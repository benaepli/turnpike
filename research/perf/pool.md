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

- category: redundant work per step | origin: proposer | status: closed - the timeline half merged in lookups-and-format-once (iteration 6); the call-map half absorbed into call-targets-indexed and lookups-dense (iteration 8)
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

- category: redundant work | origin: proposer | status: merged inside compiled-interpreter via lookups-dense (iteration 9)
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

## value-construction-without-work

- category: allocation | origin: proposer | status: merged as part of value-traffic-composite
- declarations: search-neutral, shared saving
- judge: expectedGain 7, expectedCost 0, net 7 (rewritten at judging)
- title: Leaf signatures computed at hash time under NoHashing, and call
  frames filled in place without constructors or per-slot reserve
- mechanism: under !H::EAGER, Value::new stores sig 0 and Hash for Value
  computes the leaf signature from the kind (compute_sig_leaf_only), so hash
  bits are unchanged; FrameBuilder::finish and build_frame fill slots with
  one trusted extend, each default built in place, never by clone.
- verified at judging: Hash for Value is the only NoHashing reader of sig on
  the explore path; with_sig's one non-test caller writes 0; imbl stores
  hash bits per entry, so layout and iteration order are unchanged;
  extend_from_trusted exists in ecow 0.2.6; frames are unique and exactly
  sized; Unit and Nil are the only defaults. Overstated as proposed: slots
  include parameter slots and SyncCall pushes one at a time.
- counters: frame.default_slots_filled 29,000 to 34,000 per run (primary);
  frame.params_filled 1,400 to 6,000, the two summing exactly to
  frame.slots_built; value_sig.leaf_hashes_deferred 1,000 to 5,000.
- band: [1.035, 1.07] cross-binary runs per second, lower edge below the
  floor, stated in advance.
- independent observable: Value::new + FrameBuilder::finish +
  EcoVec<Value>::reserve self falls from 7.91 to at most 3.5; eval +
  execute_common_label + build_frame self rises by at most 1.5 over 13.96
  (relocation guard); ValueKind::clone self does not rise.
- falsifier: rps interval entirely below 1.035; spread check outside the
  baseline's spread; one-thread identity run differs in any cell; the slot
  sum identity breaks; leaf_hashes_deferred reads 0; any profile check fails.
- full record: tmp/loop/perf/it7-judgment.md, copied into observations.md
  iteration 7.

## eval-borrows-operands

- category: allocation | origin: proposer | status: merged as part of value-traffic-composite
- declarations: search-neutral, shared saving
- judge: expectedGain 5, expectedCost 2 (exec.rs), net 3; admitted only
  inside the composite
- title: Borrow slot values that eval only reads, instead of cloning and
  dropping them
- verified at judging: every listed position only reads its operand; imbl
  without takes &self; (**v).clone() equals unwrap_or_clone on a shared Arc;
  evaluation and error order unchanged if each arm keeps eval, check, eval.
  Per-run counts unverifiable.
- counters: eval_borrow.handles_not_cloned 2,000 to 6,000 per run;
  eval_borrow.scalars_not_cloned 5,000 to 15,000.
- band: [1.01, 1.035], entirely below the floor.
- independent observable: ValueKind::clone self falls by at least 0.25 (from
  1.38); drop_glue<Value> + drop_glue<ValueKind> + EcoVec<Value>::drop self
  falls by at least 0.5 (from 5.23).
- falsifier: handles_not_cloned below 1,000 per run; ValueKind::clone self
  does not fall; identity run differs.

## per-run-buffers-sized-once

- category: allocation | origin: proposer | status: merged as part of value-traffic-composite
- declarations: search-neutral, shared saving
- judge: expectedGain 5, expectedCost 2 (exec.rs Print), net 3; admitted
  only inside the composite, hint rewritten
- title: Size the channel table, the log and trace vectors, and each Print
  line once instead of growing them
- rewritten at judging: the capacity hint is the previous run's final length
  on the thread, capped at 4,096 channel entries and 8,192 log and trace
  entries - not a high-water mark, which after one long run would keep a
  multi-MB table whose sparse gets miss L2 on every later run.
- verified at judging: channels starts empty each run, is filled only at
  exec.rs:222, 282, 300 and never removed; its only iteration is inside
  State::signature; the reserve_rehash line is typed to ChannelMap; logs
  and traces are taken with mem::take per run; Print grows from empty with
  one malloc and two reallocs; exec.rs:334 is the only log caller.
- counters: run_buffers.channel_table_grows at most 1.0 per run;
  run_buffers.channels_created 800 to 1,200; run_buffers.log_vec_grows and
  trace_vec_grows at most 1.0 each; print_content.presized equal to log
  rows per run exactly.
- band: [1.015, 1.035].
- independent observable: the (ChannelId, ChannelState) reserve_rehash line
  absent (from 1.15 inclusive); RawVecInner::finish_grow inclusive down at
  least 1.0 (from 3.84).
- falsifier: channel_table_grows above 2.0 per run; presized unequal to log
  rows; finish_grow does not fall; identity run differs.

## value-traffic-composite

- category: combined | origin: operator-agent (selection) | status: merged (autonomous) - spur b1fb646; primary 1.1005 [1.0385, 1.1663] over 6 rounds; relocation guard fired as written and departed from; post-merge baseline cleared its revert line
- components: value-construction-without-work, eval-borrows-operands,
  per-run-buffers-sized-once, built as one commit by the operator's decision
  in autonomous mode
- declarations: search-neutral, shared saving
- judge: expectedGain 6, expectedCost 2, net 4
- band: [1.061, 1.146] cross-binary runs per second, composed from the
  judged part bands: 1.035 x 1.01 x 1.015 and 1.07 x 1.035 x 1.035.
- counter passed to the grader: frame.default_slots_filled; the other parts'
  counters read off the dump by hand. No counter aggregates over two parts.
- falsifier: rps interval entirely below 1.061; spread check outside the
  baseline's spread; identity run differs anywhere; any part's counter or
  profile falsifier fires.
- cost clause: steps per run, end reasons and per-arm counts hold; trace,
  log and history bytes identical; no existing dump field changes;
  value_stays_narrow still 40; eval tests pass unmodified; peak resident
  memory per thread rises by no more than one run's table and buffers at the
  caps.
- why combined: the top part alone has a lower edge of 1.035 against a 0.05
  floor and the other two are floor-bound; the user prefers fewer, larger
  rounds; the parts touch disjoint code with disjoint counters. Known
  limitation recorded before any round: the wall cannot say which part paid;
  on a refuted verdict the part whose profile observable did not move is
  the one closed. A reading between 1.03 and 1.07 buys a layout control
  before deciding.

## lookups-dense

- category: data layout | origin: proposer | status: merged inside compiled-interpreter (iteration 9)
- components: call-targets-indexed (re-priced) and channel-table-dense
  (rewritten), judged in iteration 8
- declarations: search-neutral, shared saving
- judge: expectedGain 6, expectedCost 2 (exec.rs), net 4
- call-targets-indexed: a dense per-vertex callee table built in
  compile_program; only the SyncCall and Async arms of exec.rs change;
  unresolved names fall back to the maps. Verified: both maps are SipHash
  std maps never changed after compile; every label reaching
  execute_common_label is a reference into cfg.graph; VR never produces the
  NodeToString probe; frame.calls 2,086.1 per run; about 73 ns per
  resolution. path.rs:616-622 keeps 40 to 60 map lookups per run. The
  is_sync check must still run when the table answers. 2.3 to 2.9 points,
  band [1.022, 1.030]. Counters call_targets.indexed (0.95 to 1.00 of
  frame.calls per run), call_targets.fallback (0).
- channel-table-dense, as rewritten: ids start at 0 per run and increase by
  one, nothing removes a channel, the only iteration is the order-free XOR
  in State::signature; an exact-capacity Vec with natural growth replaces
  ChannelMap, keeping the table-full check, so run_buffers.channel_table_grows
  changes value (predicted 0.40 to 0.70 per run) and is exempted from the
  identity comparison, disclosed in advance. capacity() and the exec test's
  keys()/get() need their counterparts. 1.0 to 1.8 points, band [1.010,
  1.018]. Counters channel_table.lookups, lookup_misses (0), dense_inserts
  (equal to channels created).
- composite band [1.032, 1.049], entirely below the 0.05 floor: judged not
  worth a session of its own on the wall. Guards read against R, the summed
  self of six untouched scheduler and plan lines (4.12 on b1fb646).
- how to use it: ride along with a larger interpreter change, each part
  keeping its counters and its guard against R; a layout control before
  any merge whose reading lies between 1.00 and 1.08.
- full record: tmp/loop/perf/it8-judgment.md, copied into observations.md
  iteration 8.

## value-without-dead-signature

- category: data layout | origin: proposer | status: proposed, held - owes a measured price before building
- declarations: search-neutral, shared saving
- judge: expectedGain 3, expectedCost 0, net 3
- title: Zero-sized Value signature under NoHashing, 32-byte values
- verified: under NoHashing nothing reads Value.sig after iteration 7; a
  zero-sized sig leaves WithHashing at 40 bytes and every serialized form
  unchanged; no output path Debug-prints a Value; one test reads a NoHashing
  sig field directly.
- false claim that sank the pricing: 280 KB of fresh frame memory per run
  left unwritten - frames are freed on return and reused from the same
  allocator chunks, already cache-hot (iteration 4, observations.md
  598-605).
- band rewritten to [1.004, 1.012]; frame.slot_bytes dropped as a counter,
  being slots_built times 32.

## compiled-interpreter

- category: redundant work | origin: proposer | status: merged (autonomous) - spur 7f607e6, superproject 7209003; primary 1.1972 [1.1191, 1.2808] over 6 rounds; spread-check falsifier departed from on a caps-engaged one-thread identity run that read identical; post-merge baseline cleared its revert line
- components: compiled-expr-operands (expressions compiled once per program
  into an operand-resolved form), predecoded-label-ops (labels decoded once
  per program and run in exec's own loop), lookups-dense (rider)
- declarations: search-neutral, shared saving
- judge: expectedGain 6, expectedCost 2 (exec.rs), net 4; parts H1 net 2,
  H2 net 3, admitted only together
- band: [1.08, 1.15] cross-binary runs per second, rewritten at judging from
  [1.084, 1.156] to remove 0.5 point of double counting on each edge (both
  parts claimed the call cost of leaf expressions a label evaluates
  directly).
- verified at judging: Expr has 44 variants, every non-variable child calls
  eval out of line; no Program mutation after compile_program; no expression
  depends on run state; Label::Cond is built only over temps; the order
  constraints to mirror exactly (Find key after the collection match, And/Or
  short-circuit, Coalesce default only on None, KeyExists key first); every
  label execution site (exec from scheduler.rs:1698 and 2295,
  exec_sync_on_node from explorer.rs:811 and 872, path.rs:344,
  scheduler.rs:2209, SyncCall re-entry at exec.rs:192); draw points stay in
  their arms.
- counters: compiled_ops.label_execs (grader counter; 20,000 to 50,000 per
  run, refuted below 9,000), compiled_ops.legacy_labels 0,
  compiled_expr.leaf_operands_inline, compiled_expr.tree_evals,
  compiled_expr.legacy_evals 0, the lookups-dense counters; legacy counters
  count in release builds.
- equivalence obligations added at judging: a test that evaluates every Expr
  variant through both evaluators comparing value, error and counter deltas;
  one-thread identity smokes on VR and on a second spec; exec unit tests'
  Program builder edited and a test path that reaches the new loop.
- guard: the whole dispatch block plus every new compiled symbol reads at
  most 21.01 x r, where r is the summed self of the six untouched scheduler
  and plan lines over its 4.12 on b1fb646; per-part guards attribute only;
  the NameId to FunctionInfo map line is added as a guard.
- full record: tmp/loop/perf/it9-judgment.md, copied into observations.md
  iteration 9.

## grid-ordered-release-pool

- category: contention and parallelism | origin: proposer | status: closed without rounds (iteration 10) on its writer-backpressure falsifier - mechanism exact, blocked by parquet writer capacity; patch kept at research/perf/patches/grid-ordered-release-pool.spur.patch; reopen once writers have headroom - not by loosening its frozen falsifier after the fact: it returns as a new candidate (grid-ordered-release-pool-2) with its own declarations, band and a blocked_ns-per-run falsifier, frozen after text-rows-born-contiguous is graded
- declarations: search-affecting, shared saving
- judge: expectedGain 6, expectedCost 2 (campaign slice loop the grader
  reads), net 4
- mechanism: grid batches keep size 60 and their ids; a batch's fresh runs
  start early when the corpus's remaining child count, net of slot draws
  reserved by up to four earlier batches, covers all its slots and the
  previous batch's grid cursor is fixed; slot runs are drawn in order after
  earlier fresh runs are admitted in batch order; in_place_scope, at most
  four batches ahead, drained at slice end; AOS keeps its batched path.
- dependency answer, confirmed: run id, seeds, variant bits and slot-or-fresh
  are pure functions of run id; assignment depends only on earlier batches'
  fresh outcomes; learners are read at run start and merged mid-run, so the
  search moves even with ordered release.
- utilization, reproduced: busy share 0.585 (grid 0.596), 2.82 ms idle per
  grid run. 8.3 percent of slot draws found the corpus empty, so gated
  batches are common; SMT contention gives a per-thread slowdown of 1.21 to
  1.43 on 16 cores.
- band: [1.06, 1.22]. counters: grid_pool.worker_idle_ns 0.2 to 1.3 ms per
  grid run (falsifier above 1.6), busy share 0.78 to 0.96 (falsifier below
  0.75), gated batches 5 to 45 percent per arm, AOS share of runs 13.8 to
  16.2 percent, an unfilled draw in an ungated batch reads 0; steps-per-run
  guard added (learned caps changing run length voids the wall reading).
- owed before any merge: the lite grader's non-inferiority reading - 2 to 4
  paired 300 s chunks, cross-binary, depth>=4 and h2 at the 25 percent
  relative margin, read per run - logged in observations.md; the protocol
  panel runs without the campaign block, so GridArm never executes there and
  it is uninformative for this candidate, not clearance. Only with
  spur-research-loop stopped and never beside the perf grader; through the
  research-loop-lite skill's grader, without editing research/lite/.
- order: a debug shadow-assignment smoke reading gated batches per arm, then
  the perf grade, then the lite chunks if the perf reading lands in band.

## writer-capacity (direction, not yet a hypothesis)

- category: contention and parallelism | origin: operator-agent | status: addressed by text-rows-born-contiguous (iteration 11); writers on edb9e2f about 340 us busy per run, 0 s blocked
- the ceiling: at about 5,000 runs per second on 7f607e6 the four parquet
  writers are about 72 percent busy and already fill their queue in 5 of 6
  grading rounds; grid-ordered-release-pool's release smoke blocked
  simulation threads for 252 s in 60 s on a full queue.
- measured before (observations.md, history writer headroom, spur a702eef):
  arrays built on the producer thread cut writer CPU 17 to 26 percent and
  add about 100 us per run on simulation threads; accumulating runs per
  write was slower; turning dictionaries off grew output 1.1x to 3.7x.
- what reopens: grid-ordered-release-pool, once history_writer.queue_full_sends
  reads 0 at the candidate's throughput.

## text-rows-born-contiguous

- category: allocation and memory traffic (writer path) | origin: proposer | status: merged (autonomous) - spur edb9e2f, superproject a2f111d; busy_ns per run 1.7257 [1.6736, 1.7793] over 6 rounds, runs per second 1.0738; no departures; post-merge baseline cleared its revert line
- declarations: search-neutral, shared saving
- judge: expectedGain 6, expectedCost 2 (history.rs, exec.rs), net 4
- title: Each run's text columns written into one recycled buffer with end
  offsets, turned into StringArrays without copying
- mechanism: trace payload, log content and the executions payload and
  action columns are written contiguously per run instead of as about 2,200
  separate Strings; the writer builds arrays zero-copy (arrow/parquet 58:
  Buffer::from_vec, into_vec, new_unchecked, into_parts) and returns the
  buffers through a bounded free list, so large buffers are never freed
  across threads; the run row travels in the Write command; schemas built
  once.
- rewritten at judging: the free list holds at most 64 whole buffer sets and
  drops any buffer over 1 MB; offset vectors stay on the writer; the busy
  timer stops only after recycling or dropping; queue_full_sends is not
  comparable across the change (one send per run instead of two), only
  blocked_ns is. Allocations saved about 1,570 to 1,680 per run (the 614
  executions allocations claimed were about 354).
- verified at judging: writer profile lines as claimed (writer_loop 11.32,
  intern 1.33, writer cfree 2.23, Vec<PersistableTrace>::drop 1.41); busy per
  run 583 us on 7f607e6 with the counter on both sides of every round; every
  reader sorts explicitly, so read-back content is identical; the earlier
  replay bench measured a similar writer-side saving (251 to 210 us, 1.195).
- primary: counter history_writer.busy_ns per run, band [1.15, 1.40], paired
  against 7f607e6; runs per second read cross-binary for regression only
  (expected [1.01, 1.05]).
- counters added: history_writer.commands, text_buffers_allocated (under
  0.01 per run once warm), text_buffers_recycled,
  text_buffers_dropped_oversize.
- owed before rounds: one-thread identity on runs, executions, logs and
  traces read back ordered, plus porcupine exit codes; by hand, output bytes
  per run within [0.97, 1.03] and peak RSS at most 1.05x.
- full record: tmp/loop/perf/it11-judgment.md.

## integer-columns-delta-encoded

- category: data layout (writer path) | origin: proposer | status: proposed - buildable now on edb9e2f, graded alone; lower priority while writers read about 44 percent busy
- declarations: search-neutral, shared saving
- judge: expectedGain 4, expectedCost 2 (history.rs), net 2
- verified: parquet 58 supports per-column dictionary off with
  DELTA_BINARY_PACKED; go-duckdb v2.4.3 (porcupine, traceanalyzer) and the
  arrow-rs debug reader read it; no reader depends on dictionary pages or
  loses statistics. The earlier dictionary-off replay caps the saving.
- primary: history_writer.busy_ns per run, band rewritten to [1.03, 1.08];
  owes a parquet_metadata check that the encoding changed and output bytes
  per run in [0.85, 0.98].

## caller-runs-overflow-encode

- category: contention and parallelism (writer path) | origin: proposer | status: parked - build only if a merged tree still blocks 30 s or more per 60 s
- judge: expectedGain 3, expectedCost 2, net 1
- findings: encoding in helper slots keeps rows together per run and cross-run
  order is already arbitrary; missing a shutdown clause (an unfinished file
  breaks directory-wide read_parquet) and a memory clause; its claim of under
  0.001 full sends per run on today's tree is false (0.0041 on round 5).
  Its primary would be cross-binary runs per second, clearing 0.05.

## grid-ordered-release-pool-2

- category: contention and parallelism | origin: operator-agent (re-admission of grid-ordered-release-pool) | status: merged (autonomous) - spur 911e265, superproject 1501315; runs per second 1.3497 [1.3233, 1.3767] over 6 rounds, every frozen falsifier held; lite depth>=8/s 1.4389 with per-run deep guards held; post-merge baseline 7,142.3 cleared its revert line of 5,446; shadow logic removed per the user (spur 5df7084)
- declarations: search-affecting, shared saving; no treatment bit
- judge: expectedGain 7, expectedCost 2 (campaign slice loop, per-slice
  deltas and per-arm run attribution the grader reads), net 5
- mechanism: grid-ordered-release-pool's ordered-release pool, rebased on
  edb9e2f (git apply --check clean; explorer.rs, util_stats.rs and the
  completeness test hunks offset only). The rebase keeps iteration 11's
  history_writer counters beside grid_pool, never holds a run's text
  buffers in the pool, keeps the AOS batched path, and reads busy share
  beside blocked time because the pool times the whole job including the
  writer send while runs.wall_us excludes it.
- held exactly: every run's assignment and the corpus draw and admission
  order. Moves: which learner updates a starting run sees, and with it steps
  per run, end reasons and per-arm counts.
- utilization on edb9e2f: grid busy share 0.607 to 0.623 (2.06 to 2.28 ms
  idle per grid run); the old smoke's 0.894 was 0.719 productive, 0.106 idle
  and 0.175 blocked; contention on 16 cores recomposes runs per second to
  1.03 to 1.21, writers 54 to 72 percent busy with the pool on.
- primary: cross-binary runs per second against edb9e2f (5,186.6), band
  [1.05, 1.20].
- counters: grid_pool.worker_idle_ns per grid run 0.2 to 1.0 ms (falsifier
  above 1.3); busy share 0.80 to 0.95, read beside the blocking-removed share
  (falsifier below 0.75); capacity_gated_batches 4 to 35 percent;
  unfilled_in_ungated_batches 0 (falsifier above 0); fresh_ahead_launched 30
  to 50 percent of grid runs; shadow_mismatches 0 in debug over at least
  1,000 batches per grid arm (falsifier above 0); AOS us per run within
  baseline spread x 2 (falsifier outside); grid us per run up 1.15 to 1.35;
  text_buffers_allocated at most 0.05 per run.
- writer falsifier: history_writer.blocked_ns above 50 us per run in the
  pre-round smoke or in any single round. queue_full_sends and the spread
  check are description only.
- pre-round gate: one 30-thread release smoke at the graded 120 s budget;
  any falsifier firing there closes the candidate without rounds.
- voiding rule: any grid arm's steps per run outside baseline spread x 2
  voids the wall reading - neither credited nor refuting; decided by the
  operator.
- before any build is trusted: one-thread identity on edb9e2f (four tables,
  stall-cap CSV hash, every existing counter outside clocks; new grid_pool
  counters exempt) and the debug shadow smoke.
- before any merge: the lite grader under v3, 2 to 4 cross-binary chunks, per-run
  deep guards on depth>=6 and depth>=8 at the 0.25 margin reading held; the
  per-second rung as description; the panel recorded as blind to GridArm.
- order: rebase, identity, debug shadow, smoke gate, perf rounds 3 to 6,
  lite chunks only if the primary lands in band and nothing is voided, log,
  decide.
- full record: tmp/loop/perf/it12-judgment.md.

## frame-slots-by-liveness

- category: algorithmic | origin: proposer | status: merged (autonomous) - spur 45517fd, superproject fa48f64; frame.slots_built per run 4.1563 [3.9922, 4.3272] over 3 rounds, runs per second 1.0748; neutrality blocker departed from on a caps-engaged identity run that read identical; post-merge baseline 7,669.9 cleared its revert line of 6,789
- mechanism: a per-function liveness pass after compile and before
  Program::decode colors VarSlot::Local slots greedily; parameters keep
  0..param_count-1; interference is def against live-out (a store interferes
  with every slot live after it, so dead stores cannot take a live slot's
  color); entry-live non-parameter slots keep their declared defaults and
  never share a color; the use/def extraction matches every Label and Instr
  variant with no wildcard.
- declarations: search-neutral, shared saving, no treatment bit.
- exactness: an independent forward reaching-definitions checker in a unit
  test over every function of every bin/spur spec, plus a mutation test the
  checker must reject (a dead-store dummy on a live loop variable's color);
  one-thread identity runs on VR and a second spec, exempt leaves only
  frame.slots_built and frame.default_slots_filled.
- disclosed by construction: `spur compile` program.json slot indices,
  local_slot_count and local_defaults change; `_tmp{N}` names stop matching
  slot numbers; dead temps drop at slot reuse.
- counters: frame.slots_built per run baseline over candidate [1.6, 2.6]
  (primary); new frame_layout.program_slots_before/after, after/before at
  most 0.62 on VR.
- profile guards (scaled by R = 3.97): FrameBuilder::finish self at most 1.3;
  EcoVec<Value>::drop + drop_glue<Value> self down at least 0.8 from 4.34.
- wall: runs per second [1.02, 1.035], regression only.
- full record: tmp/loop/perf/it13-judgment.md (H1).

## trace-payload-escaped-in-one-pass

- category: algorithmic | origin: proposer | status: closed (iteration 13, autonomous) on its frozen summed-self guard - write_text 1.28 + push_json_string_content 1.22 = 2.50 against at most 1.97; the escape scan moved rather than went; counter identity and byte identity held; patch kept inside research/perf/patches/frame-slots-and-trace-escape.spur.patch
- mechanism: write_to becomes one text definition generic over a sink with
  raw-text and content entry points; the trace sink writes `[`, quoted
  escaped parameters joined by `,`, `]` straight into the trace TextBuffer
  with a table matching serde_json's compact escaper; TraceScratch leaves the
  path. A single-sink adapter that escapes every chunk does not meet the
  prediction.
- declarations: search-neutral, shared saving, no treatment bit.
- exactness: a generated-value unit test against json_string_array over
  write_to (quotes, backslashes, 0x00-0x1F, 0x7F, multi-byte UTF-8, the
  error piece); values.rs write_to tests unmodified; traces table
  byte-identical in the identity run.
- counters: new trace_format.payloads_streamed and trace_format.rows_logged;
  payloads_streamed + enter_payload_reused == rows_logged in every round.
- profile guards (scaled by R): format_escaped_str self at most 0.6; summed
  self of format_escaped_str, every write_to specialization and any new
  escape symbol at most 1.99.
- wall: runs per second [1.012, 1.02], regression only.
- full record: tmp/loop/perf/it13-judgment.md (H3).

## frame-slots-and-trace-escape-composite

- category: combined | origin: operator-agent (selection) | status: split (iteration 13) - three rounds, primary 4.1634 above band, rps 1.0717 not separated, deadlock-share neutrality blocker; H3 closed on its guard, H1 merged alone as frame-slots-by-liveness
- parts: frame-slots-by-liveness and trace-payload-escaped-in-one-pass;
  disjoint code, counters and guards.
- primary: frame.slots_built per run, baseline over candidate, [1.6, 2.6],
  paired. Runs per second cross-binary composed [1.032, 1.056], below the
  0.05 floor, read for regression only - stated before any round.
- falsifier: any part's falsifier, or the composite rps interval separating
  downward. Attribution: the part whose counter or guard did not move is
  closed; a regression with both guards moved is split and re-graded.
- order: pass and checker, sink split and escape test, identity runs, perf
  rounds with a candidate profile; merge rests on counters, identity, guards
  and no downward separation, with a revert line registered before the
  post-merge baseline.

## recovery-placebo-walk-skipped-without-quick-fire

- category: algorithmic | origin: proposer | status: closed at judging (autonomous) - the walk's cost is the cost-matched control the search loop built (a55aa02) and keeps on in its graded workload; skipping it changes that control, which is not this loop's to change. Verification stands (exact, draws nothing) if the user retires the control; the saving would then be taken by switching the placebo off or deleting it, not by this skip.

## node-env-detached-per-segment

- category: allocation and memory traffic | origin: proposer | status: closed (iteration 14, autonomous) on its frozen make_unique guard - 2.03 to 1.69 with shared_at_write 0 every round, so most of make_unique is not the node env copy-on-write; patch kept inside research/perf/patches/node-env-and-in-place-updates.spur.patch
- mechanism: the node env is moved out of state.nodes[i] for the segment,
  leaving a placeholder that keeps sig and writes; every exit, error exits
  included, writes it back; the clone path stays under H::EAGER.
- verified by the judge: make_unique 2.03 can only be the node env
  copy-on-write on this tree (two make_mut sites, VR stores into maps only,
  frame.entry_frame_copies 0); every mid-segment reader audited (self-send
  writes at exec.rs:1206, same-node wake at exec.rs:1533, signature only
  under hashing, async continuation after writeback); the error-path
  difference is unobservable because a failed run writes no row
  (explorer.rs:1129 vs 1168). Answers the question exec-node-env-in-place
  was closed on. Corrected price 3.1-3.4 points.
- counters: node_env.written_segments, shared_at_write (must be 0);
  error_exits description only (the grader cannot pair a baseline-absent
  counter).
- declarations: search-neutral, shared saving.
- full record: tmp/loop/perf/it14-judgment.md (H1).

## collection-self-updates-in-place

- category: allocation and memory traffic | origin: proposer | status: closed (iteration 14, autonomous) on its frozen guards - GenericNode make_mut inclusive 1.56 (at most 0.83), insert inclusive fell 0.79 (at least 1.04); reserve held; the ops fire as counted
- mechanism: decoded ops for x = x[k] := v, append and erase into the same
  slot evaluate key and value first, keep error order, take the value out,
  update in place and store once; a collection still shared elsewhere keeps
  its copy. The decoder compares slot kind as well as index (after
  frame-slots-by-liveness a temp can share the target's slot).
- verified: label shapes (cfg.rs:693-696, 1028-1031), evaluation order,
  error kinds, aliasing; the imbl root is a 32-wide node of about 2.8 KB
  (layout arithmetic). Weak: without the node-env change there is almost no
  saving; struct literals also allocate roots.
- counters: value_update in-place map and list, split local and node slots.
- declarations: search-neutral, shared saving.
- full record: tmp/loop/perf/it14-judgment.md (H2).

## node-env-and-in-place-updates

- category: combined | origin: operator-agent (selection) | status: closed (iteration 14, autonomous) - runs per second 0.9994 [0.8951, 1.1159] over 3 rounds, counters in band, identity identical; H1 and H2 profile guards fired, closed by the attribution rule
- primary: cross-binary runs per second, band [1.04, 1.10], below the 0.05
  floor so read for regression only; counters by hand every round; a
  candidate profile for the guards (make_unique for H1 alone, the Value drop
  family composite-only, one merged relocation guard at 1.5 x r, r =
  R_cand/3.93).
- before any round: one-thread identity on VR (3,008 runs), Mencius, and the
  caps-engaged 100,000-run identity.
- merge rests on counters in band, shared_at_write 0, identical identity,
  every guard held and no downward separation.

## integer-columns-delta-encoded (iteration 14 re-pricing)

- status: closed (iteration 14, autonomous) on its frozen falsifier - runs per second 0.9786 [0.9737, 0.9835] separated downward while busy_ns per run read 1.1855 [1.1623, 1.2091] above band and writers were not binding (blocked 0); output bytes per run 0.703; patch kept at research/perf/patches/integer-columns-delta-encoded.spur.patch; returns as a new candidate only once writers block, with a layout control
- band tightened to history_writer.busy_ns per run [1.04, 1.14] (the earlier
  replay bench caps the saving near the top edge; the delta encoder's cost
  is unmeasured); writers about 72 percent busy, full-queue sends 0/29/31,
  blocked at most 0.07 us per run, so not binding today.
- readers verified: porcupine and traceanalyzer through DuckDB 1.4
  (go-duckdb v2.4.3), spur debug through arrow-rs parquet 58; statistics at
  default. Restored identity checks: traceanalyzer output and one spur debug
  combined run.
- full record: tmp/loop/perf/it14-judgment.md (H3).

## runnable-one-word-record

- category: data layout | origin: proposer | status: closed (iteration 15, autonomous) - memmove 5.92 to 2.81 held, but the scheduler-family delta +0.85 (at most 0.6) fired and runs per second 1.0132 [0.8644, 1.1875] did not separate upward under the criterion registered before rounds; patch kept at research/perf/patches/records-boxed-and-index-lists-inline.spur.patch
- mechanism: Record, Timer, the ChannelSend fields and the partition type
  are boxed inside Runnable (248 to 32 bytes), with an exact priority copy
  kept beside the box (nothing writes priority after the four constructors);
  exec and exec_ops take the box; parked readers become
  Arc<(Box<Record>, Lhs)>; the crash path moves the record instead of
  cloning it.
- verified by the judge (sizes compiled from the type definitions): Record
  and Runnable 248 bytes, about 152 cold; the nine credited memmove sites
  move a Record or Runnable and carry 31.4 percent of memmove; the priority
  copy cannot change a selection, draw or tie. Corrected: Vec::remove's tail
  shift stays a memmove call; removed memmove 2.36-3.22 points; the
  record_boxes falsifier against channels_created was wrong by construction
  and is replaced by the exact identity async record boxes + timer boxes +
  make() channels = channels_created; a ChannelSend box counter added; an
  exec_ops guard added for the moved dereferences (+0.4 points).
- placebo: the pairing holds by construction (novelty off, the placebo
  never follows the pointer); its self-share band is description, and a
  reading outside it goes to the search loop's owner before any merge.
- declarations: search-neutral, shared saving. Earlier runnable-thin-queue
  was closed on arithmetic, not measurement; this brings call-stack
  evidence.
- full record: tmp/loop/perf/it15-judgment.md (H1).

## step-index-lists-inline

- category: allocation and memory traffic | origin: proposer | status: closed (iteration 15, autonomous) - scheduler family 13.28 x r (at most 13.09) and heap spills 1.48-1.68 percent of lists per round (at most 1); patch kept at research/perf/patches/step-index-lists-inline.spur.patch
- mechanism: local_queue_sizes and the eligible lists in inline SmallVec
  storage (smallvec 1.15.1, already in Cargo.lock, no new crates), same
  indices and order; eligible lists at inline capacity 14 so a copy stays
  within 128 bytes.
- verified: every allocator share matches the attribution file. Corrected:
  the from_iter guard held by construction and is replaced by memmove and
  scheduler-family guards; the spill falsifier becomes at most 1 percent of
  lists built.
- declarations: search-neutral, shared saving. Earlier per-step-scratch-
  buffers' scheduler half was closed on arithmetic, not measurement.
- full record: tmp/loop/perf/it15-judgment.md (H2).

## records-boxed-and-index-lists-inline

- category: combined | origin: operator-agent (selection) | status: closed (iteration 15, autonomous) - runs per second 1.0132 [0.8644, 1.1875], not separated upward as required by the departure registered before rounds; identity identical, counter identity exact
- two commits on one branch, the index lists first, then the boxing; the
  composite graded as one change. H1's walk guard named the collect H2
  rewrites, so the scheduler is guarded as a family (12.94 on 45517fd).
- before rounds: unit tests and the exact counter identity; identity on VR
  3,008, Mencius 2,160 and caps-engaged 100,000 runs; two plain-cycles
  profiles, the index-lists-only commit and the composite, so H2's guards
  read the first and H1's the difference.
- wall bands below the 0.05 floor, regression only; merge rests on counters,
  identity, every guard and no downward separation.

## eligible-lists-known-from-queue-info

- category: redundant work | origin: proposer | status: merged (autonomous, placebo referral read by the user) - spur 11a720c, superproject 1089040; runs per second 1.0145 [0.9486, 1.0849] over 3 rounds, counters exact, guards held; post-merge baseline 8,017.4 cleared its revert line of 7,295; patch also at research/perf/patches/eligible-lists-known-from-queue-info.spur.patch
- mechanism: when the count pass shows every element of the chosen queue
  eligible, selection borrows a static identity slice instead of filtering
  again into a fresh Vec; past the slice's length, today's code; otherwise
  an exact-capacity collect; local_queue_sizes in a buffer reused across
  steps.
- verified by the judge: not a repeat of queue-eligibility-from-counters
  (that skipped the count and still collected every step); exact - same
  predicate, no state change between passes, the one in-predicate counter
  fires only on rejected elements; the fast path fires on at least 77
  percent of selections on the graded config. Rewritten: counter band
  [3, inf); counters after the empty-list check so known + built =
  recovery_weight_placebo.decisions exactly; allocator guard on malloc +
  cfree + _int_free_chunk at most 3.73 x r; scheduler family at most
  13.11 x r + 0.15 (the queue-sizes collect can reappear inside
  schedule_runnable).
- declarations: search-neutral, shared saving.
- full record: tmp/loop/perf/it16-judgment.md (H1).

## slot-buffers-owned-per-segment

- category: redundant work | origin: proposer | status: closed (iteration 16, autonomous) before rounds on its frozen scheduler-family guard (+1.67 over the lists-only profile, allowance 0.2) with every other guard held (make_unique gone, Value drop family down 1.90); patch kept at research/perf/patches/eligible-lists-and-owned-slots.spur.patch
- mechanism: Env slots an owned buffer behind a private type whose Clone
  counts copies; each segment moves its node's environment out and back
  (moved_out == put_back every run); crash_node's held records moved, not
  cloned; the closed node-env patch's detach reused without its
  clone-under-EAGER branch.
- verified: no State clone outside tests; Record 248 to 256 bytes (about
  0.11 memmove); the refcount check goes without a new branch. False as
  proposed: the at-most-5-copies falsifier would fire on crash_node's clones
  (fixed in the mechanism); "no make_unique in the binary" cannot hold
  because list storage shares the type (check restricted to Env write
  sites). All but 0.3-0.5 of its 1.6-2.2 points is the saving the closed
  node-env patch already tried.
- declarations: search-neutral, shared saving.
- full record: tmp/loop/perf/it16-judgment.md (H3).

## eligible-lists-and-owned-slots

- category: combined | origin: operator-agent (selection) | status: split (iteration 16) - owned slot buffers closed on their scheduler guard before rounds; the eligible lists graded alone on commit A
- two commits, the eligible lists then the owned slots; identity on both
  (VR, Mencius) and caps-engaged on the composite; profiles of the lists
  alone and of the composite, a part whose guard fires closing before any
  round; three cross-binary rounds, regression only, counters by hand; a
  part whose own falsifier fires closes and the other stands.

## delivered-record-not-copied

- category: redundant work | origin: proposer | status: proposed, not built (iteration 16) - cannot be graded as its own commit: no per-run counter can see a compiler-emitted copy and a profile line is not a grader primary; the exec.rs:855 copy already happens on a moved parameter, so inlining exec may only move it; judge net 1

## aos-draw-ahead-pool

- category: contention and parallelism | origin: proposer | status: closed (iteration 17, autonomous) on the lite reading - every rung about 4 percent below the baseline per explore-second in both chunks (depth>=8 0.9578, separated below at z 2.7) while its perf counters all held; the pool moves worker time from counted grid runs to uncounted AOS runs; patch kept at research/perf/patches/aos-draw-ahead-pool.spur.patch
- mechanism: the campaign's AOS arm on an ordered-release pool that may draw
  up to two batches ahead of the newest credited one while workers would
  otherwise idle; run ids, ctrl_rng draws (two per pick, weight-independent),
  per-run seeds, credit order and the once-per-batch recompute held; credit
  before issue, so nothing is drawn ahead at one worker; the seed batch never
  ahead; whole batches past the slice cap as StrategyArm runs them today (a
  600-run slice gives 608 AOS runs); drain credits and recomputes before
  run_slice returns.
- declarations: search-affecting (an ahead batch sees a bandit up to two
  recomputes and a population up to 120 insertions stale), shared saving.
- primary grid_pool.batched_worker_idle_ns per row, baseline over candidate,
  [2.3, 6.5]; AOS busy share [0.82, 0.95]; AOS runs per pool-second
  [1.20, 1.55]; runs per second [1.010, 1.070] regression only. Profile
  reference over every specialization, R_all = 28.70.
- owed: one-thread identity (VR, Mencius, caps-engaged 100,000) with
  drawn_ahead 0; a 30-thread smoke gate; profile; three or more rounds; the
  lite reading (2-4 cross-binary chunks under v3, deep guards held) plus a
  frozen AOS-arm hand reading of depth>=6 and depth>=8 per run at the 0.25
  margin, because the pooled guard dilutes an AOS-only change about
  eightfold - regressed refutes, unresolved goes to the user.
- note: its extra runs are AOS runs, which the lite per-second rung excludes.
- full record: tmp/loop/perf/it17-judgment.md (H1).

## timeline-store-one-lock

- category: contention and parallelism | origin: judge (split from a proposer's set-aside rider) | status: closed (iteration 17, autonomous) on its malloc guard - runs per second 0.9815 [0.9355, 1.0298] did not separate upward as the departure registered before the rounds required; counters exact, identity identical; patch kept at research/perf/patches/timeline-store-one-lock.spur.patch
- mechanism: GlobalTimeline's 128-shard DashMap with one live key read-locks
  every shard and allocates an Arc per shard in snapshot(), and read-locks
  all 128 again through len() in merge(); one lock over a map instead, a
  snapshot and a merge taking one lock each.
- price about 15-40 us per run (0.5-1.3 percent); no profile line or existing
  counter sees it. Neutral, shared. Counters exactly 1 snapshot and 1 merge
  lock per run; runs per second [1.000, 1.013], regression only.
- full record: tmp/loop/perf/it17-judgment.md (section 5).

## grid-pool-worker-continues

- category: contention and parallelism | origin: proposer | status: proposed, not built (iteration 17, autonomous) - ceiling about 1 percent after the judge's rewrite, below the round spread; most grid idle is capacity gating per the per-arm evidence; revisit only if per-arm idle on the current tree shows the dispatch round trip dominant
- judge: net 2; the claim that 40-80 percent of grid idle is dispatch is
  contradicted by the per-arm idle of the edb9e2f pool smoke (grid arm 17.6
  percent idle, post-fault arms under 3 percent - mostly capacity gating);
  band rewritten to [1.15, 1.75], runs per second [1.003, 1.020]; neutral
  (it keeps which runs may overlap and every decision; it only shortens the
  gap before a start); job wall must stop before the state lock; the unwind
  guard must run the passes.
- full record: tmp/loop/perf/it17-judgment.md (H2).

## worker-continues-with-aos-draw-ahead

- category: combined | origin: proposer | status: not built (iteration 17) - ties the AOS pool to an engine likely to close, loses the grid change's neutrality reading inside affecting rounds, and muddies attribution; judge net 2

## scheduler-probe-counters-folded-per-run

- category: contention and parallelism (inside the scheduler family) | origin: proposer | status: closed (iteration 18, autonomous) on its exec_plan relocation guard (2.39 against at most 2.32) - scheduler family down 3.77, counter in band every round, identity identical, but runs per second 1.0252 [0.9976, 1.0537] over six rounds missed the upward separation registered before the rounds by 0.0024; patch kept at research/perf/patches/scheduler-probe-counters-folded-per-run.spur.patch; eligible to return as a new candidate with freshly frozen guards
- mechanism: the eight direct shared-atomic leaves the scheduler family writes
  per step (three TIMER_CONTEXT_BIASED_* statics on one 64-byte line through
  record_timer_context_bias, crash timing bias examined / withheld, crash
  placement holds) move into the per-thread stats block, folded at run end.
- verified by the judge: 0.933 biased steps per step, two writes per call;
  crash timing 0.198 / 0.099, holds 0.213; the learner atomics are separate
  statics on other lines; only the reset list and snapshot builders read the
  moved statics (the campaign reward reads other leaves; slices finish every
  run before the after-snapshot); failed and panicking runs fold as the 35
  already-folded counters do, so identity runs must show runs_failed 0. The
  50-90 ns contended-write calibration holds; about 1.35 ownership transfers
  per step, not 2.38, so the expected F fall is [2.0, 5.5], not up to 9.
- frozen: folded_increments per step, baseline over candidate, [0.875,
  0.905] (per step, since a faster binary shortens runs); one-thread identity
  difference equal to the eight-leaf sum exactly; F falls at least 1.5 x r
  (plain-cycles candidate profile); exec_plan (RecordRng) self falls at least
  0.9 x r; runs per second [1.02, 1.07]; placebo read against 1.44 x r,
  outside [0.9, 1.1] referred.
- declarations: search-neutral, shared saving.
- full record: tmp/loop/perf/it18-judgment.md (H1).

## timer-bias-read-at-the-split

- category: algorithmic | origin: proposer | status: merged (autonomous, placebo referral read by the user) - spur c9c54fc, superproject 34394a6; scheduler family down 4.10 with no relocation into exec_plan; runs per second 1.0251; counters in band; post-merge baseline 8,120.3 cleared its revert line of 7,624; lite-log note on biased_steps written (a30af54)
- verified: multiplier() a pure read; the head-timer find side-effect-free on
  a timer queue; one roll then try_select on both paths, so draws match;
  neutral. biased_steps is the declared firing counter of the merged lite
  mechanism timer-admission-context-odds-probe and evaluate.ts stores every
  leaf, so the meaning change is written into research/lite/observations.md
  before merge. Band widened to [4.6, 5.3] per grid arm (replay children),
  [4.3, 5.6] session-wide; realistic saving 0.55-1.3 points.
- full record: tmp/loop/perf/it18-judgment.md (H2).

## unweighted-steer-counters-derived-at-fold

- category: redundant work | origin: proposer | status: held (iteration 18) - waits to ride with a returned scheduler-probe-counters-folded-per-run (both read through the folded_increments identity); alone it has no readable guard at 0.2-0.6 points
- exactness false as proposed: route_by_terms' consultation bump runs
  whenever the audit is enabled, including with steer_audit_always on; the
  bump is dropped only under audit enabled, no weighted predicate and not
  steer_audit_always. Under zero weights the derived values equal today's in
  every round. Realistic saving 0.2-0.6 points (the bumps are already
  thread-local).
- combined commit frozen: biased_steps per step as above, folded_increments
  per step [1.72, 1.85] combined, F falls at least 0.7 x r, runs per second
  [1.005, 1.025] regression only.
- full record: tmp/loop/perf/it18-judgment.md (H3).

## dead-slot-operands-moved

- category: allocation and memory traffic | origin: proposer | status: closed (iteration 19) - counter falsifier: value_move.taken 7,607 / 7,366 / 7,447 per run against [3,000, 6,500] in all three rounds (self_copies 1,533 in round 1 against at most 1,500); profile guards held; runs per second 1.0101, 1.0049, 0.9621, not separated; patch kept as research/perf/patches/dead-slot-operands-moved.A.patch; may return re-priced from these rounds
- mechanism: a decode-time per-function liveness pass (over labels reachable
  from each entry, on the post-coloring graph) emits Opnd::Take at top-level
  kept positions whose slot is dead after the op - Return, Async and SyncCall
  arguments, Send values, assignments - moving the value out and leaving Unit;
  under hashing a clone; self-copies left by slot coloring run as no-ops.
- verified by the judge: census reproduced exactly (Return 25/25, Async 57/57,
  SyncCall 24/24, 25 self-copies of 72); every later read of a moved slot
  exact (error paths, trace rows, parked records resuming, SyncCall frames,
  for-in slots, recovery rebuilds, debug tooling); Hash for Record reached only
  through State::signature, which no non-test code calls. Red team: for async
  arguments the stalled map-refcount increment moves into build_frame's second
  clone - that part lands only with rpc-frames-own-arguments.
- requirements: a NoHashing decoded-versus-label test (the existing one runs
  with hashing, where a move still clones); an independent read-after-move
  checker over every spec with a mutation it must reject.
- guards (profile at a 0.3 percent cutoff, all generic instances summed,
  against attribution-c9c54fc/fp-flat-0.3.txt: clone 3.06, value family 9.40,
  interpreter family 22.12): clone falls at least 0.6 x r; value family plus
  interpreter family falls at least 0.5 x r.
- declarations: search-neutral, shared saving.
- full record: tmp/loop/perf/it19-judgment.md (H1).

## rpc-frames-own-arguments-for-non-parking-callees

- category: allocation and memory traffic | origin: proposer | status: closed (iteration 19) - relocation guard G4 fired on its incremental profile over A: run_async_op + FrameBuilder::finish self +0.38 x r against at most +0.3, I +0.73 x r; patch kept as research/perf/patches/rpc-frames-own-arguments-for-non-parking-callees.AB.patch
- mechanism: for callees with no reachable Recv, Pause or SpinAwait, the
  frame is built from the arguments by move, initial_args stays empty and
  reset keeps the frame; the callee lookup moves before argument evaluation
  (no draw, a tally only).
- verified: every reader of initial_args and all five reset call sites; such a
  callee runs to Return inside one exec call (no step budget, errors abort the
  run, a sync callee that waits is an error), so every reset precedes its first
  step and the kept frame is what initial_args would rebuild. PrepareOK, Write,
  Read and monitor_timeouts can park; the rest cannot.
- owed: a crash / partition re-delivery test and a crash-heavy identity.
- full record: tmp/loop/perf/it19-judgment.md (H3).

## fstring-chains-appended-in-place

- category: allocation and memory traffic | origin: proposer | status: closed (iteration 19, autonomous) before profiling on its frozen counter bands - appends per print 2.05 (at least 2.4), in-place share 0.485 (at least 0.55), folds per print 1.22 (at least 1.5), grows 0.18 (at most 0.15), per-print ratios the graded rounds cannot move; identity identical; patch kept
- mechanism: an AppendLocal decoded op appends into a uniquely owned buffer
  (ecow push_str appends in place on a unique heap buffer and copies a shared
  one); a literal read only by the next append is folded; the move is skipped
  under hashing.
- verified: not a repeat of fstring-concat-once (it rewrites decoded ops, not
  labels; VR has 61 such sites and 23 heap-sized literals); the shared-literal
  refcount writes land on lines all 30 workers share; aliasing exact.
  False as proposed: 280-420 prints per run - print_content.presized reads 649,
  so the counter bands are rewritten as ratios to it (appends [2.4, 3.6],
  folded literals [1.5, 2.4]); the in-place counter uses the buffer address
  unchanged after push_str as its stand-in; tree-evaluation and borrow tallies
  replicated; integer additions on their own leaf.
- full record: tmp/loop/perf/it19-judgment.md (H2).

## value-moves-and-string-appends

- category: combined | origin: operator-agent (selection) | status: closed (iteration 19) - C closed on per-print counter bands before profiling, B on its relocation guard G4 over A, A on value_move.taken above band in all three rounds (runs per second 1.0101, 1.0049, 0.9621, not separated); nothing merged; patches kept for A, A+B and A+B+C
- one branch from c9c54fc, commits A (dead slots moved), B (RPC frames), C
  (string appends); identity and tests on each; one plain-cycles profile per
  stage read against the stage before at a 0.3 percent cutoff; a part whose
  guard fires on its own profile is reverted before rounds; three cross-binary
  rounds on the surviving stack, composite band [1.020, 1.058], regression
  only, each part's counters by hand. The wall cannot separate upward at this
  size, so any fired guard closes that part.

## struct-values-as-shaped-slices

- category: data layout | origin: proposer | status: merged (iteration 20, autonomous) - 215290a (spur 85af34d); runs per second 1.0705 [1.0324, 1.1100] over six rounds, separated upward under the departure registered after G1 missed by 0.08 x r; counter primary 10.30 [9.96, 10.66]; every ratio in band every round; placebo referred, user chose merge
- mechanism: ValueKind::Struct(&'static StructShape, EcoVec<Value>) for
  string-keyed map literals whose key set occupies distinct root slots of the
  imbl node (so every insertion order iterates and later updates identically);
  field reads resolve through the shape; store, erase, for-in, Eq, Ord, both
  signature policies, write_to, JSON and a hand-written Debug produce exactly
  the Map form's output, materializing a Map where needed.
- verified by the judge: ceval:207 is 1.95 points (23.1 percent of ceval);
  every VR key set gives one order under all insertion orders and distinct
  root slots; porcupine reads map values as an ordered pair list, traceanalyzer
  reads no maps; decoded_evaluation_matches_eval_* compare Debug text, so Debug
  must print Struct as Map; value_sig.leaf_hashes_deferred exists (3,905 per
  run) and is grader-pairable.
- primary: --counter value_sig.leaf_hashes_deferred, baseline over candidate
  [9.0, 16.0]; wall [1.030, 1.060] regression only; registered departure: if
  only a relocation sub-limit fires, merge requires upward separation within
  six rounds.
- guards (flat 0.3 report, r = R_cand / 18.90): ceval 8.44 falls at least 1.0
  x r; make_mut + compute_sig + Iter::next + drop_slow at most 0.90 x r;
  allocator 4.31 falls at least 0.2 x r; memmove 6.32 falls at least 0.1 x r;
  relocation family 34.74 falls at least 1.2 x r with sub-limits on clone,
  drops and the exec loops.
- declarations: search-neutral, shared saving. Judge net 6 (gain 8, cost 2).
- full record: tmp/loop/perf/it20-judgment.md (H1).

## delivered-record-borrowed-through-exec

- category: data layout | origin: proposer | status: closed (iteration 20) - incremental profile over A: memmove fell 1.76 x r2 but the scheduler family rose to 13.56 against at most 12.53, the exec loops to 14.77 against 14.37, and scheduler + loops + memmove rose 0.26 x r2 against a fall of at least 0.5 (also pop_waiting_reader and malloc + cfree); the copy cost relocated; patch kept as research/perf/patches/delivered-record-borrowed-through-exec.AB.patch
- mechanism: schedule_runnable owns the delivered record for the step; exec
  and exec_ops take &mut Record and return its disposition (park, requeue,
  finish), applied immediately; the queue layout is unchanged, answering why
  runnable-one-word-record's scheduler guard fired (the walks read link_seq,
  pc, node, origin_node, entry_pc, priority of every queued record).
- verified by the judge: 248-byte memcpy at scheduler.rs:1334, 1547, 1598,
  1766 and exec.rs:855 in the release objdump, none elided; the park copy
  credit removed. Same cost as delivered-record-not-copied, different
  mechanism.
- grading: deciding falsifier that the named copies are gone in objdump and
  the 248/240-byte copy count falls by at least 4; incremental profile guards
  against A (memmove falls at least 0.8 x r2; scheduler family and exec loops
  each at most +0.30; their sum with memmove falls at least 0.5 x r2);
  band [1.006, 1.014], no departure path.
- declarations: search-neutral, shared (unsure). Judge net 3 (gain 5, cost 2).
- full record: tmp/loop/perf/it20-judgment.md (H2).

## struct-slices-and-borrowed-records

- category: combined | origin: operator-agent (selection) | status: closed in part (iteration 20) - A (struct-values-as-shaped-slices) merged; B (delivered-record-borrowed-through-exec) closed on its incremental profile, the copy cost relocating into the scheduler
- one branch from c9c54fc: commit A (H1), commit B (H2); tests and one-thread
  identity on each; A profiled against the flat 0.3 report, B against A's
  profile plus the objdump check; a part whose guard fires is reverted before
  rounds; three rounds against c9c54fc (six only under A's departure rule),
  wall band [1.036, 1.075] with B, [1.030, 1.060] without.

## plan-bookkeeping-answered-on-change

- category: redundant work | origin: proposer | status: merged (iteration 21, autonomous) - c0a7f42 (spur c72bc78); every guard held (collect family 1.57 to 0.00 and lookup family 1.16 to 0.46 on a low-cutoff profile, exec_plan 3.17 to 2.69 raw); graded with B: runs per second 1.0607 [0.9635, 1.1677], no downward separation, counters exact every round
- mechanism: PlanEngine keeps a Ready count and a not-Completed count, exact
  under every transition once the dead mark_as_ready is removed; the per-step
  get_ready_events scan runs only when something is ready (same sort as
  today, same empty Vec otherwise), is_complete reads the count, and the
  delivery-name lookup at path.rs:1094 runs only with a pending delivery
  (never on this workload: the generator emits no Deliver or AllowTimer).
- verified by the judge: the Vec<NodeIndex> collect is get_ready_events (97.4
  percent from plan.rs:91); at most 18 plan nodes per run; no draw or order
  changes; steer_authority.steps_total exists (steps_used_sum + deadlocks).
  Reopens plan-engine-dense-status only in part: that commit also carried the
  node-env change, so its exec_plan rise was never pinned on the plan engine;
  G3 and G4 settle it.
- counters: exact scans + scans_skipped = steps_total, scans_empty 0,
  plan_deliver.lookups 0; scans / runs [0.95, 18]; scans / steps_total
  [0.0005, 0.015].
- guards (85af34d.md, r = scheduler family / 12.13): collect family 1.57 at
  most 0.30 x r; lookup family 1.16 at most 0.71 x r; exec_plan 3.17 at most
  3.47 x r; the three 5.90 at most 4.50 x r; malloc + cfree 2.25 at most 2.35 x r.
- declarations: search-neutral, shared. Wall [1.015, 1.030], regression only,
  no departure. Judge net 5 (gain 7, cost 2: release order and PlanComplete).
- full record: tmp/loop/perf/it21-judgment.md (H1).

## known-valid-text-and-literals-without-placeholders

- category: redundant work | origin: proposer | status: merged (iteration 21, autonomous) - c0a7f42 (spur 2da4e1a); every guard held (from_utf8 0.54 and from_elem 0.60 to 0.00 on a low-cutoff profile, drop_glue<Value> 1.14 to 0.47, ceval 8.75 against 8.84); graded with A, counters exact every round
- mechanism: (a) TextBuffer::str_from and (b) Decimal::as_str skip the UTF-8
  re-check on text valid by construction (documented unsafe, no debug
  assertion; release-built equivalence tests); (c) struct literals built in
  safe Rust without placeholder Units (with_capacity and in-place permute, or
  an Option buffer), sound when a field evaluation fails midway.
- counters: literals_in_order + literals_permuted = value_struct.literals;
  str_from_off_boundary 0; literals / frame.calls 0.375 +/- 0.01.
- guards on A+B against A: from_utf8 0.54 at most 0.10 x r and trace/write_to
  set 2.03 at most 2.13 x r (revert a, b); from_elem 0.60 at most 0.10 x r,
  ceval 7.90 at most 8.10 x r, EcoVec reserve + grow 0.48 at most 0.63 x r,
  drop_glue<Value> 1.14 at most 1.24 x r (revert c); malloc + cfree at most
  2.40 x r and net 12.69 at most 12.19 x r (revert all of B).
- declarations: search-neutral, shared. Alone [1.006, 1.011]; composite with
  A [1.021, 1.041]. Judge net 2 (gain 4, cost 2: text reaches Arrow arrays
  built unchecked and payload columns).
- full record: tmp/loop/perf/it21-judgment.md (H2).

## plan-bookkeeping-and-known-valid-text

- category: combined | origin: operator-agent (selection) | status: merged (iteration 21, autonomous) - c0a7f42; both parts merged as two spur commits after three rounds at 1.0607 [0.9635, 1.1677]
- one branch from 85af34d: commit A (H1), commit B (H2); tests and one-thread
  identity on each (VR 3,008, Mencius 2,160, crash-heavy, caps-engaged
  100,000; B also trace and log bytes); A profiled against 85af34d.md, A+B
  against A's profile with H1's guards re-checked; a part whose guard fires
  is reverted before rounds; three cross-binary rounds against 85af34d, no
  extension; composite band [1.021, 1.041].

## integer-dictionary-keys-by-value

- category: contention and parallelism (writer path) | origin: proposer | status: merged (iteration 22, autonomous) - 34bac84 (spur 39428ba on the vendored parquet ea14328); every guard held (Int64 and Int32 interners 2.07 to 0.000 on a low-cutoff profile, writer total 11.51 to 10.11); graded in the stack: busy ns per row 1.267, writers 64-66 percent busy with no blocking, runs per second 0.9957 [0.8566, 1.1573]
- mechanism: in a vendored parquet 58.0.0, integer dictionary keys come from a
  last-value memo and a direct table for values in [-1, 65,535) (indexed by
  value + 1) instead of hashing; values outside take the hash path; output
  bytes identical.
- verified by the judge: the interner, value encoders and gather copy are not
  reachable through the public API; an arrow dictionary array built on the
  producer side re-interns and changes bytes; the unmodified vendor builds
  offline with a two-line Cargo.lock change and byte-identical executions,
  logs and traces files on VR 3,008; unique_id and client_id reach -1 (range
  rewritten). Conditions: diff kept as a patch file, vendored tree equal to the
  registry copy outside patched files, `exclude = ["vendor"]` in the workspace.
- primary: --counter history_writer.busy_ns (refutes only; varied 3.4 percent
  between paired rounds on identical writers); busy ns per row, baseline over
  candidate [1.09, 1.20] read by hand every round; fast-path share at least
  0.97; at most 250 hashed values per command; runs per second [0.995, 1.02]
  regression only.
- guards (0b0004e.md, writer rows with r_w over untouched writer lines):
  interner rows 2.07 at most 0.30 x r_w (low-cutoff profile registered);
  relocation rows 1.60 rise at most +0.75; writer total 11.51 at most 11.51 x
  r_w - 1.0.
- merge rests on: busy ns per row in band, byte identity, guards, no downward
  separation. Worth merging without wall movement: four writers saturate near
  10,700 runs per second (about 84 percent busy at 9,000), blocking rises with
  every merge and falls only on the faster side of a comparison.
- declarations: search-neutral, shared. Judge net 4 (gain 6, cost 2).
- full record: tmp/loop/perf/it22-judgment.md (H1).

## page-statistics-from-first-in-page-keys

- category: contention and parallelism (writer path) | origin: proposer | status: merged (iteration 22, autonomous) - 34bac84 (spur ec5aa7a); every guard held (writer memcmp 0.95 to 0.54, the gather copy 0.110 to 0.000 on a low-cutoff profile, incremental writer total down 0.84 x r_w); str_stats compared per cell 0.33 and gather copies skipped 0.93 every round
- mechanism: while a string column's dictionary is active, page min/max are
  compared only for keys new to the page (a per-page bitset cleared on every
  page flush, including the one inside dictionary fallback); contiguous
  primitive columns skip the gather copy; output bytes identical.
- verified by the judge: every string cell is compared twice for page min/max
  today; statistics, chunk statistics, column index and 64-byte truncation
  identical under the rule; all four string columns non-nullable; fallback
  happens at a page boundary; the gather skip is sound. Size rests on an
  unmeasured cardinality mix (no evidence credit).
- band: H1 + H3 busy ns per row [1.13, 1.28]; H3's own share [1.04, 1.07] on
  its incremental profile; counters str_stats_compared / str_stats_cells
  [0.35, 0.60], gather_copies_skipped.
- declarations: search-neutral, shared. Judge net 2 (gain 4, cost 2).
- full record: tmp/loop/perf/it22-judgment.md (H3).

## program-text-without-shared-refcounts

- category: contention and parallelism | origin: proposer | status: part A merged, part B closed (iteration 22, autonomous) - A (trace names as &'static str) merged in 34bac84 (spur c302525): trace functions 1.37 to 0.58, writer_loop 0.72 to 0.50, the trace-name lock sites 0.686 to 0.000 on the census; B closed on its incremental profile (interpreter net missed by 0.05, new thread-local and program_text rows 0.64 against at most 0.15, decrement side 8.05 against 7.21, allocator 3.05 against 2.87); full-stack patch kept
- mechanism: (A) trace function names as &'static str from a compile-time
  interner, leaked at most once per distinct name per process; (B) string
  literals over 15 bytes cloned from a per-thread copy keyed by a per-build
  generation number (not the program's address).
- verified by the judge: the lock-census method (samples on the instruction
  after a lock prefix) is sound; trace-name contention 0.686 at every site;
  the literal figure is 0.738 (ceval+0x5ca0 is an EcoVec clone); B's cost
  moves into a thread-local lookup inlined into ceval, exec_ops and
  run_sync_ops, so its guard is a net guard over those families. Not a repeat
  of format-once-on-simulation-threads or trace-payload-escaped-in-one-pass;
  takes up fstring-concat-once's open lead.
- counters: literal clones per presized print [0.8, 1.6]; literal tables built
  at most rayon threads + 2 per session.
- guards (0b0004e.md, r over the scheduler family): trace functions 1.25 at
  most 1.25 x r - 0.35; ceval + exec_ops + run_sync_ops 21.66 at most 21.66 x
  r - 0.35.
- band: runs per second [1.005, 1.02], cannot separate; no counter primary
  exists, so the grader's shared-saving blocker stands and needs written
  clearance before merge.
- declarations: search-neutral, shared. Judge net 3 (gain 5, cost 2).
- full record: tmp/loop/perf/it22-judgment.md (H2).

## writer-headroom-and-program-text

- category: combined | origin: operator-agent (selection) | status: merged in part (iteration 22, autonomous) - 34bac84; vendor, H1, H3 and H2 part A merged as four spur commits after three rounds; H2 part B closed on its incremental profile
- one branch from 0b0004e: (1) unmodified vendored parquet 58.0.0 with the
  patch entry and workspace exclude, (2) H1, (3) H3, (4) H2-A, (5) H2-B.
  Byte identity of every parquet file plus one-thread table identity on each
  code commit; a plain profile per stage read against the stage before, with
  the registered low-cutoff profiles; a part whose guard fires is reverted
  before rounds; one set of 3-6 rounds against 0b0004e with --primary counter
  --counter history_writer.busy_ns, busy ns per row read by hand every round,
  H2's counters by hand.

## queue-eligibility-from-counters-2

- category: algorithmic | origin: proposer | status: merged (iteration 23, autonomous) - 7fad78b (spur c5ca8bf); scheduler family 14.68 to 9.75 raw on its own profile, the old count pass 0.000 on its low-cutoff profile; G1's symbol-text pattern matched the change's own per-node map (1.47) and a departure registered before rounds required upward separation, which six rounds gave: runs per second 1.0831 [1.0435, 1.1242]
- mechanism: when no reservations, FIFO links or strict timers exist (every
  step of all five graded arms: the generator emits no Deliver, VR.spur makes
  no fifo() call, strict_timers defaults false), only a Crash can be
  ineligible, and only in its own node's queue; per-queue eligibility counts
  are then queue lengths, and only a node whose pending crash is withheld (or
  that is down on a retargeting run) has its local queue walked; the per-step
  crashed-node Vec and link map clone go. Same counts, same draws, same order.
- verified by the judge: the walked-node rule matches every ineligibility site
  in scheduler.rs; dropping the Vec and clone is exact; answers the closed
  queue-eligibility-from-counters (which still built the eligible list every
  step): the count pass is the only full walk on 97 percent of selections.
  The proposer's census never engaged crash holds, and neither do the VR or
  crash-heavy identities; the caps-engaged 100,000 identity does (23,640,317
  holds), so it is required with those leaves nonzero and identical.
- counters: counted + walked = steer_authority.steps exactly (rewritten from
  steps_total, which runs a few hundred above steps); general_steps 0;
  walked at most crash-eligible steps; walked / crash-eligible [0.40, 1.00];
  walked elements per walked step [1.0, 6.0].
- guards (c302525.md, r = (ceval + EcoVec<Value> drop + format_escaped_str) /
  14.23): G1 eligibility-count fold row 1.88 at most 0.60 x r; G2 scheduler
  family at most (14.68 - 1.8) x r; G3 placebo + audit + memmove at most (9.52
  + 0.6) x r; G4 those plus F and exec_plan at most (27.61 - 1.6) x r;
  low-cutoff profile of commit A registered. A placebo rise counts against G3
  and G4 with no waiver; a placebo reading outside [0.9, 1.1] x 1.87 x r is
  referred to the user in either direction.
- declarations: search-neutral, shared. Wall [1.012, 1.030] regression only.
  Judge net 6 (gain 6, cost 0).
- full record: tmp/loop/perf/it23-judgment.md (H1).

## crash-scans-skipped-without-a-pending-crash

- category: algorithmic | origin: proposer | status: merged (iteration 23, autonomous) - 7fad78b (spur 9340a2e); scheduler family 9.75 to 8.81 on its profile against A, exec_plan and crash_hold_mask held; skipped share 0.816-0.829 and the exact identity every round
- mechanism: a count of nodes with a pending crash, moved only at the three
  sites where a node's pending count crosses 0 and 1 (state.rs:1144, 1180,
  scheduler.rs:2125); at zero the crash hold loop, crash defer loop,
  crash-anchor probe and crash-census scan are skipped, each drawing nothing
  and writing no counter or state on such steps (verified by the judge).
- counters: skipped + crash_anchor.steps_with_crash_eligible =
  steer_authority.steps exactly; skipped / steps [0.80, 0.88].
- guards on its profile against A's: scheduler family falls at least 0.5 x
  r2; exec_plan rises at most 0.2 x r2; crash_hold_mask rises at most 0.05 x
  r2. Stack against c302525: F + placebo + audit + memmove + exec_plan at most
  (27.61 - 2.2) x r.
- declarations: search-neutral, shared. Alone [1.004, 1.012]; stack [1.018,
  1.038]. Judge net 4 (gain 4, cost 0).
- full record: tmp/loop/perf/it23-judgment.md (H2).

## runnable-one-word-record-2

- category: data layout | origin: proposer | status: parked (iteration 23) - judge net 1; returns only on the merged H1 + H2 tree with a profile, a guarded list of every read behind the box (pending_deliveries_to walks the network queue on about 0.19-0.21 of steps reading node and origin_node; fresh_first_dispatch scans eligible network records with stats on), and a way to tell cache misses from store-forwarding stalls
- mechanism: Record, Timer and ChannelSend payloads behind a Box inside
  Runnable, priority inline, ownership by value; 41 fixed-size copies
  verified, "at most 4" a prediction.
- full record: tmp/loop/perf/it23-judgment.md (H3).

## eligibility-and-crash-scans

- category: combined | origin: operator-agent (selection) | status: merged (iteration 23, autonomous) - 7fad78b; both parts merged as two spur commits after six rounds at 1.0831 [1.0435, 1.1242]
- one branch from c302525: commit A (H1), commit B (H2); release tests and
  one-thread identity (VR 3,008, Mencius 2,160, crash-heavy 1,800,
  caps-engaged 100,000 with crash holds nonzero) at A and B, parquet
  byte-identical, exact identities; A profiled against c302525.md plus its
  registered low-cutoff profile, B against A's profile, the stack against
  c302525.md; a part whose guard fires is reverted before rounds; three
  cross-binary rounds against c302525, runs per second regression only.

## run-local-value-refcounts

- category: allocation and memory traffic | origin: proposer | status: closed (iteration 24, interactive, user) - value-refcounts-ab: runs per second 1.0091 [0.9544, 1.0671] over 3 rounds, no gain; one-thread cycles 0.969-0.982 against at most 0.96 (fired on every read); census Value family 10.36 to 0.105 and G1, G2 held; patch research/perf/patches/value-refcounts-ab.spur.patch
- mechanism: (A) ecow's EcoVec forked into spur-core with a plain, non-atomic
  count and no Send/Sync, used for Value sequences and env slots; (B) the
  string type forked the same way with immortal program literals (clone and
  drop compare, never write; uniqueness answers false as today), ValueMap and
  ChannelState vectors on imbl RcK, Option/Variant payloads and WaitingReader
  on Rc. A run's Values never leave its thread (verified by the judge:
  RunResult, AosChild, Individual, Seed, GridOutcome, history commands,
  RuntimeError, GlobalState, learner maps, util_stats hold none).
- verified by the judge: lock census E2 reproduces (Value family 8.10 points
  on c302525, 8.69 scaled); lock inc/dec 3.69 ns against 0.71 ns plain on this
  host; imbl 6.1.0 exports RcK with order and hashing unchanged; literal
  immortality keeps copy decisions. False: the proposer's 80.16 denominator
  (sim threads are 89.98). Literal set must also cover FieldGet names,
  Variant/IsVariant names in decoded form and ir.rs, ir.rs Expr::String,
  StructShape statics; the unsafe Sync names its invariant; a 30-thread
  release test asserts literal headers stay immortal.
- counters: value_refs.literal_clones = value_refs.literal_drops exactly,
  folded after State and PathState drop, [200, 20,000] per run;
  value_refs.shared_string_copies equal to baseline on identity sessions.
- band: runs per second [1.04, 1.07] for A + B; A alone [1.03, 1.05]; a
  reading in [1.03, 1.07] buys a layout control before deciding.
- observables: lock census Value-family rows at most 0.30 and total down at
  least 6.5 x r; one-thread sim-thread cycles per run on VR 3,008 at most 0.96.
- guards (r = scheduler reference 9.49 on 9340a2e.md, 0.3-cutoff profiles):
  G1 sequence drop falls at least 2.4 x r; G2 interpreter + value + allocator
  + memmove + pop_waiting_reader falls at least 3.5 x r.
- declarations: search-neutral, shared. Judge net 5 (gain 7, cost 2).
- full record: tmp/loop/perf/it24-judgment.md (1).

## register-ops-written-in-place

- category: data layout and representation | origin: proposer | status: proposed, not built (iteration 24) - the composite closed before C; returns only as its own candidate on its own evidence, and its size argument (1-3 points from the stall count) must be re-argued first
- mechanism: the decoded form (Op, CExpr, Opnd, ceval, run_common_op) replaced
  by flat register code: one op per vertex (vertex ids, pc transitions and
  label_execs unchanged), expression trees as post-order ranges of Copy
  instructions in ceval's order, a per-thread scratch with an unboxed i64 lane
  and a Value lane, heap temporaries moved into consumers, results written
  into their destination, errors out of band.
- verified by the judge: stall shapes at exec_ops 0x71679a and 0x715c04 in
  annotation; 11.46-point handoff arithmetic. Not supported in size: the
  proposer's own stli count (7.5e-4 per sim cycle) explains about 1-3 points.
  Ordering hole: Find's key would run before the collection kind check; a
  kind-guard instruction is required. compiled_expr.tree_evals is kept, not
  retired.
- counters: label_execs per steer_authority.steps [0.97, 1.03];
  register_ops.vertex_ops = label_execs exactly; tree_evals equal to baseline
  on identity; results_in_place / label_execs [0.55, 0.90];
  scalar_lane_nodes / tree_evals [0.20, 0.60]; slow_path_nodes 0 on VR.
- band: runs per second [1.02, 1.08], alone or over A + B.
- observables: one-thread stli_other per label from 0.211 to at most 0.10;
  one-thread cycles per run at most 0.98 over its base.
- guards: interpreter family + new symbols fall at least 1.5 x r; net family
  at least 2.0 x r; memmove and value family each rise at most 0.4 x r.
- declarations: search-neutral, shared. Judge net 3 (gain 5, cost 2).
- full record: tmp/loop/perf/it24-judgment.md (2).

## value-refcounts-then-register-ops

- category: combined | origin: user (direction: structural changes toward 10 percent) | status: closed (iteration 24, interactive, user) - A + B read 1.0091 [0.9544, 1.0671] and missed its one-thread cycles gate; C not built
- plan: research/perf/plans/value-refcounts-then-register-ops.md
- one branch from 9340a2e: commit A and B (run-local-value-refcounts), commit
  C (register-ops-written-in-place). Before building, a 0.3-cutoff profile and
  lock census of 9340a2e. Release tests and four-session one-thread identity
  (VR 3,008, crash-heavy 1,800, Mencius 2,160, caps-engaged 100,000 with crash
  holds nonzero) at each commit; A + B profiled against 9340a2e, C against A +
  B; a part whose own guard or observable fires is reverted before rounds.
- band: cross-binary runs per second [1.06, 1.15], central about 1.10;
  one-thread cycles per run of the stack at most 0.94 over 9340a2e.
- rounds: 3 cross-binary against 9340a2e with a layout control built first;
  6 only under a departure registered before round 1.
- falsifier: interval entirely below 1.06, any part's own falsifier, or any
  identity difference; on a refuted verdict the part whose observable did not
  move is closed.
- declarations: search-neutral, shared. Judge net 4 (gain 6, cost 2).

## workers-pinned-per-cache-domain

- category: contention and parallelism | origin: proposer | status: proposed (iteration 24) - rider only, never its own session
- mechanism: an explicit rayon pool whose start handler pins worker i to L3
  domain i mod D (15 per domain here), free to move within it; writers and
  coordinator unpinned.
- counters: placement.pinned_workers 30; placement.runs_crossed_domain 0.
- band: us per run [1.005, 1.030], regression only; instructions per cycle at
  least 1.008; run-queue wait per warm grid run at most 1.1 x baseline.
- declarations: search-neutral, shared. Judge net 2 (gain 2, cost 0).

## dead-slot-values-moved-into-destinations

- category: data layout | origin: proposer | status: proposed, not recommended (iteration 24) - 0.9-1.3 of its 1.2-2.0 points double-count run-local-value-refcounts
- mechanism: iteration 19's liveness moves dead local operands into their
  destination in the register code.
- band: over ranks 1 + 2 runs per second [1.003, 1.010], regression only.
- declarations: search-neutral, shared. Judge net 1 (gain 3, cost 2).

## record-bodies-in-a-recycled-slab

- category: allocation | origin: proposer | status: parked (iteration 24) - returns only with a field-by-field per-step read list against the 62 Runnable::Record( sites and a one-thread stli count of at least 3e-4 blocked forwards per cycle in memmove
- mechanism: Record split into a ~100-byte key and a body in a per-thread
  recycled slab; queues carry key plus u32 slot index.
- band: [1.005, 1.025], regression only.
- declarations: search-neutral, shared. Judge net 1 (gain 3, cost 2).

## grid-dispatch-on-finishing-workers

- category: contention and parallelism | origin: proposer | status: not built (iteration 24) - net 0; grid-pool-worker-continues stands; buys utilization, not cycles, on a heat-bound host
- declarations: search-neutral, shared. Judge net 0 (gain 2, cost 2).

## value-in-three-words

- category: data layout and representation | origin: proposer | status: closed (iteration 25, autonomous) - refuted on G4: clone family 3.90 to 3.82 against at most 3.33; G1 0.9564 (control 0.9988), G2 A 0.9908, B over A 0.9714, G3 identity exact; at 30 threads the saving shows in the interpreter and frame rows (-1.67); no rounds; patches research/perf/patches/value-in-three-words.spur.patch and value-in-three-words-A.spur.patch; returns only as a rider or with a fresh prediction read on a new profile
- mechanism: commit A (value-signature-storage-dropped): HashPolicy::Sig is
  () under NoHashing, Value<NoHashing> 32 bytes, readers call Value::sig().
  Commit B (wide-value-payloads-in-two-words): Struct as a u32 shape id,
  Channel and FifoLink packed into two words (role and index checked below
  2^32 at topology build, failures counted), Variant as (enum id, interned
  name id, payload), names resolved for Ord, text, JSON, Debug and the
  WithHashing signature; Value<NoHashing> 24 bytes.
- evidence: one-thread cycles on VR 3,008, prototypes P1 0.985, P2 0.967 (Arc
  variant form), identical-build control 1.006 with base always first; judge
  concedes P2 to about 0.973 for run position. Replaces the cost of
  value-without-dead-signature.
- verified by the judge: sig is 0 on every NoHashing path and read only
  through H::mix (0); Hash uses compute_sig_leaf_only, so map order is
  unchanged; shape interning is compile-time only; WithHashing is test-only.
  False: CLOCK_THREAD_CPUTIME_ID is a syscall here, not vDSO; counter bands
  written in the wrong direction; program.json is ir::Program, not CExpr;
  H2's 0.982 was a ratio of ratios (absolute 0.986); memmove did fall about
  0.8 at P2.
- primary: cross-binary runs per second, band [1.02, 1.05], inside the 0.05
  floor; run_cpu.sim_thread_ns rejected as a counter primary (a cost clock,
  not a mechanism count).
- gates before round 1: G1 B over 9340a2e one-thread cycles, ABBA x4 with a
  fresh layout control, at most 0.978 and at least 3 x the control's
  |1 - mean|; G2 A at most 0.992, B over A at most 0.990; G3 five-session
  identity at A and B plus program.json, topology_pack_failures 0; G4 on B's
  0.3-cutoff profile clone family at most 3.3 x r, drop rows rise at most
  0.4 x r.
- counters (description): value_layout.value_bytes 24,
  value_layout.topology_pack_failures 0, value_layout.variant_runtime_interns
  0 on VR; label_execs and frame.slots_built per steer_authority.steps in
  [0.99, 1.01].
- declarations: search-neutral, shared, no bit. Judge net 4 (gain 6, cost 2).
- full record: tmp/loop/perf/it25-judgment.md.

## value-signature-storage-dropped

- category: data layout | origin: proposer | status: closed with value-in-three-words (iteration 25) - G2 A 0.9908 held narrowly; patch research/perf/patches/value-in-three-words-A.spur.patch; rider only
- declarations: search-neutral, shared. Judge net 4 (gain 4, cost 0).

## wide-value-payloads-in-two-words

- category: data layout | origin: proposer | status: closed with value-in-three-words (iteration 25) - B over A 0.9714 held; G4 clone guard fired on the stack
- declarations: search-neutral, shared. Judge net 2 (gain 4, cost 2) - rewrites the Channel, FifoLink and Variant arms of history.rs JSON.

## runtime-error-behind-one-pointer

- category: data layout | origin: proposer | status: closed before build (iteration 25) - prototype read 1.016 cycles over the 24-byte Value, slower; Result<Value> handoff width is not a priced cost

## stores-skipped-and-temps-moved

- category: redundant work per step | origin: proposer | status: partly merged (iteration 26, autonomous) - commit A merged as stores-skipped-at-decode (spur b20ee37, superproject 359bdeb); commit B closed at G2 (B over A 0.9954 against at most 0.993)
- mechanism: CompiledProgram::build_with(program, Rewrites) runs whole-graph
  local liveness over cfg.graph. Commit A (stores-skipped-at-decode): a local
  store whose right-hand side is its own slot, or a slot or literal into a
  slot not live afterwards, becomes Op::StoreSkipped(next). Commit B
  (temps-moved-into-consumers): Return(Local) becomes ReturnTake (moves only
  when not EAGER and the frame is unique, otherwise clones and counts
  returns_cloned_shared); a temp read only by a single-predecessor next vertex
  as its whole Cond, Return or Print operand, dead after it, becomes
  Op::TempMoved and the consumer evaluates the tree. Vertex ids, transitions,
  label_execs, the IR and program.json unchanged.
- evidence: one-thread ABBA x4 on VR 3,008: control 0.9926; A-form 0.9565; full
  0.9413; B over A 0.9862. 30-thread prototype profile, r 1.0918: interpreter
  -3.53, value -3.06, clone rows -1.56 (unscaled interpreter -1.03). Identity
  exact on five sessions per the proposer (only the VR stack dumps kept).
- verified by the judge: no non-test reader sees a skipped store (trace
  capture, logs, history, parked frames, timers, crash and reset, persist,
  Debug, State::signature, coverage and timeline keys, node-env tokens);
  liveness sound across loops and entries; a failing run is discarded before
  reward, merge and row. Missed by the prototype: ReturnTake bypassed the
  uniqueness check. False: 27,606 rewritten per run (21,584; consumers counted
  twice); 9.3 percent independent composition (9.2). Control reused across
  both proposer sessions.
- primary: counter compiled_expr.leaf_operands_inline, baseline over
  candidate, band [1.22, 1.34] (A alone [1.11, 1.23]); runs per second
  description [1.04, 1.09], can only block.
- gates before round 1: G1 B over 9340a2e one-thread cycles at most 0.955,
  at least 3 x a fresh control's |1 - mean|; G2 A at most 0.968, B over A at
  most 0.993; G3 five-session identity at A and B with the leaf identity
  leaf(base) - leaf(cand) = stores_skipped + temps_fused exact, runs_failed
  equal, returns_cloned_shared 0; G4 on B's 30-thread 0.3-cutoff profile
  exec_ops at most 9.08 x r, clone rows 3.20 x r, interpreter + value 38.67 x
  r, memmove + allocator 12.89 x r, r retaken outside [0.95, 1.15]; G5
  release tests (loops agree with rewrites off, rewrites agree, independent
  read-after-skip checker rejecting three mutations, error-order test).
- merge: G1-G5 held, grader gain with zero blockers over six rounds,
  per-round counters in band, identity exact.
- declarations: search-neutral, shared, no bit. Judge net 5 (gain 7, cost 2).
- full record: tmp/loop/perf/it26-judgment.md.

## stores-skipped-at-decode

- category: redundant work per step | origin: proposer | status: merged (iteration 26, autonomous) - spur b20ee37; counter 1.1796 [1.1442, 1.2160] over six rounds, runs per second 1.0310 [1.0009, 1.0620]; G1 stack 0.9532, G2 0.9562, G3 exact, G4 held at r 1.0822, G5 passed; equal-work band not applied (narrower than the baseline's own variation)
- declarations: search-neutral, shared. Judge net 4 (gain 6, cost 2).

## temps-moved-into-consumers

- category: redundant work per step | origin: proposer | status: closed (iteration 26, autonomous) - G2 B over A 0.9954 against at most 0.993 (prototype priced 0.9862); patch research/perf/patches/temps-moved-into-consumers.spur.patch
- declarations: search-neutral, shared. Judge net 3 (gain 5, cost 2).

## stores-skipped-over-value-in-three-words

- category: combined | origin: proposer | status: not admitted (iteration 26) - composition finding: stack over 9340a2e 0.9349 against 0.9413 alone; value-in-three-words adds about 0.7 percent over the stores change; neither kept value patch earns rider credit over it without a direct same-session pair

## print-chains-written-into-the-log

- category: algorithmic | origin: proposer | status: merged (iteration 27, autonomous) - superproject c2497c5; counter tree_evals 1.2522 [1.2332, 1.2714] over six rounds, runs per second 1.1021 [1.0790, 1.1258] separated; G1 0.9401 (control 1.0098), G2 held at r 1.0689, G3 exact, G4 passed; blocked_ns clause exceeded with writer cost per run unchanged
- mechanism: at decode (Rewrites::On), a println chain - the maximal backward
  run of AssignLocal and StoreSkipped vertices ending in Print(Local(t)), every
  vertex after the first with one predecessor counting function entries - is
  symbolically evaluated into literal, string-copy and decimal pieces when every
  folded slot and t are dead after the Print, the chain holds a tree, and
  evaluation order equals piece order. Folded stores become Op::StoreFolded
  (compiled_ops.stores_folded); the Print becomes Op::PrintParts, which reads
  each piece once, checks kinds in evaluation order with base's exact error
  text, reserves the exact length and writes the log bytes directly
  (compiled_ops.prints_fused, compiled_ops.print_trees_folded). Vertex ids,
  transitions, label_execs, pcs, the IR and program.json unchanged.
- evidence: census 23,801 tree evaluations per VR run, 1,123 prints, string
  Plus 2,304, IntToString 1,507; one-thread ABBA x4 over b20ee37 0.9571
  (controls 1.0061, 1.0085, one build reused); 30-thread prototype profile r
  1.0544: ceval 9.68 to 7.33 (-2.35 raw), drop_glue<ValueKind> 3.05 to 1.65,
  EcoVec<u8> + Decimal -0.99, interpreter + value -3.90 x r; untouched rows move
  x1.04-1.16, so r does not flatter. Identity exact on VR; tree_evals ratio
  1.2295 on the identity mix.
- verified by the judge: only Logs and TestLogger implement Logger; log text
  is read only by the logs parquet; bytes identical for every piece kind
  (Decimal::of_i64 both paths, no escaping). Holes fixed in the rewrite:
  predecessors over graph edges only; StoreSkipped reuse breaks check.rs;
  concatenation-order checks differ from evaluation order in right-nested
  chains; the right-operand TypeError names "string". False: handles_not_cloned
  as a literal-clone observable (it counts borrowed reads).
- primary: counter compiled_expr.tree_evals, baseline over candidate, band
  [1.17, 1.31] (campaign-mix center 1.2405); every round tree_evals per
  label_execs [1.20, 1.28] and mix-free (tree_evals + print_trees_folded) /
  label_execs on the candidate [0.410, 0.420]; runs per second [1.01, 1.07]
  blocks only.
- gates before round 1: G1 one-thread cycles at most 0.966 and at least 3 x a
  fresh control's |1 - mean|; G2 on the 30-thread 0.3-cutoff profile ceval
  8.40 r, drop_glue<ValueKind> 2.40 r, EcoVec<u8> + Decimal 0.95 r, exec_ops
  9.50 r, interpreter + value + memmove + allocator 48.90 r, memmove +
  allocator 12.60 r (r over 11.03, retake outside [0.95, 1.15]); G3
  five-session identity with runs_failed equal and tree_evals(base) -
  tree_evals(cand) = print_trees_folded exact; G4 release tests, check.rs
  extended with four mutations, failing-chain and byte test.
- merge: G1-G4 held, grader gain with zero blockers, per-round checks in band,
  identity exact.
- declarations: search-neutral, shared, no bit. Judge net 4 (gain 6, cost 2).
- full record: tmp/loop/perf/it27-judgment.md.

## leaf-calls-on-a-stack-frame

- category: algorithmic | origin: proposer | status: not admitted (iteration 27) - priced slower: 1.0201 over b20ee37, 1.0190 over a slice-signature build; the stack frame's setup and second dispatch loop cost more than the heap frame

## frames-and-node-env-held-once

- category: allocation and memory traffic | origin: proposer | status: admitted, building (iteration 28, autonomous)
- mechanism: commit A (frames-and-arguments-held-once): a decode-time
  never-yield bit per function entry; State::frame_pool of up to 32 cleared
  unique buffers (SyncCall frames recycled after the call, handler frames when
  the record returns); async sends to a never-yield callee evaluate arguments
  into a pooled buffer and keep no initial_args; Record::reset keeps such a
  frame; all under !H::EAGER, frame_pool out of Debug and Hash. Commit B
  (node-env-detached-per-segment, re-opened): under !H::EAGER, Env::detach in
  exec_ops and exec_sync_on_node, written back on every exit including errors
  before the continuation runs.
- evidence: census (LD_PRELOAD, VR 3,008 runs) 11,550 allocations per run,
  about 4,850 of them removable; one-thread ABBA A 0.9711, B over A 0.9808, A +
  B 0.9509, control 1.0042; 30-thread prototype profile r 1.0236 (untouched
  rows imply about 1.032): value family -3.36 x r, EcoVec<Value> drop -2.22,
  allocator -1.55 (0.54 guaranteed, the rest cutoff crossings), frame build
  -0.97, make_unique -0.52; relocation run_async_op +0.63, Continuation::call
  +0.50, ceval +0.54, drop glue +0.27.
- verified by the judge: exec_ops consumes a record and requeues it only when
  it parks, which the never-yield bit excludes; a sync callee that yields
  raises an error; every one of five reset sites sees a record that never ran;
  the pool is per run; write tokens and sig stay exact at every read;
  shared_at_write 0 by construction. False: "every EcoVec<Value> make_unique is
  the node env" (Env::set's make_mut calls make_unique on local writes too).
  H1's argument half is the mechanism rpc-frames-own-arguments-for-non-parking-callees
  closed on in iteration 19 (relocation guard); the frame pool and the whole-A
  pricing are new.
- primary: cross-binary runs per second, band [1.03, 1.10]; frame.calls
  [1.010, 1.040] named as a check that the reset keep fired, not a credit. No
  existing leaf counts allocations, frame buffers, argument sequences or
  node-env copies. Stated in advance: a real 3-5 percent saving reads no-gain
  on the 0.05 floor and is held with its patch kept.
- gates before round 1: G1a one-thread cycles A + B at most 0.960 and at least
  3 x a fresh control's |1 - mean|; G1b B over A at most 0.990; G2 30-thread
  guards (guards28.py) value family 9.00 r, EcoVec<Value> drop 3.20 r,
  make_unique 0.60 r, frame build 1.35 r, allocator 4.20 r, relocation family
  16.45 r, ceval 8.40 r, drop glue 2.80 r, big family 47.00 r, memmove 8.80 r;
  G3 five-session identity with frame.calls(base) - frame.calls(cand) =
  resets_kept_frame exact and shared_at_write 0; G4 release tests (re-delivery
  at five reset sites, never-yield bit, pool, detach writeback).
- merge: G1-G4 held, grader gain with zero blockers over six rounds (runs per
  second separated upward from 0.05), per-round hand checks in band, identity
  exact; the only blocker that may be cleared in writing is frame.calls "did
  not move" with resets kept above 0 and runs per second separated.
- declarations: search-neutral, shared, no bit. Judge net 4 (gain 6, cost 2).
- full record: tmp/loop/perf/it28-judgment.md.

## timer-firings-without-heap-strings

- category: allocation | origin: proposer | status: lead (iteration 28) - about 1,500 allocations per VR run and 1.05 one-thread allocator points; returns with a one-thread ABBA of at least 1 percent and identical history bytes

## waiting-reader-without-a-box

- category: allocation | origin: proposer | status: lead (iteration 28) - 1,465 boxes per VR run and 1.59 one-thread memmove points; returns with a one-thread ABBA of at least 1 percent and an answer to record-bodies-in-a-recycled-slab
