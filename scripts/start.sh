#!/bin/zsh
set -euo pipefail

cd -- "$(dirname -- "$0")/.."

SESSION_NAME="qq-codex-runner"
LOG_DIR="logs"
LOG_FILE="$LOG_DIR/runner.log"
PID_FILE="$LOG_DIR/runner.pid"

NODE_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --full)
      NODE_ARGS+=("--full")
      shift
      ;;
    --force-access)
      if [ $# -lt 2 ]; then
        echo "Error: --force-access requires a value (read|write|safe|full)" >&2
        exit 1
      fi
      NODE_ARGS+=("--force-access" "$2")
      shift 2
      ;;
    -h|--help)
      cat <<EOF
Usage: ./scripts/start.sh [--full | --force-access <mode>]

  --full               Boot with every session forced to access-mode=full
                       (clears any per-scope /access overrides).
  --force-access <m>   Same as --full, with chosen mode (read|write|safe|full).

Without flags, the runner boots with whatever access modes are persisted
in logs/runner-state.json (or CODEX_ACCESS_MODE env for new scopes).
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

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

NODE_CMD="exec node main.js"
for arg in "${NODE_ARGS[@]:-}"; do
  NODE_CMD+=" $(printf '%q' "$arg")"
done

screen -dmS "$SESSION_NAME" zsh -lc "echo \$\$ > '$PID_FILE' && $NODE_CMD >> '$LOG_FILE' 2>&1"

for _ in 1 2 3 4 5; do
  sleep 1
  if [ -f "$PID_FILE" ]; then
    PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "${PID}" ] && kill -0 "$PID" >/dev/null 2>&1; then
      echo "Started: $SESSION_NAME (pid $PID)"
      if [ ${#NODE_ARGS[@]:-0} -gt 0 ]; then
        echo "Args: ${NODE_ARGS[*]}"
      fi
      echo "Log: $LOG_FILE"
      exit 0
    fi
  fi
done

echo "Failed to start: $SESSION_NAME"
echo "Check log: $LOG_FILE"
rm -f "$PID_FILE"
exit 1
