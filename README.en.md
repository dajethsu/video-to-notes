# video-to-notes

[繁體中文](README.md) | **English**

An agent skill for Claude Code and Codex that turns YouTube, Bilibili, or local videos into **Traditional Chinese subtitles, a full transcript article, and study notes**.

## Output

```
video-notes/<video title>/
├── <title>.zh-TW.srt   Traditional Chinese subtitles (foreign-language videos are translated)
├── transcript.md       full transcript article, each paragraph linked to its time in the video
├── notes.md            summary, chapter outline, key points, glossary
└── work/               intermediate files
```

## How it works

1. **Get subtitles**: if a YouTube video has manual subtitles, the skill downloads them. Otherwise yt-dlp extracts the audio and [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (large-v3-turbo q5_0) transcribes it on your machine. It is free, and no audio is uploaded.
2. **Split**: the transcript is cut into chunks of about 10 minutes, always between two subtitle lines. If the YouTube video has chapters, the cuts follow the chapters.
3. **Subagents**: each chunk goes to one subagent, with up to 4 running in parallel. The subagent proofreads the chunk, converts Simplified to Traditional Chinese or translates it, rewrites it as an article, and writes chunk notes. The main agent never reads the full transcript, so its context stays small however long the video is.
4. **Check**: a script compares the line count and timestamps of each chunk. A chunk with dropped lines or changed timestamps is processed again.
5. **Merge and notes**: the script merges the subtitles and articles. The main agent reads only the chunk notes and writes `notes.md`. Finally, every `[HH:MM:SS]` becomes a link to that moment in the video.

## Requirements

- Node.js 18 or later
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [ffmpeg](https://ffmpeg.org/)
- whisper.cpp: on Windows, `setup` downloads it; on macOS, run `brew install whisper-cpp`; on Linux, install it so that `whisper-cli` is on your PATH

Python is not needed.

## Install

Clone the repo into your agent's skills folder:

```sh
# Claude Code
git clone https://github.com/dajethsu/video-to-notes ~/.claude/skills/video-to-notes

# Codex
git clone https://github.com/dajethsu/video-to-notes ~/.codex/skills/video-to-notes
```

Windows (PowerShell):

```powershell
winget install yt-dlp.yt-dlp Gyan.FFmpeg OpenJS.NodeJS.LTS
git clone https://github.com/dajethsu/video-to-notes "$env:USERPROFILE\.claude\skills\video-to-notes"
```

Download the whisper model (about 550 MB; on Windows, `setup` also downloads the whisper.cpp binary; both are checked against SHA-256 hashes), then check your environment:

```sh
node ~/.claude/skills/video-to-notes/scripts/vtn.mjs setup
node ~/.claude/skills/video-to-notes/scripts/vtn.mjs doctor
```

Restart your agent after installing.

## Usage

Paste a video URL or file path and ask for notes, or type:

```
/video-to-notes https://www.youtube.com/watch?v=...
```

The output goes to `video-notes/` in your current working folder.

## Speed and cost

- **Transcription**: on a CPU only (Intel i7-10700, 8 cores), whisper runs at about real-time speed, so a 1-hour video takes about 1 hour. YouTube videos with manual subtitles skip transcription.
- **Tokens**: subagents use about 70,000 tokens for each 10 minutes of video.

## Known limits

- Content that is not spoken, such as text or code on slides, does not appear in the subtitles.
- Bilibili CC subtitles usually require a login, so Bilibili videos are always transcribed from audio.
- Automatic transcription mishears proper nouns. The worker corrects them from context and the glossary, and marks the ones it cannot confirm with `(?)`.
- Fully tested on Windows 11 with Claude Code. Codex, macOS, and Linux are not tested yet; reports are welcome.

## Development

```sh
node tests/synthetic.mjs    # tests split / check / merge / finalize with synthetic data
```

## Responsible use

Downloading content from YouTube or Bilibili is restricted by each platform's terms of service. Use this tool only for personal study and research. The subtitles and notes it produces are derivative works of the source video. Do not share them publicly unless the video's license allows it, and credit the original creator.

## License

MIT. whisper.cpp and the Whisper models are also MIT-licensed.
