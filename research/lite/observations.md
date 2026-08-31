# Lite Loop Observations

One entry per iteration, newest last: date, hypothesis id, verdict, the key
figures the decision was made on, and what was learned.

## 2026-08-30 - aa-check (A/A validation of the lite grader)

Base binary and template on both sides (spur tree d22321ae, template 1497728c),
seeds 1000-1001, 690,360 candidate runs against 692,520 baseline runs. Every
depth rung's per-second ratio sat within noise of 1 (depth>=6: 0.994 against a
0.009 null band); throughput ratio 0.997; nothing separated at z 2.7 and
canStillAdvance correctly answered false for a true null. vr-nofault regression
passed. Verdict: close (validation run, figures as expected for A/A).

Finding worth keeping: the candidate side produced ONE linearizability
violation (run 248681, arm grid-short, config_index 17, seed 1000) in an A/A
run of the unchanged merged tree - a background-rate violation of the general
corpus, not an effect of any candidate. Evidence preserved under
research/logs/violations/lite-aa-check-sequential-1000-1788133207904/.
With lite's null violation prior this stopped the sample at chunk 1, which is
the designed behavior; the skill's calibration note covers how to read it.
The big loop's 000-baseline-30 record no longer pairs with auto-vr HEAD
(record spur tree 1f08a31e vs head d22321ae; template moved too), so lite
measured its own cache: research/lite/baselines/d22321ae599f-30-1497728c-300.json
now holds seeds 1000-1001.

## 2026-08-30 - dry-fanout-bias (dry-run of the full iteration plumbing)

Config-only candidate (partial_fanout_crash_bias 0.5 -> 0.6) implemented by a
worktree-isolated agent, exported to tmp/loop/lite/, and graded for one chunk
against the cached baseline (seed 1000 reused: 415 s per chunk against 830 s
when the baseline must be measured). depth>=6 ratio 1.024 against a 0.013
band, no violations, throughput 0.988, verdict continue at chunk 1. Closed as
a validation run: one chunk is below minChunks and is not evidence about the
dose. Flow finding: agent worktrees are cut from main, which lacks
scheduler_configs/loop/ - the skill now seeds the subject from research/lite
before editing.

## 2026-08-30 - panel anchor (first panel check of the merged lite tree)

`grader.ts panel` at scale 3, seed 1000, manifest.30 calibration in parens:
paxos-accept-stale-ballot 1561 violations over 96.0k runs in 31.4 s, 49.77
events/s (33.78), 3061 runs/s (1959); mencius-opt1-2 261 violations over
32.2k runs in 45.5 s, 5.73 events/s (4.57), 708 runs/s (544). Both members
above calibration, consistent with a faster host state rather than a
scheduler change; these figures are the anchor later panel entries compare
against. Mechanics finding: without wall_budget_sec in the materialized
config a member whose grid outlasts the wall is SIGKILLed and porcupine
cannot read the unflushed DB - the subcommand now sets it.
