# request-wait: implementation report

Candidate `request-wait`, built on the merged baseline `12b758213355c983c8a5f156549eb74668874e34`
(spur submodule) in an isolated worktree. Two hypotheses, two independent salts, no config field,
`general_vr.json` unchanged, `exec.rs` and `history.rs` untouched.

## Files changed (spur submodule, `spur.patch` + `untracked/`)

New:
- `spur-core/src/simulator/request_wait.rs` - salt `REQWAITS`, `is_treated` (probes exempt),
  `DEFAULT_BOUND = 32`, `settled(&SendLedger)`, per-run `RunState` (enabled flag, masked-record table).
- `spur-core/src/simulator/op_shelter.rs` - salt `OPSHELTR`, `is_treated` (probes exempt),
  `BOUND_STEPS = 192`, `is_sheltered`, `Release {Response, Expiry, Dry}`, `Class {Ghost, SettledFresh}`,
  per-run `RunState` (held table keyed by record, per-op key lists, mark/release bookkeeping).
- `spur-core/tests/fixtures/opening.spur` - a fixture whose restart asks every peer and whose peers
  answer with a state-writing message; writes fan out to every peer.
- `spur-core/tests/treatment_halves.rs` - session tests over that fixture (see Tests).

Modified:
- `spur-core/src/simulator.rs` - registers the two modules.
- `spur-core/src/simulator/core/state.rs` - `SendLedger` gains `opening_peers: u64`,
  `opening_replied: u64`, `opening_end: Option<u32>`, `delivery_acted_since_restart: bool`;
  `net_enter` sets `opening_peers` for a current-incarnation send of a restarted node whose trigger is
  `HandlerTrigger::None`; `note_handler_entry` sets `opening_end = issued` at the first
  Timer/Delivery entry when unset; new `clear_opening`, `begin_opening`, `note_opening_entry`
  (returns steps-from-restart when the entry settles the node), `in_opening`, `release_sheltered`;
  `release_from_purgatory` counts a sheltered record's release with its reason; `State` gains
  `request_wait` and `shelter` run states.
- `spur-core/src/simulator/core/scheduler.rs` - `request_wait_masks` (the mask predicate),
  `treatment_prepass` (one pass over every queue on runs that need it: names the masked records,
  lifts the mask when nothing else is eligible, dry-releases sheltered records when nothing at all is
  eligible), the composed `is_ineligible` closure, `note_request_wait_take` (release classification
  at the network pick), delivery-site hooks (arrivals after bound, opening replies and settle,
  per-cell entry censuses), `crash_node` clears the opening, `recover_crashed_node` begins one.
- `spur-core/src/simulator/path.rs` - run start sets both enabled flags from the run id;
  `shelter_target` (the scan at a post-fault invocation); release at `ScheduleResult::ClientOp` and
  when the stall release settles the in-progress operations; `stall_clock_suspended` excludes
  sheltered rows and counts the steps where that mattered.
- `spur-core/src/simulator/run_variant.rs` - `REQUEST_WAITS_FOR_SETTLE = 1 << 29`,
  `OP_TARGET_SHELTER = 1 << 26`, `treatment_bits(run_id)` joined in `of` and `from_run_id`; tests.
- `spur-core/src/simulator/util_stats.rs` - `DeliveryBias::SHELTERED = 8`; `treatment_cell`;
  the `request_wait` and `shelter` blocks with record functions, reset in `set_enabled(true)`,
  exported in `UtilizationSnapshot`.
- `spur-core/tests/util_stats_export_completeness.rs` - the two blocks marked leaf by leaf.

Superproject (`super.patch`): only the two `VARIANT_BITS` renames in
`research/orchestrator/src/decide.ts` (`originAlternate` -> `opTargetShelter` on 67108864,
`pairOrderGhostOnly` -> `requestWaitsForSettle` on 536870912) plus the submodule pointer line.
No constant `1 << 29` or `1 << 26` existed in `run_variant.rs` before this change.

Config field: none.

## Mechanisms as built

### Request wait (bit `requestWaitsForSettle`, 1 << 29)

- `opening_peers`: set in `net_enter` when the record is remote, its origin has incarnation > 0, its
  origin's ledger trigger is `None`, and the record carries the origin's current incarnation.
- `opening_replied`: set at the delivery site after exec when a message entry at D from O's current
  incarnation wrote D's state and O's bit is in D's `opening_peers`. Both cleared in `crash_node`,
  `opening_peers` reset in `recover_crashed_node`.
- `settled(D) = opening_peers == 0 || 2 * popcount(replied & peers) > popcount(peers)`.
- Mask (treated runs only): `Runnable::Record` with origin != node, node index below the server
  count, incarnation(node) > 0, !settled(node), `current_step < last_restart_step + Q`,
  `client_anchor.caused_post_fault(causal_operation_id)`, and not `fault_crossing(origin, sent_at)`.
  Q is `state.ghost_release.bound` (the learned p75 ghost lag for the run's scope), 32 when None.
- Lift: `treatment_prepass` evaluates the base rule and the mask over the local queues, the timer
  queue (with the strict-timer gate) and the network queue before `QueueInfo` is built. If at
  least one record is masked and nothing at all is eligible with the mask, the mask is off for the
  step and `lift_steps` counts it.
- Counters (`request_wait`): `masked_offers` (record-steps masked), `records_masked` (distinct
  records per run, the firing counter), `arrivals_after_bound`, `released_settled`,
  `released_bound`, `released_lifted`, `lift_steps`, `hold_steps_sum`,
  `settle.{treated,untreated}.{settled, settle_steps_hist[64 cells of 4 steps, last open]}`,
  `cells.{treated,untreated}.{request_entries_at_restarted, request_entries_at_restarted_acted}`,
  and the same census under `crossed.{wait_on_shelter_on, wait_on_shelter_off, wait_off_shelter_on,
  wait_off_shelter_off}`.

### Shelter (bit `opTargetShelter`, 1 << 26)

- At `invoke_client_request` with `post_fault`, on a treated run, after the target is validated
  and before the client record is pushed: skip if the target is in its opening (restarted and no
  acted message entry since) or has `crash_pending > 0`; otherwise scan the network queue once for
  records to the target from another server that are (a) `fault_crossing` or (b) from a restarted
  origin's current incarnation with `send_ordinal >= opening_end` (unset `opening_end` means every
  current record is an opening send and is left alone). Each is removed with `take_network`,
  tagged `DeliveryBias::SHELTERED`, keyed on the op id, and moved with
  `delay_runnable(step + 192, record)`.
- Release: (1) at `ScheduleResult::ClientOp` for the op and when the stall release settles the
  in-progress ops, every sheltered record of the op gets `release_step = current step`;
  (2) in the pre-pass, when nothing is eligible in any queue under the base rule, every sheltered
  record is released the same way; (3) the 192-step bound. `release_from_purgatory` pushes the
  record back through `push_runnable`, so `net_enter` re-counts it; the reason is read from the
  mark set at (1)/(2), unmarked means expiry.
- Design constraint: `stall_clock_suspended` ignores sheltered purgatory rows;
  `shelter.stall_clock_steps_not_suspended` counts the steps where the purgatory held only
  sheltered rows and nothing else held the clock.
- Counters (`shelter`): `ops_examined`, `ops_sheltered` (firing counter), `records_ghost`,
  `records_settled_fresh`, `released_on_response`, `released_on_expiry`, `released_dry`,
  `hold_steps_sum`, `skipped_target_opening`, `skipped_target_crash_pending`,
  `stall_clock_steps_not_suspended`, `hazards.{ops_with_ghost, ops_with_settled_fresh, ops_with_both}`,
  `cells.{treated,untreated}.{sender_restarted_entries, sender_restarted_acted}` and the same
  census under `crossed.*`.

Both per-cell censuses are indexed by `treatment_cell(wait, shelter)` so each contrast can be
matched on the other bit.

## Decisions where the frozen text left room (report, not improvisation)

1. `opening_peers` counts only sends carrying the origin's current incarnation. A dead-incarnation
   record re-entering the queue (after a crash re-queue or a purgatory release) while the origin's
   trigger is still `None` was not sent by the restart segment and is not an opening send.
2. "Opening replies are never masked" holds through the causal id: a reply to a restart's request is
   built inside the handler of that request, which carries no client operation, so
   `caused_post_fault` is false. No exemption by origin membership in `opening_peers` was added,
   because that would exempt exactly the replication record the hypothesis wants to wait (its
   origin is one of the peers the restart addressed).
3. "Ghosts are never masked" is an explicit `fault_crossing` check (dead incarnation or downed
   sender), independent of the causal id.
4. `arrivals_after_bound` counts, on treated runs, request-caused message entries at an unsettled
   restarted server at or past `last_restart_step + Q` whose record was never masked in the run,
   so the applicability ratio's two classes are disjoint.
5. `masked_offers` is counted once per masked record per step (from the pre-pass), not once per
   closure evaluation; the closure is evaluated several times per step.
6. Release classification happens when the record is picked: lifted if the mask is lifted this step
   and the record would still be masked without the lift; else settled if the destination is
   settled; else bound. A masked record never picked before the run ends counts no release.
7. The shelter's dry release is evaluated in the scheduler's pre-pass (nothing eligible in any
   queue under the base rule) rather than from `path.rs` at the step's first line; it is the point
   in the step where eligibility is known, before the pick, and the released rows come back at the
   next step's `release_from_purgatory` as the hypothesis describes.
8. The hazards census of the chunk-1 gates (share of treated depth>=10 runs whose label-10
   operation was sheltered with both classes held) is exported only in aggregate
   (`hazards.ops_with_both` over `ops_sheltered`); the history is unchanged, so no per-run join to
   the DAG label is available from the export.

## Side effects to be aware of

- `delivery_effects.biased` now includes sheltered deliveries (the bias is non-empty).
- On treated runs (and on shelter runs with held rows) the base eligibility closure is evaluated
  once more per runnable in the pre-pass, so `victim_swap.victim_crashed_holds`, counted inside
  that closure, rises on those runs. Untreated runs evaluate nothing extra.
- Per-step cost: one scan of every queue on treated request-wait runs and on shelter runs while
  a record is held; a `Vec::contains` on a short list per record in the closure.

## Build, tests, smoke

- Build: `cargo build --release --manifest-path spur/Cargo.toml --bin spur` clean (`build.log`;
  the three warnings are pre-existing in `coverage.rs`).
- Tests: `RUST_MIN_STACK=33554432 cargo test --manifest-path spur/Cargo.toml -p spur-core`
  (`test.log`): 515 passed, 0 failed, 0 ignored, over the lib (468) and every integration binary.
  New tests: request_wait.rs (split, settle predicate, masked table), op_shelter.rs (split,
  release reasons), scheduler.rs (mask class by class, pre-pass masking and counting, lift, settle
  and bound releases, dry release with exact accounting, crash/restart opening bookkeeping),
  state.rs (opening peers/replies/settle/clear, opening end, ledger exactness and pending count
  through shelter, response release and expiry), path.rs (scan classes and exclusions, target
  skips, response release, stall-clock exclusion), run_variant.rs (bits agree with the modules,
  half shares, no probe, even crossed cells), treatment_halves.rs (each half fires on the fixture
  and is tagged; untreated runs never fire, count the untreated census, and give byte-identical
  event sequences across two sessions; no probe carries either bit), and the export completeness
  test extended with both blocks.
- Smoke (`smoke.log`, `smoke-utilization-blocks.json`, `smoke-runs-table.log`), 60 s wall budget,
  `general_vr.json`, VR.spur: `request_wait.records_masked`, `request_wait.released_settled`,
  `shelter.ops_sheltered`, `shelter.released_on_response` and
  `shelter.stall_clock_steps_not_suspended` are all nonzero. Runs table: wait bit on 0.502 and
  shelter bit on 0.498 of the non-probe runs, on no probe, four crossed cells populated
  (~28k runs each). Numbers discarded; two qualitative smoke reads worth knowing before chunk 1:
  on VR `released_bound` exceeded `released_settled` and `arrivals_after_bound` was far above
  `records_masked` (the settle histogram carries a heavy open last cell on both halves, so many
  restarted nodes never settle inside a run and every later request-caused entry at them counts
  as an arrival after the bound); and `released_on_expiry` exceeded `released_on_response`. The
  lift never fired on VR in the smoke. These are the shapes the frozen gates and falsifiers name;
  they are reported here, not acted on.

## Predicted effects (from the frozen records)

- Request wait: depth>=8 flat within [0.96, 1.04]; depth>=11 treated/untreated up, decided only
  by the pooled z-2.7 interval; gates: masked share >= 0.40 of masked plus arrivals after bound,
  treated acted ratio >= 1.3x untreated, released_settled >= released_bound.
- Shelter: depth>=8 in [0.93, 1.03]; depth>=11 in [1.25, 2.6]; gates: released_on_response /
  ops_sheltered >= 0.55, released_on_expiry / ops_sheltered <= 0.35, steps per run within
  [0.98, 1.02] after the stall-clock exclusion.

## Deviations from the hypotheses

None in mechanism. The items under "Decisions" are the points where the frozen text was silent
and a choice had to be made; item 8 is an export limitation the grader should know about.
