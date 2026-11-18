#!/usr/bin/env node
// video-to-notes helper CLI. Node.js standard library only.
// Run `node vtn.mjs help` for the command list.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED_WHISPER = path.join(SKILL_DIR, 'bin', 'whisper', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
// Bundled binary (Windows, installed by `setup`) first, otherwise whisper-cli on PATH (brew / distro package).
const whisperBin = () => (fs.existsSync(BUNDLED_WHISPER) ? BUNDLED_WHISPER : 'whisper-cli');
const MODEL = path.join(SKILL_DIR, 'models', 'ggml-large-v3-turbo-q5_0.bin');
const MODEL_SIZE = 574041195;
const MODEL_NAME = 'large-v3-turbo-q5_0';
const DOWNLOADS = {
  model: {
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
  },
  whisperWin: {
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
    sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
  },
};
const SPEED_LOG = path.join(SKILL_DIR, 'data', 'speed.jsonl');
const UTF8_ENV = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };

const HELP = `video-to-notes helper (node vtn.mjs <command> [options])

  doctor                                   check yt-dlp, ffmpeg, whisper.cpp, model
  setup                                    download the whisper model (~550 MB) and, on Windows,
                                           the whisper.cpp binary; both are SHA-256 verified
  prepare   --source <url|file> [--out <dir>] [--force-transcribe]
                                           fetch metadata, manual subtitles or audio
  bench     --work <dir> [--seconds 300] [--beam N]
                                           time whisper.cpp on the first N seconds
  transcribe --work <dir> [--lang auto] [--threads N] [--beam N] [--prompt <text>]
                                           whisper.cpp -> work/raw.srt (long: run in background)
  peek      --work <dir> [--cues 30]       print the first cues and a few samples
  split     --work <dir> [--minutes 10] [--force]
                                           cut raw.srt into work/chunks/chunk_NN.srt
  check     --work <dir> [--id NN]         validate subagent outputs per chunk
  merge     --work <dir> [--force]         build <title>.zh-TW.srt and transcript.md
  finalize  --work <dir> [--keep-audio]    apply term_map.json, link timestamps, clean audio
  status    --work <dir>                   show which stages are done
`;

// ---------- generic helpers ----------

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { opts[key] = next; i++; }
      else opts[key] = true;
    } else opts._.push(a);
  }
  return opts;
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function tail(text, n = 15) {
  return String(text || '').trim().split(/\r?\n/).slice(-n).join('\n');
}

function run(cmd, args, { env, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: env || process.env, windowsHide: true });
  if (r.error) fail(`cannot run ${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) fail(`${cmd} exited with ${r.status}:\n${tail(r.stderr || r.stdout)}`);
  return r;
}

function toolVersion(cmd, flag = '--version') {
  const r = spawnSync(cmd, [flag], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').split(/\r?\n/)[0].trim();
}

function requireTool(cmd, flag) {
  if (!toolVersion(cmd, flag)) fail(`${cmd} not found on PATH (run: node vtn.mjs doctor)`);
}

const readText = p => fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
const writeText = (p, s) => fs.writeFileSync(p, s, 'utf8');
const readJson = p => JSON.parse(readText(p));
const writeJson = (p, o) => writeText(p, JSON.stringify(o, null, 2) + '\n');
const p2 = n => String(n).padStart(2, '0');
const show = p => String(p).split(path.sep).join('/'); // forward slashes are safer to quote in bash

function needWork(o) {
  const w = o.work || o._[0];
  if (!w) fail('--work <dir> is required (the work_dir printed by prepare)');
  const abs = path.resolve(w);
  if (!fs.existsSync(path.join(abs, 'meta.json'))) fail(`no meta.json in ${abs}; run prepare first`);
  return abs;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------- time + SRT ----------

function tsToMs(ts) {
  const m = String(ts).trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return NaN;
  return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4].padEnd(3, '0');
}

function msToSrt(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(r).padStart(3, '0')}`;
}

function msToHms(ms) {
  const t = Math.floor(Math.max(0, ms) / 1000);
  return `${p2(Math.floor(t / 3600))}:${p2(Math.floor((t % 3600) / 60))}:${p2(t % 60)}`;
}

function hmsToSec(hms) {
  const parts = hms.split(':').map(Number);
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

function parseSrt(text) {
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const m = lines[i].match(/(\d+:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d+:\d{2}:\d{2}[,.]\d{1,3})/);
    if (!m) continue;
    const idx = i > 0 ? parseInt(lines[i - 1].trim(), 10) : NaN;
    cues.push({
      index: Number.isFinite(idx) ? idx : cues.length + 1,
      startMs: tsToMs(m[1]),
      endMs: tsToMs(m[2]),
      text: lines.slice(i + 1).map(l => l.trimEnd()).join('\n').trim(),
    });
  }
  return cues;
}

function writeSrt(file, cues, renumber = false) {
  const body = cues
    .map((c, i) => `${renumber ? i + 1 : c.index}\n${msToSrt(c.startMs)} --> ${msToSrt(c.endMs)}\n${c.text}\n`)
    .join('\n');
  writeText(file, body);
}

function cleanCueText(t) {
  return t
    .replace(/<[^>]+>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// Drop empty cues and collapse whisper repetition loops (3+ identical cues in a row).
function normalizeCues(cues) {
  const out = [];
  let removedEmpty = 0, collapsed = 0;
  for (const c of cues) {
    const text = cleanCueText(c.text);
    if (!text) { removedEmpty++; continue; }
    out.push({ ...c, text });
  }
  const result = [];
  for (let i = 0; i < out.length;) {
    let j = i;
    while (j + 1 < out.length && out[j + 1].text === out[i].text) j++;
    const run = j - i + 1;
    if (run >= 3) {
      result.push({ ...out[i], endMs: out[j].endMs });
      collapsed += run - 1;
    } else for (let k = i; k <= j; k++) result.push(out[k]);
    i = j + 1;
  }
  result.forEach((c, i) => { c.index = i + 1; });
  return { cues: result, removedEmpty, collapsed };
}

function safeName(s) {
  let n = String(s || '').replace(/[\\/:*?"<>|$`'\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  const chars = [...n];
  if (chars.length > 60) n = chars.slice(0, 60).join('').trim().replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) n = `_${n}`;
  return n || 'video';
}

// ---------- source handling ----------

function detectType(src) {
  if (/^https?:\/\//i.test(src)) {
    let host;
    try { host = new URL(src).hostname.toLowerCase(); } catch { fail(`invalid URL: ${src}`); }
    if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host)) return 'youtube';
    if (/(^|\.)(bilibili\.com|b23\.tv)$/.test(host)) return 'bilibili';
    return 'web';
  }
  if (fs.existsSync(src) && fs.statSync(src).isFile()) return 'local';
  fail(`source not found: ${src} (expected a URL or an existing file path)`);
}

function linkTemplate(type, info, src) {
  if (type === 'youtube') return `https://www.youtube.com/watch?v=${info.id}&t={s}s`;
  if (type === 'bilibili') {
    const candidates = [info.webpage_url, src, info.id].filter(Boolean);
    let bv = null, p = null;
    for (const c of candidates) {
      const m = c.match(/BV[0-9A-Za-z]{10}/);
      if (m && !bv) bv = m[0];
      try { const q = new URL(c).searchParams.get('p'); if (q && !p) p = q; } catch { /* ignore */ }
    }
    if (bv) return `https://www.bilibili.com/video/${bv}${p ? `?p=${p}&` : '?'}t={s}`;
    const base = info.webpage_url || src;
    return `${base}${base.includes('?') ? '&' : '?'}t={s}`;
  }
  return null;
}

function pickSubLang(keys, videoLang) {
  if (!keys.length) return null;
  const find = re => keys.find(k => re.test(k));
  const vl = String(videoLang || '').split(/[-_]/)[0].toLowerCase().replace(/[^a-z]/g, '');
  return find(/^zh[-_](tw|hant|hk)/i)
    || (vl && find(new RegExp(`^${vl}([-_]|$)`, 'i')))
    || find(/^zh/i)
    || find(/^en/i)
    || keys[0];
}

function wavSeconds(wav) {
  return Math.max(0, (fs.statSync(wav).size - 44) / 32000); // 16 kHz mono s16le
}

function speedRatio() {
  if (!fs.existsSync(SPEED_LOG)) return null;
  const ratios = readText(SPEED_LOG).split('\n').filter(Boolean).map(l => {
    try { const j = JSON.parse(l); return j.proc_sec / j.audio_sec; } catch { return NaN; }
  }).filter(Number.isFinite);
  return median(ratios);
}

function recordSpeed(entry) {
  fs.mkdirSync(path.dirname(SPEED_LOG), { recursive: true });
  fs.appendFileSync(SPEED_LOG, JSON.stringify(entry) + '\n', 'utf8');
}

// ---------- commands ----------

function cmdDoctor() {
  const rows = [];
  const check = (name, ok, detail, fix) => rows.push({ name, ok, detail, fix });
  check('node', true, process.version);
  const ytv = toolVersion('yt-dlp');
  check('yt-dlp', !!ytv, ytv || 'missing', 'winget install yt-dlp.yt-dlp');
  const ffv = toolVersion('ffmpeg', '-version');
  check('ffmpeg', !!ffv, ffv ? ffv.split(' ').slice(0, 3).join(' ') : 'missing', 'winget install Gyan.FFmpeg');
  const fpv = toolVersion('ffprobe', '-version');
  check('ffprobe', !!fpv, fpv ? 'ok' : 'missing', 'installed together with ffmpeg');
  const wr = spawnSync(whisperBin(), ['--version'], { encoding: 'utf8', windowsHide: true });
  const wOk = !wr.error && wr.status === 0;
  const wFix = process.platform === 'win32' ? 'node vtn.mjs setup'
    : process.platform === 'darwin' ? 'brew install whisper-cpp' : 'install whisper.cpp so whisper-cli is on PATH';
  check('whisper-cli', wOk, wOk ? whisperBin() : 'missing', wFix);
  const mOk = fs.existsSync(MODEL) && fs.statSync(MODEL).size === MODEL_SIZE;
  check('model', mOk, fs.existsSync(MODEL) ? `${(fs.statSync(MODEL).size / 1048576).toFixed(0)} MB` : 'missing',
    'node vtn.mjs setup');
  const ratio = speedRatio();
  for (const r of rows) console.log(`${r.ok ? 'OK     ' : 'MISSING'} ${r.name.padEnd(12)} ${r.detail}${r.ok ? '' : `  -> ${r.fix}`}`);
  console.log(`speed   ${ratio ? `whisper takes ~${ratio.toFixed(2)}x audio length on this machine` : 'no benchmark yet (run bench once)'}`);
  if (rows.some(r => !r.ok)) process.exit(1);
}

async function download(url, dest, sha256) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) fail(`download failed (${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  let got = 0, lastPct = -10;
  const body = Readable.fromWeb(res.body);
  body.on('data', chunk => {
    hash.update(chunk);
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct >= lastPct + 10) { lastPct = pct; console.log(`  ${path.basename(dest)} ${pct}%`); }
  });
  const tmp = `${dest}.part`;
  await pipeline(body, fs.createWriteStream(tmp));
  const digest = hash.digest('hex');
  if (digest !== sha256) { fs.rmSync(tmp, { force: true }); fail(`checksum mismatch for ${url}`); }
  fs.renameSync(tmp, dest);
}

async function cmdSetup() {
  if (process.platform === 'win32' && !fs.existsSync(BUNDLED_WHISPER)) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtn-whisper-'));
    const zip = path.join(tmpDir, 'whisper-bin-x64.zip');
    console.log('downloading whisper.cpp (Windows x64, CPU)');
    await download(DOWNLOADS.whisperWin.url, zip, DOWNLOADS.whisperWin.sha256);
    const extractDir = path.join(tmpDir, 'x');
    fs.mkdirSync(extractDir);
    // Use Windows' bsdtar explicitly: GNU tar from Git Bash may come first on PATH and treats "C:" as a host.
    const winTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    run(fs.existsSync(winTar) ? winTar : 'tar', ['-xf', zip, '-C', extractDir]);
    const rel = path.join(extractDir, 'Release');
    fs.mkdirSync(path.dirname(BUNDLED_WHISPER), { recursive: true });
    for (const n of fs.readdirSync(rel)) {
      if (n === 'whisper-cli.exe' || n === 'whisper.dll' || /^ggml.*\.dll$/.test(n)) fs.copyFileSync(path.join(rel, n), path.join(path.dirname(BUNDLED_WHISPER), n));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`whisper.cpp -> ${show(path.dirname(BUNDLED_WHISPER))}`);
  } else if (process.platform !== 'win32') {
    console.log('whisper.cpp: using whisper-cli from PATH (macOS: brew install whisper-cpp)');
  }
  if (fs.existsSync(MODEL) && fs.statSync(MODEL).size === MODEL_SIZE) console.log('model already present');
  else {
    fs.mkdirSync(path.dirname(MODEL), { recursive: true });
    console.log('downloading ggml-large-v3-turbo-q5_0.bin (~550 MB)');
    await download(DOWNLOADS.model.url, MODEL, DOWNLOADS.model.sha256);
    console.log(`model -> ${show(MODEL)}`);
  }
  cmdDoctor();
}

function cmdPrepare(o) {
  const src = o.source || o._[0];
  if (!src || src === true) fail('--source <url|file> is required');
  const outRoot = path.resolve(typeof o.out === 'string' ? o.out : 'video-notes');
  const type = detectType(src);
  requireTool('ffmpeg', '-version');
  requireTool('ffprobe', '-version');

  let info = {};
  let title, duration = null, url;
  if (type === 'local') {
    url = path.resolve(src);
    const probe = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', url]);
    duration = parseFloat(probe.stdout.trim()) || null;
    title = path.parse(url).name;
  } else {
    requireTool('yt-dlp');
    const r = run('yt-dlp', ['-J', '--no-playlist', '--no-warnings', '--encoding', 'utf-8', src], { env: UTF8_ENV });
    try { info = JSON.parse(r.stdout); } catch { fail('yt-dlp returned unreadable metadata'); }
    if (info._type === 'playlist') fail('this URL is a playlist; pass one video URL at a time');
    title = info.title || info.id;
    duration = info.duration || null;
    url = info.webpage_url || src;
  }

  let outDir = path.join(outRoot, safeName(title));
  const prevMetaPath = path.join(outDir, 'work', 'meta.json');
  if (fs.existsSync(prevMetaPath)) {
    const prev = readJson(prevMetaPath);
    if (prev.url !== url) outDir = `${outDir}-${safeName(info.id || String(Date.now()))}`;
  }
  const work = path.join(outDir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const metaPath = path.join(work, 'meta.json');
  const meta = fs.existsSync(metaPath) ? readJson(metaPath) : {};
  Object.assign(meta, {
    source: src,
    source_type: type,
    id: info.id || null,
    title,
    uploader: info.uploader || info.channel || null,
    duration_sec: duration,
    url,
    link_template: linkTemplate(type, info, src),
    language: info.language || meta.language || null,
    chapters: (info.chapters || []).map(c => ({ start_sec: c.start_time, end_sec: c.end_time, title: c.title })),
    description: String(info.description || '').slice(0, 3000),
    out_dir: outDir,
    work_dir: work,
    title_file: safeName(title),
  });

  const rawSrt = path.join(work, 'raw.srt');
  if (!fs.existsSync(rawSrt) && type === 'youtube' && !o['force-transcribe']) {
    const keys = Object.keys(info.subtitles || {}).filter(k => !/^(live_chat|danmaku)$/i.test(k));
    const lang = pickSubLang(keys, info.language);
    if (lang) {
      run('yt-dlp', ['--skip-download', '--no-playlist', '--no-warnings', '--encoding', 'utf-8',
        '--write-subs', '--sub-langs', `^${lang}$`, '--sub-format', 'srt/vtt/best', '--convert-subs', 'srt',
        '-o', path.join(work, 'subs.%(ext)s'), src], { env: UTF8_ENV });
      const f = fs.readdirSync(work).find(n => n.startsWith('subs.') && n.endsWith('.srt'));
      if (f) {
        const { cues } = normalizeCues(parseSrt(readText(path.join(work, f))));
        if (cues.length) {
          writeSrt(rawSrt, cues, true);
          fs.rmSync(path.join(work, f), { force: true });
          meta.subtitle_source = `YouTube manual subtitles (${lang})`;
          meta.subtitle_language = lang;
        }
      }
    }
  }

  const wav = path.join(work, 'audio.wav');
  const needsTranscribe = !fs.existsSync(rawSrt);
  if (needsTranscribe && !fs.existsSync(wav)) {
    let input;
    if (type === 'local') input = url;
    else {
      run('yt-dlp', ['-f', 'bestaudio/best', '--no-playlist', '--no-warnings', '--no-progress', '--encoding', 'utf-8',
        '-o', path.join(work, 'source.%(ext)s'), src], { env: UTF8_ENV });
      const f = fs.readdirSync(work).find(n => n.startsWith('source.') && !n.endsWith('.part') && !n.endsWith('.ytdl'));
      if (!f) fail('yt-dlp did not produce an audio file');
      input = path.join(work, f);
    }
    run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    if (type !== 'local') fs.rmSync(input, { force: true });
  }
  if (!meta.duration_sec && fs.existsSync(wav)) meta.duration_sec = Math.round(wavSeconds(wav));
  writeJson(metaPath, meta);

  const ratio = speedRatio();
  const dur = meta.duration_sec || 0;
  console.log(JSON.stringify({
    out_dir: show(outDir),
    work_dir: show(work),
    title,
    source_type: type,
    duration: msToHms(dur * 1000),
    duration_min: Math.round(dur / 6) / 10,
    chapters: meta.chapters.length,
    needs_transcribe: needsTranscribe,
    subtitle_source: needsTranscribe ? 'whisper.cpp (pending)' : meta.subtitle_source,
    est_transcribe_min: needsTranscribe && ratio ? Math.round((dur * ratio) / 6) / 10 : null,
    est_chunks: Math.max(1, Math.round(dur / 600)),
  }, null, 2));
}

// whisper-cli reads argv in the ANSI code page on Windows, so a work dir with characters outside
// that code page (e.g. Simplified Chinese on a Big5 system) breaks absolute paths. Run it inside
// the work dir and pass only ASCII relative names.
function whisperArgs(o, extra) {
  const threads = String(o.threads && o.threads !== true ? o.threads : Math.min(8, os.cpus().length));
  const args = ['-m', MODEL, '-f', 'audio.wav', '-l', typeof o.lang === 'string' ? o.lang : 'auto', '-t', threads, ...extra];
  if (o.beam && o.beam !== true) args.push('-bs', String(o.beam), '-bo', String(o.beam));
  if (typeof o.prompt === 'string') args.push('--prompt', o.prompt);
  return { args, threads };
}

function runWhisper(work, args, logName) {
  if (!fs.existsSync(MODEL)) fail('whisper.cpp or the model is missing (run: node vtn.mjs doctor)');
  const logPath = path.join(work, logName);
  const fd = fs.openSync(logPath, 'w');
  const t0 = Date.now();
  const r = spawnSync(whisperBin(), args, { cwd: work, stdio: ['ignore', fd, fd], windowsHide: true });
  fs.closeSync(fd);
  const sec = (Date.now() - t0) / 1000;
  if (r.error) fail(`cannot start whisper-cli: ${r.error.message}`);
  if (r.status !== 0) fail(`whisper-cli exited with ${r.status}; last log lines:\n${tail(readText(logPath))}`);
  const lang = (readText(logPath).match(/auto-detected language:\s*([a-z]{2,3})/i) || [])[1] || null;
  return { sec, lang };
}

function cmdBench(o) {
  const work = needWork(o);
  if (!fs.existsSync(path.join(work, 'audio.wav'))) fail('audio.wav missing; run prepare (or prepare --force-transcribe)');
  const seconds = Math.min(Number(o.seconds) || 300, wavSeconds(path.join(work, 'audio.wav')));
  const { args, threads } = whisperArgs(o, ['-d', String(Math.round(seconds * 1000)), '-osrt', '-of', 'bench']);
  const { sec, lang } = runWhisper(work, args, 'bench.log');
  const ratio = sec / seconds;
  if (seconds >= 60) recordSpeed({ at: new Date().toISOString(), audio_sec: Math.round(seconds), proc_sec: Math.round(sec), threads: +threads, beam: o.beam || 5, model: MODEL_NAME, kind: 'bench' });
  console.log(JSON.stringify({ audio_sec: Math.round(seconds), proc_sec: Math.round(sec), ratio: +ratio.toFixed(2), language: lang, output: show(path.join(work, 'bench.srt')) }, null, 2));
}

function cmdTranscribe(o) {
  const work = needWork(o);
  const metaPath = path.join(work, 'meta.json');
  const meta = readJson(metaPath);
  const wav = path.join(work, 'audio.wav');
  if (!fs.existsSync(wav)) fail('audio.wav missing; run prepare first (use --force-transcribe for videos with manual subtitles)');
  const { args, threads } = whisperArgs(o, ['-osrt', '-of', 'whisper']);
  const { sec, lang } = runWhisper(work, args, 'transcribe.log');
  const whisperSrt = path.join(work, 'whisper.srt');
  if (!fs.existsSync(whisperSrt)) fail('whisper-cli finished but whisper.srt is missing (see transcribe.log)');
  const { cues, removedEmpty, collapsed } = normalizeCues(parseSrt(readText(whisperSrt)));
  if (!cues.length) fail('whisper produced no speech cues (silent audio or music only?)');
  writeSrt(path.join(work, 'raw.srt'), cues, true);
  const audioSec = wavSeconds(wav);
  if (audioSec >= 60) recordSpeed({ at: new Date().toISOString(), audio_sec: Math.round(audioSec), proc_sec: Math.round(sec), threads: +threads, beam: o.beam || 5, model: MODEL_NAME, kind: 'full' });
  meta.detected_language = lang;
  meta.subtitle_source = `whisper.cpp ${MODEL_NAME}${lang ? ` (detected: ${lang})` : ''}`;
  meta.transcribe_sec = Math.round(sec);
  writeJson(metaPath, meta);
  console.log(JSON.stringify({
    cues: cues.length, removed_empty: removedEmpty, collapsed_repeats: collapsed,
    language: lang, audio_min: +(audioSec / 60).toFixed(1), proc_min: +(sec / 60).toFixed(1), ratio: +(sec / audioSec).toFixed(2),
    raw_srt: show(path.join(work, 'raw.srt')),
  }, null, 2));
}

function loadRaw(work) {
  const raw = path.join(work, 'raw.srt');
  if (!fs.existsSync(raw)) fail('raw.srt missing; run transcribe first');
  return parseSrt(readText(raw));
}

function cmdPeek(o) {
  const work = needWork(o);
  const cues = loadRaw(work);
  const n = Number(o.cues) || 30;
  const line = c => `[${msToHms(c.startMs)}] ${[...c.text.replace(/\n/g, ' ')].slice(0, 80).join('')}`;
  const chars = cues.reduce((a, c) => a + c.text.length, 0);
  console.log(`cues=${cues.length} chars=${chars} last=${cues.length ? msToHms(cues[cues.length - 1].endMs) : '-'}`);
  cues.slice(0, n).forEach(c => console.log(line(c)));
  if (cues.length > n + 10) {
    console.log('--- samples ---');
    for (let k = 1; k <= 8; k++) console.log(line(cues[Math.floor(n + ((cues.length - n - 1) * k) / 8)]));
  }
}

const SENTENCE_END = /[。！？!?…」』"”.]$/;

function cmdSplit(o) {
  const work = needWork(o);
  const meta = readJson(path.join(work, 'meta.json'));
  const cues = loadRaw(work);
  if (!cues.length) fail('raw.srt has no cues');
  const chunkDir = path.join(work, 'chunks');
  if (fs.existsSync(chunkDir)) {
    const done = fs.readdirSync(chunkDir).filter(n => n.endsWith('.zh-TW.srt'));
    if (done.length && !o.force) fail(`${done.length} chunk(s) already processed; re-run with --force to discard them and re-split`);
    fs.rmSync(chunkDir, { recursive: true, force: true });
  }
  fs.mkdirSync(chunkDir, { recursive: true });

  const target = (Number(o.minutes) || 10) * 60000;
  const minLen = target * 0.3;
  const chapterStarts = (meta.chapters || []).map(c => c.start_sec * 1000).filter(t => t > 0);
  const groups = [];
  let cur = [];
  for (const cue of cues) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const elapsed = cue.startMs - cur[0].startMs;
      const crossesChapter = chapterStarts.some(t => t > prev.startMs && t <= cue.startMs);
      const natural = SENTENCE_END.test(prev.text) || cue.startMs - prev.endMs >= 800;
      let cut;
      if (chapterStarts.length) cut = (crossesChapter && elapsed >= minLen) || (elapsed >= target * 1.5 && natural) || elapsed >= target * 1.5 + 90000;
      else cut = (elapsed >= target && natural) || elapsed >= target + 90000;
      if (cut) { groups.push(cur); cur = []; }
    }
    cur.push(cue);
  }
  if (cur.length) {
    const len = cur[cur.length - 1].endMs - cur[0].startMs;
    if (groups.length && len < minLen) groups[groups.length - 1].push(...cur);
    else groups.push(cur);
  }

  const width = Math.max(2, String(groups.length).length);
  const chunks = groups.map((g, i) => {
    const id = String(i + 1).padStart(width, '0');
    writeSrt(path.join(chunkDir, `chunk_${id}.srt`), g);
    if (i > 0) {
      const prevG = groups[i - 1];
      writeText(path.join(chunkDir, `chunk_${id}.context.txt`),
        prevG.slice(-6).map(c => `[${msToHms(c.startMs)}] ${c.text.replace(/\n/g, ' ')}`).join('\n') + '\n');
    }
    return {
      id,
      start: msToHms(g[0].startMs),
      end: msToHms(g[g.length - 1].endMs),
      cues: g.length,
      chars: g.reduce((a, c) => a + c.text.length, 0),
    };
  });
  writeJson(path.join(chunkDir, 'index.json'), { chunk_minutes: target / 60000, chunks });
  console.log(`${chunks.length} chunk(s) in ${show(chunkDir)}`);
  for (const c of chunks) console.log(`chunk_${c.id}  ${c.start}-${c.end}  cues=${c.cues}  chars=${c.chars}`);
}

// Characters that only appear in Simplified Chinese (Traditional uses a different form).
const SIMPLIFIED_ONLY = new Set([...'这们说过还没时对会为发么样开关问学现应经头见实东车长门马书买卖读写电话语认识让请谁谢员务动级线红纸组织终给统结绝继续练习验图团园国际区医华单历县变号吗响围圆场块坚声处备复够夺奖妈宝审导将尘层岁岛帮库废张归录忆态怀总恶惊战扩扫扬护报择挂换据摄数断无旧显杀杂权条来极构树样档桥梦检楼汇汉测济浓涨满灭灯灵热爱状独环电画疗确礼离种积称稳穷笔简类紧纪约细绍维综绿网罗职联脑脚脸艺节药获虑虽观规视觉计订讨训议记讲许论设访证评识诉词译试该详误课调谈谱负财责败账货质购贵费资赛转轮软轻载较边达运进远违连选递遗邮针钟钱铁银错锁间闻阅队阳阴阵阶际陆险随隐难页项顺须领题颜风飞饭馆鱼鸟鸡齐龙']);

function chunkList(work) {
  const idx = path.join(work, 'chunks', 'index.json');
  if (!fs.existsSync(idx)) fail('chunks/index.json missing; run split first');
  return readJson(idx).chunks;
}

function checkChunk(work, c) {
  const dir = path.join(work, 'chunks');
  const f = name => path.join(dir, `chunk_${c.id}.${name}`);
  const errors = [], warnings = [];
  for (const name of ['zh-TW.srt', 'article.md', 'notes.md']) {
    if (!fs.existsSync(f(name)) || !readText(f(name)).trim()) errors.push(`missing ${path.basename(f(name))}`);
  }
  let info = '';
  if (!errors.length) {
    const src = parseSrt(readText(f('srt')));
    const out = parseSrt(readText(f('zh-TW.srt')));
    let j = 0, matched = 0, altered = 0;
    for (const oc of out) {
      let k = j;
      while (k < src.length && !(src[k].startMs === oc.startMs && src[k].endMs === oc.endMs)) k++;
      if (k >= src.length) { altered++; continue; }
      matched++;
      j = k + 1;
    }
    const dropped = src.length - matched;
    if (altered) errors.push(`${altered} cue(s) with timestamps not in the source chunk (or out of order)`);
    if (dropped > Math.max(2, Math.ceil(src.length * 0.05))) errors.push(`dropped ${dropped} of ${src.length} cues (limit ${Math.max(2, Math.ceil(src.length * 0.05))})`);
    const empty = out.filter(x => !x.text.trim()).length;
    if (empty) errors.push(`${empty} empty cue(s)`);
    const text = out.map(x => x.text).join('');
    const simp = [...text].filter(ch => SIMPLIFIED_ONLY.has(ch));
    if (simp.length) warnings.push(`simplified chars x${simp.length}: ${[...new Set(simp)].slice(0, 12).join('')}`);
    const letters = (text.match(/[A-Za-z぀-ヿ가-힯一-鿿]/g) || []).length;
    const cjk = (text.match(/[一-鿿]/g) || []).length;
    const ratio = letters ? cjk / letters : 0;
    if (ratio < 0.5) warnings.push(`only ${(ratio * 100).toFixed(0)}% Chinese characters; translation may be missing`);
    const notes = readText(f('notes.md'));
    const missing = ['### 摘要', '### 主題段落', '### 重點', '### 名詞'].filter(h => !notes.includes(h));
    if (missing.length) errors.push(`notes.md missing headings: ${missing.join(', ')}`);
    if (!/\[\d{2}:\d{2}:\d{2}\]/.test(readText(f('article.md')))) warnings.push('article.md has no [HH:MM:SS] markers');
    info = `cues ${out.length}/${src.length} (dropped ${Math.max(0, dropped)})  chinese ${(ratio * 100).toFixed(0)}%`;
  }
  return { id: c.id, ok: !errors.length, errors, warnings, info };
}

function cmdCheck(o) {
  const work = needWork(o);
  let chunks = chunkList(work);
  if (o.id && o.id !== true) chunks = chunks.filter(c => c.id === String(o.id).padStart(c.id.length, '0'));
  if (!chunks.length) fail('no matching chunk');
  let bad = 0;
  for (const c of chunks) {
    const r = checkChunk(work, c);
    const status = !r.ok ? 'FAIL' : r.warnings.length ? 'WARN' : 'OK';
    if (!r.ok) bad++;
    console.log(`chunk_${c.id}  ${status.padEnd(4)}  ${r.info}${[...r.errors, ...r.warnings].map(x => `\n    - ${x}`).join('')}`);
  }
  console.log(bad ? `${bad} chunk(s) failed` : 'all chunks passed');
  if (bad) process.exit(1);
}

function cmdMerge(o) {
  const work = needWork(o);
  const meta = readJson(path.join(work, 'meta.json'));
  const chunks = chunkList(work);
  const results = chunks.map(c => checkChunk(work, c));
  const failed = results.filter(r => !r.ok);
  if (failed.length && !o.force) fail(`chunk(s) not ready: ${failed.map(r => r.id).join(', ')} (run check)`);
  const dir = path.join(work, 'chunks');
  const all = [];
  const articles = [];
  for (const c of chunks) {
    const srtPath = path.join(dir, `chunk_${c.id}.zh-TW.srt`);
    if (fs.existsSync(srtPath)) all.push(...parseSrt(readText(srtPath)));
    const art = path.join(dir, `chunk_${c.id}.article.md`);
    if (fs.existsSync(art)) articles.push(readText(art).trim());
  }
  all.sort((a, b) => a.startMs - b.startMs);
  const srtOut = path.join(meta.out_dir, `${meta.title_file}.zh-TW.srt`);
  writeSrt(srtOut, all, true);
  const header = [
    `# ${meta.title}（完整逐字稿）`,
    '',
    `- 來源：${meta.url}`,
    meta.uploader ? `- 頻道／作者：${meta.uploader}` : null,
    `- 長度：${msToHms((meta.duration_sec || 0) * 1000)}`,
    `- 字幕來源：${meta.subtitle_source || '-'}`,
    '',
    '---',
    '',
    '',
  ].filter(x => x !== null).join('\n');
  const transcript = path.join(meta.out_dir, 'transcript.md');
  writeText(transcript, `${header}${articles.join('\n\n')}\n`);
  console.log(JSON.stringify({ subtitles: show(srtOut), cues: all.length, transcript: show(transcript), notes_to_write: show(path.join(meta.out_dir, 'notes.md')) }, null, 2));
}

function applyTermMap(text, map) {
  let count = 0;
  for (const [from, to] of Object.entries(map)) {
    if (!from || from === to) continue;
    const parts = text.split(from);
    count += parts.length - 1;
    text = parts.join(to);
  }
  return { text, count };
}

function linkify(text, template) {
  if (!template) return { text, count: 0 };
  let count = 0;
  const out = text.replace(/\[((?:\d{1,2}:)?\d{1,2}:\d{2})\](?!\()/g, (m, t) => {
    count++;
    return `[${t}](${template.replace('{s}', String(hmsToSec(t)))})`;
  });
  return { text: out, count };
}

function cmdFinalize(o) {
  const work = needWork(o);
  const meta = readJson(path.join(work, 'meta.json'));
  const notes = path.join(meta.out_dir, 'notes.md');
  const transcript = path.join(meta.out_dir, 'transcript.md');
  const srt = path.join(meta.out_dir, `${meta.title_file}.zh-TW.srt`);
  for (const p of [notes, transcript, srt]) if (!fs.existsSync(p)) fail(`missing ${p} (run merge, then write notes.md)`);
  const mapPath = path.join(work, 'term_map.json');
  const map = fs.existsSync(mapPath) ? readJson(mapPath) : {};
  const report = {};
  for (const p of [srt, transcript, notes]) {
    let text = readText(p);
    const t = applyTermMap(text, map);
    text = t.text;
    let links = 0;
    if (p !== srt) { const l = linkify(text, meta.link_template); text = l.text; links = l.count; }
    writeText(p, text);
    report[path.basename(p)] = { term_replacements: t.count, links_added: links };
  }
  const notesText = readText(notes);
  const missing = ['## 摘要', '## 章節大綱', '## 重點', '## 名詞表'].filter(h => !notesText.includes(h));
  const removed = [];
  if (!o['keep-audio']) {
    for (const n of fs.readdirSync(work)) {
      if (n === 'audio.wav' || /^source\./.test(n)) { fs.rmSync(path.join(work, n), { force: true }); removed.push(n); }
    }
  }
  console.log(JSON.stringify({
    out_dir: show(meta.out_dir),
    files: { subtitles: show(srt), transcript: show(transcript), notes: show(notes) },
    report,
    notes_missing_sections: missing,
    removed_from_work: removed,
  }, null, 2));
  if (missing.length) process.exit(1);
}

function cmdStatus(o) {
  const work = needWork(o);
  const meta = readJson(path.join(work, 'meta.json'));
  const has = p => fs.existsSync(path.join(work, p));
  const lines = [
    `title        ${meta.title}`,
    `out_dir      ${meta.out_dir}`,
    `audio.wav    ${has('audio.wav') ? 'yes' : 'no'}`,
    `raw.srt      ${has('raw.srt') ? `yes (${meta.subtitle_source || '?'})` : 'no'}`,
    `terms.md     ${has('terms.md') ? 'yes' : 'no'}`,
  ];
  if (has('chunks/index.json')) {
    const chunks = chunkList(work);
    const res = chunks.map(c => checkChunk(work, c));
    lines.push(`chunks       ${chunks.length} total, ${res.filter(r => r.ok).length} passed, pending: ${res.filter(r => !r.ok).map(r => r.id).join(' ') || '-'}`);
  } else lines.push('chunks       not split');
  for (const [label, n] of [['subtitles', `${meta.title_file}.zh-TW.srt`], ['transcript', 'transcript.md'], ['notes', 'notes.md']]) {
    lines.push(`${label.padEnd(13)}${fs.existsSync(path.join(meta.out_dir, n)) ? 'yes' : 'no'}`);
  }
  console.log(lines.join('\n'));
}

// ---------- main ----------

const [cmd, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);
const commands = {
  doctor: cmdDoctor, setup: cmdSetup, prepare: cmdPrepare, bench: cmdBench, transcribe: cmdTranscribe, peek: cmdPeek,
  split: cmdSplit, check: cmdCheck, merge: cmdMerge, finalize: cmdFinalize, status: cmdStatus,
};
if (!cmd || cmd === 'help' || cmd === '--help' || !commands[cmd]) {
  console.log(HELP);
  process.exit(cmd && !['help', '--help'].includes(cmd) ? 1 : 0);
}
await commands[cmd](opts);
