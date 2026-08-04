"""FastAPI エントリ — 静的キャプチャページの配信と API。

会議音声（マイク／タブの2トラック）を受け取り、faster-whisper で
文字起こし → 時系列マージ → 選択プロバイダで議事録生成 を行い、
進捗を SSE で通知しつつ Markdown を保存・返却する。

起動:
    .venv/bin/uvicorn app:app --port 8000
"""

from __future__ import annotations

import asyncio
import json
import queue
import threading

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from lib import config, diarize, merge, minutes, storage, transcribe
from lib.providers import available_providers, get_provider

config.ensure_dirs()

app = FastAPI(title="meeting_recorder")

# 拡張機能版（chrome-extension://<id>）からの fetch / SSE を確実に許可する。
# host_permissions があれば拡張は CORS を跨げるが、Chrome/Edge のバージョン差の
# 保険として明示的に許可しておく。同一オリジンの Web版（static/）には影響しない。
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension://.*|http://localhost(:\d+)?)$",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(config.STATIC_DIR / "index.html")


@app.get("/api/providers")
def providers() -> JSONResponse:
    """UI のプロバイダ選択を駆動する利用可否情報。"""
    return JSONResponse(available_providers())


@app.post("/api/meetings")
async def create_meeting(
    mic: UploadFile | None = None,
    tab: UploadFile | None = None,
    screen: UploadFile | None = None,
    title: str = Form(""),
    provider: str = Form("claude"),
    model: str = Form(""),
) -> JSONResponse:
    """ワークスペースを作成し、mic/tab/screen の .webm を保存して meeting_id を返す。

    screen（共有タブの映像＋タブ音声）は参照用の追加成果物で、文字起こし・
    議事録生成には使わない（`_process_worker` は mic/tab のみ参照する）。
    """
    meeting_id, ws = storage.create_workspace(title)

    saved = {}
    for label, upload in (("mic", mic), ("tab", tab), ("screen", screen)):
        if upload is None:
            continue
        data = await upload.read()
        if not data:
            continue
        dest = ws / f"{label}.webm"
        dest.write_bytes(data)
        saved[label] = dest.name

    # 後段の処理用にメタ情報を保存する
    meta = {
        "title": title,
        "provider": provider,
        "model": model or None,
        "tracks": saved,
    }
    (ws / "meeting.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    return JSONResponse({"meeting_id": meeting_id, "tracks": saved})


# faster-whisper が内部デコードに用いるサンプルレート（diarize と共通）。
_SAMPLE_RATE = 16000

# ピーク正規化のヘッドルーム（0dBFS 直前でのクリップ・歪み回避のため少し下げる）。
_NORMALIZE_PEAK = 0.97


def _decode_normalized(audio_path):
    """音声を 16kHz mono float32 にデコードしピーク正規化した ndarray を返す。

    ffmpeg CLI 非依存の faster-whisper 同梱デコーダを使う（AGENTS.md 準拠）。
    正規化はピーク基準＋ヘッドルームで、無音（全ゼロ）や取得失敗時は
    元の波形をそのまま返し安全側に倒す。
    """
    import numpy as np
    from faster_whisper.audio import decode_audio

    wav = decode_audio(
        str(audio_path), sampling_rate=_SAMPLE_RATE, split_stereo=False
    )
    peak = float(np.max(np.abs(wav))) if wav.size else 0.0
    if peak > 0:
        wav = (wav * (_NORMALIZE_PEAK / peak)).astype(np.float32)
    return wav


def _process_worker(meeting_id: str, q: "queue.Queue") -> None:
    """別スレッドで文字起こし〜議事録生成を実行し、進捗を queue に送る。"""

    def emit(stage: str, **data) -> None:
        q.put({"stage": stage, **data})

    try:
        ws = storage.workspace_path(meeting_id)
        meta = json.loads((ws / "meeting.json").read_text(encoding="utf-8"))
        title = meta.get("title", "")
        provider_name = meta.get("provider", "claude")
        model = meta.get("model")

        emit("uploaded")

        # ── 文字起こし（トラックごとに逐次）──────────────────
        segments: list[dict] = []
        for label, source in (("mic", "self"), ("tab", "others")):
            audio = ws / f"{label}.webm"
            if not audio.exists():
                continue
            emit(f"transcribing_{label}")

            def on_progress(src, info, _label=label):
                q.put({"stage": f"transcribing_{_label}", "progress": info})

            # tab は文字起こしと話者分離の両方で音声を使うため、一度だけ
            # デコード＋ピーク正規化した ndarray を両処理に渡し二重デコードを
            # 避ける（正規化は声の小さい参加者の取りこぼし低減が狙い）。
            # mic は文字起こしのみのためパスのまま渡す。
            audio_input = (
                _decode_normalized(audio) if label == "tab" else audio
            )

            track_segments = transcribe.transcribe_track(
                audio_input, source, on_progress=on_progress
            )
            if label == "tab":
                emit("diarizing")
                track_segments = diarize.diarize_track(
                    audio_input, track_segments
                )
            segments.extend(track_segments)

        # ── マージ ────────────────────────────────────────────
        emit("merging")
        merged = merge.write_outputs(segments, ws)

        # ── 議事録生成 ────────────────────────────────────────
        # ローカル LLM（Ollama）は RAM を大きく使う（gemma で ~8.9GB）。
        # Whisper（turbo ~6GB）と VoiceEncoder を先に解放し、ピーク RAM の
        # 重複を避ける。Claude API 利用時はローカル LLM が載らずモデル
        # 再利用のメリットが勝るため解放しない。
        if provider_name == "ollama":
            transcribe.release_model()
            diarize.release_encoder()

        emit("generating_minutes")
        provider = get_provider(provider_name, model=model)
        result = minutes.generate_minutes(
            provider, merged["transcript_md"], title, ws
        )

        emit(
            "done",
            minutes_md=result["minutes_md"],
            transcript_md=merged["transcript_md"],
        )
    except Exception as exc:  # noqa: BLE001 — UI にエラーを返すため全捕捉
        emit("error", message=str(exc))
    finally:
        q.put(None)  # 終端マーカー


@app.post("/api/meetings/{meeting_id}/process")
async def process_meeting(meeting_id: str) -> StreamingResponse:
    """文字起こし→マージ→議事録生成を実行し、SSE で段階通知する。"""
    if not storage.workspace_exists(meeting_id):
        raise HTTPException(status_code=404, detail="meeting not found")

    q: "queue.Queue" = queue.Queue()
    thread = threading.Thread(
        target=_process_worker, args=(meeting_id, q), daemon=True
    )
    thread.start()

    async def event_stream():
        loop = asyncio.get_event_loop()
        while True:
            item = await loop.run_in_executor(None, q.get)
            if item is None:
                break
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def _read_or_404(meeting_id: str, filename: str) -> str:
    if not storage.workspace_exists(meeting_id):
        raise HTTPException(status_code=404, detail="meeting not found")
    path = storage.workspace_path(meeting_id) / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"{filename} not found")
    return path.read_text(encoding="utf-8")


@app.get("/api/meetings/{meeting_id}/minutes")
def get_minutes(meeting_id: str) -> JSONResponse:
    return JSONResponse({"minutes_md": _read_or_404(meeting_id, "minutes.md")})


@app.get("/api/meetings/{meeting_id}/transcript")
def get_transcript(meeting_id: str) -> JSONResponse:
    return JSONResponse(
        {"transcript_md": _read_or_404(meeting_id, "transcript.md")}
    )


@app.get("/api/meetings/{meeting_id}/screen")
def get_screen(meeting_id: str) -> FileResponse:
    """共有タブの画面録画（screen.webm）をダウンロード用に返す。"""
    if not storage.workspace_exists(meeting_id):
        raise HTTPException(status_code=404, detail="meeting not found")
    path = storage.workspace_path(meeting_id) / "screen.webm"
    if not path.exists():
        raise HTTPException(status_code=404, detail="screen.webm not found")
    return FileResponse(
        path, media_type="video/webm", filename="screen.webm"
    )


@app.get("/api/meetings/{meeting_id}/speakers")
def get_speakers(meeting_id: str) -> JSONResponse:
    """話者番号→表示名のリネーム設定を返す（未設定時は {}）。"""
    if not storage.workspace_exists(meeting_id):
        raise HTTPException(status_code=404, detail="meeting not found")
    path = storage.workspace_path(meeting_id) / "speakers.json"
    if not path.exists():
        return JSONResponse({})
    return JSONResponse(json.loads(path.read_text(encoding="utf-8")))


@app.post("/api/meetings/{meeting_id}/speakers")
def set_speakers(meeting_id: str, mapping: dict[str, str]) -> JSONResponse:
    """話者番号→表示名のリネーム設定を保存し、transcript.md・minutes.md を再生成する。

    再文字起こしは行わない（transcript.json の生セグメントから再構築する）。
    """
    if not storage.workspace_exists(meeting_id):
        raise HTTPException(status_code=404, detail="meeting not found")
    ws = storage.workspace_path(meeting_id)
    transcript_json_path = ws / "transcript.json"
    if not transcript_json_path.exists():
        raise HTTPException(status_code=404, detail="transcript.json not found")

    (ws / "speakers.json").write_text(
        json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    segments = json.loads(transcript_json_path.read_text(encoding="utf-8"))
    transcript_md = merge.to_transcript_md(segments, speaker_names=mapping)
    (ws / "transcript.md").write_text(transcript_md, encoding="utf-8")

    meta = json.loads((ws / "meeting.json").read_text(encoding="utf-8"))
    provider = get_provider(meta.get("provider", "claude"), model=meta.get("model"))
    result = minutes.generate_minutes(
        provider, transcript_md, meta.get("title", ""), ws
    )

    return JSONResponse(
        {"transcript_md": transcript_md, "minutes_md": result["minutes_md"]}
    )


# 静的アセット（capture.js / styles.css）を /static で配信
app.mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static")
