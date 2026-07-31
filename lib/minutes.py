"""議事録プロンプトの組立とプロバイダ呼出しのオーケストレーション。

日本語ビジネス議事録として、議題・要約・議事録・決定事項・ToDo(表)・次回予定 の6節を厳守させる。
全文トランスクリプトは LLM で再生成せず別ファイルに保存する。
`## 議事録` での話者帰属は、トランスクリプト中の非自分ラベルの種類数
（話者分離により「相手・参加者1」「相手・参加者2」...や実名に分かれているか）
に応じて指示文が分岐する（`_distinct_other_labels` / `build_user_prompt` 参照）。
"""

from __future__ import annotations

import re
from pathlib import Path

SYSTEM_JA = (
    "あなたは日本語のビジネス会議の議事録作成アシスタントです。"
    "与えられたタイムスタンプ付きトランスクリプトのみを根拠に、"
    "簡潔で正確な議事録を Markdown で作成します。"
    "事実の捏造は禁止です。トランスクリプトから読み取れない事項は"
    "推測せず「不明」と明記してください。話者ラベルは「自分」（マイク音声）と"
    "「相手・参加者」（会議タブ音声、番号や実名で分かれている場合もあります）"
    "ですが、これはトランスクリプトを読み解くための音声トラック区分です。"
    "本文中でこれらのラベルをどう扱うかは、後続のユーザー指示（ユーザー"
    "プロンプト）の指定に従ってください。"
)

_LABEL_RE = re.compile(r"^\[[^\]]+\]\s+([^:]+):", re.MULTILINE)


def _distinct_other_labels(transcript_md: str) -> set[str]:
    """トランスクリプト中の「自分」以外の話者ラベルの集合を返す。

    番号ラベル（相手・参加者1 など）・リネーム後の実名のいずれでも同じ
    正規表現で抽出できる。
    """
    labels = {m.group(1) for m in _LABEL_RE.finditer(transcript_md)}
    labels.discard("自分")
    return labels


def build_user_prompt(transcript_md: str, meeting_title: str) -> str:
    """議事録生成用のユーザープロンプトを組み立てる。"""
    distinct = _distinct_other_labels(transcript_md)
    if len(distinct) >= 2:
        speaker_instruction = (
            "話者分離により「相手・参加者」は複数のラベル（番号または実名）に"
            "分かれています。トランスクリプトに現れるラベルをそのまま使って"
            "発言内容を各話者に帰属させて構いませんが、トランスクリプトに"
            "実在しないラベルや名前を創作しないでください。話者分離は自動処理"
            "のため取りこぼしや誤帰属があり得ます。この点は `## 議事録` の"
            "冒頭で一度だけ簡潔に注意書きしてください（箇条書き単位で"
            "「〜と思われる」を連発しないこと）。"
        )
    else:
        speaker_instruction = (
            "「自分」「相手・参加者」という話者ラベルは発言者の特定に使わず"
            "本文にも書き出さないでください。"
        )
    return (
        f"# 会議タイトル\n{meeting_title or '（無題）'}\n\n"
        "以下はこの会議のタイムスタンプ付きトランスクリプトです。"
        "これだけを根拠に、次の節を**この順序・この見出しで**含む議事録を"
        "Markdown で作成してください。\n\n"
        "1. `## 議題` — 会議で扱われた話題を箇条書きで列挙。\n"
        "2. `## 要約` — 見出しは付けず、会議全体の要点を箇条書きで詳しく列挙。\n"
        "3. `## 議事録` — `## 議題` で列挙した議題ごとに `### <議題名>` の"
        "小見出しで区切り、その議題における発言の流れ・論点・出た意見や提案の内容・"
        "どのような結論やニュアンスに至ったかを、後から読み返してもやり取りの経緯が"
        f"追えるレベルまで詳細に記述してください。{speaker_instruction}"
        "トランスクリプトから読み取れない内容は捏造せず「不明」と明記してください。\n"
        "4. `## 決定事項` — 箇条書き。決定がなければ「特になし」。\n"
        "5. `## ToDo` — 次の表形式。担当や期限が不明な場合は「未定」と記載。\n"
        "   `| 内容 | 担当 | 期限 |`\n"
        "6. `## 次回予定` — 次回の日時・議題など。言及がなければ「特になし」。\n\n"
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
