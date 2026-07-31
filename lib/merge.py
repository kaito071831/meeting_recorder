"""トラック別セグメントの時系列マージと話者ラベル付与。

共有 t0 で録音した2トラックのため、start をそのまま比較して
時系列に並べられる。source→話者ラベルは 自分 / 相手・参加者。
タブ音声（others）は `diarize.diarize_track` により `speaker_id` を
持ち得る。2人以上のクラスタが検出された場合、`speaker_id` は
「相手・参加者N」という番号ラベルに展開され、`speaker_names` を渡すことで
任意の表示名（実名リネーム）にも展開できる。
"""

from __future__ import annotations

import json
from pathlib import Path

# ソース種別 → 表示ラベル
SOURCE_LABELS = {
    "self": "自分",
    "others": "相手・参加者",
}


def _fmt_ts(seconds: float) -> str:
    """秒を [HH:MM:SS] 形式に整形する。"""
    total = int(seconds)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h:02d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def _label_for(seg: dict, speaker_names: dict[str, str] | None = None) -> str:
    """セグメントの表示ラベルを決める。

    others かつ speaker_id が確定している場合は「相手・参加者N」（または
    speaker_names 指定時はその表示名）、それ以外は SOURCE_LABELS のフォール
    バックを返す。
    """
    if seg["source"] == "others" and seg.get("speaker_id") is not None:
        key = str(seg["speaker_id"])
        if speaker_names and key in speaker_names:
            return speaker_names[key]
        return f"相手・参加者{seg['speaker_id']}"
    return SOURCE_LABELS.get(seg["source"], seg["source"])


def merge_segments(segments: list[dict]) -> list[dict]:
    """start 昇順にソートしたセグメントのリストを返す。"""
    return sorted(segments, key=lambda s: (s["start"], s.get("source", "")))


def to_transcript_md(
    segments: list[dict], speaker_names: dict[str, str] | None = None
) -> str:
    """マージ済セグメントをタイムスタンプ＋話者ラベル付き Markdown に整形する。"""
    lines = ["# トランスクリプト", ""]
    for seg in segments:
        label = _label_for(seg, speaker_names)
        ts = _fmt_ts(seg["start"])
        lines.append(f"[{ts}] {label}: {seg['text']}")
    lines.append("")
    return "\n".join(lines)


def write_outputs(
    segments: list[dict],
    workspace: Path,
    speaker_names: dict[str, str] | None = None,
) -> dict:
    """transcript.md と transcript.json を書き出し、パスを返す。

    transcript.json には常に生の speaker_id（int/None）を保存し、表示名は
    保存しない。これにより、リネーム後は再文字起こしせず transcript.json
    から transcript.md を再生成できる。
    """
    merged = merge_segments(segments)
    md = to_transcript_md(merged, speaker_names)

    md_path = workspace / "transcript.md"
    json_path = workspace / "transcript.json"

    md_path.write_text(md, encoding="utf-8")
    json_path.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    return {
        "transcript_md": md,
        "transcript_md_path": md_path,
        "transcript_json_path": json_path,
        "segments": merged,
    }
