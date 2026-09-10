# Successful-vector implementation map

This is a read-only source map for `selector-successful-joint-arms-with-uncertain-axis-mutation` in `tmp/loop/lite/judged-73.json`. It is not admission, an implementation, or an experiment. Source was inspected at accepted Spur commit `b86baad3f94ce14dbdf20688b61fd92317a75cc2`. Provenance72 is unresolved. Revalidate this map and the frozen mechanism if the accepted source changes before implementation.

## Ownership and allowed scope

The main implementation belongs in `spur/spur-core/src/simulator/arm_selector.rs`, especially `CellLearner`, `CellLearner::credit`, `choose`, `observe`, and `reset`. Bounded diagnostics belong in `util_stats.rs` and `spur/spur-core/tests/util_stats_export_completeness.rs`. Existing `run_variant.rs` already supplies the required tuple representation and ordering; no new configuration or tag is needed. `explorer.rs` carries `Choice` from `choose` to `observe`, so a small observation marker in `Choice` need not change caller signatures. Inspect any extra required plumbing before expanding the patch.

Do not change `core/exec.rs`, history, event accounting, detector semantics, run caps, workload generation, replay admission, AOS operators, campaign allocation, or protected files. Cost remains zero only while the implementation stays outside correctness/measurement-sensitive scope. Cross-binary grading is a requested and judged exception, not an independently randomized controller bit. Final admission and grading remain root decisions.

There are no search-context tables in this accepted baseline. `CellLearner` currently contains twelve alpha values, twelve beta values, reward mass, observation mass and an observation counter. It is owned by one of three `LazyLock<DashMap<Cell, CellLearner>>` tables. `cell(arm_index, config_index)` pools all grid arms at `(POOLED_ARM, config_index)`; non-grid calls use `(arm_index, -1)`. Preserve that ownership. Do not copy contextual state from the in-flight prototype.

## Population state and credit

Add one bounded population to each existing `CellLearner`, not one per run, arm, direction, replay family or search context. Store up to 24 entries, each containing an `ArmSet` or its existing index and the credited-observation index at insertion. Repeated successful vectors remain repeated entries. A fixed inline array/ring avoids a heap allocation per insertion; report actual Rust layout and aggregate cell count rather than a payload-only byte estimate.

`CellLearner::credit` increments `observations` once per admitted outcome and applies the current marginal equations. Preserve those equations exactly. After the credit index advances, remove entries whose age is greater than 500; age exactly 500 remains live. Insert the carried tuple only when this learner's actual Boolean reward is true, stamping it with the completed credit's observation index. Retain the most recent 24 remaining successes. Age on every admitted outcome, including zero rewards; neither draw count nor positive-only count is the clock.

The outer `credit` helper already acquires a DashMap entry guard and calls `CellLearner::credit`. Population aging, insertion and cache maintenance can share that guard. Avoid a second learner table or extra read-then-write lookup. `observe` credits coin runs into all three learners with each learner's own reward, and learner runs into only their chosen learner. Probe outcomes return before any credit. Preserve all of this, including replay reward eligibility. The proposal preserves current rewards; it does not add an inherited-parent success label or change ghost-signal exclusion.

Population support means at least eight live entries and two distinct tuples at draw time. Distinct count can be maintained through a bounded 72-entry occurrence array or recomputed from at most 24 entries when membership changes. A repeated tuple never counts twice toward distinct support. Draw-time four-distinct-vector diagnostics are separate from the two-distinct-vector applicability gate.

## Exact policy and cache

`run_variant.rs` defines `AXES=5`, `AXIS_START=[0,3,5,7,9,12]`, `COMBINATIONS=72`, `ArmSet::directions`, `from_directions`, `index`, `from_index`, and `coin_probability`. Existing `index` is the required lexicographic mixed-radix order, with the request axis varying fastest.

Keep shared warmup, `explore_share`, learner assignment, probe exemptions and the run-id coin decision first in `choose`. Unsupported learner draws must execute the unchanged five-axis `sample_axis_leading` path, including private RNG consumption and categorical fallbacks. Coin and probe paths continue to consume no selector draws. Supported population draws use the selector's existing private generator and one uniform variate for the exact joint mixture and its observation-only comparator; they do not use the execution schedule RNG.

For a live population of size M, cached mutation-axis probabilities e[a], parent tuple p and a replacement direction d different from p[a], contribute

`(1/M) * e[a] * coin_probability(d) / sum_{j != p[a]} coin_probability(j)`

to the tuple equal to p except at axis a. Sum contributions from all entries, axes and replacements into a 72-value distribution. Each latent mutation changes exactly one axis from its chosen parent; multiple parent/axis paths may reach the same output tuple and their probabilities must add. Sampling the aggregate distribution does not identify a unique latent parent or realized mutation axis. The prediction asks for mutation probability mass, so export e[a] contributions, not an invented sampled parent or axis.

Root supplied the source-based entropy interpretation before any implementation: normalize `CellLearner::leading_probability(a)` itself BEFORE multiplying by coin shares, then compute Shannon entropy and normalize the five entropy values into mutation-axis probabilities. Existing three-way leading products are not normalized, so this interpretation follows the frozen phrase 'normalized posterior-leading probabilities.' The frozen description separately uses coin shares for the alternative mutation direction. The product-marginal comparator uses the actual coin-weighted baseline categorical distribution. Entropy log base cancels when axis entropies are normalized proportionally. Zero terms contribute zero, and all-zero axis entropy retains uniform axis selection. No entropy floor or axis-width correction is permitted. Root will record this interpretation at admission; the description and prediction are unchanged, and no outcome or tuning evidence informed it.

Cache the mixture after any membership change, including expiration on a negative credit. Refresh entropy weights every 24 credited observations; that refresh must also rebuild the mixture even when no success was inserted or expired. Define a deterministic initial entropy snapshot and credited-clock boundary before coding. A safe implementation ordering is marginal credit, population maintenance, required entropy refresh, then mixture rebuild if membership or entropy changed. First use must never observe an uninitialized cache. Unsupported-to-supported transition must build a valid mixture. These are state-machine requirements, not permission to change the frozen refresh interval.

The observation comparator is the product of the current five normalized baseline categorical distributions at this draw's consistent cell snapshot. It is not the stale cached entropy distribution. Use the same uniform variate and `ArmSet::index` order to invert both CDFs. Exact joint total variation is `0.5 * sum_i abs(Ppopulation[i]-Pproduct[i])`. Hamming distance is between the two actual coupled tuples, not between a tuple and its latent parent. Identical distributions must produce identical tuples and zero TV; an independent shadow draw would fail this requirement.

Do not clamp away invalid probabilities, use only the most common successful tuple, deduplicate population weights, estimate 72 independent reward posteriors, or sample parent/axis/replacement using extra private variates instead of the prescribed aggregate draw. Numerical fallback for a normalized marginal must agree with existing `pick`: nonpositive total maps to its first direction. Non-finite probabilities should fail deterministic correctness checks rather than silently becoming a new policy.

## Draw and outcome diagnostics

`Choice` currently contains only `arms` and `learner` and derives `Copy`, `Eq` and `PartialEq`. A fixed Boolean or small enum marking a supported population draw is enough to associate its eventual actual reward without adding floating predictors or a retained per-run buffer. All constructors are in `arm_selector.rs`; existing `run_variant` consumers read its fields and need no new tag semantics.

Record draw-time support, diversity, TV, coupled Hamming distance and mutation mass while holding the same consistent state snapshot used to choose. Existing counters comparing arms with run-id coins must keep their old meaning. The new firing counter is exactly `arm_selector_population.changed_joint_draws`, comparing with the coupled product-marginal tuple. A supported draw can have zero departure; count it separately.

Normal utilization export must make all frozen gates directly calculable:

- Total supported draws, unsupported draws and changed-joint draws; Hamming histogram 0 through 5.
- Number of supported draws with TV >= 0.10, plus TV sums/counts or a histogram for diagnosis.
- Mutation probability mass sums for five axes with supported draws as denominator.
- Live-entry and unique-vector distributions at draw time, including supported draws with at least four distinct vectors and repeated-vector concentration.
- Per learner/cell cumulative supported draw count sufficient to count cells with at least 100 draws, plus bounded per-cell support/diversity summaries.
- Supported completed-run and actual successful-outcome counts by learner, with candidate own-run reward counters retained for all three learners.
- Created cell count, actual population/cache bytes per cell and bounded storage totals.

At ordinary completion, use `Choice`'s saved supported marker; do not recheck whether its cell still has support. Use the run's actual unchanged matching reward before inserting that outcome. Successful parent population entries do not provide outcome credit. Failure paths cannot fabricate a completed reward.

Per-cell draw counts need safe updates under `choose`'s shared DashMap guard. Small atomic counters inside each cell can avoid upgrading to an exclusive guard merely for observation; alternatively provide a reviewed bounded recording approach. Do not acquire nested guards on the same DashMap shard or export global cell snapshots while holding an entry guard. Snapshot-time scanning of existing cells is bounded by cell count and is separate from the selection hot path. A final gauge alone cannot tell whether a cell made 100 supported draws earlier, so keep the cumulative count.

`util_stats.rs` supplies `set_enabled`, atomic recording helpers, serializable snapshot structs, `snapshot`, `snapshot_value`, `render_snapshot`, and `flush`. Add a named top-level population block and its reset path; retain existing reward fields. Fixed-point nonnegative mass sums fit the existing integer-counter style if their scaling and rounding are exported/documented; all frozen ratio checks must use the documented scale. Full floating sums require checking the normal export/delta path rather than assuming campaign deltas carry them. No harness edit is authorized. `util_stats_export_completeness.rs` deliberately enumerates blocks and leaf fields; extend its constructors and expected leaves to prove the new fields reach the actual flushed JSON.

`arm_selector::reset` clears all three maps at session boundaries and resets selector gauges. Population state and per-cell counts must die with those maps. `util_stats::set_enabled(true)` must clear every aggregate population counter; tests must cover both counters and gauges so successive sessions do not contaminate one another.

## Required deterministic checks

1. Ring retention and expiry: 7 versus 8 successes; 1 versus 2 distinct tuples; repeated successes; 24 versus 25 entries; ages 499, 500 and 501; zero-reward aging; re-entry after loss of support.
2. Credit exposure: coin-to-all with different rewards, own learner only, no probe credit, no other learner's success, exactly one observation tick per admitted outcome. Existing marginal state must match a reference update after identical credits.
3. Exact mixture: an asymmetric population with repeated tuples and nonuniform mutation/coin shares; independently enumerated parent-axis-replacement contributions; mass sums to one; all contributing neighbors differ from their latent parent on exactly one axis; output collisions add correctly.
4. Entropy/cache lifecycle: the written entropy interpretation, zero-entropy uniform axes, initial cache, refresh boundary, membership-only rebuild, entropy-only rebuild, negative-credit expiry and fallback. Compare cached mixture with direct recomputation using the same frozen entropy snapshot.
5. Coupled diagnostics: all 72 tuple indices round-trip; same order for both distributions; identical distributions imply zero TV and no departure; asymmetric CDF-boundary examples; independently checked TV, Hamming histogram and axis-mass sums.
6. Policy preservation: coin/probe/unsupported arms and private RNG positions match baseline exactly for fixed state and seeds. Supported choices are deterministic given a consistent cell snapshot and seed. Existing schedule-stream isolation test remains valid.
7. Outcome timing: later population mutation between choice and completion cannot change supported membership of the scored run; failed/current rewards are never inherited from population entries; each learner's existing own-run reward counters retain meaning.
8. Concurrent ownership and resets: no nested entry lock, no cross-cell population contamination, configuration pooling preserved, maps and aggregate counters cleared across sessions; test through ordinary snapshot/flush export.

Existing tests in `arm_selector.rs` cover probe assignment, pooled keys, schedule isolation, warmup, learner exposure, posterior math, leading probabilities, coin share, chosen-arm counters and reward accounting. Extend them with focused cases rather than weakening assertions to accept the new policy. Test fixtures intended to exercise the old marginal branch should explicitly have insufficient population support; add separate supported fixtures. `util_stats_export_completeness.rs` covers transport rather than efficacy. No tests, builds, smoke runs, benchmarks or grader sessions were executed for this map.

## Frozen grading constraints to retain

No support rescue: >=100000 supported draws per ordinary 300-second chunk, >=20 learner/configuration cells each with >=100 population draws, firing >=50000 changed-joint draws, >=20% two-coordinate departures, TV >=0.10 on at least half of supported draws, two axes each >=10% mutation mass, and >=80% of population draws with at least four distinct live vectors. Keep the eight-entry gate, 24-entry cap and 500-credit age unchanged.

The fixed four-grid primary per-run band is [1.07,1.18], primary events/sec >=1.04 and campaign throughput >=0.97, with epoch floor and panel/AOS guards unchanged. Four independently reset ordinary chunks are required to confirm the retained four-chunk own-run reward clause: at least two learners >=1.10 of paired baseline reward rates and the third >=0.95. Early closure is permitted by frozen applicability/cost/harm failures; a shorter result is not four-chunk confirmation. No proposal here establishes any of those numerical outcomes.
