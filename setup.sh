#!/bin/bash
# meeting_recorder セットアップスクリプト（uv 管理）
# Usage: cd meeting_recorder && bash setup.sh

set -e

if ! command -v uv >/dev/null 2>&1; then
  echo "エラー: uv が見つかりません。https://docs.astral.sh/uv/ を参照してインストールしてください。"
  echo "  macOS/Linux: curl -LsSf https://astral.sh/uv/install.sh | sh"
  exit 1
fi

echo "=== Syncing dependencies (uv) ==="
uv sync

echo "=== Verifying ==="
uv run python -c "
import faster_whisper, fastapi, anthropic
print(f'faster-whisper {faster_whisper.__version__}')
print(f'fastapi {fastapi.__version__}')
print(f'anthropic {anthropic.__version__}')
"

echo ""
echo "✅ Setup complete."
echo "  1) cp .env.local.example .env.local  # ANTHROPIC_API_KEY を設定（または Ollama を起動）"
echo "  2) uv run uvicorn app:app --port 8000"
echo "  3) Chrome/Edge で http://localhost:8000 を開く"
echo ""
echo "※ 初回は faster-whisper の large-v3 モデル（約1.5GB）を models/ にダウンロードします。"
