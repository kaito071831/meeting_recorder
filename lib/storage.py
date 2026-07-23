"""会議ごとの出力ワークスペースの命名・作成・保存。

`output/<YYYY-MM-DD>_<HHMM>_<slug(title)>/` に各成果物を保存する。
Windows 禁止文字を除去し、Mac/Win の双方で有効なパスを生成する。
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

from . import config

# Windows で使えない文字（\ / : * ? " < > |）と制御文字を除去する
_INVALID_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def slugify(title: str) -> str:
    """タイトルをディレクトリ名に使える安全な slug に変換する。"""
    title = (title or "").strip()
    title = _INVALID_CHARS.sub("", title)
    # 空白類はハイフンに、連続ハイフンは1つにまとめる
    title = re.sub(r"\s+", "-", title)
    title = re.sub(r"-+", "-", title).strip("-.")
    return title or "meeting"


def create_workspace(title: str, now: datetime | None = None) -> tuple[str, Path]:
    """会議用ディレクトリを作成し、(meeting_id, パス) を返す。

    meeting_id はディレクトリ名そのもの（例: 2026-07-23_1430_weekly-sync）。
    同名が既に存在する場合は連番を付与して衝突を避ける。
    """
    config.ensure_dirs()
    now = now or datetime.now()
    stamp = now.strftime("%Y-%m-%d_%H%M")
    base = f"{stamp}_{slugify(title)}"

    meeting_id = base
    path = config.OUTPUT_DIR / meeting_id
    suffix = 1
    while path.exists():
        suffix += 1
        meeting_id = f"{base}-{suffix}"
        path = config.OUTPUT_DIR / meeting_id
    path.mkdir(parents=True)
    return meeting_id, path


def workspace_path(meeting_id: str) -> Path:
    """既存の会議ディレクトリを返す。存在チェックはしない。"""
    return config.OUTPUT_DIR / meeting_id


def workspace_exists(meeting_id: str) -> bool:
    p = workspace_path(meeting_id)
    return p.is_dir()
