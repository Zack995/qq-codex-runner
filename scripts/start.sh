#!/bin/zsh
set -euo pipefail

PROJECT_DIR="/Users/zhangzuocong/Documents/git/qq-codex-runner"
SESSION_NAME="qq-codex-runner"
LOG_DIR="$PROJECT_DIR/logs"
LOG_FILE="$LOG_DIR/runner.log"
PID_FILE="$LOG_DIR/runner.pid"

mkdir -p "$LOG_DIR"

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${PID}" ] && kill -0 "$PID" >/dev/null 2>&1; then
    echo "Already running: $SESSION_NAME (pid $PID)"
    echo "Log: $LOG_FILE"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

screen -S "$SESSION_NAME" -X quit >/dev/null 2>&1 || true

cd "$PROJECT_DIR"
screen -dmS "$SESSION_NAME" zsh -lc "cd '$PROJECT_DIR' && echo \$\$ > '$PID_FILE' && exec node main.js >> '$LOG_FILE' 2>&1"

for _ in 1 2 3 4 5; do
  sleep 1
  if [ -f "$PID_FILE" ]; then
    PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "${PID}" ] && kill -0 "$PID" >/dev/null 2>&1; then
      echo "Started: $SESSION_NAME (pid $PID)"
      echo "Log: $LOG_FILE"
      exit 0
    fi
  fi
done

echo "Failed to start: $SESSION_NAME"
echo "Check log: $LOG_FILE"
rm -f "$PID_FILE"
exit 1
