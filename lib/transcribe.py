"""faster-whisper による文字起こしラッパ。

トラック（mic / tab）ごとに .webm を日本語で文字起こしする。
WhisperModel は重いため一度だけロードして再利用し、2トラックは
逐次実行する（大モデル二重ロードを避ける）。ffmpeg CLI は不要
（faster-whisper が PyAV 同梱の ffmpeg ライブラリで WebM/Opus を
デコードする）。
"""

from __future__ import annotations

import gc
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Iterable, Union

from . import config

if TYPE_CHECKING:
    import numpy as np

# path または デコード済み ndarray（16kHz mono float32）を受け取れる。
AudioInput = Union[Path, "np.ndarray"]

# モジュールレベルで WhisperModel / BatchedInferencePipeline をキャッシュ（プロセス内で再利用）
_model = None
_model_key: tuple[str, str] | None = None
_pipeline = None


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
        cpu_threads=config.whisper_cpu_threads(),
    )
    _model_key = key
    return _model


def _get_pipeline():
    """設定に応じた BatchedInferencePipeline を返す（初回のみ生成）。"""
    global _pipeline, _model_key
    from faster_whisper import BatchedInferencePipeline

    model = _get_model()
    if _pipeline is None or _pipeline.model is not model:
        _pipeline = BatchedInferencePipeline(model)
    return _pipeline


def release_model() -> None:
    """キャッシュ済み Whisper モデル/パイプラインを解放し RAM を返す。

    文字起こし完了後、ローカル議事録生成（Ollama）へ移る前に呼ぶことで、
    Whisper（turbo で ~6GB）と LLM のピーク RAM の重複を避ける。次回の
    transcribe_track 呼び出しで再ロードされるため冪等・安全。
    """
    global _model, _pipeline, _model_key
    device = config.whisper_device()
    _model = None
    _pipeline = None
    _model_key = None
    gc.collect()
    if device == "cuda":
        try:
            import torch

            torch.cuda.empty_cache()
        except Exception:
            pass


ProgressCb = Callable[[str, dict], None]


def transcribe_track(
    audio: AudioInput,
    source: str,
    on_progress: ProgressCb | None = None,
) -> list[dict]:
    """1トラックを文字起こしし、セグメントのリストを返す。

    各セグメントは {"source", "start", "end", "text"} の dict。
    source は "self"（マイク）または "others"（タブ音声）。
    on_progress は (source, {"end": 秒}) 形式で進捗を通知する。

    `audio` は .webm 等のファイルパス、または既にデコード済みの ndarray
    （16kHz mono float32）を受け取れる。ndarray を渡すと内部デコードを省く
    ため、tab トラックのように別処理（話者分離）と音声を共有でき二重デコードを
    避けられる。
    """
    pipeline = _get_pipeline()

    # faster-whisper の transcribe は path/str/ndarray を受け付ける。
    # Path はデコードのため str に、ndarray はそのまま渡す。
    audio_arg = str(audio) if isinstance(audio, Path) else audio

    # segments は遅延ジェネレータ。反復して確定させながら進捗を発火する。
    # word_timestamps は下流（merge/diarize/minutes）で未使用のため無効化し、
    # 単語アライメント処理ぶんの CPU/RAM を節約する（精度は不変）。
    # condition_on_previous_text=False は会議のノイズ区間での繰り返し・幻聴
    # （同一文の無限反復）を抑える定番設定。
    segments, _info = pipeline.transcribe(
        audio_arg,
        language="ja",
        vad_filter=True,
        word_timestamps=False,
        condition_on_previous_text=False,
        beam_size=5,
        batch_size=config.whisper_batch_size(),
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
