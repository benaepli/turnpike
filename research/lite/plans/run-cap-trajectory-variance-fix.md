# Implementation Plan: run-cap-trajectory-variance-fix

Status: awaiting-approval (moderated round per user request; origin:
operator-agent). Prediction freezes at approval. Judge scores at planning
time: expectedGain 7, expectedCost 0. Runner-up this round:
crash-placement-completion-span-draw (gain 6, held next-up in the pool).

## 1. Hypothesis JSON

```json
{
  "id": "run-cap-trajectory-variance-fix",
  "parent": "learned-run-cap-probe-p99",
  "kind": "change",
  "category": "scheduler",
  "origin": "operator-agent",
  "title": "Freeze each scope's learned run cap at the engagement floor so the cap trajectory is a single step, not a racing quantile",
  "mechanism": "run_cap.rs only: ScopeAccum gains frozen: Option<i32>. When merge_probe folds the completed probe that lifts a scope's completed count to MIN_COMPLETED_SAMPLES (200, unchanged), it computes the quantile cap once from that 200-sample histogram and stores it in frozen, permanently for the session. effective_cap() and the gauges read only frozen; the histogram keeps accumulating for over_cap/diagnostic bookkeeping but never moves the cap again. decay() never unfreezes; reset() clears everything as before. No probe designation, scope keying, termination class, or config change.",
  "constants": { "unchanged": ["PROBE_PERIOD=32", "QUANTILE=0.99", "HEADROOM=1.5", "MIN_COMPLETED_SAMPLES=200", "HIST_CELLS=256"], "added": "none - the freeze point reuses the existing engagement floor" },
  "prediction": {
    "decisiveClause": "A/A base-vs-base with the FIXED binary on BOTH sides, same seeds (1000, 1001): pooled throughput ratio and every per-second depth rung ratio (depth>=4..7) inside |ratio-1| <= 0.035, versus the recorded 1.10-1.14 swings on the merged tree. The 0.035 band is set by the pre-run-cap same-hour A/A record (throughput 0.997 and 1.032), i.e. host-drift scale; the event-count nullBand is NOT the claim.",
    "preservationClauses": [
      "pooled per-run P(depth>=6) unchanged vs the current merged tree net of A/A (per-run comparator; A/A per-run swing ~4%)",
      "cap still engages: termination.all.learned_cap_reached > 10000 per chunk (merged record ~159k/chunk)",
      "run_cap.over_cap_completions / probe_completions stays < 1% (merged record 0.11%)"
    ],
    "firingCounter": "run_cap.scopes_frozen (new counter, one increment per scope freeze), floor 1 per session; expected 2 (6000 scope, and grid-short's 1500 scope frozen at its backup, i.e. disengaged as today)",
    "sizePct": "0 to 0 - explicitly a variance fix: the band is on the A/A ratio, not a rung gain. A small throughput shift vs the merged tree is acceptable if the preservation clauses hold."
  },
  "falsifier": "any pooled A/A per-second ratio (throughput or depth>=4..7) outside 1.05; or end-of-chunk run_cap.current_cap_max_scope differing >10% between the two sides of any A/A chunk; or per-run P(depth>=6) falls >5% below the merged tree net of A/A; or scopes_frozen == 0 while the 6000 scope has >=200 completed probe samples; or over_cap share >= 1%"
}
```

## 2. Exact mechanism (shape chosen: freeze-after-N, at N = the existing floor)

### Trade-off: why freeze, and why this variant

- Diagnosis: the recorded instability (end-of-session cap 4283 vs 5975 at
  the same seed) is a level flip between two tail modes, not small jitter.
  The p99 x 1.5 statistic sits where the histogram holds ~1% of mass, that
  mass is a lumpy mixture of arm/phase populations (the 6000 scope is
  shared by four of five campaign arms), and the cap feeds back into
  runs/s and hence into its own probe stream. Re-reading the racing
  histogram at every run start turns that into a wandering trajectory.
- EMA smoothing (shape c) removes only within-session jitter; it cannot fix
  a persistent level divergence (4283 vs 5975 are converged end states) and
  needs a new smoothing constant. Rejected.
- Widening the base (shape b) is a dose change to an unmeasured operating
  point, and the end-of-session estimate already has thousands of samples
  yet still spreads 33%. Stays available as a follow-up dose contrast -
  which is only interpretable after this fix, because today the dose itself
  is a random variable. Rejected for this iteration.
- Freeze (shape a) is the only shape that guarantees a flat trajectory:
  after the freeze the cap is a constant and the feedback loop (cap ->
  runs/s -> probe mix -> cap) is severed. Early freeze is safe for A/A
  because both sides at the same seed sample essentially the same first
  200 completed probes (cross-side divergence is smallest at session
  start; chunk-1 end caps matched exactly even across different binaries).
- Freeze-at-merge, not recompute-at-decay-boundaries: decay's only call
  site is CurriculumExplorer::step (explorer.rs:2297-2300) and
  general_vr.json runs no curriculum arm, so a boundary-recompute cap
  would never engage. Freeze-at-the-crossing-merge works in every mode.
- N = 200 (no new constant): capping starts at exactly the same moment it
  does today and the frozen value IS today's first engaged cap - the diff
  is purely "stop updating afterwards". Estimator noise at N=200 is
  cross-seed and cancels within an A/A pair.

### Function-by-function changes in `spur-core/src/simulator/run_cap.rs`

1. `ScopeAccum` (line 42): add `frozen: Option<i32>`, `None` in `new`.
2. `ScopeAccum::cap` (line 69): move the existing body to a private
   `fn estimate(&self, backup: i32) -> Option<i32>` (unchanged math);
   `cap()` becomes `self.frozen`. `effective_cap()` (line 101) and
   `publish_gauges()` (line 156) need no further change (they call
   `cap()`). `scopes_learned` semantics preserved: a scope returns `Some`
   from the same moment in time (the 200th completion).
3. `merge_probe` (line 111): inside the existing exclusive `TABLE.entry`
   guard, after the histogram fold and `completed += 1`:

   ```rust
   if acc.frozen.is_none() && acc.completed >= MIN_COMPLETED_SAMPLES {
       acc.frozen = acc.estimate(backup);
       util_stats::record_run_cap_scope_frozen();
   }
   ```

   The over-cap check at the top of the guard reads `acc.frozen` instead
   of `acc.cap(backup)` - measured against the cap actually governing
   runs. Histogram folding continues after the freeze; `probes`,
   `probe_completions`, `over_cap_completions` keep exact semantics.
4. `decay` (line 134): keep scaling `hist`/`completed`/`over_cap`; retain
   predicate becomes
   `acc.frozen.is_some() || acc.completed > 0 || acc.hist.iter().any(|&n| n > 0)`.
   The frozen value is never scaled or cleared: decay exists so stale
   phases lose their vote in a still-adapting estimate; a frozen scope has
   no vote, and unfreezing would reintroduce the variance being removed.
   (Module comment: decay currently only runs in curriculum sessions.)
5. `reset` (line 148): unchanged - `TABLE.clear()` discards `frozen`; all
   five reset call sites need no change. `scopes_frozen` is a monotone
   event counter like `probes`.
6. Doc comment (lines 1-7): the cap is computed once, at the sample floor,
   and frozen for the session.

### Concurrency reasoning

Before: every non-probe run start ran a fresh quantile scan over a
histogram being mutated by concurrent probe merges; the cap was a random
walk sampled at run starts, and merge order (thread racing) changed every
subsequent read, feeding back through run durations. After: `frozen` is
written exactly once per scope under the DashMap entry guard's exclusive
shard lock, in the same critical section that folds the crossing sample; a
reader observes either "not frozen" (identity, bit-identical to today's
pre-floor behavior) or the single frozen value. Remaining nondeterminism is
which ~200 completions constitute the freeze sample - bounded by ~1
histogram cell (~36 steps, ~0.7%) in typical draws.

### Explicitly untouched

path.rs (probe designation 306, cap read 307-311, merge sites 410/447/816,
LearnedCapReached 785-800), scope keying, Outcome classes,
timer_context.rs, exec.rs, history.rs, event accounting, linearizability
path. Exported counter/gauge semantics unchanged; one counter added.

### util_stats.rs / test additions

- New static `RUN_CAP_SCOPES_FROZEN` beside `RUN_CAP_PROBES`; gated
  `record_run_cap_scope_frozen()`; `scopes_frozen: u64` in `RunCapStats`
  (util_stats.rs:2773) and its `read()`; add the static to the
  `set_enabled` reset list.
- tests/util_stats_export_completeness.rs: `run_cap(&mut Marks)` gains
  `scopes_frozen: m.int()` and `run_cap_leaves` the matching leaf
  (compile-enforced by the exhaustive destructure).

## 3. Grading plan

Graded primarily by A/A pairs with the fixed binary on BOTH sides, plus one
standard candidate-vs-merged session for preservation. All from
research/orchestrator.

1. A/A session 1 (decisive): `start --name aa-runcap-freeze-1` with the
   fixed binary as both --cand-bin and --base-bin, then `chunk` x2. Read
   `run_cap.current_cap_max_scope` and `scopes_frozen` from both sides'
   per-chunk artifacts.
2. A/A session 2 (replication): `--name aa-runcap-freeze-2`, 2 more
   chunks - 4 A/A pairs total and a cross-session same-seed cap comparison
   (the exact contrast that read 4283 vs 5975). Both sessions' pooled
   ratios must sit inside the band.
3. Preservation session: `--name runcap-freeze-vs-merged`, candidate =
   fixed binary, base = merged-tree binary, `chunk` x2. Read pooled
   per-run P(depth>=6), `learned_cap_reached` floor, over_cap share,
   `scopes_frozen` >= 1 candidate-side. The base side still carries the
   old cap variance, so interpret per-run metrics primarily and read both
   sides' cap gauges each chunk. Measure the base side fresh - a cached
   baseline embeds old cap draws.
4. Panel spot-check (cheap): `grader.ts panel` on the fixed tree vs the
   2026-08-31 anchors (paxos 120.87, mencius 6.11) to confirm the runs/s
   benefit on cappable distributions survives at flat per-run rate.

Cost: 6 lite chunks (~12 x 300 s explore) + build + panel = ~1.5-2 h wall.

## 4. Predicted observables

- Cap gauge becomes a step function; both A/A sides at a seed agree
  end-of-chunk within ~2% (vs the recorded 28-33% spread); the two A/A
  sessions' frozen values at the same seed also agree (the falsifier's 10%
  clause watches a residual tail-mode flip).
- learned_cap_reached share stabilizes per chunk; floor > 10k/chunk;
  iterations_exhausted stays collapsed.
- A/A pooled throughput and depth>=4..7 ratios inside 1.035; per-run
  P(depth>=6) A/A swing stays <= ~4% (already robust).
- scopes_frozen = 2 per session; over_cap share <= ~0.11% or modestly
  higher, well under 1% (the early frozen cap is a near-2nd-max-of-200
  statistic, biased high - conservative direction).

## 5. Risk flags

- No diff outside run_cap.rs, util_stats.rs, tests. exec.rs, history.rs,
  event accounting, linearizability path untouched; path.rs read-only.
- Locked-in bad early draw, quantified: the frozen cap is nearly the 2nd
  max of 200 samples x 1.5 - roughly 17%+ relative spread across seeds
  (heavier for this tail; observed inter-mode distance ~33%). The spread
  is cross-seed, cancels within an A/A pair, and is biased high
  (conservative: depth preserved, some throughput given back). A cap
  frozen too low is watched by over_cap_completions (1% falsifier) and the
  per-run depth clause; too high merely reverts toward pre-merge
  throughput, bounded by the panel check.
- Decay interaction: freeze survives decay by design; under general_vr
  decay never runs (curriculum only). If a long curriculum session keeping
  its first phase's cap ever bites, re-derivation at decay boundaries is
  the sanctioned escape hatch - out of scope here.
- timer_context sibling check (performed): its multiplier is a clamped
  ratio of monotone counts with a 200-firing floor - no far-tail order
  statistic, concentrates as counts grow; structurally not subject to this
  instability. If residual A/A swing survives this fix, timer_context's
  early-engagement noise is the next suspect.

## 6. Test plan

All unit tests keep `config_override::exclusive_session()`.

- Updated: `decay_drops_a_scope_back_to_identity_and_reset_empties` breaks
  by design; rewrite as `decay_does_not_unfreeze_and_reset_does` (engage
  at 200, decay(0.5) repeatedly -> effective_cap unchanged and scope
  retained; reset() -> identity and empty). The other existing run_cap
  tests pass unchanged (freeze at the 200th merge computes from the same
  200-sample histogram today's code reads at that moment).
- New: `cap_freezes_at_the_floor_and_later_samples_do_not_move_it` (200
  merges at 1200 -> cap 1835; 500 more at 4000 -> still 1835, over_cap
  counts those 500); `freeze_fires_once_per_scope` (scopes_frozen delta
  exactly 1, then 2 with a second scope); `disengaged_scope_freezes_at_backup`
  (200 merges of 1400 into backup 1500 -> effective_cap == 1500).
- Export completeness extension (compile-enforced).
- Full `cargo test -p spur-core` plus the grader's `finish --regression`.
