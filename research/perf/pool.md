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
