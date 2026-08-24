#!/usr/bin/env bash
# Run a command under a hard memory cap, so a runaway is killed on its own
# instead of triggering a global OOM.
#
#   ./scripts/capped.sh ./traceanalyzer/main -input output
#   SPUR_MEM_CAP=8G ./scripts/capped.sh ./porcupine/main -input output -model kv
set -euo pipefail

CAP="${SPUR_MEM_CAP:-12G}"

if [ $# -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 64
fi

if ! command -v systemd-run >/dev/null; then
  echo "warning: systemd-run unavailable, running uncapped" >&2
  exec "$@"
fi

exec systemd-run --user --scope --quiet \
  -p MemoryMax="$CAP" \
  -p MemorySwapMax=0 \
  -- "$@"
