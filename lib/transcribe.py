"""faster-whisper による文字起こしラッパ。

トラック（mic / tab）ごとに .webm を日本語で文字起こしする。
WhisperModel は重いため一度だけロードして再利用し、2トラックは
逐次実行する（大モデル二重ロードを避ける）。ffmpeg CLI は不要
（faster-whisper が PyAV 同梱の ffmpeg ライブラリで WebM/Opus を
デコードする）。
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Iterable

from . import config

# モジュールレベルで WhisperModel をキャッシュ（プロセス内で再利用）
_model = None
_model_key: tuple[str, str] | None = None


def _get_model():
    """設定に応じた WhisperModel を返す（初回のみロード）。"""
    global _model, _model_key
    from faster_whisper import WhisperModel

    size = config.whisper_model_name()
    device = config.whisper_device()
    key = (size, device)
    if _model is not None and _model_key == key:
        return _model

    # CPU int8 が Mac/Win ノートの現実的経路。CUDA があれば float16。
    compute_type = "float16" if device == "cuda" else "int8"
    config.ensure_dirs()
    _model = WhisperModel(
        size,
        device=device,
        compute_type=compute_type,
        download_root=str(config.MODELS_DIR),
    )
    _model_key = key
    return _model


ProgressCb = Callable[[str, dict], None]


def transcribe_track(
    audio_path: Path,
    source: str,
    on_progress: ProgressCb | None = None,
) -> list[dict]:
    """1トラックを文字起こしし、セグメントのリストを返す。

    各セグメントは {"source", "start", "end", "text"} の dict。
    source は "self"（マイク）または "others"（タブ音声）。
    on_progress は (source, {"end": 秒}) 形式で進捗を通知する。
    """
    model = _get_model()

    # segments は遅延ジェネレータ。反復して確定させながら進捗を発火する。
    segments, _info = model.transcribe(
        str(audio_path),
        language="ja",
        vad_filter=True,
        word_timestamps=True,
        beam_size=5,
    )

    result: list[dict] = []
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        result.append(
            {
                "source": source,
                "start": float(seg.start),
                "end": float(seg.end),
                "text": text,
            }
        )
        if on_progress is not None:
            on_progress(source, {"end": float(seg.end)})
    return result


def transcribe_tracks(
    tracks: Iterable[tuple[Path, str]],
    on_progress: ProgressCb | None = None,
) -> list[dict]:
    """複数トラックを逐次文字起こしし、全セグメントを連結して返す。"""
    all_segments: list[dict] = []
    for audio_path, source in tracks:
        if not audio_path.exists():
            continue
        all_segments.extend(
            transcribe_track(audio_path, source, on_progress=on_progress)
        )
    return all_segments
