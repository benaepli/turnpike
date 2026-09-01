# Implementation Plan: run-cap-trajectory-variance-fix (amended)

Status: awaiting-approval (moderated round per user request; origin:
operator-agent). Prediction freezes at approval. Judge scores at planning
time: expectedGain 7, expectedCost 0. Runner-up this round:
crash-placement-completion-span-draw (gain 6, held next-up in the pool).

Amendment (2026-08-31, user direction): the original freeze-at-floor shape
was rejected at the hold - a session-permanent freeze assumes a stationary
completed-length distribution, and the project's horizon includes very
long sessions with dramatically varying node and crash counts, where a cap
frozen from the first 200 completions would silently misgovern everything
after a composition shift. The amended shape recomputes at deterministic
doubling checkpoints: stable between updates, adaptive forever.

## 1. Hypothesis JSON

```json
{
  "id": "run-cap-trajectory-variance-fix",
  "parent": "learned-run-cap-probe-p99",
  "kind": "change",
  "category": "scheduler",
  "origin": "operator-agent",
  "title": "Recompute the learned run cap only at doubling completed-count checkpoints, constant in between",
  "mechanism": "run_cap.rs only: ScopeAccum gains current: Option<i32> and next_checkpoint: u64 (initialized to MIN_COMPLETED_SAMPLES). When merge_probe folds a completed probe that lifts a scope's completed count to next_checkpoint, it recomputes the quantile cap from the full histogram at that moment, stores it in current, and doubles next_checkpoint (200, 400, 800, 1600, ...). effective_cap() and the gauges read only current; between checkpoints the cap is a constant, never re-derived from the racing histogram at run starts. decay() scales the histogram as today and leaves current and next_checkpoint alone; reset() clears everything. No probe designation, scope keying, termination class, or config change.",
  "constants": { "unchanged": ["PROBE_PERIOD=32", "QUANTILE=0.99", "HEADROOM=1.5", "MIN_COMPLETED_SAMPLES=200", "HIST_CELLS=256"], "added": "none - the first checkpoint reuses the engagement floor; the doubling factor 2 is a schedule shape, not a learned-value tunable" },
  "prediction": {
    "decisiveClause": "A/A base-vs-base with the FIXED binary on BOTH sides, same seeds (1000, 1001): pooled throughput ratio and every per-second depth rung ratio (depth>=4..7) inside |ratio-1| <= 0.035, versus the recorded 1.10-1.14 swings on the merged tree. The 0.035 band is set by the pre-run-cap same-hour A/A record (throughput 0.997 and 1.032), i.e. host-drift scale; the event-count nullBand is NOT the claim.",
    "preservationClauses": [
      "pooled per-run P(depth>=6) unchanged vs the current merged tree net of A/A (per-run comparator; A/A per-run swing ~4%)",
      "cap still engages: termination.all.learned_cap_reached > 10000 per chunk (merged record ~159k/chunk)",
      "run_cap.over_cap_completions / probe_completions stays < 1% (merged record 0.11%)"
    ],
    "firingCounter": "run_cap.cap_recomputes (new counter, one increment per checkpoint recompute), floor 1 per session; expected ~5-6 per chunk for the 6000 scope (checkpoints 200..3200 inside ~3400 completions) plus grid-short's",
    "sizePct": "0 to 0 - explicitly a variance fix: the band is on the A/A ratio, not a rung gain. A small throughput shift vs the merged tree is acceptable if the preservation clauses hold."
  },
  "falsifier": "any pooled A/A per-second ratio (throughput or depth>=4..7) outside 1.05; or end-of-chunk run_cap.current_cap_max_scope differing >10% between the two sides of any A/A chunk; or per-run P(depth>=6) falls >5% below the merged tree net of A/A; or cap_recomputes == 0 while the 6000 scope has >=200 completed probe samples; or over_cap share >= 1%"
}
```

## 2. Exact mechanism (shape: deterministic doubling-checkpoint recompute)

### Trade-off: why checkpoints

- Diagnosis unchanged: the recorded instability (end-of-session cap 4283 vs
  5975 at the same seed) comes from re-reading a racing histogram's far-tail
  quantile at every run start, with the cap feeding back into runs/s and
  the probe mix. The trajectory must stop wandering per-read.
- Freeze-at-floor (the original shape) kills the wander but hard-codes
  stationarity: one scope pools a mixture of configs, and a long session
  that dramatically varies node or crash counts shifts the completed-length
  distribution under a value frozen in the session's first seconds - bias
  with no recovery path. Rejected at the hold on that ground.
- EMA smoothing needs a new constant and cannot fix level divergence.
  Quantile/headroom widening is a dose change to an unmeasured operating
  point; it stays available as the follow-up dose contrast, which is only
  interpretable once the trajectory is deterministic. Both rejected.
- Doubling checkpoints give both properties: between checkpoints the cap is
  a constant (the measurement problem is the per-run-start racing read);
  at each checkpoint the estimate uses all data so far, so a composition
  shift is absorbed within one doubling of the sample count; the update
  count is logarithmic, so even a very long session gets a stable-but-alive
  cap. Each successive estimate also has twice the data, so estimator
  noise shrinks as the session ages instead of persisting.
- Cross-process A/A stability: both sides at the same seed reach checkpoint
  N having folded nearly the same first-N completed probes (probes are
  uncapped, so their lengths do not depend on the cap; residual divergence
  comes only from other racy learners' influence on run behavior). The cap
  becomes a deterministic function of an almost-shared sample sequence,
  sampled at shared points - not of thread-race timing.

### Function-by-function changes in `spur-core/src/simulator/run_cap.rs`

1. `ScopeAccum` (line 42): add `current: Option<i32>` (None in `new`) and
   `next_checkpoint: u64` (MIN_COMPLETED_SAMPLES in `new`).
2. `ScopeAccum::cap` (line 69): move the existing body to a private
   `fn estimate(&self, backup: i32) -> Option<i32>` (unchanged math);
   `cap()` becomes `self.current`. `effective_cap()` (line 101) and
   `publish_gauges()` (line 156) need no further change (they call
   `cap()`). `scopes_learned` semantics preserved: a scope returns `Some`
   from the same moment it does today (the 200th completion).
3. `merge_probe` (line 111): inside the existing exclusive `TABLE.entry`
   guard, after the histogram fold and `completed += 1`:

   ```rust
   if acc.completed >= acc.next_checkpoint {
       acc.current = acc.estimate(backup);
       acc.next_checkpoint = acc.next_checkpoint.saturating_mul(2);
       util_stats::record_run_cap_recompute();
   }
   ```

   The over-cap check at the top of the guard reads `acc.current` instead
   of `acc.cap(backup)` - measured against the cap actually governing
   runs. Histogram folding continues between checkpoints; `probes`,
   `probe_completions`, `over_cap_completions` keep exact semantics.
4. `decay` (line 134): keep scaling `hist`/`completed`/`over_cap`; retain
   predicate becomes
   `acc.current.is_some() || acc.completed > 0 || acc.hist.iter().any(|&n| n > 0)`.
   `current` and `next_checkpoint` are not scaled: decay reduces
   `completed`, which delays the next checkpoint until fresher data
   re-crosses it - the recompute then reads a decay-weighted histogram, so
   curriculum sessions adapt toward recent phases. (Module comment: decay
   currently only runs in curriculum sessions.)
5. `reset` (line 148): unchanged in text - `TABLE.clear()` discards
   `current`/`next_checkpoint`; all five reset call sites need no change.
   `cap_recomputes` is a monotone event counter like `probes`.
6. Doc comment (lines 1-7): the cap is recomputed only at doubling
   completed-count checkpoints and is constant in between.

### Concurrency reasoning

Before: every non-probe run start ran a fresh quantile scan over a
histogram being mutated by concurrent probe merges; the cap was a random
walk sampled at run starts. After: `current` is written only inside the
DashMap entry guard's exclusive shard lock, in the same critical section
that folds the crossing sample, at deterministic completed-count
thresholds; readers observe either "no cap yet" (identity, bit-identical
to today's pre-floor behavior) or the latest checkpoint value. Which
handful of in-flight completions straddle a checkpoint can differ between
processes, moving one estimate by at most a few samples' influence on the
p99 cell (~1 cell = ~36 steps, ~0.7% at typical caps); the doubling
schedule means later checkpoints are progressively less sensitive.

### Explicitly untouched

path.rs (probe designation 306, cap read 307-311, merge sites 410/447/816,
LearnedCapReached 785-800), scope keying, Outcome classes,
timer_context.rs, exec.rs, history.rs, event accounting, linearizability
path. Exported counter/gauge semantics unchanged; one counter added.

### util_stats.rs / test additions

- New static `RUN_CAP_CAP_RECOMPUTES` beside `RUN_CAP_PROBES`; gated
  `record_run_cap_recompute()`; `cap_recomputes: u64` in `RunCapStats`
  (util_stats.rs:2773) and its `read()`; add the static to the
  `set_enabled` reset list.
- tests/util_stats_export_completeness.rs: `run_cap(&mut Marks)` gains
  `cap_recomputes: m.int()` and `run_cap_leaves` the matching leaf
  (compile-enforced by the exhaustive destructure).

## 3. Grading plan

Graded primarily by A/A pairs with the fixed binary on BOTH sides, plus one
standard candidate-vs-merged session for preservation. All from
research/orchestrator.

1. A/A session 1 (decisive): `start --name aa-runcap-freeze-1` with the
   fixed binary as both --cand-bin and --base-bin, then `chunk` x2. Read
   `run_cap.current_cap_max_scope` and `cap_recomputes` from both sides'
   per-chunk artifacts.
2. A/A session 2 (replication): `--name aa-runcap-freeze-2`, 2 more
   chunks - 4 A/A pairs total and a cross-session same-seed cap comparison
   (the exact contrast that read 4283 vs 5975). Both sessions' pooled
   ratios must sit inside the band.
3. Preservation session: `--name runcap-freeze-vs-merged`, candidate =
   fixed binary, base = merged-tree binary, `chunk` x2. Read pooled
   per-run P(depth>=6), `learned_cap_reached` floor, over_cap share,
   `cap_recomputes` >= 1 candidate-side. The base side still carries the
   old cap variance, so interpret per-run metrics primarily and read both
   sides' cap gauges each chunk. Measure the base side fresh - a cached
   baseline embeds old cap draws.
4. Panel spot-check (cheap): `grader.ts panel` on the fixed tree vs the
   2026-08-31 anchors (paxos 120.87, mencius 6.11) to confirm the runs/s
   benefit on cappable distributions survives at flat per-run rate.

Cost: 6 lite chunks (~12 x 300 s explore) + build + panel = ~1.5-2 h wall.

## 4. Predicted observables

- Cap gauge becomes a staircase with ~5-6 steps per chunk (checkpoints
  200..3200 inside ~3400 completions), constant between steps; both A/A
  sides at a seed agree end-of-chunk within a few percent (same last
  checkpoint, near-shared sample basis) versus the recorded 28-33%
  spread; the two A/A sessions' end-of-chunk values at the same seed also
  agree (the falsifier's 10% clause watches a residual tail-mode flip).
- learned_cap_reached share stabilizes between checkpoints; floor >
  10k/chunk; iterations_exhausted stays collapsed.
- A/A pooled throughput and depth>=4..7 ratios inside 1.035; per-run
  P(depth>=6) A/A swing stays <= ~4% (already robust).
- cap_recomputes ~5-6 per chunk for the 6000 scope plus grid-short's;
  over_cap share <= ~0.11% or modestly higher, well under 1%.

## 5. Risk flags

- No diff outside run_cap.rs, util_stats.rs, tests. exec.rs, history.rs,
  event accounting, linearizability path untouched; path.rs read-only.
- Early-estimate noise, bounded by the schedule: the checkpoint-200
  estimate is nearly the 2nd max of 200 samples x 1.5 (17%+ cross-seed
  spread, biased high - conservative), but unlike the rejected freeze it
  governs only until checkpoint 400; each doubling halves the estimator's
  variance and any bad draw's lifetime is one doubling. A cap estimated
  too low is watched by over_cap_completions (1% falsifier) and the
  per-run depth clause; too high reverts toward pre-merge throughput,
  bounded by the panel check.
- Non-stationarity (the amendment's reason): a composition shift mid-
  session is absorbed at the next checkpoint; worst-case staleness is one
  doubling of the completed count. For very long sessions this is the
  intended behavior: log-many updates, each better-founded. If a future
  workload needs faster adaptation than doubling allows, a windowed
  re-estimate is the follow-up shape - out of scope here.
- Late-session step discontinuities: a checkpoint recompute mid-chunk
  moves the cap once; both A/A sides cross it at nearly the same
  completion count, so the step cancels in the pair. Across a candidate-
  vs-baseline grade the cap gauge is read on both sides each chunk per
  the 2026-08-31 measurement rule.
- Decay interaction: decay scales `completed` down, delaying the next
  checkpoint; `current` persists meanwhile. Under general_vr decay never
  runs (curriculum only). A curriculum session's recompute reads the
  decay-weighted histogram, adapting toward recent phases - the desired
  direction.
- timer_context sibling check (performed at planning): its multiplier is a
  clamped ratio of monotone counts with a 200-firing floor - no far-tail
  order statistic; structurally not subject to this instability. If
  residual A/A swing survives this fix, timer_context's early-engagement
  noise is the next suspect.

## 6. Test plan

All unit tests keep `config_override::exclusive_session()`.

- Updated: `decay_drops_a_scope_back_to_identity_and_reset_empties`
  breaks by design; rewrite as `decay_delays_the_next_checkpoint_and_reset_empties`
  (engage at 200, decay(0.5) -> effective_cap unchanged and scope
  retained; further merges re-cross and recompute; reset() -> identity
  and empty). The other existing run_cap tests pass unchanged (the
  checkpoint-200 recompute reads the same 200-sample histogram today's
  code reads at that moment).
- New: `cap_is_constant_between_checkpoints` (200 merges at 1200 -> cap
  1835; 150 more at 4000 (total 350 < 400) -> still 1835, over_cap counts
  them; 50 more (400) -> recompute reflects the mixture and the cap
  moves); `recompute_fires_once_per_checkpoint` (cap_recomputes delta is
  exactly 1 at 200, 2 at 400, 3 at 800); `disengaged_scope_recomputes_at_backup`
  (200 merges of 1400 into backup 1500 -> effective_cap == 1500, and
  stays 1500 at 400).
- Export completeness extension (compile-enforced).
- Full `cargo test -p spur-core` plus the grader's `finish --regression`.
