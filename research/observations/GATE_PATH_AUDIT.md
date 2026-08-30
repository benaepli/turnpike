# What the non-inferiority path actually did

Established 2026-08-30 over 122 decisions and 59 sequential advances. It
corrects a reading that was about to justify deleting the path for the wrong
reason.

## The path carries almost all the traffic

Keyed by iteration, joining each `select` to its `sequential` verdict and the
recorded decision:

| sequential advance reason | advances | of which merged |
| --- | --- | --- |
| non-inferior | 50 | 28 |
| superiority (separated at z) | 4 | 3 |
| violation | 3 | 1 |
| other | 2 | 0 |

The decision record's own `reasons` field disagrees - it reads 26 superiority
against 9 non-inferior - because it names the merge gate's rationale, not the
sampling verdict that produced the evidence. The two are different gates and
must not be counted interchangeably. `sequential.ts` is what the sampling
verdict comes from, so the sampling verdict is the one that describes how a
merge was earned.

## The compounding ratchet is not real

The thirteen epoch-11 merges that advanced on non-inferiority:

| iter | hypothesis | depth>=6 | pGreater | mei |
| --- | --- | --- | --- | --- |
| 5338 | steer-authority-counter-rewire | +0.0025 | 0.571 | 0.030 |
| 5339 | steer-preference-denominator-counter | -0.0151 | 0.105 | 0.031 |
| 5341 | steer-stats-export-parity-test | -0.0087 | 0.307 | 0.043 |
| 5342 | prefix-extension-policy-depth-diagnostic | +0.0031 | 0.600 | 0.033 |
| 5346 | purgatory-skip-holds-into-down-receivers | -0.0109 | 0.304 | 0.056 |
| 5347 | stale-delivery-acceptance-distance-census | +0.0064 | 0.681 | 0.035 |
| 5348 | counters-piggyback-serialized-block | +0.0017 | 0.559 | 0.030 |
| 5350 | steer-steps-provenance-ablate | -0.0065 | 0.319 | 0.033 |
| 5353 | util-stats-export-completeness-guard | -0.0196 | 0.063 | 0.033 |
| 5358 | crash-anchor-eligibility-base-rate-census | +0.0040 | 0.591 | 0.054 |
| 5359 | steer-decision-site-reachability-probe | +0.0121 | 0.807 | 0.037 |
| 5363 | quiet-stretch-depth-telemetry-readonly | -0.0141 | 0.120 | 0.030 |
| 5367 | recovery-steer-identity-multiplier-placebo | -0.0128 | 0.152 | 0.031 |

They sum to -0.0578 and compound to -0.0568, against +0.0616 from the one
superiority merge of the same epoch. Read as a ratchet that gives back what
the loop earns, that is wrong three ways.

- Every one of the thirteen is inside the counting floor. At depth>=6 a chunk
  carries about 2,000 events on the grid stratum, so the A/A spread is 3.15%
  (`EVAL_NOISE_FLOOR.md`). No `|delta|` here reaches it.
- Thirteen draws at that floor have a sum with sd 0.114. The observed -0.058
  is **0.51 sigma from zero**.
- Seven of thirteen are negative. A sign test gives p = 1.00.

The deltas are also measured against thirteen different baselines, each
refreshed from the previous merge's own chunks, so they are serially dependent
and summing them was never licensed in the first place. There is no evidence
the non-inferiority path eroded the objective.

## The real defect is that the path merges on non-evidence

Every `pGreater` above lies in [0.063, 0.807]. Not one of these merges rested
on a statistic that could distinguish the candidate from the baseline in
either direction. The path is not a ratchet; it is a coin flip that costs a
merge, and each merge moves the baseline the next candidate is measured
against. What accumulates is baseline variance, not objective loss.

That is still a reason to change the rule, and it is the reason to use. It
predicts something different from the ratchet reading: deleting the path
recovers no lost percentage, it stops spending merges on nothing.

## Iteration 5369 is the one genuine case, and it is a different case

`crash-timing-bias-zero-point-ablation` advanced on non-inferiority with
depth>=6 ratio 0.9485 and **pGreater 0.000** - the only advance in the record
where the gate's own posterior resolved harm and the rule did not read it. It
would have merged away the +6.16% that iteration 5361 had earned four hours
earlier. It was stopped by taking the daemon down mid-iteration.

This is what the primary-rung test on the non-inferiority path is for, and the
audit sharpens rather than weakens the case for it: the fix is aimed at
pGreater 0.000, and of the thirteen historical merges above it would have
blocked only 5353 at 0.063. It is a narrow, well-targeted safety fix, not a
policy change, and it should not be justified by the ratchet.
