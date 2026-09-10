# stall-cap: implementation report

Hypothesis `quiet-gap-learned-stall-cap` (iteration 76), candidate `stall-cap`.
Base: spur submodule d051f696d461afb7498d0746c02d8dfca83ebc02 (merged baseline),
superproject seeded from `research/lite` (`scheduler_configs/loop`, `spur`,
`research/orchestrator/src/decide.ts`).

## Files changed

spur submodule (`spur.patch`, plus `untracked/` mirror):

- NEW `spur-core/src/simulator/stall_cap.rs` - the learner (run_cap's shape:
  one histogram per step budget, 256 cells, checkpoints at 200/400/800
  completed run-cap probes, cap = ceil(1.5 x p99 cell upper edge) clamped to
  the budget, None below the floor, decay and reset), the treated cell
  (salted phase of the run id under `STALL_CAP_SALT`, three of four phases
  treated, run-cap and timer-context probes exempt), the per-run `RunClock`
  (`Marks` per step, suspension, longest gap counting the open segment),
  `finish_run` (counters, untreated rows, probe feed), and the untreated
  per-run rows with a CSV renderer.
- `spur-core/src/simulator.rs` - registers the module.
- `spur-core/src/simulator/core/state.rs` - `ScheduleResult::RecordExecuted`
  gains `acted: bool, timer_entry: bool`; `ScheduleResult::TimerFired` gains
  `acted: bool`.
- `spur-core/src/simulator/core/scheduler.rs` - the node_state_token compare
  is taken at every Record entry (one u64 read before `exec`, one after;
  no allocation) and at every timer firing, regardless of
  `emit_acted_fraction`; the acted probes, the ghost mark and the
  overtaken-ghost reward now read that shared token instead of taking their
  own.
- `spur-core/src/simulator/path.rs` - `RunOutcome::StallCapReached { cap,
  step, outstanding_events }`; the clock in `exec_plan` (marks: non-timer
  history row, acted delivery, acted timer, engine release or held request
  issued; suspension: a queued planned crash withheld by its placement hold
  or phase wait, a non-empty client hold queue, or a non-empty purgatory);
  the stall exit on treated runs when `gap > cap` (guarded by
  `!engine.is_complete()` so a step that completes the plan is never cut);
  `stall_cap::finish_run` at every exit.
- `spur-core/src/simulator/explorer.rs` - end_reason `stall_cap_reached`
  with `steps_used = step`; `stall_cap::decay` beside `run_cap::decay`.
- `spur-core/src/simulator/campaign.rs` - `stall_cap::reset()` beside
  `run_cap::reset()` at session start.
- `spur-core/src/simulator/run_variant.rs` - `STALL_CAP = 1 << 10`, joined
  in `of` and `from_run_id` via `stall_cap_bits`; tests extended (share
  0.75 of runs outside both probe streams, never on a probe, agrees with
  `stall_cap::is_treated`).
- `spur-core/src/simulator/util_stats.rs` - `RunEnd::StallCapReached`
  folded into `termination` (`stall_cap_reached` in every tally),
  `prefix_extension` (a budget stop) and `quiet_stretch` (fifth row); the
  `stall_cap` block; `record_stall_cap_run`, `record_stall_cap_probe`,
  `set_stall_cap_learned`; reset with `set_enabled(true)`; tests.
- `spur-core/tests/util_stats_export_completeness.rs` - `stall_cap_reached`
  in the termination tally, the `stall_cap` block marked leaf by leaf and
  named in the block list.
- NEW `spur-core/tests/stall_cap_exit.rs` + NEW
  `spur-core/tests/fixtures/stall.spur` - end-to-end: a treated run is cut
  on exactly the first step whose gap exceeds a seeded cap of 15 (stop at
  step cap + 2, runs-table row `stall_cap_reached` with that steps_used,
  history flushed); an untreated run with the same gap runs to its budget
  and leaves its row (`gap 255, standing 15`) and the over-cap counter; a
  run-cap probe and a timer-context probe run to their budget and feed
  nothing.
- `spur-cli/src/main.rs` - writes `<output_dir>/stall_cap_runs.csv` beside
  `utilization.json` when rows were recorded.

Superproject (`super.patch`): only the `VARIANT_BITS` rename
`freshFirstDestCut -> stallCap` at bit 1024 in
`research/orchestrator/src/decide.ts`, plus the submodule pointer line.
`scheduler_configs/loop/general_vr.json` is unchanged (verified against
`research/lite`).

## Config field

None.

## Counters (block `stall_cap` in utilization.json)

`stops` (the firing counter), `treated_runs`, `untreated_runs`,
`steps_saved_sum` (frozen step cap minus stop step), `suspended_steps_sum`,
`marks.{rows,acted_deliveries,acted_timers,releases}`, `probes_keyed`,
`probe_over_cap_completions`, gauges `scopes_learned` and `cap_max_scope`,
and the separation-gate inputs `untreated_runs_capped` (untreated runs that
ended under a standing cap), `untreated_over_cap_runs`,
`untreated_gap_hist` (16 log2 buckets of the longest gap),
`untreated_rows_dropped`. `termination.*.stall_cap_reached` and
`quiet_stretch.stall_cap_reached` are the termination folds.

Separation gate, per-run side: the runs table lives in `history.rs`
(protected), so the two per-run columns could not be added there. Instead
every untreated non-probe run writes one row
`run_id,longest_quiet_gap,stall_cap_standing` (standing 0 while the scope is
below its floor) to `<output_dir>/stall_cap_runs.csv`, which the grader
joins to its depth by run id to read
`untreated_gap_over_cap.{depth6,depth8,depth10}` and
`untreated_runs_at.{depth6,depth8,depth10}`. Rows are capped at 1,000,000
per session (`untreated_rows_dropped` counts the excess) and are gated on
`stats`.

## Tests

`RUST_MIN_STACK=33554432 cargo test --manifest-path spur/Cargo.toml -p spur-core`:
474 passed, 0 failed, 0 ignored (432 unit + 42 integration across 25 test
binaries; see `test.log`). The two `unused import: Array` warnings in the
log are pre-existing (`wall_budget.rs`, `campaign_allocation.rs`).

## Smoke (45 s campaign, `general_vr.json` unchanged, numbers discarded)

Final binary, `smoke.log` and `smoke_utilization_blocks.json`:

- `stall_cap.stops` 28,808 of 70,056 treated runs; `termination.all.stall_cap_reached` 28,808 (of 99,712 runs: plan_complete 22,583, iterations_exhausted 34,885, learned_cap_reached 13,416, deadlock 20).
- `scopes_learned` 2, `cap_max_scope` 1,043 (first checkpoint only in 45 s; `probes_keyed` 956 = `run_cap.probe_completions` 956, `probe_over_cap_completions` 0).
- `steps_saved_sum` 33.9M against `steps_used_sum` 217.5M.
- Untreated quarter: 23,432 runs, 14,553 under a standing cap, 9,711 of those over it (this is over all depths; the depth split is the grader's join on `stall_cap_runs.csv`, 23,432 rows written).
- Runs table (read from an earlier smoke of the same build, before the probe-feed fix, which does not touch the tag): bit 1024 on 79,161 of 105,560 non-probe runs (0.750) and on 0 of 7,080 probe runs; every `stall_cap_reached` row carries the bit.

## Predicted effect

Treated runs that stall (the client redirect loops and inert timer
churn the rationale describes) end at cap + last-mark rather than at the
learned step cap or the budget, so treated steps per run fall while events
per run are preserved; the gain is runs per explore-second on the
cross-binary rung. The learner feed is exactly the run-cap probe stream, so
the step cap, placement and timer-context learners see the same samples as
today.

## Deviations from the hypothesis as written

1. `RunOutcome::StallCapReached` carries a third field, `step`, so the runs
   table's `steps_used` can record the steps the run actually ran (the
   description named only `cap` and `outstanding_events`; without `step`
   the row would have had to report the cap as its length).
2. Per-run columns in the runs table were not feasible without editing the
   protected `history.rs`; the per-run side file described above stands in
   for them, as the instructions allowed. Writing it needed a one-function
   hook in `spur-cli/src/main.rs` (the only place that knows the output
   directory after every explorer mode).
3. `untreated_runs_capped` was added beyond the listed counters: the gate's
   share needs a denominator of untreated runs that actually ran under a
   standing cap, which `untreated_runs` alone does not give.
4. The stall exit is additionally guarded by `!engine.is_complete()`, so a
   quiet step that happens to complete the plan (a matching deliver that
   wrote no state) ends as `plan_complete` on the next iteration rather than
   as a stall.
5. `cap_max_scope` read 1,043 in the 45 s smoke against the prediction's
   450-900 band for the 6000 budget; that is a first-checkpoint value at
   about 200 completed probes and is reported, not tuned.
