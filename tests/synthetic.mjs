// Synthetic end-to-end test of split / check / merge / finalize (no whisper, no subagents).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const VTN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'vtn.mjs');
const root = fs.mkdtempSync(path.join(process.argv[2] || os.tmpdir(), 'vtn-synth-'));
const out = path.join(root, 'out');
const work = path.join(out, 'work');
fs.mkdirSync(work, { recursive: true });

const p2 = n => String(n).padStart(2, '0');
const ts = ms => `${p2(Math.floor(ms / 3600000))}:${p2(Math.floor(ms / 60000) % 60)}:${p2(Math.floor(ms / 1000) % 60)},${String(ms % 1000).padStart(3, '0')}`;

// 72 cues, 10 s each = 12 minutes. Every 6th cue ends a sentence.
const cues = [];
for (let i = 0; i < 72; i++) cues.push({ i: i + 1, s: i * 10000, e: i * 10000 + 9000, t: `这是第${i + 1}句测试字幕${i % 6 === 5 ? '。' : ''}` });
fs.writeFileSync(path.join(work, 'raw.srt'), cues.map(c => `${c.i}\n${ts(c.s)} --> ${ts(c.e)}\n${c.t}\n`).join('\n'));
fs.writeFileSync(path.join(work, 'meta.json'), JSON.stringify({
  source: 'https://www.youtube.com/watch?v=TESTID', source_type: 'youtube', id: 'TESTID', title: '測試影片',
  duration_sec: 720, url: 'https://www.youtube.com/watch?v=TESTID', link_template: 'https://www.youtube.com/watch?v=TESTID&t={s}s',
  chapters: [], out_dir: out, work_dir: work, title_file: '測試影片', subtitle_source: 'synthetic',
}));

const vtn = (...args) => {
  const r = spawnSync(process.execPath, [VTN, ...args], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout + r.stderr).trim() };
};
let failures = 0;
const expect = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `\n      ${detail}`}`); if (!cond) failures++; };

// split
let r = vtn('split', '--work', work, '--minutes', '4');
const idx = JSON.parse(fs.readFileSync(path.join(work, 'chunks', 'index.json'), 'utf8'));
expect('split makes 3 chunks', idx.chunks.length === 3, r.out);
expect('chunks cover all cues', idx.chunks.reduce((a, c) => a + c.cues, 0) === 72, JSON.stringify(idx.chunks));
expect('chunk 2 has context file', fs.existsSync(path.join(work, 'chunks', 'chunk_02.context.txt')));
const firstChunk = fs.readFileSync(path.join(work, 'chunks', 'chunk_01.srt'), 'utf8').trim().split('\n');
expect('chunk 1 ends at a sentence end', /。$/.test(firstChunk[firstChunk.length - 1]), firstChunk.slice(-1)[0]);

// fake worker outputs
const chunkDir = path.join(work, 'chunks');
const fakeNotes = id => `## chunk_${id}\n\n### 摘要\n\n測試。\n\n### 主題段落\n\n- [00:00:10] 主題：說明\n\n### 重點\n\n- 重點（[00:01:05]）\n\n### 名詞\n\n- 無\n`;
for (const c of idx.chunks) {
  const src = fs.readFileSync(path.join(chunkDir, `chunk_${c.id}.srt`), 'utf8');
  let zh = src.replace(/这是第/g, '這是第').replace(/测试/g, '測試');
  if (c.id === '02') zh = zh.split('\n\n').slice(1).join('\n\n'); // drop one cue: allowed
  fs.writeFileSync(path.join(chunkDir, `chunk_${c.id}.zh-TW.srt`), zh);
  fs.writeFileSync(path.join(chunkDir, `chunk_${c.id}.article.md`), `[${c.start}] 第 ${c.id} 塊的文章。`);
  fs.writeFileSync(path.join(chunkDir, `chunk_${c.id}.notes.md`), fakeNotes(c.id));
}
r = vtn('check', '--work', work);
expect('check passes with one dropped cue', r.code === 0, r.out);

// altered timestamp must fail
const f3 = path.join(chunkDir, 'chunk_03.zh-TW.srt');
const good3 = fs.readFileSync(f3, 'utf8');
fs.writeFileSync(f3, good3.replace(/(\d{2}:\d{2}:\d{2}),000 -->/, '$1,500 -->'));
r = vtn('check', '--work', work, '--id', '3');
expect('check fails on altered timestamp', r.code === 1 && /timestamps not in the source/.test(r.out), r.out);

// simplified chars must warn
fs.writeFileSync(f3, good3.replace('這是第', '这是第'));
r = vtn('check', '--work', work, '--id', '03');
expect('check warns on simplified chars', r.code === 0 && /WARN/.test(r.out) && /simplified/.test(r.out), r.out);
fs.writeFileSync(f3, good3);

// too many drops must fail
const f1 = path.join(chunkDir, 'chunk_01.zh-TW.srt');
const good1 = fs.readFileSync(f1, 'utf8');
fs.writeFileSync(f1, good1.split('\n\n').slice(6).join('\n\n'));
r = vtn('check', '--work', work, '--id', '01');
expect('check fails on many dropped cues', r.code === 1 && /dropped/.test(r.out), r.out);
fs.writeFileSync(f1, good1);

// merge refuses when a chunk fails, then succeeds
fs.renameSync(path.join(chunkDir, 'chunk_02.notes.md'), path.join(chunkDir, 'x.md'));
r = vtn('merge', '--work', work);
expect('merge refuses with missing notes', r.code === 1, r.out);
fs.renameSync(path.join(chunkDir, 'x.md'), path.join(chunkDir, 'chunk_02.notes.md'));
r = vtn('merge', '--work', work);
expect('merge succeeds', r.code === 0, r.out);
const merged = fs.readFileSync(path.join(out, '測試影片.zh-TW.srt'), 'utf8');
const mergedCues = merged.trim().split(/\n\s*\n/);
expect('merged srt has 71 cues numbered 1..71', mergedCues.length === 71 && mergedCues[70].startsWith('71\n'), `${mergedCues.length}`);

// split refuses to overwrite processed chunks
r = vtn('split', '--work', work);
expect('split refuses without --force', r.code === 1, r.out);

// finalize: term map + linkify
fs.writeFileSync(path.join(out, 'notes.md'), '# 測試影片\n\n## 摘要\n\n測試字幕。\n\n## 章節大綱\n\n- [00:01:05] **開頭**：說明\n\n## 重點\n\n- 重點（[01:02:03]）\n\n## 名詞表\n\n| 名詞 | 原文 | 解釋 | 首次出現 |\n|---|---|---|---|\n| 測試 | test | 說明 | [00:00:10] |\n');
fs.writeFileSync(path.join(work, 'term_map.json'), JSON.stringify({ '測試字幕': '試驗字幕' }));
fs.writeFileSync(path.join(work, 'audio.wav'), 'x');
r = vtn('finalize', '--work', work);
expect('finalize succeeds', r.code === 0, r.out);
const notes = fs.readFileSync(path.join(out, 'notes.md'), 'utf8');
expect('timestamps linked', notes.includes('[00:01:05](https://www.youtube.com/watch?v=TESTID&t=65s)') && notes.includes('[01:02:03](https://www.youtube.com/watch?v=TESTID&t=3723s)'), notes);
expect('term map applied to notes and srt', notes.includes('試驗字幕') && fs.readFileSync(path.join(out, '測試影片.zh-TW.srt'), 'utf8').includes('試驗字幕'));
expect('audio removed', !fs.existsSync(path.join(work, 'audio.wav')));
r = vtn('finalize', '--work', work);
const notes2 = fs.readFileSync(path.join(out, 'notes.md'), 'utf8');
expect('finalize is idempotent (no double links)', notes2 === notes, notes2);
r = vtn('status', '--work', work);
expect('status runs', r.code === 0 && /3 total, 3 passed/.test(r.out), r.out);

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
fs.rmSync(root, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
