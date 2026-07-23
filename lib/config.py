"""環境設定の読込とパス解決。

`.env.local` を読み込み、Whisper モデルのキャッシュ先や
プロバイダ選択に必要な値を提供する。work_dashboard の設定思想に倣う。
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

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


# ── Whisper 設定 ──────────────────────────────────────────────
def whisper_model_name() -> str:
    """使用する faster-whisper モデルサイズ。既定 large-v3-turbo。"""
    return os.environ.get("WHISPER_MODEL", "large-v3-turbo")


def whisper_device() -> str:
    """推論デバイス。auto なら CUDA があれば GPU、なければ CPU。"""
    return os.environ.get("WHISPER_DEVICE", "auto")


def whisper_cpu_threads() -> int:
    """CPU 推論時のスレッド数。既定は論理コア数（最大 8）。"""
    env = os.environ.get("WHISPER_CPU_THREADS")
    if env:
        return int(env)
    return min(os.cpu_count() or 4, 8)


def whisper_batch_size() -> int:
    """BatchedInferencePipeline のバッチサイズ。既定 8。"""
    return int(os.environ.get("WHISPER_BATCH_SIZE", "8"))


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
