# restart-before-stranded-drain-preempt

Iteration 25, epoch 14.

## What changes

On a salted half of runs (bit 1 << 29, recoverPreempt; probes exempt), a
plan-released Recover(v) that is offered while v is crashed with remote
sends still in flight and none of them has yet entered a handler is taken
at that step ahead of every other eligible runnable: a preemption at the
top of schedule_runnable, after the crash hold mask and before the queue
selector, returning the Recover directly. Stranded and consumed are both
defined on remote records: stranded_at_crash[v] is snapshotted in
crash_node from the ledger's remote records in flight, and
ghost_consumed_since_crash[v] is reset there and incremented at the
dispatch site's ghost branch keyed on the record's origin. Once any
stranded send is consumed the rule lapses and the Recover competes as
stock. Nothing is drawn; no record is masked, held or reordered; the
untreated half is byte-identical.

## Why

Depth 8 rewards the recovered node's Recovery request reaching the peer
before the peer consumes that node's ghost StartViewChange. In general
runs the recovery lands too late; the baseline passes depth 7 to 8 in
0.38 of runs. Restarting the node at the first offer while its stranded
sends are still undelivered lets the Recovery request race the ghost.

## Frozen prediction

- Bit: RECOVER_PREEMPT = 1 << 29 (536870912, recoverPreempt) in
  run_variant.rs and VARIANT_BITS; treated share about 0.47.
- Rung and band: depth>=8 per-run ratio treated against untreated in
  [1.06, 1.30]; depth>=6 in [0.99, 1.04].
- Firing: recover_preempt.preempted >= 200,000 per chunk; counters
  recover_preempt.{eligible, preempted, lapsed_before_queued,
  stock_before_drain, ghost_entries_from_restarted_origin, overtaken}, the
  last three on both halves.
- Observables: preempted/eligible >= 0.85 on treated runs, control's
  stock_before_drain/eligible reported; overtaken share of ghost entries
  from a restarted origin >= 1.30x control; depth>=9 per run >= 1.05 and
  depth>=11 events per chunk >= 1.3x control on the treated half.
- Falsifier: depth>=8 interval entirely below 1.03; or preempted/eligible
  below 0.70; or the overtaken ratio below 1.10x; or treated steps per run
  above 1.05x control; or treated plan_complete more than 3 points below
  control; or crashes or recovers per treated run outside 1% of control.
- Cost clause: throughput >= 0.97 of 2041.85 runs per second; the preempt
  scan gated on a crashed node with stranded sends and no consumption;
  regression passes.

## Grading

`start --treatment-bit 536870912 --band-min 0.06 --band-max 0.30`, two
chunks; read depth 6, 8, 9 and 11 from finish's rungs and the per-run
cells.
