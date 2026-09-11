# plan-clock: implementation report

Hypothesis `plan-progress-clock-second-stall-cap` (research/lite/plans/iteration-78-admitted.json).
Baseline: spur submodule 98e9a9313b9e5c063ddc29b0756483c431ac54cd (stall cap + stall release), superproject seeded from research/lite.

## Files changed

Submodule `spur` (spur.patch, 1908 lines; plus `untracked/spur-core/tests/fixtures/stall_plan.spur`):

- `spur-core/src/simulator/stall_cap.rs`
  - `PLAN_CLOCK_SALT` (0x504C414E434C4F43) and `PLAN_CLOCK_PERIOD = 2`; `plan_clock_cell(run_id)` / `is_plan_clock_treated(run_id)` draw half of the stall cap's treated runs by a salt of their own (Exempt on untreated runs and probes). Pure function of the run id.
  - `Marks::plan_progress()` keeps only `row` and `release`; `PlanClock` wraps `RunClock` and feeds it the filtered marks, so acted deliveries and acted timers do not re-arm it (timer-firing rows are already excluded from `row` in path.rs).
  - Second learner table `PLAN_TABLE` with the same `ScopeAccum`, keyed by the configured budget; `merge_probe` and `merge_plan_probe` share `fold_probe` (same QUANTILE 0.99, HEADROOM 1.5, MIN_COMPLETED_SAMPLES 200, doubling checkpoints). `decay` and `reset` cover both tables; `publish_gauges` publishes both learners' gauges.
  - `RunClocks { cell, plan_cell, fine_cap, plan_cap, fine: RunClock, plan: PlanClock }`: `for_run(run_id, backup)` freezes both caps at run start; `step(marks, suspended)` feeds both clocks with the same suspended flag and returns `Some((StallClock, cap))` when the run's cells end it: fine clock over its cap on a treated run, else plan clock over its cap on a plan-clock run; a step where both exceed is the fine clock's. `release()` re-arms both.
  - `finish_run(&RunClocks, RunEnding)` reports both gaps and both standing caps, the stop and its clock, the run's steps and cells; a completed run-cap probe feeds both learners. The untreated CSV is unchanged.
- `spur-core/src/simulator/path.rs`: `exec_plan` holds one `RunClocks`; the stall exit is `if let Some((clock, cap)) = stall_clocks.step(marks, suspended) && !engine.is_complete()`. Release-cell handling is unchanged apart from `stall_clocks.release()`; the stop carries `StallCapStop { clock, steps_saved }`. Same `RunOutcome::StallCapReached` for both clocks (doc updated: `cap` is the cap of the clock that ended the run).
- `spur-core/src/simulator/run_variant.rs`: `PLAN_PROGRESS_CLOCK = 1 << 28` (confirmed absent before); `stall_cap_bits` ORs it in on `is_plan_clock_treated`; tests extended (agreement with the mechanism, share 0.5 of treated, implies STALL_CAP, never on a probe, crosses STALL_RELEASE at 0.5).
- `spur-core/src/simulator/util_stats.rs`: `PlanClockCell`, `StallClock`, `StallCapStop`; `StallCapRun` gains `plan_cell`, `release_cell`, `steps`, `completed`, `stop`, `longest_plan_gap`, `standing_plan_cap`. New block `stall_cap.plan_clock` (`PlanClockStats`): `stops`, `steps_saved_sum`, `probes_keyed`, `probe_over_cap_completions`, `scopes_learned`, `cap_max_scope`, `untreated_runs_capped`, `untreated_over_cap_runs`, and cells `release_plan_clock`, `release_no_plan_clock`, `cut_plan_clock`, `cut_no_plan_clock` each with `runs`, `plan_complete`, `steps_used_sum`. All counters reset with `set_enabled(true)`. `record_stall_cap_plan_probe`, `set_stall_cap_plan_learned`.
- `spur-core/tests/stall_cap_exit.rs`: `seed_cap` now seeds both learners to 15; existing tests additionally assert `plan_clock.stops` is unchanged when both clocks exceed on one step (fine clock wins). New: `a_plan_clock_run_is_cut_by_the_plan_clock_while_its_fine_clock_is_under_the_cap` (six runs across all four cells plus untreated and probe; plan-clock stop at cap+2 with fine clock never over; cell counters; variant bits; runs rows; history rows) and `a_released_plan_clock_run_releases_once_and_stops_at_its_second_plan_stall` (first plan stall releases, second ends at 2*cap+4).
- `spur-core/tests/fixtures/stall_plan.spur` (new): the stall fixture with a handler that writes state on every retry, so the fine clock keeps re-arming while the plan never advances.
- `spur-core/tests/util_stats_export_completeness.rs`: the `plan_clock` block and its four cells reach the flushed JSON.

Superproject (super.patch): only `research/orchestrator/src/decide.ts` row `268435456` renamed `clientProgressRelease` -> `planProgressClock`, plus the submodule pointer line. `scheduler_configs/loop/general_vr.json` untouched (identical to the main tree).

## Config field

None.

## Build and tests

- `cargo build --release --manifest-path spur/Cargo.toml --bin spur`: exit 0 (build.log; the three warnings are pre-existing dead-code notes in unrelated modules).
- `RUST_MIN_STACK=33554432 cargo test --manifest-path spur/Cargo.toml -p spur-core`: 485 passed, 0 failed, 0 ignored (test.log). Lib crate: 439 passed; `stall_cap_exit`: 5 passed (3 existing + 2 new).

## Smoke (60 s campaign, general_vr.json, wall budget via --set; numbers discarded)

From `smoke-utilization-blocks.json` and `bitcheck.log`:

- `stall_cap.plan_clock.stops = 1145`, `steps_saved_sum = 1405723`, `probes_keyed = 957`, `probe_over_cap_completions = 4`, `scopes_learned = 2`, `cap_max_scope = 3743` (fine `cap_max_scope = 899`; `run_cap.current_cap_max_scope = 6000`, identity after 3 recomputes in this short run).
- Identity: `stall_cap.stops (20016) + plan_clock.stops (1145) = termination.all.stall_cap_reached (21161)`.
- Four cells populated: release_plan_clock 16524 runs, release_no_plan_clock 16615, cut_plan_clock 16549, cut_no_plan_clock 16392.
- Runs table: bit 268435456 on 33073 of 66080 stall-cap-treated runs (share 0.500), 0 without bit 1024, 0 on a run-cap or timer-context probe.

## Predicted effect

Treated (plan-clock) runs whose nodes keep changing state while the plan does not advance end at the learned plan-quiet cap instead of the learned run cap or the budget, so steps per run fall on the plan-clock cells with depth-8 per run preserved (the frozen prediction's bands). The cut is read off `stall_cap.plan_clock.stops`; the learned plan cap per scope off `cap_max_scope`, with `probe_over_cap_completions / probes_keyed` as the fitness read. Learners are fed only by uncut probes, so the split changes no shared state.

## Deviations and choices to note

- `stall_cap.steps_saved_sum` now counts fine-clock stops only; a plan-clock stop's saved steps go under `plan_clock.steps_saved_sum` (the two partition the stall stops, as `stops` does). The hypothesis fixed this only for `stops`.
- A plan-clock stop uses the existing `RunOutcome::StallCapReached` and the runs-table end reason `stall_cap_reached`; `cap` in the outcome is the plan cap on a plan-clock stop. No distinct outcome was needed for the accounting.
- Two counters beyond the listed set: `plan_clock.untreated_runs_capped` and `plan_clock.untreated_over_cap_runs` (the untreated quarter's plan clock against the standing plan cap), so the plan cap's bite on never-cut runs is readable as the fine cap's is. The untreated CSV keeps its three columns.
- The hypothesis text labels the marks with letters that the source does not use; the plan clock's mark set is exactly `Marks::row` and `Marks::release`.
- Internal API: `stall_cap::finish_run` takes `&RunClocks` and a `RunEnding` carrying `steps`, `stop`, and `release_cell`; the old per-argument form is gone. No caller outside path.rs and the tests.
