# Monitors

Arm exactly one of each with the Monitor tool (persistent: true). Stop
duplicates with TaskStop. All three end themselves when the unit stops.

Reap orphans before arming (see the last section). Monitors armed by earlier
sessions leave processes behind when the session is killed rather than
stopped.

## Event watcher (instant on decisions, errors, grader proposals)

```bash
cd "$(git rev-parse --show-toplevel)"; n=0; until systemctl --user -q is-active spur-research-loop || [ $n -ge 60 ]; do sleep 5; n=$((n+1)); done; MP=$(systemctl --user show -p MainPID --value spur-research-loop 2>/dev/null); if [ -z "$MP" ] || [ "$MP" = 0 ]; then echo "ALERT: loop not running; watcher not armed"; exit 1; fi; tail -n 0 -F --pid="$MP" research/journal.jsonl 2>/dev/null | grep -E --line-buffered '"event":"(select|seq_chunk|seq_chunk_anomaly|sequential|inconclusive|closed_after_resumes|seq_reset|stale_branch|baseline_sequential|screen|promote|bench|decision|publish|error|blocked|audit|stopped|parked|resumed|park_expired|grader_review|epoch_bump)"' | awk '{print substr($0,1,400); fflush()}'; echo "ALERT: spur-research-loop unit is no longer active: $(journalctl --user -u spur-research-loop --no-pager -n 4 2>/dev/null | grep -oE 'oom-kill|exit-code|Consumed.*' | tail -1)"
```

`parked`/`resumed`/`park_expired` are in the filter because a drained loop is
alive and idle: the unit reads `active`, the heartbeat prints a static
iteration beside `+$0.00`, and without the event that is indistinguishable
from a wedge. `research/PARKED` exists for exactly as long as the hold.

`--pid` is what ends the watcher: when the loop's main process dies, `tail`
exits, `grep` sees EOF, the ALERT prints and the monitor returns. Do not
replace it with a background subshell plus `kill $!`. In that form `$!` is
the subshell, so `kill` never reaches `tail` or `grep` and both survive,
reparented to `systemd --user`. That is the leak path: every watcher that
ended by detecting the unit going inactive left a pair behind, and 82
orphans accumulated over three days before anyone counted them. Stopping a
monitor with TaskStop does clean up its whole pipeline, so the count only
grows across loop restarts, which is exactly when nobody is looking.

The filter is sized correctly and does not need narrowing: across two days of
normal operation it passes 311 events, busiest minute 4. High notification
volume means the loop is spinning, not that the filter is too wide, so fix
the loop rather than the filter.

The `awk` bounds a single event; `seq_chunk` payloads carry full posteriors
and run past a screen otherwise. It must be `awk` with an explicit `fflush()`
and not `cut`: `cut` block-buffers when its output is a pipe, so events sit
unseen until 4KB accumulates or the stream ends. Measured, a `cut` stage
delivered 0 of 3 lines in five seconds while the `awk` stage delivered all
three immediately. Every stage in a monitor pipeline has to flush per line -
`grep` needs `--line-buffered`, `awk` needs `fflush()`, and `head` cannot
flush at all.

## Heartbeat (one line every 10 minutes: iteration, phase, spend)

```bash
cd "$(git rev-parse --show-toplevel)"
idle=0; PC=""
while :; do
  if systemctl --user -q is-active spur-research-loop; then
    idle=0
    L=$(python3 -c "
import json
last=None; cum=0.0
for line in open('research/journal.jsonl'):
    try: e=json.loads(line)
    except: continue
    d=e.get('data') or {}
    c=d.get('cost')
    if isinstance(c,(int,float)): cum+=c
    last=e
if last is None:
    print('journal empty 0'); raise SystemExit
d=last.get('data') or {}
hint=d.get('id') or d.get('why') or (','.join(d.get('reasons',[]))[:50] if isinstance(d.get('reasons'),list) else '') or ''
print(f\"iter={last['iteration']} last={last['event']}({str(hint)[:50]}) {cum:.2f}\")
")
    CUM=${L##* }; LAST=${L% *}
    [ -z "$PC" ] && PC=$CUM
    D=$(ls -dt tmp/loop/eval-* tmp/loop/bench-* tmp/loop/regr-* 2>/dev/null | grep -v config | grep -v '\.log' | head -1)
    SP=$(ps -o pcpu= -C spur 2>/dev/null | head -1 | xargs)
    if [ -n "$D" ] && [ -n "$SP" ]; then PH="explore ${D##*/} cpu=${SP}%"
    elif [ -n "$SP" ]; then PH="explore/regression cpu=${SP}%"
    elif [ -n "$D" ]; then PH="grading ${D##*/}"
    else PH="agent phase (propose/implement/judge/reflect)"; fi
    DELTA=$(awk -v a="$CUM" -v b="$PC" 'BEGIN{d=a-b; if(d<0)d=0; printf "%.2f", d}')
    echo "hb[loop]: $LAST | $PH | +\$$DELTA/10min"
    PC=$CUM
  else
    idle=$((idle+1))
    [ $idle -ge 3 ] && { echo "hb: loop unit inactive for 30 min - heartbeat ends"; exit 0; }
    echo "hb: loop unit not active"
  fi
  sleep 600
done
```

The spend column is what makes this a health check rather than a clock, but
read the iteration number with it. Cost reaches the journal only when a phase
completes, so an implement that runs twelve minutes prints `+$0.00` on every
tick until it finishes and its `implement` event lands. `+$0.00` on its own
means nothing.

The wedge signature is the iteration number *advancing* beside a zero: agent
calls that fail cost nothing, so a loop that is spinning prints a rising
`iter=` with no spend. A static `iter=` beside a zero is an ordinary phase in
progress, and the same is true during a long explore or grade. When it is
genuinely unclear, confirm liveness directly rather than from this line:
`pgrep -f max-turns` finds the implement's agent subprocess, and a live one
shows elapsed time climbing with low CPU, since it is waiting on the network.

`PC` seeds from the first tick, so the opening line always reads `+$0.00`
rather than reporting lifetime spend.

Ten minutes is the operator's chosen cadence: 6 lines an hour, against 24 at
the original 150s. Do not restore the unconditional 150s tick.

## Churn detector (the loop is running and accomplishing nothing)

```bash
cd "$(git rev-parse --show-toplevel)/research"; prev=$(wc -l < journal.jsonl 2>/dev/null || echo 0); while :; do sleep 300; cur=$(wc -l < journal.jsonl 2>/dev/null || echo "$prev"); d=$((cur - prev)); prev=$cur; if [ "$d" -gt 75 ]; then echo "CHURN $(date -u +%H:%M:%SZ): journal.jsonl grew $d lines in 5min (normal peak 25/5min, auth-spin ran 220/5min) - probable runaway iteration loop"; fi; done
```

`systemctl is-active` cannot detect this class of failure. When the SDK
credentials expired the unit read `active` for four hours while the loop
turned 5,178 iterations at 2.8s each, spending nothing and deciding nothing.
Liveness of the unit is not liveness of the research.

Staleness is the wrong detector here and should not be built: legitimate gaps
between journal writes reach 6.9 hours during long sequential evaluations, so
any threshold safe against false alarms is longer than the outage was. The
separation is in the other direction. Measured over 261 active minutes,
normal operation peaks at 5 journal lines per minute; the spin ran 44 to 52.
The threshold above sits at 15/min, three times normal and a third of a spin.

## Reaping orphaned monitor processes

```bash
SD=$(pgrep -u "$USER" -x systemd | head -1); ps -eo pid,ppid,args --no-headers | awk -v sd="$SD" '$2==sd && (/tail .*journal\.jsonl/ || /tail .*research\/logs/ || /ugrep/ || /is-active spur-/) {print $1}'
```

`$SD` is `systemd --user`, so anything listed has lost its controlling
shell and is a leftover. Check the list against the pids of monitors you
armed this session before killing anything.

## Detached long jobs (baseline, regression)

```bash
R="$(git rev-parse --show-toplevel)"; LOG=$R/research/logs/baseline-$(date +%Y%m%d-%H%M%S).log
systemd-run --user --unit=spur-baseline --collect --setenv=PATH="$PATH" --property=MemoryMax=14G --property=WorkingDirectory=$R/research/orchestrator --property=StandardOutput=append:$LOG --property=StandardError=append:$LOG /bin/bash -c "npx tsx src/cli.ts baseline && cp $R/spur/target/release/spur $R/tmp/loop/spur-baseline && echo BASELINE_DONE"
```
Then monitor `$LOG` for `seed N: done`, `recorded`, `Error`, and the unit
becoming inactive. 14G holds: the campaign baseline peaked at 10.5G and the
90 s-chunk baseline at 4.9G, the panel A/A at about 4G. The grader keeps one
500-run chunk resident; a grader change that holds more must re-measure. When the loop runs pinned (`SPUR_LOOP_CPUS` set at start), prefix the command of this and every other detached unit with `taskset -c $SPUR_LOOP_CPUS` (the cpuset controller is not delegated to user units, so `AllowedCPUs` is ignored): the thread count derives from the mask, and a measurement taken under a different mask records under a different baseline key. `--setenv=PATH` is not optional: a user unit starts with
the system PATH, and a system node of another major version loads
better-sqlite3 into the wrong ABI and segfaults before the first line of
output (exit 139, empty log). Do not run the baseline while the loop daemon is active
(both saturate the machine, and the baseline's final step commits the tree).

Starting the loop with `systemd-run` directly sends its stdout to the journal
rather than to `research/logs/loop-*.log`. Use `research/loop-start.sh`,
which sets up the log file; `journalctl --user -u spur-research-loop` is the
fallback when a restart bypassed it.
