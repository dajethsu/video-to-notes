---
name: video-to-notes
description: 把 YouTube、Bilibili 或本機影片／音訊轉成繁體中文字幕、完整逐字稿文章和筆記（摘要、章節大綱、重點、名詞表）。用於使用者給影片網址或影片檔，要字幕、逐字稿、影片筆記或重點整理時。
argument-hint: <YouTube／Bilibili 網址，或影片檔路徑>
---

# video-to-notes

流程：取得字幕（YouTube 人工字幕，或 whisper.cpp 轉錄）→ 切塊 → 每塊交給一個 subagent 校對、翻譯、改寫 → 合併 → 寫筆記。輸出全部用台灣用語的繁體中文。

**主 agent 的 context 只放小東西**：腳本輸出、`meta.json`、`terms.md`、各塊 `notes.md`、subagent 的回報。字幕、逐字稿、文章的全文只由 subagent 讀寫。影片多長，主 agent 的 context 都維持差不多大。

`<skill 資料夾>` 是這個 `SKILL.md` 所在資料夾的絕對路徑。以下的 `vtn` 代表 `node "<skill 資料夾>/scripts/vtn.mjs"`。路徑含中文或空白，一律加雙引號。

## 平台差異

| 動作 | Claude Code | Codex |
|---|---|---|
| 背景執行長指令 | Bash 工具加 `run_in_background: true`，等完成通知 | 在背景執行（例如 `nohup … > log 2>&1 &`），再定期看 log 是否出現結果；或把指令逾時設得比預估時間長 |
| 派 subagent | Agent 工具，`subagent_type: general-purpose` | 用內建 subagent 功能，每塊派一個 worker |
| 沒有 subagent 功能時 | — | 每塊執行一次 `codex exec --full-auto "<worker prompt>"`，最多 4 個同時跑 |

## 步驟

### 1. 檢查環境

執行 `vtn doctor`。

- 每一列都是 `OK`：繼續。
- 只缺 `whisper-cli` 或 `model`：告訴使用者要下載約 560 MB（whisper.cpp 和模型，都會驗證 SHA-256），同意後執行 `vtn setup`。macOS 的 whisper-cli 由 `brew install whisper-cpp` 安裝。
- 缺其他工具：把該列的修正方式告訴使用者，然後停止。

### 2. 準備

```bash
vtn prepare --source "<網址或檔案路徑>"          # 輸出到目前資料夾下的 video-notes/
```

可加 `--out <資料夾>` 改輸出位置；加 `--force-transcribe` 會忽略 YouTube 人工字幕，改用 whisper.cpp 轉錄。

腳本會印出 JSON，記下 `work_dir`、`out_dir`、`needs_transcribe`、`duration_min`、`est_transcribe_min`、`est_chunks`。

- YouTube 有人工字幕時直接用（`needs_transcribe: false`），跳過步驟 3。自動字幕不用。
- Bilibili、其他網站、本機檔一律轉錄。
- 影片超過 60 分鐘，或 `est_transcribe_min` 超過 30：先告訴使用者長度、預估轉錄時間和區塊數，等使用者確認。`est_transcribe_min` 是 null（這台電腦還沒測過速度）且影片超過 60 分鐘時，先跑 `vtn bench --work "<work_dir>" --seconds 120` 取得速度再估。

完成條件：JSON 印出來，而且沒有 `ERROR`。

### 3. 轉錄（`needs_transcribe: true` 才做）

```bash
vtn transcribe --work "<work_dir>"
```

在背景執行（見「平台差異」），轉錄時間約為影片長度乘上 `est_transcribe_min` 的比例。逐字稿寫進 `work/raw.srt`，whisper 的輸出寫進 `work/transcribe.log`，兩者都不讀。失敗時只看 `transcribe.log` 最後 20 行。

完成條件：輸出的 `cues` 大於 0。

### 4. 建立名詞對照表

1. 讀 `<work_dir>/meta.json`（標題、說明、章節、語言）。
2. 執行 `vtn peek --work "<work_dir>"`，看開頭和抽樣的字幕，掌握主題和常被聽錯的名詞。
3. 寫 `<work_dir>/terms.md`：

```markdown
# 名詞對照表

影片語言：<語言>　主題：<一句話>

| 原文或聽到的寫法 | 統一寫法 | 說明 |
|---|---|---|
| … | … | 人名／地名／組織／術語 |
```

完成條件：標題、說明、章節名稱和 peek 結果裡的每個人名、地名、組織、專有名詞都在表裡。外語影片的術語要定好繁中譯名，或註明保留原文。

### 5. 切塊

```bash
vtn split --work "<work_dir>"        # 預設約 10 分鐘一塊；--minutes N 可調整
```

腳本只在兩句字幕之間切，有 YouTube 章節時優先照章節切。完成條件：印出每塊的 id 和時間範圍。

### 6. 區塊處理（subagent）

每個區塊派一個 subagent（見「平台差異」），prompt 用下面的範本。一次最多 4 個平行，等它們完成再派下一批。

```text
你是 video-to-notes 的區塊 worker。先完整讀 <skill 資料夾>/references/chunk-worker.md，照它處理下面這個區塊。
- skill 資料夾：<skill 資料夾>
- 區塊：chunk_<NN>（<開始>–<結束>）
- work 資料夾：<work_dir>
完成後只用 chunk-worker.md 的「回報格式」回覆。
```

`<skill 資料夾>` 填絕對路徑，不要用 `~`。重跑失敗的區塊時，在範本最後加一行：`上次檢查沒過：<vtn check 對這塊印出的錯誤>`。

把每份回報的「不確定」和「名詞」兩欄留著，步驟 8 要用。

完成條件：每個區塊都收到回報。

### 7. 檢查

```bash
vtn check --work "<work_dir>"
```

`FAIL` 的區塊用步驟 6 的方式重派，每塊最多重派 2 次；還是失敗就停下來，把 check 的訊息告訴使用者。`WARN` 可以繼續，但要在最後的回報裡列出來。

完成條件：每塊都是 `OK` 或 `WARN`。

### 8. 統一譯名

比對各塊回報的「名詞」欄。同一個原文在不同區塊有不同寫法時，選一個統一寫法，寫進 `<work_dir>/term_map.json`：

```json
{ "其他寫法": "統一寫法" }
```

腳本會照字串取代，所以只放兩個字以上、不會誤傷其他詞的寫法。沒有不一致就不用建立這個檔。

### 9. 合併

```bash
vtn merge --work "<work_dir>"
```

產生 `<out_dir>/<標題>.zh-TW.srt` 和 `<out_dir>/transcript.md`。

### 10. 寫筆記

讀 `<work_dir>/chunks/` 下每個 `chunk_*.notes.md`，寫成 `<out_dir>/notes.md`。超過 12 個區塊時，改派一個 subagent 讀這些檔案並寫 `notes.md`，prompt 附上下面的格式。

```markdown
# <標題>

- 來源：<url>
- 頻道／作者：<uploader>
- 長度：<HH:MM:SS>
- 字幕來源：<meta.json 的 subtitle_source>

## 摘要

3–5 段：影片要回答什麼問題、主要論點、證據或例子、結論。

## 章節大綱

- [HH:MM:SS] **章節標題**：一句說明

## 重點

- 重點敘述（[HH:MM:SS]）

## 名詞表

| 名詞 | 原文 | 解釋 | 首次出現 |
|---|---|---|---|
| … | … | … | [HH:MM:SS] |
```

- 章節大綱：影片有 YouTube 章節就照章節（標題翻成繁中）；沒有就依各塊的「主題段落」整併成 5–15 項。
- 名詞表：合併各塊的「名詞」，同一個名詞只留一列，用 `terms.md` 和 `term_map.json` 的統一寫法。
- 時間一律寫成 `[HH:MM:SS]`，步驟 11 會自動轉成影片連結。

完成條件：四個 `##` 段落都在，而且每一項都有時間戳。

### 11. 收尾

```bash
vtn finalize --work "<work_dir>"
```

套用 `term_map.json`、把 `[HH:MM:SS]` 轉成影片時間連結（YouTube 用 `&t=Ns`，Bilibili 用 `?t=N`，本機檔維持純文字），並刪掉 `work/` 裡的音訊檔。要保留音訊就加 `--keep-audio`。

完成條件：`notes_missing_sections` 是空陣列。

### 12. 回報

告訴使用者：

- 三個輸出檔的路徑（字幕、`transcript.md`、`notes.md`）
- 影片長度、字幕來源、區塊數、轉錄花的時間
- 所有標了 `(?)` 的不確定名詞，以及 check 的 `WARN`

## 中斷後繼續

執行 `vtn status --work "<work_dir>"`，從第一個顯示 `no` 或 `pending` 的步驟接著做。`split` 會拒絕覆蓋已處理的區塊；要重切就加 `--force`，已處理的區塊會被刪掉。

## 常見錯誤

| 訊息 | 處理 |
|---|---|
| YouTube 要求登入或 `Sign in to confirm you're not a bot` | 請使用者更新 yt-dlp，過一陣子再試 |
| Bilibili `HTTP Error 412` | Bilibili 暫時擋下請求，等幾分鐘再跑 `prepare` |
| `this URL is a playlist` | 一次只給一支影片的網址；Bilibili 分 P 影片用帶 `?p=N` 的網址 |
| whisper 輸出大量重複句子 | `transcribe` 已自動合併連續 3 句以上的重複；剩下的由 worker 當成幻覺刪除 |
