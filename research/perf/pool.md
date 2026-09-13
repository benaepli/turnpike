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

- category: allocation | origin: proposer | status: closed
- graded as: part of the combined commit env-detach-plan-dense, refuted
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

- category: data layout | origin: proposer | status: closed
- graded as: part of the combined commit env-detach-plan-dense, refuted
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

- category: allocation | origin: proposer | status: closed in part (see queue-eligibility-from-counters)
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

## env-detach-plan-dense

- category: combined | origin: user (selection) | status: closed, refuted
- declarations: search-neutral, shared saving
- components: exec-node-env-in-place and plan-engine-dense-status, built
  together in one commit at the user's direction
- band: [1.07, 1.21] on cross-binary runs per second, declared before any
  round was bought. Composed from the two component bands rather than
  reused from either: [1.05, 1.14] and [1.02, 1.06] compose to a lower edge
  of 1.05 * 1.02 = 1.071 and an upper edge of 1.14 * 1.06 = 1.208.
- counters: env_traffic.node_slot_copies, env_traffic.node_slot_writes,
  env_traffic.recv_node_slot_stores from the first component;
  plan_deps.ready_scans, plan_deps.status_entries_scanned,
  plan_deps.plan_nodes_sum from the second. The two groups are disjoint by
  construction and neither aggregates over both mechanisms.
  env_traffic.node_slot_copies is passed as --counter; the plan_deps group
  is read off the utilization dump by hand and recorded in the log.
- falsifier: the rps interval lies entirely below 1.07; or the neutrality
  spread check reads outside the baseline's own spread; or
  recv_node_slot_stores reads above 0 on any round; or either mechanism's
  counters say it did not fire.
- known limitation, recorded before the rounds were bought: a combined wall
  reading cannot say which of the two mechanisms paid, or whether one paid
  while the other regressed and the sum came out positive. There is no
  treatment bit to split it with. The counters say which mechanism fired,
  not which one bought the time. On a regressed or refuted verdict neither
  component is individually refuted and the correct follow-up is to split
  them and re-grade, not to close both.

### env-detach-plan-dense: outcome

Refuted at six rounds. Primary 0.9733, interval [0.9064, 1.0452], entirely
below the frozen band [1.07, 1.21]. Not a demonstrated regression: the
reading does not separate from the 0.05 floor and its interval includes 1.
Patch kept at research/perf/patches/env-detach-plan-dense.spur.patch;
candidate profile at
research/perf/profiles/12b7582-cand-env-detach-plan-dense.md.

What held: the search-neutral declaration, on every spread check from round
3 to round 6, across steps per run, all five end reasons and all five arm
shares. env_traffic.recv_node_slot_stores read 0, so the one disclosed
behavior change never fired and the two programs are observationally
identical on this workload. Both mechanisms fired -
env_traffic.node_slot_copies 200 per run, and plan_deps put status entries
examined per release at 0.004 against 13.0 nodes per plan.

Why the saving did not arrive, from the post-mortem profile:

- plan-engine-dense-status removed its own symbol - the get_ready_events
  collect, 1.75 percent - but exec_plan went from 1.85 to 3.23 percent, and
  take_ready_events appears nowhere, so the work was inlined into its
  caller rather than removed. Net saving a few tenths of a percent, not the
  1.75 the line suggested. The mechanism did what it claimed; the claim was
  about a symbol rather than about work.
- exec-node-env-in-place moved EcoVec::make_unique only from 1.45 to 1.33
  percent, although its counter proves the detach fired 200 times per run.
  Local envs are EcoVec-backed too, so the most likely reading is that the
  node env clone was never the dominant contributor to that line. The
  hypothesis named a profile line and assumed a site.

Both components are therefore closed rather than split and re-graded, which
is a departure from the follow-up both plans prescribed for a refuted
combined verdict. The written reason: the prescribed split exists to
protect a component whose individual effect the combined reading might have
masked, and that protection is moot here. The two together read 0.9733, so
neither alone can clear a 0.05 cross-binary floor, and re-grading them
individually would spend twelve rounds to confirm an arithmetic certainty.
The profile already attributes the shortfall to each component separately,
which is what the split would have bought.

What would reopen either: for the plan engine, a reading that shows the
release path costs something after inlining, measured rather than inferred
from a symbol disappearing. For the node env, an answer to the question
this iteration actually produced - where the rest of make_unique is called
from. That question is the lead this iteration hands the next one.

## queue-eligibility-from-counters

- category: data layout | origin: proposer | status: closed, no-gain
- declarations: search-neutral, shared saving
- judge: expectedGain 7, expectedCost 0, net 7 - the highest-scored
  candidate the loop has raised
- patch: research/perf/patches/queue-eligibility-from-counters.spur.patch
- title: Answer the per-step eligibility counts from the per-node ledger
  instead of walking every queue
- outcome: no-gain at the six-round cap. Primary 0.9748, interval [0.8960,
  1.0604], not dominant, not separated, band [1.04, 1.10] read inside so
  not refuted.
- what held: the fast path fired on 100 percent of steps (slow_steps 0);
  the search-neutral declaration held on every observable at the round cap;
  steps per run 1999.1 against 1992.6. Exactness was verified rather than
  argued - a debug build ran ten million steps of the real workload with an
  assertion comparing all three computed counts against an actual walk on
  every step, and it never fired.
- **the durable result**: elements_skipped over fast_steps reads 8.57
  elements per step on the graded workload, 8.27 and 8.15 on release
  smokes, 7.43 on an 8-thread debug run. **The average total queue length a
  scheduling step holds is about 8.5 runnables.** Nobody in this repository
  had that number before.

### What 8.5 elements per step closes

The proposer froze the interpretation before the measurement: a reading
near 5 closes the queue-walk family, a reading near 40 says the traffic is
real. At 8.5 the family is closed by arithmetic rather than by six more
rounds of clock each:

- `pending-deliveries-dense` - would remove a second traversal of the same
  network queue. Its own band was [1.01, 1.04] and its whole symbol 1.28
  percent; at 8.5 elements the traversal it removes is a fraction of that.
  Not worth building against a 0.05 floor. Closed on this evidence.
- `runnable-thin-queue` - its case rested on striding 240-byte elements
  during queue walks. At 8.5 elements a walk touches about 33 cache lines,
  which is not where a five percent saving lives, and the judge separately
  found its headline size claim false (the enum lands near 88 bytes, not
  32, because Timer stays unboxed). Closed.
- `per-step-scratch-buffers` - the scheduler half of it reuses the buffers
  these walks fill. Same arithmetic. The per-interpreted-call argument
  vector half is untouched by this finding and remains the only live
  fragment.


## call-frame-one-pass

- category: redundant work per step | origin: proposer | status: merged
- declarations: search-neutral, shared saving
- title: Build call frames in one pass and drop the duplicate entry frame
- outcome: merged at the user's direction on split evidence, superproject
  66ed777, spur 17e74ad. Six rounds, mean 1.0634, interval [0.9884, 1.1442];
  frame.entry_frame_copies 1281 per run on an instrumented baseline against
  0 on the candidate. Full record in observations.md iteration 4 and
  decisions.jsonl.

## thread-local-stats-blocks

- category: contention and parallelism | origin: proposer | status: merged (user, on split evidence) - superproject a0572ff, spur a702eef; primary 1.3217 [1.1878, 1.4706] over 3 rounds; neutral declaration flagged by the spread check and cleared by the one-thread identity runs in observations.md iteration 5
- declarations: search-neutral, shared saving
- judge: expectedGain 7, expectedCost 0, net 7 (cost becomes 2 if the
  TERMINATION counters, which the grader and the reward read, are converted;
  they must not be)
- plan: research/perf/plans/thread-local-stats-blocks.md
- title: Per-thread counter blocks, added into the global counters once per run
- description: on this config every scheduling step makes at least 14
  unconditional Relaxed fetch_add writes (lock-prefixed) to the same
  static AtomicU64 counters from all 30 worker threads: SA_STEPS,
  SA_STEPS_TOTAL, six preference-consultation writes from three
  route_by_terms sites, ES_QUEUE_AUDIT, SR_NO_WEIGHTED_PREDICATE,
  MA_DECISIONS, RWP_DECISIONS, RWP_EVALUATED, ES_CANDIDATE_MASK, plus
  conditional ones (MA_CONTESTED on about 43 percent of steps, ES_RANKING_PASS,
  crash anchor offers, timer admission, delivery buckets, record_timer and
  its TIMER_EFFECTS mutex). This is true sharing: one counter bounced
  between cores every step. Move the hot counters into a per-thread block
  folded into the globals at the run-end hook beside flush_frame_stats, the
  pattern FRAME_RUN already uses, with begin_run as the idempotent backstop.
- verified at judging: stats true on the graded config; the writes exist
  and are unconditional as listed; no release-build mid-run reader of any
  converted counter (readers are slice-boundary snapshot/delta, the dump and
  tests); timer_context CELL_ learner atomics stay global; TIMER_KEY_CAP 4096
  never reached. One mid-run reader found: a debug_assert in
  record_run_termination (util_stats.rs:2912) reads SA_STEPS_TOTAL inside
  exec_plan, so the fold must precede it or the assert must read local plus
  global.
- red-team recorded: by the audit_multiplier_authority control (same call
  rate, about 1.4 writes, 1.13 inclusive) one contended write costs about
  0.3 to 0.8 points, so the writes explain 0.6 to 1.6 of
  walk_recovery_placebo's 3.84 self, not the proposed 2.9; the total of 5 to
  9 points still follows from 16 to 20 writes per step.
- counters: stats_local.folded_increments (per run, predicted 25,000 to
  55,000), stats_local.folds (per run, predicted 1.00 within 1 percent).
- band: [1.05, 1.20] on cross-binary runs per second (rewritten at judging
  from [1.08, 1.25]).
- treatment bit: none; VARIANT_BITS is full and a shared saving cannot use
  the within-binary contrast.
- independent observable: in a profile of the candidate binary,
  walk_recovery_placebo self falls by at least 1.0 point, and the summed self
  of schedule_runnable (all specializations), select_within_queue,
  walk_recovery_placebo and audit_multiplier_authority falls by at least 4
  points.
- falsifier: the rps interval lies entirely below 1.05; or the spread check
  reads outside the baseline's own spread on steps per run, end reasons or
  per-arm counts; or walk_recovery_placebo self does not fall by at least
  1.0 point; or stats_local.folds per run is not 1 within 1 percent; or the
  dump's integer leaves per run or timer_effects.by_key length differ from
  the baseline's beyond the round spread.
- cost clause: steps per run, end reasons and per-arm counts hold their
  distributions; runs per second does not separate downward; no dump field
  changes name, shape or content.

## exec-plan-borrows-program

- category: allocation | origin: proposer | status: closed, absorbed into run-invariant-lookups-once (iteration 6)
- declarations: search-neutral, shared saving
- judge: expectedGain 6, expectedCost 0, net 6
- title: exec_plan borrows the Program instead of deep-cloning it per run
- description: exec_plan takes program by value (path.rs:474) and
  run_single_simulation passes program.clone() (explorer.rs:1111), once per
  run on the graded path; the body only reads it. Take &Program.
- verified at judging: body read-only; the two Program clones are the only
  ones in simulator and CLI; all of Program::clone's 1.65 inclusive is the
  graded site. The drop share is not checkable.
- counter: run_setup.program_clones_avoided, predicted 1.00 per run
  (rewritten at judging from a constant vertex count that could not fail).
- band: [1.015, 1.04], below the floor alone; composes with the next two.
- independent observable: Program::clone absent from the candidate profile.
- falsifier: rps interval entirely below 1.015; spread check outside the
  baseline's spread; malloc inclusive rises.

## fx-hashed-call-and-timeline-lookups

- category: redundant work per step | origin: proposer | status: proposed in part - the timeline half is absorbed into run-invariant-lookups-once (iteration 6); the call-map half stays and competes with call-targets-indexed, which removes the same cost
- declarations: search-neutral, private saving (read cross-binary; no bit)
- judge: expectedGain 6, expectedCost 0 after rewrite (2 as proposed), net 6
- title: Fx-hash the call-target maps and the feedback timeline sets, and
  insert the constant timeline key once
- description: rpc and func_name_to_id are std RandomState maps probed on
  every interpreted call (exec.rs:169-177, 224-232); hash_one<NameId> 1.15
  inclusive is those lookups. LocalTimeline::note_delivery SipHash-inserts
  the one fixed Constant-granularity tuple once per distinct prior handler
  (insert<TimelineTuple> 2.22 inclusive under note_delivery 2.74). Make
  rustc-hash non-optional, switch those maps to Fx, insert the constant key
  once.
- rewritten at judging: drop the exec.rs role-id change and the exec.rs
  call_targets counter (both cost 2, little saving); keep
  timeline.constant_inserts_skipped; serialize_nameid_map needs a generic
  hasher; the neutral argument adds that the per_dest_seen float sum at
  feedback.rs:361-372 is unreachable on this config and was already
  randomly ordered elsewhere; attribution about 3 points, not 3.5.
- band: [1.03, 1.07], below the floor alone.
- falsifier: rps interval entirely below 1.03; spread check outside the
  baseline's spread; constant_inserts_skipped reads 0; Sip13 write
  inclusive does not fall.

## serialize-history-inline

- category: contention and parallelism | origin: proposer | status: closed, absorbed into format-once-on-simulation-threads (iteration 6)
- declarations: search-neutral, shared saving
- judge: expectedGain 4, expectedCost 2 (history.rs; payload_json is the
  column porcupine parses), net 2
- title: Serialize a run's history on its own thread without nested rayon
  jobs or JSON trees
- description: serialize_history (history.rs:209-231) runs a nested
  par_iter inside a worker of a saturated pool once per run and builds a
  serde_json Value tree per operation.
- rewritten at judging: use a streaming Serialize impl through
  serde_json::to_string (or ship only par_iter to iter) rather than a hand
  writer; compare sorted (run_id, row, payload_json) tuples or a one-thread
  run, not file bytes. The claim on steal and epoch traffic is unsupported:
  the grid and AOS par_iters produce it too.
- band: [1.015, 1.05], below the floor alone. As a composite with the two
  entries above: [1.06, 1.17], cost 2, and a combined reading cannot say
  which part paid.

## run-invariant-lookups-once

- category: redundant work | origin: proposer | status: merged as part of lookups-and-format-once
- declarations: search-neutral, shared saving
- judge: expectedGain 7, expectedCost 0, net 7 (parts a and c of the
  proposal; part b cut to call-targets-indexed)
- title: Borrow the Program in exec_plan and insert the collapsed timeline
  key once
- mechanism: (a) exec_plan takes &Program; explorer.rs:1111 and 1451 stop
  cloning. (c) LocalTimeline::note_delivery returns at once under Constant
  granularity when tuples already holds the constant key. No exec.rs edit.
- neutral argument: program is only read in exec_plan's body; tuples never
  shrinks within a run, so every reader of tuples sees the same set;
  per_dest_seen's only live reader under Constant is the skipped branch.
- counters: timeline.constant_short_circuits 250 to 700 per run (primary),
  timeline.constant_inserts equal to timeline_keys.keys_in_run_sum / runs
  to 3 decimals and never above 1 per run, run_setup.program_clones_avoided
  1.00.
- band: [1.04, 1.08] cross-binary runs per second (a [1.025, 1.04] x c
  [1.015, 1.04]); lower edge below the 0.05 floor, stated in advance.
- independent observable: in a candidate profile Program::clone,
  Vec<Label>::clone and drop_glue<Program> absent; note_delivery inclusive
  at most 0.8 (from 3.96); HashMap<TimelineTuple>::insert at most 0.5 (from
  3.22); Sip13 write inclusive down at least 1.8 points (from 4.32).
- falsifier: rps interval entirely below 1.04; a one-thread identity run
  differs in any run row, table row or pre-existing dump field;
  constant_inserts above 1 on a run or unequal to keys_in_run_sum / runs;
  constant_short_circuits 0; program_clones_avoided not 1.00;
  note_delivery not below 0.8 or malloc inclusive rising.
- full record: tmp/loop/perf/it6-judgment.md, keep-list item 1, copied into
  observations.md iteration 6.

## format-once-on-simulation-threads

- category: redundant work | origin: proposer | status: merged as part of lookups-and-format-once
- declarations: search-neutral, shared saving
- judge: expectedGain 5, expectedCost 2 (exec.rs for a; history.rs and
  payload_json for c), net 3 (parts a and c; part b scored 0)
- title: Reuse the dispatch payload at handler entry, and serialize history
  inline without JSON trees or nested rayon jobs
- mechanism: (a) TraceDispatch stores a Box<str> copy of its payload beside
  pending_trace_id; Instr::Async moves it into Record::trace_payload,
  taken at exactly the points trace_id is; TraceEnter reuses it when it
  took a pending id and the slot is Some, else formats as today; excluded
  from Record's Hash. (c) serialize_history uses iter and a borrowed
  Serialize impl through serde_json::to_string, writing every object's
  keys sorted, NodeId by hand as {"index","role"}.
- neutral argument: the Enter payload equals the Dispatch payload on every
  path (args evaluated over the same temps with no store between, params
  are those args, Record::reset rebuilds from the same initial_args);
  traces and PersistableOp have no search reader; no draw or container
  order moves.
- counters: trace_format.enter_payload_reused 230 to 300 per run (primary),
  trace_format.enter_payload_formatted 3 to 8, reused plus formatted equal
  to Enter trace rows per run exactly; history_format.ops_streamed equal
  to executions rows per run exactly.
- band: [1.018, 1.051] cross-binary runs per second; nearly all below the
  floor, so the wall can only rule out a regression, stated in advance.
- independent observable: one-thread identity of the executions, logs and
  traces tables on (run_id, seq) and every column; in a candidate profile
  trace_payload inclusive down at least 1.2 points (from 5.33),
  json_of_value and Vec<serde_json::Value> from_iter absent,
  serialize_history summed inclusive at most 2.0 (from 3.88).
- falsifier: rps interval entirely below 1.018; any byte difference in the
  identity run; enter_payload_reused 0; reused plus formatted unequal to
  Enter rows; ops_streamed unequal to executions rows; trace_payload down
  less than 1.2 points.

## lookups-and-format-once

- category: combined | origin: operator-agent (selection) | status: merged (autonomous) - spur 84b7ab5; primary 1.1727 [1.1062, 1.2432] over 6 rounds, separated, band read inside; every frozen falsifier held
- components: run-invariant-lookups-once and format-once-on-simulation-threads,
  built together in one commit by the operator's decision in autonomous mode
- declarations: search-neutral, shared saving
- band: [1.059, 1.135] cross-binary runs per second, composed from the
  component bands: 1.04 x 1.018 = 1.0587 and 1.08 x 1.051 = 1.1351.
- counter passed to the grader: timeline.constant_short_circuits; the other
  four counters are read off the dump by hand. The two groups are disjoint
  by construction.
- falsifier: the rps interval lies entirely below 1.059; the one-thread
  identity run differs in any byte of the three tables, any run row or any
  pre-existing dump field; or any component falsifier above fires.
- why combined: neither component can be read against the 0.05 floor
  alone, the user prefers fewer, larger rounds, and the parts touch
  disjoint code with disjoint counters. Known limitation, recorded before
  any round: the wall cannot say which part paid; the candidate profile and
  the counters are the attribution. On a refuted verdict the component
  whose profile observable did not move is the one closed.

## call-targets-indexed

- category: redundant work | origin: proposer | status: proposed
- declarations: search-neutral, shared saving
- judge: expectedGain 5, expectedCost 2 (exec.rs), net 3
- title: Resolve call targets to a dense index once at compile time
- description: every SyncCall and Async does a SipHash of the name in
  func_name_to_id and a SipHash of the NameId in rpc (exec.rs:169-177,
  224-232); both maps are fixed after compilation.
- before admission: rewrite the count against frame.calls (indexed
  resolutions per run within [0.95, 1.00] of frame.calls, about 2,045 to
  2,126 on a702eef); subtract the NodeToString probe at eval.rs:415 from
  hash_one<NameId>; realized size about 1.3 to 1.5 points. Must not be
  graded alongside the call-map half of fx-hashed-call-and-timeline-lookups.

## fstring-concat-once

- category: allocation | origin: proposer | status: closed at judging, score 0
- why closed: its structural claim is false - try_to_expr collapses pure
  sub-chains into one label with nested Plus and no temps (cfg.rs:986-989,
  1441-1450), so the label rewrite does not match the code; labels have
  readers outside exec (visualization/cfg.rs:162-173, 511; cfg/test.rs:138).
- lead it leaves: per-Add EcoString allocation, and contended atomic
  refcount writes on shared literal buffers and on the trace
  function_name Arc<str> cloned on every trace row (exec.rs:428, 461, 476),
  neither priced anywhere.
