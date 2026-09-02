# purgatory-blind-delay-default-ablation

status: step 1 MERGED (see decisions.jsonl); step 2 posture form open | origin: proposer | judge gain 8, cost 0, net 8

## Step 1 (this session): pure ablation, config-only

`purgatory.delay_probability` 0.15 -> 0.0 in general_vr.json, nothing else.
Same binary as baseline. Arm set unchanged; grid-no-purgatory's overlay
becomes a no-op, so that arm equals grid for this step and the arm census
carries no internal control. The cross-binary gate and the panel are the
evidence. The posture form (step 2, below) is built only if this separates.

## Frozen prediction for step 1 (frozen at admission)

- firing: `purgatory.delayed_sends` per chunk falls below 1% of the
  baseline's 46.3M - the mechanism is off everywhere
- rung depth>=6, sizePct 0.08 .. 0.32
- independent observables: the grid arm's per-run P(depth>=6) rises from
  about 0.057 toward the 0.071 grid-no-purgatory already reads;
  `delivery_effects.all.acted_fraction` rises above 0.3739; steps per
  completing run falls
- falsifier: delayed_sends below floor and pooled depth>=6 per
  explore-second below 1.05 net of a same-session A/A; or the panel
  regresses (paxos below 0.90 x 220.95 or mencius below 0.90 x 6.35)

## Why this contradicts the record and why that is answered

OBSERVATIONS.md:2765 recorded per-run P(depth>=6) 0.0246 at rate 0 against
0.0410 at 0.15, and :3001 recorded grid-no-purgatory at -41% on the
objective. Both predate the fault-timing merges of 2026-08-31/09-01. On the
current baseline the same two arms read 0.0567 vs 0.0714 and 0.0578 vs
0.0712 per run on seeds 1000 and 1001 - the undelayed arm ahead by 25.8%
and 23.3% per run, 32.2% and 33.6% per explore-second. The sign flipped
when crash placement began supplying the fault-versus-traffic separation a
blind delay used to supply by accident.

## Caveat on the rung, standing

Purgatory is the only mechanism that reorders ordinary traffic, and the
oracle cannot see whether a delivery came from a dead incarnation. The rung
can rise here while the ablation removes reordering the real target needs.
The panel is the observable for that, and it is in the falsifier.

## Step 2 (if step 1 separates): posture form

Keep `delay_probability` 0.15 and add `purgatory.posture_share` applying the
configured rate on one run in eight via a salted posture, 0.0 on the rest,
so grid-no-purgatory's overlay still zeroes that arm and an internal
delayed-versus-undelayed control survives. Variant bit, counters
`purgatory_posture.delayed_runs` / `.undelayed_runs`. Judge's rewritten
prediction applies.
