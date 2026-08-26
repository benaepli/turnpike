#!/usr/bin/env bash
# Start the loop once the post-merge baseline finishes, and only if it did.
# Survives the operator session exiting.
set -uo pipefail
LOG="$1"
while systemctl --user -q is-active spur-baseline; do sleep 30; done
RESULT=$(systemctl --user show -p Result --value spur-baseline 2>/dev/null)
if ! grep -q "BASELINE_DONE" "$LOG" 2>/dev/null; then
  echo "chain: baseline did not complete (result=$RESULT); loop NOT started"
  exit 1
fi
if systemctl --user -q is-active spur-research-loop; then
  echo "chain: loop already active; nothing to do"
  exit 0
fi
echo "chain: baseline ok (result=$RESULT); starting loop"
exec /home/benaepli/Research/alt/jennLang/research/loop-start.sh
