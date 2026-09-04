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

## Admission (2026-09-04, moderated lane, iteration 37)

Judge evidence check: gain 5, cost 0. Verified: (a) DoViewChange 2->1 is a dead-incarnation record at delivery: node 2 sends SVC 2->1 and DVC 2->1 inside its StartViewChange handler at label 4 (VR.spur:299-330, new_primary->DoViewChange on SVC quorum), the DAG orders deliver_svc_1_to_2 -> crash_2 -> recover_2, and deliver_dvc_2_to_1 follows recover_2 via rec_2_to_1 -> svc_2_to_1 -> dvc_2_to_1, so origin_incarnation 0 != incarnation(node 2) = 1 at delivery.; (a) Chain order at node 1 per research/lite/plans/oracle-v2-epoch14.md table: 7 deliver_rec_2_to_1, 8 deliver_svc_2_to_1, 9 deliver_dvc_2_to_1, 10 w2. Ghost SVC acted, ghost DVC acted, then the request - as the plan says. Both ghosts write state at node 1: SVC(1) at a normal node in view 0 calls enter_view_change (status = 1, view_number = 1, VR.spur:239-243) and records the sender; DVC at the view-1 primary in status 1 writes do_view_change_senders and do_view_change_messages (VR.spur:332-345).; (b) scheduler.rs:1300-1302 computes ghost = fault_crossing(origin, origin_incarnation).then(|| node_state_token(dest)) and :1371-1372 calls state.note_ghost_delivery(dest, entry_step, before) after exec, on every message entry with no stats gate. state.rs:1092-1098 sets acted = env.writes != before and overwrites last_ghost_step / last_ghost_acted; clear_ghost_mark (state.rs:1101) is called on the crash path (scheduler.rs:1618). node_state_token is env.writes, a counter bumped on every state write (values.rs:684), so a handler that writes an unchanged value still reads acted an
False or corrected claims: 'Recovery 2->1, label 8': the Recovery 2->1 is label 7; label 8 is the ghost SVC 2->1 landing after it (oracle-v2-epoch14.md chain table). The substance (keying on the Recovery releases before the ghost pair) stands; the numbering does not.; 'Builds on the 64-step deferral merge (EXPIRY_STEPS = 64, bit 28 quartering dropped)': the research/lite tree at spur 327bf72 has EXPIRY_STEPS = 32 and no quarter; the merge is decided at iteration 36 but not landed.; Shares 'A 0.485, B 0.24, C 0.24': measured 0.469 / 0.235 / 0.233 with probes at 0.063; B's quoted depth-10 rate 0.00026 is the 32-step quarter's, the 64-step quarter reads 0.00033-0.00037. Neither changes the power argument's conclusion.; 'mean hold steps on C below 64 with C >= B on depth 10 excludes the longer-constant reading': false by construction - at the 0.30 event floor with a 128 cap the mean hold over all C releases exceeds 89, and a depth-10 excess of C over B can only come from releases after 64 steps.

Frozen prediction as admitted (replaces section 3 where they differ):

```json
{
 "treatmentBit": {
  "name": "clientEventRelease",
  "value": 268435456,
  "shift": 28,
  "nestedIn": [
   "clientFanoutRelease (262144)"
  ],
  "reuse": "row 268435456 renamed from clientDeferralLong (operator edit in decide.ts VARIANT_BITS; precedent bit 8388608)",
  "salt": "own (EVENT_SALT)",
  "treatedShareOfAllRuns": 0.233,
  "controlShareOfAllRuns": "B 0.235 (bit 18 set, bit 28 clear); A 0.469 (bit 18 clear, probe-free)",
  "probesExempt": "by inheritance from bit 18"
 },
 "precondition": "Built on the landed 64-step deferral (EXPIRY_STEPS = 64 on the whole bit-18 half, no bit-28 quarter); the tree at spur 327bf72 still reads 32, so the merge lands first or the fixed arm is not the arm iteration 36 merged.",
 "rung": "depth>=8 (epoch 14 primary), per-run ratio event arm / fixed arm, probe-free, co-bit matched within clientFanoutRelease = 1",
 "band": [
  0.94,
  1.06
 ],
 "bandNote": "null expected at the primary: label 8 is a server-side order at node 1 and request timing between A and B read 1.01 / 0.996 / 0.98 on this rung",
 "firing": {
  "counter": "client_anchor.event.released.event",
  "floorPerChunk": "event arm held >= 150,000 (the fixed arm holds about 259,000 per chunk on the same share)",
  "applicabilityGate": "released.event / held >= 0.30 on the event arm; below it the arm is a 128-step dose and the key reads are inapplicable",
  "also": [
   "fixed arm hold steps per released in [64, 66]",
   "event arm: hold steps per event-released request reported (median expected below 64); hold steps per released over all event-arm releases reported with no band (at the 0.30 floor it is at least 89 by construction)",
   "held_at_exit / held <= 0.1% on both arms (the fixed arm reads 0.025%; the event arm's 128 cap is the one at risk)",
   "released.dry_queue reported on both arms",
   "event census on all three arms: events_total, runs_by_events {0,1,2,3+}, first_event_step and first_ghost_acted_step histograms relative to the first crash {<16,<32,<64,<128,128+}, events_at_restarted_receiver; fixed and event arms within 5% of each other on events per run (their trajectories coincide until the first release); the immediate arm reported with no band (the fan-out census already differs 10% between the immediate and held halves)",
   "ready_after_last_event: held requests on the event arm whose ready step followed the run's last E (these run to the cap), reported",
   "same_origin_pair: E firings where the receiver's prior acted ghost came from the same origin incarnation as the firing entry, reported"
  ]
 },
 "advanceRungs": {
  "depth>=10": {
   "mergeClaim": false,
   "reading": "C/B per run pooled over four chunks, reported as the cap read: release timing in (64,128] after the ready step net of early false events. Not attributable to the key, because a release before 64 steps that follows the label-9 record is also covered by the fixed arm's hold on this rung. Expected >= 1.0.",
   "falsifier": "interval entirely below 0.90: early false events outnumber the tail, the second acted ghost is the wrong key"
  },
  "depth>=11": {
   "mergeClaim": true,
   "expected": "C/B per run >= 1.5 with the lower edge above 1.0 pooled over eight chunks (two four-chunk sessions on the same binary; the fixed arm reads about 40 depth-11 events per four chunks, so 1.5x separates at z about 2.9 at eight and 1.25x cannot be resolved at this size). Rationale: after the label-9 record acts, the new primary broadcasts StartView; label 11 needs the post-fault write's PrepareOK 2->0 to land at node 0 before StartView 1->0, so only a release soon after the record helps.",
   "extension": "the two sessions are queued from the start; a four-chunk read is a progress read, never a verdict"
  },
  "depth>=9": {
   "expected": [
    0.95,
    1.2
   ],
   "reported": true
  },
  "depth>=12": {
   "reported": true
  }
 },
 "controlChecks": "from the cells: B/A depth>=10 in [3.0, 5.0] (iteration 36 read 4.07); C/A reported; the fixed arm's depth>=10 rate in [0.00028, 0.00042] per run (the control moved otherwise)",
 "independentObservable": {
  "statement": "On a kept explore of both sessions, read with the ghost_census.py dump path: among event-arm runs at depth>=9, the share whose post-fault Write invocation on node 0 falls within 16 steps after the Enter of the label-9 record (DVC 2->1 at node 1) is higher than the fixed arm's share; reported with both shares and counts. Also reported: events_at_restarted_receiver / events_total on the event arm, and same_origin_pair / events_total."
 },
 "falsifier": "depth>=10 C/B interval entirely below 0.90 (wrong key: remove C, keep the axis code, record the E1 census); or released.event / held < 0.30 (inapplicable: file as a 128 dose read); or depth>=8 C/B outside [0.94, 1.06]; or plan_complete between arms more than 2 points apart; or steps per run between arms > 1.03x; or held_at_exit / held > 0.1% on either arm",
 "cost": "cross-binary throughput >= 0.97 of the paired cache; a read in [0.94, 0.97) with steps per run within 1.03x between arms and wall per step within 1% across arms is recorded as a layout read (iteration 33's three-slot counters read 0.942 and were not the merging binary), below 0.94 refutes; the hook adds three integer compares at an existing site",
 "decisionMap": "depth>=11 claim met at eight chunks and depth>=10 not below 0.90 -> C stays as an arm beside A and B; depth>=10 entirely below 0.90 -> remove C, keep the axis code and the census; applicability gate failed -> file as a 128 dose read on the fixed arm's length line; depth>=11 straddling at eight chunks with depth>=10 >= 1.0 -> file as 'key unresolved at this rung's counts', C kept as an arm only by operator decision under the per-cell panel plan",
 "grading": "start --treatment-bit 268435456 --band-min -0.06 --band-max 0.06, two four-chunk sessions on the same binary pooled by cell counts",
 "rewritten": true
}
```

Implementer watch: [
 "Land the 64-step merge first (EXPIRY_STEPS = 64, quarter code removed) and build on it; the research/lite tree is at 32. The fixed arm must be the iteration-36 arm or the B/A control check and the [64, 66] clause do not apply.",
 "Detect E inside note_ghost_delivery before the mark is overwritten: acted && origin_restarted && l.last_ghost_acted, with origin != receiver. Use r.origin_incarnation != state.incarnation(origin) for origin_restarted, computed before exec next to the ghost token at scheduler.rs:1300; the compare is already ungated.",
 "Add the two cheap census counters the judge relies on: same_origin_pair (store the last acted ghost's origin and incarnation in the SendLedger) and ready_after_last_event; without them a depth-10 read below 1.0 cannot be told apart between the RR-ghost misfire and node-0 firings.",
 "Before or alongside the grade, run ghost_census.py over depth>=8 runs of a kept explore and count runs whose RecoveryResponse 2->1 Enter at node 1 is after crash_2's step; that is the share of the chain population on which E fires one label early.",
 "The 128 cap is the only depth-10 channel; do not read a depth-10 gain as the key. Queue both four-chunk sessions from the start since the key's claim is on depth>=11.",
 "Per-arm counters are three-slot statics like iteration 33's; expect a cross-binary throughput read near 0.94-0.97 for layout and read cost by steps per run and wall per step across arms as well.",
 "Probes must stay Immediate (arm(run_id) returns Immediate for run-cap and timer-context probes); extend run_variant.rs tests so bit 28 implies bit 18 and never a probe bit.",
 "Renaming decide.ts row 268435456 to clientEventRelease is an operator edit at admission, not candidate scope."
]

## Pre-grade census (2026-09-04, implementer smoke, 47,360 runs)

The event as built fires in about 4 percent of runs on every arm (the
detector is arm-blind: 0.039, 0.043, 0.042 events per run); on the event
arm released.event over held is 0.020, far under the 0.30 applicability
floor, so the arm will grade as a 128-step dose read (the prediction's
"inapplicable" branch), which is itself the length line's next question.
Where it fires, 79 percent of first events fall within 64 steps of the
first crash and 78-84 percent of firings are same-origin pairs, the ghost
RecoveryResponse then the ghost StartViewChange at the recovered peer,
one label before the DoViewChange the chain needs. Hold steps per released
on the event arm 126.8 (19.5 on event releases); held_at_exit over held
0.109 percent, at the falsifier's 0.1 percent edge. Tests 431 passed. The
grade proceeds for the dose read and the eight-chunk census; the next arm
should key on the second acted ghost at a restarted receiver, or on the
first acted ghost whose origin differs from the previous one, which the
same-origin counter now measures.
