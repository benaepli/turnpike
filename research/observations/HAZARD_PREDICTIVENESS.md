# Hazard deltas against depth deltas

Whether a hazard-rate delta in an archived objectiveDeltas block has ever predicted the depth-band delta beside it. Every number here is read off decisions the gate already made; nothing was re-run.

- decision records: 42, of which 38 carry both a hazard delta and depth deltas
- depth-delta scale: 26 absolute per-run differences, 12 relative per-second ratios

The four records outside the 38 came from the bench lane, which reports one throughput improvement under both `primary` and `throughput` and has no hazard channel at all.

## Which channels a decision can be audited on

| channel | records measuring it | records comparing it |
| --- | --- | --- |
| h1 | 38 | 0 |
| h2 | 38 | 38 |
| h2b | 38 | 0 |
| h3 | 38 | 0 |
| acted fraction | 12 | 0 |

A channel with a zero in the right-hand column has never entered a decision. It is printed on every run and compared on none, so no past verdict can be scored against it and a criterion phrased on it is unfalsifiable by construction rather than by bad luck.

This is the first result and it is structural, not statistical. Three of the four hazard rates and every acted fraction have never been differenced against a baseline in any recorded decision. The asymmetry that several proposals argue from - a delivery whose sender restarted acted on at one rate, a delivery into a restarted receiver at another - is measured on 12 of 38 comparisons and compared on none of them. There is no sample to audit, at any size.

## Whether the compared channel ever resolved

The between-seed spread of h2 gives a smallest separable delta of 0.0151 absolute. Of 38 archived h2 deltas, 36 are inside it and 2 outside.

| record | h2 delta |
| --- | --- |
| widen-purgatory-hold-to-run-length | +0.0218 |
| prefix-extension-policy-depth-diagnostic | +0.0201 |

A criterion that fires on a quantity which lands inside its own noise floor in almost every comparison is not a weak criterion. It fires on the seed.

Both exceptions had a rising primary, so the two readable hazard moves in the archive are concordant. Two concordant points is one bit of evidence and cannot carry a rule in either direction.

## Sign agreement with each depth band

| pair | n | same sign | expected at these margins | kappa | odds ratio | chi2 | p |
| --- | --- | --- | --- | --- | --- | --- | --- |
| h2 vs depth>=4 | 38 | 68.4% | 53.7% | 0.317 | 4.93 | 4.33 | 0.038 |
| h2 vs depth>=5 | 37 | 59.5% | 48.2% | 0.217 | 2.75 | 2.01 | 0.156 |
| h2 vs depth>=6 | 33 | 48.5% | 48.9% | -0.007 | 0.97 | 0.00 | 0.966 |
| h2 vs depth>=7 | 33 | 48.5% | 48.9% | -0.007 | 0.97 | 0.00 | 0.966 |
| h2 vs depth>=8 | 31 | 41.9% | 50.3% | -0.167 | 0.50 | 0.88 | 0.348 |
| h2 vs primary | 37 | 59.5% | 48.2% | 0.217 | 2.75 | 2.01 | 0.156 |
| h2 vs throughput | 30 | 70.0% | 50.0% | 0.400 | 6.00 | 5.00 | 0.025 |
| throughput vs depth>=6 | 30 | 53.3% | 50.0% | 0.067 | 1.31 | 0.14 | 0.713 |

Signs rather than magnitudes, because the archive writes the depth deltas on two scales and a pooled magnitude would mix them. `expected` is the same-sign rate independence gives at the observed margins, and it is not 50% when one channel is lopsided; `kappa` is the excess over that, so zero is no association and negative is anti-association. The equal rows at depth>=6 and depth>=7 are two different record sets that happen to produce the same table.

Read down the column: the agreement falls monotonically with depth, from a fifth of the way to perfect at depth>=4 to nothing at the rung the objective is named on to slightly negative below it. The strongest association in the table is not with any depth band. It is between h2 and throughput, at kappa 0.40 and an odds ratio of 6. The between-seed measurement already found that the shallow per-second rungs are the session's run count wearing a different name, correlated with throughput at 0.99 at depth>=4. So the h2-to-depth>=4 agreement has an explanation that needs no hazard mechanism: both channels are downstream of how many runs the session got through. Throughput itself does not reach the primary rung either, at kappa 0.067.

`primary` is not one quantity across the archive. It was copied from depth>=5 while the objective was named there, from depth>=6 after, and once from the violations rate, so the band rows are what should be read and the `primary` row is kept only because it is the field decisions were written against.

## Rank correlation inside a scale

| scale | pair | n | rho | p |
| --- | --- | --- | --- | --- |
| absolute | h2 vs depth>=4 | 26 | +0.337 | 0.092 |
| absolute | h2 vs depth>=5 | 26 | +0.226 | 0.259 |
| relative | h2 vs depth>=4 | 12 | +0.343 | 0.255 |
| relative | h2 vs depth>=6 | 12 | +0.259 | 0.390 |

Ranks are never pooled across the two scales. The p is the large-sample normal approximation, which is optimistic at these sample sizes, so it is safe for concluding that nothing separates and not for concluding that something does. Nothing separates. The ordering repeats the sign table: what correlation there is sits at depth>=4 and thins toward the rung that decides.

## Primary up, hazard not resolvably up

| record | verdict | primary band | scale | primary | h2 |
| --- | --- | --- | --- | --- | --- |
| steer-path-fixed-overhead-ablation | auto_merge | depth>=6 | relative | +4.21e-2 | +4.46e-3 |
| client-work-after-every-fault | auto_merge | depth>=5 | absolute | +2.55e-2 | +3.70e-5 |
| stale-delivery-acceptance-distance-census | auto_merge | depth>=6 | relative | +6.43e-3 | -6.50e-3 |
| steer-authority-counter-rewire | auto_merge | depth>=6 | relative | +2.50e-3 | +3.25e-3 |
| counters-piggyback-serialized-block | auto_merge | depth>=6 | relative | +1.66e-3 | -4.78e-4 |
| enable-purgatory-general-config | auto_merge | depth>=5 | absolute | +1.36e-3 | +9.95e-3 |
| recovery-window-length-census | needs_human | depth>=5 | absolute | +4.49e-4 | +7.41e-5 |
| depth-ceiling-diagnosis | needs_human | depth>=5 | absolute | +3.66e-4 | -6.85e-4 |
| config-override-test-state-isolation | auto_merge | depth>=5 | absolute | +3.19e-4 | +5.28e-4 |
| channel-order-probe-offline-trace | needs_human | depth>=5 | absolute | +2.64e-4 | +3.89e-4 |
| timeline-feedback-regression-triage | auto_merge | depth>=5 | absolute | +1.70e-4 | +3.86e-3 |
| util-stats-parse-into-chunk-metrics | auto_merge | depth>=5 | absolute | +1.39e-5 | +1.98e-3 |
| timer-steer-telemetry-export | auto_merge | violations | relative | +1.94e-6 | -2.03e-3 |

13 of the 15 comparisons where the primary rose did so without a hazard move large enough to read, and 4 of the 15 did so with the hazard moving the other way. Whatever carried those, it was not the channel the hazard argument names.

The two largest ladder gains in the archive lead the table. One of them, the guarantee that client work outlasts a fault, moved its band by 23% relative while moving h2 by 3.7e-5 absolute - nine thousandths of one percent of the level, four hundred times below what a seed swap produces. Its argument was about what a schedule contains, not about how often a hazard fires, and the hazard channel registered nothing.

One warning against over-reading the list. None of these primary gains clears its own floor either: at depth>=6 that floor is 12.5% relative and the largest entry is 4.2%. The list is a generator for hypotheses, not a set of measured wins, and a family derived from it still has to separate on its own evidence.

## Corroboration from the level

Read from the status ladder rather than from this script, the whole project is the same comparison at maximum leverage. Between the reference session and the current baseline, P(depth>=4) went from 0.034 to 0.466 and P(depth>=5) from 0.002 to 0.159 - thirteen-fold and eighty-fold. Over the same span h1 went 0.489 to 0.485, h2 0.388 to 0.407, h2b 0.417 to 0.418, h3 0.342 to 0.351. The ladder moved by more than an order of magnitude while every hazard rate stayed within five percent of where it started and one of them fell.

That is the cleanest statement of the finding. The hazard rates are near-saturated properties of the fault schedule: about half of runs already crash a node with sends in flight, about four in ten already deliver across a restart. There is not much room left in them, and the room that remains is not where depth comes from.

## What this licenses

The hazard channel is compared on one of its four members, that member resolves in a small minority of comparisons, and where it is recorded its sign tracks the shallow bands and the run rate rather than the band the objective is named on. So a pre-registered criterion resting only on a hazard rate or an acted fraction cannot fail on evidence: the quantity it watches is inside its own noise floor in the ordinary case, and its direction has no measured relation to the rung that decides.

Concretely, for a proposal whose only pre-registered fire criterion is a hazard rate or an acted fraction:

1. It must additionally pre-register a depth-band criterion, or be downgraded before it is queued. Prefer depth>=4 when a small effect is expected, since it is the only band stable to a tenth of a percent, and read it knowing that it partly measures throughput.
2. If the hazard criterion is kept as well, state it at a magnitude above its own floor - h1 0.0174, h2 0.0151, h2b 0.0164, h3 0.0191 absolute. A criterion written at 1e-3 is written inside the noise and will report success or failure at random.
3. An acted-fraction criterion needs its counter to reach a decision block before it can be a criterion. Until then it is a diagnostic: useful for deciding whether a mechanism fired, useless for deciding whether it worked.

None of this says a hazard is the wrong thing to build toward. It says a hazard rate is a level check and not a gradient, which is what the between-seed spread already implied, and that the archive contains no case of a hazard move predicting a depth move because it contains almost no readable hazard moves at all. The question stays open in the direction that matters: a mechanism that moved a hazard rate by more than 0.015 and moved the primary with it has not yet been built, and if one is, this table is where it would show.

## Method

A record enters if its decision carries an objectiveDeltas block; it enters the hazard tables if that block carries `h2` and all five depth bands. The depth-delta scale is read off whether the record's evaluations report the explorer's own exposure, because the gate switched from an absolute per-run difference to a ratio of events per explore-second when exposure accounting arrived, and ranks from the two are not comparable. Sign tables drop a record where either channel is exactly zero rather than counting it as a tie. Resolution floors are the smallest separable deltas from the between-seed measurement at two chunks per arm.

Sections that read a level rather than a delta are maintained by hand against the status ladder and are not regenerated here.

Regenerate with `node research/observations/hazard_predictiveness.mjs --out research/observations/HAZARD_PREDICTIVENESS.md`, and check the arithmetic with `--selftest`. The tables move as records accumulate, so this is a measurement to repeat rather than a constant to memorise.
