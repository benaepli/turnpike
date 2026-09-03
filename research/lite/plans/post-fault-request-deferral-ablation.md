# post-fault-request-deferral-ablation

Iteration 33, epoch 14. Nested ablation of the merged rule from iteration
31 (client-release-into-ghost-consumer-fanout-window, spur f769929).

## What changes

Within the treated half of bit 262144 (clientFanoutRelease), a second salt
on bit 134217728 (1 << 27, clientDeferralOnly) splits the treated runs into
two quarters. On the deferral-only quarter the fan-out-window anchor never
releases a held request: held post-fault requests leave the hold only at
the 32-step expiry or when the ready queue would otherwise run dry. On the
anchored quarter the merged rule runs unchanged. Windows are evaluated and
counted on every run so the two quarters do identical work apart from the
release decision. Counters are indexed by quarter (control, anchored,
deferral-only).

## Why

The iteration-31 grade attributed the depth-10 gain to the deferral, not
to the anchor: the anchor released 7.8% of held requests and 92% expired at
32 steps. If the deferral alone carries the effect, the rule should be
simplified to a plain post-fault deferral and its length studied as a
whole-half contrast later.

## Frozen prediction

- Bit 134217728 set only when bit 262144 is set; own salt; share of all
  runs about 0.24 per quarter. Expiry 32 and dry-queue release identical on
  both quarters.
- Firing per chunk: deferral quarter held >= 350,000, released.anchor == 0,
  (expiry + dry_queue)/held >= 0.99, dry_queue/held <= 0.001, hold steps per
  released in [32, 34]; anchored quarter anchor/held in [0.06, 0.10],
  expiry/held in [0.88, 0.94]; fanout_windows per run within 5% between
  quarters (a larger gap is a finding about downstream activity, not a
  fault); held_at_exit <= 1% of held on both.
- Grader primary (declared bit 27, depth>=8): per-run band [-0.05, +0.05],
  null expected; depth>=9 in [0.90, 1.10] reported; depth>=10 deferral-only
  over anchored per run reported with its interval at four chunks.
- Verdict map at four chunks: hi < 1.0 with point <= 0.55, the window
  matters, keep the merged rule and build the second-acted-ghost anchor;
  lo >= 0.70, the window is ornament, simplify to the deferral; otherwise
  extend to eight chunks and apply the same map; still straddling, file as
  "window adds at most about a third" and simplify on cost grounds
  (operator call).
- Sufficiency read from the cells in the grader's matched scope: the
  deferral-only quarter against the bit-262144-clear control at depth>=10
  must pass the merged rule's criterion (lower edge > 1.0, point >= 1.3)
  before the simplification is licensed; the anchored quarter against the
  same control is expected near 2.5 [1.4, 4.5] as a replication; failing
  both refutes the merged result itself (escalate to the operator).
- Refuters: bit-27 depth>=8 outside [0.95, 1.05]; plan_complete between
  quarters more than 3 points apart; held_at_exit > 1%; steps between
  quarters > 1.02x.
- Cost: throughput >= 0.97 of the current cache, steps <= 1.05x; the
  deferral quarter does strictly less work than the anchored one.

## Grading

`start --treatment-bit 134217728 --band-min -0.05 --band-max 0.05`, four
chunks, extendable to eight per the map. The depth-10 quarter-versus-quarter
ratio and the two quarter-versus-control ratios are read from the cells
with the same scope rule decide.ts uses for a declared bit.

## Verdict (2026-09-03)

Four chunks, 464,474 deferral-only, 464,238 anchored, 929,572 control runs.

| contrast | depth>=9 | depth>=10 | depth>=11 |
| --- | --- | --- | --- |
| deferral-only / anchored (grader primary on bit 27) | 1.044 [0.910, 1.198] | 1.279 [0.848, 1.929] | 1.53 [0.69, 3.39] |
| deferral-only / control | 1.203 [1.085, 1.333] | 2.945 [2.023, 4.285] on 128 vs 87 | 3.87 [1.64, 9.13] |
| anchored / control | 1.152 [1.038, 1.279] | 2.302 [1.549, 3.419] on 100 vs 87 | 2.54 [1.00, 6.45] |

Depth>=8 on bit 27: 0.996 [0.941, 1.054], null held. Firing per chunk as
frozen: deferral quarter held 372,757, released.anchor 0, (expiry +
dry_queue)/held 0.9999, dry_queue/held 0.0001, hold steps per released
33.0; anchored quarter anchor/held 0.078, expiry/held 0.922; fan-out windows
per run 0.3411 against 0.3416; held_at_exit 112 and 115. Plan completion
equal, steps equal. Cost: cross-binary throughput 0.942 (the cost clause
said 0.97; the ablation binary carries three-slot counters and is not the
binary that merges), depth>=8 per second 0.974 inside the layout floor.

Map reading: the lower edge of deferral-only over anchored (0.85) is above
0.70, so the window is ornament and the rule simplifies to the plain
deferral; the sufficiency read passes (deferral-only over control clears
the merged rule's criterion with a lower edge of 2.0) and the anchored
quarter replicates iteration 31 inside its band. The grader's rule read
"human" because the primary is a null test by design; the operator decides
simplify. The deferral length (32 steps) is the next whole-half contrast.
