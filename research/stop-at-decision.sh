#!/usr/bin/env bash
# Place research/STOP at the next decision event, the boundary that loses
# nothing: publish and reflect still finish and the loop exits before the
# next selection.
set -uo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"
J=$R/research/journal.jsonl
N=$(wc -l < "$J")
echo "watching from line $N at $(date -u +%H:%M:%SZ)"
while systemctl --user -q is-active spur-research-loop; do
  if tail -n +$((N+1)) "$J" 2>/dev/null | grep -q '"event":"decision"'; then
    touch "$R/research/STOP"
    echo "STOP placed at $(date -u +%H:%M:%SZ)"
    tail -n +$((N+1)) "$J" | grep '"event":"decision"' | cut -c1-200
    exit 0
  fi
  sleep 20
done
echo "loop went inactive before a decision; STOP not needed"
