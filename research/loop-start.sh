#!/usr/bin/env bash
# Start the research loop unattended under systemd-run (survives terminal
# close; journal + logs under research/logs/). Stop gracefully with:
#   touch research/STOP
# or hard-stop with: systemctl --user stop spur-research-loop
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/research/logs"
LOG="$ROOT/research/logs/loop-$(date +%Y%m%d-%H%M%S).log"
rm -f "$ROOT/research/STOP"
if command -v systemd-run >/dev/null; then
  systemd-run --user --unit=spur-research-loop --collect \
    --property=MemoryMax=26G \
    --property=Restart=on-failure --property=RestartSec=60 \
    --property=WorkingDirectory="$ROOT/research/orchestrator" \
    --property=StandardOutput=append:"$LOG" \
    --property=StandardError=append:"$LOG" \
    npx tsx src/cli.ts start
  echo "started unit spur-research-loop; log: $LOG"
  echo "status: systemctl --user status spur-research-loop"
else
  cd "$ROOT/research/orchestrator"
  nohup npx tsx src/cli.ts start >>"$LOG" 2>&1 &
  echo "started pid $!; log: $LOG"
fi
