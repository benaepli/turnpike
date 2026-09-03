# pair-send-order-dispatch-fault-scoped

Iteration 29, epoch 14. Parent: fresh-first-same-pair-dispatch-tiebreak.

## What changes

In the network branch of schedule_runnable, after the tournament draw and
after the merged fresh-first swap, on a salted half of runs (bit 1 << 15;
probes exempt): if the record about to be taken is a remote record from an
origin that has crashed at least once in the run, and an eligible record
with the same origin, destination and origin incarnation carries a lower
send ordinal, take the lowest-ordinal one instead. Nothing is masked or
delayed; no draw is consumed; the scan is gated on the origin's ledger
holding two or more records in the queue; records of never-crashed origins
keep the stock draw.

## Why

The StartViewChange and DoViewChange a node sends on entering a view
change leave one handler with consecutive send ordinals, and the
tournament orders them by a priority drawn once at creation: a fair coin.
Depth 9 needs the SVC before the DVC at node 1. The merged tree passes
depth 8 to 9 one time in six; a perfect fix has a ceiling near 2.0x.

## Frozen prediction

- Bit: PAIR_SEND_ORDER = 1 << 15 (32768, pairSendOrder) in run_variant.rs
  and VARIANT_BITS.
- Rungs: depth>=8 per run in [0.98, 1.10] (a null); depth>=9 per run in
  [1.30, 2.00]; depth>=6 in [0.98, 1.03]; depth>=11 events on the treated
  half >= 1.5x control reported.
- Firing: pair_order.contests >= 300,000 per chunk on both halves;
  pair_order.corrected >= 60,000 per chunk; control inorder_draws over
  contests in [0.35, 0.65].
- Independent observable: census inversions over pair entries, control in
  [0.25, 0.60], treated <= 0.02; post-session census: treated depth-8 runs'
  "DVC before SVC at a recovered node 1" class = 0, R4 >= 2x control.
- Falsifier: depth>=9 interval entirely below 1.10; treated inversions
  above 0.05; control inversions below 0.25; corrected below floor; steps
  above 1.05x; plan_complete more than 3 points below; crashes or recovers
  off by 1%. A depth>=8 interval entirely below 0.97 closes regardless.
- Cost clause: throughput >= 0.97 of 2139.37; regression passes.
- Verdict map: depth 9 up with inversions near 0, merge; depth 9 flat with
  inversions near 0, file with P(DVC exists | depth 8); inversions not
  removed, close.

## Grading

`start --treatment-bit 32768 --band-min -0.02 --band-max 0.10`, two
chunks; read depth 9 from finish's rungs and the cells; then a kept
explore for the census by half.
