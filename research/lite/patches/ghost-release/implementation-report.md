# ghost-release: implementation report

Candidate `ghost-release`, worktree cut from `main`, subject seeded from
`research/lite`, submodule at the merged baseline
`98e9a9313b9e5c063ddc29b0756483c431ac54cd`. Started from the retained
`research/lite/patches/restart-pull` patch and transformed as the frozen
record `research/lite/plans/iteration-80-admitted.json` specifies.

Hypotheses implemented:

- parent `held-crash-released-at-first-acted-ghost-entry-after-restart`,
  bit `ghostReleasedCrash = 1 << 4` (`run_variant::GHOST_RELEASED_CRASH`)
- nested `ghost-release-of-one-crash-onto-the-absorber`,
  bit `ghostReleaseSingleOntoAbsorber = 1 << 28`
  (`run_variant::GHOST_RELEASE_SINGLE_ONTO_ABSORBER`), set only with bit 16

No config field. `scheduler_configs/loop/general_vr.json` is unchanged
(copied here verbatim; byte-identical to the retained patch's copy).

## Files changed

Submodule `spur` (`spur.patch`, plus `untracked/` mirror):

- `spur-core/src/simulator/ghost_release.rs` (new, untracked; the retained
  `restart_pull.rs` renamed and reworked): the two salted coins
  (`GHOSTREL`, `GHOSTONE`) and `cell_of`/`cell`; the per-scope ghost-lag
  learner (256 one-step cells, 200-sample floor, doubling checkpoints,
  decay, reset, fed by run-cap probes only) whose quantile is now a
  per-read argument - each checkpoint freezes the histogram and
  `lag_quantile(backup, q)` reads any quantile from the frozen copy, so a
  read is constant between checkpoints; `bound(backup)` is the p75
  (`BOUND_QUANTILE = 0.75`); `Trigger`; `RunState` (cell, bound,
  feeds_learner, scope, anchored, trigger, released_mask, ghost_node,
  forced_victim, crashes_applied, last_released_apply); the pure helpers
  `held`, `any_other_held`, `release`. `pulled_target` and `pull_holds` are
  gone. Unit tests for the coins and cells, the learner shape with the
  quantile argument, the last cell and budget bound, decay and reset, the
  three gauges, the run-start state, and the release helper.
- `spur-core/src/simulator.rs`: module registration.
- `spur-core/src/simulator/core/state.rs`: `SendLedger.last_restart_step`
  (default -1); `State.ghost_release: ghost_release::RunState`;
  `State.last_acted_ghost_step` (default -1).
- `spur-core/src/simulator/core/scheduler.rs`:
  - `recover_crashed_node` sets the ledger's `last_restart_step` and calls
    `arm_release_trigger` right after the incarnation bump: on a releasing
    cell, if any other node has `crash_pending > 0` and
    `crash_hold_until[n] > s`, a trigger `{origin p, restart_step s,
    expires s + Q}` is armed; a trigger still armed is replaced and counted
    under `superseded`; nothing moves; below the floor nothing is armed;
  - `note_ghost_release_entry` at the delivery site right after `acted` is
    computed: the lag sample (dead incarnation, origin live, destination
    live, destination != origin, feeding runs only) and the firing (origin
    == armed node, dead incarnation, destination live, `acted`, step >
    restart step). On the release-all cell every other node's held crash
    goes to `min(hold, step + 1)`; on the single cell `release_one` names
    one crash by the four cases; `ghost_node = v` and the trigger disarms;
    a firing that shortens no hold counts under `fired_nothing_held` and
    not under `fired`;
  - `release_all`, `release_one`, `forced_victim`;
  - `expire_release_trigger` at the top of `crash_hold_mask`: at `s + Q`
    the trigger disarms and every hold stays where it is;
  - the crash apply site: `forced_victim` runs before `retarget_crash`;
    then `note_ghost_release_apply` before the ledger read;
  - the delivery site sets `state.last_acted_ghost_step = entry_step`
    where `ghost` and `acted` are both true;
  - tests: arming at every restart with a held crash (including a target
    inside the bound), never on the untreated, unplaced or below-floor
    twins, superseding; every non-firing entry kind and the release of
    every other held crash at step + 1 with the restarted node's own hold
    and a passed hold left alone; `fired_nothing_held`; expiry at the bound
    with targets untouched; the untreated twin never releasing with stream
    parity through `crash_hold_mask`; the phase slot after a release; the
    four single-cell cases each releasing exactly the named crash (plus a
    ranking that keeps one crash where it is and passes to the next); the
    forced victim at the apply site; lag sampling; the apply counters and
    the reset.
- `spur-core/src/simulator/path.rs`: `State.ghost_release` set at run start
  from `RunState::at_run_start(run_id, max_iterations, arms.placed(),
  arms.crash == CrashArm::PlacedPhase)`; `record_termination` records
  per-cell `runs` and `steps_used_sum`.
- `spur-core/src/simulator/run_variant.rs`: `GHOST_RELEASED_CRASH`,
  `GHOST_RELEASE_SINGLE_ONTO_ABSORBER`, `ghost_release_bits` (id view, in
  `from_run_id`) and the arm-following join in `of`; tests for the halves,
  the probe exemption, nesting, and the learner-run behavior.
- `spur-core/src/simulator/util_stats.rs`: `GhostReleaseCell`,
  `LagGauges`, `GhostReleaseTrigger`, `SingleRelease`, `GhostReleaseApply`,
  the record functions, reset membership in `set_enabled(true)`, the
  `crash_place.ghost_release` block (`armed`, `fired`,
  `fired_nothing_held`, `expired`, `superseded`, `steps_from_restart_sum`,
  `released_crashes`, `restarts_with_held_crash`, `lag_samples`, gauges
  `lag_p50`, `lag_p75`, `lag_p90`, `scopes_engaged`;
  `cells.{untreated,release_all,single,treated}` each with `runs`,
  `steps_used_sum`, `crashes_applied`, `later_crashes_applied`,
  `applied_within_3_of_acted_ghost`, `fired_crashes_applied`,
  `fired_crashes_applied_within_3`, `fired_crashes_on_ghost_node`,
  `fired_crashes_applied_{anchored,unanchored}`,
  `fired_crashes_applied_within_3_{anchored,unanchored}`,
  `fired_crashes_applied_{retarget,stock}`,
  `fired_crashes_on_ghost_node_{retarget,stock}`,
  `fired_inflight_bucket_{0,1,2,3plus}`, `double_crash_after_release`;
  `single.{releases,released_own_crash,released_via_ranking,
  released_forced,no_release_case}` and
  `single.cells.{release_all,single}` with `runs`, `steps_used_sum`,
  `crashes_applied`, `fired_crashes_applied`,
  `fired_crashes_on_ghost_node`, `double_crash_after_release`);
  `VictimSwap::ForcedOntoAbsorber` and `victim_swap.forced_onto_absorber`.
  The retained thread-local run cell and the per-cell `early_*` split of
  the fan-out anchor are gone; `crash_phase.rs` and its record hooks are
  back to baseline.
- `spur-core/src/simulator/explorer.rs`, `campaign.rs`:
  `ghost_release::reset()` beside every `fault_timing::reset()`.
- `spur-core/tests/util_stats_export_completeness.rs`: the new blocks and
  the new victim-swap leaf are marked and checked leaf by leaf through
  both export paths.
- `spur-core/tests/replay_prefix_fidelity.rs`: the retained change (child
  ids searched over every eligible id past the parent pool), unchanged.

Superproject (`super.patch`): the two `VARIANT_BITS` renames in
`research/orchestrator/src/decide.ts` (`staleOrder` ->
`ghostReleasedCrash`, `clientProgressRelease` ->
`ghostReleaseSingleOntoAbsorber`) and the submodule pointer line, nothing
else.

## Build and tests

- `cargo build --release --manifest-path spur/Cargo.toml --bin spur`: exit 0
  (`build.log`; the three warnings are the pre-existing dead-code warnings
  in `coverage.rs`).
- `RUST_MIN_STACK=33554432 cargo test --manifest-path spur/Cargo.toml -p spur-core`
  (`test.log`), verbatim per binary:
  `451 passed; 0 failed` (lib), then `4, 2, 1, 1, 1, 2, 2, 2, 1, 1, 3, 0,
  9, 2, 1, 3, 1, 1, 1, 1, 1, 1, 2, 1, 0 passed; 0 failed` across the 25
  integration and doc-test binaries. Total 495 passed, 0 failed, 0
  ignored.

## Smoke (60 s wall budget, `smoke.log`, `smoke-crash-blocks.json`, `smoke-bits.txt`)

Numbers are discarded per the instructions; they only confirm the
mechanism fires and the bits are laid out as required.

- `crash_place.ghost_release`: `armed` 26397, `fired` 10756,
  `fired_nothing_held` 233, `expired` 13851, `superseded` 1550,
  `released_crashes` 11271, `restarts_with_held_crash` 26397,
  `lag_samples` 5850, `lag_p50` 31, `lag_p75` 77, `lag_p90` 161,
  `scopes_engaged` 2. `single.releases` 5522 (`released_own_crash` 3172,
  `released_via_ranking` 493, `released_forced` 1857), `no_release_case`
  238; `victim_swap.forced_onto_absorber` 1857. Cell `runs`: untreated
  58091, release_all 28953, single 29511, treated 58464.
- Bits over 131136 run rows (read with the main tree's
  `traceanalyzer/main -runs`): bit 16 on 58464 of 116555 placed runs
  (0.502), on no run-cap probe, and on no run without `CRASH_PLACED`; bit
  268435456 on 29511 runs, all carrying bit 16 (0.505 of them). The
  per-cell `runs` counters agree with the bit counts. Bit 16 is on 2075
  timer-context probes, which are placed by inheritance exactly as the
  phase anchor is; the exemption the hypothesis names is the run-cap one.

## Deviations, choices and notes for the grader

1. `restarts_with_held_crash` is counted on the releasing cells whenever a
   restart finds another node's crash held, including below the learner's
   floor; `armed` additionally needs the bound. In the smoke the two
   coincide because the floor is crossed within the first runs.
2. `fired` counts firings that shortened at least one hold and
   `released_crashes` the holds shortened; a hold already at `step + 1`
   or earlier is not shortened. On the single cell a named crash whose
   hold already sits at `step + 1` therefore disarms the trigger, counts
   under `fired_nothing_held`, counts no case and names no forced victim,
   so `single.releases == fired` and `released_crashes / fired == 1.0`
   hold exactly on that cell (a unit test covers it).
3. Single case (3) is implemented to the letter: `v` live (guaranteed by
   the hook), no held crash of its own (case 1 failed), and
   `!retarget.has_pending_pair(v)`. `pending_pair_mask` is only ever set
   on retarget runs, so on the stock stratum case (3) applies whenever no
   ranking reaches `v` - including when `v` has a queued crash of its own
   whose hold has already passed. The frozen text asks for no more; flag
   if a stricter `crash_pending[v] == 0` was intended. The same condition
   is re-checked at the apply site before the crash lands on `v`.
4. `release_one` never names the restarted node's own crash in any case,
   matching the parent's `n != p`.
5. The learner freezes its histogram at each checkpoint and reads any
   quantile from the frozen copy; `scopes_engaged` counts scopes past
   their first checkpoint; the three gauges read the widest engaged scope.
   `decay` keeps the frozen histogram (as the retained `current` was
   kept).
6. `applied_within_3_of_acted_ghost` is counted on later crashes only,
   with `later_crashes_applied` as its denominator (the first crash of a
   run can never follow a ghost); `fired_crashes_applied_within_3` is
   counted on every fired crash. "Within 3" is `step - last_acted_ghost_step
   <= 3`.
7. The crashPhase stratum is the run's crash arm (`CrashArm::PlacedPhase`),
   stored in `RunState.anchored` at run start, so it matches the
   `CRASH_PHASE` tag bit; the retarget stratum is `state.retarget.enabled`
   at the apply.
8. `double_crash_after_release`: after a released crash is applied its
   victim and step are kept; the next applied crash counts when it lands
   within 8 steps and that victim is still down; the record is consumed
   by the next apply either way.
9. The per-cell `early_*` fields of the retained export were not in the
   frozen counter list and were dropped along with the thread-local that
   fed them.
10. `single.cells.*` is a projection of the parent's `cells.*` (the same
    atomics read again), exported so both spellings in the frozen record
    resolve.
11. The firing does not require the restarted node to be live at the
    entry; the lag sample does, as the hypothesis states for the learner.
12. `forced_victim` records `VictimSwap::ForcedOntoAbsorber`, which also
    increments `victim_swap.applied` and `acted_absorber`; it is recorded
    on stock runs too, where the stock path records nothing.

## Predicted effect

As frozen: treated over untreated placed runs, co-bit matched on
`crashPhase` and `ghostAbsorberRetarget`, depth>=8 per run in [1.02,
1.20], depth>=9 in [1.08, 1.45], depth>=10 in [1.00, 1.50]; the single
cell over the release-all cell depth>=8 in [1.00, 1.15]. Firing counters
`crash_place.ghost_release.fired` and
`crash_place.ghost_release.single.releases`. Holds only shorten and
nothing is drawn, so steps per run treated should not exceed untreated.
The smoke's `fired / armed` of 0.41 sits inside the 0.30-0.45 the
prediction expects under the p75 bound; the learned p75 (77) is well
below the p90 (161).
