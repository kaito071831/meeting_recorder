# AGENTS.md — meeting_recorder

オンライン会議（ブラウザ版 Teams / Zoom / Google Meet）を対象に、
会議音声を録音 → 文字起こし → 議事録生成 するローカル Web アプリ。

## スタック・規約

- Python + FastAPI（`app.py` がエントリ）。パッケージ管理は uv
  （`pyproject.toml` + `uv.lock`）。`setup.sh` は `uv sync` を実行するだけ。
- 文字起こしはローカル `faster-whisper`（オフライン・機密保持、日本語）。会議後の一括処理。
- 議事録生成は Claude（Anthropic SDK, `claude-opus-4-8`）と ローカル Ollama を実行時に選択可能。
- クロスプラットフォーム（Mac / Windows）。仮想オーディオデバイス等の OS 依存セットアップは不要。
- ドキュメント・UI・コメントは日本語。

## 構成

- `app.py` — 静的配信 + API（`/api/providers`, `/api/meetings`, `.../process`(SSE), `.../minutes`, `.../transcript`, `.../screen`）。拡張機能版（`chrome-extension://<id>`）からの fetch/SSE 用に CORS ミドルウェアを追加済み（`allow_origin_regex` で拡張オリジンと localhost を許可）。他のエンドポイント・処理は無変更。
- `lib/config.py` — `.env.local` 読込・パス解決・プロバイダ設定
- `lib/transcribe.py` — faster-whisper ラッパ（トラック別・逐次・モデル再利用）
- `lib/merge.py` — 時系列マージ + 話者ラベル（自分 / 相手・参加者）
- `lib/minutes.py` — プロンプト組立（要約 / 決定事項 / ToDo表）+ 生成オーケストレーション
- `lib/providers/` — `MinutesProvider` ABC + `claude.py` / `ollama.py` + ファクトリ
- `lib/storage.py` — 会議ごとの出力パス命名・保存（Windows 禁止文字を除去）
- `static/` — キャプチャUI（`getDisplayMedia`＋`getUserMedia` の2トラック音声録音
  ＋共有タブの画面録画 `screen.webm`）
- `extension/` — Chrome/Edge 拡張機能版（MV3）。Web版と並ぶ**もう一つのフロント
  エンド**で、同じ API（`/api/providers` `/api/meetings` `.../process`(SSE)
  `.../screen`）に投げる。`getDisplayMedia` 代わりに `chrome.tabCapture` でタブ音声を
  直接取得するため共有ダイアログ・「タブの音声も共有」チェックが不要。
  - `manifest.json`（MV3・permissions: tabCapture/offscreen/storage/activeTab、
    host_permissions: localhost:8000）
  - `background.js`（service worker・メッセージルータ＋状態集約。tabCapture の
    streamId 取得 → offscreen 起動。状態は `chrome.storage.local`）
  - `offscreen.html`/`offscreen.js`（実録音・アップロード・SSE。service worker では
    getUserMedia/MediaRecorder 不可のため offscreen document で録音。
    `static/capture.js` の該当部を移植。ストリーム取得のみ tabCapture 差し替え。
    tabCapture 中のタブ再生ミュートを `AudioContext.destination` 再接続で回避）
  - `popup.html`/`popup.js`（操作UI。状態は background から取得し popup 再オープンで復元）
  - `permission.html`/`permission.js`（マイク許可を拡張オリジンに一度だけ付与。
    offscreen からは許可プロンプト不可のため）
  - `styles.css`（`static/styles.css` を流用＋popup 用の調整）、`icons/`
  - **Web版（`static/`）・`lib/` は無変更。** ビルドツール無し構成のため共有モジュール化は
    せず移植とした（将来のリファクタ余地）。

## 音声取込の要点

- 会議はブラウザ版で実施。タブ音声（相手）= `getDisplayMedia({video:true, audio:true})`、
  マイク（自分）= `getUserMedia`。話者分離のため2トラックを合成せず別々に録音する。
- Chrome 制約: `getDisplayMedia` の音声取得には `video:true` が必須。取得後 video は `stop()`。
- Chrome / Edge 対象。macOS はタブ音声のみ（本用途で十分）。
- 画面録画: 破棄していた `getDisplayMedia` の映像トラックを保持し、3つ目の
  MediaRecorder で `displayStream`（映像＋タブ音声）を `screen.webm` として録画・保存
  （参照用）。文字起こし・議事録は `mic.webm` / `tab.webm` のみ使用し無変更。
  録画動画にはマイク＋タブ音声をミックスして合成する（WebAudio
  `MediaStreamAudioDestinationNode`）ため、映像＋全員の音声が1本にまとまる。
  文字起こしは `mic.webm` / `tab.webm` のみで無変更。動画は大きくなる点に注意。

## Claude 呼び出しの注意（重要）

- `messages.create` / `messages.stream` で `max_tokens=16000` 程度、
  `thinking={"type":"adaptive"}`、`output_config={"effort":"high"}`。
- `temperature` / `budget_tokens` は**渡さない**（Opus 4.8 で 400 エラー）。
- 長文トランスクリプトはストリーミングして `get_final_message()` で確定する。
- `anthropic.Anthropic()` は環境から `ANTHROPIC_API_KEY` を読む。

## 技術的前提

- ffmpeg CLI は不要。faster-whisper は PyAV（`av`、ffmpeg ライブラリ同梱 wheel）で
  WebM/Opus をデコードするため PATH 上の ffmpeg に依存しない。

## 開発コマンド

- セットアップ: `bash setup.sh`（= `uv sync`）
- 起動: `uv run uvicorn app:app --port 8000`
