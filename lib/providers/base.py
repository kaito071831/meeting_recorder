"""議事録生成プロバイダの抽象基底。"""

from __future__ import annotations

from abc import ABC, abstractmethod


class MinutesProvider(ABC):
    """議事録生成プロバイダの共通インターフェース。"""

    id: str

    @abstractmethod
    def generate(self, transcript_md: str, meeting_title: str) -> str:
        """トランスクリプトから議事録 Markdown を生成して返す。"""
        raise NotImplementedError
