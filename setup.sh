#!/bin/bash
# meeting_recorder セットアップスクリプト
# Usage: cd meeting_recorder && bash setup.sh

set -e

echo "=== Creating Python venv ==="
python3 -m venv .venv

echo "=== Installing dependencies ==="
.venv/bin/pip install -r requirements.txt

echo "=== Verifying ==="
.venv/bin/python3 -c "
import faster_whisper, fastapi, anthropic
print(f'faster-whisper {faster_whisper.__version__}')
print(f'fastapi {fastapi.__version__}')
print(f'anthropic {anthropic.__version__}')
"

echo ""
echo "✅ Setup complete."
echo "  1) cp .env.local.example .env.local  # ANTHROPIC_API_KEY を設定（または Ollama を起動）"
echo "  2) .venv/bin/uvicorn app:app --port 8000"
echo "  3) Chrome/Edge で http://localhost:8000 を開く"
echo ""
echo "※ 初回は faster-whisper の large-v3 モデル（約1.5GB）を models/ にダウンロードします。"
