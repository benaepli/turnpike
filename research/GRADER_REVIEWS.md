# Grader reviews

Operator decisions on `grader`-kind hypotheses. The loop parks these instead
of implementing them; each entry records the verdict and the evidence.

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
