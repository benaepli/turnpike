# pair-send-order-ghost-class-only

Iteration 44, epoch 14. Built on spur 02df730.

## Frozen prediction (as admitted; graded, never rewritten)

```json
{
 "carriedFrom": "iteration 40, unchanged",
 "treatmentBit": {
  "name": "pairOrderGhostOnly",
  "value": 536870912,
  "shift": 29,
  "nestedIn": [
   "pairSendOrder (32768)"
  ],
  "salt": "own (PAIRGHOST)"
 },
 "rung": "depth>=8, ghost-only quarter / full merged quarter, probe-free, co-bit matched",
 "band": [
  0.95,
  1.05
 ],
 "decisiveRung": {
  "rung": "depth>=9",
  "requirement": "lower edge above 0.95 over four chunks"
 },
 "firing": "pair_order.ghost_only.corrections_fresh_suppressed >= 20,000 per chunk; contests_by_class{ghost,fresh} counted on the full merged quarter as well; fresh class >= 0.20 of merged corrections or inapplicable; ghost-class inversions exactly 0",
 "falsifier": "depth>=9 entirely below 0.95 (keep the merged rule, record the class split); depth>=8 outside [0.95, 1.05]; firing floor missed; any ghost-class inversion",
 "cost": "throughput >= 0.98 of the paired cache",
 "rewritten": true
}
```

## Grading protocol

Build the nested arm in pair_order.rs plus run_variant.rs PAIR_ORDER_GHOST_ONLY = 1 << 29 set only with PAIR_SEND_ORDER, and rename VARIANT_BITS row 536870912 from recoverPreempt to pairOrderGhostOnly in the same commit. Four chunks, grader start --treatment-bit 536870912 --band-min -0.05 --band-max 0.05. Read contests_by_class on chunk 1 before any rung is credited; that census is the round's product. Panel reported, keep rule not required.

## Judge notes

Cheapest build of the round (about 120 lines net) and the only candidate whose product - the first split of pairSendOrder's firing by incarnation class - lands whether or not the rung moves. Promoted over the seeded candidate because its load-bearing claims all check out and the seeded one's does not. Carry the iteration-40 frozen prediction unchanged.

Red team: The honest risk is the one the iteration-40 judge already wrote in: the fresh (live-incarnation) class is the MAJORITY of pair_order_dispatch's corrections, so this is a large removal, not a small narrowing. I re-verified the gate at scheduler.rs:1617-1640: pair_order_dispatch returns the pick unchanged unless state.incarnation(origin) > 0 or the origin is currently crashed, and then orders within (origin, dest, origin_incarnation) by send ordinal - so it does cover both the dead and the live incarnation of any sender that has crashed once, exactly as claimed. Second risk: node 2's post-restart Recovery to node 1 (the depth-8 label) is a LIVE-incarnation low-ordinal send, so the merged rule may be part of what puts it early; if depth>=9 falls, the fresh class carries part of the merged effect. That outcome is the finding, not a failure. Third: with the origin axis now closed in both directions, this is the only kept entry whose product is certain regardless of the rung.

Verified at admission: ["pair_order_dispatch at spur/spur-core/src/simulator/core/scheduler.rs:1617-1660 gates on state.incarnation(origin) == 0 && !currently_crashed (returns pick), then requires send_ledger net_records >= 2 - the sender-crashed-once gate the entry describes, covering both classes.", "The call order at scheduler.rs:1054-1055 is fresh_first_dispatch then pair_order_dispatch, both returning a plain usize.", "Bit 536870912 is listed in research/orchestrator/src/decide.ts VARIANT_BITS as recoverPreempt and is absent from spur/spur-core/src/simulator/run_variant.rs (which declares only bits 0,1,2,3,9,15,18,19,20,21,24), so the row is genuinely free for the rename."]

False claims named at admission: []
