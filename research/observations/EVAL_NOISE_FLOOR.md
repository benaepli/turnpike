# Evaluation noise floor

Per-seed spread of the metrics the merge gate compares, in the units the gate writes its objectiveDeltas in: a relative change for depth>=k (events per explore-second) and for throughput, an absolute rate difference for the hazards and the mean prefix depth.

- separation z: 2.7
- chunks per arm: 2 (the sequential lane's minimum)
- replicate families: 2, of four seeds each, both unmodified baselines on the config the evaluator loads
- fresh sessions: none yet; `--run` adds them

## Replicate families, pooled

| metric | gate unit | level | per-seed sd | per-seed cv | max seed swing | sampling share | smallest resolvable delta |
| --- | --- | --- | --- | --- | --- | --- | --- |
| depth>=4 | relative | 354.3/s | 3.29/s | 0.93% | 1.02x | 9.4x | 2.5% |
| depth>=5 | relative | 121.0/s | 1.56/s | 1.29% | 1.04x | 5.8x | 3.5% |
| depth>=6 | relative | 28.23/s | 1.31/s | 4.64% | 1.16x | 16.3x | 12.5% |
| depth>=7 | relative | 5.948/s | 0.337/s | 5.67% | 1.18x | 5.1x | 15.3% |
| depth>=8 | relative | 0.954/s | 0.078/s | 8.20% | 1.25x | 1.8x | 22.2% |
| h1 | absolute | 0.4857 | 6.45e-3 | 1.33% | 1.03x | 20.5x | 0.0174 |
| h2 | absolute | 0.4076 | 5.59e-3 | 1.37% | 1.03x | 17.5x | 0.0151 |
| h2b | absolute | 0.4204 | 6.09e-3 | 1.45% | 1.03x | 20.5x | 0.0164 |
| h3 | absolute | 0.3580 | 7.08e-3 | 1.98% | 1.04x | 31.5x | 0.0191 |
| meanPrefixDepth | absolute | 3.2768 | 4.46e-3 | 0.14% | 1.00x | - | 0.0120 |
| throughput | relative | 756.6/s | 7.51/s | 0.99% | 1.02x | - | 2.7% |

## Per family

The pooled row hides how far the two families disagree, and a family is also a host mask, which is not part of what makes two sessions replicates.

| family | seeds | depth>=4 | depth>=5 | depth>=6 | depth>=7 | depth>=8 | throughput |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline @30t seeds 1000,1001,1002,1003 | 4 | 1.01% | 1.07% | 1.44% | 1.98% | 5.74% | 1.08% |
| baseline @14t seeds 1000,1001,1002,1003 | 4 | 0.84% | 1.47% | 6.40% | 7.77% | 10.08% | 0.89% |

## Reading

`per-seed sd` is the spread of one metric across sessions that differ only in the session seed, pooled over families by degrees of freedom. `sampling share` is the observed variance divided by the variance the metric's own event count would give if every run were an independent draw: above 1 is noise the gate does not charge for.

`smallest resolvable delta` is the per-seed spread carried through the pooling the sequential lane does. An arm pooling m chunks divides its variance by m, and a delta is a difference of two arms, so the delta's spread is the per-seed spread times sqrt(2/m). At two chunks per arm that factor is one: **the noise on an objectiveDelta is the per-seed spread of the metric itself**, and the smallest delta separable from a seed swap is z times it. A candidate held to two chunks against a four-chunk baseline gets sqrt(1/2 + 1/4) = 0.87 of these figures.

A delta below its floor is not weak evidence of a small effect. It is the size of the difference two seeds of one unchanged binary produce, so its sign carries no information.

## What the numbers say

**A hazard delta of 1e-4 is 150 times below the floor.** h2 moves 5.6e-3 between seeds of one binary, so its smallest resolvable delta is 0.015. Every h2 delta in the record is inside that, and so is every h1, h2b and h3 delta. The hazard rates are not a gradient at this session size; they are a level check.

**The shallow depth rungs measure throughput.** In the 30-thread family the per-seed deviations of the depth>=4 per-second rate are -1.07%, +0.18%, -0.42%, +1.31%, and the same seeds' throughput deviations are -1.16%, +0.42%, -0.55%, +1.30% - the same numbers, correlated at 0.99. The per-second rate at depth>=4 is the session's run count wearing a different name, and its spread is throughput spread, not depth spread. Per graded run that rung has a spread of 0.17%, against 0.21% from binomial sampling alone: sub-binomial, as the earlier depth-bucket work found. So the per-second objective inherits a common-mode floor of about 1% from throughput, and no per-second rung can resolve below roughly 2.7%, however many events it carries.

The transfer is not uniform. At depth>=6 the per-seed deviations are +2.02%, +0.03%, -0.86%, -1.19%, correlated at -0.73 with the same seeds' throughput: the campaign's short-iteration arm buys run count at the cost of deep runs, so a seed that runs fast is a seed that goes shallow, and the two partly cancel. A per-second rung deep enough to be event-limited is measuring depth; a shallow one is measuring the clock.

**The deep rungs' floor is not yet pinned.** The two families disagree by a factor of four at depth>=6 and depth>=7. They differ in host mask, 30 threads against 14, which is not part of what makes two sessions replicates but does change how many runs share a feedback snapshot. With three degrees of freedom each, a variance ratio of 12 is at the edge of what chance explains, so this is a real difference or a near-miss, and four seeds cannot tell which. The pooled figure is the conservative reading and the 30-thread figure is the optimistic one; the loop runs at 30.

The consequence for sampling: resolving a relative effect e at z with m chunks per arm needs m >= 2 (z cv / e)^2. At depth>=6 a +25% effect needs one chunk on either estimate. A +10% effect needs one chunk at the 30-thread spread and four at the pooled spread. A +5% effect needs two and thirteen. The class of effect the loop actually merges is exactly where the two estimates prescribe different budgets, which is why the six-seed single-mask measurement is worth its wall clock.

## Archived verdicts against the floor

One record was decided by the sequential lane on the current objective. The rest predate it or came from the bench lane, where the deltas are on a different scale.

| hypothesis | verdict | resolvable deltas | inside the floor |
| --- | --- | --- | --- |
| steer-path-fixed-overhead-ablation | auto_merge | none | depth>=4 0.0179, depth>=5 0.0319, depth>=6 0.0421, depth>=7 0.0599, depth>=8 0.0896, h2 4.46e-3, throughput 0.0239 |

This does not overturn the verdict: that ablation merged on non-inferiority, a claim that nothing moved, and every delta sitting inside the floor is what that claim predicts. What it does say is that no merge on the current objective has yet rested on a delta the floor can resolve, so the re-grade has nothing to overturn and the question stays open until one does.

## Method

A replicate family is a set of evaluations sharing hypothesis, fidelity, both commits, config, spec and grader version, and differing only in seed. Each family contributes its own coefficient of variation, weighted by its degrees of freedom, because families sit at different levels by construction. Level metrics with no underlying event count report no sampling share. Only families whose sessions carry the explorer's own exposure are included, since the rest were graded on the per-run objective and their rates are on a different scale; `--all-families` widens the set at the cost of mixing the two.

`--run` adds a fresh family: sessions at consecutive seeds on the current binary and the config the evaluator loads, with no code or config change, materialised the way the evaluator materialises them. It is the homogeneous estimate, and the one that settles the depth>=6 disagreement above; the archived families corroborate it across binaries. Six seeds at the 300 s budget cost about fifty minutes of serial explore plus grading, so it belongs in an audit slot rather than an evaluation slot.

Regenerate with `node research/observations/eval_noise_floor.mjs`, and refresh the fresh family with `--run` when the binary or the session budget changes. The floor is a measurement to repeat, not a constant to memorise.

## Superseded for the rate the gate separates on (2026-08-29)

The per-family depth>=6 disagreement above (1.44% per-seed cv at 30 threads
against 6.40% at 14) was measured on the pooled ladder, which pools the aos
arm. That arm's chunk-to-chunk cv at depth>=6 is 7.1% to 22.3% depending on
the baseline, against 0.4% to 1.4% for the four grid arms, so the pooled
figure is dominated by an arm the gate no longer separates on. Since epoch 11
the statistic reads the grid stratum, whose dispersion is at or below its own
counting floor. The sampling-budget prescriptions in this file are computed
from the pooled cv and are therefore conservative by roughly a factor of two
in standard error; recompute them on the stratified rate before using them.
The six-seed single-mask measurement this file asks for is still worth its
wall clock, because the thread-count question it was aimed at is separate
from the arm question and is not answered here.

## The null band on the stratified rate is a counting floor (2026-08-30)

Two evaluations in the record are accidental A/A pairs: the candidate binary
explores the same schedules as the baseline, so every delta they produced is
noise by construction.

- Iteration 5367, `recovery-steer-identity-multiplier-placebo`. The multiplier
  is clamped to 1.0, and `recovery_weight_placebo.flipped` is 0 across both
  seeds against 199,560 and 206,701 evaluations of the term, so no candidate's
  rank ever changed. It carries a real code-path cost (`params` +1, throughput
  -1.05%) but no change of schedule.
- Iteration 5352, `hazard-rate-vs-primary-decorrelation-audit`. The diff
  touches no file under `spur/` or `scheduler_configs/`, so the campaign ran
  the baseline binary on the baseline config. `params` 0, throughput -0.03%.

Seed-to-seed on the grid stratum, against the Poisson floor its own event
count implies:

| rung | 5367 | 5352 | 1 sigma from counts | events per chunk |
| --- | --- | --- | --- | --- |
| depth>=4 | +0.43% (0.62 s) | +0.26% (0.36 s) | 0.70% | 41,000 |
| depth>=5 | +1.51% (1.06 s) | +0.76% (0.53 s) | 1.43% | 9,700 |
| depth>=6 | +3.28% (1.04 s) | -1.13% (0.36 s) | 3.15% | 2,000 |
| depth>=7 | +2.26% (0.28 s) | -4.73% (0.61 s) | 7.9% | 320 |

Eight comparisons, every one inside 1.1 sigma. On the stratified rate the
observed dispersion is the dispersion the event count alone predicts, so the
sampling share of this file's pooled table - 5.8x at depth>=5, 16.3x at
depth>=6 - is excess that stratification removed rather than variance the
metric carries. Two pairs corroborate that; they do not measure the variance
ratio, which still wants the six-seed family.

**The band is therefore computed, not looked up.** For a candidate and a
baseline carrying `ec` and `eb` events at a rung, the A/A spread is
`sqrt(1/ec + 1/eb)`. Nothing needs to read a number out of this file, and
nothing goes stale when the arm set or the budget changes.

At the primary rung that is about 3.1% for a chunk against a chunk. The gate's
own `mei` on the same runs was 0.0310 (5367), 0.0319 (5369) and 0.0361 (5361),
so the minimum effect the gate claims to separate already equals the counting
floor, which is the coherence this reading predicts. Iteration 5361's +6.16%
is about twice that floor, which is why it separated on two chunks.

An earlier reading of 5352 alone put the band at `|primary| <= 0.003`. That is
one draw of a quantity whose spread is 0.031, and it understated the floor
tenfold; `OBSERVATIONS.md` records the correction at
`recovery-steer-identity-multiplier-placebo`. Any rule that treats a
sub-3% move at the primary rung as evidence is reading counting noise.

## Arm-mix drift is an aos phenomenon

`round_robin` gives each arm a fixed wall slice, so an arm's run count varies
with how fast it runs rather than being held. Between the two 5367 seeds:

| arm | runs | drift |
| --- | --- | --- |
| grid | 38,784 -> 38,784 | 0.00% |
| grid-short | 127,904 -> 127,168 | -0.58% |
| grid-no-purgatory | 37,728 -> 37,472 | -0.68% |
| grid-post-fault-2 | 40,416 -> 40,864 | +1.11% |
| aos | 35,392 -> 40,160 | +13.47% |

The four grid arms hold their run counts to about 1%; `aos` moves 13.5%, and
its depth>=6 rate moves 14.8% with it. Mix drift across a pooled ladder is
almost entirely this one arm, which is what the epoch-11 stratification
excluded. The concern recorded against the recovery-selection site - that
arm-mix drift makes single-term A/B deltas uninterpretable there - is correct
for the pooled figures it was raised against and does not carry to the
stratified statistic the gate has read since.
