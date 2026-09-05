# Run 61138 (lite-cycle-before-request, seed 1000, grid-short config 50): lost write uid 1

## Classification: PAPER BUG - this is the target bug (VR-Revisited view change vs. recovery), reached by a near-oracle path

One-paragraph mechanism. In view 13 (primary node 1) node 2 times out, sends
StartViewChange(14) and crashes two steps later (398-400). Node 0 receives that
ghost StartViewChange at 407, enters view change 14 and sends DoViewChange(14,
log=ops 1-2, n=2) to node 2; then node 0 itself crashes at 413. Both nodes
recover through section 4.3 and come back NORMAL IN VIEW 13 (node 2 at 425 with
n=2; node 0 at 440 with n=3, having fetched op 3 = write uid 1 from the
primary). Node 0's recovered incarnation sends PrepareOK for op 3 (440); the
primary commits it (444) and the client is acknowledged (449). Node 2's new
incarnation times out again, re-enters view change 14 (454), receives the ghost
DoViewChange from node 0's dead incarnation (466), then a fresh StartViewChange
from node 0 (479) which completes its StartViewChange quorum, and at 484 counts
{ghost DVC from node 0, own DVC} as f+1 DoViewChange "from different replicas"
and installs view 14 with log = ops 1-2. The fresh DoViewChange from node 0's
live incarnation carrying op 3 (480) is dropped as a duplicate sender. StartView
truncates op 3 everywhere: the acknowledged write uid 1 is gone from the log,
and reads in view 14 return [10, 11]. Node 0 forgot that it had promised view 14
(volatile status), recovered into view 13, helped commit op 3, and its stale
promise was still honored - exactly research/oracle/bug.md steps 1-7.

Not the nonce bug: each node recovers exactly once (node 2 nonce 1 at 402, node
0 nonce 1 at 414), every RecoveryResponse accepted (traces 163/164, 173/176) was
addressed to that single incarnation; the spec is the fixed one (VR.spur:95-97
retrieve/persist the nonce). Signature ea076ff71851ec53 is new.

## 1. The violating operations (kv model: value = ordered list of committed uids)

Writes, all key1:
- uid 1: client 3, invoked step 0 -> node 2, redirected, accepted by node 1
  (primary v13) as op 3 at 409, committed 444, RESPONSE 449.
- uid 10: client 6, invoked 415 -> node 0, accepted by node 2 (primary v14) as
  op 3 of view 14 at 491, response 510.
- uid 11: invoked 450, op 4 of v14, response 516. uid 12: invoked 511, op 7 of
  v14, response 543.

Reads:
- uid 9 (client 11): invoked 0, RESPONSE 550 = [10, 11]. First unlinearizable
  response: it contains 11 (so its linearization point is after Write 11's
  invocation at 450, by which time Write 1 had completed at 449) yet omits 1.
  An append-only list can never drop a completed write. uid 6 (client 8):
  response 553 = [10, 11], same defect.
- uid 7 (client 9): response 586 = [1, 11, 12], served by node 0 as primary of
  view 15 (op 8, executed 583): omits uid 10 (completed 510) while containing
  12 (invoked 511). uid 5 (client 7): response 713 = [1, 11, 12] from node 1
  (primary v19, op 12).
- uids 2, 3, 8: responses 634, 654, 674 = [10, 11, 12] from node 2 (primary v17).
The replicas hold two different histories for the same key; no sequential
order fits either the [10, 11] reads or the [1, 11, 12] reads.

## 2. Mechanism, step by step (node ids; trace numbers in parentheses)

1. 383-396: view 13 normal, primary node 1; ops 1 and 2 (logged reads) are
   committed at all three nodes.
2. 398: node 2 times out at v13, enters view change 14 (it is primary_of(14)),
   sends StartViewChange(14) (156 -> node 0, 157 -> node 1). 400: node 2
   crashes with both undelivered. 402: RecoverInit, nonce 1, Recovery (160 ->
   node 0, 161 -> node 1). 405/406: node 1 answers with log ops 1-2, n=2, k=2;
   node 0 answers nil (backup).
3. 407: node 0 (normal v13) receives ghost SVC 156. VR.spur:310-316 enters view
   change 14 and sends SVC (165 -> node 1, 166 -> node 2); with senders {self,
   node 2} = f+1 it sends DoViewChange(14, ops 1-2, v'=13, n=2, k=2) (167 ->
   node 2). All three sit in the network.
4. 409: node 1 accepts write uid 1 as op 3, Prepare (168 -> node 0, 169 ->
   node 2). 411: node 0 is in status view-change, Prepare ignored
   (VR.spur:186). 412: node 2 is recovering, ignored.
5. 413: node 0 crashes; 414: RecoverInit nonce 1, Recovery (171 -> node 1,
   172 -> node 2). 415: node 1's RecoveryResponse (173) carries ops 1-3
   (uid 1 at op 3), n=3, k=2. Client write uid 10 arrives at node 0 (415).
6. 423/425: node 2 receives 163 and 164 and completes recovery: view 13,
   n=2, k=2 - the pre-op-3 snapshot. 424: ghost SVC 166 reaches node 2 while
   status is recovering and is DROPPED (VR.spur:305). Node 2 is now normal in
   view 13 with no memory of its own view change.
7. 434/435/440: node 0 receives 176 (node 2, nil) and 173 (node 1) and
   completes recovery: view 13, n=3, k=2, log includes uid 1; per
   VR.spur:527-532 it sends PrepareOK(13, 3) (177). 444: node 1 counts
   {self, node 0} = quorum, commit_number 3, executes WRITE uid 1, sends
   Commit(13,3) (178). 449: Write uid 1 acknowledged. 450: node 0 commits and
   executes op 3. Node 0 has now both promised view 14 with n=2 (ghost 167 in
   flight) and prepared and committed op 3 in view 13.
8. 454: node 2 times out again, enter_view_change(14) resets its sender sets
   (VR.spur:243-269), sends SVC (180 -> node 0, 181 -> node 1).
9. 466: ghost DVC 167 delivered to node 2: primary_of(14) == self, view 14,
   status view-change -> accepted; do_view_change_senders = {node 0}.
10. 471: ghost SVC 165 reaches node 1 -> node 1 enters view change 14, sends
    SVC (188, 189) and DVC(14, ops 1-7 incl. uids 1, 11, 10, v'=13, n=7, k=3)
    (190 -> node 2). 475: node 0's live incarnation receives SVC 188 -> view
    change 14, SVC (191, 192), DVC(14, ops 1-3 incl. uid 1, v'=13, n=3, k=3)
    (193 -> node 2).
11. 479: fresh SVC 192 at node 2 -> senders {self, node 0} = f+1 -> node 2
    sends its own DVC(14, ops 1-2, n=2, k=2) (194 -> self).
12. 480: fresh DVC 193 (n=3, uid 1) arrives at node 2 -> REJECTED at
    VR.spur:341-343, `exists(do_view_change_senders, node 0)` is already true
    from the ghost.
13. 484: own DVC 194 -> senders {node 0, node 2} = f+1. Both messages have
    v'=13, n=2, so best_log = ops 1-2, commit 2. enter_normal_mode(14) and
    StartView(14, ops 1-2, 2, 2) (195 -> node 0, 196 -> node 1, 197 -> self).
    Op 3 (uid 1) is truncated. 527: node 1's DVC 190 arrives, ignored (status
    normal).
14. 491-543: node 2, primary of 14, assigns uid 10 -> op 3, uid 11 -> op 4,
    reads -> ops 5, 6, uid 12 -> op 7; node 1 sends PrepareOKs (502-503);
    commits at 506, 512, 538. 494/508: nodes 1 and 0 install the 2-entry log
    but enter_normal_mode (VR.spur:271-300) leaves applied_op_count=3 and
    kv_store=[1] as they were, so they never apply the new op 3 (uid 10) and
    end at [1, 11, 12]; node 2 ends at [10, 11, 12].
15. Reads at 550/553 (node 2, ops 5-6 of v14) return [10, 11]; 586 (node 0,
    primary v15) [1, 11, 12]; 634/654/674 (node 2, primary v17) [10, 11, 12];
    713 (node 1, primary v19) [1, 11, 12].

No ghost Prepare, no split-brain, no stale-read shortcut: the reads are logged
operations executed on committed state (VR.spur:595-600, 130-180). The commit
of op 3 had a real quorum {node 1, node 0}. The fault is the view-14 quorum
built on a dead incarnation's DoViewChange.

## 3. Comparison with the oracle chain (research/oracle/relax_minimal_general_v2.json)

Role map: NL = node 2 (primary of the new view 14), OL = node 1 (primary of
v13), oracle "node 1" = node 0, old view = 13.

In order: w1 (write uid 1 pending) -> allow_t1 (node 2 timer 397/398) ->
crash_nl (400) -> recover_nl (402, complete 425 in the old view with
RecoveryResponses from OL and node 0 = deliver_rr_1_to_2 / deliver_rr_0_to_2)
-> deliver_svc_1_to_2 (ghost SVC 156 to node 0 at 407; node 0 answers with SVC
and DVC to NL, both delayed) -> crash_2 (413) -> recover_2 (414, complete 440
in the old view; deliver_rec_2_to_1 at 415) -> w2 (op 3 committed in the old
view with deliver_pok_2_to_0 = PrepareOK 177 at 444 from the recovered node 0
to OL; ack 449; further writes 10 and 11 at 415/450) -> deliver_dvc_2_to_1
(ghost DVC 167 at 466) -> deliver_svc_1_to_0 / deliver_svc_2_to_0 (SVCs to OL at
471 and 504) -> deliver_sv_1_to_0 (StartView 195/196 at 508/494) -> r1..r3
(reads 550 onward). Nineteen of the twenty labels occur in an order the DAG
admits.

The one departure: deliver_svc_2_to_1 (the ghost SVC from node 0 to NL). It
was delivered at 424 while NL was still recovering and was dropped. Its role
was taken by NL's own second timeout at 454 plus the fresh SVC 192 from node
0's live incarnation at 479. The ghost DoViewChange then did double duty: it
supplied the stale log and, by claiming node 0's sender slot, blocked the
correct DoViewChange (193) that would have carried op 3. The essence of the
target - a replica forgets a view-change vote across crash and recovery,
continues in the old view, commits there, and the forgotten vote is later
honored - is present in full. This is the target bug on a variant path, not a
different bug.

## 4. Paper vs. implementation

Paper bug, VR-Revisited sections 4.2 and 4.3 (bin/papers/vr/vr-revisited.pdf
pp. 5-7):
- 4.2 step 3 has the new primary accept f+1 DoViewChange messages "from
  different replicas (including itself)". A replica is identified by its id;
  nothing ties a DoViewChange to the incarnation that sent it, and status,
  view-number and the view-change vote are all in memory ("The protocol does
  not require any writing to disk", 4.1).
- 4.3 restores the recovering replica to the primary's view and log. It names
  the hazard of forgetting a prepare ("if it forgets that it prepared some
  operation ... could cause the operation to be forgotten in a view change")
  but not its dual: forgetting that it sent a DoViewChange. Node 0 did the
  latter, recovered into view 13, and was then free to prepare op 3 - the
  view-change correctness argument ("the old primary must have received at
  least f PrepareOK ... recorded in the logs of at least f+1 replicas") assumes
  a replica that voted for view 14 no longer prepares in view 13.
- 4.3 also claims "if the group is doing a view change at the time of recovery,
  and the recovering replica would be the primary of the new view, that view
  change cannot complete since i will not respond to the DoViewChange
  messages". False in this run: the DoViewChange waited in the network and
  node 2's new incarnation, having restarted the same view change on its own
  timer, answered it.
- The nonce (4.3) protects only RecoveryResponse, not view-change messages.

The spec is faithful on this path. StartViewChange (VR.spur:303-334),
DoViewChange (336-385, sender dedup at 341 = "from different replicas"),
StartView (387-402), Recovery (404-430), RecoveryResponse (432-533) match
4.2/4.3. Two spec choices the paper does not spell out, neither of which
creates the violation:
- The recovered replica sends PrepareOK for its uncommitted suffix
  (VR.spur:527-532). The paper says nothing either way; it only shortens the
  path (otherwise the primary's retransmitted Prepare would draw the same
  PrepareOK). Ambiguous but harmless.
- enter_normal_mode does not roll back applied_op_count/kv_store when
  StartView truncates the log. The paper has no rollback either (committed
  operations are never supposed to be lost), so this is downstream of the
  paper bug; its only effect is that the lost write shows up as two divergent
  replica states ([10, 11, 12] vs. [1, 11, 12]) rather than one.

## 5. The scheduling arms (variant 3162153 = crashPlaced 1 + crashHoldDrawn 8 +
bit 32 (the selector-learner quarter) + clientRushPriority 16384 + replaySlot +
replayPrefix)

A selector cannot create a violation; here it bought the interleaving the
oracle needs twice over. Crash placement with a drawn hold put node 2's crash
at 400, two steps after its StartViewChange fan-out at 398 with both copies
undelivered, and node 0's crash at 413 right after its own SVC/DVC fan-out at
407 with 165, 166 and 167 all undelivered: crash-inside-the-fan-out is what
turns those messages into ghosts (labels crash_nl and crash_2 with the sends
in flight), and the long holds (156 delayed 9 steps, 165 by 64, 167 by 59) are
what let both recoveries finish in the old view before the ghosts land. The
client-rush arm released write uid 10 at 415 and uid 11 at 450, on the heels
of the recoveries, and kept write uid 1 retrying into node 1 at 409, so the
old primary was committing in view 13 during the window before StartView(14)
(bug.md step 7, label w2 before deliver_sv_1_to_0). The replay prefix spent the
run's first 383 steps on a stored view-churn prefix, leaving the 1500-step
short cap for the tail. A coin-drawn run draws the hold and the rush
independently (about 1/2 and 1/4) and places each crash uniformly over the
learned span, so landing both crashes inside their fan-out windows with the
rush on is a small fraction of runs; the learner's quarter concentrates on
those cells. The violation therefore credits the mechanism only as an exposer
of a paper bug that any schedule with this ordering reproduces.
