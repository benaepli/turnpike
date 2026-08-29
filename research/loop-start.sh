#!/usr/bin/env bash
# Start the research loop unattended under systemd-run (survives terminal
# close; journal + logs under research/logs/). Stop gracefully with:
#   touch research/DRAIN     (finish the iteration, then hold at the boundary)
#   touch research/STOP      (abort the running phase now)
# or hard-stop with: systemctl --user stop spur-research-loop
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/research/logs"
LOG="$ROOT/research/logs/loop-$(date +%Y%m%d-%H%M%S).log"
rm -f "$ROOT/research/STOP" "$ROOT/research/DRAIN" "$ROOT/research/PARKED"
if command -v systemd-run >/dev/null; then
  # Capped below total RAM so a runaway kills only the loop, not the desktop.
  # The unit does not inherit the shell's PATH, and a system node of another
  # major version segfaults in better-sqlite3 built against the nvm one.
  # SPUR_LOOP_CPUS pins the loop and everything it spawns to a CPU set
  # through the affinity mask, which children inherit; the cpuset controller
  # is not delegated to user units, so AllowedCPUs would be ignored. The
  # thread count the loop measures at derives from the mask, and each mask
  # needs its own baseline and panel calibration once.
  PIN=()
  [ -n "${SPUR_LOOP_CPUS:-}" ] && PIN=(taskset -c "$SPUR_LOOP_CPUS")
  systemd-run --user --unit=spur-research-loop --collect \
    --setenv=PATH="$PATH" \
    --setenv=SPUR_DUCKDB_THREADS=8 \
    --property=MemoryHigh="${SPUR_LOOP_MEM_HIGH:-10G}" \
    --property=MemoryMax="${SPUR_LOOP_MEM_MAX:-14G}" \
    --property=MemorySwapMax=0 \
    --property=Restart=on-failure --property=RestartSec=60 \
    --property=WorkingDirectory="$ROOT/research/orchestrator" \
    --property=StandardOutput=append:"$LOG" \
    --property=StandardError=append:"$LOG" \
    "${PIN[@]}" npx tsx src/cli.ts start
  echo "started unit spur-research-loop; log: $LOG"
  echo "status: systemctl --user status spur-research-loop"
else
  cd "$ROOT/research/orchestrator"
  nohup npx tsx src/cli.ts start >>"$LOG" 2>&1 &
  echo "started pid $!; log: $LOG"
fi
