# Monitors

Arm exactly one of each with the Monitor tool (persistent: true). Stop
duplicates with TaskStop. Both end themselves when the unit stops.

## Event watcher (instant on decisions, errors, grader proposals)

```bash
cd /home/benaepli/Research/alt/jennLang; n=0; until systemctl --user -q is-active spur-research-loop || [ $n -ge 60 ]; do sleep 5; n=$((n+1)); done; ( tail -n 0 -F research/journal.jsonl 2>/dev/null | grep -E --line-buffered '"event":"(select|screen|promote|bench|decision|publish|error|blocked|audit|stopped|grader_review)"' ) & TP=$!; while systemctl --user -q is-active spur-research-loop; do sleep 30; done; kill $TP 2>/dev/null; echo "ALERT: spur-research-loop unit is no longer active: $(journalctl --user -u spur-research-loop --no-pager -n 4 2>/dev/null | grep -oE 'oom-kill|exit-code|Consumed.*' | tail -1)"
```

## Heartbeat (one line every 2.5 minutes: iteration, last event, phase)

```bash
cd /home/benaepli/Research/alt/jennLang; idle=0; while :; do if systemctl --user -q is-active spur-research-loop; then idle=0; LAST=$(tail -1 research/journal.jsonl 2>/dev/null | python3 -c "import json,sys
try:
    e=json.load(sys.stdin); d=e.get('data') or {}
    hint=d.get('id') or d.get('why') or (','.join(d.get('reasons',[]))[:60] if isinstance(d.get('reasons'),list) else '') or ''
    print(f\"iter={e['iteration']} last={e['event']}({str(hint)[:60]})\")
except Exception: print('journal empty')"); D=$(ls -dt tmp/loop/eval-* tmp/loop/bench-* tmp/loop/regr-* 2>/dev/null | grep -v config | grep -v '\.log' | head -1); SP=$(ps -o pcpu= -C spur 2>/dev/null | head -1 | xargs); if [ -n "$D" ] && [ -n "$SP" ]; then PH="explore ${D##*/} $(du -sh "$D" 2>/dev/null | cut -f1) cpu=${SP}%"; elif [ -n "$SP" ]; then PH="explore/regression cpu=${SP}%"; elif [ -n "$D" ]; then PH="grading ${D##*/}"; else PH="agent phase (propose/implement/judge/reflect)"; fi; echo "hb[loop]: $LAST | $PH"; else idle=$((idle+1)); [ $idle -ge 8 ] && { echo "hb: loop unit inactive for 20 min - heartbeat ends"; exit 0; }; echo "hb: loop unit not active"; fi; sleep 150; done
```

## Detached long jobs (baseline, regression)

```bash
R=/home/benaepli/Research/alt/jennLang; LOG=$R/research/logs/baseline-$(date +%Y%m%d-%H%M%S).log
systemd-run --user --unit=spur-baseline --collect --property=MemoryMax=14G --property=WorkingDirectory=$R/research/orchestrator --property=StandardOutput=append:$LOG --property=StandardError=append:$LOG /bin/bash -c "npx tsx src/cli.ts baseline && cp $R/spur/target/release/spur $R/tmp/loop/spur-baseline && echo BASELINE_DONE"
```
Then monitor `$LOG` for `seed N: done`, `recorded`, `Error`, and the unit
becoming inactive. Do not run the baseline while the loop daemon is active
(both saturate the machine, and the baseline's final step commits the tree).
