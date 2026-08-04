"""環境設定の読込とパス解決。

`.env.local` を読み込み、Whisper モデルのキャッシュ先や
プロバイダ選択に必要な値を提供する。work_dashboard の設定思想に倣う。
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from dotenv import load_dotenv

logger = logging.getLogger(__name__)

# プロジェクトルート（このファイルは lib/ 配下）
ROOT_DIR = Path(__file__).resolve().parent.parent

# .env.local を読み込む（存在しなくてもエラーにしない）
load_dotenv(ROOT_DIR / ".env.local")

# 出力ワークスペースと faster-whisper モデルキャッシュ
OUTPUT_DIR = ROOT_DIR / "output"
MODELS_DIR = ROOT_DIR / "models"
STATIC_DIR = ROOT_DIR / "static"

# large-v3-turbo は初回のみ約1.5GBのダウンロードが発生する。
# HF_HOME を models/ に固定してキャッシュ先を安定させる。
os.environ.setdefault("HF_HOME", str(MODELS_DIR))


def ensure_dirs() -> None:
    """出力・モデルディレクトリを作成する（冪等）。"""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)


# ── ハード検出 ────────────────────────────────────────────────
def available_ram_gb() -> float | None:
    """利用可能な物理 RAM（GB）。取得できなければ None。

    psutil の available（OS が新規プロセスに割り当て可能と推定する量）を
    使う。cross-platform に確実な指標で、空きだけでなく回収可能なキャッシュも
    含むため実運用のヘッドルームに近い。psutil 不在・例外時は None を返し、
    呼び出し側は既定値（自動調整なし）へフォールバックする。
    """
    try:
        import psutil

        return psutil.virtual_memory().available / (1024**3)
    except Exception:
        logger.warning("psutil による RAM 取得に失敗。既定値を使用します。")
        return None


# ── Whisper 設定 ──────────────────────────────────────────────
def whisper_model_name() -> str:
    """使用する faster-whisper モデルサイズ。既定 large-v3-turbo。

    `WHISPER_MODEL` の明示指定は常に尊重する。未設定かつ利用可能 RAM が
    極端に少ない機（<6GB）のときだけ `small` へ自動フォールバックする最終
    安全網（OOM で動かないよりマシ。精度は下がる）。

    medium への降格は行わない: turbo(809M) と medium(769M) は int8 の
    フットプリントがほぼ同じで RAM をほとんど節約できず、精度は turbo の方が
    高いため、降格は逆効果になる。RAM ピークの主因は batch_size 側で調整する。
    """
    env = os.environ.get("WHISPER_MODEL")
    if env:
        return env

    default = "large-v3-turbo"
    ram = available_ram_gb()
    if ram is not None and ram < 6:
        model = "small"
    else:
        model = default

    if model != default:
        logger.warning(
            "利用可能 RAM %.1fGB のため Whisper モデルを %s に自動降格しました"
            "（既定 %s より精度が下がります。WHISPER_MODEL で明示指定すれば固定できます）。",
            ram,
            model,
            default,
        )
    else:
        logger.info("Whisper モデル: %s（利用可能 RAM %s）", model,
                    f"{ram:.1f}GB" if ram is not None else "不明")
    return model


def whisper_device() -> str:
    """推論デバイス。auto なら CUDA があれば GPU、なければ CPU。"""
    return os.environ.get("WHISPER_DEVICE", "auto")


def whisper_cpu_threads() -> int:
    """CPU 推論時のスレッド数。既定は論理コア数（最大 8）。

    `WHISPER_CPU_THREADS` の明示指定は常に尊重する。スレッド数は CPU コア数で
    決まる値であり RAM 容量とは連動させない（CTranslate2 の cpu_threads は
    共有 int8 重みへの intra-op 並列でスレッドを増やしても RAM はほぼ増えず、
    RAM ピークは batch_size 側で調整する）。過剰なオーバーサブスクライブは
    上限 8 で抑える。
    """
    env = os.environ.get("WHISPER_CPU_THREADS")
    if env:
        return int(env)
    return min(os.cpu_count() or 4, 8)


def whisper_batch_size() -> int:
    """BatchedInferencePipeline のバッチサイズ。既定 8。

    `WHISPER_BATCH_SIZE` の明示指定は常に尊重する。未設定時は利用可能 RAM で
    決定する（≥16GB→8 / 8〜16GB→4 / <8GB→2）。batch は速度と RAM ピークに
    のみ効き、精度は不変。
    """
    env = os.environ.get("WHISPER_BATCH_SIZE")
    if env:
        return int(env)

    ram = available_ram_gb()
    if ram is None or ram >= 16:
        return 8
    if ram >= 8:
        return 4
    return 2


# ── Claude 設定 ───────────────────────────────────────────────
def claude_model() -> str:
    """使用する Claude モデル。省略時 claude-opus-4-8。"""
    return os.environ.get("CLAUDE_MODEL", "claude-opus-4-8")


def anthropic_api_key() -> str | None:
    return os.environ.get("ANTHROPIC_API_KEY") or None


# ── Ollama 設定 ───────────────────────────────────────────────
def ollama_base_url() -> str:
    return os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")


def ollama_default_model() -> str | None:
    return os.environ.get("OLLAMA_MODEL") or None


# ── 話者分離設定 ──────────────────────────────────────────────
def diarization_enabled() -> bool:
    """タブ音声の話者分離を有効にするか。既定 True。"""
    return os.environ.get("DIARIZATION_ENABLED", "1") != "0"


def diarization_distance_threshold() -> float:
    """AgglomerativeClustering の distance_threshold（cosine距離）。既定 0.15。

    実会議2件（3〜9人相当のパネル/座談会形式）の tab.webm で実測した値。
    0.4 では常に1クラスタに収束し分離されず、0.10〜0.15 の範囲で発話の
    連続ブロック（同一話者が長く話す区間）と整合するクラスタが得られた。
    """
    return float(os.environ.get("DIARIZATION_DISTANCE_THRESHOLD", "0.15"))
