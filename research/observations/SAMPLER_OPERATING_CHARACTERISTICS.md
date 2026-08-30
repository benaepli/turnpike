# What the sequential sampler costs, and what the gate then does with it

Measured 2026-08-30 with `npx tsx src/selftest_sequential.ts 200`, 200 draws
per shape against the live 14-thread baseline (4 chunks, 1,101,792 runs),
policy `maxChunks=4 minChunks=2 inconclusiveP=0.9 throughputFloor=0.8`.

The sampler now decides only when to stop. Its own tally has two terminal
outcomes - `stop` and `inconclusive` - and neither says what becomes of a
candidate. The gate verdict beside it is `ruleVerdict` on the same figures,
with no decider and no diff, which is what the loop falls back to whenever a
decider answer is unavailable.

| shape | stop | inconc | merge | close | human | chunks | chunks before |
| --- | --- | --- | --- | --- | --- | --- | --- |
| null (A/A) | 100% | <1% | 0% | 0% | **100%** | 4.0 [4-4] | 4.0 [4-4] |
| +25% d6 | 100% | 0% | 100% | 0% | 0% | 2.0 | 2.0 |
| +25% d6 at 0.7x throughput | 100% | 0% | 0% | 100% | 0% | 2.0 | 2.0 |
| flat depth at 1.4x throughput | 100% | 0% | 100% | 0% | 0% | 2.0 | 2.0 |
| +12% d4, +15% d5 | 100% | 0% | 100% | 0% | 0% | 2.0 | 2.0 |
| harmful (-40% d4 per run) | 100% | 0% | 0% | 100% | 0% | 2.0 | 2.0 |
| d7-only +40% | 100% | <1% | 0% | 0% | **100%** | 4.0 [4-4] | 4.0 [4-4] |
| h2-only +10% | 100% | <1% | 0% | 0% | **100%** | 4.0 [4-4] | 4.0 [4-4] |
| 1.4x throughput, -15% per-run d6 | 100% | 0% | 100% | 0% | 0% | 2.0 | 2.0 |
| 1.4x throughput, -25% per-run d6 | 100% | 0% | 4% | 3% | **94%** | 3.9 [2-4] | 3.9 [2-4] |
| -40% per-run d6 only | 100% | 0% | 0% | 100% | 0% | 2.0 | 2.0 |

## The collapse cost zero chunks

Every chunk-count entry is identical to the table measured before it, on
every shape, to the draw. That is the whole test: the stopping conditions -
the throughput floor, a resolved per-run guard, a separated rung with the
guards held, and the cap - are the same conditions in the same order, and
only the name of the verdict and the reader of it changed. A moved chunk
count would have meant a stop condition was deleted.

The unification of the deep-rung guard moves the sampler's Monte Carlo seed
for depth>=5 and depth>=6. It does not move a chunk count either.

## What changed is who reads the stop

Three shapes that used to be deleted as negative results now reach a person:
the null, `h2-only`, and the deep-rung gain. None of the three resolves
anything against the candidate, and a closure claimed that it did. The
`d7-only` and `-25% per-run d6` shapes reached a human before, through the
escalate; they reach one now through the gate, which is the same outcome by
one mechanism instead of three.

The `-25% per-run d6` row is the shape the whole change exists for. Its
per-second rate is up on every rung, the primary rung is not separated below
the baseline, and nothing reads as regressed - so with the deep per-run guard
merely *unresolved* rather than held, every other post-condition passes and
the candidate merges unattended. It reaches a human 94% of the time because
the guard is unresolved. The 4% that merges is the guard resolving held on
the draw, which is a clean gain and the same 4% that used to advance; the 3%
that closes is the guard resolving regressed.

## Nothing merges on a sample that resolved nothing

The gate can now merge a flat result, which is what lets a telemetry change
or an inert ablation be judged at all. It is bounded in code: a candidate
with no separated improvement may merge only where the hypothesis stated a
prediction before sampling, the mechanism was seen to fire, and the predicted
rung landed in the band claimed for it. Without all three the merge is held
for review. No recorded hypothesis carries a prediction, so across the whole
replay this post-condition is inert and cannot have moved a historical row.

## The null band at the live counts

Two gate readings are expressed against `primaryNullBand`, the counting floor
`sqrt(1/ec + 1/eb)` on the primary rung's own stratum event counts. It is
arithmetic on the sample in hand, not a constant, so it follows the arm set
and the budget.

The live 14-thread baseline carries **9,890 depth>=6 grid-stratum events per
chunk** (`baseline:14` in `research/state.sqlite`, seeds 1000-1003: 9,761 /
9,909 / 10,007 / 9,883). The evidence file `000-baseline-14.json` carries
8,993. At those counts:

| comparison | band |
| --- | --- |
| chunk against chunk | 1.42% |
| 2-chunk candidate against 4-chunk baseline | 0.87% |
| 4-chunk candidate against 4-chunk baseline | 0.71% |
| 8-chunk candidate against 4-chunk baseline | 0.67% |

The band replaces the sampler's primary-down cross-check, which refused a
shallower-rung gain when depth>=6's posterior put `pGreater` below 0.10.
Measured on the live baseline with a 2-chunk candidate, that cross-check
first fires at a depth>=6 delta of -2.05% and does not fire at -1.55%; the
band reading first fires at -1.06% and does not fire at -0.56%. The
replacement is therefore strictly stricter - it covers everything the
cross-check covered, plus the band from -0.87% to -1.7% - and it hands the
case to a person where the cross-check deleted it.

`depth>=7` is a separate rung and carries about 2,020 stratum events a chunk,
a fifth of depth>=6. A band read off that column is 2.2x too wide.

## Reading the table

Every shape that resolves cleanly still does so at the two-chunk minimum. The
sampler's cost is concentrated in the shapes it cannot separate - the null,
`h2-only`, the deep-rung conflict and the deep-rung gain - and those are what
the mid-run stopper is there to cut short. Whether it answers at all remains
the first thing to watch: the fallback is `continue`, and a stopper that
never answers pays the cap on every null without saying so.

Under a decider outage the dominant "nothing separated" class falls to
`human`, which opens a PR and buys the regression suite. That is the review
queue to watch first.
