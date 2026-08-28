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

The depth rows above were measured against `research/oracle/relax_minimal.json`
and are superseded; see the next section for why.

## Oracle destination binding (measured 2026-08-27, epoch 3)

The key binding below was fixed; the destination binding was not, and it is
the same class of mismatch one layer down.

`relax_minimal_general.json` names node 0 for `w1`, `w2`, `r1`, `r2` and `r3`.
`path/generator.rs` chooses each client operation's destination with
`rng.random_range(0..num_servers)`, so with three servers only a third of
operations address node 0. Measured over 30,024 general runs, writes split
20675 / 20577 / 20609 across nodes 0 / 1 / 2, and only 15,914 runs (53.0%)
contain a write to node 0 at all.

The consequence is not that those runs score zero. `rootAnchoredPrefix` in
`matching.go` skips labels with no candidates and promotes their successors to
roots, which is deliberate and covered by `TestPrefixDepthContractsUnmatchable`.
So when `w1` has no candidate the chain is anchored at `crash_nl` instead, and
a depth of k counts a different k vertices than it does in a run where `w1`
matched.

`P(depth>=k)` therefore mixes two populations in roughly a 53/47 split. Two
consequences for anyone reading a ladder delta:

- A mechanism that shifts the proportion of runs containing a write to node 0
  moves every rung for a reason unrelated to its mechanism.
- Rungs are not comparable across the two populations, so a pooled
  `P(depth>=6)` is an average over two different six-vertex chains.

Not a defect in the grader: contraction is right for a plan-mode metric reused
in general mode. Pinning the destination would be the other kind of error,
teaching the subject an answer the oracle knows, so the mismatch should be
measured and reported rather than removed.

## Oracle key binding (measured 2026-08-26, epoch 3)

`relax_minimal.json` names the client key `x`. The general grid pins
`num_keys` to 1 and `path/generator.rs` names keys `key1..keyN`, so the six
client-op labels (`w1`, `w2`, `r1`, `r2`, `r3`) plus the always-unmatchable
`allow_t1` had **zero candidates in 100% of runs**. Only 7 of 13 labels could
ever match, and the longest chain through those 7 is 5 vertices, so
`max_prefix_depth` was pinned at exactly 5 for arithmetic reasons.
`depth>=6/7/8` were not rare, they were unreachable, and the escalate path
that keys on `depth6plus > 0` could never fire.

A/B on one identical 32,400-run general corpus, changing only the key literal:

| | key `x` | key `key1` |
|---|---|---|
| max_prefix_depth | 5 | 8 |
| mean_prefix_depth | 2.323 | 3.027 |
| depth_at_least | 32400/28586/12536/1613/139 | 32400/29682/21330/11486/2662/457/43/2 |

Per 54k-run chunk that is about 762 runs at depth>=6, 72 at depth>=7 and 3.3
at depth>=8 - all resolvable, where before there was no gradient above 5.
Evaluation therefore grades against `relax_minimal_general.json`, which is
`relax_minimal.json` with the five client-op keys retargeted to `key1`. The
frozen oracle and `research/corpus/` are untouched, so the corpus invariants
in `manifest.json` still hold against the original DAG.

Depth alone is not the bug, and the gap is large. All 32,400 runs were
linearizable, both depth-8 runs included. Extrapolating P(depth>=8) = 6.2e-5
over the 2,688,021 graded runs the loop has already produced puts about 166
depth-8 runs in that history, and porcupine found 0 violations in it - a
general-config precision at full depth below 1.8% at 95%, against 266/372 =
72% for the plan corpora. At least a 40x gap, so the oracle chain is necessary
but nowhere near sufficient: the plans constrain something the DAG does not
capture. Treat prefix depth as a weak proxy and violations as the objective.
(The 2.7M runs span different candidate binaries and their depth was never
measured under the old oracle, so this is an extrapolation, not a direct
count.)

**What the proxy is blind to.** Inside `findbug_archive`, among the 148 runs
at depth 8, 112 violate and 36 do not - and every grader-visible feature is
identical between the two groups: edge_satisfaction 1.000, eligible_edges 59,
matched_labels 12, chain_score 0.778, longest_chain 7, critical_path 9. The
DAG metric is saturated at depth 8 and carries no discriminating power over
the 76% that violate.

The variable it cannot see is timer admission. `allow_t1` is an
`allow_timer` directive, and `buildCandidates` returns nil for it
unconditionally, so it is a zero-candidate label in every run of every
corpus - plan-driven ones included. The plans set `strict_timers: true`, so
timers fire only where the plan admits them; the general grid has no
`strict_timers` key at all and lets the simulator fire them at will. Same
8-vertex chain, 76% violation under plan-constrained timers against under
1.8% without. So the ordering of timer firing relative to the crash and
delivery chain is the uncontrolled variable, and it is invisible to the
grader by construction. A proxy that discriminates has to observe
timer-versus-delivery ordering; mechanisms that make timer firing a
schedulable decision are the ones with headroom.

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

## Wall-budget chunks and events per explore-second (epoch 5)

Measured 2026-08-28 on the 32-thread host at `rayonThreads: 30`, epoch-4
baseline binary (spur `28a81df`), seeds 1000-1003: a 54,000-run chunk is a
**90 s explore at 598 runs/s (cv 1.0% across chunks)** followed by a 107 s
grade, with per-chunk counts depth>=4/5/6/7/8 = 19,731 / 6,033 / 883 / 110 /
5 and h2 0.416. Grading, not exploring, is now the larger cost of a chunk.

**The chunk is a fixed explore budget, `sequential.exploreBudgetSec` = 90 s.**
The explorer stops issuing runs at the budget on its own clock
(`wall_budget_sec`), walks the grid one run of every configuration per round
so a cut leaves the corpus with the grid's composition whatever the
throughput, and reports the time the runs had in `session.json`. The
harness reads that as `exposureMs`. `maxRunsPerConfig` (4000) is a cap so a
session cannot outgrow the grid's storage; it binds above four times the
baseline's throughput. 90 s reproduces the 54k chunk at the measured
throughput, so every archived 54k-per-arm record stays comparable; a
candidate at the 0.8 throughput floor still gets 43k runs, twice the
400/config plateau onset from the session-length table, so the cold-start
over-read cannot flip a verdict before the floor rejects.

**The objective is rung events per explore-second.** A rung's rate is its
count over the exposure, and two rates are compared by the log ratio of
Poisson rates, `se = sqrt(1/a + 1/b + extra)`, at `MERGE_Z` 2.7 - the
quantity `minimumEffect` already used. `extra` is the throughput
dispersion: with 1% chunk-to-chunk cv the variance the exposure adds to a
4-against-4 log ratio (2 x 0.01^2 / 4 = 5e-5) exceeds the counting variance
on depth>=4 (2.5e-5), so the statistic charges `cv_c^2/chunks_c +
cv_b^2/chunks_b` with the cv floored at 0.01; on depth>=6 (5.7e-4) it is a 3%
correction. Posteriors are Gamma-Poisson under a Jeffreys prior with the
same term. The minimum separable effect on depth>=6 against the 4-chunk
baseline is 7.9% at 2 chunks, 6.4% at 4, 5.6% at 8 and 4.5% unbounded.

**Rung roles, from the power floor.** depth>=6 per second is primary (the
deepest rung that resolves the +10..25% class every merge so far belonged
to); depth>=4 and 5 per second are secondary advance rungs; depth>=4 per
graded run and h2 per run are regression guards, which stay per run because
the objective already rewards throughput - a 10%-slower candidate with +30%
depth>=6 is +17% on the objective and -10% on depth>=4 per second, and a
per-second guard would reject it at z 13. depth>=7 needs +40% to separate
at 4 chunks, so a favourable posterior there (`pGreater >= inconclusiveP`)
only suppresses futility and extends the cap to 8 chunks; it is never a
verdict. depth>=8 is recorded and never tested. A rung the baseline never
reaches is the jackpot rule (extend, then escalate), unchanged.

**Throughput floor.** A candidate whose pooled runs per explore-second fall
below `1 - regression.throughputTolerance` (0.8) of the baseline's is
rejected at `minChunks`, and the merge gate closes on the same ratio: the
objective credits speed, so a slower candidate has to have earned its rate.
The bench's strict-dominance test in the regression suite is unchanged.

**Every duration is active time.** The explorer's budget, its session
account, each run's `wall_us` and `session_offset_ms`, and the harness's
own timers all read monotonic clocks (`Instant`, `performance.now()`) that a
machine suspend does not advance. A chunk that straddles a suspend keeps its
true exposure and counts; `suspendedMs` is recorded on the evaluation as a
fact, not a verdict.

**Timing anomalies.** A chunk is excluded for its timing, never its content:
a missing session summary (the explorer was killed before it wrote one), or
throughput below the baseline median / 1.5 before the candidate is known to
be slow. A slow chunk is retried once; a second slow chunk in a row confirms
the candidate slow, after which its chunks count and the floor decides.
Three exclusions error the evaluation out. Fast chunks are never anomalies:
the exposure is the explorer's own clock, which the environment cannot
inflate. Baseline top-ups apply the same rule against their own siblings.

**Chunk cap.** `maxChunks` stays 4 and equals the baseline's size, which is
the binding limit: the fourth chunk buys 1.5 points of depth>=6 resolution
and the next four 0.8. `cli selftest` asserts that the minimum effect at the
cap is within 1.5x the unbounded floor at the measured counts, so a change
of budget, rates or baseline size that breaks the relation fails loudly.

**Operating characteristics** (`npx tsx src/selftest_sequential.ts 60
--assert`, synthetic wall-budget chunks at the counts above): A/A -> 0%
advance, 97% reject, 3% inconclusive (the d7 extension on a null, mean 2.6
chunks); +25% depth>=6 -> 100% advance in 2 chunks; +25% depth>=6 at 0.7x
throughput -> 100% reject; flat depth at 1.4x throughput -> 100% advance
(intended: throughput multiplies every rung); +12% depth>=4 with +15%
depth>=5 -> 100% advance; -40% per-run depth>=4 -> 100% reject at chunk 1;
depth>=7-only +40% -> 0% advance, 100% inconclusive at 8 chunks; h2-only
+10% -> 0% advance; NI null -> 100% advance; NI -30% -> 100% reject at chunk
1. The consistency of the sequential rule with the merge gate on the same
pooled chunks is asserted by `selfTestGateConsistency`.

**Comparability.** Per-run rates from epoch 4 and earlier are not
per-second rates; the epoch-5 baseline is re-measured under this protocol
and results before it no longer steer decisions.

## Campaign evaluation (epoch 7)

The evaluation session is a campaign: `spur explore -e campaign` on the one
template, whose `campaign` block names the arms, under one active-time
budget `sequential.exploreBudgetSec` = 300 s. Five arms to start, all
generic: `grid` (the merged envelope), `grid-short` (`max_iterations`
1500, since depth is flat across the step budget and a shorter budget buys
events per second), `grid-no-purgatory` (`purgatory.delay_probability` 0;
six purgatory hypotheses were falsified and delayed deliveries act 13.8%
against 40.9%), `grid-post-fault-2` (`post_fault_client_ops` 2, the
largest recorded depth move came from feeding the post-fault segment) and
`aos` (tape mutation refines a recorded run, the only strategy that searches
near a deep run). Allocation is round robin, which needs no proxy; the
reward (`termination_completed`) is recorded per arm and may steer a
`halving` or `bandit` allocation only once
`research/observations/surrogate_validation.mjs` has admitted it
(`research/observations/SURROGATE_VALIDATION.md`), which the lint enforces.

Each arm keeps its own feedback store across its slices, so an arm's
session length is the budget over the arm count: 300 s / 5 = 60 s, about
36,000 runs at the standard explorer's rate, above the 400 runs/config
plateau onset. The ladder is the union of the arms; per-arm rung counts,
violations and time to first violation are recorded in every evaluation
(`metrics.campaign`) and rendered in STATUS.md, and they are what an
`arm`-kind hypothesis (one that edits only the campaign block) is proposed
from. Screen and promote fidelities stay on the standard explorer without
the block, so the perf lane's non-inferiority check is unchanged.

Measured, one chunk on the 32-thread host (seed 1000): 226,137 runs in
300.8 s of exposure (752 runs/s over the arms; `grid-short` runs about four
times as many runs per second as the others), `depth_at_least`
226137/204005/157657/105443/36448/8702/1862/297/4, the checker 14 s, grading
431 s, and **one linearizability violation** - the first ever recorded on
VR under a general configuration. Its corpus was deleted with the
evaluation before the finding was seen; from this chunk on, an evaluation
with violations copies the checker's report, the config, the campaign
report, the violating runs' rows and their combined timelines to
`research/logs/violations/<evaluation id>/` and appends a line to
`research/logs/violations/INDEX.jsonl` before cleaning up. A chunk is about
12.5 minutes, four chunks 50, inside the 150-minute hypothesis budget;
grading is the larger half and the place to recover more arms.

The rung statistic is unchanged from epoch 5. The campaign's counts are
unions over arms of different session lengths and are not comparable to
the epoch-5 and epoch-6 single-session baselines, hence epoch 7.

## The timer vertex and the runs table (epoch 6)

The explorer records every timer firing as an executions row, the grader
matches the oracle's `allow_timer` label against them, and `h4` counts runs
with a timer firing while a message to that node was in flight. The oracle
chain therefore reaches 9 where it reached 8: on the regenerated
`find_bug_plan` corpus (3,000 runs, the archived 11 violating run ids
exactly) `depth_at_least` is 3000/3000/3000/3000/751/751/751/145/103 and all
11 violating runs sit at 9. In general mode the vertex is close to free
(timers fire constantly, so one lands between `w1` and `crash_nl` in nearly
every run), which shifts rung k to roughly the old rung k-1 wherever `w1`
matched; the epoch-6 baseline re-measures the ladder on that scale. `h4` is
0.94 in general mode against 0.035 under plan-admitted timers, so it
measures the timer regime, not the violation, and is reported only.
Details and the ground-truth check: `research/GRADER_REVIEWS.md`.

**Cost of the timer rows.** VR fires about a thousand timers per run, so the
executions table grew thirtyfold. Measured on the epoch-6 baseline (32
threads, rayon 30): explore throughput 555 runs/s against 587 before (the
writer's share), grading 186-195 s per chunk against 107 s, and the checker
46-48 s against 3 s until it stopped reading the rows it discards, after
which it is back under a second. A chunk is therefore about 90 s explore
plus 190 s grade; grading, not exploring, bounds how many arms a campaign
chunk can afford, and the grader's per-run read of the executions table is
the place to recover it.

Each run also leaves a row in a `runs` table (strategy, grid index, seeds,
steps, active-time cost, end reason, session offset), which is what a
per-strategy or time-to-first-violation reading joins against; the grader
summarises it as `runs_meta`, and porcupine reports the first violating
run's ordinal and a signature per violation.

## Sequential evaluation (non-perf kinds)

Epoch 4 and earlier. The chunk unit and the statistic are superseded by the
section above; the chunking, seeding, futility, resume and refresh rules
below still hold.

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
pooled sample separates from the baseline at z = 2.7 on depth>=4, depth>=5 or
depth>=6 (the same test `finalGate` applies), so an advance never fails the
gate for lack of separation; only regression, lint and throughput can still
close it. Three looks (chunks 2, 3, 4) at z = 2.7 inflate the familywise
error modestly; the Bonferroni z already carries slack for that.

depth>=6 became a frontier rung in epoch 3, when the key-matched oracle made
it reachable (about 762 runs per 54k chunk against 19,140 at depth>=4). It was
already inside the objective family the Bonferroni z was derived for, so
adding it costs no extra correction. It is tested for gain and futility but
not for regression: with the sparsest counts of the three rungs, its noise
would reject good candidates. Without it the oracle fix would not pay off -
depth>=4 now sits at 35% of runs and is close to saturated, so a candidate
that moves only the deep tail read as futile on the two rungs the gate used
to test. Measured on the live decision function, a +25% depth>=6 candidate
gives pMei 0.004 on depth>=4 and 0.011 on depth>=5, so the old futility test
rejected it; it now advances at pMei 1.000 on depth>=6.

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
when P(effect >= that minimum) < 0.05 on all three depth rungs, or when
depth>=4 or h2 regresses by the separation test. h2 is reported but never
decides: a mechanism can raise crash hazards without lengthening the chain.

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

**Rare evidence extends sampling; it never short-circuits the gate.** A
violation (ground truth) still advances immediately, since the gate
special-cases a zero violations baseline. A depth the baseline never reaches
(depth>=6 against zero) is not enough hits to separate at the gate, so it no
longer advances (which would hand the gate a sample it cannot clear and get
the branch deleted). Instead it suppresses the futility reject, extends the
cap to the compiled ceiling (12 chunks, ~90 min), and at the cap returns
**escalate**: the pooled evidence goes to a human as a needs-review PR rather
than being discarded. The merge gate stays the sole authority on what merges.

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
synthetic binomial 54k-run chunks, 100 reps, at the epoch-3 rates
P4 0.3545 / P5 0.0822 / P6 0.0141): null -> reject 83% / inconclusive 15% /
advance 2%; harmful (-40% depth>=4) -> reject 100% in 1 chunk; h2-only +10%
-> reject 84%; depth>=6-only +25% and +40% -> advance 99% in 2 chunks;
+20% depth>=5 with +12% depth>=4 -> advance 99%; broad +25% -> advance 100%.
A null costs ~2.8 chunks (~20 min). The 2% false advance is the cost of a
third advance rung and sits inside the family alpha ~ 0.05 that MERGE_Z was
derived for; the merge gate, regression suite and lint still run after an
advance.

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
per-hypothesis 90 min · audit every 5. These are priors;
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
