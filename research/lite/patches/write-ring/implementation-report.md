# write-ring: implementation report

Candidate `write-ring` implements the frozen hypotheses of
`research/lite/plans/iteration-83-admitted.json`:

- `write-region-replay-ring` (bit `WRITE_RING_SLOT = 1 << 26`, row 67108864
  renamed `writeRingSlot`)
- `write-ring-suffix-uniform-within-queue` (bit
  `WRITE_RING_UNIFORM_SUFFIX = 1 << 29`, row 536870912 renamed
  `writeRingUniformSuffix`)

Base: spur submodule `12b758213355c983c8a5f156549eb74668874e34` (merged
baseline), superproject seeded from `research/lite` for
`scheduler_configs/loop`, `spur` and `research/orchestrator/src/decide.ts`.
No config field. `general_vr.json` unchanged (the exported copy is
byte-identical to `scheduler_configs/loop/general_vr.json` on
`research/lite`).

## Files changed (spur submodule, `spur.patch`)

- `spur-core/src/simulator/replay_corpus.rs`: `WRITE_SALT`, `UNIFORM_SALT`;
  `is_write_slot(id) = is_slot && !is_prefix && salted_phase(id, WRITE_SALT, 2) == 1`;
  `is_uniform_suffix(id) = is_write_slot && salted_phase(id, UNIFORM_SALT, 2) == 1`;
  `Seed<C>` gains `parent_run_id: i64` and `arms: ArmSet`; new
  `WriteChild { parent_run_id, arms, cut_step, uniform_suffix }`. Slot test
  extended (write share of plan-only slots and uniform share of write slots
  in 0.47..0.53, none on probes, uniform implies write, write excludes
  prefix).
- `spur-core/src/simulator/run_variant.rs`: the two bits; `grid_arm_bits`
  joins them; tests extended for the bit shares and implications.
- `spur-core/src/simulator/core/state.rs`: `State` gains `write_cut:
  Option<ReplayCut>`, `write_cut_delivery: Option<WriteCutDelivery>`,
  `uniform_switched: bool` (all excluded from `signature()`, which hashes
  only nodes, queues, channels and links); new enum `WriteCutDelivery
  { Awaiting { target }, Seen { stale } }`; new predicate
  `State::write_signal(target, num_servers)` implementing (a)
  `incarnation_at(target) == 0 && send_ledger[target].crash_pending == 0`,
  (b) at least two of the first `num_servers` nodes with incarnation > 0,
  (c) `Runnable::Record` entries of the network queue addressed to the
  target from remote origins with `fault_crossing(origin,
  origin_incarnation)` true, from at least two distinct origins. Unit test:
  each condition necessary.
- `spur-core/src/simulator/path.rs`: `invoke_client_request` gains
  `num_servers` and reads the signal once per run (first invocation with
  `write_cut.is_none()` and the predicate true) before `schedule_client_op`
  draws the request's priority, setting `write_cut = Some(ReplayCut { step,
  tape_pos: rng.position() })`, `write_cut_delivery = Awaiting { target }`
  and bumping `replay.write_ring.signal_runs`. `exec_plan` gains
  `write_child: Option<&WriteChild>`; `draw_id = parent_run_id` for a write
  child (own id otherwise) is what `ghost_release::RunState::at_run_start`,
  `pair_order::is_census_run`, `run_cap::is_probe`,
  `timer_context::run_mode`, `stall_cap::cell` and `stall_release::cell`
  read; the run keeps its own id for rows and logs. The within-queue
  selector is now an owned per-run copy (`within_queue.clone()`, no draw);
  a uniform-suffix child replaces it with `WithinQueueSelector::Proportional
  { exponent: 0.0 }` at the first step where `write_cut.step == cut_step`,
  after that step's invocations and before its `schedule_runnable`, and
  sets `uniform_switched`. `RunOutcome::steps_used(max_iterations)` added
  and used by `run_row` and the ring counters.
- `spur-core/src/simulator/core/scheduler.rs`: at a message entry whose
  destination is the awaited target, records `Seen { stale:
  fault_crossing(origin, origin_incarnation) }` once.
- `spur-core/src/simulator/explorer.rs`: `run_single_simulation` gains
  `write_child: Option<&WriteChild>` (after `seed_tape`); a write child
  takes `Choice { arms: child.arms, learner: None }` instead of
  `arm_selector::choose`, skips `arm_selector::observe`, and its runs-table
  `variant` is `run_variant::of(parent_run_id, ...) |
  recover_deps_bits(seed) | attribution.variant_bits`. `RunResult` gains
  `write_cut`, `write_delivery`, `uniform_switched`, `arms`. `run_row`
  takes `draw_id`.
- `spur-core/src/simulator/campaign.rs`: `GridArm` gains `write_corpus:
  Corpus<SingleRunConfig>` (the same generic ring, CAPACITY 64,
  CHILDREN_PER_PARENT 8, built with the ghost ring in the arm each session
  constructs); `GridRun::WriteChild { seed, uniform }`; `assign` serves a
  write slot from `write_corpus.next_child()` and falls through to the ghost
  ring's plan-only child when empty (counted `slots_unfilled`); fresh runs
  admit to the ghost ring from `r.cut` and to the write ring from
  `r.write_cut` of the same `RunResult` (ghost-ring supply unchanged), with
  `parent_run_id = run_id` and `arms = r.arms`; a write child runs
  `run_single_simulation::<F, ReplayRng>` with the parent's tape, workload
  seed, config and `Some(&WriteChild {..})`, is never admitted, and is
  counted through `record_write_ring_child`; ghost-ring plan-only children
  outside the write slots are counted as the control. Unit tests for slot
  assignment and the ring's independence and capacity.
- `spur-core/src/simulator/util_stats.rs`: `ReplayStats.write_ring:
  WriteRingStats { signal_runs, parents_admitted, probe_parents_skipped,
  children, slots_unfilled, prefix_faithful, children_signal_fired,
  cut_step_sum, child_steps_sum, control_plan_only_steps_sum, write { runs,
  plan_complete }, control { runs, plan_complete }, uniform { switched,
  not_switched, first_post_cut_delivery_at_target { uniform { stale, fresh,
  total }, tournament { stale, fresh, total } } } }`; all reset by
  `set_enabled(true)`. Firing counters: `replay.write_ring.children`
  (ring), `replay.write_ring.uniform.switched` (cell).
- `spur-core/tests/util_stats_export_completeness.rs`: extended for the
  block.
- `spur-core/tests/write_ring.rs` (new, under `untracked/`): on the
  `ghost.spur` fixture, a parent that fires the signal; the cut precedes the
  request's priority draw (`tape_pos < tape.len()`, an `Invocation` row at
  the cut step); a child with other own-id bits replays the prefix under
  the parent's id: fires the signal at the parent's step and draw, same
  events to the cut (rows before the cut step plus that step's invocations,
  since the rest of the cut step is post-cut), runs-table variant equal to
  `from_run_id(parent)` and unequal to `from_run_id(child)`; the uniform
  child switches, with the cut at the same draw and the same prefix; a
  uniform child given an unreachable cut step never switches and is
  byte-identical (recording, all events, run row) to the tournament child;
  `signal_runs` counts exactly four per checked parent. A campaign session
  (4096 runs) checks every counter through `render_snapshot` (the CLI's
  rendering), the bit split on the runs table, and that `set_enabled(true)`
  zeroes the block.
- Ten existing test files: one `None,` argument added at their
  `run_single_simulation` call.

## Files changed (superproject, `super.patch`)

- `research/orchestrator/src/decide.ts`: the two `VARIANT_BITS` renames
  only.
- The `spur` submodule pointer line (dirty marker).

## Tests

`RUST_MIN_STACK=33554432 cargo test --manifest-path spur/Cargo.toml -p spur-core --no-fail-fast`
(`test.log`): 27 binaries, all `ok`; lib 454 passed; the integration
binaries sum to 46 passed; total 500 passed, 0 failed, 0 ignored. New or
extended tests:
`replay_corpus::slots_are_a_pure_function_of_the_id_and_spare_the_probes`,
the `run_variant` bit tests,
`state::ledger_tests::the_write_signal_needs_each_of_its_conditions`,
`campaign::tests::write_slots_take_write_children_and_fall_through_when_the_ring_is_empty`,
`campaign::tests::the_write_ring_is_its_own_ring`,
`write_ring::a_write_child_reproduces_the_signal_under_its_parents_draws`,
`write_ring::a_campaign_serves_write_slots_and_exports_the_rings_counters`,
`util_stats_export_completeness`. A first full-suite run had
`campaign_allocation::the_reward_decides_which_arm_halving_keeps` fail while
the release build was competing for the CPU (it is a 6-second wall-clock
halving comparison of two arms' run rates); it passed alone and in the
exported rerun.

Release build (`build.log`): three warnings, all pre-existing dead-code
warnings in `coverage.rs`.

## Smoke (numbers discarded; firing only)

`explore -e campaign --config scheduler_configs/loop/general_vr.json --set
campaign.wall_budget_sec=90` on `bin/spur/VR.spur` (`smoke.log`,
`smoke-utilization-replay.json`): `replay.write_ring.signal_runs` 15148,
`parents_admitted` 1413, `probe_parents_skipped` 90, `children` 11258,
`slots_unfilled` 8267, `prefix_faithful` 10908, `children_signal_fired`
11036, `cut_step_sum` 395012, `uniform.switched` 5439, `not_switched` 165,
first post-cut delivery at the target: uniform half stale 2958 / fresh 2544
/ total 5502, tournament half stale 1159 / fresh 4375 / total 5534; write
cell 11258 runs / 1943 plan complete, control cell 15789 / 2409. Runs table
(204992 rows): bit 1<<26 on 19525 of 39262 plan-only slots (0.497), bit
1<<29 on 9662 of the 19525 (0.495), never with REPLAY_PREFIX, never outside
a REPLAY_SLOT, never on a probe (12909 probe rows); the AOS arm carries
neither. Ghost ring: 19660 parents, 53679 children.

## Predicted effects

Per the frozen predictions: the treated half of the plan-only slots (bit
1<<26) replays write parents to the invocation and continues on its own
seed with inherited draws; depth 8-10 per run mechanical, depth>=11 the
honest read against the other plan-only half. The uniform cell (bit 1<<29
within 1<<26) should read a higher stale-first share at the target than the
tournament half (the smoke already shows 0.54 against 0.21) with rungs 8-10
unchanged.

## Deviations and judgment calls

1. Probe parents are not admitted to the write ring (counted
   `replay.write_ring.probe_parents_skipped`). The frozen text does not
   address probes; the iteration-28 inheritance it cites did not inherit
   from probe parents. A child taking every id-keyed draw under a probe
   parent's id would itself be a run-cap or steer-off probe and would feed
   the cap and timer learners with a replayed run, which the ring's own
   contract forbids. The ghost ring still admits those runs.
2. `write.runs` equals `children` by construction (both count write
   children that returned a result); `control.runs` counts ghost-ring
   plan-only children on the non-write half of the plan-only slots. The
   steps sums are over the same two populations. A write slot that fell
   through to a ghost plan-only child is in neither cell (it is in
   `slots_unfilled`).
3. The learners' observational rows (`stall_cap` untreated rows,
   `quiet_stretch` rows) keep the child's own run id, as the record says
   the child keeps its own DB id; the cells themselves are read under the
   parent's id.
4. `first_post_cut_delivery_at_target` counts message entries (a remote
   record entering a handler at the target), the same event class the ghost
   signal reads, and is recorded for every write child, split by half.
5. The uniform switch is evaluated after the step's client invocations and
   before the step's schedule, so the first schedule after the reproduced
   signal already runs uniform. Untreated runs clone the configured
   selector once per run; no draw is taken by the clone or the switch
   (verified by the byte-identical test).
6. The write signal also fires on ghost-ring children and on write children
   (counted in `signal_runs`, as the record's "once per run"); only fresh
   grid runs are admitted, so `signal_runs` bounds and does not equal
   `parents_admitted + probe_parents_skipped`.
7. Baseline `replay.*` counters other than `write_ring` are not in the
   `set_enabled` reset list on the merged tree; that was left as is.
