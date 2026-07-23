"""ClaudeProvider — Anthropic SDK で議事録を生成する。

claude-opus-4-8 を、adaptive thinking + effort=high で呼び出す。
temperature / budget_tokens は渡さない（Opus 4.8 で 400 になる）。
長文トランスクリプトはストリーミングして get_final_message() で確定する
（大きな max_tokens での HTTP タイムアウトを避ける）。
"""

from __future__ import annotations

from .. import config
from ..minutes import SYSTEM_JA, build_user_prompt
from .base import MinutesProvider


def claude_available() -> bool:
    """ANTHROPIC_API_KEY が設定されていれば Claude を利用可能とみなす。"""
    return bool(config.anthropic_api_key())


class ClaudeProvider(MinutesProvider):
    id = "claude"

    def __init__(self, model: str | None = None):
        # anthropic.Anthropic() は環境から ANTHROPIC_API_KEY を読む
        import anthropic

        self._model = model or config.claude_model()
        self._client = anthropic.Anthropic()

    def generate(self, transcript_md: str, meeting_title: str) -> str:
        user_prompt = build_user_prompt(transcript_md, meeting_title)

        # 長文入力・大きめ出力になり得るためストリーミングで実行する。
        with self._client.messages.stream(
            model=self._model,
            max_tokens=16000,
            thinking={"type": "adaptive"},
            output_config={"effort": "high"},
            system=SYSTEM_JA,
            messages=[{"role": "user", "content": user_prompt}],
        ) as stream:
            message = stream.get_final_message()

        # テキストブロックのみを連結して返す
        parts = [b.text for b in message.content if b.type == "text"]
        return "".join(parts).strip()
