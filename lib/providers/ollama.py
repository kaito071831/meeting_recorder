"""OllamaProvider — ローカル Ollama で議事録を生成する。

/api/tags で疎通・モデル一覧を確認し、/api/chat に同一の system+user
プロンプトを投げる。既定モデルは OLLAMA_MODEL、なければインストール済み
一覧の先頭を使う。
"""

from __future__ import annotations

import httpx

from .. import config
from ..minutes import SYSTEM_JA, build_user_prompt
from .base import MinutesProvider


def ollama_models(timeout: float = 1.5) -> list[str]:
    """インストール済みモデル名の一覧。疎通できなければ空リスト。"""
    try:
        resp = httpx.get(f"{config.ollama_base_url()}/api/tags", timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return []
    models = []
    for m in data.get("models", []) or []:
        name = m.get("name") or m.get("model") or ""
        if name:
            models.append(name)
    return models


def ollama_available() -> bool:
    return len(ollama_models()) > 0


class OllamaProvider(MinutesProvider):
    id = "ollama"

    def __init__(self, model: str | None = None):
        self._model = model or config.ollama_default_model()
        if not self._model:
            installed = ollama_models()
            if not installed:
                raise RuntimeError("Ollama にインストール済みモデルがありません")
            self._model = installed[0]

    def generate(self, transcript_md: str, meeting_title: str) -> str:
        user_prompt = build_user_prompt(transcript_md, meeting_title)

        # 長時間の生成に耐えるようタイムアウトを広めに取る。
        resp = httpx.post(
            f"{config.ollama_base_url()}/api/chat",
            json={
                "model": self._model,
                "stream": False,
                "messages": [
                    {"role": "system", "content": SYSTEM_JA},
                    {"role": "user", "content": user_prompt},
                ],
            },
            timeout=httpx.Timeout(600.0),
        )
        resp.raise_for_status()
        data = resp.json()
        return (data.get("message", {}).get("content") or "").strip()
