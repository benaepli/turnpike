# Candidate `plan-shape`: implementation report

Two plan-generation cells drawn from the workload seed under independent salts,
built as one binary. No config field; `scheduler_configs/loop/general_vr.json`
untouched (byte-identical to the main tree). Base: spur submodule at
`12b758213355c983c8a5f156549eb74668874e34` (merged baseline), superproject
seeded from `research/lite`.

## Cells and bits

| cell | module | bit | decide.ts row |
|---|---|---|---|
| `SurvivorTarget::{Stock, Survivor}` | `spur-core/src/simulator/survivor_target.rs` | `POST_FAULT_SURVIVOR_TARGET = 1 << 26` | 67108864 `postFaultSurvivorTarget` (was `originAlternate`) |
| `PostFaultShape::{Stock, WriteThenRead}` | `spur-core/src/simulator/post_fault_shape.rs` | `POST_FAULT_WRITE_THEN_READ = 1 << 29` | 536870912 `postFaultWriteThenRead` (was `pairOrderGhostOnly`) |

Both are `of_workload_seed(seed) = salted_phase(seed, SALT, 2) == 1` with their
own salts (`SURVIVOR_SALT`, `SHAPE_SALT`), independent of each other and of
`RecoverDeps` (module tests assert agreement at chance). Neither `1 << 26` nor
`1 << 29` existed in `run_variant.rs` before. `run_variant::plan_cell_bits(seed)`
joins the three plan-cell bits and `explorer::run_row` uses it in place of the
single recover-deps join, so replay and AOS children inherit their parent's
cells through the shared workload seed.

## Mechanisms (generator.rs, post-fault pass)

Survivor cell: after the stock post-fault pass, every client request with a
mandatory edge from a recover whose target is a server with a crash stub in the
plan is readdressed to a server drawn uniformly from the never-crashing servers,
in node-index order, from `SmallRng::seed_from_u64(splitmix(workload_seed ^
TARGET_SALT))`. The workload stream is untouched (stock fingerprints unchanged;
the survivor plan has the stock plan's node list and edge list). A plan that
crashes every server is left as it is and counted. Reservations here mean the
post-fault pass's recover-to-request edges, not the second pass's probabilistic
edges into a request.

Write-then-read cell: per recover, the stock shuffled candidate list is filtered
to write-like requests not path-connected with the recover; the first is
reserved (recover-to-write edge) unless taking it would leave no write-like
request without a direct recover edge (`last_free_write` fallback, stock choice)
or none is available (`no_write_available`, stock choice). Only when a write was
reserved by preference, one read not path-connected with that write gets the
edge write-to-read, preferring reads with no recover edge and not already pulled
behind another write. The stock loop then runs over the same shuffled list, so
`post_fault_client_ops` is honoured unchanged and the stock cell is
byte-identical (it draws exactly the same shuffles). The second pass and its
cycle guard see these edges. `PlanEngine` readiness needs no change: the read's
extra in-edge is completed when `path.rs` marks the write's plan event complete
on its client response (unchanged code).

## Counters (`util_stats.rs`, new `plan_shape` block)

- `plan_shape.survivor.{reserved_seen, reserved_retargeted, plans_without_survivor}`;
  firing counter `reserved_retargeted`.
- `plan_shape.write_read.{pairs_added, write_fallbacks.{no_write_available,
  last_free_write}, read_unavailable}`; firing counter `pairs_added`.
- Per-cell run-end census (one struct, all eleven fields on every cell):
  `runs, post_restart_invocations_at_survivor, post_restart_writes_at_survivor,
  post_restart_reads_at_survivor, acked_writes_at_survivor_after_two_restarts,
  acked_writes_with_stranded_records, reads_invoked_after_such_ack,
  post_restart_writes_invoked, post_restart_write_acks,
  reads_invoked_after_post_restart_write_ack,
  reads_outstanding_at_survivor_state_move_post_ack`, exported as
  `plan_shape.survivor.cell.{stock,survivor}` and
  `plan_shape.write_read.cell.{stock,write_then_read}` (each marginal over the
  other bit) and `plan_shape.crossed.{stock, survivor_only,
  write_then_read_only, both}` so every contrast can be matched on the other bit.
  Kept in a thread-local per-run struct beside `RunCrossingState`, folded at
  `record_run_termination` into the cell registered by
  `record_plan_shape_run` (called from `run_single_simulation`).
- Definitions: "restarted" = incarnation > 0; "two restarts" = at least two
  servers restarted. The responding server of a client operation is the server
  whose returned value last woke a reader on the client (new `State::wake_origin`,
  set in `Continuation::call` via `State::executing`, which `scheduler.rs` sets
  around each handler segment, and in the scheduler's remote channel-send
  delivery; cleared at each invocation). Stranded records: distinct
  `(origin, origin_incarnation)` pairs of server records addressed to the
  responder in `network_queue` for which `fault_crossing` holds.
  `reads_invoked_after_such_ack` follows a stranded ack (the counter it is
  listed after). `reads_outstanding_at_survivor_state_move_post_ack` counts a
  read once when a server that had acked a post-restart write at incarnation 0
  *before the read's invocation* takes an acting delivery from a restarted
  peer's current incarnation while the read is unanswered; the freshness of
  that delivery is a new `fresh` field on `ScheduleResult::RecordExecuted`
  (set in `scheduler.rs`; `exec.rs` and `history.rs` untouched).
- Everything resets under `set_enabled(true)`; `tests/util_stats_export_completeness.rs`
  destructures the new block.

## Files changed

spur (submodule): `spur-core/src/simulator.rs` (module registration),
`survivor_target.rs` (new), `post_fault_shape.rs` (new), `path/generator.rs`,
`run_variant.rs`, `explorer.rs`, `util_stats.rs`, `path.rs`,
`core/state.rs`, `core/scheduler.rs`, `tests/util_stats_export_completeness.rs`,
`tests/client_anchor_release.rs`. Superproject: only the two `decide.ts` renames
(plus the `-dirty` submodule line in `super.patch`).

## Build and tests

- `cargo build --release --manifest-path spur/Cargo.toml --bin spur`: exit 0
  (three pre-existing dead-code warnings in `coverage.rs`). See `build.log`.
- `RUST_MIN_STACK=33554432 cargo test --manifest-path spur/Cargo.toml -p spur-core`,
  foreground: every binary `ok`; summed over the 26 result lines
  **517 passed; 0 failed; 0 ignored** (lib: 473 passed). See `test.log`.
- New tests: cell functions of the seed, half shares, independence (both
  modules); plan-cell bits disjoint from id bits and each other, shares
  (run_variant); stock fingerprints unchanged with any seed field; survivor
  rewrite touches exactly the reserved crashing-target requests, same kind and
  key, survivors only, nothing when every server crashes, single-survivor draw;
  `prefer_write` (more/equal/fewer writes, last-free guard, already-reserved
  write) and `dependent_read` unit tests; plan-level write-then-read tests for
  3, 2 and 1 writes over 2 recovers (fewer: byte-identical to stock); read
  readiness only after the write completes (PlanEngine); second pass keeps
  the edges and stays acyclic; census fixture exercising every counter's
  condition and the marginals, plan-time counters, reset; export completeness.

## Smoke (60 s campaign on VR, numbers discarded)

124,992 runs. `plan_shape.survivor.reserved_retargeted = 64,977`
(`reserved_seen` 131,799; `plans_without_survivor` 6,147, about 9.8% of
survivor plans); `plan_shape.write_read.pairs_added = 122,091`
(`last_free_write` 15,231, `no_write_available` 0, `read_unavailable` 0).
Runs table: survivor bit on 0.4999 of runs, write-then-read on 0.5027, both on
0.2490 against 0.2513 if independent; among the 7,871 probes 0.503 / 0.495;
0 seeds whose runs disagree on plan bits; 46,691 replay-slot runs, 30,888 of
which share a seed with an earlier run, and 0 whose plan bits differ from the
first run of their seed. Every census counter is nonzero on every cell
(`smoke_utilization_plan_shape.json`).

## Predicted effects (frozen)

Survivor cell: depth>=10 per-run ratio in [1.4, 2.6], depth>=11 in [1.3, 2.6],
depth>=8 in [0.90, 1.06]; premise gate on
`acked_writes_with_stranded_records`, artifact rule on
`acked_writes_at_survivor_after_two_restarts` >= 1.15. Write-then-read cell:
depth>=10 in [1.15, 2.4], depth>=11 in [1.1, 2.4], depth>=8 in [0.85, 1.06],
guard depth>=1 in [0.97, 1.03]; supply `reads_invoked_after_post_restart_write_ack`
treated at or above 0.70 per run, `reads_outstanding_at_survivor_state_move_post_ack`
ratio in [2.0, 6.0].

## Deviations and notes

1. `GeneratorConfig` gained three fields, not one: `survivor_target`,
   `post_fault_shape`, and `workload_seed` (the target draw is seeded from the
   workload seed under a second salt as frozen, and the generator only
   receives the rng, so the seed itself has to reach it). Not a config field.
2. The frozen guard says the stock choice is made when taking the write would
   reserve the last free write; that stock choice can itself land on that
   write, so "every plan keeps at least one write outside the reservations" is
   the preference's property, not a plan-wide invariant. Implemented as frozen
   and counted (`last_free_write`).
3. "Reserved by a recover" is read as a direct recover-to-request edge from the
   post-fault pass (the parenthetical in the frozen text), for the survivor
   rewrite, the last-free-write guard and the read preference alike.
4. `ScheduleResult::RecordExecuted` gained a `fresh` field and `State` gained
   `executing` and `wake_origin` (scheduler.rs and state.rs; exec.rs and
   history.rs are untouched).
5. `tests/client_anchor_release.rs` now draws its run ids from workload seeds on
   the stock write-then-read cell (`requests_ready_at_a_restart`). Its
   assertions are unchanged; under the treated cell a pulled read can become
   ready inside the hold's 64-step expiry of the 600-step budget and be held at
   exit (observed: a reserved write answered at step 588 of 600), which the
   test's invariant "none may still be held when a run ends" does not describe.
   Survivor-cell plans remain in its population.
6. The paired hypothesis names the new counter both
   `reads_invoked_after_survivor_state_moved_post_ack` (description) and
   `reads_outstanding_at_survivor_state_move_post_ack` (prediction's
   `newCounter`); the latter is implemented.
