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
