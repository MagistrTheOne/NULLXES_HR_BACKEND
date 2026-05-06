#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"

cd "$(dirname "$0")"

python -m uvicorn app:app --host "$HOST" --port "$PORT"

