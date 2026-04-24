#!/bin/zsh
set -euo pipefail

cd -- "$(dirname -- "$0")/.."

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  cat <<EOF
Usage: ./scripts/restart.sh [--full | --force-access <mode>]

Stops the running runner (if any) and starts it again. Extra arguments
are forwarded to ./scripts/start.sh verbatim, so:

  ./scripts/restart.sh                    Normal restart (keeps per-scope
                                          access modes from runner-state.json)
  ./scripts/restart.sh --full             Restart and force every session
                                          to access-mode=full on boot
  ./scripts/restart.sh --force-access safe
                                          Restart and force every session
                                          to access-mode=safe on boot
EOF
  exit 0
fi

./scripts/stop.sh || true
exec ./scripts/start.sh "$@"
