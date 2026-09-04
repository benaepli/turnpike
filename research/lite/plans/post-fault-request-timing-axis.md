# post-fault-request-timing-axis

Iteration 37 candidate, epoch 14. Builds on the 64-step deferral merge
(EXPIRY_STEPS = 64, bit 28 quartering dropped). Written by a planning
agent on 2026-09-04 under the user's direction: strategies as arms, read
per cell.

## What changes

Post-fault request timing becomes a three-arm axis drawn per run. Arm A,
immediate issue, is today's control. Arm B, fixed deferral, is today's
treated half: hold, release at 64 steps or a dry queue. Arm C, event-keyed
release: hold, release when the run's event fires, with a cap as fallback.
The bit-18 half keeps its salt and population; a second salt splits that
half into B and C, exactly as bits 27 and 28 quartered it before.

## 1. The event for arm C

Correction to the brief. In research/oracle/bug.md steps 3-4 the peer
(DAG node 2) sends StartViewChange and DoViewChange to the new primary
(node 1) and then crashes; the DAG edge deliver_svc_1_to_2 -> crash_2
encodes the same order. So the DoViewChange whose acting the request must
follow is a dead-incarnation record: origin_incarnation !=
state.incarnation(origin) at delivery. The new incarnation's records
(Recovery 2->1, label 8) act at node 1 before the ghost pair; keying on
them would release at depth 8, ahead of the transition the deferral
buys, and C would read below B. The event therefore admits only records
whose sender restarted after sending them.

Second, the chain's order at node 1 is ghost SVC acted, then ghost DVC
acted, then the request. A release on the first acted ghost is what the
iteration-31 anchor did (plus a fan-out condition); iteration 33 graded it
as ornament and named "the second-acted-ghost anchor" as the alternative.
So the event is the second one:

E fires at step s when a message entry at live receiver R from origin O
!= R has origin_incarnation != incarnation(O), the post-exec token
compare shows node_state_token(R) changed, and R's SendLedger already
had last_ghost_acted == true (an earlier fault-crossing entry acted at R
since R's own last restart; clear_ghost_mark resets it at crash).

Protocol-neutral statement: some live node has now acted twice on
messages from incarnations that no longer exist.

Hook: scheduler.rs computes ghost = Some(before) at about line 1300
and calls state.note_ghost_delivery(record_dest.index, entry_step,
before) after exec (about line 1372). Add an origin_restarted: bool
argument computed before exec, and inside note_ghost_delivery
(state.rs:1094) detect E from acted && origin_restarted &&
l.last_ghost_acted before overwriting the mark; write
state.client_anchor.events += 1, last_event_step, and
first_event_step (client_anchor::RunState). "Restarted during this
run" is incarnations[O] > 0, per-run state bumped at
scheduler.rs:1703. Also record the first-acted-ghost step (E1) in the
same RunState for the census only, so the read can say whether E1 would
have released earlier.

Held requests: E releases every held request (post_fault_client_ops is
1 on the loop config, 2 on one grid arm). Requests that become ready
after an E are held again until the next E or the cap. Release order is
ready order, as today.

Cap: EVENT_CAP_STEPS = 2 * EXPIRY_STEPS = 128, not 64. With a 64 cap C
is B minus the runs the event pre-empts, and the contrast could not tell
"the event is the right key" from "64 is the right length". At 128,
released.expiry / held on C measures how often the event never comes,
and mean hold steps on C below 64 with C >= B on depth 10 excludes the
"longer constant" reading (the dose line's next test is 128 against 64;
this design reports it as a side read, not as its claim).

Arm D (release-before): a plan gates when a request becomes ready and A
already issues at that step; nothing earlier exists on this axis. Issuing
"ahead of the recovered node's first message" is a dispatch preference on
the client record's priority in State::push_runnable, a different axis.
Not an arm here; the panel's per-cell A read is the inverse side of B and
C.

## 2. Encoding and shares

Hold half: salted_phase(run_id, CLIENT_ANCHOR_SALT, 2) == 1, unchanged,
tagged bit 18 (CLIENT_FANOUT_RELEASE). Within it, salted_phase(run_id,
EVENT_SALT, 2) == 1 selects C, tagged bit 28 (268435456), renamed in
decide.ts VARIANT_BITS from clientDeferralLong to clientEventRelease
(the bit-8388608 rename is the precedent). Bit 28 is set only with bit
18, probes exempt by inheritance. Bit 12 is the fallback, but the
decide.ts selftest fixture uses 4096 as its "not on the roster" value,
so 12 costs an operator edit there.

This is bit-within-bit, the nesting probeFreeScope plus invariantCoBits
handles: declaring bit 28 gives C against B matched (control = bit 18
set, bit 28 clear). Bit 18 reads hold (B+C pooled) against A. C against
A and B against A come from the cells, the way iteration 33 read its
quarter-versus-control rows. An encoding with B and C as independent
salts would let a run be both and break exclusivity; a two-bit encoding
with 18 meaning B only would give bit 28 a mixed A+B control. Shares:
A 0.485, B 0.24, C 0.24 of all runs. At about 2.4M runs per four chunks:
B about 150 depth-10 events (0.00026 per run), C 150 if equal, A about
105 (0.00009). C over B separates at 1.5x at four chunks (z about 3.4);
1.25x needs eight, as the length contrast did.

## 3. Counters and frozen prediction

util_stats.rs client_anchor block, indexed by arm {immediate, fixed,
event}: runs, completed_runs, population, post_fault_invocations, held,
released.{event, expiry, dry_queue}, hold_steps_sum, held_at_exit,
runs_with_held_at_exit. Event census on all arms (the detection runs on
every run; only the release differs): events_total, runs_by_events {0, 1,
2, 3+}, first_event_step histogram relative to the first crash {<16, <32,
<64, <128, 128+}, first_ghost_acted_step in the same buckets,
events_at_restarted_receiver. Fan-out windows stay as they are.

Frozen prediction (declared bit 268435456, probe-free, matched within
bit 18):

- Firing per chunk: event arm held >= 150,000; released.event / held >=
  0.30 (below this C is a 128-step dose and the read is inapplicable);
  event arm hold steps per released in [20, 64]; fixed arm hold steps per
  released in [64, 66]; held_at_exit / held <= 0.1% on both; dry_queue
  reported; runs_by_events on the immediate arm within 2% of the fixed
  arm (the detector is arm-blind).
- Primary depth>=8 C/B per run in [0.94, 1.06], null expected.
- Decisive: depth>=10 C/B >= 1.25 with lower edge above 1.0 pooled over
  four chunks; straddling, extend to eight and apply the same rule.
  Control checks from the cells: B/A depth>=10 in [3.0, 5.0] (iteration
  36 read 4.07); C/A reported.
- depth>=9 reported, expected [0.95, 1.20]; depth>=11 reported.
- Independent observable: mean hold steps on the event arm below 64
  while C >= B on depth 10.
- Falsifier: depth>=10 C/B interval entirely below 0.90 (the second
  acted ghost is the wrong key; keep B, record E1 census); or
  released.event / held < 0.30; or depth>=8 C/B below 0.94; or
  plan_complete more than 2 points apart; or steps per run > 1.03x;
  or held_at_exit / held > 0.1%.
- Cost: cross-binary throughput >= 0.97 of the paired cache; wall per
  step within 1% across arms (the hook adds three integer compares at an
  existing site).
- Decision map: merge claim met -> C stays as an arm beside B (the axis
  keeps all three); refuted -> remove C, keep the axis code; inapplicable
  -> file as a 128 dose read.

## 4. Generality

Rule: a request that becomes ready after a fault waits until some live
node has acted twice on messages from incarnations that no longer exist,
or until a cap. Inert when a run has no restart (no dead incarnation; C
runs to its cap and is a longer B), and on protocols that reject stale
messages without writing state (term-guarded Raft handlers), where the
count never reaches two. The per-cell panel read shows the bias: a member
whose bug needs an early post-crash request reads highest in the A cell
and lowest in B and C; a member needing the drain reads C >= B > A; an
inert member reads flat across the three cells with events_total near
zero.

## 5. Risks

- C degenerates to B: if the event rarely fires before 128, C is a dose
  read. The 0.30 floor and the hold-steps read make this visible.
- Several restarts: node 0 can also act on two ghosts (SVC 1->0, 2->0)
  and fire E before node 1 does; the oracle wants those after w2, so such
  a release is early for the chain. events_at_restarted_receiver counts
  the split; narrowing R to restarted receivers is the next arm, not this
  one.
- Dry-queue release: unchanged and reported; it fires about 1 in 5,000.
- Depth 8: label 8 is the order of two server records at node 1; the
  hold touches only the client's request, and every downstream label of
  w2 is after it in the DAG. The request-side deferral read 1.01 (iter
  31), 0.996 (33), 0.98 (36) on depth 8. Iteration 32's hold was on the
  Recover, a chain event, which inverted labels 7/8 and halved depth 8.
  Nothing here holds a server event.

## 6. Implementation map

- spur/spur-core/src/simulator/client_anchor.rs: enum Arm {Immediate,
  Fixed, Event}, pub fn arm(run_id) -> Arm (probes always Immediate),
  EVENT_SALT, EVENT_CAP_STEPS, Release::Event, HoldQueue::take_due(step,
  cap), HoldQueue::take_all_event(), RunState fields (events,
  last_event_step, first_event_step, first_ghost_acted_step), pure
  event_fired(acted, origin_restarted, prior_acted) -> bool. Unit tests:
  arm shares 0.485/0.24/0.24, Event implies hold half, probes exempt,
  same id same arm, queue tests for event release and the 128 cap.
- core/state.rs: note_ghost_delivery gains origin_restarted and
  updates client_anchor RunState.
- core/scheduler.rs: two-line change at the ghost hook (about 1300 and
  1372) to pass the flag.
- path.rs: exec_plan takes client_anchor::Arm; hold when arm !=
  Immediate; per step, on the Event arm, if state.client_anchor.events >
  seen { due.extend(held.take_all_event()) }; cap per arm; counters
  indexed by arm.
- explorer.rs (about line 1122): pass client_anchor::arm(run_id).
- run_variant.rs: CLIENT_EVENT_RELEASE = 1 << 28, set iff arm == Event;
  tests extended.
- util_stats.rs: per-arm statics and struct;
  tests/util_stats_export_completeness.rs mirrors the new leaves.
- tests/client_anchor_release.rs: third session on Event-arm ids; every
  release is event, expiry or dry; event releases waited under the cap;
  events counted; invocations exact; untreated sessions unchanged.
- research/orchestrator/src/decide.ts: rename row 268435456 (operator).
- Do not touch exec.rs, history.rs, campaign.rs, the campaign block of
  general_vr.json, or fanout_window.

Size: about 400 lines net including tests; one implementer session.

Grading: start --treatment-bit 268435456 --band-min -0.06 --band-max
0.06, four chunks, extension per the prediction.
