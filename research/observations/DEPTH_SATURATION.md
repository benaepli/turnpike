# Prefix depth does not come from longer runs

Measured 2026-08-30 from iteration 5340's own chunks, as a within-campaign
contrast: `grid-deep` (overlay `max_iterations` 24000) against `grid`
(6000), same session, same binary, same seed, same wall per arm.

| arm | runs | wall | depth>=6/s | P(depth>=6) | P(depth>=8) |
| --- | --- | --- | --- | --- | --- |
| grid | 79,712 | 120.1 s | 27.19 | 0.04096 | 0.00148 |
| grid-deep | 13,536 | 80.5 s | 6.76 | 0.04019 | 0.00118 |

Per second the deep arm runs at **ratio 0.249, z -30.1**. Per graded run the
ratio is **0.981** - flat. Two chunks agree to 0.4%, so this is not an
underpowered call.

Quadrupling the iteration budget produces runs that are no deeper. The entire
per-second cost is that the wall buys a sixth as many of them. Prefix depth
saturates well below the default 6000 iterations, so there is no depth to be
bought by spending throughput on longer runs.

## What this settles

The iteration-5340 audit raised a Goodhart concern: the objective is rung
events per explore-second, which is maximised by shortening runs, and
`grid-short` (1500 iterations) posts a 2.95x objective advantage over `grid`.
The concern was that the arm wins by truncating rather than by searching.

It does not. `grid-short`'s per-run depth is 0.03958 against `grid`'s 0.04096
- within 3.4% - so its advantage is almost entirely more runs at the same
per-run depth, which is the objective working as intended rather than being
gamed. And the converse arm, `grid-deep`, buys nothing. The current
allocation is not leaving depth on the table in either direction.

It also confirms iteration 5342's premise, which was proposed independently:
prefix depth saturates at about 3.3 regardless of a 16x iteration budget.

## What it does not settle

Whether depth is the right proxy at all. `grid-short` also carries 43.8% of
runs and 55.6% of recorded violations - an enrichment of only 1.27x, so it is
not violation-enriched either, just larger. The question of what distinguishes
a depth-6 run from a depth-7 one is still unmeasured; see the parked
`diagnose-top-rung-prefix-events` grader proposal.
