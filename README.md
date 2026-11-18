# video-to-notes

把 YouTube、Bilibili 或本機影片轉成**繁體中文字幕、完整逐字稿文章和筆記**的 agent skill，Claude Code 和 Codex 都能用。

Turn YouTube, Bilibili, or local videos into Traditional Chinese subtitles, a full transcript article, and study notes. Works as a skill for Claude Code and Codex.

## 產出

```
video-notes/<影片標題>/
├── <標題>.zh-TW.srt   繁中字幕（外語影片會翻譯）
├── transcript.md       完整逐字稿文章，每段附影片時間連結
├── notes.md            摘要、章節大綱、重點、名詞表
└── work/               中間檔
```

## 運作方式

1. **取得字幕**：YouTube 有人工字幕就直接下載；其他情況用 yt-dlp 抽音訊，再用 [whisper.cpp](https://github.com/ggml-org/whisper.cpp)（large-v3-turbo q5_0）在本機轉錄。完全免費，不上傳音訊。
2. **切塊**：約 10 分鐘一塊，只在兩句字幕之間切；有 YouTube 章節時照章節切。
3. **subagent 處理**：每塊派一個 subagent 校對、簡轉繁或翻譯、改寫成文章、寫區塊筆記，最多 4 個平行。主 agent 不讀字幕全文，影片再長 context 也不會爆。
4. **檢查**：腳本比對每塊的句數和時間戳，有掉句或改到時間戳就重跑那一塊。
5. **合併與筆記**：合併字幕和文章，主 agent 只讀各塊筆記寫出 `notes.md`，最後把 `[HH:MM:SS]` 轉成影片時間連結。

## 需求

- Node.js 18 以上
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) 和 [ffmpeg](https://ffmpeg.org/)
- whisper.cpp：Windows 由 `setup` 自動下載；macOS 用 `brew install whisper-cpp`；Linux 自行安裝，讓 `whisper-cli` 在 PATH 上

不需要 Python。

## 安裝

Clone 到你的 agent 的 skill 資料夾：

```sh
# Claude Code
git clone https://github.com/dajethsu/video-to-notes ~/.claude/skills/video-to-notes

# Codex
git clone https://github.com/dajethsu/video-to-notes ~/.codex/skills/video-to-notes
```

Windows（PowerShell）：

```powershell
winget install yt-dlp.yt-dlp Gyan.FFmpeg OpenJS.NodeJS.LTS
git clone https://github.com/dajethsu/video-to-notes "$env:USERPROFILE\.claude\skills\video-to-notes"
```

下載 whisper 模型（約 550 MB，Windows 另外下載 whisper.cpp 執行檔，都會驗證 SHA-256），然後檢查環境：

```sh
node ~/.claude/skills/video-to-notes/scripts/vtn.mjs setup
node ~/.claude/skills/video-to-notes/scripts/vtn.mjs doctor
```

裝完重新啟動 agent。

## 使用

貼上影片網址或檔案路徑，說「幫我整理成筆記」，或輸入：

```
/video-to-notes https://www.youtube.com/watch?v=...
```

輸出會放在目前工作資料夾下的 `video-notes/`。

## 速度和成本

- **轉錄**：CPU-only（Intel i7-10700，8 核）約 1 倍即時速度，1 小時影片約 1 小時。有人工字幕的 YouTube 影片不用轉錄。
- **token**：每 10 分鐘的影片，subagent 約用 7 萬 token。

## 已知限制

- 沒有聲音的內容（投影片上的文字、程式碼）不會進字幕。
- Bilibili 的 CC 字幕通常要登入，所以 Bilibili 影片一律轉錄音訊。
- 自動轉錄會聽錯專有名詞。worker 會依上下文和名詞表修正，無法確定的會標 `(?)`。
- 已在 Windows 11 + Claude Code 完整測試過。Codex 和 macOS／Linux 尚未實測，歡迎回報。

## 開發

```sh
node tests/synthetic.mjs    # 用合成資料測試 split / check / merge / finalize
```

## 使用規範

下載 YouTube 或 Bilibili 內容受各平台服務條款限制，請只用於個人學習和研究。產出的字幕和筆記是原影片的衍生作品，除非影片授權允許，請不要公開散布，並註明原作者。

## 授權

MIT。whisper.cpp 和 Whisper 模型也是 MIT 授權。
