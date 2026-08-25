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
bottleneck (confirm: 21.6k runs ≈ 70 s vs 3–6 min explore), and graded-n is
what powers every depth-rung CI. Sampling was pure waste.

**Confirm = 400 runs/config × 54 configs × 3 seeds = 64.8k pooled.** Minimum
effects of interest (MEI): +50% relative on P(depth>=5) and +30% on
P(depth>=4). Wilson separation at z=2.7 needs n ≈ 60–70k for the former;
64.8k is the smallest config-grid multiple that clears it. Zero-baseline
rungs (depth>=6, violations) are Poisson: 64.8k runs resolves rates ≥ ~7e-5,
and any 3 events is decisive evidence regardless.

**Promote = 250/config × 2 seeds = 27k pooled.** Kills non-movers before the
25-minute confirm; CI-separates ~+40% on depth>=4 at z=1.96. Promote spends
compute, not merges, so no multiplicity correction.

**Screen = 100/config × 1 seed = 5.4k.** Advance rule: 2σ Poisson exceedance
(successes > expected + 2·sqrt(expected), floor 5) per objective. The prior
"+15% point estimate" rule advanced on 4-vs-3.6 counts (iteration 4) — pure
noise. At 5.4k runs, depth>=4 has ~190 expected successes (2σ ≈ +15%),
depth>=5 ~16 (2σ ≈ +50%): the gate self-scales to each rung's support.

Screen and promote now serve only the perf lane's non-inferiority check;
every other kind is evaluated sequentially (below) and then confirmed.

## Sequential evaluation (non-perf kinds)

Instead of fixed screen -> promote rungs, a candidate is sampled in chunks
of **100 runs/config x 54 configs = 5.4k runs** (one explorer session, ~40 s
explore + ~15 s grade) and after each chunk the pooled counts are compared
with the pooled confirm baseline (64.8k runs) through Beta posteriors
(Jeffreys prior, 2000 Monte Carlo draws, seeded). The chunk is the smallest
unit the explorer produces at full config coverage; chunking smaller would
not reduce cost per decision.

**Minimum effects of interest (MEI): depth>=5 +40%, depth>=4 +25%, relative.**
These are the smallest gains that separate at merge z (2.7) within the
64.8k-run confirm; an effect below MEI cannot be merged even if real, so
spending samples to resolve it is waste. h2 has MEI 5% but is supporting
evidence only: it never advances on its own (a mechanism can raise crash
hazards without moving depth) and it blocks rejection only for the first 6
chunks, long enough for depth>=5 to reach ~100 expected successes.

**Stopping thresholds.** Advance at P(candidate > baseline) >= 0.99 with the
posterior mean ratio >= 1 + MEI/2 (a one-sided 0.01 error per objective; the
confirm rung still has to clear the Bonferroni merge gate, so this is a
resource decision, not the merge decision). Reject when P(regression beyond
25% of baseline) >= 0.95, or when no objective can plausibly reach its MEI
(P(effect >= MEI) < 0.05 on every rung). **Inconclusive** when the cap is hit
or no objective can reach MEI but some objective still has P(> baseline) >=
0.90: an effect that is probably real but too small to resolve. Minimum 2
chunks so a single unlucky session cannot decide; cap 18 chunks (97k runs,
~15 min) because beyond that the confirm rung itself is cheaper.

**Non-inferiority kinds** (ablate/enabling/meta) advance when P(regression
beyond the 25% margin) < 0.05 on every rung, and reject at >= 0.95; these
resolve in 2 chunks for a true null because the margin is wide relative to
sampling noise at 10.8k runs.

**Resumes.** An inconclusive hypothesis keeps its branch and counts, and is
selectable again after a 2-iteration cooldown (so a slot is not spent
re-sampling the same idea back to back) with the posterior replacing the
proposer's gain/cost prior. Up to 2 resumes; the cap grows by 18 chunks per
resume. After the last resume an inconclusive result closes with its
evidence.

**Operating characteristics** (simulation on the live decision function,
synthetic binomial chunks at the measured baseline rates, 200 reps each):
null -> reject 89% / inconclusive 11%, never advances; MEI -> advance 100%
in 2 chunks; half MEI -> advance 76% / inconclusive 24%; harmful (-40%
depth>=4) -> reject 100% in 2 chunks; depth>=5-only +40% -> advance 92%;
h2-only +10% -> reject 91% at 6 chunks (correct: h2 alone is not progress).
Mean cost 2-4 chunks (2-4 minutes) against the fixed ladder's 5.4k + 27k
runs (~4 minutes) before confirm, with the difference that a +36% depth>=5
signal at 5.4k runs (iteration 30) now continues sampling instead of being
rejected at the screen.

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
