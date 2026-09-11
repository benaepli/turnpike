# restart-pull: implementation report

Candidate `restart-pull`, worktree cut from `main`, subject seeded from
`research/lite`, submodule at the merged baseline
`98e9a9313b9e5c063ddc29b0756483c431ac54cd`.

Hypotheses implemented (frozen record `research/lite/plans/iteration-79-admitted.json`):

- parent `restart-pulls-held-crash-into-learned-ghost-lag-window`,
  bit `restartPulledCrash = 1 << 4`
- nested `pulled-crash-released-at-first-acted-ghost-entry`,
  bit `ghostTriggeredCrash = 1 << 28`, set only with bit 16

No config field. `scheduler_configs/loop/general_vr.json` is unchanged
(copied here verbatim).

## Files changed

Submodule `spur` (`spur.patch`, plus `untracked/` mirror):

- `spur-core/src/simulator/restart_pull.rs` (new, untracked): the two
  salted coins and the cell they name, the per-scope ghost-lag learner
  (`lag_quantile`, `merge_probe_lag`, `decay`, `reset`, gauge publish),
  `RunState`, `Trigger`, and the pure pull arithmetic (`pulled_target`,
  `pull_holds`). Unit tests for the learner shape, the coins, the cells,
  the pull arithmetic and the gauges.
- `spur-core/src/simulator.rs`: module registration.
- `spur-core/src/simulator/core/state.rs`: `SendLedger.last_restart_step`
  (default -1); `State.restart_pull: restart_pull::RunState`.
- `spur-core/src/simulator/core/scheduler.rs`:
  - `recover_crashed_node` sets the ledger's `last_restart_step` and calls
    `pull_held_crashes` right after the incarnation bump;
  - `pull_held_crashes`: the pull on the pulling cells, target
    `s + (old mod (S + 1))` on the pull-only cell, `s + S` plus trigger arm
    on the trigger cell; identity below the learner floor; no random draw;
  - `note_restart_pull_entry` at the delivery site right after `acted` is
    computed: lag sampling (dead incarnation, origin live, destination live,
    destination != origin, feeding runs only) and the trigger firing
    (origin == armed node, dead incarnation, acted, step > restart step):
    every pulled crash's hold becomes `step + 1`, the trigger disarms;
  - `expire_trigger` at the top of `crash_hold_mask`: at `s + S` the trigger
    expires and the pulled crashes go at their `s + S` target;
  - `note_restart_pull_apply` at the crash apply site, before the ledger
    read: per-cell apply counters, `applied_within_window`, the fired-crash
    landing split by the retarget arm, and mask bookkeeping;
  - tests: the pull and the untreated/unplaced/below-floor twins with
    stream parity through `crash_hold_mask`; the phase slot after a pull;
    the trigger's arm/fire/expire/supersede rules and every non-firing
    entry kind; the lag sampling rules; the apply counters and the reset.
- `spur-core/src/simulator/path.rs`: `State.restart_pull` is set at run
  start from `RunState::at_run_start(run_id, max_iterations, arms.placed())`
  and the run's cell is named to `util_stats`; `record_termination` records
  per-cell `runs` and `steps_used_sum`.
- `spur-core/src/simulator/run_variant.rs`: `RESTART_PULLED_CRASH`,
  `GHOST_TRIGGERED_CRASH`, `restart_pull_bits` (id view, in `from_run_id`)
  and the arm-following join in `of`; tests for the halves, the probe
  exemption, nesting, and the learner-run behavior.
- `spur-core/src/simulator/util_stats.rs`: `RestartPullCell`, the
  `crash_place.restart_pull` block (`pulls`, `restarts_with_held_crash`,
  `steps_saved_sum`, `lag_samples`, gauges `lag_p90` and `scopes_engaged`,
  `cells.{untreated,pull_only,trigger,treated}` each with `runs`,
  `crashes_applied`, `later_crashes_applied`, `applied_within_window`,
  `steps_used_sum`, `early_armed`, `early_expired`,
  `early_inflight_bucket_{0,1,2,3plus}`; `trigger.{armed,fired,expired,
  superseded,steps_from_restart_sum,fired_crashes_applied_{retarget,stock},
  fired_crashes_on_ghost_node_{retarget,stock}}`), the record functions,
  reset membership in `set_enabled(true)`, and a thread-local run cell read
  by `record_crash_phase_arm/release/apply` for the per-cell Early split.
- `spur-core/src/simulator/explorer.rs`, `campaign.rs`:
  `restart_pull::reset()` beside every `fault_timing::reset()`.
- `spur-core/tests/util_stats_export_completeness.rs`: the new blocks are
  marked and checked leaf by leaf through both export paths.
- `spur-core/tests/replay_prefix_fidelity.rs`: the child id with the
  parent's bits is searched over every eligible id past the parent pool
  instead of a fixed pool of 400 (the tag now has three times as many bit
  combinations, so the fixed pool missed a parent's); the assertion is
  unchanged.

Superproject (`super.patch`): the two `VARIANT_BITS` renames in
`research/orchestrator/src/decide.ts` (`staleOrder` -> `restartPulledCrash`,
`clientProgressRelease` -> `ghostTriggeredCrash`) and the submodule pointer
line, nothing else. Confirmed before editing: no `1 << 4` or `1 << 28` tag
existed in `run_variant.rs`.

## Build and tests

- `cargo build --release --manifest-path spur/Cargo.toml --bin spur`: exit 0
  (`build.log`; the three warnings are pre-existing dead-code warnings in
  `coverage.rs`).
- `RUST_MIN_STACK=33554432 cargo test --manifest-path spur/Cargo.toml -p spur-core`
  (`test.log`), verbatim per binary:
  `447 passed; 0 failed` (lib), then `4, 2, 1, 1, 1, 2, 2, 2, 1, 1, 3, 0, 9,
  2, 1, 3, 1, 1, 1, 1, 1, 1, 2, 1, 0 passed; 0 failed` across the 25
  integration and doc-test binaries. Total 491 passed, 0 failed, 0 ignored.

## Smoke (60 s wall budget, `smoke.log`, `smoke-crash-blocks.json`, `smoke-bits.txt`)

Numbers are discarded per the instructions; they only confirm the
mechanism fires and the bits are laid out as required.

- `crash_place.restart_pull`: `pulls` 11063, `restarts_with_held_crash`
  28680, `steps_saved_sum` 1458064, `lag_samples` 6158, `lag_p90` 161,
  `scopes_engaged` 2; `trigger.armed` 5173, `fired` 2301, `expired` 2872,
  `superseded` 0.
- Bits over 140032 run rows: bit 16 on 62062 of 123546 placed runs (0.502),
  on no run-cap probe, and on no run without `CRASH_PLACED`; bit 268435456
  on 31081 runs, all carrying bit 16 (0.501 of them). The per-cell `runs`
  counters agree with the bit counts (treated 62062, trigger 31081). Bit 16
  is on 2246 timer-context probes, which are placed by inheritance exactly
  as the phase anchor is; the probe exemption the hypothesis names is the
  run-cap one.

## Deviations, choices and notes for the grader

1. The learner lives in `restart_pull.rs` as `restart_pull::lag_quantile`
   rather than `fault_timing::lag_quantile`; the hypothesis allows an
   equivalent accessor. Shape as `fault_timing`: 256 cells, 200-sample
   floor, doubling checkpoints, Laplace-smoothed quantile at the winning
   cell's upper edge, same decay and reset, stock run-cap probes only.
2. Cell width is one step (cells cover lags 0..255, the last cell absorbs
   everything past it), not `backup / 256` as the length learner uses:
   at a 6000-step budget that width is 23 steps and would fold the whole
   lag distribution into one or two cells. The window is bounded by 255
   and by the scope's budget. Note the smoke learned `lag_p90 = 161` on the
   widest scope, far above the ~20 steps the hypothesis expected; the
   window is therefore wide, which bears on the `applied_within_window`
   contrast the frozen observable expects (the smoke read 0.624 against
   0.530 on later crashes; discarded, but flagged).
3. Cell assignment follows the crash arm the run actually ran under
   (`arms.placed()`) at run start and in `run_variant::of`, with
   `from_run_id` keeping the id-only view - the convention `CRASH_PHASE`
   already uses. The arm selector can hand a placed id a stock crash arm;
   in a first smoke 3947 such runs carried bit 16 with no hold a restart
   could pull. After the change no run carries bit 16 without
   `CRASH_PLACED`. The coins themselves are the id's salted phases
   (`fault_timing::is_placed`-nested for the id view), so probes stay
   exempt by inheritance.
4. The trigger is armed only by a restart that pulled at least one crash,
   so `fired / armed` reads over occasions; the hypothesis wording ("a
   trigger is armed on p") does not say what an arming without a pull would
   wait for. A restart that pulls while a trigger is still armed replaces
   it (counted under `superseded`, zero in the smoke) and the earlier pulls
   stay in the pulled set, so a firing releases them too.
5. The trigger fires on an entry from any dead incarnation of the armed
   node and does not require that node to be live at firing; the lag
   sample does require the origin live, as the hypothesis states for the
   learner.
6. `applied_within_window` is counted on later crashes only (after each
   run's first), with `later_crashes_applied` exported as its denominator;
   "another node's most recent restart" excludes the crash's victim; the
   window is the run's `S` read at run start, so the untreated cell reads
   the same window as the treated one.
7. The per-cell Early counters come from a thread-local run cell inside
   `util_stats`, so `crash_phase.rs` is untouched. The per-cell Early
   apply-time histogram is not behind the crash-census switch (the config
   has it on anyway).
8. `restarts_with_held_crash` is counted on the pulling cells only, so
   `pulls / restarts_with_held_crash` reads the pull's own occasion rate.
9. `decay` exists for the lag learner exactly as for `fault_timing`, and
   like it has no production call site.
10. The two gauges are reset both by `util_stats::set_enabled(true)` and by
    `restart_pull::reset()`, as `run_cap`'s are.

## Predicted effect

As frozen: treated over untreated placed runs, co-bit matched on
`crashPhase` and `ghostAbsorberRetarget`, depth>=8 per run in [1.03, 1.30]
and depth>=9 in [1.08, 1.50]; the trigger cell over the pull-only cell
depth>=8 in [1.03, 1.25]. Firing counters `crash_place.restart_pull.pulls`
and `crash_place.restart_pull.trigger.fired`. Holds only shorten, so steps
per run treated should not exceed untreated. Because the learned window is
wider than the hypothesis assumed, the pull-only offset is uniform over a
longer stretch after the restart than the rationale pictured; the trigger
cell is the half that lands on the reaction regardless of the width.
