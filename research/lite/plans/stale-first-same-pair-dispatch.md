# stale-first-same-pair-dispatch

Iteration 39, epoch 14. Built on spur 02df730.

## What changes

New arm on the DELIVERY axis, the opposite side of freshFirstPair. In fresh_first_dispatch (scheduler.rs:1540-1600) the merged rule, on bit 24 runs, replaces a drawn ghost (origin_incarnation != incarnation(origin)) by the highest-priority eligible fresh record from the same origin to the same destination. On a nested salted quarter (bit 1 << 22, staleFirstPair, own salt STALEFST, set only when bit 24 is set; probes exempt by inheritance) the direction is inverted: when the drawn record is fresh and an eligible dead-incarnation record from the same origin to the same destination exists, take that ghost instead (highest priority, lowest queue index among equals; fresh_first::rival gains the index for the want_fresh == false search, which today only detects). Same gate (origin ledger has both net_fresh and stale records in the queue), same no-draw-consumed property, ghost census unchanged, channel sends neutral. pair_order_dispatch runs after it as today and orders inside the class taken. Counters (fresh_first block, third slot stale_arm): contests, swaps_to_stale, repeat_swaps, taken histogram, and the existing ghost-entry overtaken census read per arm. Registration: run_variant.rs STALE_FIRST_PAIR = 1 << 22 set only with FRESH_FIRST_PAIR; decide.ts VARIANT_BITS row 4194304 renamed from replyFirstRecovering (filed at iteration 34, patch kept, not in the tree: run_variant.rs sets no bit 22) to staleFirstPair. No config field. Nesting inside bit 24 gives the grader a matched two-sided read (stale quarter against fresh-first quarter, the coin's two ends) and leaves the stock half untouched as the third cell; while the arm is in the tree the pooled bit-24 headline reads (fresh + stale) against stock, the same acknowledged pooling the request-timing axis carries on bit 18.

## Why

Fresh-first is the tree's one class-order bias and it reads as one: +12% on depth 8 for VR and 0.79 [0.44, 1.41] on raft-stale-vote in the first per-cell panel read. panel-per-cell-read.md section 5 classes two members as 'opposite: the stale reply first' (raft-stale-vote, paxos-fixed-recover-stale-scout). Read in simulator terms: the candidate's RequestVote (or the scout's P1a) is sent, the sender crashes and restarts, and the restarted incarnation's request to the same follower (acceptor) is co-eligible with the dead incarnation's; fresh-first lands the new-term request first, the follower's term (ballot) rises and the ghost is refused, so the stale grant that the buggy reply handler would count is never produced. Stale-first produces it every time the contest occurs. For VR the same swap at node 1 puts the ghost SVC 2->1 before the fresh Recovery 2->1, which inverts label 8, so the VR read is a frozen loss: the control's stock coin took the ghost first about 60% of the time and fresh-first's 100% fresh read 1.12 over stock, so 100% stale should read about 0.92 of stock and about 0.82 of the fresh-first quarter it is matched against. The one order at node 1 where a ghost first helps (RR 2->1 before Recovery 2->1) is an arrival gap, not a contest (iteration 34), so it does not offset the loss. This is the arm the pool held twice (pair-order-drawn-class-fresh-stale-stock, HELD at iteration 26: 'run stale-first alone with a negative band') and the direction note now asks for: a strategy whose bias is the mirror of a merged one, read per cell.

## Frozen prediction (rewritten by the judge at admission; graded, never rewritten)

```json
{
 "treatmentBit": {
  "name": "staleFirstPair",
  "value": 4194304,
  "shift": 22,
  "nestedIn": [
   "freshFirstPair (16777216)"
  ],
  "reuse": "row 4194304 renamed from replyFirstRecovering (filed iteration 34, not in the tree)",
  "salt": "own (STALEFST), salted_phase(run_id, STALEFST, 2) == 1 within fresh_first::is_treated(run_id)",
  "treatedShareOfAllRuns": 0.235,
  "controlShareOfAllRuns": "0.235 (freshFirstPair set, staleFirstPair clear), matched by invariant co-bits; stock half (0.47) is the third cell",
  "probesExempt": "by inheritance from freshFirstPair"
 },
 "rung": "depth>=8 (epoch 14 primary), per-run ratio stale quarter / fresh-first quarter, probe-free, co-bit matched",
 "band": [
  0.6,
  0.9
 ],
 "bandNote": "Frozen as a LOSS. The floor is widened from 0.70 to 0.60 because the control ghost-first share is recorded twice with different values (0.37 overtaken in the plan, 0.711 in the merge note); a linear model gives 0.82 of the fresh-first quarter under the first and 0.63 under the second. Stale quarter over stock half reported from the cells, expected [0.70, 0.98].",
 "advanceRungs": {
  "depth>=9": {
   "expected": [
    0.55,
    0.95
   ],
   "reported": true
  },
  "depth>=10": {
   "reported": true
  },
  "depth>=6 and depth>=7": {
   "expected": [
    0.97,
    1.03
   ],
   "reported": true,
   "note": "a read below 0.95 is an implementation check on the gate"
  }
 },
 "panelCells": {
  "readOn": "grader panel --binary <candidate> --members paxos-accept-stale-ballot,mencius-opt1-2,raft-stale-vote,paxos-fixed-recover-stale-scout,paxos-fixed-forget-promise,raft-forget-vote,paxos-fixed-host-control --seed <s> --scale 3, cell staleFirstPair (4194304), matched control = freshFirstPair set, staleFirstPair clear (panelCells invariant co-bits); pooling across seeds per the cell arithmetic",
  "expectedUp": [
   {
    "member": "raft-stale-vote",
    "direction": "up",
    "expected": ">= 1.5 per run against the fresh-first quarter (its freshFirstPair cell read 0.79, so stale over fresh is expected near 1/0.79 or above)",
    "runsPerRead": "288,000 runs per seed at scale 3 (quick set)",
    "eventsPerRead": "about 117 violations per seed; about 27 per quarter at the base rate, about 23 on the fresh-first quarter",
    "seeds": "1000 after the grade; 1001-1003 pooled at the review; a fifth seed allowed. A >= 2x lift is confirmable on three pooled seeds (z about 3.9), 1.5x needs five (z 2.7 at about 125 control events); a 1.3x lift is REPORTED, never a keep criterion",
    "why": "the follower must grant the dead incarnation's RequestVote before the restarted incarnation's raises its term; the guard-dropped RequestVoteReply handler then counts the stale grant"
   },
   {
    "member": "paxos-fixed-recover-stale-scout",
    "direction": "up",
    "expected": ">= 1.5 per run",
    "runsPerRead": "96,000 runs per seed at scale 3; count-only at that size (about 29 violations per seed, about 7 per quarter)",
    "seeds": "1000-1003 pooled: confirms only a >= 2.5x lift (z about 3.1); if the operator gives the member the slow-set run count (10x, 960,000 per seed) a 1.5x lift confirms on two pooled seeds",
    "why": "the acceptor must promise the dead scout's ballot before the restarted scout's higher one, producing the stale P1b the clause-dropped HandleP1bResponse counts"
   }
  ],
  "expectedFlat": [
   {
    "member": "paxos-accept-stale-ballot",
    "expected": [
     0.9,
     1.1
    ]
   },
   {
    "member": "mencius-opt1-2",
    "expected": "flat (null row)"
   },
   {
    "member": "paxos-fixed-forget-promise",
    "expected": "reported"
   },
   {
    "member": "raft-forget-vote",
    "expected": "reported"
   },
   {
    "member": "paxos-fixed-host-control",
    "expected": "0 violations"
   }
  ],
  "upDefinition": "a cell reads UP when the pooled ratio's 2.7-sigma lower edge (overdispersion 1.3) is above 1, ratio - 1 >= 0.02, and both halves carry >= 5 violations - the grader's own 'up'. Pool by summing treatedRuns/treatedViolations and controlRuns/controlViolations per member from research/lite/state/panel/<iso>/<member>/{porcupine,runs}.json.",
  "notUpDefinition": "a named member is NOT up when, after its specified pooled seeds, the cell reads flat or down, or reads count-only with pooled treated violations >= 15 and ratio < 1.5.",
  "powerNote": "treated and matched-control events both come from quarters, so per-seed counts are a quarter of the member's; raft-stale-vote is the member that can decide within four seeds (at >= 2x), the scout is count-only unless run at the slow-set size"
 },
 "firing": {
  "counter": "fresh_first.stale_arm.swaps_to_stale",
  "floorPerChunk": 40000,
  "also": [
   "fresh_first.stale_arm.contests per treated run within 10% of the fresh-first quarter's contests per run (the gate is arm-blind)",
   "repeat_swaps / swaps_to_stale <= 0.25 with the taken histogram",
   "no stale-arm contested dispatch delivered a fresh record while a same-pair ghost was eligible (exact, 0)",
   "fresh-first quarter's swaps and overtaken share unchanged from the merged read (0.9989)",
   "stale quarter ghost-entry overtaken share reported per chunk"
  ]
 },
 "independentObservable": "stale quarter ghost-entry overtaken share <= 0.10 against 0.9989 on the fresh-first quarter and the stock half in [0.25, 0.65] (both recorded control values fall inside)",
 "falsifier": "depth>=8 stale/fresh-first interval containing or above 1.00; or overtaken share above 0.20; or swaps_to_stale below 40,000 per chunk; or steps per run > 1.03x; or plan_complete more than 2 points apart; or crashes or recovers per run off by 1%; or, on the panel, neither named member UP after its specified pooled seeds (remove the arm, keep the stale-arm census, record 'no stale-first member on the panel')",
 "vrCost": "tree-level price while the quarter is in the tree: about 0.235 x (1.12 - band) of depth>=8 events per chunk, 4-12% across the band. Acceptable: cross-binary depth>=8 events per explore-second >= 0.88 of the paired cache (layout floor applies); throughput >= 0.97; wall per step within 1% across quarters",
 "decisionMap": "depth>=8 in [0.60, 0.90], cost met, and raft-stale-vote or the stale scout UP after pooled seeds -> merge and keep the quarter (class-order axis fresh 0.235 / stale 0.235 / stock 0.47; any share change is an operator decision from the tree ledger with its own panel re-read); band met, cost met, no named member up -> remove the arm, keep the census, record 'no stale-first member'; depth>=8 above 0.95 -> implementation check (the swap did not invert); depth>=8 below 0.50 -> implementation check on the gate before any read is credited; VR cost clause failed -> close regardless",
 "grading": "grader start --treatment-bit 4194304 --band-min -0.40 --band-max -0.10, four chunks; panel on the candidate binary: quick set at seed 1000 after the grade, seeds 1001-1003 pooled for the two named members at the review",
 "rewritten": true
}
```

## Grading protocol (an opposite-side arm)

Build on the merged tree. Grade four chunks on bit 4194304 (nested in 24), primary depth>=8 stale quarter / fresh-first quarter; firing and overtaken-share clauses read on chunk 1 before any rung is credited; VR cost clause at finish. Panel per panelCells.readOn; verdict by the decisionMap. The panel state files are the pooling source.

## Judge notes

Cost 0: fresh_first.rs and the dispatch site in scheduler.rs only; no exec.rs, history.rs or event-accounting touch (the candidate wrote 0.5; the rubric has no such value). Nested quarter inside bit 24 gives the matched two-sided read the direction note asked for; while in the tree the pooled bit-24 headline reads fresh+stale against stock, which the ledger must record. Interaction with the receiver-ghost holds: none at the dispatch site (a hold masks before the draw; this swaps among eligibles).

False claims named at admission: ["power clauses: '1.5x separates on two pooled seeds, 1.3x on four' is false under the grader's cell rule at about 27 events per quarter per seed; 2x needs three pooled seeds, 1.5x five; 1.3x is never confirmable at these counts", "'stock coin took the ghost first about 60%' is one of two disagreeing records (plan line 24 says 0.37 overtaken; the iteration-26 merge note says 0.711 overtaken); the derived 0.92 and the band floor 0.70 depend on which is right"]

## Pre-grade census (2026-09-04, implementer smoke, 50,944 runs)

Fresh quarter: swaps 6,776, overtaken share 1.000 on 23,048 ghost entries.
Stale quarter: swaps to the stale record 14,083, overtaken share 0.0002 on
23,261 ghost entries (the identity contested - stale_drawn - contested_down
- swaps_to_stale = 0 holds exactly). Control half: overtaken share 0.626.
Flag for the read: repeat swaps over swaps on the stale quarter 0.34,
above the prediction's 0.25 clause - a fresh record is displaced once per
eligible ghost of its pair and a fan-out leaves several ghosts per pair;
the fresh arm's ratio is 0.05. Tests 391 unit plus all integration suites.
The grade proceeds on the frozen prediction; the repeat-swap clause is
read as stated.
