# origin-alternation-at-destination

Iteration 45, epoch 14. Built on spur 02df730.

## Frozen prediction (as admitted; graded, never rewritten)

```json
{
 "treatmentBit": {
  "name": "originAlternate",
  "value": 67108864,
  "shift": 26,
  "reuse": "VARIANT_BITS row 67108864 renamed from originSticky; verified absent from run_variant.rs",
  "salt": "own (ORIGTURN)",
  "share": "0.5 of non-probe runs",
  "probesExempt": true,
  "registration": "run_variant.rs ORIGIN_ALTERNATE plus the decide.ts rename, same commit"
 },
 "mechanism": "The candidate's stated mechanism is withdrawn: the DAG has no node-0 record at node 1, and the depth 8, 9 and 10 labels are three consecutive node-2-to-node-1 deliveries. What replaces it, verified in VR.spur: node 1 leaves status 2 only on responses from BOTH peers including the primary (VR.spur:428-527, quorum 2 of 2 peers plus an explicit primary_resp test), and StartViewChange returns early at status == 2 (VR.spur:301) while DoViewChange requires status == 1 (VR.spur:335). So node 0's RecoveryResponse must be taken at node 1 before node 2's ghost pair, or both ghosts are dropped and the chain dies. Alternation raises the chance node 1 switches to node 0 rather than draining node 2. Priced against it, and this is why the band's lower edge is where it is: the same rule then forces node 0's other traffic BETWEEN the ghosts, which is the interference the closed arm named as its own gain, and the chain's shape at node 1 after the switch is a same-origin run of three.",
 "rung": "depth>=8, per-run ratio treated/untreated, probe-free, co-bit matched",
 "band": [
  0.85,
  1.3
 ],
 "bandNote": "Widened downward from the proposed [1.05, 1.35]. Mirroring a measured 0.738 is not a derivation: the control's cross-origin order is close to a fair coin (streak 1.93 against 2.0 for a fair coin over two origins), and the target prefix is a CONJUNCTION of a cross-origin switch and a same-origin run, so always-repeat and never-repeat each delete a different half of it and both can lose against the coin. A read entirely above 1.03 with the streak observable met is a merge; [0.97, 1.03] is a null and closes the direction question; entirely below 0.97 is a loss and is interpreted only through the strength cell.",
 "sizePct": {
  "min": -0.15,
  "max": 0.3
 },
 "mandatoryStrengthCell": "REQUIRED, and the round's product. A nested sub-bit (own salt ORIGTURNQ, set only when originAlternate is set, about a quarter of the treated half) applies the SAME alternation preference on only a salted quarter of eligible contests. Three cells are then read: full-strength alternation, quarter-strength alternation, control. Without this cell a second loss on this axis cannot be attributed and the round produces nothing new. Report the streak observable per cell so dose and direction are separable.",
 "advanceRungs": {
  "depth>=9": "reported, no expectation - the switch this arm supplies must precede label 9 and the run it disrupts follows it, so the two rungs sit on opposite sides of the rule",
  "depth>=10": "reported",
  "depth>=6 and depth>=7": "expected [0.96, 1.04]; below 0.95 is an implementation check"
 },
 "firing": {
  "counter": "origin_turn.alternate_swaps",
  "floorPerChunk": 40000,
  "also": [
   "override counters exactly zero over fresh-first and over pair order (the gate iteration 43 passed as the last layer)",
   "origin_turn.contests per treated run >= 0.5 or inapplicable",
   "exact: on a treated step where the drawn record's origin already differs from the destination's last-entry origin, the pick is unchanged (0 swaps)",
   "the no_last_origin, same_origin_already and nothing_ready declines reported separately, as in the closed arm"
  ]
 },
 "independentObservable": "The origin_turn census keyed on ORIGTURN, salted sixteenth of runs on both halves, exactly the closed arm's census with the direction inverted: mean same-origin message-entry streak at a destination at most 0.80 of the MEASURED control's (the closed arm read 1.567 the other way against a control of 1.93). Reported per cell so the quarter-strength dose is visible. Above 0.95 is an implementation check before any rung is credited.",
 "falsifier": "depth>=8 interval entirely below 1.00 AND the quarter-strength cell also entirely below 1.00 -> the cost is determinism rather than direction, the cross-origin family closes for good and that attribution is the finding; depth>=8 entirely below 1.00 with the quarter-strength cell at or above 1.00 -> the family needs a dose, not a direction, and the follow-up is a strength sweep, not a third predicate; interval inside [0.97, 1.03] -> null, close the direction question; streak observable above 0.95 or any swap on a step whose drawn origin already differs from the last-entry origin (exact, 0) -> implementation check, no rung credited; alternate_swaps below 40,000 per chunk; steps per run above 1.03x; plan_complete more than 2 points apart.",
 "panelCells": {
  "keepRuleRequired": false,
  "why": "the arm predicts a VR gain and must stand on the VR rung; a VR loss closes it, and a panel move is a portfolio note",
  "readOn": "grader panel --binary <candidate> --members paxos-accept-stale-ballot,mencius-opt1-2,raft-stale-vote,paxos-fixed-recover-forget-accepted --seed 1000 --scale 3, cell originAlternate (67108864), matched control = bit clear",
  "reported": [
   {
    "member": "paxos-accept-stale-ballot",
    "expected": "[1.00, 1.20] reported; the closed arm predicted this member DOWN under grouping because its bug needs a cross-origin contest at one acceptor, so alternation is the side that should serve it. About 1,675 violations per half, the only member with power to resolve a 6 percent move. This cell is the arm's bias made visible and is worth as much as the VR rung."
   },
   {
    "member": "raft-stale-vote",
    "expected": "reported"
   },
   {
    "member": "paxos-fixed-recover-forget-accepted",
    "expected": "reported"
   }
  ],
  "expectedFlat": [
   {
    "member": "mencius-opt1-2",
    "expected": "flat; no crashes but it does have destinations, so a move is a real read"
   }
  ],
  "keepIfVrLoses": "NONE."
 },
 "cost": "cross-binary throughput >= 0.97 of the paired cache; wall per step within 1 percent between cells. The closed arm read 1.021 in both sessions at the same site and shape, so a read below 0.97 is build layout and below 0.94 refutes.",
 "orderOfOperations": "LAST dispatch layer: origin_turn runs after fresh_first_dispatch and pair_order_dispatch and stands aside whenever either expressed a preference, which requires both to return whether they chose. The swap consumes no random draw, so a treated and an untreated run read the same random sequence at every step.",
 "rewritten": true
}
```

## Grading protocol

The closed arm's patch is GONE from the tree - there is no spur/spur-core/src/simulator/origin_turn.rs at spur 02df730 - so four things must be rebuilt from the plan's description before anything is graded: (1) the origin_turn.rs module with per-destination last-origin RunState and the full counter set; (2) the (usize, bool) returning-flag change to fresh_first_dispatch (scheduler.rs:1540) and pair_order_dispatch (scheduler.rs:1617), which is NOT in the tree - both currently return a plain usize - so that the origin layer can stand aside; (3) the per-destination last-origin write at the message-entry site (scheduler.rs:1264-1300), placed OUTSIDE the `if message_entry && util_stats::enabled()` block that currently wraps fresh_first.note_entry, since the preference reads it on every treated step; (4) session 2's invariant fix - re-run both pure rankers on the swap target under the conditions their dispatch uses, recording nothing, or the merged pair-order zero-inversion test fails (it failed with 29 inversions before that fix). Then add the nested quarter-strength sub-bit. Grade four chunks, grader start --treatment-bit 67108864 --band-min -0.15 --band-max 0.30, with the quarter cell read alongside. On chunk 1 read the firing floor, the applicability floor, the exact no-swap clause and the streak observable BEFORE any rung is credited. Panel at seed 1000 after the grade. Verdict: above 1.03 with the streak observable met -> merge; otherwise close, and report which of direction or determinism the strength cell blames.

## Judge notes

Admitted at rank 2, not rank 1, because its stated mechanism is false and the ablation above it has verified claims and a certain product. It is still worth a grade: it is the only experiment that says what the two spent sessions on this axis actually measured, and it closes or opens the cross-origin family either way. The mandatory strength cell below is the reason I did not close it - without it a second loss is uninterpretable and the round yields nothing. If only one grade fits the session, run the ablation; if two fit, this is the second.

Red team: The strongest case that alternation will NOT read above 1.0, in three parts. (1) The chain's shape at node 1 is a same-origin RUN, not an interleaving. relax_minimal_general_v2.json contains no node-0 record addressed to node 1 anywhere in its 20 labels; the three chain deliveries at node 1 - deliver_rec_2_to_1, deliver_svc_2_to_1, deliver_dvc_2_to_1, the depth 8, 9 and 10 rungs - are all node 2 to node 1, chained in that order by the dependency list. The closed arm's own mechanism sentence named the interleaving of node-0 traffic between them as the thing that lets node 1's status or view move and drop the ghosts; alternation deliberately creates that interleaving. On the one place the mechanism is readable off the DAG, alternation is the wrong side. (2) The 0.74 loss has other candidate causes that this arm does not separate. The arm is not a tiebreak: session 2 recorded 152.0M swaps with zero overrides of either merged layer, i.e. the merged layers rarely express a preference at all, so the origin layer is the dominant network-order rule in either position, and it substitutes a record from a DIFFERENT pair and then re-ranks it - it changes which record of which sender is taken first in ways the swap counters do not separate from the sender choice. Interaction with the merged 64-step post-fault deferral and the client anchor is also unmeasured: the deferral's release is step-keyed, and changing how fast a recovered node's queue drains changes step counts against that release. (3) The mirror of a loss is NOT a sound prediction in general, and the record already shows why: the control is a near-greedy tournament over i.i.d. priorities, so its cross-origin order is close to a fair coin (measured mean streak 1.93, against 2.0 for a fair coin over two origins). The coin is approximately the midpoint on the STREAK statistic, but not on the space of prefixes: the chain needs a conjunction - node 0's RecoveryResponse taken at node 1 BEFORE node 2's ghosts (a cross-origin switch) and then node 2's three records in order without node 1's view moving (a same-origin run). Always-repeat deletes the first half of that conjunction; never-repeat deletes the second. A coin samples both. So both a mechanism and its inverse can lose against random, and the band's lower edge must admit it. The mirrored [1.05, 1.35] is a hope dressed as arithmetic and I have rewritten it.

Verified at admission: ["TRUE, and this is the candidate's one load-bearing claim that survives: VR.spur completes recovery on a majority INCLUDING the primary. RecoveryResponse (bin/spur/VR.spur:428-527) sets quorum = len(replicas)/2 + 1 = 2 at three servers, counts only distinct peer senders (Recovery is sent to peers only, VR.spur:102-106, self excluded), and after the quorum test requires primary_resp from primary_of(latest_view) or returns. At n=3 the recovering node therefore needs BOTH peers' responses, so a genuine cross-origin requirement does exist at node 1.", "TRUE and load-bearing for the repaired mechanism: StartViewChange returns early at status == 2 (VR.spur:301) and DoViewChange acts only at status == 1 with new_view == view_number (VR.spur:335), so node 1 must have LEFT recovery before node 2's ghost StartViewChange lands or both ghosts are lost. That is the real reason node 0's RecoveryResponse must beat node 2's ghosts at node 1 - and it is a claim the candidate did not make.", "GOAL.md's rung definition matches the DAG: depth 8 is deliver_rec_2_to_1 (node 2's post-restart Recovery delivered to node 1 before that node sees the ghost StartViewChange), depth 9 deliver_svc_2_to_1, depth 10 deliver_dvc_2_to_1.", "spur/spur-core/src/simulator/origin_turn.rs DOES NOT EXIST in the tree at spur 02df730; the closed arm's patch is gone.", "scheduler.rs:1054-1055 calls fresh_first_dispatch then pair_order_dispatch, both returning a plain usize - the returning-flag change that session 2 depended on is NOT in the tree and must be rebuilt.", "The message-entry site at scheduler.rs:1264-1300 runs state.fresh_first.note_entry INSIDE an `if message_entry && util_stats::enabled()` block, so the plan's constraint that the per-destination last-origin write must NOT inherit that gate is real a

False claims named at admission: ["'labels 7 to 9 interleave node 0's and node 2's records at node 1' (pool entry, and the iteration-43 observation it is copied from). FALSE on the face of research/oracle/relax_minimal_general_v2.json: those three labels are deliver_rec_2_to_1, deliver_svc_2_to_1 and deliver_dvc_2_to_1, all node 2 to node 1 and chained in that order, and the DAG contains NO node-0-to-node-1 delivery at any label. The closed arm's own plan states this correctly in its first sentence ('three deliveries from one origin to one destination ... all node 2 to node 1'), so the loop contradicted itself between iterations 42 and 43. This is the clause that carried the whole mechanism and it is withdrawn; the supported cross-origin requirement is the UNLABELLED RecoveryResponse pair for node 1's own recovery, which gates the ghosts taking EFFECT (status == 2 drop) and node 1 answering Recovery, not the depth-8/9/10 deliveries themselves.", "'depth>=9 expected at or above depth>=8's ratio.' Not derivable. Under the repaired mechanism the cross-origin switch that alternation supplies has to happen BEFORE the depth-9 delivery and the same-origin run has to happen AFTER it, so the two rungs are on opposite sides
