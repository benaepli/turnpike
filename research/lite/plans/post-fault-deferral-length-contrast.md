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
