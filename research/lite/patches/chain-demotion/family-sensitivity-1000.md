# Replay-family sensitivity, seed 1000

Exact candidate replay-family reconstruction is feasible from retained runs metadata. Exact outcome-clustered uncertainty is not available from the retained aggregate grade: per-run depth outcomes and baseline family metadata are absent. No grading or exploration was rerun.

## Reconstruction and checks

The metadata-only traceanalyzer `-runs` path was run with `SPUR_DUCKDB_THREADS=1`, `GOMAXPROCS=1`, and nice level 15. It reads only runs parquet, not execution/trace content, and projects run_id, arm_index, config_index, workload_seed, and variant. Python parses the uint64 seeds as exact integers. The analysis script and numeric results are family_sensitivity.py and family-sensitivity-1000.json in this directory.

Source basis: simulator/history.rs:86-96 and :470-477 persist workload/config/arm identity; campaign.rs:439-515 derives each fresh workload seed and copies it unchanged into both child types; campaign.rs:609 derives arm seeds; rng.rs:315-326 defines the SplitMix derivation; replay_corpus.rs:34-36 and :114-130 enforce at most eight children and no recursive child admission. Paths refer to accepted nested Spur source, whose corresponding mechanisms remain unchanged in the candidate.

Within one arm, seed derivation is a bijection of run_id: addition, xor shifts and multiplication by odd constants are invertible over u64. Distinct fresh runs therefore cannot accidentally share a workload seed in that arm. Families are keyed by (arm_index, workload_seed), with config consistency checked. A run is a fresh root precisely when its workload seed equals the fresh seed derived from session seed 1000, arm and its own run_id. All remaining runs with that key are direct children of that root. Separate arms are never combined. Schedule seeds identify the child's fresh suffix stream and cannot serve as a family key. Slot bits alone cannot distinguish filled from unfilled slots.

All checks passed: every family has exactly one root, that root has the earliest run_id, configurations agree within families, every inferred child has the slot bit, and no root has more than eight children. Reconstructed child and unfilled counts equal the independently exported replay counters exactly.

- Grid runs: 522,780; distinct fresh roots/families: 295,584.
- Roots with at least one child: 76,663. Both prefix and plan-only children appear in 55,010 families.
- Filled children: 227,196 = 113,981 prefix + 113,215 plan-only.
- Unfilled slots: 17,746, including 8,805 prefix-tagged slots. These remain part of the randomized all-slot treatment population; reconstruction does not drop them.
- Exported parents admitted: 76,698. The difference of 35 from served families is consistent with admitted parents that did not serve a child before termination; singleton metadata alone cannot distinguish those admitted parents from unadmitted fresh runs.

| Family size, including root | Families |
| --- | ---: |
| 1 | 218,921 |
| 2 | 161 |
| 3 | 14,803 |
| 4 | 51,292 |
| 5 | 9,771 |
| 6 | 191 |
| 7 | 13 |
| 8 | 20 |
| 9 | 412 |

The size-weighted quantity sum(m^2)/sum(m) is 2.79258 across candidate grid runs (2.62673, 2.77822, 2.87158, 2.88083 by grid arm). Under equal marginal variance and perfect positive correlation within each family, that quantity is the familiar variance inflation for an equally weighted sum. It is descriptive here: observed family sizes cannot identify the actual depth-outcome covariance. The large singleton count does not justify treating served siblings independently.

## Hypothetical aggregate sensitivity

For a deliberately pessimistic sibling-only scenario, the script applies D = 1 + 8*rho to both baseline and candidate variances, treating every run as if it could belong to a size-nine family. Family independence, equal marginal variance/common intrafamily correlation, and fixed exposure are assumptions, not established facts. Shared adaptive learners and campaign scheduling can create dependence beyond these families; therefore these are illustrative intervals, not empirical cluster-robust confidence intervals or guaranteed worst-case bounds.

For depth>=8 events/sec, log standard error is sqrt(D*(1/E_candidate + 1/E_baseline)). The per-run version uses sqrt(D*(1/E_candidate - 1/N_candidate + 1/E_baseline - 1/N_baseline)). Intervals use exp(log(ratio) +/- 1.96*SE). Point estimates are unchanged.

| Assumed sibling correlation | D | Grid events/sec illustrative interval | Campaign events/sec illustrative interval |
| --- | ---: | --- | --- |
| 0 | 1 | 1.1262-1.1961 | 1.0770-1.1383 |
| 0.25 | 3 | 1.1017-1.2227 | 1.0554-1.1616 |
| 0.5 | 5 | 1.0851-1.2414 | 1.0408-1.1779 |
| 1 | 9 | 1.0604-1.2703 | 1.0190-1.2031 |

The observed primary grid events/sec ratio 1.16063 remains above one even in the stylized D=9 scenario, with its lower bound only just above the frozen 1.06 prediction. Campaign events/sec 1.10724 has a D=9 lower bound below the 1.03 prediction. At D=9, per-run illustrative intervals are grid 1.0167-1.2161 and campaign 0.9702-1.1439. These calculations show that sibling dependence alone can matter to precision without explaining away the observed grid point improvement. They do not validate those prediction bands statistically.

Do not apply this calculation as a claimed correction to the matched prefix/plan-only contrast or DID. Prefix and plan-only siblings share families, creating within-family covariance between the contrast's two cells; co-bit matching changes weights; baseline family outcomes are also missing. Raw 1.20-1.60 and baseline-adjusted 1.15-1.50 remain different predictions, neither replaced by this aggregate exercise.

## Action

No further trace analysis is needed to decide a closure caused by repeated AOS loss or the already failed persistence prediction. If a possible merge later depends on resolving uncertainty, per-run depth indicators must be joined to this family key separately for each binary/seed and used in a family-clustered influence calculation or bootstrap that preserves original matching weights and all unfilled slots. Candidate and baseline families must not be assumed to correspond merely because run ids or workload seeds coincide: campaign arm assignments and admitted parents can diverge across binaries. Between-family dependence from adaptation would still require a separate block/seed analysis. None of that extra analysis was run here.
