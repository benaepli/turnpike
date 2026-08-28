# Grader reviews

Operator decisions on `grader`-kind hypotheses. The loop parks these instead
of implementing them; each entry records the verdict and the evidence.

## 2026-08-28, epoch 6: the timer vertex becomes observable

Operator change, not a queued hypothesis. The explorer now records every
timer firing as an execution row (`kind = TimerFired`, payload node and
label), the grader matches `allow_timer` labels against those rows, and a
generic hazard `h4` counts runs in which a timer fired on a node while a
message to that node was in flight. The runs table (`runs/*.parquet`) and
`runs_meta` ride along; they attribute runs to strategies and do not touch
the ladder.

**Ground truth is unchanged.** The plan corpus `find_bug_plan` regenerated
with the new binary violates on exactly the archived run ids
(`[572, 594, 791, 828, 1024, 1447, 1646, 1802, 1824, 2345, 2721]`, 11 of
3,000); porcupine skips the new rows as unknown actions (`skipped_ops`
grows, verdicts and exit codes do not). The archived parquet corpora are not
on this host (`research/corpus/*/` is gitignored working data), so the
manifest invariants were re-verified by construction rather than by
re-grading: those corpora carry no `TimerFired` rows, `allow_t1` therefore
has zero candidates in them, and it contracts out of the chain exactly as
before. The traceanalyzer unit suite, which pins the contraction contract,
passes.

**What the vertex measures.** On the regenerated plan corpus the chain now
reaches 9 and all 11 violating runs sit at 9; `depth_at_least` is
3000/3000/3000/3000/751/751/751/145/103. On a 1,080-run general session the
deepest chains include `allow_t1` (`w1 -> allow_t1 -> crash_nl -> ...`) and
the maximum was 8 with the two-crash labels unmatched, so in general mode
the vertex is close to free: timers fire constantly and one of them lands
between `w1` and `crash_nl` in nearly every run. The rung semantics shift by
about one vertex where `w1` matched, which is why this is an epoch bump.

**h4 is saturated in general mode**: 0.938 of runs in that session, against
0.035 on the plan corpus where timers are admitted only where the plan
allows. The hazard is therefore a measurement of how much freer the general
grid is with timers than the plans are, not a discriminating proxy for the
violation, and it must not enter the objective. The discriminating
information is still the absence of firings around the chain, which no
metric observes yet; `h4` is the first counter that can see the difference
between the two regimes at all.

Landed with the boundary procedure: grader and harness committed together,
`research/PARAMETERS.md` noted, epoch bumped to 6, baseline re-measured.

## 2026-08-26, epoch 3

Both queued items were rejected, and the review turned up the reason the
depth ladder had never moved above 5.

### The finding that decided both

`research/oracle/relax_minimal.json` names the client key `x`. The general
grid pins `num_keys` to 1 and `spur-core/src/simulator/path/generator.rs`
names keys `key1..keyN`, so no write or read event could ever match a
client-op label. Measured over a 32,400-run general corpus, the labels `w1`,
`w2`, `r1`, `r2`, `r3` had zero candidates in **100.00%** of runs, and
`allow_t1` is unmatchable outside plan mode by construction
(`buildCandidates` returns nil for allow_timer). Seven of thirteen labels
could match; the longest chain through those seven is five vertices.
`max_prefix_depth` was therefore pinned at exactly 5 by arithmetic.

Re-grading that same corpus against a copy of the DAG with the key retargeted
to `key1`, changing nothing else:

| | key `x` | key `key1` |
|---|---|---|
| max_prefix_depth | 5 | 8 |
| mean_prefix_depth | 2.323 | 3.027 |
| depth_at_least | 32400/28586/12536/1613/139 | 32400/29682/21330/11486/2662/457/43/2 |

Evaluation now grades against `research/oracle/relax_minimal_general.json`.
The frozen oracle and `research/corpus/` are untouched, so the calibration
invariants in `manifest.json` still hold against the original DAG.

Depth is not the bug. All 32,400 runs were linearizable, both depth-8 runs
included. Plan corpora violate on 71% of their depth-8 runs, so general-config
precision at full depth is far lower and depth stays a proxy.

### novelty-credit-instrumentation (queued iteration 53) - rejected

Proposed three explorer fields.

- `decision_divergence_frac` already exists. `util_stats.rs` defines
  `SteerStats { evaluations, divergent_picks }` fed by
  `record_steer_evaluation`; this is the counter the iteration-51 audit read
  when it reported 0.139% divergence over 2.2M evaluations.
- `novelty_depth_corr` cannot be built where it was proposed. It correlates
  per-decision novelty against the realized prefix depth of the containing
  run, but prefix depth is produced afterwards by traceanalyzer matching
  against the oracle DAG. Computing it inside the explorer puts the oracle in
  front of the scheduler, which breaks ruler/subject separation; the DAG names
  `Node.StartViewChange`, so the VR-name lint rejects the diff on contact.
- `tied_candidate_frac` is new, cheap and feasible, and it belongs beside the
  existing steer counters as an ordinary counter rather than a grader change.

### guard-absorption-counter (queued iteration 72) - rejected, remedy replaced

Proposed classifying every delivered message at the receive point as ACTED
(mutated node state or enqueued sends) against ABSORBED (dropped by a guard or
a no-op branch), emitting `acted_fraction` behind a new config bool, so a
mechanism that never fires can be rejected in one chunk instead of three.

The premise is right. Iteration 71 spent 162,000 runs to reach a futility
reject, and its own utilization counters - 62 lines of them, added by that
same hypothesis - never surfaced. The reason is that `collectUtilization`
materializes a separate 20-runs/config session (1,080 runs, seed 4242) with
`stats: true`, and it runs only after a merge or at an audit. Evaluation
explores never set `stats`, so a candidate's own sample produces no
utilization data at all.

The remedy is wrong, on three counts. Classifying ACTED against ABSORBED needs
per-delivery state diffing and is semantically fuzzy, since a handler that
touches a timestamp has mutated state without doing anything. Deciding that a
no-op was a *guard* rejection rather than an ordinary one needs protocol
knowledge, which is how a generic classifier drifts into recognizing VR guard
patterns and trips rule 1. And it adds a config parameter, which is a cost.

What landed instead: capture the utilization session with the candidate's own
binary during its evaluation, store it as `util:<id>` and journal it. That
covers every mechanism, including counters a hypothesis writes for itself,
adds no classifier and no parameter, and costs about 1,080 runs against a
54,000-run chunk.

Deliberately not adopted: the auto-reject. Closing a hypothesis on a
utilization criterion is a gate change; the counters are recorded as evidence
for the judge, reflect and audit to weigh, and they close nothing on their own.

Also not done: setting `stats: true` on the evaluation explores themselves.
Counter atomics sit in hot paths, `runsPerSec` is a perf-lane gate objective,
and the baseline is measured without them, so enabling it would make every
candidate read slower and force a baseline re-run.

### depth-tail-power-analysis (queued iteration 56) - rejected, premise superseded

The proposal argued that rungs >= 6 read 0.0 for want of statistical
resolution and should replace the binary rungs with mean, percentile and
attrition statistics.

The rungs read 0.0 because they were unreachable, not underpowered. With the
key-matched DAG they carry roughly 762, 72 and 3.3 runs per 54k chunk at
depth >= 6, 7 and 8 - resolvable, and now the only live frontier above the
saturated lower rungs. Replacing them would also delete `depth6plus`, which
the escalate path and the merge gate's jackpot handling key on, so the binary
rungs stay. `meanPrefixDepth` is already emitted; per-rung attrition is a pure
function of `depthAtLeast` and belongs in orchestrator reporting, not in
traceanalyzer.

## 2026-08-26 (second batch), epoch 3

Three queued items, all rejected. Two of them asked for instrumentation that
would answer a question `research/corpus/manifest.json` already answers.

### h2b-invariance-audit (queued iteration 5262) - rejected, question already answered

Proposed per-run telemetry for the h2b predicate (which conjuncts hold, first
step index each becomes true, near-miss counts) behind a new
`stats.hazard_conjunct_breakdown` flag, to decide whether h2bRate's constant
0.417 means (a) structurally unreachable, (b) a predicate firing on a
coincidence the scheduler cannot construct, or (c) controllable but never hit.

The premise is that h2bRate is invariant. It is not. Measured h2b_rate across
the corpora already on disk:

| corpus | h2b_rate |
|---|---|
| find_bug_plan | 0.1387 |
| relax_minimal | 0.1472 |
| findbug_archive | 0.1542 |
| relax_5 | 0.1603 |
| unconstrained_c0 | 0.2204 |
| relax_3 | **0.5840** |
| general-config evaluations (n=131) | 0.3789 - 0.4372 |

A metric that ranges over 4.2x across configurations is not invariant and not
saturated. The answer is (a) in a specific sense: h2b is fixed by the
*configuration's* crash and recovery structure, not by scheduler policy. That
is why it sits near 0.417 for everything graded against the general grid and
why no delivery-order or purgatory mechanism has moved it - those mechanisms
change which schedules are explored, not how often the config puts a node
through the crash-recover shape h2b tests.

No instrumentation is needed to reach that conclusion, so the flag, the
spur-core changes and the grader changes all come off the table. The proposal
also touches `spur-core/src/simulator/util_stats.rs`, which a grader-kind
hypothesis may not do: `lintRulerSubject` restricts grader diffs to
`traceanalyzer/`, `research/observations/` and `research/evaluations/`, so it
would fail the lint on contact.

Two consequences worth acting on, neither of which is a grader change:

- h2b should not carry a pre-registered movement threshold in scheduler-policy
  hypotheses. `receiver-side-orphan-hold` pre-registered ">= 0.05 movement in
  h2bRate" as its falsifier; the observed range across 131 general-config
  evaluations is 0.0583, so that threshold sits inside the spread and the
  falsifier could fire on noise in either direction. It happened to reject
  correctly, on a delta of ~0.000.
- The live frontier stays depth >= 6/7/8 and violations. h2b is a description
  of the config, so it belongs in reporting, not in a hypothesis's objective.

### timer-vs-delivery-order-proxy (queued iteration 5259) - rejected, wrong side of the ruler

Proposed two reporting-only per-run statistics in `traceanalyzer/`:
`timerDeliveryInversionRate` (timer fires while a message addressed to that
node is undelivered) and `timerBurstConcentration` (max share of timer fires
landing on one node).

The motivating observation is sound. `ablate-timer-queue-entirely` is the
largest delta on the board and every other timer hypothesis closed at 0.0000,
so the timer-admission axis genuinely has no feature that can see it.

The remedy is on the wrong side of the ruler/subject line, in the same way
`tied_candidate_frac` was. Both quantities are properties of the scheduler's
own decision, not of the trace: when the explorer picks the timer queue it is
holding the queues, so it already knows whether messages addressed to that
node are pending and which node it just fired. Computing this in the grader
means reconstructing queue occupancy from the event log, which is strictly
more work for a strictly less reliable answer.

Cost matters here too. Grading is already 189s against 218s of explore per
54k-run chunk, about 46% of chunk wall time, and per-run queue reconstruction
lands directly on that path. The explorer-side counters are increments in a
branch the scheduler already takes.

What to do instead: add both counters to `spur-core/src/simulator/util_stats.rs`
beside the existing steer and purgatory counters, as an ordinary `add`-kind
hypothesis. Per-candidate utilization capture already stores and journals
those counters for every evaluated hypothesis, so the timer family gets its
observability with no grader change, no new config parameter, and no cost on
the grading path.

### joint-hazard-objective (parked, grader-kind) - rejected

Proposed per-run hazard co-occurrence (`h1&h2`, `h1&h2&h3`) and mean prefix
depth conditioned on h1, exposed as `jointHazardRate` and `depthGivenH1`, and
"optionally" feeding `jointHazardRate` into the curriculum reward in
`spur-core/src/simulator/curriculum.rs` behind `reward_joint_hazards`.

Rejected on the same separation grounds, more directly than the others. It
edits `spur-core`, which grader-kind diffs may not touch, and the optional
half wires a grader-side statistic into the scheduler's reward. That puts the
ruler in front of the subject: the explorer would be steered by the quantity
it is being measured on, and any subsequent movement in that quantity would
be uninterpretable. `novelty_depth_corr` was rejected for the same structure.

The marginal statistics half is cheap and harmless, but it is also not
obviously useful yet: no hypothesis has been blocked for want of a joint
hazard rate, whereas six were blocked for want of "did my mechanism act",
which per-candidate utilization capture now answers. Reconsider if a concrete
hypothesis declares it as a dependency.

## Addendum, 2026-08-26 (later): stats is on for evaluation runs

The guard-absorption-counter entry above states that evaluation explores never
set `stats`, and reasons from that: counter atomics sit in hot paths,
`runsPerSec` is a perf-lane objective, and enabling them would slow every
candidate and force a baseline re-run. That was true when written and is not
true now. `scheduler_configs/loop/general_vr.json` carries `stats: true` from
#18 (crash-recover-density-telemetry) and `emit_acted_fraction: true` from
#19, and `materializeConfig` copies the template through untouched, so every
evaluation explore runs with the counters live.

The concern that justified the original position does not survive
measurement. Paired 54,000-run sequential chunks, same seeds, before and
after the two merges that added the delivery probe:

| seed | before | after | delta |
|---|---|---|---|
| 1000 | 220.3s | 236.0s | +7.1% |
| 1001 | 219.8s | 207.0s | -5.8% |
| 1002 | 217.5s | 203.0s | -6.7% |
| 1003 | 217.1s | 205.0s | -5.6% |

Mean 218.7s -> 212.8s, three of four chunks faster. There is no measurable
throughput cost to carrying the counters, so "counters are too expensive for
evaluation runs" should not be cited again without new measurement.

Two consequences. The per-candidate utilization capture added after that
review is still worth having, because it stores and journals the counters
under a fixed seed and session size so numbers are comparable across
candidates, which a candidate's own evaluation config does not guarantee. And
a hypothesis proposing to enable a counter on evaluation runs can no longer
be rejected on cost alone.

## The checker's two edits, kept as a documented exception (2026-08-28)

Rule 4 puts `porcupine/` beyond edit. Two commits on its `main` touched it
on 2026-08-28 and are kept:

- `ebf06c5` `checker/duckdb_reader.go`: the executions read excludes rows of
  kind `TimerFired`. The checker never consumed them (an unknown action is
  dropped before the operations are built, so only `skipped_ops` changed),
  but reading a thousand such rows per run took the checker from 3 s to
  47 s per chunk. The harness could not have done this: the read is inside
  the checker.
- `23b288c` `cmd/porcupine_batch/main.go`: JSON gains
  `first_violation_ordinal`, `first_violation_run_id` and
  `violation_signatures`. Verdicts, exit codes and `violating_run_ids` are
  unchanged. The harness derives the first violation's ordinal and time from
  `violating_run_ids` and the runs table and does not read the two ordinal
  fields; `PorcupineJson` no longer declares them. The signature needs the
  checker's partial linearizations and stays.

Neither change alters a verdict, which is the property rule 4 protects, and
reverting the second would be a third edit for no verdict change. The
archived-corpus check that would show the verdicts byte-identical is still
owed: `research/corpus/*/` is gitignored and was not carried to this host.

**To run once the corpora arrive** (rsync the six directories from the old
host, then `sha256sum` against `research/corpus/manifest.json`):

```
./porcupine/batch -input research/corpus/findbug_archive -model kv
```

expected: exit 2, 266 violations, `violating_run_ids` identical to
`research/corpus/findbug_archive.porcupine.json`. Those corpora carry no
timer rows, so the reader filter is a no-op on them; the epoch-6 check
(the regenerated `find_bug_plan` reproducing the 11 archived violating ids)
is the one that exercises it, and it was run at `ebf06c5`.

## Grader: the runs of a chunk are matched concurrently (2026-08-28)

`traceanalyzer -grade` matched one run at a time. The matching of a run is
seeded by its own id, so the runs of a chunk are now matched by a worker
pool (`-grade-workers`, default the process's CPU count) and consumed in
chunk order, with every aggregate, every per-run record and every warning
landing as it did one run at a time; one chunk stays resident.

Acceptance, same corpora graded before and after with `-grade-budget-ms 0
-grade-max-runs 0 -grade-per-run -grade-run-depths`:

| corpus | runs | before | after | output |
|---|---|---|---|---|
| regenerated `find_bug_plan` (`relax_minimal.json`) | 3,000 | 0.55 s | 0.38 s | byte-identical, 2,360,387 bytes |
| VR campaign chunk (`relax_minimal_general.json`) | 229,980 | 819 s | 371 s | identical except `wall_ms`, the grade's own elapsed time; 170,698,108 bytes |

`go test ./...` passes. The grade JSON now prints per-chunk read and match
times on stderr, and on the VR chunk they answer where the cost is: over
460 chunks the DuckDB reads took 322 s and the matching 7 s. The parallel
matching is not what shortened the VR grade (the earlier figure was taken
beside another grade); the reads are, and they are the timer rows: the
executions read filters them with `json_extract` on every row, and the
plan corpus, which has no timer rows, reads a 500-run chunk in 39 ms
against about 700 ms here. The recovery is on the writer's side, timer
node and label as their own columns so the filter is a column predicate,
and it is the next grader item.

