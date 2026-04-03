#!/bin/zsh
set -euo pipefail

cd -- "$(dirname -- "$0")/.."

SESSION_NAME="qq-codex-runner"
PID_FILE="logs/runner.pid"

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${PID}" ]; then
    kill "$PID" >/dev/null 2>&1 || true
  fi
fi

screen -S "$SESSION_NAME" -X quit >/dev/null 2>&1 || true
pkill -f "qq-codex-runner/main.js" >/dev/null 2>&1 || true
pkill -f "node main.js" >/dev/null 2>&1 || true

sleep 1

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${PID}" ] && kill -0 "$PID" >/dev/null 2>&1; then
    echo "Stop failed: $SESSION_NAME"
    exit 1
  fi
fi

if (screen -ls 2>/dev/null || true) | grep -Fq ".${SESSION_NAME}"; then
  echo "Stop failed: $SESSION_NAME"
  exit 1
fi

rm -f "$PID_FILE"
echo "Stopped: $SESSION_NAME"
