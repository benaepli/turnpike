All exploration is done — I verified the scoring path, the timer-fire path, the feedback sharing pattern, the run-end hooks, and the stats export machinery in this tree. Here is the plan.

---

# Plan: timer-refire-outcome-quantile

## 1. Hypothesis (frozen)

- **id**: timer-refire-outcome-quantile (origin: user)
- **Title**: Cross-run learned refire budget: damp a timer class past the firing count that completed runs exhibit.
- **Description**: Session-global per-timer-class outcome-correlation table. Timer class key = the resume vertex `TimerKey` already uses (util_stats.rs). At run end the explorer knows the outcome (`RunOutcome::Completed` vs `IterationsExhausted`) and per-(node,vertex) firing counts. Accumulate per timer vertex the within-run firing-count distribution split by outcome (modeled on `GlobalTimeline`'s merge/decay); derive a per-class refire budget = ~p90 firing count observed in completed runs (Laplace-smoothed; identity behavior until >= 200 firings of that class sampled). During a run, a `Runnable::Timer` whose class's within-run firing count for that node has passed its learned budget gets its selection score multiplied by 0.25 (bounded, never zero). No config field; bound and sample floor are compile-time constants.
- **Counters**: `timer_refire_budget.damped`, `timer_refire_budget.classes_learned`, `timer_refire_budget.over_budget_firings`.
- **Frozen prediction**: firing counter `timer_refire_budget.damped`, floor 50000; rung depth>=6 events per explore-second, sizePct +4% to +15%; independent observables: `termination.all.iterations_exhausted` share falls >=3pp from ~72%; `timer_effects.inert_streak.long.fired` per run falls >=25% while `timer_effects.all.acted` per run stays within 5%.

## 2. Verified code reality (what I confirmed in this tree)

**Timer scoring is live through the within-queue blend, not bypassed.** `schedule_runnable` (`core/scheduler.rs:690`) picks a queue by *size only* (`QueueSelector::select`, `core/queue_selector.rs:31` — `ProbabilisticSelector`/`PreemptiveSelector`/`AnySelector` all read `QueueInfo.timer_queue_size`, never scores). When `QueueSelection::Timer` is chosen (`core/scheduler.rs:908-945`), the timer queue goes through `select_within_queue` (`core/scheduler.rs:470`), whose Tournament and Proportional arms both score every candidate via `score_with_terms` (`core/scheduler.rs:110-132`). `score_runnable` (line 138) is a thin wrapper over `score_with_terms`. **The implementation site is `score_with_terms`** — one multiplier there reaches Tournament, Proportional, and all audit paths uniformly. Consequence (stated honestly): the damping re-ranks timers *within* the timer queue (which class fires), it cannot reduce how often the timer queue itself is drawn; and if every eligible timer is over budget the uniform 0.25 cancels in both selector arms. The predicted effect operates by shifting firings from over-budget classes (long inert-streak refires) to under-budget classes.

**The resume vertex of a PENDING timer is knowable.** `Timer` (`core/state.rs:391`) carries `pc` (the `set_timer` creation site) and `channel`. The class vertex `TimerKey` uses is the *woken reader's* `pc`: at fire time `chan.pop_waiting_reader()` yields the parked `Record` and `reader.timer_entry = Some(reader.pc)` (`core/scheduler.rs:1017`); `record_timer` later keys on that `r.pc` (`core/scheduler.rs:1113-1122`). Before firing, that same reader is parked in `state.channels[timer.channel].waiting_readers` (front entry — `pop_waiting_reader` is `pop_front`, `core/state.rs:360`), and its `pc` is exactly the vertex it will resume at. So scoring-time lookup is `state.channels.get(&t.channel)?.waiting_readers.front().map(|w| w.0.pc)`. A timer whose channel has no parked reader yet (fires into the buffer) has no class and is never damped — consistent with `TimerKey` accounting, which also skips those. **No deviation needed here.**

**Per-(node,vertex) within-run firing counts do NOT currently exist.** `TimerRunStats` (`core/state.rs:639`) holds run totals only; `timer_inert_streaks` (`core/state.rs:588`) holds consecutive-inert streaks (reset on acted), not totals. Also, the existing counting (`note_timer_effect`, `core/state.rs:723`, driven from `core/scheduler.rs:1145-1148`) only runs when `util_stats::acted_fraction_enabled()`. A behavior mechanism must not depend on the stats switch, so a small new unconditional per-run table is required (see step 3b). This is an addition the hypothesis text already assumes exists; flagged in section 8.

**Sharing/merge pattern.** `GlobalTimeline` (`feedback.rs:293`): `DashMap<K, u64>` + `AtomicU64`, per-run local accumulator, `merge` at run end, `decay(factor)` retains-and-floors. It lives in `GlobalState<F>` (`coverage.rs:245`), shared via `Arc` across rayon workers (`explorer.rs:1211`, `par_iter` at 1456/1571/2247/...). Merge hook: after `exec_plan` returns (`explorer.rs:1084` and `1386` — both call sites go through `exec_plan`, `path.rs:281`). Decay cadence: per-batch, `F::decay(&self.global_state.feedback, self.decay_factor)` at `explorer.rs:2286-2287` (half-life from `decay_half_life_runs`, `explorer.rs:2070/2119`). Our table follows this shape but as a session-global store in a new module (it cannot live in `F::Global` without touching every `Feedback` impl and every strategy's type signature); it is reset at session start beside `util_stats::set_enabled` (sites below).

**Run outcome site.** `exec_plan` (`path.rs:281`) has exactly three exits, each already calling `record_termination` with `&path_state.state` in hand: `Completed` (`path.rs:396`), `Deadlock` (`path.rs:430`), `IterationsExhausted` (`path.rs:779`). Both explorer run paths (`run_single_simulation` at `explorer.rs:1051`, `run_single_plan` at `explorer.rs:1359`) funnel through it, so hooking the merge at these exits covers every run.

## 3. Files and mechanisms to change

**a) NEW `spur/spur-core/src/simulator/timer_budget.rs`** — the session-global table, modeled on `GlobalTimeline` (`feedback.rs:293-341`):
- `static TABLE: LazyLock<TimerBudgetTable>` with `DashMap<Vertex, ClassAccum>`. `ClassAccum`: saturating fixed-size histogram of per-(run,node) firing counts from *completed* runs (`[u32; 256]`, counts capped at 255 — a budget above the cap simply never damps, which is the conservative direction), plus `completed_runs: u64`, `total_firings: u64` (both outcomes; this is the >=200 sample floor), `exhausted_firings: u64` (diagnostic split the hypothesis asks to keep).
- Compile-time constants: `REFIRE_DAMP: f64 = 0.25`, `MIN_CLASS_FIRINGS: u64 = 200`, `BUDGET_QUANTILE = 0.90`.
- `merge_run(completed: bool, firings: &[(usize, Vertex, u32)])` — one histogram sample per (node,vertex) entry when `completed`; always adds into `total_firings`/`exhausted_firings`. Called at run end (3c). After merging, store the learned-class count into util_stats via a setter (3e).
- `snapshot() -> Arc<TimerBudgetSnap>` — `HashMap<Vertex, u32>` of budgets for classes past the floor. Budget = Laplace-smoothed p90: smallest `c` with `(runs_with_count<=c + 1) / (completed_runs + 2) >= 0.90`; class present only when `total_firings >= MIN_CLASS_FIRINGS` and `completed_runs >= 1`. Taken once per run — no locking in the scoring hot path, stable within a run.
- `decay(factor)` — scale histogram cells and totals, floor, drop empty classes (mirrors `GlobalTimeline::decay`, `feedback.rs:332`).
- `reset()` — clear, for session isolation.
- Register in `spur/spur-core/src/simulator.rs` (`mod timer_budget;`, near line 2-10; private-to-`simulator` visibility is enough — `core/scheduler.rs` reaches it as `crate::simulator::timer_budget` the same way it reaches `util_stats`).

**b) `spur/spur-core/src/simulator/core/state.rs`** — per-run counting and snapshot carriage:
- New fields on `State` (struct at line 548, near `timer_inert_streaks` line 588): `timer_firings: Vec<(usize, Vertex, u32)>` (per-(node, resume-vertex) firing counts this run; linear-scan Vec like `timer_inert_streaks`) and `pub timer_budget: Arc<TimerBudgetSnap>` (default empty = identity). Initialize in `State::new` (~line 690). `State` derives `Clone` (line 547) — `Arc` keeps the snapshot clone one word. Both fields are excluded from `signature()` (line 1075) and `Hash` (1146) automatically, since those enumerate fields manually; add a comment matching the existing "observation only, excluded from signature" style. **Note**: this one is *not* observation-only — it feeds scoring — so the comment must say "excluded from `signature()`: scheduling bias, not protocol state", matching how `bias`/`send_ledger` are documented.
- New helpers next to `timer_inert_streak` (line 714): `note_timer_refire(&mut self, node, pc)` (increment), `timer_refires(&self, node, pc) -> u32`, and `timer_resume_vertex(&self, channel) -> Option<Vertex>` reading `self.channels` front waiting reader as verified above (add a `ChannelMap::get` if only `get_mut` exists).

**c) `spur/spur-core/src/simulator/core/scheduler.rs`** — the two live sites:
- **Fire-time count** (unconditional, unlike the stats-gated probe): in the `Runnable::Timer` arm (line 997), inside the `Some((mut reader, lhs))` branch next to `reader.timer_entry = Some(reader.pc)` (line 1017): `state.note_timer_refire(reader.node.index, reader.pc)`; and, when the class is over budget at that moment, `util_stats::record_refire_over_budget()`.
- **Scoring-time damp** in `score_with_terms` (lines 110-132), after `blend(...)`: for `Runnable::Timer(t)`, resolve `state.timer_resume_vertex(t.channel)`; if the class has a learned budget in `state.timer_budget` and `state.timer_refires(t.node.index, v) >= budget`, multiply the score by `REFIRE_DAMP` (0.25 — bounded, never zero; Proportional additionally floors weights at 1e-9, line 605) and `util_stats::record_refire_damped()` (counter gated on `util_stats::enabled()` per the `record_timer_admission` pattern at line 2267 of util_stats.rs; the damping itself is unconditional). This automatically reaches Tournament (562/573), Proportional (602), the single-candidate path (504), `score_runnable` and every audit that wraps it — consistent scores everywhere.

**d) `spur/spur-core/src/simulator/path.rs`** — run boundary hooks in `exec_plan` (line 281):
- At entry, beside `util_stats::begin_run()` (line 299): `path_state.state.timer_budget = timer_budget::snapshot();`.
- At each of the three exits, beside the existing `record_termination` calls (lines 386, 420, 769) but *not* gated on stats: `timer_budget::merge_run(completed, &path_state.state.timer_firings)` where `completed` is true only for the `Completed` exit; **Deadlock runs are excluded from the completed distribution and contribute only to `total_firings`** (the outcome dichotomy in the hypothesis is Completed vs IterationsExhausted; deadlocks are neither — noted as an interpretation in section 8).

**e) `spur/spur-core/src/simulator/util_stats.rs`** — counters:
- New statics near the timer block (line 259-275): `TIMER_REFIRE_DAMPED`, `TIMER_REFIRE_OVER_BUDGET`, `TIMER_REFIRE_CLASSES_LEARNED` (gauge, `.store()` from `timer_budget::merge_run`).
- Add all three to the `set_enabled` reset list (line 289ff).
- Record fns beside `record_timer_admission` (line 2267): `record_refire_damped()`, `record_refire_over_budget()`, `set_refire_classes_learned(n)`.
- New `#[derive(Serialize)] pub struct TimerRefireBudgetStats { damped, classes_learned, over_budget_firings }`; field `pub timer_refire_budget: TimerRefireBudgetStats` in `UtilizationSnapshot` (line 2664-2690) and populate in `snapshot()` (line 2758). All three are integer leaves, so the chunk grader's `delta`/`add` (lines 2707/2736) pick them up with no reader changes.

**f) `spur/spur-core/src/simulator/explorer.rs` + `campaign.rs`** — session hygiene:
- `timer_budget::decay(self.decay_factor)` beside `F::decay` at `explorer.rs:2286-2287` (the only decay cadence in the tree; non-genetic paths never decay `GlobalTimeline` either, so parity holds).
- `timer_budget::reset()` beside each `util_stats::set_enabled(...)` session entry: `explorer.rs:1133, 1525, 1962, 2609` and `campaign.rs:834` — this is what makes the table *session*-global rather than process-global (matters for multi-session test binaries).

## 4. Config surface

**None.** Confirmed nothing forces one: the damp factor and floor are constants in `timer_budget.rs`; `ResolvedTerms`/`SteerTermStats`/`FeedbackConfig` are untouched; no serde structs change except the stats output. The mechanism replaces default behavior outright and is identity until a class passes the 200-firing floor.

## 5. Firing counter

`timer_refire_budget.damped` — one increment per selection-time score reduction applied in `score_with_terms`. **Fired** means `damped >= 50000` summed over an evaluation chunk (the chunked grader differences `UtilizationSnapshot` integer leaves, so the new leaves flow through `delta`/`add` unchanged).

## 6. Predicted observables (frozen)

- Primary rung: depth>=6 events per explore-second, sizePct +4% to +15%.
- `termination.all.iterations_exhausted / termination.all.runs` falls >= 3pp from ~72%.
- `timer_effects.inert_streak.long.fired` per run falls >= 25%.
- `timer_effects.all.acted` per run stays within 5%.

## 7. Risk flags

- **`core/exec.rs`: not touched.** The timer fire path lives entirely in `scheduler.rs` (the `Runnable::Timer` arm buffers/wakes via the channel; `exec` only runs the woken record). Checked: the only timer-adjacent line in exec.rs is `timer_entry: None` on fresh records (line 212), untouched.
- **`history.rs`: not touched.** No new `PersistableRun` columns; run rows (`explorer.rs:917`) unchanged.
- **Event accounting / linearizability recording: not touched.** `Operation`/`OpKind`, `record_operation`, and the porcupine-facing history path are untouched; `state.timer_firings` and `timer_budget` are excluded from `signature()`/`Hash`, so deduplication and replay hashing are unchanged.
- **Determinism / RNG**: `rng_stream_isolation` streams (`rng.rs:34-49`) are unperturbed — the damp consumes no RNG, and both selector arms consume the identical number of draws regardless of scores (Tournament: k `random_range`; Proportional: one `random()` per eligible). The table is read only through a per-run snapshot taken at `exec_plan` entry, so scores are stable within a run. Cross-run: which budgets a run sees depends on rayon completion order — exactly the nondeterminism `GlobalTimeline` novelty already has; no new class of nondeterminism.
- **Phase-of-budget degeneration**: the gate is `per-run per-node count >= per-class learned p90`, never a global step threshold; classes without 200 sampled firings are absent from the snapshot (strict identity), and classes with high completed-run counts learn a high budget.
- **Length confounding (kept as designed)**: exhausted runs run ~6000 steps vs much shorter completed runs, so completed-run p90s are low partly because completed runs are short, not because refiring causes exhaustion. Per the frozen hypothesis this is accepted; the place a per-run normalization COULD later go is the merge hook in `exec_plan` (section 3d), where `step`/`max_iterations` are in hand at each exit and counts could be scaled by steps-used before sampling. **Do not add now.**

## 8. Deviations / interpretations

- **DEVIATION (small, forced)**: the hypothesis cites `TimerRunStats` as holding per-(node,vertex) firing counts; it holds run totals only, and the existing per-key accounting is gated on `acted_fraction_enabled()`. A new unconditional per-run `timer_firings` table on `State` is added (3b), incremented at the fire site (3c). Rationale: behavior must not depend on the stats switch, and the fire site is the single place the woken reader (hence the class vertex) is in hand.
- **Interpretation**: the pending timer's class is read from its channel's front parked reader (`pop_waiting_reader` is FIFO, so this is exactly the record the firing would wake); a timer with no parked reader has no class and is never damped. This is the faithful signal the red-team asked to name — it is the actual resume vertex, not a proxy, so no operator review deviation is needed.
- **Interpretation**: Deadlock runs feed neither the completed histogram nor the "exhausted" split; they count toward the 200-firing floor only.
- **Interpretation**: one distribution sample per (node, vertex) per completed run (budget compares like-with-like against a per-node count); "firings of that class sampled" for the floor = total firings summed across nodes and outcomes.

## 9. Grading plan

- **Rungs**: depth>=6 events/explore-second is primary; watch depth>=4 and >=8 as neighbors. Expected **2-4 chunks** (the table needs completed-run mass before any class passes the 200-firing floor, so chunk 1 may be near-identity; `classes_learned` distinguishes "not yet learned" from "learned but inert").
- **utilStats reads per chunk**: `timer_refire_budget.damped` (fired at >=50000), `timer_refire_budget.classes_learned`, `timer_refire_budget.over_budget_firings`; independents: `termination.all.iterations_exhausted` vs `termination.all.runs`, `timer_effects.inert_streak.long.fired`, `timer_effects.all.acted`, `timer_effects.all.fired` (all already exported; per-run normalization via `termination.all.runs`).

## 10. Test plan

- `cargo test --manifest-path spur/Cargo.toml -p spur-core` — touched-code coverage:
  - `core/scheduler.rs` unit tests (mod at line 1464) exercise `select_within_queue`/scoring on constructed states; add one asserting a timer over budget scores 0.25x an identical under-budget timer and that a class absent from the snapshot is identity.
  - `tests/timer_effects.rs` — asserts per-run fired/acted parity against the run rows; our counting is parallel and unconditional, must not disturb it.
  - `tests/util_stats_export_completeness.rs` — **will fail to compile** until the new `timer_refire_budget` field is added to its constructed snapshot and leaf list (it verifies every leaf exports under its own name); `tests/stats_export_parity.rs` likewise checks the rendered snapshot.
  - `feedback.rs` tests document the merge/decay contract being mirrored.
- **Unit test for the budget table** (`#[cfg(test)]` in `timer_budget.rs`) should assert: identity (no budget) below the 200-firing floor even with many completed runs of a tiny class; after merging completed runs with a known count distribution, the budget equals the Laplace-smoothed p90; exhausted-only merges never create a budget; `decay` shrinks mass and eventually drops a class back to identity; `reset` empties the table; and the snapshot omits capped-out classes rather than damping them.

### Critical Files for Implementation

- /home/benaepli/Rust/turnpike/tmp/lite/base/spur/spur-core/src/simulator/core/scheduler.rs
- /home/benaepli/Rust/turnpike/tmp/lite/base/spur/spur-core/src/simulator/core/state.rs
- /home/benaepli/Rust/turnpike/tmp/lite/base/spur/spur-core/src/simulator/path.rs
- /home/benaepli/Rust/turnpike/tmp/lite/base/spur/spur-core/src/simulator/util_stats.rs
- /home/benaepli/Rust/turnpike/tmp/lite/base/spur/spur-core/src/simulator/timer_budget.rs (new; pattern source: /home/benaepli/Rust/turnpike/tmp/lite/base/spur/spur-core/src/simulator/feedback.rs)
