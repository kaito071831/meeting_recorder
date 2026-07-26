"""議事録プロンプトの組立とプロバイダ呼出しのオーケストレーション。

日本語ビジネス議事録として、議題・要約・決定事項・ToDo(表)・次回予定 の5節を厳守させる。
全文トランスクリプトは LLM で再生成せず別ファイルに保存する。
"""

from __future__ import annotations

from pathlib import Path

SYSTEM_JA = (
    "あなたは日本語のビジネス会議の議事録作成アシスタントです。"
    "与えられたタイムスタンプ付きトランスクリプトのみを根拠に、"
    "簡潔で正確な議事録を Markdown で作成します。"
    "事実の捏造は禁止です。トランスクリプトから読み取れない事項は"
    "推測せず「不明」と明記してください。話者ラベルは「自分」（マイク音声）と"
    "「相手・参加者」（会議タブ音声）です。"
)


def build_user_prompt(transcript_md: str, meeting_title: str) -> str:
    """議事録生成用のユーザープロンプトを組み立てる。"""
    return (
        f"# 会議タイトル\n{meeting_title or '（無題）'}\n\n"
        "以下はこの会議のタイムスタンプ付きトランスクリプトです。"
        "これだけを根拠に、次の節を**この順序・この見出しで**含む議事録を"
        "Markdown で作成してください。\n\n"
        "1. `## 議題` — 会議で扱われた話題を箇条書きで列挙。\n"
        "2. `## 要約` — 見出しは付けず、会議全体の要点を箇条書きで詳しく列挙。\n"
        "3. `## 決定事項` — 箇条書き。決定がなければ「特になし」。\n"
        "4. `## ToDo` — 次の表形式。担当や期限が不明な場合は「未定」と記載。\n"
        "   `| 内容 | 担当 | 期限 |`\n"
        "5. `## 次回予定` — 次回の日時・議題など。言及がなければ「特になし」。\n\n"
        "全文トランスクリプトは別途保存済みのため、議事録内に再掲しないでください。\n\n"
        "---\n\n"
        f"{transcript_md}\n"
    )


def generate_minutes(
    provider,
    transcript_md: str,
    meeting_title: str,
    workspace: Path,
) -> dict:
    """プロバイダで議事録を生成し minutes.md に保存する。"""
    minutes_md = provider.generate(transcript_md, meeting_title)
    minutes_path = workspace / "minutes.md"
    minutes_path.write_text(minutes_md, encoding="utf-8")
    return {"minutes_md": minutes_md, "minutes_md_path": minutes_path}
