#!/bin/zsh
set -euo pipefail

SESSION_NAME="qq-codex-runner"
PROJECT_DIR="/Users/zhangzuocong/Documents/git/qq-codex-runner"
LOG_FILE="$PROJECT_DIR/logs/runner.log"
PID_FILE="$PROJECT_DIR/logs/runner.pid"

PID=""
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
fi

if [ -n "${PID}" ] && kill -0 "$PID" >/dev/null 2>&1; then
  echo "Status: running"
else
  echo "Status: stopped"
fi

echo "Session: $SESSION_NAME"
echo "Log: $LOG_FILE"
if [ -n "${PID}" ]; then
  echo "PID: $PID"
fi
echo

(screen -ls 2>/dev/null || true) | grep -F ".${SESSION_NAME}" || true
if [ -n "${PID}" ]; then
  ps -p "$PID" -o pid=,ppid=,stat=,command= || true
fi
