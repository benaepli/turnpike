# Perf Loop Hypothesis Pool

Scored candidates awaiting implementation, and the ones already settled. One
section per hypothesis: id, category, origin (proposer | operator-agent |
user), status (proposed | awaiting-approval | implemented | closed | merged |
human), the two declarations, and the frozen prediction.

## global-allocator-swap

- category: allocation | origin: operator-agent | status: closed
- declarations: search-neutral, shared saving
- title: Replace the system allocator with a faster one
- description: Link mimalloc or jemalloc as the global allocator, on the
  argument that the explorer's cost is dominated by allocation traffic.
- why closed: measured and refuted before this loop existed. mimalloc under
  LD_PRELOAD read about 8 percent slower than glibc, ABBA over 30,000 runs.
  The bytes moved are the cost, not the allocator servicing them, so the
  lever is the representation that allocates.
- what would reopen it: that measurement was taken on the fixed single-config
  workload at 14 threads, not on the campaign workload at the thread count
  this loop grades. A hypothesis arguing that the allocator's arena behavior
  differs under the campaign's parallelism may re-test it, and owes the
  layout floor like any other global change.

## exec-node-env-in-place

- category: allocation | origin: proposer | status: awaiting-approval
- declarations: search-neutral, shared saving
- judge: expectedGain 7, expectedCost 2 (touches core/exec.rs), net 5
- plan: research/perf/plans/exec-node-env-in-place.md
- title: Take the node env out of its slot instead of cloning it
- description: exec.rs:564 and exec.rs:87 clone the whole role-slot array
  per executed segment. state.nodes[i] keeps its handle, so the EcoVec
  refcount is 2 and the segment's first Env::set faults make_unique: one
  malloc, one memmove, 21 Value clones on VR's Node role, then a full
  drop_glue walk when the exit-path writeback drops the old buffer. Replace
  the clone with Env::detach, which moves the slots out and preserves sig
  and writes verbatim, so the refcount stays 1 and make_mut is a no-op.
- counters: env_traffic.node_slot_copies (predicted above 0, of the order
  of the segments a run executes), env_traffic.node_slot_writes (predicted
  at or above node_slot_copies, ratio 1.5 to 6),
  env_traffic.recv_node_slot_stores (predicted exactly 0).
- band: [1.05, 1.14] on cross-binary runs per second. Frozen at proposal.
  The planning pass proposed relaxing it to [1.00, 1.10]; the operator
  declined, because a band containing 1.0 predicts nothing and a prediction
  is graded rather than made easier to pass.
- treatment bit: none available. VARIANT_BITS names all 31 slots and
  decide.ts is off-limits; a shared saving could not use the within-binary
  contrast in any case.
- falsifier: the rps interval lies entirely below 1.05; or the neutrality
  spread check reads outside the baseline's own spread on steps per run,
  end reasons or per-arm counts; or node_slot_copies reads 0 (the mechanism
  never fired); or recv_node_slot_stores reads above 0 on any round, which
  refutes the neutral declaration and closes the candidate.
- verified at judging: the aliasing argument at exec.rs:654-658 holds -
  push_waiting_reader has exactly one call site, so the re-read node is
  provably record.node. Preserving Env::writes is load-bearing rather than
  cosmetic: it feeds node_state_token, the weighted stale_late term and the
  acted flag, all search-visible.
- disclosed behavior change: a Recv whose lhs is a role-scope slot has its
  store silently clobbered today and lands after the change. No such site
  exists in bin/spur/VR.spur, so the prediction is that it never fires; the
  third counter measures that rather than asserting it.

## plan-engine-dense-status

- category: data layout | origin: proposer | status: awaiting-approval
- declarations: search-neutral, shared saving
- judge: expectedGain 5, expectedCost 2 (release order decides operation
  ids and client-node assignment, which is the linearizability record), net 3
- plan: research/perf/plans/plan-engine-dense-status.md
- title: A dense Vec for the plan engine's status table
- description: PlanEngine::statuses is a std HashMap over a dense 0..n
  NodeIndex range, rescanned every step of exec_plan to rediscover a ready
  set the engine already knew, then copied through three vectors the last of
  which deep-clones a PlannedEvent and its owned strings. Replace with a Vec
  indexed by NodeIndex::index(), an incrementally maintained ready queue and
  a remaining count, and hand the dispatch loop bare indices.
- counters: plan_deps.status_entries_scanned, plan_deps.ready_scans,
  plan_deps.plan_nodes_sum. The mechanism fired iff
  status_entries_scanned / ready_scans is far below plan_nodes_sum / runs.
- band: [1.02, 1.06] on cross-binary runs per second, declared honestly at
  proposal and deliberately not inflated. Its lower edge is below the 0.05
  cross-binary floor, so a true effect in the lower half of this band is
  invisible to this instrument by construction.
- treatment bit: none available, same reason as above.
- falsifier: the rps interval lies entirely below 1.02; or the neutrality
  spread check reads outside the baseline's own spread; or
  status_entries_scanned per ready scan does not fall.
- verified at judging: the release order is provably unchanged - both paths
  end in sort_unstable on Vec<NodeIndex>, and the ready sets are equal
  because the transitions into Ready are enumerable. One correction carried
  into the plan: is_complete() short-circuits rather than scanning every
  bucket, so that half of the claimed saving is largely fictional. One gap
  found and closed: mark_as_ready is a third transition into Ready, has no
  callers tree-wide, and is deleted rather than left as a hole.

## per-step-scratch-buffers

- category: allocation | origin: proposer | status: proposed
- declarations: search-neutral, shared saving
- judge: expectedGain 4, expectedCost 2 (touches core/exec.rs), net 2
- title: Reuse the scheduler's per-step vectors and the per-call argument vector
- description: Hang the scheduler's local_queue_sizes, eligible and
  crashed_victims buffers off State so they keep capacity across steps, take
  link_deliver_seq by borrow rather than by handle clone, and pool the
  per-interpreted-call argument Vec that make_local_env drains.
- why it stayed in the pool rather than being built: the judge found the
  count inflated - crashed_victims takes the non-allocating branch on this
  config, the imbl handle clone is not a heap allocation, and only one of
  the three eligible sites fires per step, so it is two mallocs per step and
  not four. The closed global-allocator-swap entry already records that
  allocator servicing is not the lever on this workload; the bytes moved
  are. Declared band [1.02, 1.07], below the cross-binary floor.
- what would advance it: a reading that shows the per-call argument vector,
  rather than the scheduler buffers, is where the traffic is. That half was
  not disputed and is the part with a real per-call frequency.

## step-novelty-memo

- category: redundant work per step | origin: proposer | status: closed
- declarations: would have been search-neutral, shared saving
- judge: expectedGain 1, expectedCost 0
- title: Memoize runnable_novelty across the repeated scorings of one step
- description: Proposed on the reading that novelty is recomputed 20 to 35
  times per step over a handful of distinct candidates, each evaluation a
  fan of SipHash probes into a session-wide tuple map.
- why closed: the premise is refuted by the graded config.
  scheduler_configs/loop/general_vr.json sets feedback.novelty_enabled
  false; FeedbackConfig::key_granularity (feedback.rs:184-190) folds that to
  Constant; timeline_steer_bias (feedback.rs:345-349) returns 1.0 before any
  probe. On this workload runnable_novelty is a predicted branch returning a
  constant, so there is nothing to memoize and the memo's thread-local
  borrow and linear scan would most likely be a small slowdown. Verified
  independently against the config and the source.
- what would reopen it: a workload that sets novelty_enabled true. The
  purity argument underlying the memo was checked and is sound - the local
  timeline is mutated only by note_delivery and note_recovery, which run in
  exec and never inside schedule_runnable - so the idea is correct in
  general and merely inapplicable here.
- worth keeping from it: a profile ranks symbols but cannot say which branch
  inside them the graded config takes. Check the config before attributing
  a profile line to a mechanism.
