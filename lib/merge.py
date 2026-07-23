"""トラック別セグメントの時系列マージと話者ラベル付与。

共有 t0 で録音した2トラックのため、start をそのまま比較して
時系列に並べられる。source→話者ラベルは 自分 / 相手・参加者。
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


def merge_segments(segments: list[dict]) -> list[dict]:
    """start 昇順にソートしたセグメントのリストを返す。"""
    return sorted(segments, key=lambda s: (s["start"], s.get("source", "")))


def to_transcript_md(segments: list[dict]) -> str:
    """マージ済セグメントをタイムスタンプ＋話者ラベル付き Markdown に整形する。"""
    lines = ["# トランスクリプト", ""]
    for seg in segments:
        label = SOURCE_LABELS.get(seg["source"], seg["source"])
        ts = _fmt_ts(seg["start"])
        lines.append(f"[{ts}] {label}: {seg['text']}")
    lines.append("")
    return "\n".join(lines)


def write_outputs(segments: list[dict], workspace: Path) -> dict:
    """transcript.md と transcript.json を書き出し、パスを返す。

    transcript.json は生セグメント（両トラック）を保持し、別プロバイダでの
    議事録再生成時に再文字起こしを不要にする。
    """
    merged = merge_segments(segments)
    md = to_transcript_md(merged)

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
