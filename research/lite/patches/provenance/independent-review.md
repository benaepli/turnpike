# Independent implementation review: provenance72

Final verdict: PASS for the reviewed scope. The bounded unfilled-slot attribution defect was corrected and independently rechecked. No blocking runtime, mathematical, diagnostic-definition or export defect remains in this review. Final spur-full.patch SHA256: 7cf2668323910ac8af0eacd615a5c4ff38ff7558df584106ab08a820c0f27f75. Final exported binary hash recorded by the implementer: 020acbb8a23c769adaeba56f1bdec8b6ccde58c59cc8867f025d8957d50998cd. This is an implementation review, not efficacy or supply evidence.

Read-only review of the exact hypothesis.json (equal to the selected admitted hypothesis), admitted decision, implementation report, candidate source and tests, accepted baseline source, export plumbing and protected grader readers. No source changes, builds, tests, exploration or performance measurements were run. Source references below are relative to tmp/loop/wt-lite-provenance/spur/spur-core/src/simulator/.

## Corrected defect

In the initial export, `util_stats/selector_context.rs:103-104`, called from `campaign.rs:445`, recorded every unfilled-slot Fresh assignment into learner=None. Every replay slot excludes the same probe classes that make arm_selector::learner(run_id) return None, so these actual issued runs have an assigned A/B/C learner. Consequently scopes.grid.contexts.fresh.learners.none.unfilled_slot_fresh contains all unfilled assignments, and the A/B/C fields incorrectly remain zero. The aggregate count is correct but the frozen per-context/per-learner assignment diagnostic is false.

Applied correction: pass learner(run_id) from the actual GridArm::assign empty-corpus branch to unfilled(), retain Grid/Fresh attribution, and test an unfilled prefix-tagged run appears in its actual assigned learner bucket with none remaining zero. Do not derive Fresh from the tag; the actual empty branch remains authoritative. The final source passes the assigned learner from GridArm::assign, and the test asserts the actual A/B/C bucket, other learner buckets zero, none zero, and aggregate one. This closes the defect.

## Selector and scoring findings

- Shared equations, cell keys, learner/probe assignment, warmup, exploration share and coin selection are unchanged. ContextEvidence::credit at arm_selector.rs:256 updates only five carried directions with discount0.998 and increments exactly one raw context observation per permitted credit. Shared and local credit occur under the same existing DashMap entry guard at :548-558. Coin-to-all and own-to-own behavior is retained.
- The shared posterior at :330 is the frozen As/Bs around reward_mass/mass. Contextual parameters at :510-514 use the shared posterior means ms, not the raw shared reward rate. Both context means and variances match Ac*Bc/((Ac+Bc)^2*(Ac+Bc+1)). This is the specified overlapping-data pseudo-posterior; no independent-evidence interpretation is warranted.
- The consistent read guard obtained at choose_with_context remains alive through shared/context vectors, all selections and diagnostic snapshots. Shared warmup and coin selection precede the24 matching-context raw-observation threshold. A sparse context falls through the original shared sampler.
- probabilities() uses the unchanged normal_cdf on pairwise mean differences over combined variance, multiplies by ordinary coin shares, normalizes over the axis, and preserves lowest-direction fallback for nonpositive total. Unused third entries on binary axes are zero. Weights are asserted finite; the bounded valid posterior values keep means, variances and sums finite. The lowest-index argmax rule uses strict greater-than comparisons.
- :515-523 calls the unchanged CellLearner::pick once for each of five axes. On positive totals, that function draws one f64 from the same privately seeded SmallRng and uses the same cumulative order. TV/argmax and diagnostic membership consume no RNG. The API accepts only schedule_seed, not the running schedule generator. Context specialization changes the action probabilities but not the private categorical draw budget.
- The exact salted1/16 membership at :524 applies only inside specialized actual learner draws. Diagnostic stores ten actual chosen-direction reward means inside Choice, along with that Choice's learner, context and scope. These are reward means ms/mc, not action probabilities q.
- observe() at :567-575 scores the immutable snapshot against rewards_of(the stored learner) before any credit. The five natural-log losses are averaged and clamped exactly as frozen. Later concurrent credits cannot change the stored prediction. Probes receive no credit or loss; coin runs have no specialized snapshot. ContextRun accounts successful/failed issued runs without creating rewards for failed execution.
- Actual GridRun Fresh/PlanReuse/PrefixReplay branches provide context before choose. run_recorded forces Fresh and actual TapeMutate forces TapeMutation, preserving source scope and ordinary attribution fields. Root separately reviewed complete caller attribution and runtime diff.

## Gate export audit

All new frozen aggregate gates are computable from the ordinary session utilization JSON flattened into utilStats.counters. The protected reader research/orchestrator/src/evaluate.ts:218-245 recursively preserves every finite numeric object leaf, including f64 loss and TV sums. No new field lies in a skipped large array. util_stats::snapshot contains the complete selector_context block, and reset clears all fixed atomic rows and cell state between sessions.

Let P = selector_context and S = P.scopes.{grid,aos}:

| Frozen quantity | Numeric leaves/arithmetic |
| --- | --- |
| Total specialized >=100000 per chunk | P.specialized_learner_draws |
| Specialized learner fraction >=0.75 by grid/AOS | S.specialized_learner_draws / (S.specialized_learner_draws + S.shared_fallback_learner_draws) |
| Each grid context >=5000; each AOS context >=1000 | S.contexts.{fresh,plan_reuse,prefix_replay,tape_mutation}.specialized_learner_draws for the specified actual contexts |
| Scored sample >=1000 grid, >=100 AOS per chunk | S.scored_runs |
| Mean categorical TV >=0.05 | sum(P.tv_sum) / sum(P.specialized_learner_draws) |
| Changed categorical argmax share >=0.15 | sum(P.changed_argmax_runs) / sum(P.specialized_learner_draws) |
| Four-chunk contextual/shared predictive loss <=0.98, separately grid/AOS | sum(S.context_loss_sum) / sum(S.shared_loss_sum) |
| Sample completion audit | S.sampled_runs, S.scored_runs, S.sampled_unscored_runs |
| Issuance/completion/credit audit | issued_runs, completed_runs, failed_runs, credited_runs, learner_credits at global/scope/context/learner levels |
| Context storage/visits | context_blocks_created, pooled_context_blocks_created, raw_observations_max, pooled_raw_observations_max and layout byte gauges |

The learner fraction denominator is actual Choice.learner=Some, including fallback, and correctly excludes all coins/probes. issued/draw/completion rows identify the assigned learner; credited_runs counts one permitted outcome; learner_credits counts the actual receiving learner (three on a coin run). Do not add flattened totals to their nested strata: the repeated hierarchy is alternative views of the same counts. Sum loss totals across chunks rather than averaging ratios. Maxima and layout byte gauges are not additive counts.

Campaign per-arm delta/add drops floating leaves, but the global selector_context.scopes.grid/aos loss and TV totals are computed directly from atomics and survive normal session export. Use these direct leaves for the frozen diagnostics, not the campaign arm delta objects. Scope Grid is the four fixed grid arms and Aos the one fixed AOS arm in the unchanged template; Other contributes no normal campaign runs. Existing graded arm counts/exposures, depth arrays, throughput and epoch ledger remain the inputs for the primary/cost/harm gates; those are not new selector counters. No protected harness change is required.

## Storage and validation evidence

Inspected ContextEvidence:12 f64 alpha +12 f64 beta + one u64 observations =200 bytes; exactly four inline blocks add800 bytes per existing learner/cell. No occupancy map, extra cell key or per-run corpus is introduced. CellLearner is1016 bytes, Choice96 bytes, RunAttribution32 bytes in the retained release-exported layout gauges. Choice owns its optional ten-f64 snapshot inline even on nonsampled runs. Fixed telemetry is48 rows of21 atomic u64 fields (8064 bytes), plus bounded snapshot serialization maps. context_blocks_created denotes blocks receiving first credit; it does not mean only those slots are allocated. Reserved context slots are4 times the existing live learner-cell count. Existing cell counters can provide that count.

Independently summed the initial tests-final.log:461 passed,0 failed,25 suites. Confirmed the initial config, tracked/full patch, superpatch and hypothesis hashes against hashes.json. No new test/build was run by this reviewer. The sole retained smoke was inspected only for export field structure and layout values, not supply/effect inference.

The initial export had a focused test gap, now covered by the added test described below: its categorical test used equal means/variances, and the selected-means snapshot test uses uniform local alpha7/beta31. Neither independently checked nonuniform contextual variances, normalized action vectors, five-axis TV/changed-argmax, or the specialized five-draw private sequence. The existing CountingRng schedule test constructs a generator that is never passed to choose; source/API establish absence of schedule RNG access, but that test does not establish the private draw count. The requested correction was a fixed asymmetric-state reference test computing both posterior formulas and probabilities independently, consuming exactly one reference f64 per positive-weight axis, and comparing ArmSet, TV and changed-argmax across fixed seeds. This is deterministic correctness coverage, not an efficacy experiment. Cold-context sampler equality, scoring from stored means after intervening credit, shared/coin/probe credit and reset already have focused coverage.

No further concrete runtime or definition defect was found. Four unchanged normal chunks are still required for confirmation, and any per-chunk supply failure remains a close condition; neither this review nor the smoke confirms a scientific prediction.

## Final correction and export recheck

Re-read the corrected attribution code and new asymmetric_context_matches_reference_posteriors_and_five_private_draws test. The new test builds unequal shared and local evidence, independently computes shared/context A/B, means, variances and normalized categorical probabilities, derives TV and lowest-index argmax by its own loops, and constructs expected actions from exactly five reference f64 draws for four fixed schedule seeds. It compares actual actions, actual saved selected-direction reward means, emitted specialized count, TV sum and changed-argmax count. This closes the identified deterministic coverage gap. It reuses only the already validated normal_cdf and baseline coin-share definition, not the new probabilities helper.

Independently summed refreshed tests-final.log:462 passed,0 failed across25 suites; both the asymmetric test and corrected unfilled-attribution test pass. Refreshed build.log ends with successful release completion. Recomputed hashes of both patches, config, empty superpatch and frozen hypothesis agree with refreshed hashes.json. The exported untracked telemetry source equals the final source byte-for-byte, and the tracked git diff matches spur.patch. No reviewer test, build or simulator run was performed. No additional smoke was run; the retained firing smoke is earlier than the final telemetry fix/test addition. The final full test/build evidence covers that change.
