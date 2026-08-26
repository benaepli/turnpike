# Parameter Derivations

Every statistical parameter is derived from the measured baseline
(`evaluations/000-baseline.json`); judgment-call parameters are labeled as
such. Re-derive when the baseline moves materially (grader change, big
throughput change).

## Measured constants (baseline 000, commit 02304d3)

| quantity | value |
|---|---|
| explore throughput | 110–200 runs/s (screen higher, confirm ~115) |
| grading cost | ~3 ms/run (traceanalyzer -grade) |
| porcupine cost | ~0.15 ms/run (clean); 3 s cap on stuck runs |
| P(depth>=4) | 0.0356 pooled (seeds: .0363/.0310/.0393) |
| P(depth>=5) | ~0.003 |
| P(depth>=6) | 0 in 130k runs (=> < 2.3e-5 at 95%) |
| violations | 0 in 130k runs |

## Fidelity sizing

**Grade every run (`gradeMaxRuns: 0`).** At 3 ms/run grading is never the
bottleneck, and graded-n is what powers every depth-rung CI. Sampling was
pure waste.

**Screen = 100/config x 1 seed = 5.4k; promote = 250/config x 2 seeds =
27k.** These now serve only the perf lane's non-inferiority check on the
same-protocol screen/promote baseline. Every other kind is evaluated
sequentially in long sessions (below); there is no separate confirm rung.

## Session length (measured 2026-08-25, baseline binary, general_vr grid)

The frontier rate is not a property of a run; it depends on how long the
session has been going. With the same binary and template:

| runs/config | sessions | P(depth>=5) | P(depth>=4) |
|---|---|---|---|
| 100 | 4 (seeds 1000-1002, 11) | 0.0045 (21, 32, 24, 21 of 5.4k) | 0.0514 |
| 400 | 3 (seeds 11, 23, 37) | 0.0035 (76, 77, 73 of 21.6k) | 0.0493 |
| 1000 | 4 (seeds 1000-1003) | 0.0039 (193, 219, 214, 222 of 54k) | 0.0499 |
| 2000 | 1 (seed 1000) | 0.0037 (404 of 108k) | 0.0495 |

Early runs of a session hit the frontier more often than later ones
(timeline feedback, novelty keys and dedup all shape a session as it goes),
so short sessions measure the cold-start regime. Two consequences: (1) a
candidate sampled at 100/config and compared with a 400/config baseline
reads +30% for doing nothing, which is exactly what iterations 34 and 35
showed (10.8k-run "advances" at ratio 1.45-1.48 that vanished at confirm);
(2) the regime the tool is used in is the long session, so that is the one
to optimize. Candidates and baseline are therefore always measured with the
identical protocol: same runs/config, same seed family, same binary
lineage.

## Sequential evaluation (non-perf kinds)

A candidate is sampled in chunks of one long session, **1000 runs/config x
54 configs = 54k runs** (~4 min explore + ~3 min grade), seeds 1000, 1001,
... . 1000/config is the floor the operator set for a session to be
representative of real use; the measurement above shows the rate is on its plateau from 400/config on
(400: 0.0035, 1000: 0.0039, 2000: 0.0037, all within sampling noise), so
1000 is the shortest session that is both representative and at the floor;
2000 costs twice as much for the same information.
After each chunk the pooled counts are compared with the baseline's own
chunks (same protocol, `maxChunks` of them, refreshed after every merge)
through Wilson intervals for decisions and Beta posteriors (Jeffreys prior,
2000 seeded Monte Carlo draws) for futility and reporting.

**The advance rule is the merge gate.** A candidate advances as soon as the
pooled sample separates from the baseline at z = 2.7 on depth>=4 or
depth>=5 (the same test `finalGate` applies), so an advance never fails the
gate for lack of separation; only regression, lint and throughput can still
close it. Three looks (chunks 2, 3, 4) at z = 2.7 inflate the familywise
error modestly; the Bonferroni z already carries slack for that.

**The separation test is the two-sample MOVER (Newcombe) difference bound**
(`rateSuperiorCI`), not non-overlapping one-sample Wilson intervals. Two
non-overlapping intervals are about sqrt(2) stricter than the difference
test at the same z, which is stricter than the Bonferroni z = 2.7 was
derived for - so the earlier non-overlap implementation silently discarded
real gains (novelty-authority-normalization: +3.05% depth>=4 at P 0.997 over
648k runs, two-sample z = 2.75, closed unmerged). The MOVER bound is the
statistic the non-inferiority side already uses. Simulated operating
characteristics at the measured rates are unchanged on the null (A/A ->
merge 0%) and on harmful cases (reject 100%), with power on small real
effects rising sharply (a +20% depth>=5 advances 55% -> 90%).

**Minimum effect is derived, not chosen.** For each rung, the smallest
relative effect the gate could separate with the candidate at the cap and
the baseline at its recorded size: z * sqrt(1/E_cand + 1/E_base) with E the
expected hit counts. At today's counts (4 chunks each side) that is about
+4% on depth>=4 and +15% on depth>=5. A candidate is rejected for futility
when P(effect >= that minimum) < 0.05 on both rungs, or when a rung
regresses by the separation test. h2 is reported but never decides: a
mechanism can raise crash hazards without lengthening the chain.

**Cap and floor.** Minimum 2 chunks so one unlucky session cannot decide -
except a decisive regression, which rejects at the first chunk: a frontier
rung separated below baseline at the merge z is a real loss, not chunk
noise, so a second confirming chunk on a clear loser is wasted (simulated:
a -40% depth>=4 candidate rejects in 1 chunk instead of 2, ~7 min saved per
obvious loser; nulls and marginal cases still take the full path). Advancing
and calling futility still require the 2-chunk floor, since those decide on
the positive side where one lucky chunk must not be trusted.
Cap 4 chunks (216k runs, ~30 min): the baseline is the same size, so beyond
that the baseline's own uncertainty dominates and more candidate chunks buy
little. At the cap: **inconclusive** if some rung has P(better) >= 0.9, else
reject.

**Non-inferiority kinds** (ablate/enabling/meta) advance when P(regression
beyond a 25% relative margin) < 0.05 on depth>=4 and h2, and reject at
>= 0.95.

**Resumes.** An inconclusive hypothesis keeps its branch and counts and is
selectable again after a 2-iteration cooldown with the posterior replacing
the proposer's gain/cost prior; up to 2 resumes, each adding 4 chunks. On
resume the branch is rebased onto the research branch and counts gathered
against a superseded baseline are discarded.

**Baseline refresh.** After every merge the merged candidate's chunks are
topped up to `maxChunks` with the next seeds in the family (~30 min per
merge); the perf lane inherits the previous chunks.

**Operating characteristics** (simulation on the live decision function,
synthetic binomial 54k-run chunks at the measured 1000/config rates, 100
reps): null -> reject 95% / inconclusive 5%, never advances; +20% depth>=5
with +12% depth>=4 -> advance 100% in 2 chunks; +40%/+25% -> advance 100%;
depth>=5-only +20% -> advance 55% / inconclusive 45%; harmful (-40%
depth>=4) -> reject 100% in 2 chunks; h2-only +10% -> reject 95%. A null
costs ~2.7 chunks (~20 min); that is the price of resolving +4% on
depth>=4.

## A/A noise floor (measured 2026-08-25, baseline binary)

Four same-binary same-config sessions differing only in session_seed
(1000, 1001, 4242, 4243), 5400 runs each, general_vr grid: depth>=4 counts
278/285/265/279, depth>=5 20/28/15/25, h2 counts within 8 of each other.
The frontier counts vary sub-binomially (count sigma 8.4 against 16.2
expected from a binomial at these rates), so the floor is configuration
structure shared across seeds, not per-run randomness; a Wilson/binomial
separation test is therefore conservative here, not anti-conservative.

Band (the delta below which a comparison is no evidence), derived as
2*sqrt(2)*sessionSigma and scaled by sqrt(54000/n):

| metric | band at 54k runs | band at 5.4k runs |
|---|---|---|
| depth>=4 | 1.4e-3 | 4.4e-3 |
| depth>=5 | 9.5e-4 | 3.0e-3 |
| h2 | 6.4e-4 | 2.0e-3 |
| violations, depth>=6..8 | 0 | 0 |

Consistency check: iteration 46 (novelty-authority-normalization) pooled
216k runs each side to depth>=4 +2.2% (about 1.1e-3 absolute) - above the
54k band but below the z=2.7 separation the merge gate needs, which is why
it resolved inconclusive rather than as noise or a merge.

## Gate statistics

- **Merge z = 2.7 (`MERGE_Z`).** ~7 objectives tested per hypothesis
  (violations, depth 4–8, h2); Bonferroni at family α ≈ 0.05 → per-test
  α ≈ 0.007 → z ≈ 2.7. At z=1.96 the familywise false-merge rate would be
  ~30% per hypothesis.
- **Non-inferiority margins are relative: 25% of the baseline rate per
  objective, floored at 0.2 pp** (Newcombe/MOVER bound). The old absolute
  0.02 margin exceeded half the depth>=4 baseline — a change could nearly
  halve the frontier rate and still "pass".
- Confirm uses 3 seeds because the explorer is nondeterministic at fixed
  seed (measured); screen's single seed is acceptable because its errors
  only misallocate ~6 min of promote compute.

## Perf lane

Bench: fixed single-config workload (2000 runs ≈ 15 s/round), ABBA
interleaving, 1 warmup + 4 measured rounds/side, gate = strict dominance
(min cand > max base) AND mean +5%. Dominance over 4×4 rounds is a
nonparametric test robust to drift; +5% is the smallest improvement worth a
merge's overhead (judgment).

## Judgment-call parameters (audit-tunable policy, not derived)

exploration quota 0.3 · UCB c 1.2 · stagnation window 8 · lineage depth 6 ·
per-hypothesis 90 min · daily wall 20 h · audit every 5. These are priors;
the audit role exists to retune them from accumulated iteration data via
meta-hypotheses (inside compiled hard limits).

## Grader memory (measured 2026-08-24, after two OOM kills)

Explorer peak RSS on a 13.5k-run session: **2.4 GB**. The grader
(traceanalyzer -grade) materialized every graded run's rows in memory at
**~2.4 GB per 1000 runs** (4.3G @ 2000, 10G @ 4000) — grade-everything on a
13.5k-run promote projected to ~32G and OOM-killed the box twice. dagorder now
reads runs in chunks of 500 (peak 2.5 GB for all 13.5k runs, 50 s), so
`gradeMaxRuns: 0` (grade all) stays the derived default at every fidelity.
Lesson recorded: parameter changes that alter *which code runs at what scale*
need a resource measurement, not only a statistical derivation.
