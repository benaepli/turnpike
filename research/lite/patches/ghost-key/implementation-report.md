# ghost-key: implementation report

Candidate `ghost-key`: three nested treatment bits inside the merged ghost
release cell (bit 16), built together on the merged baseline
`spur` commit `12b758213355c983c8a5f156549eb74668874e34` (checked out and
verified in the worktree). No config field; `scheduler_configs/loop/general_vr.json`
is unchanged (`git diff research/lite -- scheduler_configs/loop/general_vr.json` is empty).

## Files changed

Submodule (`spur.patch`, all under `spur/spur-core/`):

- `src/simulator/util_stats.rs` - `GhostReleaseBits`, payload variants on
  `GhostReleaseCell`, 17 counter columns (untreated + 8 x release-all + 8 x
  single), per-cell counters for the three mechanisms, the crossed and
  marginal export cells, the `defer_coin`, `phase` and `stranded` blocks,
  reset wiring.
- `src/simulator/ghost_release.rs` - three salts and coins, `bits(run_id)`,
  `cell_of` carries the bits, `RunState::{defer_exempt, early_on_ghost,
  stranded_key}`, `RunState.stranded_skipped_at`, tests.
- `src/simulator/run_variant.rs` - tags `GHOST_RELEASE_DEFER_EXEMPT = 1 << 30`,
  `GHOST_RELEASE_PHASE_EARLY_ON_GHOST = 1 << 29`,
  `GHOST_RELEASE_STRANDED_KEY = 1 << 26`, `GHOST_RELEASE_BITS`, emitted from
  the cell in `ghost_release_cell_bits`; tests. Confirmed before tagging that
  no `1 << 30`, `1 << 29` or `1 << 26` constant existed in the file.
- `src/simulator/crash_phase.rs` - `hold_read_on` takes
  `force_arm: Option<CrashPhaseArm>` and returns `Hold { held, drawn, ended }`;
  `hold()` still returns `bool`; tests.
- `src/simulator/core/state.rs` - `SendLedger.stranded_floor`,
  `SendLedger.stranded_end`, `State::note_stranded_segment`.
- `src/simulator/core/scheduler.rs` - the three mechanisms (below), the
  per-cell trigger counters, `crash_defer_mask` as a helper called from the
  same place in `schedule_runnable`, `ghost_read_node`, the delivery site
  passes `r.send_ordinal` into `note_ghost_release_entry`, tests.
- `tests/util_stats_export_completeness.rs` - every new field and block.

Superproject (`super.patch`): only the three `VARIANT_BITS` renames in
`research/orchestrator/src/decide.ts` (`restartAfterPeerSettle` ->
`ghostReleaseDeferExempt`, `pairOrderGhostOnly` ->
`ghostReleasePhaseEarlyOnGhost`, `originAlternate` ->
`ghostReleaseStrandedKey`) plus the submodule pointer line.

## Cells and tags

Each bit is a salted coin over the releasing runs (`ghost_release::bits`):
`DEFER_EXEMPT_SALT` "GHOSTDEF", `EARLY_ON_GHOST_SALT` "GHOSTEAR",
`STRANDED_KEY_SALT` "GHOSTSTR", all distinct from every other salt in the
session. `cell_of(placed, run_id)` now yields `ReleaseAll(bits)` or
`Single(bits)`, so the bits follow the same nesting as the single bit (never
without bit 16, never on a run-cap probe, follow the arm set on learner
runs). The counter column is `1 + bits.index()` on the release-all half and
`9 + bits.index()` on the single half.

## Mechanisms

Cell 1, defer-coin exemption (`crash_defer_mask`, scheduler.rs): the coin is
drawn on `Stream::FaultPriority` for every pending crash with
`in_flight != 1`, exactly as before, and `record_crash_timing_bias` still
counts it. When `released_mask` has the crash's node bit the read is counted
as `defer_coin_examined` on the run's cell and, when the coin says withhold
and the run is on the exempt half, the withhold is not applied and counted
as `defer_coin_exempted`. Nothing else changes.

Cell 2, early-on-ghost (`crash_hold_mask`, scheduler.rs): past the step
hold, when the run is on the early-on-ghost half, the crash's node bit is
in `released_mask`, and the crash's phase slot is still Pending or Waiting,
the fan-out is read on `ghost_node` (`ghost_read_node`; falls back to
`phase_read_node` when the ghost node is None, out of range or down) and
`hold_read_on` is called with `force_arm = Some(Early)`. In `crash_phase.rs`
the Pending slot draws on `Stream::CrashPhase` as before and
`record_crash_phase_arm(drawn)` counts the draw; the wait is then settled
against the forced arm, from that draw on, with the unchanged deadline
(`armed_at + WINDOW`, min the reserve). The gate on the slot state makes
unanchored runs byte-identical to the other half (an Off slot is never
read, no counter moves). Counted per cell as `phase_overridden` split by the
drawn arm (`stock_to_early`, `mid_to_early`, `early_read_on_ghost`) at the
draw, and `phase_released_on_condition` / `phase_expired` when the forced
wait ends.

Cell 3, stranded key: `crash_node` calls `state.note_stranded_segment(node)`
before `note_handler_entry(node, None)`, capturing `floor..issued` into
`stranded_floor..stranded_end` (empty for a silent segment; ordinals are
never reset). The delivery site captures `r.send_ordinal` before `exec`
consumes the record and passes it to `note_ghost_release_entry`. On the
stranded-key half, after the existing acted/origin/step checks and before
`release_all`/`release_one`, an entry whose ordinal is outside the origin's
range returns with the trigger armed, marks its destination in
`stranded_skipped_at`, and counts `stranded_skipped_entries`; an entry in
the range fires exactly as the parent and counts `stranded_fired`, split by
whether a skipped entry had already occurred at that peer since the trigger
was armed (`stranded_fired_first_entry` / `stranded_fired_later_entry`).
`arm_release_trigger` clears `stranded_skipped_at`. Expiry, the learner, the
single cell, the forced victim and the apply census are untouched.

## Counters and exports

`crash_place.ghost_release.cells.*` now carries, for every one of
`untreated, release_all, single, treated`, the eight crossed cells
`defer{d}_early{e}_stranded{s}` (release-all and single pooled) and the six
marginal halves `defer_on/off, early_on/off, stranded_on/off`, every
existing per-cell field plus `triggers_armed`, `triggers_fired`,
`triggers_expired`, `defer_coin_examined`, `defer_coin_exempted`,
`phase_overridden`, `phase_overridden_stock_to_early`,
`phase_overridden_mid_to_early`, `phase_overridden_early_read_on_ghost`,
`phase_released_on_condition`, `phase_expired`, `stranded_fired`,
`stranded_fired_first_entry`, `stranded_fired_later_entry`,
`stranded_skipped_entries`. The firing-counter paths
`crash_place.ghost_release.defer_coin.{examined,exempted}`,
`crash_place.ghost_release.phase.{overridden,stock_to_early,mid_to_early,early_read_on_ghost,released_on_condition,expired}`
and `crash_place.ghost_release.stranded.{fired,fired_first_entry,fired_later_entry,skipped_entries}`
read the acting half of each bit (`defer_on`, `early_on`, `stranded_on`), so
`exempted / examined` at the top level is the exempt half's own rate; the
other half's coin reads are in `cells.defer_off.defer_coin_examined`. All
counters reset with `set_enabled(true)`; the completeness test covers every
field on both export paths.

## Tests

Added: `a_released_crash_is_exempt_from_the_defer_coin_only_on_the_exempt_half`,
`a_released_crash_on_the_early_on_ghost_half_waits_for_the_early_phase_on_the_ghost_node`,
`the_stranded_key_fires_only_on_a_record_of_the_segment_the_crash_stranded`,
`a_nested_cell_counts_under_exactly_the_export_cells_that_contain_it`
(scheduler.rs); `a_forced_early_arm_keeps_the_draw_and_waits_for_the_early_phase`,
`a_forced_wait_keeps_the_deadline_and_overrides_a_waiting_arm` (crash_phase.rs);
`the_nested_bits_split_the_releasing_runs_in_half_each_and_cross_every_other_split`
(ghost_release.rs); nesting, probe and crossing assertions in run_variant.rs.
Existing tests were updated only for the new signatures (`hold_read_on`'s
`force_arm` argument and `Hold` return, `note_ghost_release_entry`'s ordinal,
`GhostReleaseCell::ReleaseAll(GhostReleaseBits::NONE)`); no assertion was
weakened. Each new test checks the untreated half against the merged
behaviour with twin states on the same seed and compares the stream
position afterwards.

`RUST_MIN_STACK=33554432 cargo test --manifest-path spur/Cargo.toml -p spur-core`
(`test.log`): lib `458 passed; 0 failed; 0 ignored`; every integration
target `0 failed` (campaign_allocation 4, client_anchor_release 2,
compiler_integration 1, config_override_effect 1, crash_census_landing 1,
crash_phase_anchor 2, fresh_first_dispatch 2, ghost_absorber_retarget 2,
map_iteration_identity 1, message_order_probe 1, pair_order_dispatch 3,
refinement_diagnostics 0, refinement_types 9, replay_prefix_fidelity 2,
run_cap_exit 1, stall_cap_exit 3, stats_export_parity 1,
steer_authority_wiring 1, steer_decision_site_reachability 1,
steer_terms_fire 1, steer_terms_identity 1, timer_effects 1,
util_stats_export_completeness 2, wall_budget 1, doctests 0); `TEST_EXIT=0`.
The release build (`build.log`) carries only the three pre-existing
dead-code warnings in `coverage.rs`, identical to the baseline build.

## Smoke run (numbers discarded, no measurement)

`explore -e campaign --config scheduler_configs/loop/general_vr.json --set campaign.wall_budget_sec=60`
on `bin/spur/VR.spur` (`smoke.log`, `smoke-utilization-blocks.json`,
`smoke-runs-table.txt`), 135,872 runs. The mechanisms fire:
`defer_coin.exempted` 26,853 of 53,859 examined on the exempt half (the
other half examined 63,082, exempted 0); `phase.overridden` 3,941
(1,306 stock, 1,379 mid, 1,256 early drawn; 3,713 released on condition,
228 expired; equal to `fired_crashes_applied_anchored` on that half, and
zero on the other half); `stranded.fired` 4,173 (3,756 first-entry, 417
later-entry) with 2,842 skipped entries, zero on the other half. Every one
of the eight crossed cells holds about an eighth of the release-bit runs
(7,433 to 7,727 runs each), and each bit crosses the single bit at about a
quarter. From the runs table: each bit is on 0.497 to 0.501 of the runs
carrying bit 16, on 0 runs without bit 16, on 0 run-cap probes, and all
sixteen (three bits x single) cells are populated.

One observation to hand to the grader rather than act on: in this smoke
the early-on-ghost half's anchored within-three share
(`fired_crashes_applied_within_3_anchored / fired_crashes_applied_anchored`)
read below the other half's, while `released_on_condition / overridden` read
about 0.94. A forced early wait on a ghost node whose reaction segment
issued no send stays withheld until that node's next segment issues one,
which is far from the acted entry; the frozen record sized that case by the
in-flight-at-apply bucket, which does not count a silent segment on a node
with older sends in flight. This is a smoke read, not a measurement.

Note on probes: the nested bits are never on run-cap probes (bit 2) and do
appear on timer-steer probes (bit 4) exactly where bit 16 does (the release
is drawn over the placed runs, and a timer-context probe is placed like any
other run), so the exemption is inherited from bit 16 as the record states.

## Deviations and choices to report

- `hold_read_on` returns a `Hold { held, drawn, ended }` struct instead of a
  bool so the scheduler can count the override by drawn arm and the outcome
  under the run's cell; `hold()` keeps its bool return.
- Under a forced arm a stock draw is not recorded as an immediate release
  (it does not release), and the slot carries the forced arm afterwards, so
  the crash-phase release and apply census count the crash under `early`
  while `crash_phase.stock.armed` still counts the draw. The record's "arm
  counters keep meaning" is read as the arm draw counters.
- The stranded key's "first entry" is defined as: no entry from the trigger's
  origin had been skipped at that peer since the trigger was armed.
- Per-cell `triggers_armed`, `triggers_fired`, `triggers_expired` were added
  beyond the listed per-cell fields so the frozen "fired over armed on this
  half" observable is computable from utilization alone.
- The defer loop moved verbatim into `crash_defer_mask`, called at the same
  point of `schedule_runnable`, so the exemption is testable in isolation.

## Latent flaw (merged single cell)

The ranking case in `release_one` still runs before `note_ghost_delivery`
writes the ghost node's mark, so on the single half it sees only an earlier
mark. None of the three cells reads that mark at firing time: cell 1 reads
`released_mask` after the firing; cell 2 reads `ghost_node`, which the
firing sets from the entry's destination (the ranking is consulted only as
the fallback when the ghost node is down); cell 3's key check precedes
`release_one`. The flaw therefore persists unchanged in the single half of
all eight crossed cells and biases none of the three nested contrasts.
Nothing in the single cell was changed.
