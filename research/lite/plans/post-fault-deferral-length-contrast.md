# post-fault-deferral-length-contrast

Iteration 36, epoch 14. Built on spur 327bf72.

## What changes

see pool entry post-fault-deferral-length-contrast

## Why

the deferral length has never been varied; iteration 33 showed the delay carries depth 10

## Frozen prediction (as admitted; graded, never rewritten)

```json
{
 "treatmentBit": {
  "name": "clientDeferralLong",
  "value": 268435456,
  "shift": 28,
  "nestedIn": [
   "clientFanoutRelease (262144)"
  ],
  "reuse": "none: a fresh row",
  "salt": "own",
  "treatedShareOfAllRuns": 0.24,
  "probesExempt": "by inheritance from bit 18"
 },
 "rung": "depth>=8 (epoch 14 primary), per-run ratio long quarter / short quarter, probe-free, co-bit matched within clientFanoutRelease = 1",
 "band": [
  0.94,
  1.06
 ],
 "bandNote": "null expected at the primary",
 "advanceRungs": {
  "depth>=10": {
   "mergeClaim": true,
   "expected": "long/short per run >= 1.25 with the lower edge above 1.0, pooled over four chunks (about 120-150 events per quarter); if the interval straddles 1.0 at four chunks, extend to eight and apply the same rule"
  },
  "depth>=9": {
   "expected": [
    0.95,
    1.15
   ],
   "reported": true
  },
  "depth>=11": {
   "reported": true
  }
 },
 "decisiveContrast": "64-step quarter versus 32-step quarter at depth>=10; the 32-step quarter must reproduce iteration 33's rate (about 0.00026 per run) as the check that nothing else moved",
 "firing": {
  "counter": "client_anchor.long.released.expiry",
  "floorPerChunk": 150000,
  "also": [
   "long quarter hold steps per released in [63, 66]; short quarter in [32, 34]",
   "long quarter held_at_exit / held <= 0.1% (short quarter reads 0.007%)",
   "released.dry_queue reported on both quarters (short reads about 1 in 10,000)",
   "fanout_windows per run equal within 5% across quarters"
  ]
 },
 "independentObservable": {
  "statement": "on a kept explore, among treated depth-9 runs the share whose w2 is invoked after deliver_dvc_2_to_1 lands is higher on the long quarter than on the short (census tool, both quarters); reported, not gated"
 },
 "falsifier": "depth>=10 long/short interval entirely below 0.90 (64 overshoots node 0's view change: record, and propose 16 under the same bit); or plan_complete more than 3 points below the short quarter; or steps per run > 1.05x the short quarter; or held_at_exit / held > 0.1%; or the short quarter's depth>=10 rate outside [0.00020, 0.00032] (the control moved, the read is not about the dose)",
 "cost": "cross-binary throughput >= 0.97 of the paired cache; steps <= 1.05x",
 "decisionMap": "lower edge > 1.0 and >= 1.25 -> merge 64 as the rule; interval entirely below 0.90 -> keep 32, next dose 16; straddling at eight chunks -> file as 'length insensitive in [32, 64]' and close the dose line",
 "rewritten": true
}
```

## Implementer watch (from the judge)

A clean dose on the one merged lever that moved depth 10, with both directions of failure named in the falsifier. The 'few dozen steps' timing earns no evidence credit (unchecked, not false). Rewritten: eight-chunk extension rule when the interval straddles; overshoot reading names 16 as the next dose; held_at_exit clause tightened from 3% to 0.1% (the 32-step quarter reads 0.007%, so 3% could never fire).

## Grading

`start --treatment-bit 268435456 --band-min -0.06 --band-max 0.06`, four
chunks; the decisive contrast and the extension rule are in the prediction.

## Four-chunk read (2026-09-04, session post-fault-deferral-length-contrast)

417,655 long against 421,063 short runs. Depth>=8 long/short 0.969 [0.903,
1.040] (band met); depth>=9 0.980 [0.855, 1.123]; depth>=10 1.078 [0.740,
1.572] on 138 against 129 events; depth>=11 35 against 31. Both quarters
against the bit-18-clear control: depth>=10 short 3.43 [2.32, 5.07], long
3.70 [2.51, 5.44] - the 32-step quarter reproduces iteration 33 (2.95) and
iteration 31 (2.52) within noise. Firing as frozen: hold steps per
released 33.00 and 64.99; held_at_exit 0.009% and 0.025% (clause 0.1%
met); dry-queue 184 and 186. Cost read is contaminated: chunk 1 of the
candidate overlapped another implementer's smoke explore (candidate
depth-8 per second 16.8 against 22-25 on chunks 2-4), so the session's
throughput ratio of 0.868 is not a clean reading; steps per run between
quarters 1.0045x. The depth>=10 interval straddles 1.0, so the frozen
rule extends to eight chunks: a second four-chunk session on the same
binary (post-fault-deferral-length-contrast-b) is queued and the two are
pooled by cell counts.

## Eight-chunk verdict (2026-09-04, sessions -contrast and -contrast-b pooled)

| rung | long / short per run | interval | z | events long / short / control |
| --- | --- | --- | --- | --- |
| depth>=8 | 0.980 | [0.945, 1.017] | -1.46 | 10,804 / 11,094 / 21,127 |
| depth>=9 | 1.035 | [0.953, 1.124] | 1.12 | 2,162 / 2,103 / 3,374 |
| depth>=10 | 1.281 | [1.019, 1.609] | 2.93 | 318 / 250 / 157 |
| depth>=11 | 1.240 | [0.763, 2.016] | 1.20 | 69 / 56 / 38 |

The merge claim (depth>=10 long over short >= 1.25 with the lower edge
above 1.0) is met on the pool; the second session alone read 1.50 [1.09,
2.05] and the grader's rule separated it up on the advance rung. Against
the bit-18-clear control the long quarter reads 4.07 on depth 10 and the
short quarter 3.18. Depth>=8 null held. Firing as frozen in both sessions.
Cost: the second session's throughput 0.967 (the first was contaminated),
steps between quarters 1.005x, held_at_exit 0.025%. Decision: merge as the
simplified rule - the post-fault deferral is 64 steps on the whole treated
half, the bit-28 quartering is not kept. The next dose, if any, is 128
against 64; a per-run adaptive length (release on the first ghost entry
at the new primary) is the mechanism-level follow-up.
