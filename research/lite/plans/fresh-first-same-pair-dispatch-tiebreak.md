# fresh-first-same-pair-dispatch-tiebreak

Iteration 26, epoch 14.

## What changes

In the network branch of schedule_runnable, after the stock tournament has
drawn a record and spent its draws: on a treated run (bit 1 << 24,
freshFirstPair, salted half by run id, run-cap probes exempt), if the drawn
record is a remote record from a dead incarnation of its origin, the
destination is not crashed, and an eligible remote record from that
origin's current incarnation to the same destination exists, the fresh
record with the highest priority is taken instead. The ghost stays
eligible every step; no step goes unfilled; nothing is drawn; channel
sends are never displaced or preferred. The scan is gated on the origin's
ledger having both fresh and stale records in flight. Untreated runs never
reach the code.

## Why

The Recovery request of a recovered node and its dead incarnation's
StartViewChange are both in flight to the peer at once in most runs, and
which the peer takes first is depth 8. The control's overtake share of
0.37 says the stock tournament takes the ghost first about 60% of the
time. The fresh backlog in that episode is one record, so the swap fires
once and delays the ghost one step.

## Frozen prediction

- Bit: FRESH_FIRST_PAIR = 1 << 24 (16777216) in run_variant.rs and
  VARIANT_BITS.
- Rung and band: depth>=8 per-run ratio treated against untreated in
  [1.12, 2.60]; depth>=6 in [0.98, 1.03]; depth>=7 in [0.99, 1.05];
  depth>=9 and depth>=11 reported.
- Firing: fresh_first.swaps >= 100,000 per chunk; contested_dispatches >=
  300,000 per chunk on both halves; stale_drawn, repeat_swaps,
  contested_down, the swap-count histogram, and the overtake census
  (ghost_entries_from_restarted_origin, overtaken) on both halves.
- Independent observable: treated overtake share >= 1.30x control.
- Falsifier: depth>=8 interval entirely below 1.03; or overtake below
  1.10x; or repeat_swaps/swaps above 0.25; or a treated contested dispatch
  that delivered the stale record while a fresh same-pair record was
  eligible; or treated steps per run above 1.05x control; or plan_complete
  more than 3 points below control; or crashes or recovers per treated run
  outside 1% of control.
- Cost clause: throughput >= 0.97 of 2041.85 runs per second; regression
  passes.
- Post-session: a census of P4_2 and R4 on treated versus control depth>=8
  runs from a kept explore of the candidate binary; merge requires the
  treated P4_2 share not below control.

## Grading

`start --treatment-bit 16777216 --band-min 0.12 --band-max 1.60`, two
chunks, then the kept explore for the census.
