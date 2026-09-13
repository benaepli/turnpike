# Plan: thread-local-stats-blocks

Per-thread counter blocks, folded into the global counters once per run.
About 105 counter slots across 14 record_* functions convert; nothing the
grader or the reward reads mid-run changes.

Recommendation: the fold pattern (per-thread block, folded once per run),
not per-thread shards. Comparison in 3.1.

## 1. Hypothesis and declarations

On `scheduler_configs/loop/general_vr.json`, every scheduling step makes
about 14 unconditional `Relaxed` `fetch_add` writes to shared
`static AtomicU64` counters in `spur/spur-core/src/simulator/util_stats.rs`.
All 30 rayon workers write the same counters. Deliveries and timer firings
add more, plus a global `Mutex<HashMap>` lock on every timer firing. Moving
those writes into a per-thread block, folded into the globals once per run,
removes the true sharing.

- **Search: neutral.** Only *when* the dump counters absorb a run's
  increments changes: at run end instead of per event. No RNG draws, no
  scheduling reads and no reward reads of any converted counter (section 7).
- **Sharing: shared.** The saving is cache-line traffic between cores. By
  construction it travels between runs.

## 2. The cost being removed, and where the profile shows it

Profile `research/perf/profiles/292c15b.md`. Inlined `fetch_add` has no
symbol of its own, so the cost sits in its callers' self time:

- `schedule_runnable`: 8.69 (RecordRng), 1.70 (ReplayRng), 1.56 (LiveRng)
- `walk_recovery_placebo`: 3.84
- `select_within_queue`: 2.14
- `audit_multiplier_authority`: inlined, no row of its own

The per-step writes, verified at these call sites:

- path.rs:637, `record_steer_step_total`: `SA_STEPS_TOTAL`
- scheduler.rs:1143, `record_steer_step`: `SA_STEPS`
- scheduler.rs:1144, 644, 488, `record_preference_consultation`: 3 x
  (`SA_PREFERENCE_CONSULTED` + `SA_PREFERENCE_SOURCE_ABSENT`). No predicate
  carries weight, so both are written each time: 6 writes per step.
- scheduler.rs:1148/1153, `record_empty_slice_skip(QueueAudit)` and
  `record_steer_reach(NoWeightedPredicate)`
- scheduler.rs:501, `ES_CANDIDATE_MASK`
- scheduler.rs:547, `ES_RANKING_PASS`
- scheduler.rs:545, `record_steer_evaluation`: `STEER_EVALUATIONS`,
  `STEER_DIVERGENT_PICKS`
- scheduler.rs:179, `record_multiplier_decision`: `MA_DECISIONS`, plus the
  contested and quick-fire splits
- scheduler.rs:212, `record_multiplier_flips`: the flip counters and a
  float sum
- scheduler.rs:305, `record_recovery_placebo`: `RWP_DECISIONS`,
  `RWP_EVALUATED` and 4 flag counters
- scheduler.rs:1125, `record_crash_anchor_offer`
- scheduler.rs:1378, `record_timer_admission`

Per event:

- per delivery: `record_delivery` (scheduler.rs:1733), the DELIVERIES and
  acceptance-distance buckets
- per timer firing: `record_timer` (scheduler.rs:1738), 6 atomics plus the
  `TIMER_EFFECTS` lock (util_stats.rs:535)

Runs take about 2,000 steps (observations.md:412).

## 3. Files and mechanisms to change

### 3.1 Fold versus per-thread shards (judge finding 3)

**Consistency.**
- Fold: the same shape as the merged `FRAME_RUN` / `flush_frame_stats`
  (util_stats.rs:1794, 5311; path.rs:469).
- Shards: a new pattern.

**Threads outside rayon.**
- Fold: `thread_local!` works on any thread, including main, test threads
  and the `std::thread` in the export tests.
- Shards: `current_thread_index()` is `None` there, so a fallback shard is
  needed. An index-0 slot collides across pools, including the test pools
  built with `build_global`.

**Write cost.**
- Fold: a plain `Cell<u64>` add, no atomic.
- Shards: load-then-store is only safe with one writer per index, and that
  fails when two pools exist. Safe code falls back to an uncontended
  `fetch_add`, which still takes the lock prefix.

**Snapshot exactness.**
- Exactness only matters when no run is in flight, which is the case at
  every graded snapshot:
  - The snapshots are at campaign.rs:1060/1091, around `arm.arm.step`.
    Its `par_iter().collect()` (campaign.rs:558-561) joins every run first.
  - The CLI dump is taken after the session.
  - The module-level `snapshot()` calls in run_cap, stall_cap,
    arm_selector, fault_timing, timer_context, ghost_release and
    crash_phase are all inside `#[cfg(test)]` modules.
- Shards: exact at any moment, which nothing on the graded path needs.

**Per-run cost.**
- Fold: about 105 Cell reads plus a `fetch_add` for each nonzero slot,
  once per run. That replaces about 28,000 shared-line writes.
- Shards: no fold, but every snapshot sums all shards, the shard count is
  only known at runtime, and each write goes through a `OnceLock` load.

**Errored runs.**
- Fold: leftovers fold at the next `begin_run` on that thread. `FRAME_RUN`
  already behaves this way.
- Shards: nothing is left over.

### 3.2 spur/spur-core/src/simulator/util_stats.rs

**The block.** Add `static RUN_COUNTERS: RunCounters = const { RunCounters::new() };`
to the existing `thread_local!` at 1784. `RunCounters` holds:

- one `Cell<u64>` per converted slot, with arrays written as
  `[const { Cell::new(0) }; N]`
- `active: Cell<bool>`
- `generation: Cell<u64>`
- `writes: Cell<u64>`
- `configured_sum: Cell<f64>`

Do NOT copy the whole struct through a `Cell<Struct>` the way `FrameTally`
does. The block is about 1 KB, so a get/set per write would be a memcpy.
Give each field its own Cell. The const initializer with no Drop keeps
`with` a plain TLS offset.

**Write helper.**
`#[inline] fn bump(local: impl Fn(&RunCounters) -> &Cell<u64>, global: &AtomicU64, n: u64)`:

- if `active`: add `n` to the local cell and 1 to `writes`
- otherwise: `global.fetch_add(n, Relaxed)`

Each converted record_* keeps its gate and branch structure; only the write
lines change. The `RUN_CROSSING` part of `record_delivery` (1555-1566)
stays as it is.

**Converted counters.** Criterion: written at least once per step, per
delivery or per timer firing on the graded path.

1. `record_steer_step_total` (1352): `SA_STEPS_TOTAL`
2. `record_steer_step` (1365): `SA_STEPS`
3. `record_preference_consultation` (1382): `SA_PREFERENCE_CONSULTED`,
   `SA_PREFERENCE_SOURCE_ABSENT`
4. `record_empty_slice_skip` (1630): `ES_CANDIDATE_MASK`,
   `ES_RANKING_PASS`, `ES_QUEUE_AUDIT`
5. `record_steer_reach` (1446): all six `SR_*`
6. `record_steer_evaluation` (1598): `STEER_EVALUATIONS`,
   `STEER_DIVERGENT_PICKS`
7. `record_multiplier_decision` (1284): `MA_DECISIONS`,
   `MA_CONTESTED_DECISIONS`, `MA_QUICK_FIRE_OFFERS`,
   `MA_QUICK_FIRE_DECISIONS`
8. `record_multiplier_flips` (1305): `MA_FLIPPED_CONFIGURED`,
   `MA_FLIPPED[5]`. `MA_CONFIGURED_SUM` becomes a local f64 sum, added at
   fold with `add_f64` (1583); see the float flag in section 8.
9. `record_recovery_placebo` (1253): `RWP_DECISIONS`, `RWP_EVALUATED`,
   `RWP_PRESENT`, `RWP_CONTESTED`, `RWP_WON`, `RWP_FLIPPED`
10. `record_crash_anchor_offer` (2100): `CA_STEPS_WITH_CRASH_ELIGIBLE`,
    `CA_OFFERED`
11. `record_timer_admission` (4261): `TIMER_STEER_EVALUATED`, `_RAISED`,
    `_LOWERED`
12. `record_delivery` (1516): `DELIVERIES[5]`, `DELIVERIES_ACTED[5]`,
    `ACCEPT_DIST[3][7]`, `ACCEPT_DIST_ACTED[3][7]`
13. `record_timer` (4135): `TIMERS_FIRED`, `TIMERS_ACTED`,
    `TIMERS_INFLIGHT_FIRED`, `TIMERS_INFLIGHT_ACTED`,
    `TIMER_STREAK_FIRED[4]`, `TIMER_STREAK_ACTED[4]`, plus `TIMER_EFFECTS`
    (see "Timer effect map" below)

**Not converted.**

- `TERMINATION` (450). The grader reads `termination.all`
  (evaluate.ts:237) and the reward reads `termination.all.plan_complete`
  (campaign.rs:208).
- Every once-per-run record: finish_run, run extension, quiet stretch,
  ghost release run, plan deps.
- `record_steer_authority` and `record_audit_candidates`. They are not
  reached: `resolvable` is false with no predicate and no
  `steer_audit_always`.
- `record_term_decision`, `record_term_authority`, `record_term_acted`.
  `count_terms` is false and the mask is 0.
- `record_message_entry`. It writes only when a recovery window closes,
  and `RW_MAX` uses `fetch_max`.
- `record_purgatory_delay`. `delay_probability` is 0.
- The `timer_context` `CELL_` learner atomics.
- Every counter read by run_cap, stall_cap, arm_selector or fault_timing.

**Timer effect map.** Add a second thread-local,
`RUN_TIMER_EFFECTS: RefCell<HashMap<TimerKey, (u64, u64)>>`, capped at
`TIMER_KEY_CAP` (534).

- While `active`, `record_timer` writes it. Otherwise it takes the global
  lock as it does today.
- The fold drains the map with `drain()`, which keeps capacity, under ONE
  lock per run.
- The drain applies the event path's rule: add if present, insert if
  `len < TIMER_KEY_CAP`.
- `TimerEffectStats::read` sorts `by_key` (4294), so merge order does not
  show.

**`fold_run_counters()`** is new and private, placed beside
`flush_frame_stats` (5311). In order:

1. Read `active` and `writes`, then clear `active`.
2. If `generation` differs from a new
   `static STATS_GENERATION: AtomicU64`, zero the block and the map without
   adding anything.
3. Otherwise add each nonzero slot to its global, add `configured_sum`
   with `add_f64`, and merge the map.
4. If `writes > 0`, add 1 to `STATS_LOCAL_FOLDS` and add `writes` to
   `STATS_LOCAL_FOLDED_INCREMENTS`.
5. Zero the block.

**Hooks.**

- **`begin_run` (1843).** Call `fold_run_counters()` beside
  `flush_frame_stats()` (1848) as the idempotent backstop, then set
  `generation = STATS_GENERATION` and `active = true`. This comes after the
  existing `enabled()` early return, so a disabled session never activates
  the block.
- **`record_run_termination` (2908).** Call `fold_run_counters()` as the
  first statement after the `enabled()` check and BEFORE the
  `debug_assert!` at 2912 (judge finding 1). This is the run-end fold.
  - It lives inside `record_run_termination` rather than beside
    `flush_frame_stats` at path.rs:469, so unit tests that call it
    directly also see folded totals.
  - All five run-end paths reach it via path.rs `record_termination` (607,
    674, 1139, 1183, 1202).
  - `record_run_extension` and `record_ghost_release_run` run after it with
    `active` false, and write no converted counter.
- **`snapshot()` (6202).** Call `fold_run_counters()` first. Single-threaded
  tests that `begin_run` and then snapshot without a run end (for example
  6576 and 6794) then still read exact values. The campaign thread has no
  active block, so this is a no-op there.
- **`set_enabled(true)` (691).** Increment `STATS_GENERATION`, zero the
  calling thread's block, and add `STATS_LOCAL_FOLDS` and
  `STATS_LOCAL_FOLDED_INCREMENTS` to the reset list.

**Dump section.**

- Add `pub struct StatsLocalStats { pub folds: u64, pub folded_increments: u64 }`
  with `read()`.
- Add `pub stats_local: StatsLocalStats` to `UtilizationSnapshot` after
  `frame` (6125), and `stats_local: StatsLocalStats::read()` after 6337.
- Doc comment, constraint only: "Counter blocks folded into the session
  totals at run end, and the writes they carried."

### 3.3 Nested runs on one thread (judge finding 5)

- `serialize_history`'s `par_iter` (history.rs:213) is called at
  explorer.rs:1165/1479, after `exec_plan` has returned. By then the outer
  run's block is folded and inactive.
- A stolen job starts its own run: `begin_run` folds nothing and activates,
  that run's end folds and deactivates, and the outer frame resumes with
  nothing local.
- No `par_iter`, `join` or `scope` exists inside `exec_plan`'s call tree. A
  grep of path.rs, core/scheduler.rs and core/exec.rs finds none.
- If one ever did, the fold is additive, so totals stay exact. The inner
  `begin_run` folds the outer run's partial block, and the outer run's
  remaining writes go straight to the globals. Only `folds` would count 2
  for that run.

### 3.4 spur/spur-core/tests/util_stats_export_completeness.rs

- Add `stats_local(m)` and `stats_local_leaves`, modeled on `frame` and
  `frame_leaves` (1237-1256).
- Add `stats_local: _` to the destructure (about 1939).
- Add the section name to both key lists (about 1981 and 2126).
- Add the assignment and leaves (about 2057 and 2079).

No other file changes. The call sites in path.rs, scheduler.rs and exec.rs
keep their signatures.

## 4. Config surface

None. No new config key, and no entry in the explorer's config-key list.

## 5. Counters and what per-run values mean

Normalize by `termination.all.runs`.

**`stats_local.folded_increments`: 25,000 to 55,000 per run.** That is
about 14 per step over about 2,000 steps, plus deliveries, acceptance
distance and timers. Near 0 means the writes are not going through the
block.

**`stats_local.folds`: 1.00 per run within 1 percent.**
- Below 1 means runs end without folding. Leftovers caught by the backstop
  are counted too, so a persistent shortfall means blocks never activated.
- Above 1 means runs are being folded twice.

## 6. Treatment bit

None. `VARIANT_BITS` is full, and the saving is shared anyway.

## 7. Predicted observables, and what must not move

**Band.** [1.05, 1.20] on cross-binary runs per second.

**Candidate profile.**
- `walk_recovery_placebo` self falls by at least 1.0 point.
- The summed self of `schedule_runnable` (all specializations),
  `select_within_queue`, `walk_recovery_placebo` and
  `audit_multiplier_authority` falls by at least 4 points.
- A new `fold_run_counters` symbol appears, well under 0.5 points.

**Must not move.**
- Steps per run, end reasons and per-arm counts.
- Every existing integer leaf per run.
- `timer_effects.by_key` length.
- `termination.*`, which is still written live.
- Runs per second must not separate downward.

**Dump shape.** Every existing field keeps its name and shape. The only
change is the added `stats_local` section.

**Falsifiers.** The hypothesis is refuted if any of these holds:
- the rps interval lies entirely below 1.05
- the spread check reads outside the baseline's spread on steps per run,
  end reasons or per-arm counts
- `walk_recovery_placebo` self does not fall by at least 1.0 point
- `folds` per run is not 1 within 1 percent
- the dump's integer leaves per run, or the `by_key` length, differ from
  the baseline beyond spread

## 8. Risk flags

**Protected code.** exec.rs, history.rs, event accounting and the
linearizability recording path are not touched.

**Run tagging the grader reads.** Not touched.
- `TERMINATION` stays live.
- The per-arm split comes from the slice-boundary delta (campaign.rs:1091),
  which only runs with no run in flight.

**Errored runs.**
- A run that exits `exec_plan` via `?` (path.rs:601, 727, 761, 765, 796,
  882) skips run end. Its block folds at the next `begin_run` on that
  thread, possibly into a later slice's delta.
- `set_enabled(true)` drops an earlier session's leftovers through the
  generation check.
- `FRAME_RUN` behaves the same way today.

**`MA_CONFIGURED_SUM` is a float.**
- A local sum added at fold groups the additions differently.
  `mean_configured_multiplier` may therefore differ in the last unit of
  precision.
- It is not an integer leaf, so `delta` and the spread check ignore it.
- If bit-exact floats are wanted, leave `record_multiplier_flips`'s
  `add_f64` global. It only fires on contested quick-fire decisions.

**`TIMER_EFFECTS` cap.**
- Admission differs from today only once the global map has hit 4096 keys.
- Before grading, confirm the baseline dump's `timer_effects.by_key` length
  is below 4096. If it is at the cap, keep the map global and convert only
  the atomics.

**Forgetting to deactivate.** If `active` is not cleared at run end, the
writes that follow the run leak into the next slice. The order in 3.2
fixes this: fold, then deactivate, before the assert.

## 9. Grading plan

Instrument: shared, so the primary is cross-binary against the 0.05 layout
floor.

```
--search neutral --sharing shared --primary cross-binary --band-min 1.05 --band-max 1.20 --counter stats_local.folded_increments --argument <text below>
```

The counter reads absent on the baseline, so it is mechanism evidence, not
the ratio.

Rounds: min 3, max 6, 120 s campaign wall each. Expect 3 to 4 rounds if the
effect is mid-band.

Neutral argument:

> The change moves where about 105 observation-only utilization counters
> accumulate during a run: into a block owned by the running thread,
> folded into the same process-wide totals when the run ends (and at the
> next run's start as a backstop). No counter it touches is read by
> scheduling, arm selection, run or stall caps, fault timing or the
> campaign reward. Those read the termination tallies, which stay live, or
> learner state that is not converted. Every snapshot is taken between
> slices after all runs have joined, and the snapshot folds the calling
> thread's block first, so every dumped total is the same sum. No random
> draw, candidate set, ranking or event order changes; only when a count
> reaches the shared total.

Pre-grade checks:

1. From the root:
   `RUST_MIN_STACK=33554432 cargo test --manifest-path spur/Cargo.toml -p spur-core`.
   It must include `util_stats_export_completeness`,
   `stats_export_parity` and the util_stats tests in the same file.
2. A debug-build smoke campaign on the graded config, which exercises the
   moved `debug_assert!`. Check `stats_local.folds / termination.all.runs`
   is about 1.00 and `folded_increments / runs` is 25,000 to 55,000.
3. Compare the flattened key sets of the candidate's and the baseline's
   `utilization.json`. They must be equal except for `stats_local`,
   `stats_local.folds` and `stats_local.folded_increments`. Also check
   `timer_effects.by_key` length: below 4096, and equal to the baseline's
   within spread.

Critical files: `spur/spur-core/src/simulator/util_stats.rs`,
`spur/spur-core/tests/util_stats_export_completeness.rs`. Read-only
references: `path.rs` (run-end paths), `core/scheduler.rs` (call sites),
`campaign.rs` (snapshot and reward readers).
