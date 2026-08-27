# Depth-bucket power floor

Between-seed spread of each prefix-depth bucket, measured on archived evaluation records. Replicates are evaluations that share hypothesis, fidelity, both commits, config, spec and grader version, and differ only in seed.

- records: 34 evaluations in 16 same-arm seed families
- fidelity: sequential
- session size: 54000 graded runs per arm
- separation z: 2.7
- treatment effect held plausible: +50% relative
- families dropped for a ladder shorter than depth>=8 (graded against a different oracle graph): 2

| bucket | pooled rate | events/session | families | dispersion | median seed swing | max seed swing | resolvable effect | binomial-only | dispersion-charged | powered |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| depth>=4 | 3.60e-1 | 19426.7 | 16 used, 0 too sparse | 0.31 | 1.00x | 1.01x | 2% | 2% | 1% | yes |
| depth>=5 | 9.26e-2 | 5000.4 | 16 used, 0 too sparse | 0.64 | 1.02x | 1.03x | 5% | 5% | 4% | yes |
| depth>=6 | 1.47e-2 | 791.3 | 16 used, 0 too sparse | 0.72 | 1.04x | 1.08x | 13% | 13% | 11% | yes |
| depth>=7 | 1.67e-3 | 90.0 | 16 used, 0 too sparse | 0.48 | 1.08x | 1.22x | 40% | 40% | 28% | yes |
| depth>=8 | 6.10e-5 | 3.3 | 4 used, 12 too sparse | 0.15 | 1.50x | 3.00x | 210% | 210% | 80% | no |

## Reading

`dispersion` is observed between-seed variance over the variance binomial sampling alone would give. 1 means a seed swap costs nothing beyond sampling; above 1 means the gates understate the noise by that factor; below 1 means two seeds of the same binary agree more closely than independent draws would. `resolvable effect` is the smallest relative change one session per arm could separate at the stated z, and it is the larger of the two columns beside it: the gates compute binomial intervals, so dispersion under 1 is margin they cannot spend, while dispersion over 1 is noise they failed to charge. A bucket whose families are all too sparse to score has no dispersion estimate, which is itself the finding: its counts are single digits.

## Power floor

**depth>=7 is the deepest bucket with power at 54000 runs per arm, against a +50% effect.**

Buckets deeper than that are worth recording - a rare event is still an event - but a verdict must not rest on them. A difference there is inside the range two seeds of the same binary already produce, so accepting or rejecting on it decides by coin flip, and the decision is unreproducible by construction.

### Sensitivity to the effect held plausible

| plausible effect | power floor |
| --- | --- |
| +25% | depth>=6 |
| +50% | depth>=7 |
| +100% | depth>=7 |

## Objective definition note

The objective is violations first, then P(prefix depth >= k), then the stale-incarnation hazard rate. This measurement bounds the second term: only buckets up to depth>=7 carry decision weight at the current session size and the effect held plausible. Deeper buckets stay in the record, stay in the reported deltas, and stay as escalation triggers when they fire against a baseline that never reaches them, but they are not gradients, and a gain on one of them alone is not an improvement.

Regenerate with `node research/observations/power_floor.mjs --out research/observations/POWER_FLOOR.md`. The floor moves when session size or the archived record set changes, so it is a measurement to repeat, not a constant to memorise.

## What the table says beyond the floor

Three results carry further than the headline.

**depth>=8 resolves nothing.** It runs at 3.3 events per session. Even under the gates' own noise model it takes a +210% change to separate two sessions, and only 4 of 16 families have enough events for a dispersion estimate at all. The 3.00x maximum seed swing is two seeds of the same binary, same config, same commit: 1 event against 3. No plausible treatment effect survives that, and no amount of chunking at the current session size repairs it, because the deficit is in events per session and not in the number of sessions pooled. A hypothesis scored on depth>=8 is scored on a coin flip.

**depth>=7 is a boundary case, not a frontier.** At 90 events per session it needs a +40% change to separate. That is inside the range a hypothesis with a genuine mechanism might produce, so the bucket is not useless, but it cannot see the +10% to +25% class of effect that describes every change merged so far. Read a movement there as a hint that justifies more sampling, never as a verdict.

**The gates are conservative, not optimistic.** Dispersion is below 1 at every bucket where it is estimable: 0.31, 0.64, 0.72, 0.48. Two seeds of the same binary agree more closely than independent Bernoulli draws over the same number of runs would - the 54000 runs of a session are a stratified sweep rather than 54000 independent samples, so the session-to-session term is smaller than the within-session term the gates already charge. The practical consequence is one-directional: a binomial interval on a depth bucket is wider than the truth, so a separation the gate reports is real, while a null it reports may be an effect the interval was too wide to see. It also means the correct reading of a large relative swing on a sparse bucket is sampling noise on few events, not extra variance between sessions - at depth>=6, one session against two is 3.1% at one sigma, so swings of several percent are ordinary.

## Method

For each family and bucket, the Pearson statistic sum over seeds of (count - n p)^2 / (n p (1 - p)), with p pooled within the family, is summed across families and divided by the total degrees of freedom. Families whose expected count falls below 5 for any seed are excluded from that bucket's statistic and reported as too sparse, since the chi-square approximation does not hold there. The resolvable effect is the delta-method standard error of a log rate at the given dispersion, doubled for two independent arms and scaled by z.

Two families are excluded entirely: their ladders stop at depth 5, so they were graded against a different oracle graph and their rates are on a different scale. A ladder that stops short inside a qualifying family is ordinary truncation at the deepest depth that run set reached, and its missing entries are true zeros.
