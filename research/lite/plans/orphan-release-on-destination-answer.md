# orphan-release-on-destination-answer

Iteration 18, epoch 13. Family: stale-incarnation record mask.

## What changes

A crashed node's orphaned sends are held per destination until that
destination has answered the node's current incarnation. On a treated run
(bit 1 << 16, ghostPeerAnswer, a salted half of all runs drawn by run id),
crashing a node v that has sends in flight arms v. While armed, a remote
record from v to d is masked in is_ineligible when its incarnation is
stale or v is crashed, unless d has answered: d sent a remote record to v's
current incarnation from a handler segment that a fresh delivery from v
woke. Each (v, d) pair releases on its own condition, or expires at
armed_at + 96 steps or the run's step reserve, or is inert when no orphan
to d remains. Records stay in the network queue throughout.

Bookkeeping: SendLedger gains woke_by, the origin and freshness of the
delivery that woke the current segment, stamped where the dispatch site
already computes the incarnation crossing; and answered, a bitmask over
destinations reset at the incarnation bump. The answer is detected at
flight entry for remote records only, never the implicit return channel
send. A census at the dispatch site records for every sender-restarted
delivery, on both halves, whether the destination had answered the
origin's current incarnation before consuming the ghost.

## Why

The ordering the target cannot do without is at the destination: it must
answer the recovering node before it reacts to that node's ghost, because a
peer that has reacted no longer answers and the recovery never closes. The
closed BEHIND arm ordered the ghost after the destination merely received
fresh traffic, which is necessary but not sufficient. The round-trip hold
in the pool releases on the origin's first reply from anyone, which at
three nodes is the other peer half the time. The destination's own reply
is the minimal sufficient condition: it holds shortest and expires least.

## Frozen prediction

- Bit: GHOST_PEER_ANSWER = 1 << 16 (ghostPeerAnswer) in run_variant.rs and
  VARIANT_BITS. Salted half of all runs; no probe exemption.
- Rung and band: depth>=6 per-run ratio treated against untreated,
  probe-free, co-bit matched, in [1.03, 1.12].
- Firing: ghost_answer.armed >= 100,000 per chunk; ghost_answer.{
  masked_offers, condition, expired, inert} and
  ghost_answer.census.{treated,control}.{answered, unanswered} exported.
- Independent observable: treated answered share of stale-incarnation
  deliveries at least 1.5x the control share (treated HIGHER);
  expired/armed at most 0.45.
- Falsifier: the depth>=6 interval entirely below 1.03; or treated answered
  share below 1.5x control; or expired/armed above 0.45; or treated steps
  per run above 1.04x untreated; or treated plan_complete more than 3
  points below untreated; or stale-incarnation deliveries per treated run
  more than 10% below untreated; or crash_phase expired/armed on treated
  runs more than 3 points above untreated.
- Cost clause: cross-binary throughput at or above 0.97 of the paired
  baseline.

## Grading

`start --treatment-bit 65536 --band-min 0.03 --band-max 0.12`, two chunks
minimum; read expired/armed and the control answered share at chunk 1. A
control answered share already above 0.37 means free scheduling supplies
the ordering, and the whole family closes with this candidate.
