"""議事録生成プロバイダのファクトリと利用可否プローブ。

work_dashboard の provider.ts / claudeAvailable() / ollamaModels() を
Python に移植したもの。実行時にプロバイダ（claude / ollama）を選択できる。
"""

from __future__ import annotations

from .base import MinutesProvider
from .claude import ClaudeProvider, claude_available
from .ollama import OllamaProvider, ollama_models


def available_providers() -> dict:
    """UI のプロバイダ選択を駆動する利用可否情報を返す。

    {"claude": bool, "ollama": [モデル名, ...]}
    """
    return {
        "claude": claude_available(),
        "ollama": ollama_models(),
    }


def get_provider(name: str, model: str | None = None) -> MinutesProvider:
    """プロバイダ名からインスタンスを生成する。"""
    if name == "claude":
        return ClaudeProvider(model=model)
    if name == "ollama":
        return OllamaProvider(model=model)
    raise ValueError(f"未知のプロバイダ: {name}")


__all__ = [
    "MinutesProvider",
    "ClaudeProvider",
    "OllamaProvider",
    "available_providers",
    "get_provider",
]
