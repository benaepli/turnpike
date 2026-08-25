# Diagnostics playbook

## Reading the journal

```bash
python3 -c "
import json
for line in open('research/journal.jsonl'):
    e = json.loads(line)
    if e['iteration'] == N and e['event'] in ('implement','regression','reflect','audit'):
        print(e['event'], json.dumps(e['data'])[:2000])"
```
`implement.summary` says what the implementer did and what blocked it.
`regression.cases[].detail` names the failing case. `reflect.learned` is the
lab-notebook entry. `audit` carries utilization findings and policy
suggestions (see the auditor misreads listed in SKILL.md).

## Daemon died

`journalctl --user -u spur-research-loop -n 6`: `oom-kill` (unit peak in the
Consumed line) vs `exit-code`. Restart=on-failure brings it back after 60 s;
startup recovery requeues stranded hypotheses and wipes leftover corpora.

## A phase took hours

Check `suspendedMs` on the evaluation (state-edits.md) or
`journalctl -b | grep -i suspend`. Durations are monotonic, so metrics are
unaffected; wall-clock gaps are the machine sleeping.

## Stale `index.lock`

Git commands retry with backoff. If the error persists, another process
(IDE, another session) holds the lock; wait, do not delete the lock while a
git process exists.

## Degenerate evaluation (ok=false, "zero graded runs")

The explorer produced no usable corpus (dead-locking mechanism, or a killed
explore leaving truncated parquet). Look at
`research/logs/eval-<id>-<fidelity>-<seed>.log` (kept on failure).

## Merged pointer references an unpushed spur commit

`git -C spur log origin/research/vr-loop -1` vs the superproject's recorded
pointer (`git ls-tree HEAD spur`). Push the spur branch and fast-forward
spur's `research/vr-loop` to the referenced commit.

## Grader sanity (after any traceanalyzer change)

```bash
./traceanalyzer/main -input research/corpus/findbug_archive -grade -dag-config research/oracle/relax_minimal.json -grade-max-runs 0 -grade-budget-ms 0 -grade-per-run -format json > /tmp/fb.json
```
Invariants from `research/corpus/manifest.json`: all 266 violating runs at
max prefix depth (8); mean prefix depth ~3.88; hazard rates h1/h2/h2b/h3 =
0.2628/0.2596/0.1542/0.2436. `./porcupine/batch -input research/corpus/findbug_archive -model kv`
must report 266 violations.

## Resource reference (measured)

Explorer peak RSS ~2.4 GB on a 13.5k-run session; grader ~80 MB on 5000
runs; explore ~140-290 runs/s depending on the merged binary. One sequential
chunk (5.4k runs) ~1 min; a typical verdict takes 2-4 chunks, the cap is 18;
confirm ~3 min per seed, regression ~2 min. Perf lane: screen ~40 s, promote
~2 min.
