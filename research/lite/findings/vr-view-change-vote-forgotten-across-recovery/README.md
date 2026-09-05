# VR.spur: the target bug - a view-change vote forgotten across recovery, later honored

Classification: **paper bug, and the target of `research/oracle/bug.md`**
(VR-Revisited sections 4.2 and 4.3), surfaced by porcupine under the general
config `scheduler_configs/loop/general_vr.json` on the nonce-fixed spec
(VR.spur at acca633). Found at iteration 56 of the lite loop, session
`cycle-before-request`, seed 1000, run 61138, signature `ea076ff71851ec53`
(new; not among the twenty entries in `research/logs/violations/INDEX.jsonl`).

## Reproduction

- Binary: the candidate of session `cycle-before-request` - the merged tree at
  spur 0587e8c plus `research/lite/patches/cycle-before-request/spur.patch`
  (the per-cell selector at quarters with the bit-128 learner on the
  cycle-before-request reward). The run's arm bits: replay prefix child,
  crash placed with a hold drawn, client rush arm, the bit-32 learner's
  quarter (variant 3162153).
- Config: `evidence/config.json` (the template unchanged), campaign arm
  grid-short, configuration index 50, session seed 1000; the run ends at
  step 714 with the plan complete.
- Evidence: `evidence/run_61138.combined.txt.gz` (the unified timeline),
  `evidence/porcupine.json`, `evidence/violating_runs.json`. The full
  archive with the run's structured record and utilization is under
  `research/logs/violations/lite-cycle-before-request-sequential-1000-1788640468601/`
  (not tracked).
- Rate: one in 577,680 candidate runs on chunk 1; zero on chunk 2's 602,220.

## The violation (kv model: a key's value is the ordered list of committed write uids)

Write uid 1 (client 3, invoked at step 0, redirected, accepted by node 1 as
op 3 of view 13 at 409, committed at 444 with a real quorum, acknowledged at
449) is later truncated by StartView(14). Reads at 550 and 553 return
[10, 11]: they contain uid 11 (invoked at 450, after write 1 completed) and
omit uid 1. Later reads return [1, 11, 12] from nodes 0 and 1 (which never
applied the new op 3) and [10, 11, 12] from node 2: the replicas hold two
different histories for the same key.

## Mechanism (node ids and steps from the combined log)

1. 398: node 2, primary of view 14, times out in view 13 and sends
   StartViewChange(14) to nodes 0 and 1; 400: node 2 crashes with both
   undelivered (crash_nl with the sends in flight).
2. 402-425: node 2 recovers (nonce 1, its only recovery) into view 13 with
   n=2 from the RecoveryResponses of nodes 1 and 0. The ghost SVC to node 2
   arrives at 424 while it is still recovering and is dropped.
3. 407: node 0 (normal, view 13) receives the ghost SVC(14) from node 2's
   dead incarnation, enters view change 14, sends SVC(14) to nodes 1 and 2
   and DoViewChange(14, log ops 1-2, n=2) to node 2. All three sit in the
   network. 413: node 0 crashes (crash_2 with its sends in flight).
4. 409: node 1 accepts write uid 1 as op 3 of view 13 and sends Prepare;
   node 0 ignores it (view-change status), node 2 ignores it (recovering).
5. 414-440: node 0 recovers (nonce 1, its only recovery) into view 13 with
   n=3: node 1's RecoveryResponse carries op 3. Per the spec's recovery
   path it sends PrepareOK(13, 3); 444: node 1 commits op 3 with quorum
   {node 1, node 0}; 449: the client is acknowledged. Node 0 has now both
   promised view 14 with n=2 (its DoViewChange still in flight) and
   prepared and committed op 3 in view 13; it remembers only the second.
6. 454: node 2's new incarnation times out again and re-enters view change
   14, sender sets reset. 466: the ghost DoViewChange from node 0's dead
   incarnation is delivered and accepted (sender node 0, view 14). 471:
   the ghost SVC reaches node 1, which enters view change 14 and sends
   DoViewChange(14, ops 1-7, n=7) to node 2. 475: node 0's live
   incarnation receives an SVC, enters view change 14, sends a fresh
   DoViewChange(14, ops 1-3 including uid 1, n=3) to node 2.
7. 479: a fresh SVC from node 0 completes node 2's StartViewChange quorum;
   node 2 sends its own DoViewChange(14, ops 1-2). 480: node 0's fresh
   DoViewChange (n=3, carrying uid 1) is rejected as a duplicate sender:
   the ghost already holds node 0's slot. 484: node 2 counts {ghost from
   node 0, itself} as f+1 DoViewChange from different replicas, takes the
   best log among them (ops 1-2, n=2) and sends StartView(14, ops 1-2).
   Op 3 is gone. 527: node 1's DoViewChange (n=7) arrives and is ignored
   (status normal).
8. 491 onward: node 2 as primary of 14 assigns uid 10 to op 3, uid 11 to
   op 4; nodes 0 and 1 install the truncated log but keep applied_op_count
   3 and kv_store [1], so they never apply the new op 3. The divergent reads
   follow.

## Against the oracle DAG (`research/oracle/relax_minimal_general_v2.json`)

Nineteen of the twenty labels occur in an order the DAG admits, with NL =
node 2, OL = node 1, the oracle's node 1 = node 0, old view 13. The one
departure: deliver_svc_2_to_1 (the ghost SVC from node 0 to NL) was dropped
during NL's recovery; NL's own second timeout at 454 plus the fresh SVC from
node 0's live incarnation at 479 took its role. The ghost DoViewChange then
did double duty: it supplied the stale log and, by claiming node 0's sender
slot, blocked the fresh DoViewChange that carried op 3. The essence of the
target - a replica forgets a view-change vote across crash and recovery,
continues in the old view, commits there, and the forgotten vote is later
honored - is present in full.

## Paper against implementation

- 4.2 step 3: the new primary accepts f+1 DoViewChange messages "from
  different replicas (including itself)". Replicas are identified by id;
  nothing ties a DoViewChange to the incarnation that sent it, and status,
  view-number and the vote are in memory ("the protocol does not require any
  writing to disk", 4.1).
- 4.3 restores the recovering replica to the primary's view and log. It
  names the hazard of forgetting a prepare but not its dual, forgetting that
  it sent a DoViewChange. The correctness argument for view changes assumes
  a replica that voted for view 14 no longer prepares in view 13.
- 4.3 claims that "if the group is doing a view change at the time of
  recovery, and the recovering replica would be the primary of the new
  view, that view change cannot complete since i will not respond to the
  DoViewChange messages". False here: the DoViewChange waited in the
  network and node 2's new incarnation, having restarted the same view
  change on its own timer, accepted it.
- The nonce protects RecoveryResponse only, not view-change messages.

Not the nonce bug: each node recovers exactly once, every accepted
RecoveryResponse was addressed to that incarnation, and the spec is the
fixed one (VR.spur:95-97). The spec is faithful on this path:
StartViewChange (VR.spur:303-334), DoViewChange (336-385, sender dedup at
341), StartView (387-402), Recovery (404-430), RecoveryResponse (432-533).
Two spec choices the paper does not spell out, neither of which creates
the violation: the recovered replica sends PrepareOK for its uncommitted
suffix (527-532; otherwise the primary's retransmitted Prepare draws the
same PrepareOK), and enter_normal_mode does not roll back applied state
when StartView truncates the log (the paper has no rollback either; its
only effect is that the lost write shows as two divergent replica states).

## What the schedule did

A selector cannot create a violation; it bought the interleaving twice over.
Crash placement with a drawn hold put node 2's crash two steps after its
StartViewChange fan-out and node 0's crash right after its own SVC/DVC
fan-out, with all the sends undelivered, which is what makes them ghosts;
the long holds let both recoveries finish in the old view before the
ghosts landed. The client-rush arm released writes 10 and 11 on the heels of
the recoveries and kept write 1 retrying into node 1, so the old primary
was committing in view 13 in the window before StartView(14). A coin-drawn
run draws the hold and the rush independently and places each crash over
the learned span; the learner's quarter concentrates on the cells where
this happens. The violation credits the mechanism only as the exposer of a
paper bug that any schedule with this ordering reproduces.
