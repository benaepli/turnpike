# Plan: `plan-engine-dense-status`

## 1. Hypothesis and declarations

**Hypothesis.** The plan engine keeps per-event status in a `HashMap<NodeIndex, EventStatus>` and re-derives the ready set by scanning that whole table on every step of `exec_plan`, then materializes the result through three successive `Vec`s, the last of which deep-clones a `PlannedEvent` (owned `String`s). Plan nodes are a dense `0..n` index range, so the map is the wrong data structure. Replace `statuses` with a `Vec<EventStatus>` indexed by `NodeIndex::index()`, maintain the ready set and the outstanding count incrementally, and hand the dispatch loop bare `NodeIndex` values instead of cloned events.

**Search declaration: `neutral`.**
The change does not alter what the explorer searches. Nothing about the set of events released, their order, or the RNG draws taken changes. See section 8 for the safety obligations and section 10 for the `--argument` text this declaration owes.

**Sharing declaration: `shared`.**
The judge confirmed `shared` and flagged it as the weakest `shared` of the candidate set - record that nuance. The scan cycles themselves are private to the run that takes them; only the allocator traffic (three `Vec` allocations per step plus a `String` malloc per released `Deliver`/`AllowTimer` event) and the reduced cache footprint of the status table travel between runs on a shared allocator and shared caches. Under the goal's rule that unsure is treated as shared, and because the within-binary contrast is invalid the moment any of the saving travels, this is graded as shared. The practical consequence is that the primary is a cross-binary wall reading, not a within-binary contrast (section 10).

## 2. The cost being removed, and where the profile shows it

Per step of the `for step in 0..effective_cap` loop in `spur/spur-core/src/simulator/path.rs`:

1. `path.rs:613` calls `engine.is_complete()` -> `plan.rs:147-149`.
2. `path.rs:654-657` calls `engine.get_ready_events()` -> `plan.rs:85-102`, which:
   - iterates the entire `HashMap` through `std::collections::hash::map::Iter`, filters to `Ready`, and collects a `Vec<NodeIndex>` (allocation 1);
   - `sort_unstable`s it;
   - re-`insert`s each ready index as `InProgress` - a SipHash write per ready event;
   - maps into a second `Vec<(NodeIndex, &PlannedEvent)>` (allocation 2).
3. `path.rs:654-657` then maps that into a third `Vec<(NodeIndex, PlannedEvent)>` (allocation 3), cloning each `PlannedEvent`. `DeliverSpec { function: String, .. }` (`plan.rs:25-29`) and `EventAction::AllowTimer(i32, String)` (`plan.rs:35`) carry owned `String`s, so every released deliver or timer event costs a heap allocation for its name plus the matching free.

Profile (`research/perf/profiles/12b7582.md`):

- `<Vec<NodeIndex> as SpecFromIterNested<..., PlanEngine::get_ready_events::{closure#0}/{closure#1}>>::from_iter` - **1.75% self**. This is allocation 1 and the full-table scan feeding it, and it is the only line in the profile attributable to this candidate by name.
- `spur_core::simulator::path::exec_plan::<...>` - **1.85% self**. `is_complete`, the `insert` loop, and the map-and-clone at `path.rs:654-657` are inlined into this.
- `<core::hash::sip::Hasher<Sip13Rounds>>::write` - **2.28%**, and `_int_malloc` 2.38% / `malloc` 1.54% / `cfree` 1.16%. Only a fraction of each belongs here. `exec_plan` alone holds seven other `HashMap`s and four `HashSet`s (`in_progress`, `pending_crash`, `pending_recover`, `victim_remap`, `pending_allow_timer`, `name_to_entry`, `entry_to_name`, `all_delivers`, `crashed_nodes`, `recovered_nodes`, `settled`, `completed_delivers`), and `schedule_runnable` at 10.63% dominates the allocator traffic. Do not size the expectation as if these lines were ours.

**Correction the implementer must carry (the hypothesis as proposed is partly wrong here).**
The claim that `is_complete()` scans every bucket is false. `plan.rs:147-149` is `self.statuses.values().all(|s| *s == Completed)`, which short-circuits at the first non-`Completed` entry. Mid-run, with many events still outstanding, it typically stops after one or two entries. Its cost is not zero - it is O(length of the Completed prefix in hash-iteration order), which grows toward the node count as the run nears completion - but it is bounded, unprofiled, and does not appear as its own symbol. The `is_complete` half of the claimed saving is largely fictional and must not be counted in the expectation. Replacing it with `remaining == 0` is a correctness-preserving simplification that comes free with the rest, not a source of gain.

Likewise `outstanding_count()` (`plan.rs:151-157`) does a full non-short-circuiting `filter().count()`, but it is called once per run (`path.rs:465`, `1173`, `1204`, `1226`), not per step. Zero saving; bookkeeping only.

**The real saving is:** the per-step full-table scan and its `Vec` (the 1.75% line), plus the two further per-step `Vec` allocations, plus the `PlannedEvent`/`String` clone on every step that releases an event, plus the SipHash writes on the `Ready -> InProgress` transitions.

## 3. Files and mechanisms to change

### 3.1 `spur/spur-core/src/simulator/path/plan.rs`

**Struct (`plan.rs:57-61`).**

```rust
#[derive(Debug, Clone)]
pub struct PlanEngine {
    graph: DiGraph<PlannedEvent, ()>,
    statuses: Vec<EventStatus>,
    ready: Vec<NodeIndex>,
    remaining: usize,
}
```

`statuses` is indexed by `idx.index()`. `ready` is a queue of indices whose status was `Ready` when they were pushed; it may hold stale entries and the drain filters on the authoritative `statuses` value (see below). `remaining` is the count of entries whose status is not `Completed`.

**`new` (`plan.rs:64-78`).** Build `statuses` by `node_indices()` in order (indices are dense and ascending, so a plain `Vec` push is index-correct); push every root (`neighbors_directed(idx, Incoming).count() == 0`) into `ready`; set `remaining = graph.node_count()`.

**`get_ready_events` (`plan.rs:85-102`) - signature moves.** Replace with:

```rust
pub fn take_ready_events(&mut self, out: &mut Vec<NodeIndex>) -> usize
```

- `out.clear()`.
- `let visited = self.ready.len();`
- Drain `self.ready` (`for idx in self.ready.drain(..)`) into `out`, keeping only entries whose `self.statuses[idx.index()] == EventStatus::Ready`. `drain(..)` empties the vector but retains its capacity, so no allocation after the first few steps.
- `out.sort_unstable();`
- For each `idx` in `out`, set `self.statuses[idx.index()] = EventStatus::InProgress`.
- Return `visited`.

The `visited` return is the counter input (section 5); it lets `plan.rs` stay free of a `util_stats` dependency. Keep the existing doc comment at `plan.rs:80-84` verbatim - it states the index-order constraint, which is still exactly the constraint that holds.

**`mark_event_completed` (`plan.rs:104-128`).**

- `let slot = &mut self.statuses[idx.index()];` - decrement `remaining` only if `*slot != EventStatus::Completed`, then set `Completed`. The guard makes `remaining` exactly equal to the old `outstanding_count()` even if a node is completed twice (section 8).
- The dependent loop keeps its shape: `neighbors_directed(idx, Outgoing)` collected into `children`, then for each child `all_deps_done = neighbors_directed(child, Incoming).all(|dep| self.statuses[dep.index()] == EventStatus::Completed)`. Replace the two `self.statuses.get(&..)` lookups with direct indexing.
- When `all_deps_done && self.statuses[child.index()] == EventStatus::Pending`, set `Ready`, push `child` onto `self.ready`, and push onto `released` as before. Return `released` unchanged.

**`is_complete` (`plan.rs:147-149`).** `self.remaining == 0`.

**`outstanding_count` (`plan.rs:151-157`).** `self.remaining`.

**`event` (`plan.rs:130-132`).** Unchanged.

**`mark_as_ready` (`plan.rs:134-145`) - delete it.** Confirmed by tree-wide grep that it has no callers anywhere in `spur/` (only its own definition matches). It is the third transition into `Ready` and would be a silent hole in the incremental `ready` queue. Deleting it is the right call rather than pushing to `ready` from it, because:

- Deleting it also makes `PlanError` (`plan.rs:8-15`) dead - it is referenced nowhere outside `plan.rs`, and its only two variants (`NotInProgress`, `EventNotFound`) exist solely for this function. Delete `PlanError` too, along with the now-unused `use thiserror::Error;` (`plan.rs:6`).
- Also remove `use std::collections::HashMap;` (`plan.rs:5`) once `statuses` is a `Vec`. Verify no other use of `HashMap` remains in the file.
- Per `research/STYLE.md` rule 6, leave no comment noting the removal.

If the implementer prefers to keep `mark_as_ready`, the only acceptable form is one that pushes to `self.ready` alongside setting `Ready`; leaving it as-is is not acceptable. Deleting is preferred.

### 3.2 `spur/spur-core/src/simulator/path.rs`

**Import (`path.rs:14-16`).** `PlannedEvent` is no longer needed in the `exec_plan` dispatch path; check whether it is still used elsewhere in the file before removing it from the import list (`all_delivers` uses `DeliverSpec`, `EventAction` is still used). Let the compiler decide.

**Buffer.** Declare one reusable buffer before the `for step in 0..effective_cap` loop (near `let mut engine = PlanEngine::new(plan);` at `path.rs:592`):

```rust
let mut ready_events: Vec<NodeIndex> = Vec::new();
```

Declaring it outside the loop is the point: it keeps the capacity across steps, so steady state does zero allocations for the ready set.

**Call site (`path.rs:653-657`).** Replace

```rust
let ready_events: Vec<(NodeIndex, PlannedEvent)> = engine
    .get_ready_events()
    .into_iter()
    .map(|(idx, e)| (idx, e.clone()))
    .collect();
```

with a call to `engine.take_ready_events(&mut ready_events)`, capturing the returned `usize` for the counter (section 5). The three `ready_events.is_empty()` reads at `path.rs:664`, `671`, `673` work unchanged on a `Vec<NodeIndex>`.

**Dispatch loop (`path.rs:739`).** Change

```rust
for (node_idx, event) in ready_events {
    match &event.action {
```

to

```rust
for &node_idx in &ready_events {
    match &engine.event(node_idx).action {
```

This borrows cleanly - the whole loop body (`path.rs:739-841`) contains no `&mut engine` call. Every mutation inside it targets `path_state`, `held`, `pending_crash`, `pending_recover`, `pending_allow_timer`, `pending_partition`, `pending_heal`, or `ready_delivers`. The `&mut engine` calls at `path.rs:926/945/977/990/1003/1040/1075` all sit after this loop closes. So an immutable borrow of `engine` for the match scrutinee is fine, and `ready_events` is a separate local. The `held.hold((node_idx, op_spec.clone()), step)` clone of the `ClientOpSpec` and the `label.clone()` in the `AllowTimer` arm stay as they are - only the whole-`PlannedEvent` clone goes away.

**Nothing else in `path.rs` changes.** `settle_in_progress` (`path.rs:389-418`) calls `engine.mark_event_completed(...)` and then `engine.event(child)` on the returned owned `Vec<NodeIndex>` - that continues to compile unchanged.

### 3.3 `spur/spur-core/src/simulator/util_stats.rs`

See section 5.

### 3.4 `spur/spur-core/tests/util_stats_export_completeness.rs`

Adding a field to `PlanDepsStats` breaks this test's compilation by design (it destructures the struct with no rest pattern). See section 5.5.

## 4. Config surface

**None.** The change adds no knob, no tunable, and no behavioral switch. No entry is added to `EXPLORER_CONFIG_KEYS` (`spur/spur-core/src/simulator/explorer.rs:362`). The two `check_top_level_keys(&config_json, &[EXPLORER_CONFIG_KEYS])` call sites (`explorer.rs:1220`, `explorer.rs:1623`) are untouched, and `scheduler_configs/loop/general_vr.json` is untouched.

## 5. The counter

Confirmed that `plan_deps` / `PlanDepsStats` exists at `spur/spur-core/src/simulator/util_stats.rs:1953-1960`, and that `status_entries_scanned` does not exist anywhere in the tree. It is genuinely new.

### 5.1 Fields

Add three `u64` fields to `PlanDepsStats`, inserted immediately after `recover_edges_dropped` and before `stock`:

```rust
pub struct PlanDepsStats {
    /// Probabilistic edges into a recover left out of exempt-cell plans.
    pub recover_edges_dropped: u64,
    /// Times a plan execution asked the engine for its ready events.
    pub ready_scans: u64,
    /// Status entries those requests looked at.
    pub status_entries_scanned: u64,
    /// Planned events summed over the runs that executed a plan.
    pub plan_nodes_sum: u64,
    pub stock: PlanDepsDensitySplit,
    pub exempt: PlanDepsDensitySplit,
}
```

`status_entries_scanned` alone is not interpretable: it needs a denominator (how many scans) and a scale (how many nodes a plan has). All three together make the evidence self-contained on the candidate side, which matters precisely because the counter cannot be read cross-binary (section 5.4). Widen the block's doc comment at `util_stats.rs:1951-1952` accordingly - plain words, no history, ASCII only, per `research/STYLE.md`.

### 5.2 Statics and reset

Follow the `PD_RECOVER_EDGES_DROPPED` convention exactly.

- Declare beside it at `util_stats.rs:365`:
  ```rust
  static PD_READY_SCANS: AtomicU64 = AtomicU64::new(0);
  static PD_STATUS_ENTRIES_SCANNED: AtomicU64 = AtomicU64::new(0);
  static PD_PLAN_NODES_SUM: AtomicU64 = AtomicU64::new(0);
  ```
- Add all three to the reset list that already contains `&PD_RECOVER_EDGES_DROPPED` at `util_stats.rs:777`.
- Read them in the `plan_deps:` block of the export at `util_stats.rs:6194-6204`, beside `recover_edges_dropped: PD_RECOVER_EDGES_DROPPED.load(Ordering::Relaxed)`.

### 5.3 Recorders

Beside `record_plan_deps_edges` (`util_stats.rs:1873-1880`), matching its shape including the `if !enabled() { return; }` guard and `#[inline]`:

```rust
/// One request for the plan's ready events looked at `visited` status
/// entries.
#[inline]
pub fn record_plan_ready_scan(visited: u64) { ... }

/// A run began executing a plan of `nodes` planned events.
pub fn record_plan_nodes(nodes: u64) { ... }
```

`record_plan_ready_scan` bumps `PD_READY_SCANS` by 1 and `PD_STATUS_ENTRIES_SCANNED` by `visited`, both `fetch_add(.., Ordering::Relaxed)`.

**Call sites, both in `path.rs`:**
- `record_plan_nodes(...)` once, right after `let mut engine = PlanEngine::new(plan);` (`path.rs:592`), using a new `pub fn node_count(&self) -> usize { self.graph.node_count() }` on `PlanEngine`.
- `record_plan_ready_scan(visited as u64)` immediately after the `take_ready_events` call at `path.rs:653-657`, using its return value.

Keep the hot path clean: the recorder is called once per step, not once per entry, and the `enabled()` check lives inside it. Do not add any call that consumes RNG, pushes history, or allocates.

### 5.4 What a per-run value means

`status_entries_scanned / ready_scans` is the mean number of status entries one ready-release looks at.

- On the old structure this quantity is exactly the plan's node count, every step, without exception: `plan.rs:85-91` iterates the whole `HashMap` unconditionally.
- On the candidate it is the number of entries sitting in the incremental `ready` queue at that step - normally 0, occasionally 1-3.

So the mechanism fired as claimed iff, on the candidate side:

```
status_entries_scanned / ready_scans  <<  plan_nodes_sum / runs
```

with the right-hand side being the node count the same runs would have scanned per step. A candidate-side value of `status_entries_scanned / ready_scans` that is close to `plan_nodes_sum / runs` means the incremental queue is not doing its job and the change did not do what it claims. A `ready_scans` per run that does not track the grader's own `stepsPerRun` for the campaign workload means the release site is not being reached once per step and something is wrong with the wiring.

`runs` is the `rows` the grader divides by, so all three read directly off `flatCounters` as `plan_deps.ready_scans`, `plan_deps.status_entries_scanned`, `plan_deps.plan_nodes_sum`.

### 5.5 The export-completeness test

`spur/spur-core/tests/util_stats_export_completeness.rs` reads the expected leaves by destructuring each block without a rest pattern, so a new field is a compile error until it is named. Three edits, all mechanical:

- `fn plan_deps(m: &mut Marks) -> PlanDepsStats` at line 240 - add `ready_scans: m.int(), status_entries_scanned: m.int(), plan_nodes_sum: m.int(),` in declaration order.
- `fn plan_deps_leaves(prefix, p)` at line 248 - add the three names to the destructuring pattern and push a `leaf(prefix, "<name>", *<name>)` for each, in the same order.
- No change is needed at lines 1903, 1944, 2040, 2043 or 2092 (`plan_deps` is already listed as a block).

## 6. The treatment bit

**None is available, and none is declared.**

`VARIANT_BITS` in `research/orchestrator/src/decide.ts` already names all 31 slots `2^0 .. 2^30`, and that file is off-limits to research iterations under `research/PERF_GOAL.md`'s harness boundary. There is no free bit to draw a treatment on.

This is consistent with the `shared` declaration regardless: `research/PERF_GOAL.md` states that for a shared saving the within-binary contrast is invalid, not merely weak, and `research/perf/grader.ts:279` refuses `--primary within-binary` outright when `sharing` is `shared`. So the absent bit costs this candidate nothing it could otherwise have had.

## 7. Predicted observables, and what must not move

**Must move (candidate side):**
- `plan_deps.status_entries_scanned / plan_deps.ready_scans` drops from the plan node count to a small number near zero (section 5.4).
- `plan_deps.ready_scans` appears at roughly one per step of every plan run.

**Should move, modestly:**
- Campaign runs per second up. Honest sizing: the only profile line attributable by name is 1.75%; the rest is a share of `exec_plan`'s 1.85% self and an unquantified slice of the malloc/free/sip lines that this candidate does not own outright. A total CPU removal of roughly 1.5-3% is the plausible range, and that is an upper bound on the wall gain, not a point estimate.
- Total process allocation count down by roughly three per step plus one per released `Deliver`/`AllowTimer` event.

**Must NOT move - any movement here is a bug, not a result:**
- `steps per run` on the campaign workload (the neutrality spread check reads it).
- Every end reason share (`PlanComplete`, `Deadlock`, `StallCapReached`, `LearnedCapReached`, `IterationsExhausted`).
- Every arm share.
- `planned_events_outstanding` in `RunTermination` (`path.rs:465`) and `outstanding_events` in `RunOutcome::IterationsExhausted` / `LearnedCapReached` / `StallCapReached`.
- The history a run produces: operation ids, client-node assignment, and the order of `Operation` rows. This is the linearizability record.
- Any RNG draw, in count or in order.

The cleanest single check available without new tooling: on a fixed session seed, the run rows the campaign writes should be identical before and after. `spur/spur-core/tests/replay_prefix_fidelity.rs` and `spur/spur-core/tests/map_iteration_identity.rs` are the in-tree expressions of exactly this property, and they must pass unchanged.

## 8. Risk flags

- Does it touch `spur-core/src/simulator/core/exec.rs`? No.
- `history.rs`? No.
- Event accounting? Yes - `outstanding_count()` changes implementation. See 8.4.
- The linearizability recording path? Yes, indirectly. See 8.1. This is why this candidate carries a nonzero cost and is not a free win.
- The run tagging the grader reads? Yes, indirectly, through the same path.

### 8.1 The release-order exposure

`plan.rs:80-84` states the constraint in-source: events are released in index order because the release order decides which operation gets which id and which client node, so a run is only a function of its seed when this order is fixed.

Concretely, the dispatch loop at `path.rs:739` drives, in release order:
- `invoke_client_request`, which increments `op_id_counter` and allocates a client node from `path_state.client_pool` - these become the `unique_id` and `client_id` on the `Operation` rows in `path_state.history`, which is the linearizability record and the run tagging the grader's `endReasons`/`armRuns`/`stepsPerRun` come off;
- `policy.sample(rng, RunnableCategory::{Crash,Recover,Partition,Heal})`, which consumes RNG draws in release order. A permuted release order permutes the RNG stream and changes the search - which would refute the `neutral` declaration outright.

### 8.2 What must be true for this to be safe

The candidate is safe iff, at every step, `take_ready_events` yields the same sequence of `NodeIndex` values the old `get_ready_events` yielded. Re-verified enumeration:

1. Both paths end in `sort_unstable()` on a `Vec<NodeIndex>`, and `NodeIndex: Ord` orders by the underlying index. So both produce strictly ascending index order. Order is therefore settled by the sort, and depends only on the set.
2. The sets are equal because the transitions into `Ready` are enumerable and finite:
   - `PlanEngine::new` (`plan.rs:64-78`) - mirrored: every root pushed to `ready`.
   - `mark_event_completed` (`plan.rs:118-124`) - mirrored: the push sits under the identical `all_deps_done && child is Pending` guard, so no node is ever pushed twice.
   - `mark_as_ready` (`plan.rs:134-145`) - removed (section 3.1). Confirmed zero callers tree-wide.
3. The only transition out of `Ready` is `get_ready_events` / `take_ready_events` itself, which removes each yielded index from the queue as it drains.
4. The drain filters on `statuses[idx.index()] == Ready` rather than trusting the queue. This makes the queue a tolerant superset and makes the yielded set exactly the set of `Ready`-status nodes, which is what the old filter computed - so any transition not enumerated degrades to yielding nothing extra, never to yielding something out of order.

### 8.3 The dense-index exposure

A `Vec` indexed by `NodeIndex::index()` is only correct if plan node indices are dense `0..n`. Verified:

- `ExecutionPlan = DiGraph<PlannedEvent, ()>` (`plan.rs:47`) - `petgraph::graph::DiGraph`, not `StableGraph`. A `DiGraph` only ever compacts indices on removal.
- `grep -rn "remove_node" --include=*.rs spur/` returns zero hits tree-wide. No node is ever removed.
- Both construction sites only `add_node`: `plan_config.rs:271-291` (`to_execution_plan`) and `generator.rs:132` (`generate_plan`). The third, `generator.rs:298-310` (`without_edges`), explicitly rebuilds the node set in order and documents that node indices carry over unchanged; it drops only edges.

So indices are dense and ascending. If a future change introduces `remove_node` on the plan graph, this `Vec` indexing silently breaks. That is a real (if currently inert) coupling the implementer should be aware of; do not add a defensive comment about it beyond what the code shows.

### 8.4 The outstanding-count exposure

`outstanding_count()` becomes `remaining`, which must equal `statuses.values().filter(|s| **s != Completed).count()` exactly, not approximately, because `spur/spur-core/tests/stall_cap_exit.rs` asserts exact values (`outstanding_events == 1` at line 318, `== 3` at line 533, and struct literals with `outstanding_events: 2` / `: 1` at lines 438/447). The guarded decrement in section 3.1 is what makes this exact: `exec_plan` can reach `mark_event_completed` for the same node more than once in principle - `settle_in_progress` (`path.rs:389-418`) completes in-progress plan nodes at a stall while leaving the operation itself in progress, and the `settled` set at `path.rs:1083-1097` exists precisely to stop a later real response from completing the same node a second time. The guard makes `remaining` correct whether or not that guard elsewhere holds.

### 8.5 Tests the implementer must keep green

`plan.rs` has no unit tests of its own - this code is covered only through integration. `cargo test -p spur-core` must pass, and these are the files that actually exercise the changed path:

- `spur/spur-core/tests/stall_cap_exit.rs` - the only direct assertions on `outstanding_count()`. Highest signal for this change.
- `spur/spur-core/tests/replay_prefix_fidelity.rs` - a replayed child must take the same events as its parent. Catches any release-order or RNG-order drift.
- `spur/spur-core/tests/map_iteration_identity.rs` - two sessions of one config at one seed must write the same schedule. Catches nondeterminism.
- `spur/spur-core/tests/util_stats_export_completeness.rs` - will not compile until the three new fields are named (section 5.5).
- `spur/spur-core/tests/client_anchor_release.rs`, `run_cap_exit.rs`, `pair_order_dispatch.rs`, `fresh_first_dispatch.rs`, `stats_export_parity.rs` - all drive `exec_plan` end to end.
- `spur/spur-core/src/simulator/path.rs` unit test `a_held_request_is_recorded_at_the_step_it_is_issued` - exercises the `held`/dispatch interaction at the edited loop.
- `spur/spur-core/src/simulator/path/generator.rs` unit tests (`a_stock_plan_is_the_baseline_plan_for_the_same_seed`, `exempt_drops_exactly_the_probabilistic_edges_into_a_recover`, `exempt_changes_nothing_at_zero_density`, `zero_reserves_no_client_work_after_a_restart`, `every_restart_gets_a_client_request_ordered_after_it`) - guard the graph shape the `Vec` indexing assumes.

## 9. Style

`research/STYLE.md` governs every line written. Specifically for this change: keep the existing `plan.rs:80-84` doc comment (it states a constraint the code cannot show); add no comment explaining that a `Vec` replaced a map, that a function was deleted, or that a clone was removed (rules 2 and 6); write the new `util_stats` doc comments as statements of what the counter holds, in plain words, ASCII only.

## 10. Grading plan

### 10.1 Instrument

The `shared` declaration makes the within-binary contrast invalid (`grader.ts:279` refuses it outright). The grader's default for `shared` is `--primary counter`, but that is unusable here: `counterReading` (`grader.ts:668-684`) reads the named counter on both sides, and the baseline side is the unpatched main-tree binary whose utilization dump has no `plan_deps.status_entries_scanned` key at all. It reads `NaN`, `presentOnBothSides` is false, and the per-round ratio is `NaN` on every round, so `primaryRatioOf` yields a `Ratio` with no reading.

**Therefore: `--primary cross-binary`.** Runs per second on the campaign workload, against the layout control.

Pass `--counter plan_deps.status_entries_scanned` anyway. Not passing it trips the blocker at `grader.ts:794` (a saving declared shared names no per-run counter). Passing it trips the blocker at `grader.ts:797` (missing from the utilization dump on at least one side). One blocker stands either way, and the second is the better one to stand under: it is a known structural artifact of introducing a new counter against an unpatched baseline, not a defect of the candidate, and it comes with real candidate-side evidence attached. Record that reading explicitly in the decision log: report the candidate-side `status_entries_scanned / ready_scans` against `plan_nodes_sum / runs` (section 5.4) as the mechanism-fired evidence, and state plainly that the blocker is structural.

Note that blockers do not change the computed verdict in `grader.ts:820-847` - they append to the reason and are for the decider. Do not treat the standing blocker as a refutation.

### 10.2 Frozen band

**`--band-min 1.02 --band-max 1.06`.** This is the candidate's own declared band, declared honestly at proposal time. Do not inflate it.

Be clear-eyed about what it means. The floor for a cross-binary primary is `max(layoutFloor, minEffect) = max(0.05, 0.01) = 0.05` (`research/perf/perf.json`, `grader.ts:772-775`). The band's lower edge, 1.02, is below that floor. So the entire lower half of the candidate's own honest prediction is a region where `separates()` (`grader.ts:504-506`) cannot fire no matter how clean the measurement. A true effect of 1.02-1.05 is invisible to this instrument by construction.

Add to that: `separates()` requires all three of `|mean - 1| >= 0.05`, a t-interval excluding 1, and `dominant` (every round's ratio on the same side of 1). The layout control on this host reads mean ~0.99 with per-round sd ~4.5%. At that spread and 3-6 rounds, `dominant` alone is a coin-flip for a sub-5% true effect.

Note also the band's downside: `bandReadingOf` returns "below" - a hard `refuted` verdict - when the t-interval's upper end falls under 1.02. With sd ~4.5% and few rounds the interval is wide, so an early `refuted` is unlikely; but it is a live possibility by round 5-6 if the true effect is genuinely near zero, and that is the band doing its job.

### 10.3 The `--argument` text the `neutral` declaration owes

`grader.ts:311-313` requires at least 20 characters; `grader.ts:790` re-checks it as a blocker. Draft:

> The plan engine releases ready events in ascending node-index order, and that order is what the search depends on: it fixes which client operation gets which id and which client node, and it fixes the order in which crash, recover, partition and heal dispatches draw from the RNG. This change does not touch that order. Both the old and the new release paths end in sort_unstable on a Vec<NodeIndex>, which orders by the underlying index, so the order is settled entirely by which set of indices is released. The two sets are equal: the only transitions into Ready are the constructor, which marks every root, and mark_event_completed, which marks a dependent whose predecessors are all complete. The new path pushes onto an incremental queue at exactly those two sites, under the identical guard, and the drain filters on the authoritative per-node status, so it can never yield an index the old full-table filter would not have yielded. The third transition, mark_as_ready, has no callers anywhere in the tree and is deleted rather than left as a hole. What is removed is the rescanning of the status table to rediscover a set the engine already knew, the two intermediate vectors that set was copied through, and the deep clone of each released event's owned strings. None of those was ever read by the search: the scan's only output was the set, the copies were byte-identical, and the clone was consumed as a borrow would have been. No RNG draw is added, removed, or reordered.

### 10.4 Expected rounds

Plan for the full 3-6 (`minRounds` 3, `maxRounds` 6 in `research/perf/perf.json`). Given 10.2, the honest expectation is:

- Most likely verdict: `no-gain` at round 6 - the primary does not clear the 0.05 floor, because the candidate's own band mostly sits under it.
- Possible: `gain`, if the true effect lands at the top of the band and the rounds happen to agree in direction.
- Possible: `refuted`, if the interval tightens below 1.02.
- A `no-gain` here is not evidence the mechanism failed. The counter (section 5.4) is what says whether the mechanism fired, and it is readable regardless of the wall verdict. Record both, separately, in the decision log.

### 10.5 If graded as part of a combined commit

There is a real possibility this is graded alongside `exec-node-env-in-place` in one commit rather than alone, because neither candidate's honest band clears the 0.05 cross-binary floor by itself while their sum plausibly does. What changes:

- The wall reading becomes uninterpretable per mechanism. A combined runs-per-second ratio cannot say which of the two mechanisms paid, or whether one paid and the other regressed and the sum happened to come out positive. The grader has no way to split it; there is no treatment bit (section 6) to split it with either.
- Therefore the counters must remain independently attributable. `plan_deps.status_entries_scanned`, `plan_deps.ready_scans` and `plan_deps.plan_nodes_sum` must count only this mechanism, and `exec-node-env-in-place` must name a counter of its own that counts only that one. Neither counter may be a shared aggregate over both changes, and neither may be incremented from a site the other change also touches. If `exec-node-env-in-place` also wants to add to `PlanDepsStats`, refuse - it belongs in its own block.
- Only one counter may be passed as `--counter`. The other must be read off the utilization dump by hand and written into the decision log. State in the log which counter was passed and which was read manually, so the reading can be reproduced.
- The band must be re-declared for the combined commit before any round is bought, as the sum of the two honest bands, not as this candidate's band reused. Freezing a band and then grading a different change against it is exactly the failure the goal file's freeze-it-there rule exists to prevent.
- The `--argument` must cover both mechanisms. The `neutral` declaration is made for the commit, not for a candidate; if either mechanism moves the search, the combined declaration is refuted.
- On a `regressed` or `refuted` combined verdict, neither mechanism is individually refuted. The correct follow-up is to split them and re-grade, not to close both.
