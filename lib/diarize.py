"""タブ音声（相手・参加者）内の複数話者を分離する。

resemblyzer の軽量話者埋め込み + `sklearn.cluster.AgglomerativeClustering`
（コサイン距離、`distance_threshold` で話者数を自動推定）により、タブ音声
セグメントを話者ごとにクラスタリングし `speaker_id`（1始まり、発話開始が
早い順の初出順）を付与する。話者分離は補助機能であり、無効化・データ不足・
例外はすべて `speaker_id=None`（既存の単一ラベル表示）へのフォールバックと
して本モジュール内で握り込み、会議処理全体を止めない。呼び出し側で追加の
例外処理は不要。
"""

from __future__ import annotations

import logging
from pathlib import Path

from . import config

logger = logging.getLogger(__name__)

# これ未満の長さのセグメントは埋め込みが不安定になるため計算をスキップする。
# 実データでの検証は未実施（config化はせずモジュール内定数とする）。
_MIN_SEGMENT_SECONDS = 0.6

_SAMPLE_RATE = 16000

# VoiceEncoder はロードが重いためモジュールレベルでキャッシュする
# （transcribe.py の _get_model()/_get_pipeline() と同じ方針）。
_encoder = None


def _get_encoder():
    global _encoder
    from resemblyzer import VoiceEncoder

    if _encoder is None:
        _encoder = VoiceEncoder(verbose=False)
    return _encoder


def _fallback(segments: list[dict]) -> list[dict]:
    """全セグメントに speaker_id=None を付与したコピーを返す。"""
    return [dict(seg, speaker_id=None) for seg in segments]


def diarize_track(audio_path: Path, segments: list[dict]) -> list[dict]:
    """タブ音声セグメントに speaker_id を付与して返す（元の dict は変更しない）。

    speaker_id は 2人以上のクラスタを検出できた場合のみ 1始まりの int、それ
    以外（無効化・セグメント不足・単一クラスタへの収束・例外発生）はすべて
    None を返す。埋め込み計算をスキップした短い/無音セグメントには、時間的
    に最も近いラベル付きセグメントの speaker_id を割り当てる簡易ヒューリス
    ティックのため、発話の境界付近では誤帰属し得る。
    """
    try:
        if not config.diarization_enabled() or len(segments) < 2:
            return _fallback(segments)

        import numpy as np
        from faster_whisper.audio import decode_audio
        from resemblyzer import preprocess_wav
        from sklearn.cluster import AgglomerativeClustering

        wav = decode_audio(
            str(audio_path), sampling_rate=_SAMPLE_RATE, split_stereo=False
        )
        encoder = _get_encoder()

        embeddings: list[np.ndarray] = []
        embedded_indices: list[int] = []
        for i, seg in enumerate(segments):
            start, end = float(seg["start"]), float(seg["end"])
            if end - start < _MIN_SEGMENT_SECONDS:
                continue
            start_sample = int(start * _SAMPLE_RATE)
            end_sample = min(int(end * _SAMPLE_RATE), len(wav))
            chunk = wav[start_sample:end_sample]
            if chunk.size == 0:
                continue
            processed = preprocess_wav(chunk, source_sr=_SAMPLE_RATE)
            if processed.size == 0:
                continue
            embeddings.append(encoder.embed_utterance(processed))
            embedded_indices.append(i)

        if len(embeddings) < 2:
            return _fallback(segments)

        clustering = AgglomerativeClustering(
            n_clusters=None,
            metric="cosine",
            linkage="average",
            distance_threshold=config.diarization_distance_threshold(),
        )
        raw_labels = clustering.fit_predict(np.stack(embeddings))

        if len(set(raw_labels)) < 2:
            return _fallback(segments)

        # 生のクラスタ番号は順序が不定なため、発話開始時刻が早い順の初出順で
        # 1, 2, 3... に振り直す（クラスタサイズ順は再実行時の入れ替わりリスクがある）。
        ordered = sorted(
            zip(embedded_indices, raw_labels),
            key=lambda pair: float(segments[pair[0]]["start"]),
        )
        remap: dict[int, int] = {}
        for idx, raw_label in ordered:
            if raw_label not in remap:
                remap[raw_label] = len(remap) + 1

        speaker_by_index = {
            idx: remap[raw_label]
            for idx, raw_label in zip(embedded_indices, raw_labels)
        }

        result = [dict(seg) for seg in segments]
        for i, seg in enumerate(result):
            seg["speaker_id"] = speaker_by_index.get(i)

        # 埋め込みをスキップした短い/無音セグメントには、時間的に最も近い
        # ラベル付きセグメントの speaker_id を割り当てる。
        labeled_starts = sorted(
            (float(segments[i]["start"]), sid)
            for i, sid in speaker_by_index.items()
        )
        for i, seg in enumerate(result):
            if seg["speaker_id"] is not None:
                continue
            t = float(seg["start"])
            seg["speaker_id"] = min(
                labeled_starts, key=lambda pair: abs(pair[0] - t)
            )[1]

        return result
    except Exception:
        logger.exception(
            "話者分離に失敗したため speaker_id=None にフォールバックします。"
        )
        return _fallback(segments)
