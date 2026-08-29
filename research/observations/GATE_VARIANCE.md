# The gate charges as certainty what a seed swap produces

The deep-rung exclusion described below was fixed at epoch 9: depth>=7 and
depth>=8 now decide, and the resume gate consults them. The hazard-variance
and depth>=4 placement problems are unchanged and still stand as written.

Two rejection criteria fail, for different reasons, and both were exercised
tonight on candidates in the directions the operator named.

Reporting only. Changes no gate.

## The hazard criterion models a variance it does not have

`sequential.ts` rejects on `max(g4.pRegress, h2.pRegress, deepRegress)`, and
`h2.pRegress` comes from a Poisson comparison of counts over runs. That
models the between-session spread of h2 as sampling from its own event count.
It is not.

`EVAL_NOISE_FLOOR.md`, measured on replicate sessions differing only in seed:

| rate | between-seed sd | sampling share |
| --- | --- | --- |
| h1 | 6.45e-3 | 20.5x |
| h2 | 5.59e-3 | 17.5x |
| h2b | 6.09e-3 | 20.5x |
| h3 | 7.08e-3 | 31.5x |

At a quarter of a million runs h2's binomial standard error is about 9.7e-4
while its between-seed spread is 5.6e-3, so the model is tight by a factor of
about six. A difference of 1e-2 is ten binomial standard errors and under two
seed spreads: overwhelming to the gate, indistinguishable to the experiment.

Iteration 5327 was rejected on exactly that. `timer-effect-steer` moved h2 by
-9.9e-3 absolute, against a smallest resolvable delta of 1.5e-2. The report
that measures this had merged three hours earlier and says of such a delta
that "its sign carries no information".

The same report says every h1, h2b, h3 and h2 delta in the record is inside
its floor. The hazards are a level check, not a gradient, and a criterion
that rejects on their movement rejects on the seed.

## The shallow-depth criterion is sound and aimed at the wrong rung

The other guard, `depth>=4` per graded run, does not have this problem: the
same measurement finds that rung sub-binomial per run, 0.17% observed against
0.21% from sampling, so its confidence interval is conservative and the
movements it fires on are real.

It is the placement that fails. Truncating runs is what the guard is for, and
truncation does not show at depth>=4: the arm that caps iterations at 1500
moves that rung +0.4% per run while costing 7.1% at depth>=6 and 10.9% at
depth>=7. Four candidates in the stall family span 0.970 to 0.987 on the
guarded statistic while spanning a 45% to 95% throughput gain, per-run
depth>=7 effects from +4.5% to -7.8%, and one violation against none. See
`PLAN_STALL.md`.

## What the two cost

Five candidates were closed on these two criteria in one night: four in the
stall family on depth>=4 per run, and `timer-effect-steer` on h2. Both
directions were the ones the operator had named as most important. Neither
criterion was reading the quantity that distinguishes the candidates from
each other.

Nothing here says any of the five should have merged. Four of them are one
chunk each, and at one chunk against a four-chunk baseline the depth>=6 and
depth>=7 gains sit above the optimistic per-seed floor and below the
conservative one, a disagreement `EVAL_NOISE_FLOOR.md` says four seeds cannot
settle. What it says is that the sequential lane exists to accumulate chunks
until a signal separates, and in five cases it stopped at the first one on a
statistic that could not separate anything.


## A violation is credited to whoever was running

A non-zero violation count short-circuits `primary` and forces `advance`,
whatever the rungs say. That was harmless while no evaluation had ever seen
one. Tonight three appeared in 5,035,980 runs, about one per 1.68 million, and
a chunk is roughly 260,000 runs, so a chunk carries a violation about 15% of
the time. Around one evaluation in six can now advance, and merge, on a
violation it did not cause.

It has happened twice already. Iteration 5311 advanced on a violation from the
`aos` arm, which its config sweep did not touch, and was closed on its own
evidence only because arm-kind changes route to human review. Iteration 5328
auto-merged on a violation from the `grid-post-fault-2` arm while being a
telemetry export that changes no behaviour, with its gate reason recorded as
"improved: violations".

The merges are not wrong on their merits; the attribution is. A violation
belongs to the configuration that produced it, and the arm it came from is
recorded in `violating_runs.json` alongside the arms the candidate actually
changed. Comparing those two is enough to tell whether a candidate can claim
the credit.

## The mechanism check that is missing

`timer-effect-steer` is worth re-running rather than re-deciding, and the
reason is in its counters rather than its deltas: `timer_steer` recorded
3,014,627 evaluations, 1,751,249 admissions lowered and 438,499 raised, and
the predicate it keys on separates cleanly - idle timer firings act at 6.0%
against 16.8% for firings with a delivery in flight. A change that fires
three million times and reorders more than half of all timer admissions has a
causal path to the deep rungs. A change that never fired would not, and the
evaluation record does not currently carry the counters that tell the two
apart. Its implementation survives at `202b525` (superproject) and `69efb98`
(spur).
