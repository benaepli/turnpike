# crash-fanout-reaction-triggered-arm

Iteration 17, epoch 13. Parent: crash-fanout-phase-anchored-release
(merged 7134f43, spur 6f07962).

## What changes

The placed-crash anchor gains a fourth arm, REACTION, available only on a
salted half of anchored runs (variant bit 1 << 14, crashPhaseReaction,
drawn by run id) and only for a crash whose run has already had a fault.
REACTION releases the held crash while the victim's current handler
segment was woken by a fault-crossing delivery: the origin is currently
crashed, or restarted since it sent. The dispatch site already computes
both facts. The existing 96-step window and cap reserve bound the wait.

Untreated runs, unanchored runs, and any treated run's crashes before its
first fault draw from the merged three-arm table with the merged modulus.
The control is therefore byte-identical to the merged behaviour; a test
pins the arm sequence on untreated anchored runs.

## Why

The chain the depth rung now requires has the initiating node crash while
the reaction to a fault is still in flight. The merged anchor lands crashes
on fan-out of any cause; MID's exactly-one-in-flight bucket rose 5.7 points
against a predicted 10, so the phase draw selects the segment kind only
half the time. Selecting fan-out that a fault caused is the direct lever.

## Frozen prediction

- Bit: CRASH_PHASE_REACTION = 1 << 14, registered in run_variant.rs and
  VARIANT_BITS (decide.ts) in the same change. Treated share about 0.22 of
  runs (half of anchored runs).
- Rung and band: depth>=6 per-run ratio, treated against untreated,
  probe-free, co-bit matched within crashPhase = 1, in [1.02, 1.12].
- Firing: crash_phase.reaction.armed >= 15,000 per chunk;
  crash_phase.reaction.{condition, expired, broadcast_releases,
  skipped_no_fault} exported beside it.
- Independent observable: reaction.broadcast_releases / reaction.condition
  >= 0.50; REACTION's expired/armed reported against MID's 17.4%.
- Falsifier: the depth>=6 interval entirely below 1.02 (treated LOWER); or
  broadcast share below 0.35; or reaction.expired / reaction.armed above
  0.60; or treated steps per run above 1.10x untreated.
- Cost clause: cross-binary throughput at or above 0.97 of the paired
  baseline.

## Grading

`start --treatment-bit 16384 --band-min 0.02 --band-max 0.12`, two chunks
minimum, decide on the internal primary; the merged baseline binary is the
control side.
