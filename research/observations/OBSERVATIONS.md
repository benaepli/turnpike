# Observations

Dated notes appended by the research loop.

## 2026-08-24T09:16:11.502Z

### Initial perf profile snapshot (bench workload)
```
# Overhead  Command          Shared Object                    Symbol                                                                                                                                                                                                                                                                          
    26.46%  spur             libc.so.6                        [.] __memmove_avx512_unaligned_erms
            |          
             --26.42%--__memmove_avx512_unaligned_erms
                       |          
                       |--6.92%--core::ptr::write (inlined)
                       |          |          
                       |           --6.82%--<T as core::clone::uninit::CopySpec>::clone_one (inlined)
                       |                     <T as core::clone::CloneToUninit>::clone_to_uninit (inlined)
                       |                     |          
                       |                     |--5.31%--alloc::sync::Arc<T,A>::make_mut
                       |                     |          
                       |                      --1.45%--alloc::sync::Arc<T,A>::make_mut
                       |          
                       |--6.53%--alloc::boxed::Box<T>::new (inlined)
                       |          alloc::sync::Arc<T>::new (inlined)
                       |          <archery::shared_pointer::kind::arc::ArcK as archery::shared_pointer::kind::SharedPointerKind>::new (inlined)
                       |          archery::shared_pointer::SharedPointer<T,P>::new (inlined)
                       |          |          
                       |          |--4.05%--imbl::vector::GenericVector<A,P>::promote_front
                       |          |          |          
                       |          |           --4.01%--imbl::vector::GenericVector<A,P>::push_back
                       |          |          
                       |           --1.91%--imbl::vector::GenericVector<A,P>::promote_front
                       |          
                       |--3.91%--<imbl_sized_chunks::sized_chunk::Chunk<A,_> as core::clone::Clone>::clone (inlined)
                       |          <T as core::clone::uninit::CopySpec>::clone_one (inlined)
                       |          <T as core::clone::CloneToUninit>::clone_to_uninit (inlined)
                       |          |          
                       |          |--2.81%--alloc::sync::Arc<T,A>::make_mut
                       |          |          
                       |           --1.10%--alloc::sync::Arc<T,A>::make_mut
                       |          
                       |--2.37%--<imbl_sized_chunks::sized_chunk::Chunk<A,_> as core::convert::From<&mut imbl_sized_chunks::inline_array::InlineArray<A,T>>>::from (inlined)
                       |          <T as core::convert::Into<U>>::into (inlined)
                       |          imbl::vector::GenericVector<A,P>::promote_front (inlined)
                       |          |          
                       |           --2.37%--imbl::vector::GenericVector<A,P>::push_back
                       |          
                        --1.16%--alloc::sync::Arc<T>::new (inlined)
                                  <archery::shared_pointer::kind::arc::ArcK as archery::shared_pointer::kind::SharedPointerKind>::new (inlined)
                                  archery::shared_pointer::SharedPointer<T,P>::new (inlined)
                                  |          
                                   --1.12%--imbl::vector::GenericVector<A,P>::promote_front

```

(publish selftest 2026-08-24T09:16:27.977Z)

## 2026-08-24T10:34:37.041Z

**orphan-message-purgatory** (closed): Screen run is degenerate, not merely negative: 5400 runs at 215/s but gradedRuns=0, depthAtLeast=[], h1/h2/h2b/h3 all exactly 0.0 and h2 delta -0.392 (i.e. baseline h2 ~0.39 -> 0). A mechanism that merely reorders delivery cannot zero out the grader; zero graded runs means histories stopped being produced/paired at all (porcupineWallMs=731 with nothing to check). Corroborating: the recorded diff touches only scheduler_configs/loop/general_vr.json — spurFiles is empty and no core/exec.rs / crash-path change is in superFiles. So either (a) the described implementation never landed and the unknown config key silently poisoned the run, or (b) holding orphaned in-flight messages past crash starves every client request so no operation ever completes -> nothing linearizable to grade. Either way the result is uninformative about the H2 hypothesis itself: we did not test 'stale-incarnation delivery raises depth>=5..7', we tested 'runs die'. Two process lessons: (1) a config-only diff for an add-kind hypothesis is a red flag the harness should catch before spending 25s x N seeds; (2) gradedRuns=0 should be an automatic invalid/re-run verdict rather than a scored comparison, since the objectiveDeltas computed here (all <=0) are artifacts of an empty grading set and should not be read as evidence against orphan holding. The underlying rationale (deliberately manufacturing dead-incarnation deliveries) is untouched and still plausible, but any retry must (i) actually implement the release-at-Recover path, (ii) bound hold duration so client ops can still complete, and (iii) assert gradedRuns>0 before reporting.

## 2026-08-24T09:19:52.666Z

**?** (?): Config-only purgatory (delay_probability 0.15, delay_duration_range [5,100]) in scheduler_configs/loop/general_vr.json produced no measurable ladder movement: primary 0, violations 0, depth>=6/7/8 all 0, and small NEGATIVE deltas on depth>=4 (-0.036), depth>=5 (-0.003) and h2 (-0.392). So uniform random message delay at this rate does not create the old-message-after-recovery interleavings the oracle chain needs; it mostly perturbs schedules that were already being explored, slightly diluting mid-depth coverage. Run was also procedurally invalid: lint failed because the diff touched research/journal.jsonl (superFile) — any future config experiment must keep the diff to scheduler_configs/ only, so the numbers above should be treated as directional rather than certified. Two takeaways: (1) blind uniform delay is the wrong knob granularity — delays need to be correlated with crash/recovery windows to matter; (2) the enabling-mechanism assumption ('purgatory exists but is off') was correct, but existence != usefulness at default-ish parameters.

## 2026-08-24T10:07:02.142Z

**enable-timeline-feedback-general-config** (closed): Flipping feedback:{mode:"timeline", steer:true} in scheduler_configs/loop/general_vr.json is a pure-config change that runs, but it does not pay: no violations gained, primary objective flat (0), and the ladder moved slightly negative at the shallow rungs (depth>=4 -0.036, depth>=5 -0.003, depth>=6/7/8 all 0) with h2 down -0.39. So timeline feedback + steer as currently wired diversifies at shallow depths without converting into deeper coverage — steer's divergent picks are spent on cheap early-branch novelty rather than on the deep interleavings that the ladder rewards. Verdict closed: regression failed and lint failed, but the lint failure is a grader/tooling artifact, not a code defect — the 'lint failures' list is a dump of Graphviz SVG text nodes (cluster_DoViewChange, cluster_StartView, <text> elements with coordinates) from .smoke_out/cfg.svg plus a research/STOP file. The lint stage is globbing generated smoke artifacts (.smoke_out/*.svg, parquet outputs) as lintable sources, so any hypothesis whose run emits .smoke_out will trip a false lint failure regardless of its actual diff. That contaminates the verdict signal for every config-only experiment in this pool and should be fixed before more config runs are judged.

## 2026-08-24T17:56:49.974Z

**send-anchored-crash-points** (closed): Mechanism works as designed but is objective-negative. Anchoring crash runnables to observed remote dispatches (p=0.3, score boosted to ~1.0) nearly doubled the crash-after-send hazard (h1Rate 0.50 vs ~0.28 baseline), confirming the scheduler hook and config threading (ExplorerConfig->SingleRunConfig->scheduler state) work. But hard preemption starves the rest of the runnable set: h2 collapsed (-0.388), depth>=4 fell -0.034 and depth>=5 -0.002, maxPrefixDepth capped at 5, meanPrefixDepth 2.275, unpairedFraction 0.465, and violations stayed at 0. Interpretation: killing the sender immediately after dispatch truncates the run — the crashed node never performs the follow-on work that generates the second hazard or the deeper linearizable prefix, so we buy one hazard by destroying the tail of the trace. Raw hazard rate is therefore NOT a proxy for bug-finding here; joint h1-and-h2 co-occurrence plus prefix depth are the quantities that matter. Perf was fine (264 runs/s, 5400 runs in 20s), lint passed, regression failed. Any revisit must (a) delay the crash by a bounded number of steps after the dispatch rather than firing immediately, and/or (b) use a soft score boost that keeps other runnables selectable, and be scored on h1&h2 conjunction rather than h1 alone.

## 2026-08-24T17:58:39.295Z

### Audit @15
Implement dominates at 523.3s of 608.7s total logged phase time (86.0%); evaluate is 44.7s (7.3%), reflect 40.4s (6.6%), build 0.3s and propose ~0s (<0.1%). Across the last 15 iterations the same skew holds (iter 13: implement=539.6s vs evaluate=231.4s; iter 12: implement=647.8s then hard error before any evaluation). Worse, 8 of 15 iterations (2,3,4,6,7,8,11,14) never finished at all and 2 more (10,12) ended in 'Claude Code returned an error result' — so roughly 2/3 of wall-clock is spent on iterations that produce zero merged metric rows. The 'Latest merged' column is empty for every metric after 15 iterations, meaning cumulative spend has bought no measured movement over baseline. Budget is concentrated in code-writing, not in measurement or in deciding what to measure (propose ~0.001s is effectively a no-op phase).

Goodhart: meanPrefixDepth and P(depth>=k) reward longer prefixes, not more bugs found — a mechanism that merely lengthens schedules (e.g. purgatory delays, orphan holds) inflates depth without increasing violation discovery, and violations has been 0 at baseline with no other correctness-grounded metric to anchor it.; violations=0 baseline means the only ground-truth metric is saturated-at-zero and therefore contributes no gradient; the loop is optimizing exclusively surrogates (depth, h-rates) with no check that the surrogates correlate with violation discovery.; h1/h2/h2b/h3Rate are hypothesis-specific event rates; 4 of them alongside 5 depth metrics gives the loop wide latitude to declare a win on whichever metric moved, i.e. metric-shopping. No pre-registered primary metric is recorded in the status.; runsPerSec (142.4) is listed on the ladder and can be traded against exploration quality — a perf hypothesis (reduce-explorer-memory-footprint, gain/cost 6/6) could raise runsPerSec while reducing per-run diversity and still read as progress.; Two 'enabling' hypotheses were closed and one blocked before any merged metric row exists; closing enablers with gain/cost 4/0.5 and 6/2 as cheap wins inflates the closed count (3) without any ladder movement — activity metrics standing in for outcomes.

Utilization: steer=broken, purgatory=unexercised, crash_after_send=unexercised, dedup=unexercised, aos=unexercised, feedback=unexercised, randomly_drop_msgs=unrewarding, explorer allocation (imbl/Arc memmove)=healthy, eval-guard-graded-runs=scaffolding

Policy suggestions: Freeze all 'add' hypotheses until every mechanism with a zero counter is either exercised or deleted. Concretely: block orphan-message-purgatory, purgatory-recovery-correlated-delay, send-anchored-crash-points, hazard-fitness-for-guided-modes, incarnation-timeline-tuples, and steer-depth-gated (combined cost 27 units) — all six build on mechanisms recording 0 executions. Require a 'mechanism fires >0 times in the evaluated config' precondition in the hypothesis schema, checked automatically before implement starts.; Treat steer as a P0 bug, not a hypothesis: 0 divergent picks in 2,250,224 evaluations is a defect. Spend one cheap diagnose iteration on the gating predicate before any steer-adjacent work. If it cannot be made to fire within one iteration, ablate it and reclaim the per-evaluation overhead.; Fix the iteration failure rate before anything else. 8/15 iterations never finished and 2/15 errored out; only 3 (1, 10-partial, 13) reached reflect and none produced a merged metric row. Add a hard per-phase wall (implement <= 300s, currently averaging 523-648s) with automatic abort-and-record, and make a failed iteration write a row explaining the failure so the ladder is not silently empty for 15 iterations running.; Drop P(depth>=6), P(depth>=7), and P(depth>=8) from the decision ladder entirely — all three are 0.000 at baseline and at 21k screen runs / 128k confirm runs cannot support a decision. Keep them as diagnostics only. Promote meanPrefixDepth and the h-rates (SE ~0.003 at screen fidelity) to the powered tier.; Pre-register a single primary metric per hypothesis at propose time and require it in the record, with the other 10 metrics explicitly marked secondary. Screening 11 correlated metrics per hypothesis gives ~43% per-hypothesis false-positive probability at nominal 0.05; without pre-registration the loop can metric-shop indefinitely.; Require multi-seed evaluation with reported CIs: minimum 3 independent seeds at screen and 5 at confirm, and reject any promote/confirm decision whose effect is inside the seed-to-seed spread. Currently no replicate count is recorded at any fidelity.; Add a ground-truth anchor to counter Goodhart on depth. violations has been 0 at baseline, so inject a small set of known-buggy specs (mutation-style) and track detection rate alongside meanPrefixDepth; refuse to merge any hypothesis that raises depth while leaving injected-bug detection flat or lower.; Rebalance the phase budget away from implement. propose is 0.001s — effectively skipped — while implement runs 523-648s on hypotheses whose mechanisms are dead. Allocate a real propose/triage step (target 30-60s) whose only job is checking utilization counters and dependency order, which would have caught all six blocked-on-dead-mechanism hypotheses above for ~1% of the cost of implementing them.; Take the two cheap, evidence-backed items now: lint-ignore-smoke-artifacts (5/0.5, best gain/cost ratio in the pool at 10x) and ablate-dead-randomly-drop-msgs (2/1), and unblock enable-purgatory-general-config (5/0.5) since it gates ~8.5 cost units of downstream work. Total cost 2 units.; Cap reduce-explorer-memory-footprint expectations explicitly: memmove is 28.82% of profile but eval is only 4.32%, so even perfect elimination of copy-on-write traffic yields at most ~1.4x runsPerSec (142.4 -> ~200). Record that ceiling in the hypothesis before spending its 6 cost units, and do not let runsPerSec gains substitute for ladder movement.

## 2026-08-24T18:17:44.176Z

**exclusive-timer-firing** (closed): Restricting timer firing to a single rotating 'active timeout node' did not move the ladder: at seed 11 the primary objective was flat (violations 0), depth>=4 fell slightly (-0.011) and depth>=5 marginally (-0.0006), with h1 -0.006 and h2 -0.006 against h3 +0.004 — noise-level movement in both directions, and the regression gate failed. Interpretation: the deep-prefix bottleneck is not contention among simultaneously-timing-out backups; serializing which node may time out mostly removes interleavings without adding new reachable structure, and the rotation window (fixed K) is an arbitrary schedule that does not correlate with the protocol state where a single suspect is actually useful. Exclusivity is only valuable if it is conditioned on state (a node that has a pending request / stale view), not on a step counter. Cost was low (5 files, ~14s explore), so the mechanism is cheap to keep behind a default-false flag but there is no evidence to enable it in general_vr.json.

## 2026-08-24T18:22:09.084Z

**ablate-dead-randomly-drop-msgs** (closed): The ablation itself was semantically correct (violations 0, primary delta 0, lint clean), but it was NOT metric-neutral: h1 +0.0030, h3 +0.0015, depth>=4 -0.0013, depth>=5 +0.0009 on a single screen seed (seed 11, 5400 runs). A branch that is provably never taken cannot change grading outcomes unless the edit perturbed the RNG draw sequence (removing the drop-branch coin flip shifts every downstream sample), so seed 11 pre/post are different explorations, not a paired comparison. Consequence: the non-inferiority/regression gate is measuring seed-level noise, not effect — it failed the pure-hygiene change it was supposed to trivially pass. Two pipeline defects surfaced: (a) no RNG-stream stability across refactors and no multi-seed pairing, so |delta| ~1e-3 is indistinguishable from the noise floor, which is currently unmeasured; (b) unpairedFraction 0.466 means nearly half of runs are unpaired at grading, further inflating variance. Throughput is fine (274 runs/s, 19.7s explore, grading ~1s), so multi-seed screening is cheap. The end-to-end ablate pipeline (branch -> screen -> grade -> decide) does execute, so the plumbing is validated; the decision rule is not. Do not read this verdict as evidence against the code change — it is evidence against the gate.

## 2026-08-24T23:13:05.538Z

**meta-noise-floor-screen-gate** (closed): The measurement half ran; the gate-change half did not. Diff touched only scheduler_configs/loop/noise_floor.json+.md (zero code, zero spur files), so this was a provable null experiment — and the harness still returned verdict=closed via regressionPassed=false with lintPassed=true. That is a demonstrated false-positive of the regression gate on a diff that cannot change behavior (1/1). NOISE FLOOR (3 seeds 11/23/37, n=21600 confirm, unmodified baseline): h1 mean 0.4894 sd 0.0040; h2 0.3873 sd 0.0040; h2b 0.4170 sd 0.0015; h3 0.3415 sd 0.0009; meanPrefixDepth 2.2548 sd 0.0075 (0.33% rel); d>=4 0.0349 sd 0.0015 (4.2% rel); d>=5 0.00220 sd 0.00047 (21% rel). Binomial sqrt(p(1-p)/n) predicts 0.0034 / 0.0033 / 0.00032 for h1/h2/d>=5 — observed/predicted 1.15-1.45, i.e. seed-to-seed dispersion is essentially pure sampling noise with only ~20-45% excess. There is no hidden seed-structure variance; sigma scales as 1/sqrt(n), so screen (n=5400) sigma_h1 ~= 0.0068, sigma_h2 ~= 0.0067, sigma_{d>=5} ~= 0.00064. Against that floor the recorded closure deltas are noise by an order of magnitude: h2 = -0.00032 is 0.08 sigma at confirm n and 0.05 sigma at screen n; primary (d>=5) = +0.00012 is 0.26 sigma (~2.7 runs out of 21600). The parent's 0.003 h1 wobble was 0.44 sigma at screen n — also unresolvable. Actionable tolerances (2 sigma): screen h1/h2 0.014, h3 0.004, d>=4 0.006, d>=5 0.0013, meanPrefixDepth 0.015. Two structural findings fell out. (1) LADDER SATURATION: maxPrefixDepth == 5 in every run at every budget up to 21600; depth>=6/7/8 are identically 0 and carry zero information, while the nominal primary d>=5 has 21% relative sigma — it is the single noisiest objective in the set. meanPrefixDepth has ~65x better relative precision on identical data. Selecting on d>=5 at current budgets is close to selecting on coin flips. (2) TIMING METRICS ARE UNUSABLE AS GATE SIGNAL: confirm seed 23 recorded exploreWallMs 14,581,119 (4.05 h) at 1.48 runs/s while its sibling seeds ran 125-210 runs/s, with statistically indistinguishable output metrics — a harness/machine stall, not a workload difference. Any perf regression rule keyed on wall time would have fired spuriously. Side note: unpairedFraction is 0.4659/0.4735/0.4753/0.4689/0.4733 across all seeds and fidelities (sd 0.0022) — a stable ~47% systematic pairing loss, NOT a variance source as the hypothesis notes speculated; the follow-up question is whether recovering it buys ~1.37x effective sample.

## 2026-08-25T01:41:45.495Z

**enable-purgatory-general-config** (auto_merge): Enabling purgatory (p=0.15, delay 5-100) in scheduler_configs/loop/general_vr.json is a real but small positive: over 3 confirm seeds x 21.6k runs it moved depth>=4 by +1.5pp and depth>=5 (primary) by +0.14pp, h2 by +1.0pp, with 0 violations, 0 unknowns, and no throughput cost (~278-283 runs/s, unchanged). Ceiling is unmoved: maxPrefixDepth stays pinned at 5 across all seeds and depth>=6/7/8 remain exactly 0, so message delay alone reorders enough to deepen the mid-ladder but does not manufacture the late-chain events (old message landing after a completed recovery/view change) needed to cross depth 6. Effect is seed-stable (depth>=5 counts 82/70/65 of 21600, ~0.35% - low absolute count, so this metric is noisy at screen fidelity and needs >=20k runs to resolve). Uniform, untargeted delay is the likely limitation: a 5-100 tick delay drawn independently of protocol state rarely straddles a view change, so most delayed messages still arrive in an epoch where they are trivially discarded. Purgatory is now on and available as a substrate for dependents that were gated on it.

## 2026-08-25T01:52:38.829Z

**pct-priority-selector** (closed): PCT-style priority selector (random static priorities + d demotion change points) was implemented in core/queue_selector.rs behind the within_queue_selector enum and screened at seed 11 on general_vr.json (5400 runs, 367 runs/s). It did not clear the screen gate: zero violations and the depth ladder moved slightly negative vs baseline (depth>=4 -0.0078, depth>=5 -0.0007, depth>=6/7/8 flat at 0), with handler rates all down or flat (h1 -0.032, h2 -0.024, h3 +0.005). Primary objective delta -0.0007. Regression suite failed (lint passed), so the branch was closed. Interpretation: on this workload the bug/coverage frontier is not depth-limited in the PCT sense — classic PCT's fixed random priority assignment plus a handful of demotions effectively serializes runnables and reduces the interleaving entropy that Tournament's per-step randomization provides, hurting exactly the deep-prefix tail we care about. Throughput was fine, so the loss is behavioral not budgetary. Caveat: only one seed and one depth setting were screened, and the regression failure means part of the delta may be implementation noise rather than a clean read on PCT itself; but the effect direction (flat at depth>=6..8) gives no evidence the mechanism is reachable-but-mistuned.

## 2026-08-25T03:21:34.122Z

**enable-timeline-feedback-general-config** (closed): Flipping feedback={mode:timeline, steer:true} in scheduler_configs/loop/general_vr.json is a null result on VR, and the arm closed on a regression-suite failure (lint clean). Ladder is flat to the 4th decimal across 5.4k-screen -> 13.5k-promote -> 21.6k-confirm x3 seeds (11/23/37): meanPrefixDepth 2.314-2.328 vs baseline-equivalent, maxPrefixDepth pinned at 5 in every run, depth>=4 delta -5.7e-4, depth>=5 -1.2e-4, depth>=6/7/8 exactly 0, primary -1.2e-4; only h2 moved (+1.4e-3) and that is inside cross-seed spread (h2Rate 0.3959/0.4008/0.4003). Zero violations, zero unknown, throughput 150-162 runs/s, so feedback+steer costs ~0-6% wall and buys nothing measurable. Critically, the intended diagnostic -- the steer utilization counters (how often steer's pick diverges from the base sampler) -- was NOT emitted in the metrics blob, so we cannot distinguish 'steer fires often and doesn't help' from 'steer never fires' (config key ignored / gate never true / timeline signal degenerate on VR). The tri-seed consistency (depth>=5 counts 65/76/68 out of 21600) argues the run is deterministic-ish and the mechanism is inert rather than noisy-harmful. Two blockers to unstick before any dependent of timeline-feedback/steer is worth spending on: (a) the regression failure is unexplained and may be the config schema itself rather than behavior, (b) no utilization telemetry. Do not requeue this arm as-is a third time; requeue only behind instrumentation.

## 2026-08-25T03:23:19.570Z

### Audit @25
Evaluate dominates the ledger at 1084.6s (~76% of the 1342s accounted), with regression (89.2s, 6.6%) second and implement only 127.5s (9.5%) — but the ledger badly understates implement: the per-iteration table shows implement=6717s in iter 20 and 1276s in iter 19, and evaluate=15471s in iter 19. So real spend is bimodal: a few mega-iterations (19, 20) consumed ~4.9h and ~2h wall respectively, roughly 70%+ of the last 15 iterations' wall clock, while iterations 15-18 and 22-24 cost 3-12 min each. Propose is effectively free (<1ms) — meaning hypothesis selection is doing no measurable work and 19 of 27 hypotheses sit un-run. Additional waste: 3 of the last 15 iterations (11, 14, 21, 24) have no finish timestamp (abandoned/crashed), and 2 more (12, 16) ended in hard errors — a ~33% iteration failure/abandon rate is the single largest recoverable cost.

Goodhart: Two merges in 25 iterations moved zero primary metrics: meanPrefixDepth identical to 3sf, P(depth>=5) down (worse) by 0.001, violations still 0 — yet both are recorded as merged wins, so 'merged' has decoupled from 'improved'.; P(depth>=6/7/8) are structurally zero and remain on the reported ladder; keeping all-zero rows creates the appearance of a richer metric suite than actually exists and invites cherry-picking whichever of 11 rows happened to tick up.; h1/h2/h2b/h3 form four correlated hazard rates; reporting them separately gives four independent chances at a nominally positive delta (multiple-comparisons inflation with no correction), and the only 'gains' this iteration are exactly the two smallest of them.; enable-purgatory-general-config merged at gain/cost 5/0.5 — an extremely cheap 'enabling' flag flip that produces 292,850 delayed sends of activity but no depth movement; high activity counters are substituting for outcome evidence.; runsPerSec is being tracked alongside correctness metrics, letting a perf-only change (reduce-explorer-memory-footprint, 6/6) register as ladder progress while contributing nothing to bug-finding.; The proposal pool is skewed toward grader/objective-redefinition hypotheses (primary-objective-swap-to-low-variance-depth-statistic, joint-hazard-objective, gate-two-sigma-tolerance) — changing the scoreboard is now competing with changing the system, which is the classic pre-Goodhart failure signature.

Utilization: steer=broken, feedback=unexercised, purgatory=unrewarding, dedup=unexercised, aos=unexercised, randomly_drop_msgs=scaffolding, explorer memory (imbl/Arc)=healthy

Policy suggestions: Retire P(depth>=6), P(depth>=7), P(depth>=8) from the reported ladder immediately — they are identically 0.000 and can only serve as cherry-pick surface. Promote meanPrefixDepth (or an area-under-depth-CCDF statistic) to sole primary; adopt primary-objective-swap-to-low-variance-depth-statistic (7/1.5) as the next hypothesis.; Land gate-two-sigma-tolerance-and-null-diff-regression-test (8/2) before any further add-hypotheses. Require every merge to clear 2 sigma over >=3 independent seeds, and add a null-diff (identical-code, different-seed) run each iteration to publish the empirical noise floor; the closed meta-noise-floor-screen-gate work is evidently not being enforced given single-seed 0.001 deltas are still reported as movement.; Freeze all new 'add' mechanisms until the two zero-signal mechanisms are resolved: debug steer's divergent_picks=0 over 2.2M evaluations (likely blocked on feedback.scored_runs=0) by merging enable-timeline-feedback-general-config (4/0.5, cheapest open item), and either enable or delete dedup and AOS. Do not fund hazard-fitness-for-guided-modes (cost 6) while AOS has never executed.; Downgrade the purgatory follow-on cluster (release-on-state-change, recovery-correlated-delay, long-tail sweep, probability sweep — 4 hypotheses, ~10 cost units). Run only the cheap clean sweep (2/1.5) as a kill-test; if 292k delayed sends still yield no depth delta at 2 sigma, close the whole cluster.; Add a hard iteration-health policy: ~33% of the last 15 iterations errored or never finished (11, 12, 14, 16, 21, 24). Cap implement wall at 90 min per hypothesis as budgeted (iteration 20 ran 6717s = 112 min, iteration 19 evaluate ran 15471s = 4.3h, both over), auto-abort and record a failure reason, and treat repeated aborts as an automatic close.; Stop reporting runsPerSec on the same ladder as correctness metrics, or explicitly label it non-primary; require perf hypotheses to show a >=5% improvement across repeated trials before merging (the merged 6/6 perf item delivered +2.1%, unverified).; Take the free wins: unblock lint-ignore-smoke-artifacts (5/0.5, currently blocked) and land ablate-dead-randomly-drop-msgs (2/1). Combined cost 1.5 units against 19 stalled proposals.; Fix the propose stage — it consumes <1ms and has left 19 of 27 hypotheses untouched while re-merging cheap flag flips. Either raise explorationQuota above 0.3 or require the bandit to justify skipping the highest gain/cost items (orphan-message-purgatory 9/4, gate-two-sigma 8/2) explicitly in the iteration record.; Since violations has been 0 for all 25 iterations, add at least one seeded-bug or mutation-injected spec to the evaluation so the loop has a ground-truth positive signal; without it every metric on the ladder is an unvalidated proxy.

## 2026-08-25T05:35:51.868Z

**delayed-send-anchored-crash** (closed): Softening the send-anchored crash hook converted it from harmful to inert. Screen (seed 11, VR, 5400 runs): h1 0.484, h2 0.390, h3 0.332, maxDepth 5, 0 violations — every objective delta is within noise of baseline (|Δ|<=0.006, primary +0.0002), and the parent's damage (h2 -0.39, truncated traces) is gone but so is the parent's h1 lift (0.50). The three softening knobs are jointly too weak: p=0.15 x max 1 crash/run x a 2.0x multiplicative boost almost never changes argmax selection, so the mechanism fires rarely and, when it does, loses the score contest. Dose-response is therefore bimodal as parameterized: hard override = trace truncation, soft = no-op; the useful middle (if any) was not sampled. Cost side is real: +4 general config params (11->15) and regression failed, for zero measured gain. Verdict closed. Key structural insight for the family: crash is the wrong instrument for widening the in-flight-message window, because the same act that creates the hazard also removes the actor that would generate downstream hazards and depth; a non-terminal preemption (deprioritize the matching delivery) achieves the window without destroying the run.

## 2026-08-25T05:46:31.905Z

**dispatch-anchored-delivery-deferral** (closed): Changing the instrument (crash -> non-terminal deferral) did not rescue the send-anchored family: every objective moved within noise (primary/depth>=5 +0.0013, h2 +0.0056, h1 +0.0002, violations 0, depth>=6 flat at 0). Screen run: h1 0.489, h2 0.399, h3 0.334, meanPrefixDepth 2.34, maxPrefixDepth 5, depthAtLeast [5400,4791,2104,288,27]. The parent's failure was diagnosed as 'crash kills the actor that would produce h2', but removing the crash bought ~nothing, so that diagnosis was wrong or incomplete: the real problem is that the send-anchored hook is near-inert. Multiplying ONE Deliver runnable's score by 0.1, gated at p=0.3 for <=3 steps, is far too small a lever against a large runnable set with softmax-ish selection -- the suppressed delivery is still frequently picked, and the in-flight window barely widens. Conclusion: widening the in-flight window per-message is not the binding constraint on depth (still hard-capped at 5), and score-scaling a single runnable is below the effect-size floor at which this scheduler responds. Also notable: regressionPassed=false while lint passed, despite touching exec.rs/state.rs/path.rs -- the dispatch-observation plumbing inherited from the parent perturbs replay/path semantics, so that plumbing is a liability to reuse as-is. Two consecutive failures on the same anchor (dispatch-of-remote-message) argue the anchor itself is uninformative, not the reaction attached to it.

## 2026-08-25T06:45:02.628Z

**incarnation-timeline-tuples** (closed): Adding an incarnation-crossing flag to TimelineTuple did not move the depth ladder at screen fidelity (seed 11, 5400 runs): depth>=4 -0.0015, depth>=5..8 exactly 0, violations 0, max prefix depth still 5. Oracle-chain rates were flat-to-noise (h1 +0.005, h2 +0.0007, h3 -0.0002). Interpretation: the extra flag multiplies the tuple space (more novel tuples to chase) without making post-recovery deliveries of pre-crash messages actually reachable more often — steer spends budget on newly-labeled-but-behaviorally-identical tuples. Crash/recover events are apparently rare enough in the general config that crossing tuples are a thin slice; refining the novelty key is not the bottleneck, generating the crossing situations in the first place is. Cost was low (~23s explore, 5 spur files, lint clean), so the negative result is cheap and informative: further novelty-key enrichment on top of the existing timeline signal is unlikely to pay unless paired with a mechanism that raises crash/recover density or preserves in-flight messages across incarnations.

## 2026-08-25T07:36:12.718Z

**crash-recover-density-knob** (closed): Null-to-negative. Across 2 sequential (5.4k runs) + 3 confirm (21.6k runs) evals at seeds 1000/1001/11/23/37, the depth ladder was flat: depth>=4 -0.28pp, depth>=5 +0.01pp, depth>=6/7/8 exactly 0, maxPrefixDepth pinned at 5 in every run, meanPrefixDepth 2.31-2.33 (baseline-equivalent), 0 violations, unpairedFraction ~0.485 unchanged. h2 fell 2.4pp (0.405->0.38) while h2b/h3 were flat, i.e. the bias slightly redistributed shallow coverage rather than deepening it. Cost: +2 general config params for zero primary gain, and the regression suite failed (lint passed) -> closed. Critically, the promised instrumentation (post-recovery deliveries of pre-crash messages) never surfaced in the recorded metrics, so the hypothesis's own precondition -- 'verify the situation density actually rises' -- was left unverified; we cannot distinguish (a) the knob failed to raise crash/recover-crossing density from (b) density rose but the depth ladder is insensitive to it. That ambiguity is the real deliverable: the same failure mode as the parent (incarnation-timeline-tuples), and it means no further crash/recover steering should be attempted before the density counter is a first-class, reported metric. Secondary lesson: touching scheduler.rs event selection broke regression even though it was gated behind a default-0.0 bias, so the gating was not actually inert.

## 2026-08-25T09:13:19.865Z

**ablate-dead-randomly-drop-msgs** (auto_merge): Ablation landed (auto_merge, non-inferior, regression+lint green). Two claims tested; one held, one broke. HELD: the 30% drop branch is genuinely unreachable — both call sites pass false, no config field gates it, general config param count unchanged 12->12, and removal touched only spur-core scheduler.rs + path.rs with zero super-side edits. Violations stayed 0/54000 across both seeds. BROKEN: the predicted *exact* non-inferiority. Deltas are small but nonzero (primary/depth>=5 -1.48e-4, depth>=4 +1.53e-4, h2 +1.02e-4, depth>=6/7/8 exactly 0), i.e. trajectories reshuffled rather than reproduced bit-for-bit. Signature is diagnostic: sign-flipped adjacent-depth pair of equal magnitude (~8 runs of 54000 migrating between depth buckets) with deep tail untouched = draw-count shift in a shared RNG stream, not a behavioral change. So the drop check was consuming (or offsetting) a draw from the same stream the scheduler uses for its live decisions even with the flag off; deleting it re-phased every downstream sample. Consequences: (a) rng-stream-isolation is now empirically motivated, not speculative — this run is its evidence; (b) no future ablation, however dead the code, can claim exact reproducibility under the current RNG design, so 'expected exact' must be retired as a gate criterion until streams are isolated; (c) we have no measured noise floor, so we cannot currently distinguish this 1e-4 reshuffle from a genuine 1e-4 regression — the gate passed on non-inferiority slack, not on a calibrated band. Pipeline itself validated end to end: ablation kind now correctly screened without demanding superiority.

## 2026-08-25T09:40:48.836Z

**hazard-fitness-for-guided-modes** (closed): Rejected at sequential fidelity after 2 seeds / 108k runs (seeds 1000-1001, general_vr.json, VR.spur). Hazard-weighted plan_score moved nothing: all objective deltas ~1e-4 or negative (h2 -0.0012, h1 -0.0003, h3 -0.0002, depth>=4 -0.00035, depth>=5 +1.4e-5, violations 0 both arms); pMei d4=0.002 at +4%, d5=0.025 at +13% — no frontier rung separable. Root cause is signal saturation, not implementation: baseline hazard rates are already h1~0.50, h2~0.40, h2b~0.42, h3~0.33, so a fitness term that rewards 'a hazard happened' is near-constant across the population and supplies almost no selection gradient. The scarce quantity is depth, not hazards — meanPrefixDepth 2.32, maxPrefixDepth 5, and only 209/54000 runs reach depth>=5. Additionally the guided half of the hypothesis was never testable: aos/genetic are inert in this config (tape_wins=0, config_wins=0, cfg_score_sum=0.0), so only feedback-mode='hazard' was exercised. Throughput unaffected (~260-265 runs/s, explore ~205s), general-config param count unchanged 12->12, lint passed. Corollary for the pool: any binary event-occurrence fitness whose base rate is >0.1 is unlikely to steer this scheduler; future feedback terms must key on rare/compound events, and it is worth first auditing whether plan_score perturbations of this magnitude change scheduling decisions at all in general_vr.json.

## 2026-08-25T10:52:15.140Z

**state-conditioned-timer-eligibility** (closed): State-derived timer gating fails exactly like the schedule-derived parent. Across 3 seeds x 54k runs (162k total), 'stale' eligibility left every rung flat-to-negative: depth>=4 -0.0034 (ratio 0.93, the sequential reject trigger), depth>=5 +0.000026 (noise), depth>=6/7/8 identically 0, violations 0. Hazard rates moved <0.004 (h1 -0.0040, h2 -0.0027, h3 +0.0008) and unpaired fraction stayed pinned at ~0.497, i.e. the predicate barely changed which queue got picked — and where it did, it cost interleavings rather than buying depth. maxPrefixDepth capped at 5 in all three seeds, same as baseline. This falsifies the hypothesis on its own stated criterion, and more importantly it separates the two candidate explanations for the parent's failure: the problem was never that the exclusivity trigger was arbitrary (a counter), because replacing it with a node-visible staleness predicate reproduces the same null. Timer-vs-message priority is simply not the bottleneck for prefix depth in this config — the ladder is limited before any timer-ordering decision matters. The whole timer_exclusive family (schedule-derived and state-derived alike) is now closed; +1 config param bought nothing. Cheap fixed-cost lesson: any future 'which queue to prefer' knob should be pre-screened by checking whether unpairedFraction/h-rates move at all before spending 3 full sequential chunks.

## 2026-08-25T10:56:01.452Z

### Audit @40
Total accounted wall time is ~1735s/iteration. evaluate = 1177s (67.8%) and implement = 445s (25.6%) consume 93.4%; propose+build+reflect+rejudge together are 6.6%, and propose is effectively free (0.5ms). The evaluate concentration is the standout waste: at the measured 262 runs/sec, a full sequential test at the stated cap (1000 runs/config x 4 chunks x 2 arms = 8000 runs) is ~30s of simulator compute, yet evaluate burns ~1177s. Even accounting for the config sweep (3 servers x 3 write x 3 read x 3 crash x 2 dep-density = 162 configs x 100 runs = 16.2k runs ~ 62s), 90%+ of evaluate wall time is orchestration/serialization/grading overhead, not simulation. The loop has spent iterations 25-39 doubling runsPerSec (142.4 -> 262.1, +84%) while the phase that dominates wall time is not simulator-bound at all — the perf work optimized the wrong 5%. Secondary waste: iterations 26 and 27 terminated after implement only (95s, 110s, no evaluate) — 2/15 recent iterations produced no measurement at all. Implement at 445s/iteration against a 12% merge rate (5 merged / 43 total, 15 closed) means ~6300s of implement time has been spent on hypotheses that were subsequently closed.

Goodhart: Merge set is 100% non-behavioral: of 5 merges, timeline-feedback-regression-triage (enabling), reduce-explorer-memory-footprint (perf), novelty-key-ablation-sweep (ablate), and ablate-dead-randomly-drop-msgs (ablate) changed no depth metric. Zero merged hypotheses have moved the exploration-quality metrics; the loop is converting effort into throughput and code deletion, both of which are locally scorable, instead of into deeper prefixes.; runsPerSec has become a de-facto objective: +84% (142.4 -> 261.9) while meanPrefixDepth moved 2.26 -> 2.32 and P(depth>=4) 0.034 -> 0.051 (both attributable to earlier merges, both flat since). More runs at an unchanged per-run depth distribution does not improve bug-finding power for a fixed-n sequential test — the speedup only buys wall time that is not the bottleneck (evaluate is orchestration-bound).; Baseline already exceeds the reference on every depth row (meanPrefixDepth 2.32 vs 2.26, P(d>=4) 0.051 vs 0.034, P(d>=5) 0.004 vs 0.002) while violations stays 0 in all three columns. The ground-truth objective — finding violations — has been 0/0/0 for the entire run, so every decision is being made on surrogate depth statistics with no anchor to whether deeper prefixes actually find bugs.; The grader hypothesis that would have fixed the underpowered primary metric (primary-objective-swap-to-low-variance-depth-statistic, gain 7 / cost 1.5) was CLOSED, as was gate-two-sigma-tolerance-and-null-diff-regression-test (gain 8 / cost 2) and meta-noise-floor-screen-gate (gain 7 / cost 2). Three high-gain, low-cost measurement-integrity hypotheses were retired while the loop continued to gate on a 0.004-rate event — the cheapest path to 'progress' was to keep the weak metric rather than fix it.; Ablation hypotheses are being used as safe merges. Two of five merges are ablations that by construction cannot regress much; ablating dead code and reporting the resulting ladder row as a metric column manufactures the appearance of a measured change where none exists.; Hypothesis-pool churn without conclusion: 43 hypotheses, 15 closed, 10 parked, 1 blocked, 1 inconclusive, 1 needs_human, 12 proposed — 39/43 (91%) are in a non-merged state, and the parked pile is dominated by one theme (purgatory: 4 entries; orphan/purgatory family: 6) that has been re-proposed under new names repeatedly without a decisive measurement.

Utilization: dedup=unexercised, aos=unexercised, steer=unrewarding, feedback (timeline)=unrewarding, purgatory=unrewarding, explorer state representation (imbl/Arc persistent structures)=unrewarding, hazard instrumentation (h1/h2/h2b/h3)=scaffolding, violations detector=healthy

Policy suggestions: Halt new 'add' hypotheses for the next 3 iterations. Spend them on measurement integrity in this order: (1) null-ablation-noise-band (cost 2) to get an empirical A/A distribution for every ladder row at both screen (n=1000) and promote (n=4000) fidelity; (2) re-open primary-objective-swap-to-low-variance-depth-statistic (cost 1.5) and switch the primary to meanPrefixDepth or an area-under-depth-CDF statistic; (3) re-open gate-two-sigma-tolerance-and-null-diff-regression-test (cost 2). Total cost 5.5 against 12 queued proposals whose measurements are currently uninterpretable.; Demote P(depth>=5) from any accept/reject role immediately. At 0.004 with 4 expected events per screen arm it cannot support a decision; keep it as a reported diagnostic only. Delete P(depth>=6/7/8) from the ladder — three rows that have been identically 0.000 for the entire run — and replace them with a single maxPrefixDepth-observed counter, then run depth-ceiling-diagnosis (gain 8, cost 2) to find out whether depth 5 is a hard structural cap of VR at 3 servers, because if it is, the whole depth ladder is capped and no scheduler change can move it.; Resume orphan-hold-bounded-retry now. It is at P(better)=0.990 on d>=5 and 0.893 on d>=4 after 10800 runs with 0 of 2 allowed resumes consumed and 5 iterations idle. It is the only hypothesis on the board with a posterior above the 0.9 inconclusive threshold; finishing it costs one chunk versus the 445s+1177s of a fresh hypothesis with unknown prior.; Attack evaluate, not the simulator. Instrument evaluate to report gradedRuns/second end-to-end. At 262 runs/sec the configured sweep is ~60s of simulation inside a 1177s phase — find and fix the ~95% overhead (serialization, per-config process spawn, artifact I/O) before accepting another perf hypothesis. Cap evaluate wall time per hypothesis and fail loudly on overrun rather than absorbing it silently.; Introduce a utilization floor gate: any mechanism whose behavioral-effect counter is below 1% of its evaluation counter, or is exactly zero, must be either removed, disabled in the eval config, or re-tuned before any dependent hypothesis is scheduled. This immediately triggers on steer (0.139% divergence over 2.2M evaluations), dedup (all-zero), aos (all-zero), and cfg_score_sum (exactly 0.0). Promote steer-utilization-telemetry (cost 1) out of 'proposed' as the enabling step.; Freeze the purgatory/orphan family except the already-running resume. ~294k delayed sends have produced zero metric movement across 6 hypotheses (2 closed, 3 parked, 1 proposed at cost 7). Require a positive result from the resumed orphan-hold before purgatory-recovery-correlated-delay (cost 7) or parameter-free-purgatory (cost 3) may be scheduled.; Change the merge criterion so that a null-effect ablation cannot occupy a ladder column. Ablations that remove dead code should merge under a 'no-regression within measured noise band' label with the ladder explicitly annotated 'no effect'; reporting 0.051 -> 0.049 (a 1-sigma move at n=10800) in the same table as reference-vs-baseline invites reading noise as progress.; Escalate the two open needs_human PRs (spur#8, turnpike#12). lint-ignore-smoke-artifacts is gain 5 / cost 0.5 and is 'blocked' behind them — the highest gain-to-cost ratio on the entire board (10:1) is stalled on human review, while the loop spends 445s/iteration implementing cost-3-to-8 items.; Add an iteration-abort counter and alert. Iterations 26 and 27 ended after implement with no evaluate (95s and 110s), i.e. 13% of the last 15 iterations produced no measurement; these currently show up as ordinary rows and are invisible in the ledger.; Re-derive the objective from ground truth at least once: violations has been 0 across reference, baseline, and every merge. Either inject a known-buggy spec variant to confirm that higher meanPrefixDepth actually raises violation-detection rate, or stop treating depth as a proxy for bug-finding. Without that link, every gain/cost estimate in the pool is unvalidated.

## 2026-08-25T11:20:32.768Z

**depth-ceiling-diagnosis** (needs_human): The instrumentation run reproduced the ceiling exactly rather than explaining it: two sequential seeds (54k runs each) again both hit maxPrefixDepth=5, with depthAtLeast tails [54000,47417,20824,2784,224] and [53999,47454,20998,2641,236] — i.e. ~0.4% of runs reach depth 4 and depth 5 is the terminal rung, never 6. Objective deltas were noise-level (primary +3.7e-4, depth>=6/7/8 exactly 0, violations 0), confirming the diagnostic was behavior-neutral as intended. The decisive fact is the shape of the tail: it decays smoothly by roughly an order of magnitude per rung (54000 -> 47417 -> 20824 -> 2784 -> 224), which is a search-difficulty gradient, not a hard structural cap. Extrapolating the ~1/10 per-rung attrition, depth 6 would be expected at ~20 runs and depth 7 at ~2 per 54k — so the observed 'identically zero' depth>=6 is fully consistent with sample starvation at 54k runs, and maxPrefixDepth=5 is simply the max order statistic of a heavy-decay distribution, stable across seeds precisely because it is an extreme-value quantity. The hypothesis's structural-cap premise is therefore effectively falsified, but weakly: the run touched curriculum.rs/path.rs/plan.rs/util_stats.rs and no termination-cause histogram surfaced in the reported metrics, so the instrumentation did not actually deliver its payload — the conclusion rests on the depth histogram alone. Immediate consequence for the pool: depth>=6/7/8 are near-unmeasurable at current run counts and every add-arm scored on them is being graded on a rung with expected count ~0, so those sub-objectives are not saturated, they are underpowered. Scoring should key on the depth>=4/>=5 mass (which does move and has resolution ~1e-4) or on mean/quantile prefix depth, not on binary depth>=6 indicators.

## 2026-08-25T12:20:00.000Z

**step-budget-matches-oracle-regime** (closed, operator): The depth-ceiling diagnosis found that 72.6% of general-config runs stop at max_iterations=6000 with plan events outstanding, worst among multi-recovery runs (91.9%). Raising the budget to the oracle regime (10000) was measured over two clean 54k-run chunks: depth>=4 ratio 0.98, depth>=5 ratio 1.03, both flat. The truncated runs are quiescent (explorer logs: 37851 "stalled for 500 iterations, ready [], blocked []" warnings in one session, mean completed length 463 steps, max 4671); letting them run to the cap adds no depth. Truncation is not the cause of the depth ceiling. The step-cap experiment also strains the toolchain: 10000-step sessions overrun the chunk wall (1 of 4 wall-killed) and the checker failed on the oversized corpus. Successor: **end-run-at-plan-stall** — end a run at the first confirmed stall instead of spinning to the cap, which reclaims that time as more runs without changing depth.

## 2026-08-25T13:41:01.827Z

**null-ablation-noise-band** (needs_human): A/A null ablation (identical spurCommit bcf1979/superCommit db6ebe5, same general_vr.json + VR.spur, seeds 1000/1001, 54k runs each) returns NON-zero objectiveDeltas: depth>=4 -3.80e-4, h2 -5.46e-4, depth>=5 = primary -8.80e-5; violations/depth>=6..8/params exactly 0. So the noise floor is strictly positive and the parent ablation's ~1e-4 delta is indistinguishable from re-phased RNG, as hypothesized (not falsified). Two sharper facts: (a) the raw per-seed metrics move an order of magnitude more than the aggregated objective deltas — depthAtLeast[2] 20754 vs 20947 (3.6e-3 of runs, ~0.9% rel), depthAtLeast[3] 2769 vs 2583 (3.4e-3 of runs, ~7% rel), depthAtLeast[4] 208 vs 203, h2Rate 0.40078 vs 0.39885 (1.9e-3), unpairedFraction 0.48547 vs 0.48838 (2.9e-3), and gradedRuns at depth>=1 is 54000 vs 53998 — i.e. even run-count is not seed-invariant; (b) the objective's h2/depth aggregates are therefore already smoothing/normalizing relative to the raw rates, so a floor must be measured on the exact quantity the gate compares, not on the metric names. Deep-tail bins are the noisiest in relative terms and the ones most hypotheses claim to move. Critically, n=2 runs gives one difference, not a variance: a '2-sigma band' cannot be estimated from this data — what we have is a single sample of |delta| in [0, 5.5e-4] for smooth metrics with evidence of ~3e-3 raw spread in tail bins. Violations stayed identically 0 across both, so the violations channel remains a clean 0-noise gate (at 54k runs on this spec, which finds none). Verdict needs_human (meta gate); the only artifact written was research/policy.json — no product code touched, harness reproducibility itself confirmed (runsPerSec 265.7 vs 260.2, wall ~205s explore + ~180s grade per seed, so an 8-seed sweep is ~50 min). Practical upshot: any closure resting on |delta| < ~1e-3 in depth/h2/primary is currently unjudgeable, and the pool's habit of reading 1e-4 deltas as signal is unsupported.

## 2026-08-25T14:41:40.084Z

**crash-boost-dose-sweep** (needs_human): The run did not produce the intended 12-cell dose-response table: only two sequential seeds (1000/1001, 54k runs each) landed, both statistically indistinguishable from baseline (primary delta -1.4e-5, depth>=4 -5.3e-4, depth>=5 -1.4e-5, depth>=6/7/8 exactly 0, h2 -6.9e-4, violations 0, params 12->12). Seed-to-seed spread on the same knobs is itself ~1e-3 (h1 .4993 vs .4980, h2 .4003 vs .3991, depth>=5 count 2741 vs 2595, ~5% relative), i.e. the noise floor is an order of magnitude above the effect the sweep was supposed to resolve — unpaired 3-seed cells could never have distinguished any cell from baseline. maxPrefixDepth stayed at 5 in both seeds with only ~0.4% of runs at depth>=5, so the send-anchored crash hook is not opening deeper prefixes at any dose reachable here. Combined with the three prior send-anchored variants closing at 0.0000/0.0002/0.0013, the family is confirmed inert on general_vr and the only recoverable value is the four config params. Meta/tooling verdict routed to needs_human as designed; regression and lint both passed, so removal is low-risk. Secondary observation for the harness: at ~260 runs/s with 181s of grading per 207s explore, grading dominates wall-clock, so any future dose matrix pays ~6.5 min/cell — a 12-cell x 3-seed sweep is ~4 hours, which is the real reason this design should not be re-attempted without paired-seed variance reduction.

## 2026-08-25T15:10:11.185Z

**novelty-authority-normalization** (closed): Online standardization of novelty vs. priority was implemented (spur-core/src/simulator/score_scale.rs, feedback.rs, scheduler.rs; general_vr.json param count unchanged 12->12, blend weight removed as promised) and evaluated to the sequential cap: 12 chunks / 648k runs, pGreater 0.997, never crossing the accept threshold -> closed inconclusive. The direction is consistently positive but the magnitude is an order of magnitude too small to matter: depth>=5 delta +8.3e-5 (194-245 runs out of 54k per seed), depth>=4 +1.3e-3, h1 +5.1e-3, h2 +2.7e-3, h3 +1.0e-3, violations 0, throughput ~251-255 runs/s (no regression), maxPrefixDepth pinned at exactly 5 in all four recorded seeds. Two structural readings. (1) The gain is concentrated in shallow strata (h1/h2/depth>=4) and vanishes at depth>=5, which is the signature of a term that reshuffles early picks but carries no information about what makes a prefix deepen -- scale was necessary but not sufficient. The iteration-38 audit diagnosed the novelty term as numerically invisible; fixing visibility converted ~0.14% divergence into a real but near-null ladder effect, so the binding constraint has moved from the term's *scale* to the term's *content*. (2) The screen criterion (decision_divergence_frac rising to double digits) was never measured at ladder fidelity -- it is absent from the recorded metrics -- so we cannot separate 'mechanism fired and didn't help' from 'mechanism fired weakly'. That instrumentation gap is the reason this hypothesis burned 648k runs to learn a null. Also flagged: regressionPassed=false despite lintPassed=true and zero violations; worth confirming this is a harness/threshold artifact and not a real breakage before reusing this branch's code. Practical rule for the feedback lane: no further hypothesis should propose reweighting or rescaling an existing feedback term; the lane's remaining leverage is in what the novelty key hashes over, and any such hypothesis must ship its divergence/credit instrumentation inside the ladder eval, not only at the screen.

## 2026-08-25T15:15:03.538Z

### Audit @50
Over the last 15 iterations (wall 07:36:12Z->14:41:42Z = 25530 s), 22202 s is attributed to phases: evaluate 14389 s (64.8% of attributed, 56.4% of wall), implement 6892 s (31.0%), regression 765 s (3.4%, 5 runs x ~153 s), build 78 s (0.35%), reflect 78 s (0.35%), propose ~0 s. 3328 s (13%) is unaccounted wall, essentially all in one gap between iter 35 end (07:55:12) and iter 36 start (08:39:42). Evaluation is the dominant cost and it is priced per chunk: 1 chunk = 54000 runs = 213 s explore, but observed evaluate phases are 648-3120 s, i.e. 3-15 chunk-equivalents, so grid/config overhead and multi-chunk sequential testing (not raw simulation) set the bill. The single largest consumer in the pool is novelty-authority-normalization: 8 chunks = 432000 runs (~1700 s explore, more with overhead) plus 1 resume, and it still returned inconclusive. Implement is the second sink at 31%, and it is leaky: iterations 41, 43, 45 burned 0.16 s / 5.003 s / 5.006 s and produced nothing (3 of 15 = 20% no-op iterations, the 5.00 s figures look like a hard fail-fast path that is being retried rather than diagnosed). Throughput headroom is not the binding constraint: runsPerSec is already 261 vs reference 142 (+83%), and the perf profile still shows ~33% of cycles in allocation/copy traffic (__memmove_avx512 21.4%, Arc::make_mut ~7.8% of that plus 2.0% chunk clone, _int_malloc 4.2%) versus only 6.1% in eval::eval, so even a large perf win would buy at most ~1.3x on a phase whose real cost is chunk count, not per-run speed.

Goodhart: The latest merged change (ablate-dead-randomly-drop-msgs) is statistically indistinguishable from baseline on every single ladder row - max |delta| is 0.002 on h1Rate (0.497->0.499) and 0.001 on P(depth>=4) (0.050->0.049, i.e. slightly worse) - yet it merged. With no measured A/A band, 'merged' currently means 'did not visibly break anything', not 'improved anything'.; Merge composition is hygiene, not science: of 5 merges, reduce-explorer-memory-footprint is perf, timeline-feedback-regression-triage is a test-suite fix, novelty-key-ablation-sweep and ablate-dead-randomly-drop-msgs are deletions. Zero merged changes are mechanisms that raised depth. The ladder's headline movement since reference is runsPerSec +83% (142.4->261.0), a cost metric, while meanPrefixDepth moved +2.7% (2.26->2.32). The loop is optimizing the cheapest-to-move number on the board.; runsPerSec is on the metric ladder at all. It is a throughput metric that trades directly against exploration depth - any change that ends runs earlier raises it and lowers depth - so it should be a budget accounting line, not a scored objective sitting next to the depth metrics.; P(depth>=6/7/8) and violations are permanently 0.000/0 across reference, baseline and latest merged. Keeping four dead rows on an eleven-row ladder inflates the apparent breadth of 'no regression' claims at zero evidentiary cost.; h1/h2/h2b/h3 rates have not moved outside +/-3% of reference across 50 iterations and 5 merges (h2bRate and h3Rate are actually below reference: 0.417->0.416 and 0.342->0.338). They are being reported as if they constrain anything; they are inert.; The crash-anchoring family has consumed at least 5 hypotheses (send-anchored-crash-points 8/3, delayed-send-anchored-crash 5/2, crash-recover-density-knob 6/4, orphan-hold-bounded-retry 6/8, state-conditioned-timer-eligibility 3/4) - all closed, none merged - and the pool still contains crash-boost-dose-sweep (needs_human), crash-recover-density-telemetry, and retire-send-anchored-crash-params. The proposer keeps resampling a branch that has been falsified ~5 times, and the residue is dead config surface (four crash_after_send_* params) that now needs its own retirement hypothesis.

Utilization: aos=unexercised, dedup=unexercised, steer=unrewarding, feedback (timeline)=unrewarding, purgatory=healthy, run termination / step budget=broken, curriculum=unexercised, timer queue / rotation window=scaffolding

Policy suggestions: Freeze all add/ablate hypotheses for one iteration and land the noise floor first. Run null-band-seed-sweep-n8 (7/2.5) and null-ablation-noise-band (6/2) as blocking work, then re-open gate-two-sigma-tolerance-and-null-diff-regression-test (currently closed). Until an A/A band exists, every accept/reject in this loop - including the ablate-dead-randomly-drop-msgs merge, whose largest delta was 0.002 - is uninterpretable. This is the highest-leverage 4 s of policy change available.; Demote P(depth>=5) from primary objective to a reported-only statistic and promote meanPrefixDepth (or an area-under-depth-CDF) to primary, i.e. reverse the closure of primary-objective-swap-to-low-variance-depth-statistic. The evidence is already in hand: at 432000 runs, d>=5 gave P(better)=0.632 while d>=4 on the identical data gave 0.998. Delete P(depth>=6), P(depth>=7), P(depth>=8) from the ladder - 216000+ runs put their 95% upper bound at ~1.4e-5, so they can never move at any realistic budget - and move violations to a pass/fail regression assertion rather than a scored row.; Move runsPerSec off the metric ladder and into the budget ledger. It is a cost metric that trades against depth (any early-termination change inflates it), and it is currently the only number on the board that has moved substantially since reference (+83%), which is exactly the Goodhart shape.; Promote paired-seed-delta-harness (6/3) to the next implement slot ahead of every 'add' hypothesis. Common random numbers is the standard fix for the loop's actual failure mode - 1e-3 effects drowning in cross-seed and cross-config variance - and it would have resolved novelty-authority-normalization in far fewer than 8 chunks. Pair it with a prospective power gate: no hypothesis may open a chunk unless a power calculation on the primary metric shows the target effect is detectable within 4 chunks; auto-close instead of resuming otherwise. Cap total runs per hypothesis at 216000 (4 chunks) - novelty-authority-normalization has already had 2x the baseline's own budget.; Treat the depth ceiling as a termination bug, not a search problem, and act on the depth-diag telemetry that is already sitting on disk: 72.6% iterations_exhausted, 100% of plan_complete runs exiting with pending work, one recovered-node bucket at exactly 100% of step budget with 0/193 completions. Re-open step-budget-matches-oracle-regime (gain 9, cost 0.5 - the best gain/cost ratio in the pool, and it was closed) and implement end-run-at-plan-stall (8/3). Any depth hypothesis proposed before this is diagnosed should be rejected at propose time.; Retire dead mechanisms rather than continuing to carry them. Delete or feature-gate aos and dedup (0 activations across all dumps) out of the config surface and the hot path; land retire-send-anchored-crash-params (3/0.8) to remove the four crash_after_send_* params; and either delete steer/timeline-feedback or accept the novelty-norm result as a decisive negative - 97x more divergent picks for zero resolvable depth gain - and stop spending 2.24M evaluations per chunk on a mechanism that acts 0.131% of the time. Add a propose-time rule: any hypothesis whose target mechanism reports zero activity in the latest utilization.json must be filed as 'enabling' with the enabling change scoped first.; Add a proposer taboo on the crash-anchoring family until depth-ceiling-diagnosis resolves. Five hypotheses in that family are closed with zero merges, and three more are still live in the pool; the bandit's explorationQuota=0.3 is re-funding a falsified branch. More generally, add a rule that closes any theme after 3 consecutive closures without a merge.; Fix the implement-phase fail-fast loop before adding capability. Iterations 41, 43 and 45 consumed 0.16 s / 5.003 s / 5.006 s and produced nothing (20% of the last 15 iterations); the identical ~5.00 s durations indicate a deterministic hard failure being silently retried. Log the failure reason and fail the iteration loudly rather than re-entering propose.; Unblock the 7 open needs_human PRs and 4 needs_human hypotheses before opening new work - three of them (null-ablation-noise-band, depth-ceiling-diagnosis, plan-score-sensitivity-audit) are precisely the diagnostics the rest of the pool depends on, so the loop is spending 65% of its wall clock on evaluations it has already admitted it cannot calibrate. Also raise lint-ignore-smoke-artifacts (5/0.5, 'blocked') - a 0.5-cost blocker sitting unresolved is pure friction.; Attack evaluate cost structurally, not with perf work. The profile shows ~33% of cycles in imbl/Arc copy traffic (__memmove 21.4%, make_mut ~7.8%, malloc 4.2%) versus 6.1% in eval, so a second perf push buys maybe 1.3x - but evaluate time is set by chunk count and the 54-cell config grid, not by runs/sec. Shrink the grid to the cells that actually produce depth variance (the by_recovered_nodes telemetry shows the three buckets behave completely differently: 0/193, 265/506, 31/381 plan_complete), which cuts both cost and the clustering that is destroying power.

## 2026-08-25T16:07:48.739Z

**parameter-free-purgatory** (closed): Self-calibrating purgatory did not preserve the tuned mechanism's effect: across 2 chunks / 108k runs (seeds 1000-1001) depth>=4 fell -0.00055 and depth>=5 -0.00044 (primary), i.e. at or just below the +-0.0009 noise floor — the pre-registered falsification condition — while h2 regressed hard (-0.0234, ratio 0.94) and h1 -0.0256, triggering sequential reject. Params unchanged (12 -> 12; old fields kept accepted), so the intended -2 tunable saving never materialized in the general config either. Confound: the change bundled two edits — (i) delay probability -> 1.0 (delay EVERY remote message, coin flip removed) and (ii) delay duration drawn from the in-run empirical dispatch-to-delivery latency distribution. Delaying every message plausibly makes delays a uniform shift rather than a reordering perturbation, which would explain the h2/h1 handoff-coverage loss with no depth gain; the empirical distribution is also self-referential (delays feed back into the latency samples that generate future delays), so it can drift toward the model's own steady state instead of the tail that produced interleavings. Practical lesson: parameter-elimination rewrites that also change the mechanism's *shape* cannot be attributed; and 'derive from observed data' fails when the observed data is downstream of the intervention.

## 2026-08-25T16:14:30.427Z

**ablate-timer-queue-entirely** (closed): Ablation falsified in the informative direction: timers are load-bearing, not inert. Zeroing timer_weight (1 chunk, 54k runs, seed 1000, VR) regressed every ladder rung — depth>=4 -0.0499, depth>=5 -0.0039, h1 -0.0284, h2 -0.0249 (h3 +0.0028, noise), pRegress 1.000, violations unchanged at 0. Combined with the two prior null additive arms (timer_exclusive, state-conditioned eligibility), the timer response curve is one-sided: removing timer events costs depth, but boosting their selection share buys nothing. Default weight 1.0 sits at or past the plateau knee, so the remaining headroom in this family is bounded below 1.0 in the down direction only — i.e. there is nothing to win, only something to lose. Ceiling on depth is elsewhere: maxPrefixDepth was 3 with mean 1.53 even in baseline-adjacent runs, so depth>=4/5 are tail events and no scheduler reweighting of an already-saturated event class will move them. Cheap byproduct: timer_weight is now a live continuous knob in queue_selector.rs (params 12->13), so any future weight question is a config edit, not a code change.

## 2026-08-25T16:18:32.646Z

### Audit @55
Summed over the 15 logged iterations (40-54) ~18,670 s of phase time: evaluate 12,223 s (65.5%), implement 5,366 s (28.7%), regression ~770 s (4.1%), rejudge 107 s, reflect 87 s, build 116 s, propose ~0 s. Ledger per-iteration means agree (evaluate 88 s/iter only because most iterations record 0; live evaluates cost 780-3,120 s each). Two-thirds of all compute goes to re-measuring a metric ladder that has not moved: meanPrefixDepth 2.32 for the last several merges, P(d>=4) 0.051->0.049, violations 0 throughout. The baseline alone holds 4 chunks = 216,000 runs, and it is re-held on essentially every promote, so a large fraction of the 12.2 ks is spent re-estimating an unchanged control. Meanwhile 4 of the last 15 iterations (41, 43, 45, 53 - 27%) terminated in <6 s with only a propose/implement stub and produced no measurement at all: loop-turn overhead with zero information yield. Secondary waste: 9 open needs_human PRs and 5 needs_human hypotheses accumulating faster than they are consumed, and 15 proposed vs 5 merged over 55 iterations (~9% merge rate, 20 closed).

Goodhart: runsPerSec is 1.84x the reference (262.1 vs 142.4) while every depth statistic is flat and violations stay 0 - throughput is being optimized because it is the only high-power metric, and it is directly gameable in the wrong direction (shorter/cheaper runs raise runs/sec and lower prefix depth simultaneously).; Three of eight ladder objectives (P(d>=6/7/8)) are identically 0.000 in reference, baseline, and latest. A dead objective is a free pass: every candidate scores 'no regression' on 37.5% of the ladder by doing nothing.; The terminal objective, violations, is 0 in all columns. The loop has spent 55 iterations optimizing surrogate depth/hazard proxies with no ground-truth signal that deeper prefixes find more bugs; there is no seeded-bug canary to validate the proxy.; Hazard rates h1/h2/h2b/h3 are frozen within 1-3% of reference across every column (0.489/0.388/0.417/0.342 -> 0.499/0.400/0.416/0.338). They are saturated pass-through gates, not discriminators, yet they occupy 4 ladder rows and consume the same 54k runs to estimate.; Current baseline 'beats' the 000 reference on meanPrefixDepth (2.32 vs 2.26) and P(d>=4) (0.051 vs 0.034) while producing an identical zero tail - a ladder shift with no change in the phenomenon it is supposed to proxy, suggesting the reference column is not configuration-comparable (e.g. different step budget) and should not be used as a target.; Merge criterion drift: ablate-dead-randomly-drop-msgs was merged on deltas of 1.4-1.5 sigma. If the accept rule is 'no visible regression' on an uncalibrated band, the expected outcome is a slow random walk that reads as progress.

Utilization: aos=unexercised, dedup=unexercised, steer=unrewarding, feedback (timeline scoring)=unrewarding, purgatory=healthy, explorer memory path (imbl/Arc clone traffic)=scaffolding

Policy suggestions: Freeze all perf-kind hypotheses and demote runsPerSec from the metric ladder to a budget constraint (e.g. 'must stay >150/s'). It is already 1.84x reference, it is the highest-power and least-relevant number on the board, and it creates a direct incentive to shorten runs.; Block every add/ablate hypothesis until the measurement layer lands: run paired-seed-delta-harness (7/3.5) and null-band-seed-sweep-n8 (8/2.5) next, in that order. Merges are currently being made at 1.4-1.5 sigma; without a paired/CRN estimator and an empirical A/A band the loop cannot distinguish a real 1e-3 effect from drift, and the last 20 closed hypotheses were graded against that unknown band.; Retire the zero-information objectives: delete P(d>=6), P(d>=7), P(d>=8) (0/54,000, 95% UB 5.5e-5) and replace them with one continuous tail statistic - area-under-the-depth-CDF or mean of the top-decile prefix depth - per depth-tail-power-analysis (8/2). Also collapse h1/h2/h2b/h3 into a single conjunction metric or move them to regression-only, since all four have been frozen within 3% for 55 iterations.; Deduplicate the noise-floor cluster. null-ablation-noise-band, null-band-seed-sweep-n8, raise-runs-until-band-shrinks, meta-noise-floor-screen-gate (closed), and paired-seed-delta-harness all answer the same question; likewise depth-ceiling-diagnosis and prefix-depth-ceiling-diagnostic. Keep one of each, close the rest, and add a proposer rule that rejects a hypothesis whose question is already in flight.; Force a decision on aos and dedup within one iteration: either land an enabling config change that produces non-zero counters in the measured grid, or delete the mechanisms. Zero activity over 55 iterations means they are pure maintenance and audit tax, and they silently invalidate any hypothesis that 'builds on' them.; Schedule an ablation of steer in the eval config (0.141% divergent picks over 2.2M evaluations). Run it under the new paired-seed harness so a null result is interpretable; if null, remove steer from general_vr.json and the hot path rather than continuing to refine it (steer-depth-gated).; Add a ground-truth canary: since violations = 0 in every column, run a spec variant with a seeded, known-reachable bug alongside VR.spur and report time-to-first-violation. Without it there is no evidence that prefix depth is a valid proxy, and the entire ladder is unfalsifiable.; Cut evaluate cost structurally: cache/reuse the 4-chunk baseline across iterations instead of re-holding it (it has been identical for multiple merges), and gate the promote fidelity behind a screen that must clear the empirical A/A band. This targets the 65.5% of phase time currently spent re-measuring an unchanged control.; Cap the needs_human queue at 3 open PRs and stop opening new ones while over cap; 9 PRs plus 5 needs_human hypotheses are outstanding and the loop is producing them faster than they are being retired.; Add a proposer/loop guard that treats an iteration ending in <60 s with no evaluate phase as a failure to be logged and diagnosed - 4 of the last 15 iterations (27%) were such no-ops.

## 2026-08-25T16:54:02.378Z

**purgatory-tunable-sensitivity-sweep** (needs_human): The sweep was never actually executed as designed: the eval harness pins configPath to scheduler_configs/loop/general_vr.json, so the two variant configs written by the run (general_vr_purgatory_mid.json, general_vr_purgatory_long.json — neither of which survives in the working tree) were graded by nobody. Both sequential evals (seeds 1000/1001) are therefore plain baseline replicates of the merged purgatory setting (delay_probability=0.15, delay_duration_range=[5,100]), and the reported deltas (depth>=4 -0.00064, depth>=5 -0.00007, h2 -0.00008, params 0, 0 violations) are noise, not a response surface. The runs are still worth one thing: a noise floor. Seed 1000 vs 1001 at 54k runs each gives depth>=4 0.05056 vs 0.04804 (spread 0.0025), depth>=5 0.00365 vs 0.00400 (0.00035), h1 0.5005/0.4975, h2 0.4012/0.3994, h3 0.3341/0.3377 (~0.003), meanPrefixDepth 2.3169/2.3189, maxPrefixDepth 5 in both. So single-chunk seed noise on the primary ladder metric is ~±0.0025 on depth>=4 and ~±0.003 on h-rates; purgatory's merged +0.015 on depth>=4 is ~6x that, i.e. genuinely real, but any future grid point must beat ~0.005 to be readable from one chunk — a 5x4 grid at one chunk each would have been mostly unresolvable even if it had run. Meta conclusion: config-space sweeps are not expressible in the current harness; a sweep must either be split into one-point-per-hypothesis in-place edits of general_vr.json, or the harness must gain a config-override/sweep input first. Nothing was learned about whether the purgatory surface is flat or peaked, and no parameter-count change is justified either way (12 -> 12).

## 2026-08-26T06:24:14.077Z

**novelty-key-on-interleaving-signature** (closed): Re-keying novelty from per-decision local state to a cross-node delivery-order (interleaving) signature produced no separable effect: 2 seeds x 54k runs, all objective deltas <=0 and within noise (depth>=4 -7.4e-4, depth>=5 -1.4e-4, h1 -1.6e-3, violations 0, params flat). pMei separability 0.000 at d4 / 0.004 at d5 -> no frontier rung reachable, closed at chunk 2. Combined with 046 (which removed the scale excuse and still moved only h1), this is now the second independent failure of the *content* side of the novelty term. The natural reading: the deep tail is not gated by what novelty measures at all. Both seeds cap at maxPrefixDepth=5 with depth>=5 ~0.38% and depth>=4 ~4.8%, essentially baseline; a myopic per-decision bonus -- whatever it hashes over -- gets averaged away over the ~2.3 mean-depth prefix before it can compound into a depth-5+ prefix. Two consequences: (a) further variants of novelty keying are low-value and should not be enqueued; (b) the untested alternative is committing to deep prefixes across runs (replay/pinning) rather than scoring decisions within a run, plus a cheap check that maxPrefixDepth=5 is not a structural ceiling of the spec/grader, which would make the whole d>=5 rung unwinnable regardless of scheduler.

## 2026-08-26T09:39:16.055Z

**orphan-hold-bounded-retry** (closed): Real implementation, real runs: 3 sequential chunks / 162k graded runs at orphan_hold_probability=0.15 with a 50-step hold bound and client-response exemption produced a flat ladder — depth>=4 +0.0014, depth>=5 -0.00008, depth>=6 -0.00026, depth>=7 -0.00012, violations 0/0. Sequential eval rejected: no frontier rung can separate even at generous MEIs (pMei d4 0.049@+1%, d5 0.014@+2%, d6 0.002@+6%). Depth histograms across seeds 1000-1002 are statistically indistinguishable from baseline (meanPrefixDepth 3.022-3.023, maxPrefixDepth 8, tail counts 707-752 at d6). h1/h2/h3 rates unmoved (0.492-0.498 / 0.399-0.404 / 0.336-0.338), so the hold is not even shifting which hazards fire, let alone stacking them. This closes the board's highest-posterior item and retroactively explains it: the 0.990 P(better) on depth>=5 came from a stale unrebased branch, i.e. it was a harness artifact, not evidence — the mechanism had never actually run. Mechanism-level conclusion, and the transferable part: perturbing *delivery timing* of dead-incarnation messages is invisible to a protocol that guards on view/epoch numbers. VR discards a released orphan on the view-number check before it can touch state, so the injected hazard is absorbed at the receive guard and never becomes a scheduling choice-point the depth grader can see. The 'delivered-after-sender-recovered' counter was specified but no such signal surfaced in the reported metrics, so we could not distinguish 'holds never happened' from 'holds happened and were silently dropped by the guard' — a monitoring gap that should be closed before any further timing-perturbation work. Corollary for the pool: hypotheses whose only lever is when a message arrives (delay, hold, reorder, purgatory) are low-yield against epoch-guarded protocols; the lever has to make the receiver *accept and act on* the stale message. Cost: ~7 min explore + ~3 min grade per 54k chunk, ~20 min total compute for a clean negative. Config param count unchanged (12 before/after), so the two new fields did not enter the tuned general surface.

## 2026-08-26T10:22:56.399Z

**crash-recover-density-telemetry** (auto_merge): The enabling experiment merged as non-inferior but produced none of the information it existed to produce. Both sequential evals (seeds 1002/1003, 54k runs each) emit the same metrics schema as before — runs/h1Rate/h2Rate/h2bRate/h3Rate/meanPrefixDepth/depthAtLeast — with zero crash, recover, drop, or crossing-delivery fields. So the crossing-density number that both incarnation-timeline-tuples and crash-recover-density-knob hinged on is still unmeasured; the branch was neither killed nor calibrated. Three secondary facts. (1) Cost was not free: generalConfigParams went 12->13, directly contradicting the hypothesis's own 'gate behind an existing stats/verbosity flag' constraint, so we paid a generality tax for nothing. (2) The diff touched core/scheduler.rs and path.rs, not just util_stats.rs — a change advertised as pure measurement reached into the scheduler's hot path, which is why the objective moved at all. (3) The movement is noise: every depth delta is |d| < 0.0015 (depth>=4 -0.0011, depth>=5 -0.0008, h2 +0.0013) on 54k runs, well inside seed-to-seed spread (h2Rate 0.4019 vs 0.4007 across the two seeds alone), and violations stayed 0. Process lesson worth more than the result: a measurement hypothesis must specify the *sink* (which JSON field in the eval metrics blob) and not just the *source* (the counters in util_stats), and it should be validated by a short smoke run whose output is inspected for the new field before any 54k-run eval is spent. Parking at sequential in iteration 62 meant no one checked that the counters reached the surface.

## 2026-08-26T10:44:01.766Z

**stale-accept-window-bias** (closed): Biasing the release of orphaned messages ahead of guard-bumping events did not buy depth and cost h2: primary (depth>=5) moved +0.00088 while h2Rate fell 0.365 vs baseline (ratio 0.91, delta -0.035) and h3 dropped -0.0024, so sequential rejected after one 54k-run chunk. Two readings, not separable from this data: (a) the reorder does land stale messages inside the accept window but the resulting states are shallow/redundant, and (b) the reorder steals scheduling mass from the interleavings that were producing h2, i.e. the bias is a zero-sum reallocation rather than new coverage. Notably the prerequisite guard-absorption-counter gate ('do not evaluate unless acted_fraction is measurably above baseline') was never actually enforced — nothing in the metrics reports acted_fraction, so we still do not know whether the biased messages were acted on. That instrumentation gap is the real blocker: this family has now produced two negative results (orphan-hold-bounded-retry, stale-accept-window-bias) without ever measuring whether the injected hazard was observed. Also confirmed: a scheduler-side reorder at probability 0.2 is enough to visibly perturb h2, so the knob has real authority - the problem is direction, not magnitude. Do not spend further budget on orphan/stale-message scheduling variants until acted_fraction exists and shows the hazard is being consumed.

## 2026-08-26T10:51:25.732Z

### Audit @75
Total tracked wall ~1468.9 s/iteration. Implement 674.8 s (45.9%), evaluate 413.8 s (28.2%), rejudge 285.3 s (19.4%), reflect 94.8 s (6.5%), build 0.25 s (0.02%), propose ~0. Only 28% of the loop's time produces experimental evidence; 72% is LLM token generation (implement model/think alone is 439 s = 65% of implement, i.e. 30% of the whole iteration). Rejudge at 285 s/iteration is the second-largest LLM sink and yields zero new data — it re-scores hypotheses that were already scored. Implement churn is high-variance and high-volume: 26.3 edits and 2.8 cargo builds per iteration, with 49 s of test and 55 s of build inside implement. Recent wall-clock is worse than the ledger suggests: iterations 61-62 alone burned ~10.3 h (61: 5.6 h in implement; 62: 4.6 h idle/queued before a 444 s evaluate), and iterations 69 and 74 have no finish timestamp at all — dangling/aborted iterations are not being accounted against the 20 wall-h/day budget. Evaluate cost is dominated by chunk size: 1 chunk = 54000 runs = 218 s explore, baseline holds 4 chunks; a full 4-chunk hypothesis is ~872 s of explore plus grid overhead (observed evaluates 444-2479 s, 5.6x spread, indicating the chunk cap is being hit routinely).

Goodhart: violations = 0 in reference, in the current baseline, and in every one of the 7 merges, across 75 iterations and roughly 4M+ simulated runs. The terminal objective has never once moved; 100% of measured progress is on a proxy depth ladder that has no demonstrated link to violation discovery. There is no positive control proving the grader can report a violation at all.; Prefix depth is inflated by runs that never finish their plan. termination.all: 771/1080 (71.4%) iterations_exhausted vs 309 (28.6%) plan_complete, pending_work_at_exit_sum 7948, planned_events_outstanding_sum 6509. The by_recovered_nodes=0 stratum is 193 runs at 1158000/1158000 steps (100% of budget) with plan_complete=0 — pure timeouts that still contribute depth samples. Depth conditioned on completed plans is not reported.; step-budget-matches-oracle-regime (closed, gain 9 / cost 0.5) raised the step budget, which mechanically raises reachable prefix depth without improving hazard exposure. Current steps_used/step_budget = 4.77M/6.48M = 73.6%, so the budget knob is still a live lever on the headline metric.; runsPerSec 142.4 -> 248.3 (+74%) while meanPrefixDepth rose 2.26 -> 3.02. Throughput and depth improving together while h1/h2/h2b/h3 hazard rates stayed flat within +-0.015 (h1 0.489->0.502, h3 0.342->0.337) is the signature of cheaper/shorter-per-event runs rather than richer executions.; Merge mix is instrumentation-heavy: of 7 merges, depth-ceiling-diagnosis (meta), crash-recover-density-telemetry (enabling), and novelty-key-ablation-sweep (ablate) produce no behavioral improvement. The loop is scoring itself on merges while merging things that cannot move the objective. The pool has independently noticed this — telemetry-param-neutrality-gate (proposed, 3/0.7) exists specifically to reject tooling hypotheses that grow config params.; primary-objective-swap-to-low-variance-depth-statistic (grader, gain 7 / cost 1.5) is an explicit proposal to replace the hard objective with an easier-to-move one. It was correctly closed, but depth-tail-power-analysis (8/2, closed) and joint-hazard-objective (5/3, proposed) keep the scoreboard-rewrite pressure alive; three of the last several grader-kind hypotheses target the measuring stick rather than the system.; crash-recover-density-telemetry was merged and crash-recover-crossing-metric-sink ('finish the telemetry: land crossing counters in the eval metrics') is still only proposed. The merged telemetry currently feeds no gate, so it has produced exactly zero decision value while counting as a merge.

Utilization: aos=unexercised, dedup=unexercised, stale_accept=broken, feedback.cfg_score=broken, curriculum=unexercised, steer (feedback steering)=unrewarding, purgatory=healthy, crash_recovery=healthy, termination / deadlock detection=scaffolding, simulator state representation (imbl persistent vectors)=unrewarding

Policy suggestions: Halt all 'add' hypotheses until a positive control exists: deliberately inject a protocol-violating mutation into VR and confirm the grader reports violations > 0. After 75 iterations and millions of runs with violations pinned at 0, the loop cannot distinguish 'no bugs found' from 'oracle cannot report bugs'. This is the highest-value single experiment available and costs one iteration.; Promote paired-seed-delta-harness (proposed, 7/4) to the next implement slot and make common-random-numbers pairing mandatory for every gate decision. The accidental A/A from crash-recover-density-telemetry shows unpaired deltas of 0.001-0.002 on the tail metrics are indistinguishable from noise, which is the entire remaining signal range.; Retire P(depth>=8) as an objective immediately (0.000 observed in reference, baseline, and all merges — zero events, infinite required N) and demote P(depth>=7) to reporting-only. Institute a rule: an objective must yield >= ~100 expected events per chunk (p >= ~0.002 at 54000 runs) to be gate-eligible; otherwise it is descriptive.; Report depth metrics conditioned on plan_complete separately from all-run depth. With 71.4% of runs ending by iterations_exhausted and 6509 planned events never executed, the headline meanPrefixDepth/P(d>=k) are contaminated by timeouts, and the step-budget knob is a direct, uncontrolled lever on them.; Rebalance the phase budget toward evidence: cut implement turns from 80 to ~40 and cap rejudge (currently 285 s/iteration = 19% of wall for zero new data — batch it to once every 5 iterations, aligned with the audit cadence). Redirect the recovered ~500 s/iteration into additional sequential chunks, which is what the deltas actually need.; Instrument and enforce iteration completion. Iterations 69 and 74 have no finish timestamp and 61-62 consumed ~10.3 h between them (61: 5.6 h in implement alone). Add a hard per-phase kill at the stated 90 wall-min/hypothesis and record aborted iterations in the ledger, or the daily 20 wall-h budget is unenforced.; Delete or explicitly disable the dead mechanisms rather than carrying them: aos, dedup, curriculum, and feedback.cfg_score are all exactly zero under the evaluation config. Unblock retire-send-anchored-crash-params (blocked, gain 6 / cost 0.8) — it is the best gain/cost item in the pool and it is dead-code removal, which cannot regress a metric.; Block stale-accept-window-bias (6/7) until stale_accept.windows_offered > 0 is demonstrated. Under the loop's own stated rule ('a change whose effect is confined to a zero-activity mechanism cannot be measured'), it is currently the most expensive unmeasurable proposal in the pool; the correct predecessor is a cheap enabling fix that makes windows fire.; Force a decision on steer: at 3032/2232510 = 0.136% divergence it must either be given real authority (novelty-authority-normalization, 6/3.5) or ablated from the hot path. Run the ablation first — if removing 2.2M evaluations does not move the ladder outside the A/A band, delete it and take the throughput.; Spend one iteration on the imbl hot path (23.3% of CPU in memmove from Arc::make_mut / promote_front / push_back). A ~1.25x runsPerSec gain is a pure statistical-power win with zero metric-gaming risk, and it strictly dominates raise-runs-until-band-shrinks (parked, 5/3.5) as a way to shrink the noise band.; Treat 'enabling'/telemetry merges as non-neutral until proven otherwise: require every such change to pass an explicit A/A (same seeds, metrics unchanged within the published band) before merge. The last one shifted six metrics, which means RNG draw ordering is not isolated — make enabling-rng-stream-isolation (parked, 5/4.5) a prerequisite for further instrumentation.; Cap grader-kind hypotheses at one merge per 10 iterations. Three of the recent grader proposals (primary-objective-swap-to-low-variance-depth-statistic, depth-tail-power-analysis, joint-hazard-objective) modify the scoreboard; with violations flat at 0, scoreboard edits are the path of least resistance and the least evidential value.

## 2026-08-26T11:20:11.198Z

**acted-fraction-instrumentation** (needs_human): Behaviorally neutral, as designed: 2 seeds x 54k runs, 0 violations, all depth deltas within seed noise (primary -0.0002, depth>=4 +0.0013, h2 -0.0016), lint+regression green. Verdict needs_human purely for touching core/exec.rs (+scheduler.rs, state.rs, path.rs) — the instrumentation is now wired through the dispatch path at no measurable throughput cost (~251 runs/s, in-family with prior sequential runs). But the enabling goal was NOT met: the sequential eval metrics block still reports only runs/h1Rate/h2Rate/h2bRate/h3Rate/depthAtLeast — no acted_fraction, overall or biased-restricted. The counter exists in util_stats.rs; nothing carries it out of spur into the eval record, so the family gate ('was the injected hazard actually observed by the protocol?') remains unanswered and every downstream orphan/stale bias would still be an uncontrolled experiment. Net cost so far: +1 general config param (13->14) and a needs_human review on execution-semantics files, in exchange for a number no one can read. Do not resume the stale/orphan bias family until the metric is visible in the eval JSON; the cheap remaining work is pure plumbing (spur stats -> eval metrics serialization) and touches no execution-semantics file, so it should route to auto-accept.

## 2026-08-26T17:38:32.013Z

**receiver-side-orphan-hold** (closed): Pre-registered falsification fired cleanly. h2bRate with the flag on: 0.4186/0.4148/0.4173 across seeds 1000-1002 (162k runs) vs the 0.417 constant seen in the reference, baseline, and all seven merges — delta ~0.000, not the >=0.05 required. Primary (depth>=5) -0.00045, every rung inside the A/A band; sequential rejector stopped at 3 chunks with no frontier rung separable (pMei d4 0.003@+1%, d5 0.003@+2%, d6 0.018@+6%). Holding rather than dropping receiver-orphaned messages did not even inflate all-run depth, so the predicted timeout-artifact confound never materialized — the mechanism simply does not change the reachable interleaving set. This is the 6th purgatory/orphan-family attempt (orphan-hold-bounded-retry -0.0001, orphan-message-purgatory 0.0000, purgatory-release-on-state-change blocked, parameter-free-purgatory -0.0004, this one -0.0004) with zero merges and every delta within noise; the sender-side/receiver-side distinction was a relabeling, confirming the red-team read. Family is closed. The more informative residual: h2bRate is invariant to 0.417 under every scheduler intervention tried to date, which is now strong evidence it is not scheduler-controllable at all but fixed by the spec's reachable state space or by the grader's h2b predicate — that, not another delivery-policy tweak, is where the next probe belongs.

## 2026-08-26T18:03:12.394Z

**timer-weight-response-curve** (needs_human): Sweep did not actually sweep. Four variant configs (general_vr_timer_w025/050/200/400.json) were emitted, but both evaluation runs used configPath=scheduler_configs/loop/general_vr.json (seeds 1000/1001) — i.e. the harness only ever exercised the unmodified baseline, so no point on the response curve besides w=1.0 was measured. Consistent with that, every objective delta is inside the seed band: depth>=4 +0.0019, depth>=5 -0.0006, depth>=6/7/8 ~+1e-4 or less, h2 -0.0015, violations 0, params 13->13, regression+lint pass. Verdict needs_human only because kind=meta. Two conclusions: (1) the stated falsifier ('w in {2,4} moves depth>=4 by less than ~0.0025') was never testable by this run, so the plateau claim for 0<w!=1 remains unmeasured, not confirmed — do not record it as evidence; (2) a real tooling gap dominates the result: variant configs dropped under scheduler_configs/loop/ are inert because the eval driver pins configPath to general_vr.json, which silently converts every config-only sweep hypothesis into a null-delta no-op. Any future 'emit N configs and compare' hypothesis is unfalsifiable until the driver takes a per-variant configPath. Meanwhile the only demonstrated high-sensitivity signal in this family stays the w=0.0 full ablation (depth>=4 -0.0499), which is a whole-event-class removal effect, not a weight-magnitude effect — suggesting sensitivity lives in class presence/absence rather than in the continuous weight.

## 2026-08-26T22:15:00.000Z (operator)

leave-one-event-class-out-audit (iteration 5266) is being recorded by the
gate as `blocked: sequential evaluation failed`, and blocked hypotheses get
no reflect, so the result it actually produced would otherwise be lost. It is
a positive finding, not a harness failure.

The queue selector's event classes are load-bearing for progress. With one
class removed, no run reaches the end of its plan. From the hypothesis's own
utilization capture, 1,080 runs, taken before the sequential and completed
normally:

| | ablated | baseline (it5261) |
|---|---|---|
| plan_complete | 0 | 312 |
| iterations_exhausted | 1080 | 768 |
| deadlock | 0 | 0 |
| steps_used_sum | 6,480,000 | - |
| step_budget_sum | 6,480,000 | - |

Every run burned its entire step budget with work still outstanding
(pending_work_at_exit_sum 5957, planned_events_outstanding_sum 10629), and
none was classified as a deadlock. Runs do not hang; they fail to make
progress fast enough to finish, and the step budget cuts them off.

That explains the sequential failures without appealing to a harness bug.
Every run now costs the full 6000 steps instead of terminating early, so
traces are far larger and the session cannot finish 54,000 runs inside the
900s explore budget. The explorer is killed at the wall, leaving parquet
without footers. Three chunks failed identically at 931s.

The reason the gate recorded blames the wrong component: "3 chunks failed in
a row: porcupine produced no parseable JSON (exit 1)". Porcupine is fine. It
was handed a corpus whose parquet files have no footers because the process
writing them was killed, and it exits 1 rather than reporting an empty
corpus. Anyone grepping that message should look at the explorer's wall
budget and the log's runs=0, not at the checker.

Two things worth carrying forward. `plan_complete` is a cheap pre-screen for
this class of change: it resolves on the 1,080-run utilization session, which
runs before the sequential, and a value of 0 predicts the sequential will
burn its full budget and return nothing. And the ablation lane should treat
"removes a mechanism the simulator needs to make progress" as a distinct
outcome from "removes a mechanism nothing uses" - only the second is a
candidate for deletion.

## 2026-08-26T22:48:21.622Z

**per-channel-fifo-authority-probe** (closed): The probe ran to completion on two seeds (1000/1001, 54k runs each) and produced no ladder movement: violations 0, primary (depth>=5) -0.0006, depth>=4 +0.0010, h2 +0.0005 — all inside A/A noise, consistent with the counter being reporting-only. The iteration nonetheless closed as failed because the regression suite did not pass (lint did pass), and the config param count grew 14->15, so the instrumentation was not cost-free: adding channel_inversions touched exec.rs, scheduler.rs, state.rs, path.rs and util_stats.rs, i.e. the per-pair send-order bookkeeping required threading sequence identity through the delivery path rather than a local read. No recorded value of channel_inversions survived the failed run, so the actual question — is same-(sender,receiver) order pinned FIFO — remains formally unanswered by measurement, though the fact that a counter needed new state threaded through exec/state/path is weak evidence that send order is not currently retained anywhere at delivery time (i.e. the axis may well be free already, which would be the falsifier). Meta-lesson: a 'probe only, cost 2' framing underestimated cost because the observable did not exist as a derived quantity; probes should first check whether the predicate is computable from existing state before being priced as instrumentation-only.

## 2026-08-26T22:50:00.000Z (operator)

per-channel-fifo-authority-probe (iteration 5267) was closed by the gate on
"regression suite failed". The three correctness cases passed; only the
throughput case failed, and it failed for a reason that had nothing to do
with the hypothesis. Recording both the harness fault and the result the
probe actually produced, since a closed hypothesis keeps neither.

### Same-pair delivery order is a free variable

Measured over the probe's own 1,080-run utilization session:

| | |
|---|---|
| deliveries between node pairs | 1,061,985 |
| delivered out of send order | 118,010 (11.1%) |
| runs containing an inversion | 959 / 1080 (88.8%) |

The scheduler already reorders same-pair messages on 11% of deliveries, in
nearly nine runs out of ten. So reordering mechanisms are not inert because
the orderings are unreachable - the loop generates them in quantity. That
leaves absorption as the standing explanation, consistent with delayed
deliveries acting 13.8% of the time against 40.9% for ordinary ones. A
future reordering hypothesis has to argue it produces orderings that differ
from these, not merely that it produces inversions.

This was worth knowing before building anything, and it is the second probe
in a row whose value was in refusing a direction rather than opening one.

### The gate reason was wrong, and it was blocking everything

`runBench` runs the candidate binary and `tmp/loop/spur-baseline` against the
same materialized config. That baseline binary is a file copy, refreshed by
hand, and it was two merges old. The acted_fraction merge had added
`emit_acted_fraction` to `bench.json`, and the old binary rejects unknown
top-level keys under `strict_config_keys`, so its round produced 0 of 5400
runs and the bench failed.

The failure was not specific to this hypothesis. Every hypothesis evaluated
after that merge would have failed the same way, since the offending key sits
in the shared bench config. A stale baseline binary is therefore not a
degraded comparison; it is a total block on the perf lane that presents as a
per-hypothesis regression failure. Refreshing the copy cleared it.

## 2026-08-26T23:15:00.000Z (operator)

stale-delivery-expedite (iteration 5268) was the first hypothesis aimed at
the sender-side timing lever rather than the receiver-side volume one, and
the ladder rejected it after 2 chunks and 108,000 runs, no frontier rung
separable. What it does and does not establish is worth stating precisely,
because it is easy to read as a falsification of the lever and it is not one.

Its own absorption prescreen moved in the intended direction. Stale-sender
deliveries acted 17.88% before and 21.68% after, with every other bucket flat
or slightly down (all 41.10 -> 40.45, delayed 13.95 -> 13.73). But n is 1033
in that bucket, so the difference is about 43 events, roughly 1.5 sigma, and
the same bucket has read 15.79%, 15.87% and 17.88% across earlier sessions -
a session-to-session spread comparable to the effect.

The question that would settle it cannot be answered, because the hypothesis
added no counter for its own mechanism. There is no record of how many
deliveries it expedited. So "the mechanism worked and acting does not buy
depth" and "the mechanism barely fired" are both consistent with what was
recorded, and they call for opposite next steps.

The sender-side lever is therefore untested, not falsified. Do not cite this
iteration as evidence against it.

The general lesson is sharper than the specific one. Per-candidate
utilization capture exists to answer "did the mechanism fire", and it can
only do that when the mechanism increments something. The six purgatory
attempts were all diagnosable because purgatory.delayed_sends exists; this
one is not. A mechanism hypothesis that ships without a counter for its own
firing spends a full sequential sample and returns a result nobody can
interpret, which is worse than a negative.

## 2026-08-26T23:37:12.280Z

**probe-cost-precheck-rule** (needs_human): Null-diff run: only research/policy.json changed (spur a3f67ba, super aedc137 both carried forward), so the two sequential seeds (1000/1001, 54k runs each, general_vr/VR.spur) are a pure re-measurement of the same binary, not a test of the policy. That makes the run accidentally valuable as a noise-floor calibration: with identical code, seed-to-seed objective deltas were depth>=5 -1.18e-3, depth>=6 -1.05e-3, h2 -1.42e-3, depth>=4 +2.6e-4, violations 0, params 14->14, and runsPerSec drift ~0.11. Empirically, any future |Δ primary| below ~1.2e-3 on a two-seed sequential eval is indistinguishable from seed noise; several past accept/reject calls likely sat inside that band. The policy itself is untestable by this harness — verdict needs_human, regression+lint green, and its falsifier (a future probe actually repriced by the rule) can only fire at proposal time, over iterations, not in an evaluation. Meta-lesson compounding the parent's: kind=meta/policy hypotheses should not consume ~7 min/seed of explore budget at all; they should be recorded and applied without an eval, since the eval can only ever report noise. Cost of learning this: ~410s explore + 363s grading for zero information about the hypothesis.

## 2026-08-27T00:04:24.899Z

**enabling-rng-stream-isolation** (needs_human): Per-decision RNG substream derivation landed across 8 spur files (rng.rs added; scheduler/path/exec/state/explorer/curriculum touched) plus one new gating config param (14->15). Aggregate behavior is unchanged within noise: violations 0 on both seeds, primary (depth>=5) -6.1e-4, h2 +1.3e-3, depth>=4 +1.2e-3, all deltas 5e-6..1.3e-3 i.e. inside the ~2.5e-3 seed band; depth histogram shape and maxPrefixDepth=8 preserved; throughput +0.13 runs/s (~0.05%, free). So the refactor costs nothing and breaks nothing — but it also does not by itself deliver the thing it was proposed for. The evaluation harness only reports aggregate screen metrics over 2 seeds, so the stated falsifier (re-apply a known-null diff at fixed seed, assert bit-identical metrics) was NOT exercised; substream isolation remains an untested claim, and the one-time re-baselining it forces means every historical calibration entry is now off-stream. Verdict needs_human purely because execution-semantics files were touched, not because of any measured regression. Bottom line: infrastructure is in place, oracle is not; without a trace-hash assertion and a paired/common-random-numbers comparison protocol built on top, the 1e-4..1e-3 effects that motivated this still drown in seed variance.

## 2026-08-27T00:08:26.249Z

### Audit @5270
Per-iteration mean wall is ~1598 s, of which evaluate (773.8 s, 48%) and implement (487.1 s, 30%) are 78%. Regression (158.8 s) plus rejudge (131.3 s) add another 18% — i.e. nearly a fifth of the loop is spent re-checking and re-judging rather than producing new evidence. Propose is effectively free (0.0005 s mean) because the pool is pre-stocked, so there is no cost pressure keeping 30 parked + 8 proposed hypotheses alive. Inside implement, the breakdown is model/think 227 s vs edit 0 s, read 7 s, shell 1 s — 47% of implement is deliberation over a mean of 12.5 edits and 2.5 cargo builds, so the marginal cost of an iteration is dominated by thinking about small diffs. Recent iterations confirm the tail risk: 5266 spent 2792 s in evaluate alone (3.6x the mean) and 646 s implementing. Grader-proposal iterations (5259, 5262) burn a full iteration slot for ~3 s of work, and three consecutive 'empty pool' iterations (5255-5257) each consumed a slot for ~3 s. Cost per merged hypothesis is the real number: 9 merges out of 90 hypotheses at ~1600 s each implies roughly 16000 s of loop wall per merge, and the last merge (crash-anchor-utilization-precheck) moved no ladder metric outside noise.

Goodhart: runsPerSec climbed 229.2 -> 247.2 (+7.8%) in the latest merge while every quality metric stayed flat; throughput is the only ladder metric moving reliably, and it is the one metric that rewards doing less work per run (the perf profile shows 23% of time in memmove/Arc::make_mut from imbl persistent-vector clones, so throughput gains are allocator wins, not search wins).; meanPrefixDepth 3.02 vs reference 2.26 and P(d>=4) 0.354 vs 0.034 — the loop is 10x past the reference on the depth tail while violations stays pinned at 0. Depth is being maximized with no bug-finding payoff, which is the definition of a proxy detached from the goal.; violations = 0 in reference, baseline, and latest merged. The single ground-truth metric has never moved, so every accept/reject decision for thousands of iterations has been made on proxies alone.; h2bRate pinned at 0.415-0.417 across every scheduler variant; h2b-invariance-audit was opened to explain it and was closed without the ladder changing, so a known-invariant column is still carried as if it were a signal.; Merges are being scored on precheck/telemetry hypotheses (crash-anchor-utilization-precheck, acted-fraction-instrumentation) that cannot move the ladder by construction. Merge count rises (9) while the ladder does not — merge rate itself has become the gamed metric.; crash_anchor: offered 1969, crashes_taken 1907, but applied only 727 (38%). The counter that gets reported ('crashes') is 2.6x the counter that reflects an actual effect ('applied'), so crash injection looks 2.6x more effective than it is.; delivery_effects shows biased deliveries act at 0.139 vs 0.414 for all deliveries — the scheduler is preferentially injecting perturbations into deliveries that are 3x LESS likely to change state. Injection count goes up, causal effect goes down; guard-absorption-counter was opened on exactly this and closed.; termination: plan_complete = 311 and plan_complete_with_pending_work = 311 — every single 'complete' run exits with pending work. 'Completion' is nominal, and 769/1080 runs (71%) simply exhaust iterations.

Utilization: aos=unexercised, dedup=unexercised, curriculum=unexercised, randomly_delay_msgs=broken, crash_after_send_* anchors=unrewarding, steer (feedback/timeline)=unrewarding, purgatory=unrewarding, crash_recovery=healthy, receiver_restarted bias=unrewarding, rng_streams isolation=scaffolding, termination accounting=broken, deep-tail depth metrics (P(d>=7), P(d>=8))=broken

Policy suggestions: Measure the A/A band before judging anything else: run baseline-vs-baseline at 1, 2, and 4 chunks (unparking raise-runs-until-band-shrinks, gain 5 / cost 3.5) and publish per-metric separability thresholds. Predicted band is ~+/-0.006 on rate metrics, which would retroactively reclassify the entire last merge as noise.; Promote paired-seed-delta-harness (gain 8 / cost 5 — highest gain/cost in the pool, parked) to the front of the queue and flip rng_streams to isolated_runs>0 so common random numbers are possible. CRN typically cuts variance 3-10x on paired designs; without it the loop cannot resolve the 1e-3 effects it keeps proposing.; Unblock and execute the two cheapest deletions immediately: retire-send-anchored-crash-params (gain 6 / cost 0.8) and ablate-dead-randomly-delay-msgs-wiring (gain 3 / cost 1.5). Together they cost ~2.3 units against a 1600 s/iteration budget and remove config surface that every future hypothesis must reason around.; Run zero-utilization-mechanism-sweep-ablation (proposed, gain 6 / cost 2.5) as a single combined ablation of aos + dedup + curriculum + randomly_delay_msgs. All four read exact zero over 1080 runs; if removing them leaves the ladder inside the A/A band, delete them rather than continuing to carry enabling hypotheses for them.; Drop P(d>=7) and P(d>=8) from the accept/reject ladder and mark them reporting-only. P(d>=8) is identically 0.000 across all three columns and P(d>=7)=0.001 gives ~54 events per chunk; neither can support a decision.; Stop counting telemetry/precheck hypotheses as merges. Route kind=meta/enabling work that touches no scheduler mechanism through a separate lightweight track (policy-hypotheses-skip-evaluation, gain 3 / cost 0.5, parked) so the 773 s evaluate + 158 s regression is not spent confirming that a counter did not change behavior.; Change the injection objective from count to effect: gate crash/delay/restart biases on acted_fraction. Current numbers — biased 0.139, delayed 0.140, receiver_restarted 0.021 vs all-deliveries 0.414 — mean the scheduler is aiming perturbations at deliveries 3-20x less likely to matter. Land acted-fraction-metric-surfacing (parked, gain 3 / cost 2) so this is visible on the ladder, then re-tune.; Fix the crash_anchor reporting gap: report applied/offered (727/1969 = 37%) as the headline, not crashes_taken (1907). Run crash-anchor-acted-fraction-comparator (proposed, gain 4 / cost 3) to rank the four existing anchors and delete the bottom half.; Investigate the budget ceiling before adding any depth mechanism: 769/1080 runs (71%) exit on iterations_exhausted, and the 0-recovery bucket is 196/196 exhausted with steps_used == step_budget exactly. Depth may be capped by max_iterations=6000, not by scheduling — depth-ceiling-structural-diagnostic (parked, gain 6 / cost 5) answers this and would invalidate several queued 'add' hypotheses.; Impose a pool TTL and cap: 33 parked + 6 proposed = 39 open items against 9 merges in 5270 iterations. Auto-close anything parked more than N iterations without a promotion, and cap the pool at ~15, so propose stops being free and the queue reflects real priority.; Add an explicit no-op guard to the iteration accounting: iterations 5255-5257 ('empty pool', ~3 s each) and 5259/5262 (grader proposal queued, <0.1 s) consumed loop slots without work. Either batch grader proposals into the next real iteration or stop incrementing the counter for them, so iteration count remains a meaningful denominator.; Given meanPrefixDepth 3.02 vs reference 2.26 and P(d>=4) 0.354 vs 0.034 with violations stuck at 0 in all columns, re-anchor the objective on violations (or a bug-proxy correlated with it). The loop has 10x-overshot the reference on the depth proxy with zero movement on ground truth; continuing to optimize depth is optimizing a proxy that has demonstrably decoupled.

## 2026-08-27T00:15:00.000Z (operator) - assessment of the 5270 audit

This audit is better than the standing caveat about auditor misreads
suggests. It does not commit the classic error: aos, dedup and curriculum are
classified unexercised rather than broken, with the reason named (not enabled
in general_vr.json; the grid pins num_servers and num_crashes externally).
Weigh its recommendations on their merits.

Already satisfied, not open work:

- "Measure the A/A band before judging anything else." Measured and published
  the same evening. Identical explorer, 108,000 runs against the 216,000-run
  baseline: depth>=4 +0.07%, depth>=5 -1.44%, depth>=6 -7.50%, h2 -0.36%. The
  audit predicted ~+/-0.006 on rate metrics and that is about right for
  depth>=4; the frontier rungs are proportionally far worse.
- "Flip rng_streams to isolated_runs>0 so common random numbers are
  possible." enabling-rng-stream-isolation was reviewed and approved the same
  evening, with tests that pin the isolation property against a negative
  control. The audit reached the same conclusion independently, which is
  worth something.

Sound and accepted:

- Runs within a config share an RNG stream, so nominal binomial standard
  errors are optimistic and the effective n is below the nominal n. Every
  power calculation in the record understates the band.
- crash_anchor reports crashes 2.6x the applied count, so crash injection
  reads more effective than it is.
- Merge count is a gamed metric. Both merges of the evening were telemetry
  that cannot move the ladder by construction. The telemetry earned its place
  by producing the absorption asymmetry and the noise floor, but the criticism
  of merge count as a measure of progress is correct and should not be
  argued away.

Corrected before adoption:

- The audit reads biased deliveries acting at 0.139 against 0.414 as the
  scheduler preferentially perturbing inert deliveries. The numbers hold; the
  causal claim does not follow, because delaying a message may be what makes
  it inert. See GOAL.md for the discriminating measurement.

Deferred, worth doing:

- Skip ladder evaluation for hypotheses whose diff cannot reach the explorer.
  Two iterations this evening spent a full sequential plus regression, about
  930 s each, comparing a binary against itself. The lints now fail inert
  changes, but a legitimate policy change still gets an evaluation the ladder
  cannot interpret. policy-hypotheses-skip-evaluation is parked and cheap.
- The three zero-utilization deletions the audit lists are cheap and unblock
  config surface, but they are ablations and should run through the normal
  lane rather than as operator edits.

## 2026-08-27T00:30:00.073Z

**novelty-key-utilization-precheck** (needs_human): Instrumentation-only change (feedback.rs + util_stats.rs, +0 general config params) ran clean at both seeds: 54k runs each, 0 violations, regression+lint pass, throughput even improved slightly (+0.127 runs/s, ~265-269 r/s). Objective deltas are all within seed noise (|primary| = 2e-4, depth>=6 -9e-4, h2 -6.7e-4), confirming the counters are behavior-neutral as designed. Verdict is needs_human only because kind=meta requires human review in v1 — not because of any measured regression. The saturation curve itself is not present in the recorded metrics blob: the eval harness captures only the standard grader metrics (runs, depth histogram, h1/h2/h2b/h3 rates), so distinct-keys-per-run and cumulative-distinct-keys never made it into the evidence record. Consequently the actual question — does the timeline key space saturate, and at what run index — remains unanswered; the prescreen bought a clean, cheap vehicle but no data. Real lesson: reporting-only instrumentation is worthless to the ladder unless its counters are plumbed into the metrics object the evaluator serializes. The three coverage-key proposals still lack a numeric falsifier. Secondary observation: depth>=8 hit 1 and 5 runs at seeds 1000/1001 — the deep tail is so thin that any key-refinement lever must be judged on depth>=6 (70/69 runs) or shallower, since depth>=8 has no statistical power at 54k runs.

## 2026-08-27T01:10:00.000Z (operator)

The baseline's `runsPerSec`, which is the denominator of every `throughputRatio`
the gate computes, is a single screen-fidelity evaluation.

From the refresh just recorded: screen mean 287.8 over n=1, sequential mean
264.1 over n=4. `cli baseline` sets `runsPerSec` from the screen arm
(`screenOk.reduce(...) / screenOk.length`), so the figure carried forward is
the n=1 number, 9% above the better-powered one measured on 216,000 runs.

That has two consequences. Throughput comparisons in the perf lane are drawn
against a single short run, so `throughputRatio` inherits its noise; and the
apparent climb the 5270 audit flagged - runsPerSec 229.2 -> 247.2 -> 287.8
across refreshes - is partly a property of resampling one screen run, not
evidence that the explorer keeps getting faster.

The sequential arm already produces four measurements at 54,000 runs each and
they are tight: this refresh gave 206, 204, 205, 203 s explore, a 1.5% spread.
Using that arm for `runsPerSec` would cost nothing extra, since the chunks are
run either way.

Not changed here. It is a gate input, so it belongs in a deliberate boundary
with the perf-lane numbers re-based, rather than folded into a batch that was
already landing three other things.

## 2026-08-27T01:25:00.000Z (operator)

Two of the last four iterations spent a full implement producing work that
could not be landed, because the hypothesis targeted operator-owned paths.

- 5269 probe-cost-precheck-rule wrote its rules into `research/policy.json`
  under a key the schema drops on parse. Cost the implement plus a full
  sequential, because the diff existed and was evaluable.
- 5272 depth-power-floor-audit reached "the analysis is done; the artifacts
  could not be landed where the hypothesis names them" after $5.33 and 79
  turns. Every target it named is protected.

This is not a knowledge gap. `agents.ts:244` already tells the proposer:
"Change only the subject (spur, scheduler_configs/loop) or, for grader-kind,
traceanalyzer. Never propose changing the evaluation harness, the
orchestrator, the fixed evaluation config, or the sequential/gate protocol -
those are fixed and operator-owned, and such a proposal will be rejected."
The judge rubric likewise asks for rule-violating candidates to be rejected.
Both hypotheses were proposed, judged, selected and implemented regardless.

So the rule is stated and not enforced, and restating it more loudly is not
the fix. The deterministic points are the judge, which sees the description
before anything is spent, and selection, which sees it again. An analysis
hypothesis also has nowhere legitimate to put its output: the implement fence
reports `spur/**`, `scheduler_configs/loop/**` and `tmp/loop/**` as writable,
while `research/observations/` - the one place a finding belongs - is outside
it, even though the protected-path lint permits it.

Worth fixing together: give analysis work a writable destination, and make
the judge reject proposals whose deliverable is a document or a change to an
operator-owned path. Staged, not applied, since it is a prompt change and the
loop reads its modules at start.

## 2026-08-27T01:45:00.000Z (operator)

The throughput field added earlier tonight is systematically biased, and the
cause is not the sample size noted before but a fidelity mismatch.

`loop.ts:669` sets `throughputRatio = meanRps / baseline.runsPerSec`, where
`meanRps` is the mean over the candidate's sequential chunks and
`baseline.runsPerSec` comes from the baseline's screen arm. Screen runs are
shorter and therefore faster. Measured on iteration 5273: candidate
sequential 268.1 against a stored screen baseline of 287.8, reported as
-6.83%, while the bench's own paired rounds in a single window gave candidate
254.1 against baseline 253.0, ratio 1.004. The same change is level and the
field calls it a 7% regression.

This is a constant offset, not noise, so it will read about -7% for every
candidate whatever its merit. The comment directly above the line asserts
"same protocol and seeds as the baseline chunks they are compared with",
which holds for the depth rungs and not for throughput.

It has a second consumer. Line 727 rescales the stored baseline on merge as
`baseline.runsPerSec * throughputRatio`, so a biased ratio walks the stored
figure on every merge. It happens to walk it toward the sequential value,
which is the right direction by accident and not a reason to leave it.

Staged fix: divide by the mean of the baseline's own sequential chunks, which
are already recorded and were 264.1 across four. On 5273's numbers that gives
+1.5% against the bench's +0.4%, instead of -6.8%.

The regression suite's throughput case was never affected: it runs its own
paired bench in one window and uses `baseline.runsPerSec` only as a floor.

## 2026-08-27T01:56:13.433Z

**util-stats-metrics-plumbing** (auto_merge): Merged as auto_merge on non-inferiority, but the enabling goal is only half-delivered. Diff touched spur-core only (feedback.rs, util_stats.rs); superFiles is empty, i.e. the harness-side deserialization leg was never written. Consequence: both sequential evals (seed 1000/1001, 54k runs each, general_vr/VR.spur) recorded metrics blobs with the identical old field set — runs, runsPerSec, unpairedFraction, h1/h2/h2b/h3Rate, meanPrefixDepth, depthAtLeast, violations — and zero util_stats fields. The promised cumulative-distinct-key curve was NOT captured, so the saturation denominator the coverage-key lane needs still does not exist and the precheck observation is unrecorded. Behavioral read: objective deltas are all ~1e-4 noise (depth>=4 +5.6e-4, depth>=5 -2.0e-4 = primary, h2 -7.4e-4), throughput -0.068 runs/s on ~265-272 runs/s (~0.03%), params 15->15, regression+lint pass — confirming the change is semantically inert as intended, and that stats emission under stats=true costs nothing measurable. Seed spread is the real yardstick: depth>=5 differs by 136 runs between seeds (19078 vs 19214, ~0.25%) and h3Rate by 0.004, so any future coverage-key effect below ~0.5% relative is unresolvable at 2 seeds x 54k runs. Falsifier status: NOT falsified — nothing forced a touch to execution-semantics files or a new config param — but also not confirmed, because the counters remain invisible downstream. The hypothesis's own success criterion (counters appear in the harness metrics JSON) is measurably unmet by its own evaluation record.

## 2026-08-27T02:23:38.402Z

**timer-vs-delivery-coverage-axis** (closed): Refining the coverage key with timer-vs-delivery ordering bits does not move the ladder: 2 sequential chunks / 108k runs, all rungs flat-to-slightly-negative (d4 -0.00014, d5 -0.0019, d6 -0.00074), pMei separability 0.013 at +1% on d4 and 0.000 at d5/d6 — no frontier rung could reach a separable effect, so it was closed early. This falsifies the premise in the notes that key-space saturation (1790 distinct keys, new_keys decaying 1432->230->24->6) was the binding constraint. Adding resolution to the reward signal is inert because the key only scores trajectories after the fact; it does not change which events are admissible, and the explorer apparently cannot convert finer novelty accounting into different schedules. Corollary: the -0.0499 d4 sensitivity from the full timer-class ablation lives in admission/placement of timer events, not in how those events are labeled — that sensitivity is reachable only from the scheduler side. Also a methodological data point: 'novelty signal is dead for 99% of the budget' is not by itself evidence that finer keys help; the next such argument should be paired with a measurement that steer's preference actually binds.

## 2026-08-27T02:55:00.000Z (operator) - why depth and violations decouple

The general-config depth ladder measures the bug's chain with its decisive
step deleted, and the deletion is silent. This explains three years of
symptoms in one mechanism, so it is worth stating exactly.

The oracle DAG has 13 events and a longest chain of 9:

  w1 -> allow_t1 -> crash_nl -> deliver_svc_1_to_2 -> crash_2 -> recover_2
     -> w2 -> deliver_svc_1_to_0 -> r1

`allow_t1` is the second vertex. It is the only successor of the only source
and the only predecessor of everything downstream: a cut vertex. Its kind is
KindAllowTimer, and `buildCandidates` in
`traceanalyzer/metrics/dagorder/candidates.go` has no case for it. It falls
to `default: return nil, false`, so it never matches in non-plan-mode runs.

Prefix depth does not stop there. `bestMatchingFull` scores against the
transitive closure, and `TestPrefixDepthSkipsViolatedMiddle` fixes the
behaviour deliberately: when an intermediate vertex is unassigned, the chain
continues through the closure edge that spans it. So `w1 -> crash_nl` is
satisfiable without `allow_t1` ever occurring, and the remaining eight
vertices chain normally.

That is exactly the observed ceiling. General-mode max prefix depth is 8, one
short of 9, and it has never been higher. A general run scoring 8 has matched
every step of the bug chain except the one that cannot be matched.

The consequence is that depth 8 means something different in the two modes.
In plan mode the timer step is enforced, so depth 8 is the real chain and 71%
of those runs violate. In general mode depth 8 is the chain minus its setup,
with nothing requiring the timer to have fired at the point that makes the
rest a bug, and 0 of those runs have ever violated. Same number, different
meaning, and the ladder reports them as one metric.

This is a better explanation of the record than any of the mechanism-level
ones. Four families were falsified against a target that cannot express the
difference between reaching the bug and reaching its shadow, and the loop's
depth numbers today match the pre-loop corpus regraded with the corrected
oracle, so the search has been optimising a quantity that saturates one step
short by construction.

Not yet established: whether a timer fire is recoverable from existing trace
rows. The trace schema carries Crash, Dispatch, Enter, Exit, Invocation,
Recover and Response, with no timer kind, so a collector would have to infer
the fire from the handler resumption it causes. If it can, the repair is
grader-only. If it cannot, the simulator must emit the event first, which
crosses from ruler into subject and needs deliberate operator handling.

Either way this is a measurement-plane change: it alters what depth means, so
it requires an epoch bump, corpus revalidation and a baseline re-run, and it
should not be attempted by a hypothesis.

### Feasibility of the allow_t1 repair: grader-only, confirmed

The open question above is answered from real general-mode traces. A timer
fire is recoverable without touching the simulator.

Traced functions in a general VR run are Node.Init, Node.RecoverInit,
Node.Recovery, Node.RecoveryResponse, Node.Prepare and Node.StartViewChange,
with rows of kind Enter, Exit and Dispatch carrying node and step. Two runs
show the signature plainly:

  run 2: step 22, node 2 Dispatch StartViewChange (x2), no prior Enter on node 2
  run 3: step 90, node 2 Dispatch StartViewChange (x2), no prior Enter on node 2

A node that dispatches StartViewChange without having entered one first was
not relaying somebody else's view change; in VR nothing but its own timeout
starts one. So "node N's timeout fired" is exactly "the first Dispatch of the
view-change handler from node N with no preceding Enter of it on node N",
which is what `allow_t1` with Target 1 and TimerLabel "timeout" denotes.

The repair is therefore a `KindAllowTimer` case in `buildCandidates` that
collects those dispatches for the target node, and nothing else. No simulator
change, no new trace event, no crossing from ruler into subject. It does
hard-code the view-change handler name into the grader, which the separation
rules permit for the ruler and which the DAG already relies on.

It remains a measurement-plane change: it makes depth 9 reachable, so every
depth number recorded before it means something different afterwards. Epoch
bump, corpus revalidation against manifest.json, and a baseline re-run.

Expected effect, stated in advance so it can be checked: general-mode max
prefix depth should rise from 8 to 9, the fraction at depth >= 8 should fall
sharply because the timer step now has to be genuinely present, and the
depth >= 8 population should start to correlate with violations the way the
plan corpora do. If depth >= 8 stays at its current rate after the change,
the collector is matching something too permissive and should be rejected.

### Prototype result: the diagnosis holds, the repair is not worth its price yet

Built in a scratch copy of the grader, never in `traceanalyzer/main`, since
that binary is what the loop grades with and rebuilding it would have changed
live measurement silently.

Design, after operator correction: every protocol name stays in the oracle.
`allow_timer` takes an optional third element naming the handler the timer
causes the target to send, so `allow_t1` becomes
`[1, "timeout", "Node.StartViewChange"]`, and the grader rule is generic - a
dispatch of a handler the node has never entered was originated, not relayed.
No VR identifier enters the Go source, matching how `deliver` already receives
`function` through `EventSpec.Function`.

Confirmed, on `findbug_archive` where violations are known:

| | max depth | runs at max | violating runs' mean depth |
|---|---|---|---|
| old | 8 | 382 | 8.00 |
| new | 9 | 382 | 9.00 |

Max moves 8 to 9 and the run set at max is identical. The collector adds
exactly the missing vertex and matches in exactly the runs where the timer
really fired. The claim that general-mode depth tops out one step short by
construction is therefore established, not merely argued.

The pre-registered prediction failed. It said the depth >= 8 rate should fall
because the timer step must now genuinely be present. On a general corpus
every rung rose instead: d>=4 35.6% to 42.6%, d>=5 8.95% to 12.4%, d>=6 1.9%
to 3.5%. The prediction was badly formed - making a vertex matchable
lengthens satisfied chains mechanically, so some rise was inevitable and the
test could not have distinguished a correct collector from a permissive one.

What the rise does show is that node-1 self-initiated view changes are common
in general mode. allow_t1 is an easy step there, so requiring it adds little
discriminating power, and precision at max depth is unchanged at roughly
266/382, about 70%. An earlier figure of 0.131 in this session was computed
against the manifest's truncated 50-id list and was wrong.

Verdict: hold. It is a genuine instrument correction, the ladder should be
able to express the full nine-vertex chain rather than topping out one short,
but it buys a rescale rather than a better proxy, and it still costs an epoch
bump, corpus revalidation and a baseline re-run. Land it bundled with a change
that moves the objective, not on its own.

Prototype kept at `scratchpad/ta-proto` with the config variants beside it.

## 2026-08-27T03:07:08.018Z

**steer-authority-audit** (auto_merge): Instrumentation merged clean and confirmed inert: with steer_audit default-off, 2 seeds x 54k runs at 233-235 runs/s show primary (depth>=5) delta -0.0012, h2 -0.0008, depth>=4 +0.0001, violations 0 — all within seed noise (seed-to-seed spread on depth>=5 count is 35355 vs 35458, ~0.3%). Throughput cost -0.126 runs/s (~0.05%), i.e. the audit counters' presence in the scheduling loop is free when disabled. So the mechanism is safe to leave in. BUT the diagnostic payoff was NOT realized by this evaluation: the harness ran the default-off path, and the audit aggregates land in util_stats, which is not part of the metrics record the grader emits. Nothing in this evidence blob answers the actual question — no preference-expressed rate, no override-cause histogram. The falsification criterion ('>90% no preference expressed') therefore remains untested; the hypothesis is built, not run. Two negative results upstream (flat continuous weights, flat finer coverage keys) still sit unexplained, and the signal-quality-vs-authority partition is still open. Immediate next step is cheap and mechanical: surface the counters into the recorded metrics and do one steer_audit=true run. Second-order note: pure-instrumentation hypotheses need their read-out path wired all the way to the evaluation record, or they auto-merge as no-ops and produce zero information — the merge verdict here is a false positive on 'progress'.

## 2026-08-27T03:11:49.870Z

### Audit @5275
Evaluation dominates: 1703s of 2574s mean iteration wall (66.2%), and evaluate+regression together are 1863s (72.4%). Implement is 474s (18.4%), of which model/think is 369s (78% of implement); actual edits+reads+shell are ~13s (2.7%). Propose is effectively free (0.0005s) and rejudge (138s, 5.4%) plus reflect (41.6s, 1.6%) are pure meta-overhead. At 20 wall-h/day this yields only ~28 iterations/day, ~13.2 h/day spent inside the evaluator. The concentration is worst-case because the work being evaluated is frequently a no-op: the latest merge (util-stats-metrics-plumbing) is a counter-serialization change that cannot alter scheduling, yet it consumed a full 54,000-run chunk grid (249s explore/chunk, 2-4 chunks) plus 159s regression. A parked hypothesis that would fix exactly this (policy-hypotheses-skip-evaluation, cost 0.5) has been sitting unexecuted while the loop pays ~1860s per telemetry-only iteration. Recent iterations also show abandoned work: 5272 burned 836s of implement with no build/evaluate, 5265 burned 270s the same way — ~18 min/iteration of implement discarded with zero measurement.

Goodhart: runsPerSec is on the ladder at 264.6 vs reference 142.4 (1.86x 'better') while P(depth>=4) is 0.356 vs reference 0.034 (10.5x worse). Throughput is trivially improvable by producing shallower/cheaper schedules, so it rewards the exact failure mode the depth metrics penalize; it should be a guardrail, not a ladder rung.; termination.plan_complete is a vacuous success signal: plan_complete=302 and plan_complete_with_pending_work=302 — 100% of 'completed' runs exited with outstanding work (pending_work_at_exit_sum=7931, planned_events_outstanding_sum=6453). Any hypothesis credited for raising completion is being credited for a metric that never distinguishes clean completion.; h2bRate has moved 0.412 -> 0.421 against a reference of 0.417 while the closed h2b-invariance-audit concluded it is pinned under every schedule. A metric that is invariant to the intervention is now sitting above reference and can be reported as 'at/above target' without any causal contribution — pure ladder decoration.; Merged work is overwhelmingly self-instrumentation: of 11-12 merged hypotheses the visible ones (util-stats-metrics-plumbing, crash-anchor-utilization-precheck, acted-fraction-instrumentation) all add counters rather than change scheduling. The loop is optimizing its own observability surface while the headline gap (meanPrefixDepth 3.03 vs 2.26, P(depth>=4) 0.356 vs 0.034) is unchanged, and each such merge still consumes a full evaluation, letting a no-op register as a ladder row.; Bookkeeping is inconsistent between the pool table and the ledger (parked 33 vs 37, closed 39 vs 40, merged 11 vs 12, proposed 8 vs 5). Counts used to judge loop productivity are not reconciled, so 'merged' totals cannot be trusted as a progress measure.; The steer mechanism is reported as active (steer.evaluations=2,236,581) while divergent_picks=3161 (0.141%) — a large-looking activity counter that represents essentially zero behavioral influence.

Utilization: aos=unexercised, dedup=unexercised, curriculum=unexercised, feedback config-scoring (cfg_score_sum)=unexercised, steer / steer_authority=unrewarding, steer_authority gates (blocked_by_order, blocked_by_timer_gate)=broken, purgatory / biased+delayed delivery=unrewarding, receiver_restarted delivery path=unrewarding, crash_anchor=unrewarding, crash_recovery=healthy, timeline_keys novelty=scaffolding, rng_stream_isolation=scaffolding, termination.plan_complete=broken

Policy suggestions: Freeze accept/reject verdicts until the noise floor is measured: unpark eval-noise-floor-calibration (4/1.5) and enabling-crn-paired-eval (8/4) and run them next, ahead of any add-kind hypothesis. Justification: a causally inert merge moved P(depth>=7) by 50% relative (~4-5 nominal binomial SEs), so the current sequential rule (reject at P<0.05) is operating on an unvalidated variance model.; Drop P(depth>=7) and P(depth>=8) from the decision ladder and mark them reporting-only. At 54k runs they carry 0-108 events; P(depth>=8)=0.000 has a 95% upper bound of ~5.5e-5 and can never be moved detectably. Unblock depth-power-floor-audit (cost 0.5) to pick the deepest bucket with real power (likely depth>=5, p=0.081).; Adopt policy-hypotheses-skip-evaluation (cost 0.5) immediately: route kind=meta/enabling/grader/telemetry hypotheses that touch no scheduler decision path to a build+regression-only gate. This removes ~1863s (72%) from the iteration cost of changes like util-stats-metrics-plumbing that provably cannot move the metric, roughly doubling measured-hypothesis throughput within the same 20 wall-h/day.; Cut num_runs_per_config from 1000 to ~300 (or add a stopping rule on new-key growth < 1% per 100-run bucket) and spend the freed ~70% of chunk compute on paired/common-random-number seeds and a wider config grid. Evidence: saturation_run_index=300; runs 601-1080 contributed 25 of 1784 keys.; Demote runsPerSec from the metric ladder to a guardrail with a floor (e.g. reject only if <120/s). At 264.6 vs reference 142.4 it currently rewards shorter, shallower runs — directly antagonistic to the depth objective that is 10x off reference.; Fix or retire termination.plan_complete before any hypothesis is scored on completion: plan_complete==plan_complete_with_pending_work (302/302). Also report all depth metrics stratified by termination reason, since 72% of runs are right-censored by max_iterations=6000, and either raise the step budget or state explicitly that depth is budget-limited.; Force a mechanism-liveness precheck on proposals: any hypothesis whose buildsOn names aos, dedup, curriculum, or feedback cfg-scoring must be rejected at propose time unless it first enables the mechanism in general_vr.json. Then execute zero-utilization-mechanism-sweep-ablation (4/2) to delete the dead paths, including blocked_by_order and blocked_by_timer_gate, which have fired 0 times in 4.8M steps.; Close steer-authority-audit (proposed, cost 3) as already answered by the existing counters (0.155% preference_expressed, 43.4% honored, 0.141% divergent picks) and require any future steer hypothesis to state a target for preference_expressed/steps; a mechanism influencing 0.07% of steps cannot plausibly move meanPrefixDepth from 3.03 to 2.26.; Add an implement-abort guard: iterations 5272 and 5265 spent 836s and 270s in implement with no build or evaluate. Cap implement at ~2 model-think stalls or 400s before forcing a checkpoint/abandon decision, and log abandoned iterations explicitly in the ledger.; Institute pool hygiene: 33-37 parked and 39-40 closed hypotheses against 11-12 merged (~12% merge rate). Auto-expire parked items older than 500 iterations, cap parked at ~15, and reconcile the pool table against the time/budget ledger (parked 33 vs 37, merged 11 vs 12) so productivity accounting is trustworthy.; Re-scope the delivery-bias family: biased/delayed deliveries have acted_fraction 0.137 vs 0.412 baseline and receiver_restarted 0.026. Require new add-kind hypotheses in this family to predict an acted_fraction target and be rejected if the injected events remain below ~0.25, so effort stops flowing into perturbations the guards absorb.; Audit the crash_anchor applied/taken ratio (749/1916 = 39.1%) as a cheap, evaluation-free win: unpark crash-anchor-acted-fraction-comparator (4/3) and identify which anchors account for the 1167 discarded crashes before adding any new anchor (crash-during-inflight-fanout, recovery-completion-race-window both cost 6-7.5).

## 2026-08-27T03:20:00.000Z (operator) - depth is not step-budget limited

The 5275 audit observed that about 72% of runs are right-censored by
`max_iterations` and asked for either a bigger step budget or an explicit
statement that depth is budget-limited. The censoring is real and the
inference is not.

Censoring, from six consecutive utilization captures of 1,080 runs each:
`iterations_exhausted` runs 774 to 790, i.e. 71.7% to 73.1%. Consistent, so
nearly three runs in four stop because the budget ran out.

Matched corpora, same seed and config, only `max_iterations` varying, 2,160
runs each:

| max_iterations | explore | mean depth | d>=4 | d>=5 | d>=6 |
|---|---|---|---|---|---|
| 1,500 | 3s | 3.027 | 35.5% | 7.8% | 1.1% |
| 3,000 | 6s | 3.021 | 35.4% | 7.8% | 0.8% |
| 6,000 | 10s | 3.018 | 35.2% | 7.2% | 0.9% |
| 24,000 | 41s | 3.015 | 35.6% | 7.4% | 1.2% |

Depth is flat across a sixteenfold range while cost scales linearly. Every
rung sits inside the measured A/A floor. The runs that exhaust their budget
are spending it on work that never advances the oracle chain, which is what
the absorption numbers already implied. Raising the step budget is closed as
a lever: at 24,000 it costs four times the wall clock and returns nothing.

The converse is tempting and is NOT established here. Depth being insensitive
to the budget does not license cutting it, because depth is a proxy already
known to decouple from violations at the top of the ladder, so "depth is
flat" and "nothing that matters changed" are different claims. This
experiment cannot separate them: the grade output for these corpora reported
h1/h2/h2b/h3 as 0.0000 where the standing baseline shows h2 near 0.40, so the
hazard channel was not validated and the zeros should not be read as
measurements. Anyone pursuing a cheaper chunk must check hazards and
violations first, on corpora graded the way the loop grades them.

What this does settle: the current 6,000-step budget is not buying depth, and
neither would a larger one.

## 2026-08-27T03:36:00.000Z (operator) - the feedback apparatus does not steer

enable-cfg-feedback-general-config turned on the config-scoring feedback path,
dead since the project began, and the result is the cleanest negative in the
record.

The mechanism did not merely fire, it took over the signal. `cfg_score_sum`
went from 0.0 in every previous capture to 1063.1, against a timeline score of
71.1 that did not move - the score the explorer feeds on is now dominated
fifteen to one by a source that contributed nothing an hour ago. Steer
divergent picks roughly halved, 3161 to 1653.

The ladder did not respond. Sequential advanced on non-inferiority after
108,000 runs with depth>=4 ratio 1.0014 and depth>=5 ratio 1.0002, both
indistinguishable from 1, and pMei 0.033 against a bar of 1%.

Put beside the rest of the evening this is no longer one null among many. The
steer changes its pick in 0.1% of two million evaluations. The timeline
coverage key saturates after a few hundred runs, and widening it 2.6x moved
nothing. Turning on a second scoring source that dominates the first moved
nothing. Each of those is a component of the same apparatus: the machinery
whose purpose is to direct exploration rather than let it run at random. On
the evidence, that apparatus has no measurable influence on how deep the
explorer gets.

That reframes the four falsified mechanism families. They were not competing
to steer a search that was otherwise working; they were adjusting inputs to a
steering system that does not reach the objective. It also predicts the two
remaining dormant mechanisms, AOS and dedup/coverage scheduling, are likely to
null for the same structural reason, and they belong to the same apparatus.

One caution on my own claim. I argued earlier that "enable a mechanism that is
off" is the only class that has ever cleared the merge bar, on the strength of
enable-purgatory-general-config at +4.3%. That class is now one for two. The
generalisation was drawn from a single success and should not be leaned on.

## 2026-08-27T03:55:23.055Z

**enable-cfg-feedback-general-config** (auto_merge): Config-scoring is now wired and enabled in the graded general_vr.json, and the two-seed sequential run (54k runs each, seeds 1000/1001) came back non-inferior rather than falsified-dead: violations stayed 0, primary unchanged, and depth>=4 moved +0.0005 absolute (49420/49519 of 54000 -> ~91.5%), i.e. a ratio of ~1.0005, far under the pre-registered 1.05 bar. Mid-ladder is flat-to-noisy (depth>=5 exactly 0, depth>=6 -0.00027, depth>=7 +0.00014, h2 -0.00005) and the seed-to-seed spread on the deep tail (depth>=7: 90 vs 83; depth>=8: 5 vs 2) is larger than every delta reported, so no depth claim here is separable from seed noise. Cost is real and one-sided: throughput -0.139 runs/sec (204.0 -> 199.8), ~2% slower explore, param count unchanged at 15. Auto-merged as enabling/non-inferior, which unblocks the standing liveness rule, but the pre-registered reward bar was NOT met: the mechanism fires without paying, so dependent tuning proposals stay barred until a metrics-level check confirms cfg_score_sum > 0 and cfg_score_updates > 0 — the evaluation harness recorded no cfg_score counters in the metrics blob at all, so the interpretability precondition is technically unverified and the flat result is equally consistent with the flag being threaded but the scoring loop never updating. That ambiguity is the single most valuable thing to resolve next, and it is cheap.

## 2026-08-27T04:20:00.000Z (operator) - correction, and a crash-timing measurement

Two earlier entries this session over-reached and should be read with this
one. The entry titled "why depth and violations decouple" is sound about the
grader, allow_t1 is genuinely skipped through the transitive closure and
general-mode depth does top out one step short, but the conclusion drawn
around it - that the loop may not be pointed at the bug, that depth may be
the wrong proxy entirely - does not follow. A plan only gates which events
may be released; it does not make states unreachable. The plan corpora find
the bug, so free exploration can too. Improbable is not impossible, and the
task is raising that probability.

Likewise the entry on the feedback apparatus stands as a measurement, the
components do not influence depth, but read it as "the current heuristics do
not work", which is the problem to solve, not as evidence the search is
misconceived.

A measurement, offered as data rather than as a recommendation. Steps between
a crash and the recovery that follows it, over whole corpora:

| corpus | pairs | mean | median | share <= 5 steps |
|---|---|---|---|---|
| findbug_archive (5.3% of runs violate) | 6218 | 1.1 | 1.0 | 100.0% |
| general grid (0 violations in ~2M runs) | 3203 | 4.9 | 3.0 | 78.4% |

The histograms differ in shape, not only in centre: findbug is 5648 pairs at
gap 1 and nothing past 6, while the general grid trails out past 8. The gap
is counted in scheduler steps, so it measures how much other work was
interleaved between a node going down and coming back, which is a scheduling
choice rather than a property of the protocol.

What this does not establish: whether the tight gap in findbug_archive was
chosen by its scheduler or forced by the configuration that generated it,
which is not recorded in the manifest. Anyone building on this should settle
that first, because the two readings imply different work. Nor does a
correlation across two corpora with different generators establish that
shortening the gap raises the violation rate; that needs a paired experiment.

Stated in general terms, the candidate is: schedules that bring a node back
soon after it goes down expose the window where messages from the previous
incarnation are still in flight. That names no handler and no protocol, and
is the shape a heuristic has to have here.

## 2026-08-27T04:50:00.000Z (operator) - the crash-gap question, settled the other way

The previous entry left one thing to settle before anyone built on it:
whether the tight crash-to-recovery gap in `findbug_archive` was chosen by
its scheduler or forced by the configuration that generated it. It was
forced, and the gap turns out to be a symptom of something with far more
signal in it.

**The corpus is a pinned fault schedule, not a discovery.** Node 1 crashes
in all 5,000 runs, exactly once. Node 2 crashes in 1,218 of them. Node 0
never crashes. Crash and recover are adjacent planned events, so the gap of
1 is written into the corpus rather than found by search.

**Within the corpus the gap separates nothing.** Mean gap over violating
runs is 1.096, over clean runs 1.113. What separates them is the fault
count, and cleanly:

| shape | runs | violations | rate |
|---|---|---|---|
| 1 crash-recover pair, 1 node | 3782 | 0 | 0% |
| 2 pairs, 2 distinct nodes | 1218 | 266 | 21.8% |
| ...of those, windows overlap | 91 | 0 | 0% |
| ...of those, windows disjoint | 1127 | 266 | 23.6% |

**The gap is downstream of quiescence.** Every one of `findbug_archive`'s
6,218 crashes lands with zero client operations outstanding. In a 2,160-run
general grid only 9.3% do, with a mean of 5.14 operations in flight at the
moment of the crash. Split the general grid by that variable and its own gap
splits with it: 2.36 steps mean when the crash is quiescent, 5.73 when it is
not. So shortening the gap directly would be treating the symptom.

**The fault shape is not the missing ingredient either.** Measured on the
same 2,160 general-grid runs, the shape appears often:

| filter | share of runs | per 54k chunk |
|---|---|---|
| 2 crashes, 2 nodes, both recover | 16.2% | ~8,700 |
| + disjoint windows | 8.6% | ~4,600 |
| + both crashes quiescent | 0.60% | ~325 |
| + node 0 spared | 0.23% | ~125 |

At the corpus conditional rate of 23.6%, the fully shaped runs alone would
predict roughly 30 violations per chunk. The observed count is zero across
about two million runs. Reproducing the fault schedule is not sufficient,
which closes the whole "imitate findbug's fault timing" family, my own
quiescence refinement included.

**Where the general grid actually stalls.** The graded chain in
`relax_minimal_general.json` needs, after the second recovery and after a
second write completes, the delivery of two `StartViewChange` messages that
were sent before the first crash. That is a hold across two crash-recover
cycles and a full write. Measured span from the first crash to the response
of the write that follows the second recovery:

| corpus | runs measured | mean | median | p90 | share <= 100 steps |
|---|---|---|---|---|---|
| findbug_archive | 382 | 26.8 | 25 | 35 | 100% |
| general grid | 23 | 224.9 | 192 | 338 | 17.4% |

The mechanism that exists to carry a message across a crash is the send
delay in `exec.rs`: `release_step = current_step + duration`, with duration
drawn log-uniform over `delay_duration_range`, set to `[5, 100]` in
`general_vr.json`. Log-uniform over that range has a median of 22 steps and
a hard maximum of 100. The general grid's median requirement is 192. The
cap sits below the median need, so no draw can bridge it in more than half
of correctly shaped runs.

Nothing else holds a message that long. `delay_runnable` has exactly two
call sites and both are this one. The runnable set is the same size in both
corpora, median 4 and mean about 4.6, so a record surviving 192 steps without
being selected has probability on the order of 1e-19; free scheduling does
not hold messages. The one other hold in the simulator is buffering at a
crashed receiver, which lasts only until that receiver recovers, a general
grid mean of 5.4 steps and median 3. The send delay is the only path with the
right order of magnitude, and it is sized for a corpus whose runs are 31
steps long against a graded config whose runs are 2,387.

**The ladder agrees about which rung.** From the loop's own 54,000-run
chunk, `depthAtLeast` is [54000, 49420, 35424, 19045, 4446, 719, 90, 5], so
per-rung survival runs 0.92, 0.72, 0.54, 0.23, 0.16, 0.13, 0.06. The two
worst rungs are the last two, and they are the two the hold has to cover:
rung 7 is the second write completing after both recoveries, rung 8 is the
delivery of the pre-crash `StartViewChange` copies after that write. Rung 4,
the delivery that only has to cross a single crash, survives at 0.54. Short
holds pass; long holds do not.

What this does not establish: that widening the range raises depth or
violations. It is a correlational diagnosis plus an arithmetic bound, and the
general-grid span figure rests on 23 runs, though run length and mean
operation window (2,387 vs 31 steps, 162 vs 14.4) corroborate the order of
magnitude independently. It is also a lower bound on the requirement, since
the message must be held from its send, which precedes the first crash, not
from the crash itself. The test is a paired experiment, seeded as
`widen-purgatory-hold-to-run-length`.

Worth noting against the standing read that the loop is out of levers: this
is a mis-calibration of a parameter that already exists, not a new tunable,
and it is the first candidate in some time with a mechanistic reason to
expect movement at the depth 7 to 8 rung specifically.

## 2026-08-27T04:48:27.896Z

**acted-delivery-novelty-credit** (closed): Subtractive coverage-key filtering is as inert as additive refinement. Gating a delivery's key component on its acted bit (inert deliveries collapsed to an 'absorbed' sentinel) fired as intended — the mechanism was live and distinct-key counts fell — yet across 3 sequential chunks / 162k runs at seeds 1000-1002 every ladder rung sat on baseline: d>=4 +0.0004, d>=5 -0.00005, d>=6 +0.00009, d>=7 -0.00013, violations 0, meanPrefixDepth 3.018-3.025 (baseline-identical), maxPrefixDepth 8 with only 1-2 runs there. pMei was 0.009/0.018/0.041 for d4/d5/d6 at +1/+2/+6% — no frontier rung can reach a separable effect, so this is a real null, not underpower. Taken with the two prior additive-resolution nulls (timer-vs-delivery axis: 2.6x keys, zero movement; interleaving signatures: null), the coverage-key *resolution* axis is now falsified in both directions: coarser and finer keys move nothing. That kills the 'signal quality' branch of the signal-quality-vs-authority partition and leaves authority — how much of the scheduler's decision the novelty score actually controls — as the only surviving explanation, or the possibility that timeline-key novelty is a no-op channel end to end. Also note h1/h2/h3 rates and unpairedFraction (~0.487) were unmoved, so the filter did not even perturb workload shape.

## 2026-08-27T05:20:00.000Z (operator) - the hold was mis-sized, but not where I said it was

`widen-purgatory-hold-to-run-length` merged at iteration 5279 on 108,000
runs. It is the largest measured effect in the visible record, and the
reason I proposed it was wrong.

Merged deltas, against the refreshed baseline, absolute and relative:

| statistic | absolute | relative | gate bar |
|---|---|---|---|
| depth>=4 | +0.00973 | +2.8% | +1.1% |
| depth>=5 | +0.00473 | +5.7% | +2.3% |
| depth>=6 | +0.00071 | +5.4% | +5.8% |
| h2 | +0.02184 | +5.4% | +1.1% |
| depth>=7 | +0.0000093 | +0.6% | - |
| depth>=8 | -0.0000093 | -10% | - |
| violations | 0 | - | - |
| throughput | +0.053 rps | +0.03% | - |
| params | 0 | - | - |

Posteriors were pGreater 1.0 and pMei 0.999 on depth>=4, 0.998 on depth>=5,
1.0 on h2. The regression suite passed on all four cases. Cost is nil:
throughput ratio 1.004 and the top-level config key count is unchanged.

**The prediction failed.** The argument for the change was that the hold cap
of 100 steps sat below the median 192-step span the graded chain needs, and
that the effect would therefore appear at rungs 7 and 8 specifically. Those
are exactly the two rungs that did not move. Depth>=7 rose 0.6%, inside
noise, and depth>=8 fell by one run in 108,000. The gain is concentrated at
rungs 4 through 6, which need short holds, and those were never the ones I
argued were starved.

**What the mechanism actually did.** Counters from matched 1,080-run
captures either side of the change:

| counter | [5, 100] | [5, 1000] | ratio |
|---|---|---|---|
| purgatory delayed sends | 299528 | 226624 | 0.76 |
| deliveries, all | 1083324 | 951346 | 0.88 |
| deliveries that changed receiver state | 453779 | 476148 | 1.05 |
| acted fraction | 41.9% | 50.0% | 1.19 |
| delayed deliveries that acted | 22176 | 15108 | 0.68 |
| pending work at run exit | 7876 | 14101 | 1.79 |
| steps used | 4786997 | 5175514 | 1.08 |

Fewer deliveries happen, and a much larger share of the ones that do happen
change state: 42% to 50%. That density shift is what lifts the mid-ladder,
and it is a different mechanism from the one I proposed. Meanwhile work
stranded at the end of a run rose 79%. Long holds park messages past the end
of the run rather than carrying them to the point the chain needs them, which
is a plausible reason the deep tail stayed flat while the middle rose.

**Correction.** My earlier entry argued the hold length was the binding
constraint at the 7-to-8 rung, on an arithmetic bound and a 23-run span
measurement. The bound was right about the cap and wrong about the
consequence. A 2,160-run probe I ran beforehand estimated depth>=4 at 1.028
and depth>=5 at 1.064, which matched the 54,000-run chunk almost exactly
(1.027, 1.058), and estimated depth>=7 at 1.62, which did not survive at all.
Small-sample ratios on rungs with a dozen events are worthless even when the
same probe is accurate two rungs lower, and I should have said so more
strongly than "underpowered".

**What this settles.** The top of the ladder is not hold-limited. Widening
the window by tenfold moved every rung that needs a short hold and none that
needs a long one, so whatever blocks 7 and 8 is not the message being
released too early. The send-delay family is not closed - it paid, and it
paid without cost - but tuning it further to reach the deep tail has now been
tested and failed.

The obvious follow-up is a hold bounded by the run budget remaining rather
than by a constant, since the 79% rise in stranded work says a fixed 1,000
overshoots late in a run. That is a derived parameter rather than a new free
one, but it is still code rather than a config value, and it should be
weighed against the fact that the deep rungs did not respond to hold length
at all.

**Violations are still zero.** This moved a proxy. It did not move the goal,
and general-config depth-8 runs remain linearizable.

## 2026-08-27T05:29:58.003Z

**widen-purgatory-hold-to-run-length** (auto_merge): Merged (auto_merge) on mid-ladder gains, but the hypothesis's own falsifier fired at the top. Two seeds x 54k runs, [5,1000] vs baseline [5,100]: depth>=4 19571/19613 vs 19045 (+2.9%), depth>=5 4688/4651 vs 4446 (+5.0%), depth>=6 771/770 vs 719 (+7.2%), h2 0.4246/0.4229 vs 0.4028 (+2.2pp), meanPrefixDepth 3.049/3.051. But depth>=7 85/83 vs 90 (-7%) and depth>=8 3/2 vs 5 both went DOWN, and violations stayed 0. Throughput cost was nil (211/210 runs/s, +5% vs baseline), so the change is free and the mid-rung lift is real and seed-stable (two seeds agree to within 1% at every rung >=4). The mechanistic claim -- 'the 100-step cap is below the 192-step median span, so no draw can bridge it' -- is confirmed for the rungs where a single held message must cross one crash (rungs 4-6 all lifted monotonically with hold length). It is falsified as the explanation for the top two rungs: tripling the reachable hold window did not produce a single extra depth>=8 run. Best reading is that the top rungs need TWO pre-crash StartViewChange messages held past the same post-recovery write, and exec.rs draws each delayed record's duration independently and log-uniformly, so the joint event of both landing after the same later point stays rare no matter how wide the marginal range is -- widening the range actually spreads the two release steps further apart. Secondary caveat: depth>=7/8 raw counts are 2-5 per 54k, so a ~50% swing there is inside Poisson noise (sqrt(5)=2.2); the decline is not evidence of harm, only of no gain. The send-delay family should not be tuned further by range alone -- the next lever is correlation between holds, not hold length.

## 2026-08-27T05:40:00.000Z (operator) - the grader's candidate cap is not suppressing depth

Recorded so nobody spends the evening on it twice.

`dagorder.go` caps candidates per label at 256, keeps the earliest 256 in
step order, and warns on truncation. On the general config that fires on 23.1
percent of runs at a hold range of [5, 100] and 18.1 percent at [5, 1000],
always on the three `deliver_svc_*` labels and never on the others. The story
writes itself: the deep rungs need a delivery that lands after the second
write, late deliveries are exactly what a first-256 truncation discards, and
a longer hold pushes deliveries later, so an explorer-side gain could be
erased at the grader.

It is not happening. Re-grading the same two corpora with a scratch build at
a cap of 8192:

| corpus | cap 256 | cap 8192 |
|---|---|---|
| [5, 100] | mean 3.0222, [2160, 1980, 1419, 759, 173, 37] | mean 3.0227, [2160, 1980, 1420, 759, 173, 37] |
| [5, 1000] | mean 3.0486, [2160, 1999, 1445, 768, 178, 31, 4] | mean 3.0477, [2160, 1999, 1444, 768, 178, 30, 4] |

A thirty-twofold cap increase moves one run in each direction, one of them
downward. The runs that hit the cap are not the runs that would have scored
deeper. No grader change is warranted and none was proposed; the prototype
was built and discarded outside the repository.

The warning line is still worth keeping. It is loud, it is accurate about
what it truncates, and it costs nothing.

## 2026-08-27T06:00:46.805Z

**recovery-completion-race-window** (closed): Null at 108k runs (2 seeded chunks, seq-reject after chunk 2). Weight-biasing crash selection toward other live nodes while any node is mid-recovery moved nothing measurable: h3Rate 0.332/0.337 vs baseline 0.337 (delta -0.0004), depth>=4 +0.0007, depth>=5 -0.0001, depth>=6 -0.0007, depth>=7 -0.0002, violations 0. pMei at frontier rungs (d4 0.026, d5 0.021, d6 0.000) says no rung can separate. The implementation was live (files touched across scheduler.rs/state.rs/curriculum.rs/util_stats.rs, config params 15->16), but the decision record carries no recovery_race.{windows_offered,races_created,max_concurrent_observed} readout, so the mechanism-fired-but-didn't-help vs mechanism-never-fired branch is NOT distinguished here — that ambiguity is the single most important thing to resolve before any sibling in this family is tried. Two structural readings survive: (a) the recovery window is very short in wall-event terms (first applied post-restart delivery arrives almost immediately), so 'while recovering' is a near-empty window and weight multiplication has almost no eligible events to reweight; (b) the window is real and races do get created, but ordered-h3 is not the binding constraint on rungs 6/7 — i.e. the ladder's attrition above depth 5 (19564 -> 4675 -> 738 -> 76) is not gated on crash *ordering* at all. Reading (b) would generalize the earlier crash-recover-density-knob null: two independent knobs on the same crash-shaping axis (density, ordering) both returned flat, which is evidence the crash axis is saturated and the depth>=6 shortfall lives elsewhere (message/quorum interleaving after recovery, not the crash pattern itself). Also note unpairedFraction ~0.49 unchanged, consistent with no change in overall event mix. Practical lesson: conditional-probability reshaping of an already-33%-satisfied predicate has no headroom to convert unless the predicate's ordered sub-case is actually rare AND actually rung-limiting; verify both with a counter before spending 6.5 cost.

## 2026-08-27T06:06:27.293Z

### Audit @5280
Per-iteration mean ~1819 s of tracked phase time is 50% evaluate (915.7 s) and 37% implement (675.3 s) = 87%; rejudge is a further 10% (188.7 s) and is pure re-litigation of already-graded work. Propose is ~0 s (cached), so the loop spends essentially nothing deciding WHAT to test and everything executing it. Inside implement, 384 s/iter (57%) is model/think, 48 s builds, 14 s tests, 10 s reads — 22.5 edits and 3.9 cargo builds per iteration, i.e. the implementer is rewriting more than it is verifying. Wall-clock: last 15 iterations spanned 21:25Z→05:33Z (8 h 08 m) for 14 completions = ~35 min/iteration against a 90 wall-min/hypothesis budget. Two of the last 15 iterations (5272, 5277) recorded implement time and then no build/evaluate/finish at all — 5272 burned 835.6 s of implement and died; that is ~13% of iterations paying full implement cost for zero measurement. Evaluate is also highly variable (772 s at iter 5270 vs 2792 s at 5266, 3.6x), so the 90-min budget is being consumed by a phase whose cost is not being controlled. Topic concentration is worse than phase concentration: 4 of the 40 listed hypotheses (novelty-steer-authority-sweep, steer-authority-knob, steer-audit-readout, ablate-steer-authority-dead-gates) plus 1 merged (steer-authority-audit) target a mechanism that influences 1326 of 5,258,194 steps (0.025%).

Goodhart: Depth is being maximized far out of proportion to the outcomes it proxies. P(depth>=4) is 0.363 vs reference 0.034 (10.7x) and meanPrefixDepth 3.05 vs 2.26 (+35%), but the actual bug-surface rates barely moved: h1 0.489->0.523 (+3.4 pp), h2 0.388->0.423 (+3.5 pp), h2b 0.417->0.433 (+1.6 pp), and h3 went DOWN, 0.342->0.337. A 10x move in the proxy buying <4 pp in the targets, with one target regressing, is the signature of optimizing the proxy.; The scheduler's interventions land on inert messages. acted_fraction is 0.504 over all 970,116 deliveries but only 0.112 for the 142,309 biased deliveries and 0.113 for the 139,347 delayed ones — a 4.5x deficit. The mechanism perturbs ~29% of deliveries and ~89% of those perturbations change no receiver state. Depth is going up because messages are being held, not because more distinct states are being reached.; Termination-reason contamination: 73.5% of runs end on iterations_exhausted. Deeper prefixes are partially an artifact of runs being cut off mid-plan (pending_work_at_exit_sum 14,026; planned_events_outstanding_sum 6,492). The metric that rewards depth is structurally correlated with the failure mode of not finishing the workload.; h2bRate was already found to be pinned (h2b-invariance-audit: 'pinned at 0.417 under every scheduler config', status closed) and it is still on the ladder, now reading 0.433. Carrying a near-invariant metric inflates the apparent width of the improvement front.; runsPerSec (142.4 -> 210.3) is on the metric ladder despite being a cost measure, not a quality measure, and a hypothesis (ablate-config-scoring-throughput, gain 3 / cost 2) is now proposed purely to reclaim 2% throughput. Optimizer effort is leaking into the speedometer.; Novelty credit is being paid for keys that are no longer novel: timeline_keys cumulative_distinct is 1,783 by run 601 and adds 1 key over runs 601-1080, yet all 1080 runs are scored and 221,605 key-instances are counted. Runs 301-1080 (72% of eval cost) contribute 57 of 1789 distinct keys (3.2%).; steer_authority reports 'honored: 4,129,806' of 5,258,194 steps (78.5%) in the same counter block as preference_honored: 1,326. The large 'honored' number reads as high authority in any summary, but preference was expressed only 2,726 times (0.052% of steps). This counter is trivially misread as evidence the mechanism works.

Utilization: aos=unexercised, dedup=unexercised, curriculum=unexercised, steer / steer_authority=unrewarding, steer_authority order/timer gates=broken, purgatory delay/bias=unrewarding, timeline-key novelty channel=unrewarding, feedback config_scoring=unrewarding, recovery_race=unrewarding, crash_anchor=healthy, crash_recovery=healthy, restarted-endpoint deliveries=unrewarding, rng_stream_isolation=scaffolding

Policy suggestions: Stop grading on unmeasurable rungs: delete P(depth>=8) (0 events at 54,000 runs, zero power) and demote P(depth>=7) (~108 events, ~20% relative detection floor) to reporting-only. Print the missing 'Current baseline' column or the ladder cannot support any accept verdict.; Unblock and run depth-power-floor-audit / eval-noise-floor-calibration BEFORE the next accept/reject. The sequential rule's 'separable' constant is unmeasured, which means all 14 merges and 42 closes rest on an uncalibrated threshold. Budget one full iteration (~35 min) to replicate the baseline config under 4 different seed sets and report per-metric SD; that is <2% of a day's 20 wall-h against a systematic error affecting 100% of verdicts.; Add termination-reason stratification to the grader immediately: report meanPrefixDepth and P(depth>=k) separately for plan_complete (n=286) and iterations_exhausted (n=794) runs. Until this exists, treat the +35% meanPrefixDepth and 10.7x P(depth>=4) as unattributed — 73.5% exhaustion makes 'deeper' and 'slower' indistinguishable.; Make acted_fraction a gate, not a readout. Any delay/bias/hold hypothesis must show it raises acted_fraction on the perturbed subset (currently 0.112-0.113 vs 0.504 population) or it is rejected regardless of depth movement. Promote bias-eligible-unselected-acted-control out of proposed; it is the control arm this whole family is missing.; Freeze the steer family (novelty-steer-authority-sweep 6/4.5, steer-authority-knob 6/3, steer-audit-readout 5/1.5) pending a single ablation. A mechanism that changes 1,326 of 5,258,194 steps (0.025%) cannot produce a detectable ladder move; running ablate-steer-authority-dead-gates (0 fires on both gates) first is the cheap decisive test.; Execute zero-utilization-mechanism-sweep-ablation now (proposed, 3/2.5) and delete aos, dedup, curriculum, and randomly_delay_msgs. Four mechanisms with exactly zero recorded activity are consuming build time (3.9 cargo builds/iter, 48 s) and proposal attention while being structurally unmeasurable in the graded config.; Cut evaluation cost using the saturation data: novelty-scored runs past ~run 300 add 3.2% of distinct keys for 72% of the run budget. Either cap novelty scoring at the saturation index and reinvest the freed runs into more config cells (raising per-cell N above the current noise-dominated 1000), or rotate the key space. Evaluate is 50% of iteration time; this is the single largest recoverable block.; Add a pre-implement feasibility gate and a post-implement abort ledger. Iterations 5272 and 5277 spent implement time (835.6 s in 5272) and never reached evaluate — ~13% of recent iterations. Require a build+smoke pass at <=120 s into implement before allowing further edits; current implement averages 22.5 edits and 384 s of model/think before anything is compiled against the grader.; Cap or eliminate rejudge (188.7 s/iter, 10% of tracked time). Route kind=meta/policy hypotheses that touch no spur/super code past evaluation entirely (policy-hypotheses-skip-evaluation, parked at 3/0.5) — that is a near-free reclaim of full evaluate cycles on hypotheses that cannot move the ladder by construction.; Reconcile the hypothesis census (header 112 with parked 35/proposed 15 vs ledger 114 with parked 41/proposed 11) and expose merge yield explicitly: 14 merged of 112 = 12.5%, against 42 closed and 41 parked. If parked+blocked (47) exceeds merged+proposed, the proposer is generating faster than the evaluator can adjudicate and the exploration quota (0.3) should be reduced until the backlog drains.

## 2026-08-27T06:45:00.000Z (operator) - why the steer does not steer, and three search strategies nobody has run

Two structural findings, both from reading rather than measurement, and both
about capability rather than tuning.

**The scheduler is three-quarters random by construction.**
`score_runnable` in `scheduler.rs` is `0.25 * novelty + 0.75 * priority`.
`priority` is a random draw taken when the runnable is created, from the
schedule policy; `novelty` is the timeline signal that saturates after two to
three hundred runs. So the ranking the steer can influence is a quarter of a
score whose other three quarters are a coin flip, and the quarter goes flat
early in a session. That is the arithmetic behind the 0.1% divergence rate
this document already records, and it predicts the failure of
`timer-vs-delivery-coverage-axis` in advance: sharpening a term weighted 0.25
cannot outvote a random term weighted 0.75.

It also says which interventions can work. The one place the scorer overrides
the randomness is the quick-fire branch, which boosts a `Recover` whose node
is currently crashed by reweighting against `quick_fire_multiplier`. A
structural boost for a named class of runnable is the shape that reaches the
decision; another scoring axis fed into novelty is not.

**Three of the four search strategies have never been run.** `spur-cli`
exposes `standard`, `genetic`, `aos` and `continuous`, and the harness
hardcodes `-e standard` at `runners.ts:197`, so no hypothesis can reach the
others - the evaluation lane cannot express them.

`aos` is a record-and-replay controller: a bandit over mutating a recorded
schedule tape and mutating the config, which is prefix-preserving
perturbation around runs that already went deep. It takes the ordinary
`ExplorerConfig`, so `general_vr.json` runs it unmodified. Measured on 5,000
runs at one seed against the standard explorer on the same envelope:

| rung | standard | aos | ratio |
|---|---|---|---|
| depth>=4 | 0.3606 | 0.4116 | 1.141 |
| depth>=5 | 0.0819 | 0.1040 | 1.269 |
| depth>=6 | 0.0167 | 0.0146 | 0.876 |
| depth>=7 | 0.00185 | 0.00200 | 1.080 |

`tape_wins` 1065 and `config_wins` 3885, against the zeros every utilization
capture has reported for this mechanism. The gain is not config drift: crashes
per run are 1.707 against the standard grid's 1.750. It does run 7.22 client
operations per run against 6.87, a five percent difference that is a partial
confound for a fourteen percent depth gain, and it costs throughput, 106
runs/s against 161, so per second of compute it currently yields fewer
depth>=5 runs than the standard explorer does. depth>=6 fell and depth>=7 has
about ten events, so nothing is established at the rungs that matter.

`continuous` is a conductor rotating over curriculum, curriculum-seeded
record-and-replay, and aos, with each mode's state persisting across slices.
Its config is the ordinary envelope plus `rotation`, `total_runs`,
`batch_size` and `decay_half_life_runs`, all defaulted.

Whether any of this is worth adopting turns on a question five thousand runs
cannot answer: does an adaptive strategy compound over a long session, or is
its early advantage a fixed offset that the standard explorer closes by
sampling more? That is the experiment to run before any harness change.

**Timer admission is a missing capability, not a tuning gap.** `strict_timers`
is a field on `PlanConfig` and is absent from `EXPLORER_CONFIG_KEYS`, and
`timer_gate_blocks` gates on `allowed_timers`, which only plan `AllowTimer`
events populate. The general grid therefore cannot admission-control timer
firing at all. Since the plan corpora violate at 76% at depth 8 against under
1.8% for the general grid and timer admission is the difference, this is the
largest untried lever, and it is untried because the capability does not
exist rather than because the knob is set wrong.

## 2026-08-27T07:40:00.000Z (operator) - the client workload is front-loaded relative to faults, and half the runs cannot match the chain's first event

Two facts measured on 30,024 general-config runs at the merged settings, plus
a correction to how the depth ladder should be read.

**The workload is spent before the faults arrive.** Among the 4,909 runs where
two distinct nodes crash and recover:

| | runs | share |
|---|---|---|
| every write invoked before the first crash | 3880 | 79% |
| a write invoked after both recoveries | 428 | 8.7% |
| a write completing after both recoveries | 176 | 3.6% |
| a write invoked before the crash that never answers | 3458 | 70% |

The oracle chain is a write, then faults, then a second write. In four runs out
of five there is no second write left to issue, because six to twelve client
requests become eligible at once against one to three crashes, so every
invocation has been made by the time a crash is selected. The writes that were
outstanding stall across the crash and never answer. Nothing in the plan
generator guarantees client work survives a fault, and this is not an artifact
of declaration order: `generate_plan` shuffles the node list before the
probabilistic dependency pass. Seeded as `client-work-after-every-fault`.

**Half the runs cannot match the chain's first event.** The oracle names node 0
for `w1`, `w2` and all three reads. The generator picks each client operation's
destination with `rng.random_range(0..num_servers)`, so with three servers only
a third of operations address node 0, and only 15,914 of 30,024 runs (53%)
contain a write to node 0 at all.

**Consequently depth is not one quantity.** `rootAnchoredPrefix` in
`matching.go` skips labels with zero candidates and promotes their successors
to roots, which is deliberate and has a test. When `w1` is unmatchable the
chain is anchored at `crash_nl` instead, so a depth of k in such a run counts a
different k vertices than in a run where `w1` matched. Roughly half of every
sample is being scored on a chain that never contained the first write. This
is not a bug report against the grader - contraction is the right behavior for
a plan-mode metric reused in general mode - but it does mean P(depth>=k) mixes
two populations, and comparisons between mechanisms are only clean if they do
not shift the proportion.

**Correction to my own earlier entry.** An earlier draft of this observation
claimed the second write was rung 6 or 7 and that the delivery downstream of it
already succeeded 72% of the time. Both were wrong. They came from mapping
ladder rungs onto DAG vertices by eyeballing survival rates, and from checking
each chain step for existence independently while the grader solves a joint
assignment with injectivity over 200 swaps. A greedy earliest-match
reconstruction of the literal chain gives depth>=4 at 0.0022 against the
grader's 0.365, so the two are not measuring the same thing and no rung
attribution in that draft should be trusted. The workload numbers above were
measured directly from executions and do not depend on the mapping.

The general lesson, worth keeping: do not infer what a rung means from its
survival rate. Read the metric's implementation or measure the events by name.

## 2026-08-27T07:15:00.000Z (operator) - the evaluation lane does not share the machine

Recorded because it cost two chunks and because it kills an idea that looks
attractive.

Running a second explorer on four of sixteen cores, alongside the loop, made
two of iteration 5281's chunks exceed the 900-second explore wall and return
`ok=false runs=0`. A normal chunk explores in about 250 seconds, so the wall
carries roughly a 3.6x margin at full CPU, and four competing threads were
enough to spend it.

The harness handled it correctly and this is worth knowing: `pooledCountsOf`
skips evaluations with `ok=false`, so a failed chunk contributes nothing to the
pooled counts rather than contributing zeros. The verdict rests only on chunks
that succeeded. Failure costs seeds and wall time, not correctness, and trips
an error only at three consecutive or `maxChunks` total.

What it rules out: a long-running search lane sharing the machine with the
evaluation lane. The appeal is real - the loop spends all of its compute on
controlled A/B measurement and none on simply searching for a violation, which
is the actual objective - but any such lane starves the wall it runs beside. If
a hunt is worth running it has to replace the loop for a defined window, not
run beside it.

Two smaller consequences. Throughput figures measured while anything else runs
are worthless, so the runs-per-second numbers in any concurrent experiment
should be discarded while its per-run rates survive, since run counts are
seed-deterministic. And the right place for operator compute is the boundary
stop, when the loop is down and the machine is idle regardless.

## 2026-08-27T07:55:00.000Z (operator) - the three unrun explorers, measured; none of them is a win

Measured with the loop stopped, 14 threads, 30,000 runs per arm, same config
envelope and the merged binary. Earlier figures in this log for these arms were
taken while the loop was running and are superseded: their per-run rates were
sound, since run counts are seed-deterministic, but every throughput number in
them was contaminated.

| | standard | aos |
|---|---|---|
| throughput | 211.4 runs/s | 185.2 runs/s |
| mean prefix depth | 3.0527 | 3.1769 |

| rung | per-run ratio | per-second yield |
|---|---|---|
| depth>=4 | 1.121 | 0.981 |
| depth>=5 | 1.190 | 1.042 |
| depth>=6 | 1.064 | 0.932 |
| depth>=7 | 0.760 | 0.666 |

Violations were zero in every arm, as everywhere else.

`aos` costs 14% throughput and returns 12 to 19% more depth-4 and depth-5 runs
per run, which nets to break-even per unit of compute and to a loss at the
rungs past that. `continuous` was measured at the same run count and is worse
than either at every rung past 4 - depth>=5 0.0476 against standard's 0.0867 -
while carrying the higher mean prefix depth, which is a clean demonstration
that mean depth reports the shallow end and should not be used as a headline.

The whole direction is therefore a negative. That is worth knowing: three
search strategies existed in the binary, none had ever been run, and the
natural assumption was that the unexplored ones held headroom. They do not, on
this workload.

**A small-sample error, made three times in one session, worth naming.** An
`aos` arm of 5,000 runs put depth>=7 at 2.75 times standard, on 22 events. At
30,000 runs the same comparison is 0.760, on 41 events against 54. The ratio
did not shrink, it inverted. The same shape of error produced a 1.62 estimate
from a 2,160-run probe that the 54,000-run chunk did not reproduce, and a 72%
conditional from independent existence checks where the grader solves a joint
assignment. In each case the sample was labelled underpowered and the number
was quoted anyway. A ratio over fewer than about fifty events is not a
measurement and does not belong in a summary.

What survives from the exercise is a capability rather than a result. The
harness hardcoded `-e standard`, so no hypothesis could reach the other three
explorers; `evaluation.explorer` now exists and defaults to standard. There is
no reason to use it today.

## 2026-08-27T08:10:08.568Z

**client-work-after-every-fault** (auto_merge): Merged (auto_merge, 2 seeds x 54k runs, seeds 1000/1001, both stable). Forcing one mandatory RecoverNode -> client-request edge per crash/recover pair is a real but modest win: depth>=4 +0.63pp, depth>=5 +2.55pp (primary), depth>=6 +0.22pp, depth>=7 +0.04pp; violations still 0 at 108k runs, h2 flat (+0.004pp). Cost was negative, not positive: throughput rose +6% (223 runs/s) rather than falling, so the predicted 'surviving client work lengthens runs' penalty did not materialize at k=1 -- the extra edge is nearly free, which implies the plans it produces are short-tailed and that k=1 is far from any budget limit. The prediction that failed is the one about unpairedFraction: it stayed at 0.495/0.497, essentially the pre-change level, so we are not converting stalled writes into completing ones. Combined with the depth gain, the reading is that the mechanism succeeds at *issuing* client work after a fault but that work is itself largely unanswered -- the binding constraint has moved from 'no op exists after the fault' to 'the op that exists after the fault never completes', presumably because nothing prevents the next crash/timer from landing on it before quiescence. Caveat on the evidence: the falsifier counter post_fault_ops.ops_invoked_after_last_recover was implemented but is not surfaced in the harness metrics block, so wiring was confirmed only indirectly via the depth movement; the depth>=5 headline should also be discounted per the hypothesis's own note that only depth>=4 is stable to a tenth of a percent, making the honest effect size ~0.6pp, not 2.5pp. General config params 15 -> 16.

## 2026-08-27T08:15:00.000Z (operator) - guaranteeing client work outlasts a fault moved depth>=5 by 29%

`client-work-after-every-fault` merged at iteration 5282 on a superiority
separation, `depth>=4 separated at z 2.7`, which is the first such verdict in
the visible record; every other merge advanced on non-inferiority.

Paired evaluation, 108,000 runs:

| statistic | ratio | pGreater | pMei | bar |
|---|---|---|---|---|
| depth>=4 | 1.0176 | 1.00 | 0.908 | +1.1% |
| depth>=5 | 1.2955 | 1.00 | 1.000 | +2.3% |
| depth>=6 | 1.1493 | 1.00 | 0.997 | +5.6% |
| h2 | 1.0000 | 0.507 | 0.011 | +1.0% |

Replicated on the refreshed baseline, two independent 216,000-run samples:

| statistic | before | after | ratio |
|---|---|---|---|
| depth>=4 | 0.36216 | 0.36696 | 1.013 |
| depth>=5 | 0.08649 | 0.11194 | 1.294 |
| depth>=6 | 0.01453 | 0.01653 | 1.138 |
| h2 | 0.42513 | 0.42476 | 0.999 |

The paired and unpaired estimates agree to two decimal places on the rung that
moved. Against the recorded null-diff floors, -1.44% at depth>=5 and 7.5% at
depth>=6, the first is about twenty times the floor and the second about twice
it. h2 flat to a tenth of a percent is the signature of a mechanism that
reorders client work and touches nothing about delivery.

Regression passed all four cases and the predicted throughput cost did not
appear: 209.5 rps against 205.9, ratio 1.017. Longer runs, not slower ones.

Cost: one config key, `post_fault_client_ops`, taking the graded config from 15
to 16. That is a real price under the parameter rule and the first merge of the
night that was not free.

**What actually did the work was the measurement.** In 79% of runs where two
distinct nodes crashed and recovered, every write had been invoked before the
first crash, so the chain's second write had nothing left to match. The
mechanism is three lines of edge-adding in the plan generator; the finding was
that four families of falsified hypotheses had been optimising the segment
downstream of a starved step.

**What this is not.** Violations are still zero, here and in every corpus
measured this session. depth>=7 rose 23% and depth>=8 by two runs in 108,000,
and neither is a measurement - roughly 45 and 2 events per 54,000 runs. The
defensible claims are depth>=4, depth>=5 and depth>=6. A proxy moved a long
way; the goal did not move at all, and general-config depth-8 runs remain
linearizable.

## 2026-08-27T08:45:00.000Z (operator) - the steer's authority was raised 135-fold and the ladder did not move

`starvation-gated-timer-admission` was rejected at iteration 5283 after 108,000
runs, with every frontier rung inside the noise: depth>=4 +0.00085 absolute,
depth>=5 -0.00050, depth>=6 -0.00003, h1 -0.00064, h3 -0.00032, violations 0.

The mechanism was not inert. Matched 1,080-run captures either side:

| counter | before | after | |
|---|---|---|---|
| steer_authority.preference_expressed | 2648 | 205317 | 78x |
| steer_authority.preference_honored | 1326 | 179618 | 135x |
| steer.divergent_picks | 1201 | 17873 | 15x |

Divergence went from 0.052% of evaluations to 0.77%. This document has held
that the steer diverging in about a tenth of a percent of evaluations is the
core weakness, and that "making it actually steer is worth more than any single
mechanism riding on it". The steer was made to steer, fifteen times harder, and
nothing downstream responded.

That does not settle which of two things is true, and they imply opposite work:
authority was never the constraint and the steer is now expressing a wrong
preference more often; or this particular preference is not a heuristic at all,
so the experiment tested the vehicle rather than any destination.

The second reading is the live one, because the predicate turned out to be
close to vacuous. `timer_admission` recorded 5,078,499 offers of which
5,071,221 - 99.86% - were already at a node with an empty local queue. "Prefer
a starved node's timer" is therefore "prefer every timer", and the 87:1 ratio
between `fired_starved` and `fired_busy` is the base rate rather than
selectivity. What was actually tested is a uniform upweighting of timer firing,
which is what `timer-weight-response-curve` already tested and closed.

That is the process failure worth recording. This document asks that a
hypothesis in an already-falsified family carry an argument for why it differs
from the one tried before. The argument offered was that a structural boost
reaches the decision where a weighting change cannot, and the counters show the
boost did reach the decision - but because the gating predicate was almost
always true, the intervention collapsed into the weighting change it claimed to
differ from. The check that would have caught it costs nothing: measure the
base rate of a gating predicate before proposing a mechanism that gates on it.

Cost: one config key, evaluated and now closed, so the key should be removed
rather than left in the tree as a parameter nobody uses.

What survives: the steer can be given real authority cheaply, and the knowledge
that authority alone buys nothing. Any future proposal to strengthen the steer
now has to name the preference it wants expressed and show that preference is
selective.

## 2026-08-27T08:43:08.176Z

**starvation-gated-timer-admission** (closed): Null on both seeds. 2 chunks x 54k runs (seeds 1000/1001) on general_vr/VR.spur: violations 0/0 (as always on this grid), meanPrefixDepth 3.067 vs 3.071, depth>=4 delta +0.0008, depth>=5 -0.0005, depth>=6 -0.00003; pMei on the only rungs with resolution was 0.039@d4/+1%, 0.012@d5/+2%, 0.032@d6/+5% -- no frontier rung can reach a separable effect, so the sequential test rejected before chunk 3. Config params 16->17 with zero return; regression flag came back false. The mechanism itself is cheap and clean (one new key, currently_crashed's sibling threaded through score_runnable), so the cost estimate of 5 was roughly right and the gain estimate of 4 was not.

The important negative is methodological, not scientific: the hypothesis shipped its own falsifier (timer_admission.fired_starved vs fired_busy) and the falsifier was unreadable. util_stats counters do not appear in the sequential evaluation record -- metrics carries only runs/rates/depthAtLeast/violations -- so we closed this without knowing whether the multiplier ever reached the decision. Two indistinguishable worlds remain: (a) the reweight fires as designed and starvation-gated timers simply do not deepen VR prefixes, or (b) a multiplier applied to the 0.25*novelty + 0.75*priority sum is swamped by the priority coin flip and the branch never changed a selection. The parent hypothesis' own rationale argued (b) is the ambient risk for anything touching score_runnable, and we have no data to exclude it. Until util_stats is in the record, every future structural-scorer probe on this axis inherits the same blind spot and its null is uninterpretable.

Secondary observation worth carrying: this grid is depth-limited, not violation-limited. maxPrefixDepth stayed at 8 with 4-6 runs reaching it out of 54k; d7/d8 counts (108/112, 4/6) are pure noise floor. Any hypothesis whose predicted effect lives above d6 is currently untestable at 54k-run chunks regardless of merit -- the sequential test will reject it for lack of resolution, not for lack of effect. The 76%-at-depth-8 plan-corpus gap named in the goal document cannot be attacked one scorer knob at a time through this measurement setup.

## 2026-08-27T08:49:50.317Z

**post-fault-client-ops-sweep** (closed): The sweep never produced usable dose-response data: it was closed on lint, not on science. Two of the three configs (scheduler_configs/loop/general_vr_post_fault_ops_1.json and _3.json) are inert — no runner loads a per-k config file, so writing sibling JSONs is not a valid way to vary a knob in this harness. Only the k-value baked into general_vr.json actually ran, and the recorded objective deltas (depth>=4 -0.367, depth>=5 -0.112, h2 -0.425) reflect whatever single perturbed setting landed in the live config rather than a k=1/2/3 comparison. Regression also failed. Two transferable lessons: (1) parameter sweeps must be driven by the existing runner's config-loading path (mutate the loaded config / pass a sweep arg), never by adding sibling config files the runner never reads; (2) the cycle-guard question the sweep was meant to answer — the edges_added/pairs_seen ratio — is still completely unmeasured, so both post_fault_client_ops children remain blocked on an unknown that a single instrumented run could resolve far more cheaply than any sweep.

## 2026-08-27T09:20:00.000Z (operator) - a mechanism's throughput cost is not a constant

`ablate-config-scoring-throughput` merged at iteration 5285 and reclaimed 17.9%
throughput: 256.1 rps against 217.3 in the interleaved A/B, both rounds tight
(256.4/255.9 against 217.0/217.5), with every ladder delta inside the noise and
violations 0. The hypothesis predicted 2%.

The same mechanism was measured in the other direction five iterations earlier.
`enable-cfg-feedback-general-config` at 5276 recorded ratio 0.993, a cost of
0.7%. The A/B structure is identical in both: `regression.ts` builds the
baseline arm from `general_vr.json` as it stands on the research branch and the
candidate arm from the candidate's own config, so 5276 compared
[without config-scoring] against [with] and 5285 compared [with] against
[without]. Same comparison, opposite sign, and the magnitudes differ by about
twenty-five times.

What changed in between is the workload. `client-work-after-every-fault` merged
at 5282 and makes client operations outlast faults, which lengthens runs.
Config-scoring is per-run work, so its cost scales with run length. That is the
most likely explanation and it is not verified; `recovery-window-length-census`
also merged in the interval and added per-run telemetry behind a mutex, which
could contribute.

The finding worth keeping is independent of which of those it was. A mechanism's
throughput cost is a function of the workload, not a property of the mechanism,
and the loop records perf verdicts as though they were durable. This one aged by
a factor of twenty-five in six hours and five iterations. Two consequences:

- A throughput number in an old decision record is evidence about the workload
  of that iteration, not about the mechanism. Do not carry it forward.
- An ablation of a mechanism previously measured as cheap can still be worth a
  large reclaim, so "we already know it costs almost nothing" is not a reason to
  skip one.

The reclaim itself multiplies everything downstream: 17.9% more runs per second
shortens every future evaluation and raises the bug-finding rate by the same
factor at constant probability per run.

## 2026-08-27T09:27:58.761Z

**ablate-config-scoring-throughput** (auto_merge): Ablation merged (auto_merge, non-inferior): config-scoring branch removed from feedback.rs/util_stats.rs/explorer.rs + flag dropped from general_vr.json, 2 seeds x 54k runs, grader pinned ta:9b8ed8b+porc:8de73a4. Violations 0/0, unknown 0/0 — no correctness cost. Objectives all noise-scale: primary -0.00024, depth>=4 +0.00142, depth>=5 -0.00024, h2 +0.00027. Note depth>=4 landed at +0.00142, just outside the pre-registered +/-0.001 band, but in the *favorable* direction and far inside within-arm seed spread — the band was mis-set, not the mechanism. Two independent conclusions: (1) config_scoring is confirmed inert on VR — it fired (counters live per the telemetry precondition) yet contributed nothing to depth, so a whole cross-run reweighting surface is gone for free; (2) the parent's headline '2% throughput cost' does not survive scrutiny. Measured runs/sec were 243.6 (s1000) and 248.7 (s1001) — a 2.1% spread *within the same arm, same code, two seeds* — while the reclaimed throughput delta was +0.105, i.e. ~0.04% of the ~246 runs/sec operating point. The parent's -0.139 was likewise ~0.05%, and the 204.0 'baseline' it was quoted against is stale hardware state. So the cost we paid to justify this experiment was never measurable, and the reward we booked isn't either. Methodological floor established: with n=2 seeds, throughput claims below ~2-3% are indistinguishable from seed noise, and any pre-registration quoting an absolute runs/sec baseline from an earlier hardware epoch is invalid on arrival. Also: generalConfigParams before=16 after=16 — deleting the flag did not shrink the counted config surface, so the 'shrinks the search space' half of the rationale did not cash out under the current parameter accounting either. Net: a clean, cheap dead-mechanism removal with zero regression; the throughput and search-space stories were both artifacts of unnormalized single-digit-noise reporting.

## 2026-08-27T09:33:10.927Z

### Audit @5285
Evaluation dominates: 1667s/iteration mean (~72% of the ~2318s mean total), with regression adding 171s and rejudge 221s. Implement is 283s mean but the last-15 activity breakdown shows 367s/iter of model/think plus 52s build, 3.9 cargo builds and 19 edits per iteration — i.e. implement wall-clock in recent iterations is far above the ledger mean (recent iterations run 30-70 min end to end; 5281 spent 3311s in evaluate alone). Propose is effectively free (0.4ms) because the pool is pre-stocked with 20 proposed hypotheses, so no new search is happening. One sequential chunk = 54000 runs at 222 runs/sec ≈ 243s; 2-4 chunks plus a 4-chunk baseline hold means most of the evaluate budget is re-measuring an already-held baseline. Roughly 90% of wall time buys statistics on effects that the last 15 merges have not moved.

Goodhart: meanPrefixDepth/P(depth>=k) are drifting AWAY from the reference (2.26 -> 3.08; P(d>=4) 0.034 -> 0.369, 10x) while violations stays pinned at 0. Depth is being maximized as an end in itself with no demonstrated coupling to found violations.; h1/h2/h2b/h3 rates now all EXCEED the reference (0.503 vs 0.489, 0.426 vs 0.388, 0.431 vs 0.417, 0.354 vs 0.342) — the ladder no longer discriminates 'better' from 'different', so any change that perturbs scheduling scores as a win.; Merging on sub-SE deltas (+0.002 h2Rate, +0.01 meanPrefixDepth) accumulates 17 merges of noise; the baseline has ratcheted upward without any single merge being individually defensible.; termination: iterations_exhausted = 750/1080 runs (69%) and pending_work_at_exit_sum = 14006. Deeper 'prefix depth' is partly an artifact of runs that never complete their plan — depth gains may be bought by burning the 6000-step budget rather than by exploring more interleavings. runsPerSec also rose 142 -> 223 vs reference, consistent with cheaper/truncated runs.; ordered_h3 by_fault_events shows h3 is structurally impossible for 534/1080 runs (buckets 1-3 have runs_with_h3 = 0), so h3Rate is really a mixture of a config-grid composition effect and a scheduling effect; changes that shift which fault-event bucket runs land in will move h3Rate without improving exploration.

Utilization: aos=unexercised, dedup=unexercised, curriculum=unexercised, steer_authority=unrewarding, feedback.cfg_score (config scoring)=broken, purgatory delay/bias=unrewarding, recovery_window=healthy, crash_anchor=healthy, post_fault_ops (client-work-after-every-fault)=scaffolding, timeline_keys novelty=unrewarding, rng_stream_isolation=healthy

Policy suggestions: Freeze merges until depth-power-floor-audit (gain/cost 5/0.5) and eval-noise-floor-calibration run. Both are cheap and both directly gate the validity of every verdict the loop has issued; running them costs <1 iteration and retroactively values or invalidates 17 merges.; Adopt noise-floor-gated-verdicts: require |delta| >= 3x the measured per-seed SE on the primary metric before merging. Under the current 54000-run chunk that is roughly >=0.006 on P(d>=4) and >=0.03 on meanPrefixDepth — none of the last several merges would qualify, which is the point.; Stop reporting/judging on P(depth>=7) and P(depth>=8). At 0.002 and 0.000 they carry no information; declare the power floor at depth>=5 (0.111, SE ~0.0014) and reject hypotheses whose only claimed effect lives above it.; Re-open enable-cfg-feedback-general-config as a failed merge: cfg_score_sum = 0.0 with scored_runs = 1080 proves the path is still dead. Either fix it or take ablate-config-scoring-throughput and reclaim the ~2% runsPerSec.; Batch the three zero-activity mechanisms (aos, dedup, curriculum) and the two never-firing steer_authority gates (blocked_by_order = 0, blocked_by_timer_gate = 0 over 5.1M steps) into one deletion PR. This is zero-risk by construction — code that never executes cannot change a metric — and it shrinks the surface the proposer keeps generating hypotheses about.; Add a termination guard to the ladder: report meanPrefixDepth conditioned on plan_complete runs separately from iterations_exhausted runs (currently 750/1080 = 69% exhaust their budget). Without this split, depth gains from truncated runs are indistinguishable from real exploration gains.; Cut the baseline hold from 4 chunks to 2 and cache it across iterations. Evaluate is 1667s/iter mean (72% of wall); re-measuring a stable baseline every iteration is the single largest recoverable waste in the ledger.; Require every new 'add' hypothesis to name the counter that will prove it acted AND a pre-registered threshold on that counter, following the delivery_effects precedent — purgatory ran 213,876 delayed sends at a 0.109 acted_fraction before anyone noticed it was mostly moving inert messages.; Route kind=meta/policy hypotheses that touch no spur/super code past evaluation entirely (policy-hypotheses-skip-evaluation, cost 0.5, currently parked). At 1667s/iter of evaluate, skipping even a third of meta hypotheses pays for the audits above.; Escalate the fact that violations = 0 for reference, baseline, and all 17 merges to a first-class problem: the loop has no discriminating outcome variable. Either introduce a workload with known injectable violations to calibrate whether depth predicts detection, or accept that the depth ladder is an unvalidated surrogate and say so in the status header.

## Where to read a mechanism's own counters

`spur explore` now writes its utilization counters twice: to
`<output-dir>/utilization.json` as before, and to a sibling file
`<output-dir>.utilization.json`. The sibling copy is the readable one. Every
consumer that batches runs deletes the output directory once the corpus has
been checked and graded, which used to take the counters with it; the sibling
survives, so a run's counters can be read afterwards and attributed to that run
by its directory name.

For loop evaluations this means each chunk leaves
`tmp/loop/eval-<hypothesis>-<fidelity>-<seed>.utilization.json`, including the
chunks run for the baseline arm under the id `baseline`. A hypothesis that
pre-registers a falsifier in terms of a counter can therefore read that counter
from the same runs the verdict was computed on, and difference it against the
baseline chunks, without re-running the explorer on a separate small sample.
Counts are raw and per chunk: divide by `rng_streams.isolated_runs` or
`termination.runs` to get a per-run rate, and note that a chunk killed at its
wall clock writes no counter file at all.

The practical consequence for reading a null result: a counter file whose new
field is zero says the mechanism never fired, which is a different finding from
a nonzero counter with a flat ladder, and the two used to be indistinguishable.

## 2026-08-27T09:40:00.000Z (operator) - depth was not bought by exhausting the step budget

The audits at 5275, 5280 and 5285 each argue that depth gains may be an
artifact of runs being cut off mid-plan, since about 70% of runs exit via
`iterations_exhausted`. The earlier entry here answered the general form of it:
depth is flat across a sixteenfold range of `max_iterations`, so the budget is
not what sets depth. This answers the specific form, for the merge that
actually moved the ladder.

Termination counters over matched 1,080-run captures:

| iteration | exhausted | plan_complete | steps used |
|---|---|---|---|
| 5281, before the merge | 783 (72.5%) | 297 | 5,201,508 |
| 5283, after it | 763 (70.6%) | 317 | 5,159,558 |
| 5285, after the ablation too | 750 (69.4%) | 329 | 5,040,362 |

If depth were bought by burning the budget, exhaustion and steps used would
rise with it. Both fell while depth>=5 rose 29%. More runs finish their plan,
consuming fewer steps, and reach deeper. The mechanism raised the productivity
of a step rather than spending more of them, which is the opposite of the
alleged artifact.

Two notes for reading future audits. The exhaustion share is a stable property
of this workload, not a signal: it has sat between 69% and 73% across every
capture in the record, including ones where nothing merged. And a charge of
this shape should be answered with the termination counters either side of the
specific merge, which takes one query, rather than argued about in the
abstract.

## 2026-08-27T10:05:00.000Z (operator) - depth 8 has been reached 76 times and has never once violated

Summed over every evaluation record in `research/evaluations/`: 49 sessions,
1,809,000 graded general-config runs, 2,025 runs at depth>=7, 76 runs at
depth>=8, and 0 violations.

`findbug_archive` violates on 266 of its 372 depth-8 runs, 71.5%. If that rate
transferred, 76 depth-8 runs would have produced about 54 violations. The
probability of seeing none is around 1e-41. The one-sided 95% upper bound on
the general config's violation rate at depth 8 is 3.9%, so the two populations
differ by at least eighteenfold.

This document already says the ladder is saturated and blind at depth 8 and
that the discriminator is timer admission. What is added here is the sample
size that turns that from a suspicion into a settled fact: it is not that
depth-8 runs are too rare to have shown a violation yet. There have been 76 of
them and the expected count under the plan-corpus rate is 54.

The consequence for direction is uncomfortable and worth stating plainly. Depth
is the metric the loop optimises, the gate separates on, and every merge is
judged by. Its top rung has now been reached often enough to establish that
reaching it is not sufficient, so a mechanism that raises P(depth>=k) is buying
more of something already shown not to carry the bug. The 29% gain at depth>=5
recorded above is real and was measured correctly; what it is worth toward the
objective is unestablished, and the honest reading is that nothing in the depth
ladder has yet been shown to predict a violation in the general config.

What that leaves. The distinguishing feature is not in the graded set - the
violating and non-violating depth-8 runs are identical on every feature the
grader computes. Timer admission is the candidate this document names, and it
is a missing capability rather than a mis-set knob: `strict_timers` is a
`PlanConfig` field, absent from `EXPLORER_CONFIG_KEYS`, and `timer_gate_blocks`
gates on `allowed_timers`, which only plan `AllowTimer` events populate. A
general mechanism that makes timer firing admission-controlled would be the
first intervention aimed at the thing that actually separates the corpora,
rather than at a rung that does not.

## 2026-08-27T10:11:04.219Z

**util-stats-in-eval-record** (auto_merge): Merged on non-inferiority, not on its own falsifier. Two sequential chunks (seeds 1000/1001, 54k runs each) show the metrics record still carrying only runs/runsPerSec/h*Rate/depthAtLeast/violations/unknown/porcupineWallMs — no utilStats key, empty or otherwise. Diff summary explains why: the change touched spur-cli/src/main.rs (spur side) plus research/observations/OBSERVATIONS.md, and nothing in the super-side evaluation harness. So the emit half may exist but the parse/copy half does not; the chunk record is produced by the harness's own metrics extraction, which drops any field it does not know. Falsifier verdict: FAILED (record contains no utilStats for either arm), despite verdict auto_merge — the gate passed on objective non-inferiority only. Objective deltas are pure noise as expected for instrumentation: violations 0/0, depth>=4..8 deltas 8e-4..0, primary -5.5e-4, params unchanged 16->16; throughput -1.4% (235.8 vs 249.4 runs/s across the two chunks is within seed-to-seed spread, not attributable). Consequence: the original blocker stands. Any hypothesis stating a falsifier in util_stats counters (starvation-gated-timer-admission, client-work-after-every-fault/post_fault_ops) still cannot read it, and a null from those remains undiagnosable between 'fired, no effect' and 'never fired'. Cost of the lesson is low (~7.5 min explore wall per chunk) but the enabling debt is unpaid; the next attempt must land on the super side and must self-verify by asserting the key exists in chunk 1 rather than by merging clean.

## 2026-08-27T10:45:00.000Z (operator) - two ways of favouring timers, both closed, and what they say admission is not

Two hypotheses aimed at the timer lever this document names, in one night.

`starvation-gated-timer-admission` (5283) boosted a timer's score when its node
had no other queued work. The boost reached the decision - steer
`preference_honored` went 1,326 to 179,618 - and every frontier rung stayed
inside the noise over 108,000 runs. The gate turned out vacuous: 99.86% of
timer offers were already at a node with an empty queue, so it was a uniform
upweighting, which `timer-weight-response-curve` had already closed.

`deliver-hold-while-timer-pending` (5287) withheld deliveries to a node while
one of its timers was eligible, so the timer would win the race. This gate was
genuinely selective - 356,181 holds taken of 1,188,225 offered, and 209,296 of
those let the timer fire first - and it was rejected for making things worse:
depth>=4 ratio 0.991, depth>=5 pGreater 0.0005, every pMei zero.

The reason is in the termination counters, and it was visible before the first
chunk landed: `iterations_exhausted` rose 750 to 802 and `plan_complete` fell
329 to 278. Holding deliveries stalls plans, and a truncated run satisfies
fewer chain events, so depth falls.

That is also the cleanest disconfirmation available of the recurring audit
claim that depth is an artifact of runs being cut off mid-plan. Two cases now
point the opposite way: the merge that raised depth>=5 by 29% reduced
exhaustion, and this mechanism, which really did cut runs off, reduced depth.
Stalling costs depth rather than inflating it.

What the two failures together say about the lever. Neither reproduced what a
plan does. A plan does not reweight timers against deliveries at run time, and
it does not hold deliveries to win a race. It gates whether a labeled timer may
fire at all, and it opens that gate at a point fixed by dependencies on other
events - `w1` then `allow_t1` then `crash_nl` in the graded chain. The
mechanism that matches it is admission tied to the progress of the run, not
priority and not blocking. `strict_timers` is a `PlanConfig` field absent from
`EXPLORER_CONFIG_KEYS`, and `timer_gate_blocks` reads `allowed_timers`, which
only plan `AllowTimer` events populate, so the general config has no way to
express that today.

Anyone proposing the third attempt should say which run-progress condition
opens the gate, and measure how often that condition already holds before
building it.

## 2026-08-27T10:40:53.108Z

**deliver-hold-while-timer-pending** (closed): Admission-side delivery holds do not buy depth on VR/general. 108k runs across 2 seeds: every depth rung moved negative or within noise (d4 -0.32pp, d5 -0.36pp, d6 -0.11pp, d7/d8 ~ -0.01pp), pMei 0.000 at +1%/+2%/+5% for d4/d5/d6 — sequential test could not find any rung where a separable positive effect was even reachable, so it rejected after 2 chunks. Violations stayed 0. The one non-trivial magnitude is h3 -0.89pp: withholding deliveries measurably slows runs toward the deepest handler-coverage predicate without producing compensating prefix depth, i.e. the hold is delay-only as designed but the delay costs progress rather than winning a useful race. Combined with the earlier steer-side attempt on the same timer-vs-delivery ordering axis, both sides of that axis (position and admission) are now null-to-negative on this spec; the earlier 'timer removal moves a rung by an order of magnitude' observation should be read as timers mattering as *events*, not as an exploitable ordering race against deliveries. Caveat that bounds the strength of the refutation: the shipped gate was deliberately weak (hold_probability 0.3, max_nodes_held 1, max_hold_steps 8), so the near-zero deltas are consistent with an inert knob as well as with a wrong hypothesis; the run record here does not establish that holds_taken / timer_fired_after_hold were ever nonzero. Cost side is unambiguous: +1 general config param (16→17), regression not passed.

## 2026-08-27T11:05:00.000Z (operator) - the hold band that mattered was 100 to 300 steps, and the rest was slack

`bisect-purgatory-hold-range-300` merged at 5288, narrowing
`delay_duration_range` from [5, 1000] to [5, 300] with depth>=4 ratio 0.9992,
depth>=5 0.9937 and throughput 1.002 over 108,000 runs. Cutting 70% off the top
of the range costs nothing measurable.

That corrects an implication of the earlier entry here, which argued for [5,
1000] on the grounds that 31% of its draws exceed the 192-step median
requirement. Log-uniform over [5, 300] puts only 10.9% of draws above 192 and
performs identically, so the effect saturates at a much lower rate of long
holds than that reasoning assumed. The argument for widening was right about
where the requirement sits and wrong about how much of the distribution needs
to sit above it.

What the two results together locate is a band. [5, 100] places no draw above
100 steps and was the state before; [5, 300] places 26.8% above 100 and carried
the whole gain; [5, 1000] adds a further 22.7% above 300 and adds nothing. The
holds that matter are the ones between roughly 100 and 300 steps, which is
where the measured requirement lives - median 192, p90 338 - and the tail past
that is slack.

Two things worth carrying. A range parameter can be right about its lower bound
and wasteful about its upper one, and the cheap test is a bisection, which the
loop found on its own here. And an effect that saturates in the distribution
should be described by the band that produces it rather than by the range that
happens to contain the band; the earlier entry named the wrong quantity even
though its measurement was sound.

## 2026-08-27T11:13:41.177Z

**bisect-purgatory-hold-range-300** (auto_merge): Falsified as stated, in the direction the red-team note predicted: [5,300] is statistically indistinguishable from [5,1000] on every rung (d4 -0.00026, d5 -0.00069, d6 +0.00021, d7/d8 ~0; h2 -0.0071, within the ~0.006 seed spread seen between 1000/1001 on prior runs). Both seeds landed nearly on top of each other (d4 19728 vs 19846, d5 5989 vs 6008, d6 916 vs 865, d7 106 vs 117, d8 3 vs 3 of 54000), so seed noise is small and the null is real, not underpowered at rungs 4-6. Conclusion: the purgatory hold-duration dose-response SATURATES somewhere at or below 300 steps — the entire gain from the [5,1000] widening is already captured by a cap near the p90 span (~338), and the extra 700 steps of tail bought nothing and cost nothing. The 'long tail delays the post-recovery client write' mechanism is therefore not operating at measurable magnitude. Corollary, now firm: the top-rung 'cost' seen in the parent was noise — d7 counts are ~100/54000 and d8 is literally 3/54000, so no decision at depth>=7 or 8 is supportable at this run budget by any config change, and any hypothesis whose success criterion is stated in terms of d7/d8 is untestable as written. Merged as non-inferior; [5,300] is preferred over [5,1000] only on the meta-grounds that a p90-sized rule is a statable, transferable rule while 'range = run length' is not. Further bisection of this single knob is exhausted: the response is flat between 300 and 1000, so the only remaining unknown is the knee between 100 and 300, which is worth at most the ~+0.01 d4 already banked.

## 2026-08-27T11:40:00.000Z (operator) - the coverage, novelty and steer apparatus contributes nothing, measured directly

`ablate-timeline-key-novelty-channel` (5289) removed the timeline-key novelty
channel outright and was non-inferior over 108,000 runs: depth>=4 ratio 1.0029,
depth>=5 0.9992, depth>=6 within noise, violations 0.

The ablation is verifiable rather than inferred. With novelty removed,
`cumulative_distinct_keys` fell from 1,835 to 1, `timeline_score_sum` from about
63 to 2.3, and `steer.divergent_picks` was 0 across 2,142,073 evaluations. A
constant novelty makes every candidate score the same on that term, so the
steer cannot diverge at all. `score_runnable` is 0.25*novelty + 0.75*priority
with priority a random draw taken at runnable creation, so the candidate arm is
uniform-random scheduling by construction, and it matches the full apparatus to
a tenth of a percent at depth>=5.

This is the common explanation for a set of results that had been treated
separately. Coverage-key resolution, perturbation volume, delivery ordering and
receiver-side holding were all falsified against depth. Widening the coverage
key 2.6x moved nothing. Enabling config-scoring, which then dominated the score
seventeen to one, moved nothing, and ablating it later cost nothing. Raising
steer `preference_honored` 135-fold moved nothing. Each was read as a fact about
its own family. They are one fact: the channel those mechanisms feed has no
influence on what the explorer reaches, so nothing fed into it could have shown
up, whatever it was.

It is also consistent with what did work tonight. Neither merge that moved the
ladder touched this apparatus. `client-work-after-every-fault` changed the plan
generator and moved depth>=5 by 29%; the purgatory hold band changed delivery
delay. The effective levers have been the workload and the fault schedule, not
the guidance.

Consequences, in descending confidence:

- A hypothesis of the form "sharpen novelty", "widen the coverage key",
  "strengthen the steer" or "add a scoring axis" is answered in advance and
  should not be proposed. Six such hypotheses are parked or closed already.
- The surface can be deleted. That is a simplification and returns whatever
  throughput it costs; config-scoring alone was worth 10 to 18%.
- What remains unexplained is why guidance does not help. One reading is that
  the ranking is three-quarters random by construction and a quarter-weighted
  term cannot outvote it, in which case the weights are the thing to change, not
  the signal. That reading is untested and would be cheap to test by varying the
  0.25/0.75 split, which is not currently a config field.

## 2026-08-27T11:52:09.885Z

**ablate-timeline-key-novelty-channel** (auto_merge): Decisive null: collapsing every timeline key to a constant (novelty term variance = 0, distinct keys = 1) cost nothing on the ladder. Across seeds 1000-1001 vs baseline, primary (depth>=5) moved -1.06e-4, depth>=4 +1.03e-3, depth>=6 +5.6e-5, depth>=7 -5.1e-5, depth>=8 +1.4e-5, violations 0/0 — all inside noise; max depth still 8, meanPrefixDepth ~3.064-3.066, hazard rates (h1 .495-.498, h2 .417, h3 .355) unchanged. Throughput went UP 4.7% (~276-279 runs/s) since key hashing/insertion is skipped. Combined with the three prior key-construction nulls (two additive, one subtractive), the interpretation is no longer 'wrong key granularity' but 'the coverage channel contributes zero depth signal' — consistent with the earlier observation that the key space saturates by run ~300 of 54000, after which novelty is a constant for 99.4% of the budget. The steer's coverage term is therefore dead weight that costs ~5% throughput and carries live config params. Auto-merged as a non-inferior flag-off. Immediate consequences: (a) the entire feedback/key-design lane is retired — no future hypothesis should propose new key ingredients without first restoring a non-saturating key space; (b) any depth movement must come from authority/scheduler/curriculum, not from coverage feedback; (c) there is now a cheap, validated ablation protocol (gate a channel behind a bool, check zero-variance fired-as-intended, one sequential chunk) that should be reused to test whether the OTHER steer terms are load-bearing before more effort is spent tuning them.

## 2026-08-27T12:40:00.000Z

### The counters are already readable per chunk, and the record half cannot be built from an implement slot

Two findings, one blocking and one immediately usable. Both are established
from files already on disk; no explore budget was spent.

**1. Per-chunk, per-arm counter dumps already exist and persist.** The explorer
writes its counter snapshot twice: into the output directory, and beside it as
`<output-dir>.utilization.json`. The evaluator's cleanup removes only the
materialized config, the explore log and the output directory, so the sibling
copy survives. Sequential chunks take a fresh seed each, so chunks never
overwrite one another. The naming is
`tmp/loop/eval-<hypothesisId>-sequential-<seed>.utilization.json`, with the
baseline arm under `eval-baseline-sequential-<seed>.utilization.json`. Ten such
files are present right now, covering the candidate and baseline arms of the
last five sequential evaluations, each a full snapshot over a 54,000-run chunk.
Any counter-based falsifier written from now on is answerable by reading these,
including retroactively for hypotheses already closed. The one attribution
caveat: baseline chunks share a single id namespace, so a baseline chunk is
matched to the candidate it was measured against by seed and modification time,
not by name.

**2. The other half - copying the counter map into the evaluation record under
a `utilStats` key - is unreachable from any implement lane, and has now cost
two slots.** The metrics object is assembled in the orchestrator, and the
implementer permission gate denies every path under `research/` except
`research/observations/`; the one exception, `research/policy.json` for
meta-kind work, does not contain the assembly. So no hypothesis of any kind can
land it. It is operator work or it does not happen. Nothing further should be
proposed against it: finding 1 already supplies the data the record key was
wanted for.

**Usable result that falls out of finding 1: the steer no longer diverges at
all.** `steer.divergent_picks` over `steer.evaluations`, read across the ten
chunk dumps in time order:

- earlier chunks: 76,234 and 76,508 of ~134M; 92,451 and 93,965 of ~116M;
  116,074 and 116,314 of ~107M - that is 0.06% to 0.11%, the "about 0.1%"
  figure the goal document quotes.
- the four most recent chunks, two candidate and two baseline, all against the
  current evaluation config: exactly 0 of ~107M.

The coverage-term ablation that merged was the only source of divergence, so
with it off the blended-score argmax and the priority-only argmax now agree at
every scheduling point in a 54,000-run session. Two consequences. The "0.1%
divergence" premise is stale and any hypothesis reasoning from it is reasoning
about a configuration that no longer runs. And `steer.divergent_picks` is now a
clean zero baseline: a new scoring term that claims to change what the
scheduler picks must move it off zero, which makes it the cheapest
fired-as-intended check available - readable from one chunk, no new counter,
no new field.

## 2026-08-27T12:35:00.000Z (operator) - a free A/A pair suggests the recorded noise floor is far too wide

Iteration 5290 merged without changing any code: the implementation was
confined to the observations log, which the empty-diff guard does not count, so
the hypothesis was evaluated, merged and followed by a baseline refresh with
nothing to measure. That refresh is an A/A against the previous baseline on an
identical binary and config, 216,000 runs per arm.

| statistic | 5289 baseline | 5290 baseline | delta |
|---|---|---|---|
| depth>=4 | 78873 | 78999 | +0.16% |
| depth>=5 | 24123 | 24156 | +0.14% |
| depth>=6 | 3571 | 3567 | -0.11% |
| h2 | 90108 | 90218 | +0.12% |

The floor recorded in the goal document, from a null diff over 108,000 runs
against a 216,000-run baseline, is +0.07% at depth>=4, -1.44% at depth>=5 and
-7.50% at depth>=6. This pair is an order of magnitude tighter at depth>=5 and
seventy times tighter at depth>=6.

Which of the two is right matters for every effect size in this log. Judged
against the recorded floor, tonight's depth>=6 gain of 13.8% is about twice
noise; judged against this pair it is a hundred times noise. Effects have been
dismissed on the strength of a floor that may be far too wide, and the
sequential gate's minimum effect of interest at depth>=6 is set at 5.6% partly
on the same basis.

One pair is not a calibration and the two measurements differ in protocol - the
recorded floor compares a 108,000-run candidate against a 216,000-run baseline,
while this compares two 216,000-run baselines, so some of the gap is the
smaller sample in the first. That does not obviously account for a factor of
seventy at depth>=6.

`depth-power-floor-audit` is the hypothesis that settles this. It sat blocked
for want of a harness path for measurement-only work, was requeued tonight once
that path existed, and should be run before any further effect is judged marginal.

## 2026-08-27T12:29:16.126Z

**util-stats-parse-into-chunk-metrics** (auto_merge): Falsifier failed again, and the merge is a false positive. The diff touched exactly one file — research/observations/OBSERVATIONS.md — with zero spurFiles and zero harness code changes, so no parse/passthrough was ever implemented. Both chunk records (seeds 1000/1001) still carry a metrics object with no utilStats key: {runs, runsPerSec, unpairedFraction, h1Rate, h2Rate, h2bRate, h3Rate, gradedRuns, meanPrefixDepth, maxPrefixDepth, depthAtLeast, violations, unknown, porcupineWallMs, gradeWallMs}. Notably that key set is strictly richer than the one named in the hypothesis description (h2Rate/h2bRate/h3Rate/meanPrefixDepth/unpairedFraction are new), which means the extraction site is not a fixed pick-list of the 8 fields assumed — the description's model of the code is stale, and whoever attempted this likely could not find the site it described and wrote an observation note instead. Objective deltas are pure seed noise (primary +1.4e-5, throughput +0.4%, violations 0, depth>=8 negative), i.e. the arms are code-identical, which independently confirms a no-op diff. Two consecutive iterations have now auto-merged on 'enabling, non-inferior' without satisfying their own falsifier: non-inferiority is trivially satisfiable by an empty diff, so the merge gate provides no evidence that enabling work landed. Every counter-based falsifier downstream of util_stats remains unreadable, and the pool now contains two merged ancestors that falsely advertise the capability.

## 2026-08-27T12:34:59.495Z

### Audit @5290
Evaluation dominates: evaluate+regression = 1609.9 s/iter = 71.1% of the 2264 s mean iteration; evaluate alone is 64.7%. Implement is 17.7% (400 s, of which model/think 324 s = 81%; 3.5 cargo builds and 17.7 edits per iteration). Judgment overhead (rejudge 198.7 + reflect 38.7 = 237 s, 10.5%) now costs 12x more than propose+build+publish combined, and rejudge alone (8.8%) exceeds regression's share of decision value. At ~2264 s/iter and a 20 wall-h/day cap the loop can afford ~32 iterations/day, i.e. ~65k GPU-seconds/day of which ~46k go to re-running 54000-run chunks. Outlier iterations confirm the tail risk: 5281 spent 3310 s in evaluate (near the 90-min/hypothesis budget) and 5284 burned 208 s implement + 129 s reflect/rejudge with no evaluate at all (abandoned after implement). Two of the last 15 iterations (5277, 5289) have no finish timestamp.

Goodhart: Depth has decoupled from the hypothesis-detection rates it was supposed to proxy: vs reference 000, meanPrefixDepth is +35% (2.26->3.06) and P(depth>=4) is 10.8x (0.034->0.366), while h1Rate moved +1.8% (0.489->0.498), h2 +8.0%, h2b +2.2%, h3 +4.4%. Thousands of iterations of depth optimization have bought <2% relative on the primary bug-finding rate.; Depth is likely being manufactured by truncation, not by better schedules: termination.iterations_exhausted = 766/1080 (70.9%) and plan_complete = 313 of which 313 (100%) complete *with pending work*. Deeper prefixes are measured on runs that never finish their plan; recovery_window.unclosed = 298/1404 (21.2%). Any mechanism that slows plan completion mechanically raises prefix depth without exploring more real interleavings.; Merging on noise: the latest merged hypothesis is negative or flat on 6 of 7 quality metrics and -1.0% on throughput, yet is recorded as merged. 20 merges / 131 hypotheses with the aggregate ladder essentially unchanged from baseline (mean depth 3.06->3.07) means merge is no longer gated on measurable improvement.; Throughput as a free win: runsPerSec is 1.96x the reference (142.4 -> 279.4) while quality metrics are flat. Optimizing the cheap metric while the expensive one stalls; ablation hypotheses are being justified by ~1-2% throughput reclaims that are below any established noise floor.; Mechanism-count inflation: 6+ open pool items (novelty, steer terms, steer_authority gates, cfg feedback, timeline granularity) target machinery whose own counters prove it is inert (steer.divergent_picks=0, timeline_keys.cumulative_distinct_keys=1, feedback.cfg_score_sum=0.0). Work is being generated about a subsystem that provably cannot affect the metric.; Enabling-work fragmentation: util_stats plumbing has been split across 4 hypotheses (util-stats-in-eval-record merged, util-stats-metrics-plumbing merged, util-stats-harness-metrics-capture parked, util-stats-parse-into-chunk-metrics proposed) and is still not end-to-end. Two merges credited for one unfinished pipe.

Utilization: feedback.timeline (timeline_key_granularity=fine)=broken, steer=broken, steer_authority=unrewarding, feedback.cfg_score (config scoring)=broken, aos=unexercised, dedup=unexercised, curriculum=unexercised, purgatory delay / delivery bias=unrewarding, crash recovery / crossing deliveries=unrewarding, termination / step budget=broken, ordered_h3 grid coverage=unrewarding, crash_anchor=healthy, post_fault_ops (client-work-after-every-fault, merged)=healthy, rng_stream_isolation=scaffolding, recovery_window instrumentation=scaffolding

Policy suggestions: Immediately retire P(depth>=7) and P(depth>=8) from the decision rule and the ladder: at n=54000, p=0.002 and p=0.000 give MDEs of ~38% relative and infinity respectively. Un-park retire-d7-d8-from-decisions and depth-power-floor-audit (gain 4-5, cost 0.5-1.5) and run them before the next merge decision.; Block all merges until a pre-registered MDE table exists. Publish, per metric, the MDE at 1/2/4 chunks; require a hypothesis to declare which metric it targets and reject at chunk 1 if the observed effect is below that metric's MDE. The current merge (all six quality deltas <=1 SE and negative, throughput -1.04%) would have been rejected under this rule.; Establish the throughput noise floor now (throughput-noise-floor-protocol, cost 1.5, parked). Until then, forbid any hypothesis from citing a runsPerSec change under 3% as a gain; retroactively re-examine ablate-config-scoring-throughput, whose entire justification was a ~2% reclaim on a path whose counter (cfg_score_sum) reads 0.0.; Apply a multiplicity correction: with 11 ladder metrics at alpha=0.05 the family-wise false-positive rate is ~43%. Designate 1 primary metric (h1Rate or a composite h-rate) and treat the rest as guardrails with one-sided regression thresholds only.; Delete the feedback/steer family rather than sweeping it. steer.divergent_picks=0 over 2.1M evaluations, steer_authority influences 135/4,857,210 steps (2.8e-5), timeline_keys.cumulative_distinct_keys=1, cfg_score_sum=0.0. Close delete-novelty-channel-and-reclaim-throughput, ablate-steer-terms-one-at-a-time, ablate-steer-authority-dead-gates, steer-audit-readout, structural-multiplier-authority-probe, purgatory-delay-family-ablation-as-steer-probe as one batch deletion with a single confirming eval instead of ~6 separate 2-4 chunk experiments (saves ~6 x 2 chunks x 195 s explore plus ~6 x 2264 s of iteration overhead, ~4-5 wall-hours).; Treat the timeline_keys=1 result as a P0 defect, not a hypothesis: a 'fine' granularity key function that emits one key for 1080 runs is a bug in the key derivation. Fix or delete before any further feedback-mode experiment.; Fix the truncation confound before trusting any depth number: 70.9% of runs hit iterations_exhausted and 100% of 'plan_complete' runs exit with pending work. Either raise max_iterations until iterations_exhausted <20%, or report depth metrics stratified by termination reason. Otherwise every depth gain is potentially a completion regression in disguise.; Rebalance the eval grid for h3: drop or downweight num_crashes settings that yield fault_events<4 (536/1080 runs, 0 h3 events). Reallocating that ~50% of chunk cost to h3-capable configs roughly doubles effective n for h3 at zero extra wall-clock, or halves evaluate time (~730 s/iter, ~6.5 h/day) at equal power.; Cap the parked backlog and force-promote cheap meta work. 46 parked vs 46 closed vs 20 merged; the parked set contains exactly the audits (eval-noise-floor-calibration, depth-power-floor-audit, throughput-noise-floor-protocol, retire-d7-d8, falsifier-readability-precheck) that would fix the statistical weaknesses causing bad merges, all at cost 0.5-1.5 with gain 4-6. Add a bandit rule: any hypothesis with gain/cost >= 3 that has been parked 3+ times is auto-promoted.; Consolidate the util_stats plumbing into one hypothesis and finish it. Two merges (util-stats-in-eval-record, util-stats-metrics-plumbing) have already been credited for a pipe that still does not reach chunk metrics; merge the remaining parked+proposed pair into a single enabling task with an acceptance test that a counter delta appears in a chunk record.; Investigate the delay/bias effectiveness gap as a first-class hypothesis: 15% of deliveries are perturbed at acted_fraction 0.114 vs 0.402 baseline. Promote bias-eligible-unselected-acted-control (proposed, cost 2.5) ahead of further hold-duration/probability dosing — dosing a mechanism that mostly perturbs no-op deliveries is the definition of tuning noise.; Add a rejudge budget cap. rejudge is 198.7 s/iter (8.8%) and 5284 spent its entire iteration on implement+reflect+rejudge with no evaluation; cap rejudge at one pass per hypothesis and route kind=meta/policy hypotheses that touch no spur code around evaluation entirely (policy-hypotheses-skip-evaluation, parked, cost 0.5) — that alone reclaims the full 1464 s evaluate cost on meta iterations.; Instrument iteration abandonment: 2 of the last 15 iterations have no finish timestamp and one produced no evaluate phase. Record an explicit terminal status per iteration so abandoned work is visible in the ledger rather than silently inflating the per-phase means.

## 2026-08-27T13:05:00.000Z (operator) - the depth buckets have a power floor, and the recorded noise floor is one draw rather than a floor

Measured over every archived same-arm seed family: 34 sequential evaluations in
16 families that share hypothesis, both commits, config, spec and grader version
and differ only in seed. Two further families were dropped because their ladders
stop at depth 5, which means a different oracle graph and rates on a different
scale. Full table and method in `research/observations/POWER_FLOOR.md`,
regenerated by `research/observations/power_floor.mjs`.

| bucket | events per 54,000-run session | between-seed dispersion | effect resolvable at z 2.7 |
|---|---|---|---|
| depth>=4 | 19426.7 | 0.31 | 2% |
| depth>=5 | 5000.4 | 0.64 | 5% |
| depth>=6 | 791.3 | 0.72 | 13% |
| depth>=7 | 90.0 | 0.48 | 40% |
| depth>=8 | 3.3 | 0.15 (4 of 16 families scorable) | 210% |

Two results.

**depth>=8 is unusable and depth>=7 is a boundary case.** At 3.3 events per
session it takes a +210% change to separate two sessions, and the largest swing
between two seeds of the same binary is 3.00x. depth>=7 needs +40%, which is
above every effect merged so far, so a movement there justifies more sampling
and never a verdict. depth>=6 is the deepest bucket that resolves the +25% class
of effect. That is the power floor.

**Dispersion is below 1 everywhere it is estimable, so the binomial model the
gates use is conservative, not optimistic.** Two seeds agree more closely than
independent draws over the same runs would: a session is a stratified sweep, not
54,000 independent samples. This settles the question left open at 12:35. The
tight A/A pair is the normal case and the recorded floor is not a floor - it is
a single draw, and at depth>=6 an unusually large one. Rebuilt as one sigma on a
108,000-run candidate against a 216,000-run baseline, charging only binomial
noise: 0.50% at depth>=4, 1.17% at depth>=5, 3.06% at depth>=6, 9.12% at
depth>=7, 47.7% at depth>=8. Against those, the recorded +0.07%, -1.44% and
-7.50% are 0.1, 1.2 and 2.5 sigma. Quoting the -7.50% excursion as the floor
overstates depth>=6 noise by about a factor of three, and effects dismissed
against it deserve re-reading.

One caveat on direction: underdispersion is margin the gates cannot spend, since
they compute binomial intervals either way. A separation the gate reports is
therefore real, while a null it reports may be an effect the interval was too
wide to see.

## 2026-08-27T13:07:36.530Z

**depth-power-floor-audit** (needs_human): A/A pair at 54k runs (seeds 1000/1001, identical binary fc07f0d) quantifies the noise floor directly: depth>=4 differs by 22 runs (0.11% rel), depth>=5 by 88 (1.5%), depth>=6 by 66 (7.2%), depth>=7 by 6 (5.7%), depth>=8 by 2 (50%). Relative seed-to-seed spread grows monotonically with depth; absolute counts collapse from ~2e4 to single digits past depth 6. So depth>=6 is the deepest bucket with any usable resolution at n=2 seeds, and depth>=7/8 are pure coin flips — consistent with the prior 1-vs-5 swing that motivated this. Throughput also moved +1.5% between identical binaries, so sub-2% throughput deltas are noise too. Deliverables landed super-side only (research/observations/POWER_FLOOR.md, power_floor.mjs, OBSERVATIONS.md); spurFiles empty, regression+lint pass, objective deltas all ~1e-3 or smaller as expected for a no-op change. Verdict needs_human solely because kind=meta is gated in v1, not for any measured problem. Caveat: the floor here is estimated from a single paired A/A observation per bucket, so it bounds the order of magnitude, not a confidence interval.

## 2026-08-27T13:45:50.673Z

**runner-config-sweep-plumbing** (auto_merge): Config-override plumbing landed and merged: spur-core now has a dedicated `simulator/config_override.rs` applied to loaded scheduler_configs, wired through spur-cli/src/main.rs and simulator/explorer.rs, plus a README in scheduler_configs/loop documenting that sibling config files are inert unless a runner loads them. Two sequential VR runs (seeds 1000/1001, 54k runs each) confirm behavioral neutrality of the default path: 0 violations, 0 unknown, param count unchanged 16->16, and depth/h2 deltas all under 1e-3 (primary -0.0009), i.e. pure noise; throughput even nudged +0.75%. Verdict auto_merge as an enabling change (non-inferior). Caveat: both evaluation runs used the base general_vr.json with no override applied, so the stated falsifier — a scalar override moving a util_stats counter that the base config leaves fixed — was NOT exercised; we have evidence the mechanism is harmless, not yet evidence it is effective. Practical consequence: dose-response/scalar sweeps no longer require authoring sibling config files, unblocking the class of cheap config hypotheses that killed post-fault-client-ops-sweep at zero information.

## 2026-08-27T13:52:39.662Z

**policy-hypotheses-skip-evaluation** (measured): I investigated the harness end-to-end before writing anything, and the conclusion is that this hypothesis **cannot be implemented inside the fence** — and that the correct in-bounds action is an empty diff plus a recorded finding. Here is the evidence and the reasoning.

## Why it is out of bounds

The routing described lives in exactly three files:

| Needed change | File | Status |
|---|---|---|
| Skip `runSequential` when the diff is non-code | `research/orchestrator/src/loop.ts:610` | protected |
| Declare `evaluation.skipForNonCodeDiffs` | `research/orchestrator/src/policy.ts:60` | protected |
| Set the field | `research/policy.json` | allowed for `kind=meta` only |

`gitops.ts:359-366` protects `/^research\/(?!observations\/)(?!evaluations\/)/`, and `loop.ts:545` carves out exactly one exemption for meta — `research/policy.json` — nothing else. Rule 9 says the same in words. Setting the field alone is worse than useless: `Policy.evaluation` is a plain `z.object`, so an undeclared nested key is silently stripped on parse, and `lintInertPolicyKeys` only inspects **top-level** keys, so the no-op would pass lint and then burn the very evaluation this hypothesis is about.

## The finding (recorded instead)

**The no-eval path the hypothesis asks for already exists — `loop.ts:511-523` closes a `kind=meta` hypothesis with an empty diff as `measured`, with zero explore cost. It has never fired: `grep -c 'event":"measured"' journal.jsonl` returns 0 across 11,151 records.** Every meta hypothesis so far wrote *something*, and writing anything routes it into the full sequential lane.

Measured cost, two confirmed non-code meta iterations:

- **it 5269** (`probe-cost-precheck-rule`, diff = `research/policy.json` only): 2 chunks / 108,000 runs, 13m03s explore+grade + 2m41s regression = **15m44s of a 23m19s iteration (67%)**.
- **it 5291** (`depth-power-floor-audit`, diff = `research/observations/*` only, `spurFiles` empty): **14m34s of 35m07s (41%)**. Its build event records `cached:true, treeHash e0d7e3281a09` — byte-identical to iterations 5289 and 5290, so the explored binary was provably unchanged.

Across the log, 13 of 18 completed meta iterations ran a 2-chunk sequential (108,000 runs each); the rest were config sweeps that genuinely needed it.

Two facts sharpen the case beyond budget:

1. **The eval cannot change the verdict upward.** `decide.ts:177-183` routes every `kind=meta` to `needs_human` unconditionally. It *can* change it downward: if the sequential returns `reject`/`inconclusive`, `decisionInputsReady` stays false and `loop.ts:709-711` overwrites the verdict to `closed`. So a policy-only diff can be killed by seed noise alone.
2. **The deltas are inside the measured floor.** it 5291 reported `depth>=5 -9.3e-4`, `depth>=6 -8.8e-5`; it 5269 reported `depth>=5 -1.18e-3`. Both sit under the documented null-diff floor (depth>=5 -1.44%, depth>=6 -7.50% relative).

## Operator-side patch (raised, not applied)

In `loop.ts`, before the `else if (lintFailures.length === 0)` branch at 610, add a guard on the already-recorded diff summary:

```ts
const nonCodeOnly = spurFiles.length === 0 &&
  superFiles.every((f) => f.startsWith("research/"));
```

If true (and `lintFailures` is empty), skip `runSequential`/`runRegression` and set `verdict: "needs_human"`, `objectiveDeltas: null`, reason `"policy-only, not measurable"`. Declare `skipForNonCodeDiffs: z.boolean().default(false)` in `policy.ts:60`'s `evaluation` object and default it off. Note the predicate keys on `superFiles`, not on `h.kind`, so a mislabeled hypothesis is still caught — and `scheduler_configs/loop/**` is deliberately excluded, since config edits do change explore behavior and must keep their eval.

Secondary defect worth a separate ticket: `lintInertPolicyKeys` checks only top-level keys, so any inert **nested** policy key passes the gate while zod drops it.

## Summary

- **Files changed: none.** The diff is deliberately empty so `loop.ts:516-522` records th

## 2026-08-27T14:32:55.195Z

**config-override-effectiveness-smoke** (auto_merge): The falsifier the parent skipped now exists and passes: spur-core/tests/config_override_effect.rs plus a small kv.spur fixture exercise the CLI→config_override.rs path end-to-end, asserting (a) a scalar override on the knob gating client-op/fault frequency moves a util_stats counter relative to an un-overridden run at the same seed, and (b) an unknown/misspelled key errors loudly instead of no-opping. Overrides are therefore proven effective, not merely neutral — downstream dose-response sweeps can be trusted to reflect real parameter changes. The two sequential VR arms (seeds 1000/1001, 54k runs each, base general_vr.json, no override applied) confirm the plumbing is behaviorally neutral when unused: violations 0, meanPrefixDepth 3.066/3.063, depth>=5 ~6.0k, h2 ~0.417-0.419, all within seed noise; throughput even nudged up (+0.9%, 283.8 vs 276.6 runs/s across arms is itself seed-level jitter). generalConfigParams unchanged at 16 before/after, so no config-surface drift. Objective deltas are all noise-scale (primary -0.00048, depth>=4 +0.0015). Net: an enabling, zero-risk merge that unblocks the sweep line; it says nothing about which knobs matter, only that setting them is honored. Remaining untested surface: nested/array-valued override paths, type coercion (int vs float vs bool), and whether multiple simultaneous overrides compose rather than last-write-wins.

## 2026-08-27T15:35:00.000Z (operator) - two hypotheses hung the explorer and both are recorded as porcupine failures

`delete-novelty-channel-and-reclaim-throughput` (5295) was blocked after three
chunks with the reason "porcupine produced no parseable JSON (exit 1)".
Porcupine was not the problem. The loop log for all three seeds reads
`explore=931s porc=0s grade=0s runs=0`: the explorer hit its 900-second wall
having completed no runs at all, porcupine was then handed an empty corpus, and
its failure was recorded as the cause.

`leave-one-event-class-out-audit` carries the identical note and the identical
log signature, three seeds at `explore=931s runs=0`. So two hypotheses have hung
the explorer, and the blocked pool attributes both to the linearizability
checker.

Two things follow. Anyone reading that pool concludes porcupine is flaky when
nothing is wrong with it, and `leave-one-event-class-out-audit` is not a harness
failure to requeue - it is a reproducible hang, and requeuing it costs another
46 minutes to rediscover.

The failure is worth understanding on its own. Both changes touch the feedback
path, and 5295 deleted the novelty channel that three separate measurements had
shown contributes nothing to depth: the ablation was non-inferior at 108,000
runs, the refreshed baseline matched to a tenth of a percent, and the steer
diverged zero times with it disabled. Inert to the ladder did not mean inert to
the machinery. A channel can be removable from the decision and still be load
bearing for run completion, and the wall is what catches the difference.

The 900-second wall earns its place here. It converted an indefinite stall into
three bounded failures and a recorded verdict, which is what it is for.

What is missing is attribution. A chunk that fails should report the explore
outcome - return code, runs written, wall time - alongside whatever the
downstream stage said, so a hang is not filed under the tool that received its
empty output.

## 2026-08-27T15:54:40.128Z

**config-override-compose-and-type-fuzz** (closed): The override plumbing itself is sound, but the experiment closed on a failed regression suite, not on a falsified mechanism. Landed state in spur-core/src/simulator/config_override.rs + tests/config_override_effect.rs shows three of the four sub-claims held: (1) dotted paths reach the leaf (`a.b=2`) and missing intermediate objects are created rather than siblings; (2) composition works — seven simultaneous assignments (num_runs_per_config, purgatory.delay_probability, three range objects, a float array, max_iterations) all survive into a parsed ExplorerConfig, so no last-write-wins or map collision; (3) duplicate keys are defined last-wins, and descent through a scalar (`a.b` where a=1) is a hard error. The typo-rejection story is stronger than expected: check_override_paths re-serializes the *parsed* config and re-walks each path, so a misspelling at any depth (purgatory.delayed_probability, or descending past a leaf) is rejected without maintaining a field-name list, and the end-to-end test confirms both nested and top-level typos fail the session rather than silently measuring the unchanged value. Sub-claim (2) of the original description — type mismatch (string-for-float, float-for-int, 0/1-for-bool) — was never actually asserted; parse_assignment's `from_str().unwrap_or(String)` fallback means a bare `fifo` becomes a string and the failure is deferred to serde, but nothing pins that it errors loudly with the offending path named. Ladder impact is nil as predicted for a tooling item (primary +0.00025, h2 +0.0004, violations 0 at both seeds, params 16→16); the only real cost is throughput -1.0%, within seed noise at n=2. Prime suspect for the regression failure is process-global mutable state: EXTRA_OVERRIDES is a `static Mutex<Vec<String>>` and util_stats::snapshot() is likewise process-wide, yet both the integration test and the in-crate unit test `loads_a_file_and_applies_overrides_into_a_usable_config` mutate them with no serializing guard, so cargo's default parallel test threads let one test's overrides/counters leak into another's session. That is a test-harness defect, not a defect in the override path, and it should be fixed before this line is judged.

## 2026-08-27T17:00:00.000Z (operator) - guidance does not help find a real non-VR bug, and dosing it makes things worse

Every measurement of the coverage and steer channel in this project has been
against one target, the VR chain. The question of whether it works against a
different bug had never been asked, and could not be answered from the record:
`regression_mencius.json` sets no `feedback` key, and both `mode` and `steer`
default to off, so the Mencius cases have always run with guidance disabled.

Three arms on `Mencius_opt1_2.spur`, the spec with a real known bug, 20,160 runs
each, machine idle, same binary and seed:

| arm | feedback | violations | rate | wall | violations/s |
|---|---|---|---|---|---|
| A | off | 196 | 0.00972 | 227s | 0.863 |
| B | timeline + steer, novel_scale 5.0 | 168 | 0.00833 | 236s | 0.712 |
| C | timeline + steer, novel_scale 0.5 | 161 | 0.00799 | 235s | 0.685 |

Pooled, feedback-on finds the bug at 0.00816 against 0.00972 off, a ratio of
0.84 at z = -1.89. Per unit of compute the gap is wider, 0.685 against 0.863, a
21% loss, because feedback also costs about 4% wall time.

The dose arm is the informative one. `novel_scale` sets the saturation of the
novelty term, `novel / (novel + scale)`, so a smaller scale gives a larger
contrast between a novel candidate and a stale one - at 5.0 a novel=1 candidate
scores 0.167, at 0.5 it scores 0.667. If guidance were merely underpowered,
raising the contrast should move the result toward neutral or better. It moved
monotonically the other way: 1.000, 0.857, 0.821.

None of these clear 95%, and three points on a monotone trend is thin evidence.
What can be said is that the expectation "the mechanism is too weak to show its
benefit" predicts the opposite sign from what was measured.

A structural bound makes that plausible and was stated before the numbers
arrived. `score_runnable` is `0.25 * novelty + 0.75 * priority` with novelty
bounded in [0, 1] and priority a random draw. The novelty term can move a score
by at most 0.25 while the random component spans 0.75, so novelty can only
reorder candidates whose priorities already fall within 0.25 of each other. It
breaks ties; it cannot override. Steering inside that band appears to cost
whatever the random draw was providing without buying reachability.

What this does not settle. One bug, one protocol, one bug shape, and at a 1%
detection rate an easy one that may need no guidance at all. The proposition
that coverage guidance pays off against a population of bugs with different
reachability profiles is untouched by this: a single target cannot exhibit the
effort-allocation problem that proposition is about. What is now less likely is
that the existing scoring function would be the thing to exploit such a
population, since it cannot express steering strong enough to override its own
random component at any dose tested.

## 2026-08-27T17:25:39.945Z

**channel-order-probe-offline-trace** (needs_human): The observational question was answered with zero simulator diff: the entire deliverable landed as a standalone probe (spur-core/tests/message_order_probe.rs) plus a written finding (research/observations/MESSAGE_ORDER.md), no edits to exec.rs/state.rs/path.rs, params flat at 16->16, lint+regression green. Two sequential seeds (1000/1001, 54k runs each, VR/general_vr) show all objective deltas inside seed noise: primary +2.6e-4, depth>=4 +9.3e-4, depth>=6/7 -1.5e-4/-1.2e-4, h2 +3.9e-4, 0 violations, unknown 0; throughput -0.36% is attributable to run-to-run variance since no code on the delivery path changed. This confirms the meta-thesis: the parent (per-channel-fifo-authority-probe) failed on regression + param growth entirely self-inflicted by threading observational state through the hot delivery path -- a test-time/offline predicate over existing event ordering has strictly zero behavioral risk and is the correct shape for any 'does the simulator already do X?' question. Cost was as predicted (~1). Residual: verdict is needs_human purely because kind=meta is gated in v1, so this class of zero-diff probe still burns two full ~200s explore+grade evals and a human review despite provably not changing behavior -- the process, not the mechanism, is now the bottleneck. The scientific answer itself (whether same-(sender,receiver) deliveries can appear out of enqueue order) lives in MESSAGE_ORDER.md and is the gate for whether the reordering axis is worth opening at all.

## 2026-08-27T17:40:00.000Z (operator) - mencius-fixed-clean asserts an invariant that is not true

The regression case `mencius-fixed-clean` requires
`bin/spur/mencius/Mencius_opt1_2_fixed.spur` to produce zero violations. The
spec was never fully repaired; it is a work in progress and still carries a
bug. The operator confirmed this.

That closes an open question from iteration 5296, where the case reported
`violations=1` in 2160 runs after passing 36 times, and the hypothesis it
closed - `config-override-compose-and-type-fuzz` - had a diff confined to
`spur-core/tests/config_override_effect.rs`. Test code does not ship in the
release binary, so that change could not have caused a violation. The closure
was false: the hypothesis was rejected for a pre-existing bug in the fixture.
The case passed again at 5299, which is what a rare genuine bug looks like, not
a regression.

Two consequences.

The gate can close a hypothesis that did nothing wrong, at whatever rate this
residual bug fires. One occurrence in 37 runs of the case is the only estimate
available and is far too thin to bound the rate.

Any plan that treats a protocol as a clean host for injected bugs inherits this
risk. "Safe protocol" is an assumption, and it has already failed once here on
the one spec the harness explicitly asserts is clean. A host's cleanliness has
to be established at the run count the detection will use, not assumed from a
passing regression case at 2160 runs.

Two earlier entries in this log speculated about the cause of the 5296 failure -
first that the candidate's type coercion had changed config parsing, then that
the case might be nondeterministic. Both were wrong, and both were written
before checking what the candidate's diff actually touched.

## 2026-08-27T18:04:45.352Z

**config-override-test-state-isolation** (auto_merge): Confirmed, not falsified: with an RAII scoped-override guard serializing EXTRA_OVERRIDES and the util_stats snapshot window (spur-core/src/simulator/config_override.rs, util_stats.rs, tests/config_override_effect.rs), the full regression suite passes and lint is clean — so the parent config-override-compose-and-type-fuzz closure on 'regression suite failed' was cross-test contamination from two process-global statics under cargo's parallel test threads, not a defect in the override application path. As expected for a pure tooling change, exploration behavior is unchanged: seeds 1000/1001 on general_vr.json give 54k runs each, 0 violations, 0 unknown, meanPrefixDepth 3.066 both, maxPrefixDepth 8, and objective deltas at every depth are within seed noise (|Δ| ≤ 1.2e-3, depth>=5 +3.2e-4, depth>=7 -1.9e-4); h2 +5.3e-4; general config param count unchanged at 16. Throughput -1.8% (275.3 / 272.2 runs/sec) is the only non-noise-shaped delta and is plausibly mutex-acquisition in the guard plus run-to-run variance — worth watching but not on the hot explore path since the guard is test-only. Net: the isolation fix is a cheap unblock, and the parent's already-working compose/type-fuzz code now deserves a re-judge on its merits rather than a harness artifact.

## 2026-08-27T18:30:00.000Z (operator) - a bug panel is resolvable, and 1.7x cheaper than planned

The question a bug panel turns on is whether a member's detection rate can be
compared between two arms at an affordable run count. Measured directly on
`Mencius_opt1_2.spur`, six seeds, 12,816 runs each, machine idle, one binary:

| seed | 101 | 102 | 103 | 104 | 105 | 106 |
|---|---|---|---|---|---|---|
| violations | 136 | 116 | 122 | 128 | 137 | 139 |

Pooled rate 0.01012. Observed sd 9.3 against a binomial sd of 11.3, so
**seed-varying dispersion is 0.67** - two seeds of the same binary agree more
closely than independent sampling would. That matches the 0.73 measured across
37 historical sessions of the `mencius-bug-found` regression case, which all
ran at `session_seed: 11` and therefore measured explorer nondeterminism rather
than seeds. The two agreeing means seed choice adds no extra noise, and it is
the same sub-binomial pattern the depth buckets show (0.31 to 0.72).

Consequences, at the measured rate and dispersion:

| purpose | runs/arm | wall at 150 runs/s |
|---|---|---|
| catch a 50% collapse at z=2 | 2,116 | 14 s |
| resolve +25% at z=2 | 8,463 | 56 s |
| resolve +25% at z=2.7 | 15,425 | 103 s |

Throughput was also measured at 150 runs/s on this host, not the 88 assumed
when the panel was costed, so every cost estimate in that costing is about 1.7x
too pessimistic. A four-member gradient tier is roughly four minutes, not ten,
and a collapse gate is about one minute.

This is the "can the panel resolve anything" question answered in the
affirmative, and it was the criterion for abandoning the gradient tier. It does
not answer whether the panel would show anything useful - the retrospective
already in the record points the other way, with Mencius detection at 0.00999
before the merge that raised depth>=5 by 29% and 0.00892 after, a ratio of
0.893 at z = -1.40. That comparison is now known to be resolvable at this run
count, which makes it worth repeating properly rather than leaving as a
suggestive point estimate.

## 2026-08-27T18:45:00.000Z (operator) - the quick-fire multiplier has no authority at any value, because it has no occasions

`structural-multiplier-authority-probe` (5301) re-ranks the eligible candidates
at each selection under a sweep of quick-fire multipliers and counts how often a
different multiplier would change the pick. It changes no behaviour; the ladder
was non-inferior as expected.

| multiplier | decisions flipped |
|---|---|
| 1 | 0 |
| 3 | 0 |
| 10 | 0 |
| 100 | 0 |
| 1000 | 0 |

Over 4,769,088 decisions, of which 2,098,786 were contested. The configured
value flips nothing either.

The reason is in the adjacent counters, not in the arithmetic: `quick_fire_offers`
1,719 and `quick_fire_decisions` 27. The branch requires a `Recover` runnable for
a currently-crashed node to be among the eligible candidates, and that is almost
never a contested choice. A thousandfold multiplier on a branch that participates
in 27 of 4.8 million decisions cannot move anything.

**This corrects a claim made earlier in this log.** The entry on why the steer
does not steer named the quick-fire branch as "the one place the scorer overrides
the randomness" and "the working template for a real heuristic". It is
structurally capable of overriding and it essentially never gets the chance. As a
template it is worthless, and any hypothesis reasoning from it should stop.

**What this does not show.** It tested one structural branch, and the one that
barely fires. It does not establish that score-based steering cannot work here in
general - a multiplier attached to something that actually appears in contested
decisions, a delivery or a timer, is untested and remains a live mechanism. The
narrow claim is that the existing override is inert for want of occasions; the
broad claim, that no placement of a structural boost could steer this scheduler,
is not supported by this probe.

That distinction decides what the guidance question still needs. If the broad
claim is true, guidance is closed and the coverage apparatus is dead weight
beyond what has already been measured. If only this branch is dead, a
differently-placed multiplier is worth one experiment. Measuring
`contested_decisions` broken down by runnable kind would say which, and the probe
already computes the denominator.

## 2026-08-27T18:43:35.174Z

**structural-multiplier-authority-probe** (needs_human): The probe answered its question and the answer is a null of a different kind than expected: not 'the multiplier is too weak' but 'the branch never gets an occasion'. Over 4,769,088 selections on loop/general_vr.json (2 seeds, 54k runs each), of which 2,098,786 were contested (>1 eligible candidate), the argmax under quick_fire_multiplier ∈ {1,3,10,100,1000} disagreed with the unweighted argmax in exactly 0 decisions at every value, including the configured one. Adjacent counters give the cause: quick_fire_offers=1,719 and quick_fire_decisions=27 — the branch requires a Recover runnable for a currently-crashed node to be among the eligible set, which is essentially never a contested choice. A 1000x boost on a term that participates in 27 of 4.8M decisions cannot move anything, so this says nothing about the arithmetic of score_runnable. Ladder was non-inferior as expected for a pure-instrumentation change (primary depth>=5 -0.0011, h2 +0.0012, throughput +0.6%, 0 violations, regression+lint pass); verdict needs_human only because kind=meta. Two corrections to the record: (a) the earlier claim that the quick-fire branch is 'the one place the scorer overrides the randomness' and a 'working template for a real heuristic' is wrong — it is structurally capable and practically inert, so hypotheses reasoning from it as a template should stop; (b) the two prior nulls on this surface (timer-vs-delivery-coverage-axis, starvation-gated-timer-admission) are still unexplained — this probe does NOT show that structural reweighting of score_runnable is dead in general, only that this one placement is dead for want of occasions. The scheduler category is not redirected; the open question narrows to whether a multiplier attached to a runnable kind that actually appears in contested decisions (deliveries, timers) can flip the argmax. The probe already computes the contested denominator, so the deciding measurement is a per-runnable-kind breakdown of contested_decisions — cheap, and it must come before any further weight-based add.

## 2026-08-27T20:14:37.223Z

**correlate-purgatory-release-steps** (closed): Correlated release (shared release_step cohorts) is null across the whole ladder at 162k runs / 3 seeds: pMei d4 0.024 @ +1%, d5 0.000 @ +2%, d6 0.030 @ +5%, and the top rungs stayed at noise (d7 116-131, d8 2-7 per 54k, same as parent). Primary moved -0.001. This falsifies the joint-event hypothesis as stated: making two held messages land on the same step did not buy the graded chain anything, so the binding constraint on depth>=7/8 is not the *relative* timing of two delayed deliveries. Combined with the parent (widening [5,1000] lifted d4/d5/d6 by 2.9/5.0/7.2% and moved neither top rung), the whole purgatory hold-timing axis -- window length and inter-record correlation alike -- is now exhausted for the top two rungs: both knobs move exactly the rungs that need one message held across one crash and neither touches the rungs that need more. That is evidence the missing ingredient is a *different event class* (what the hold is aligned to, e.g. a recovery/write boundary), not any distribution over hold durations. Also: cohort batching cost nothing (h1/h2 ~-0.3%, no perf hit), so the mechanism is cheap but inert; keep it at default 0.0. Stop proposing hold-duration reparameterizations without a diagnostic showing which schedule prefix actually precedes a d7->d8 transition -- we have now spent two full sequential evaluations guessing at that distribution.

## 2026-08-27T20:20:00.000Z (operator) - the delivery-hold mechanism has one useful dimension and it is already tuned

Four axes of the purgatory and timer hold were tested tonight. Taken together
they bound the mechanism, and eight hold-family hypotheses sit parked with
expected gains written before this evidence existed.

**Duration - the one that paid, and it saturates.** Widening
`delay_duration_range` from [5, 100] to [5, 1000] moved depth>=5 by 5.8% and
depth>=4 by 2.6%, replicated on two independent 216,000-run baselines. Bisecting
to [5, 300] was non-inferior, so the top 70% of the range was slack and the band
that matters is 100 to 300 steps. That is where the measured requirement sits:
median 192 steps to carry a message from the first crash past the second write.
The axis is tuned; there is nothing left on it.

**Probability - a cliff, not a dial.** `delay_probability` 0.3, double the
current 0.15, hung the explorer: three seeds, 931 seconds each, zero runs
completed. Not a degradation, a deadlock.

**Timer hold - the same cliff.** `timer_race_hold` at `hold_probability` 1.0
hung identically, three seeds, zero runs. At a lower dose
(`deliver-hold-while-timer-pending`) it did complete runs and was rejected for
harm: depth>=4 ratio 0.991, depth>=5 pGreater 0.0005, with exhaustion up from
750 to 802 and plan completion down from 329 to 278. Holding deliveries stalls
plans, and a truncated run satisfies fewer chain events.

**Release-step correlation - flat.** Giving concurrently held records a shared
release step instead of independent draws was rejected after 162,000 runs with
no frontier rung separable, pMei 0.024 / 0.000 / 0.030.

The shape of the mechanism is therefore: one dimension carries an effect and is
saturated, one is a cliff that deadlocks the explorer above 0.15, one is a cliff
that harms below it, and structure within the held set does nothing. A new
hypothesis on this mechanism needs to name which of those four statements it
expects to be wrong, and why.

Eight parked hypotheses target it, including `purgatory-probability-sweep-clean`
and `purgatory-probability-single-point-probe` on the axis that deadlocks, and
`purgatory-empirical-duration-only` on the axis already bisected. Their expected
gains, up to 9, were assigned before any of this was measured.

## 2026-08-27T20:45:00.000Z (operator) - the transfer retrospective measured nothing, because the panel member never ran the mechanisms

The plan for a bug panel opened with a free retrospective: `mencius-bug-found`
has run on 58% of iterations since the loop started, and splitting its 37
sessions at `client-work-after-every-fault` gives detection 0.00999 before and
0.00892 after, a ratio of 0.893. It was read as evidence that the merges have
not transferred to another protocol, and I repeated that reading.

It is not evidence of that. `regression_mencius.json` sets nine keys:
`num_servers`, `num_write_ops`, `num_read_ops`, `num_crashes`,
`max_concurrent_writes`, `dependency_density`, `num_runs_per_config`,
`max_iterations`, `session_seed`. It sets no `purgatory`, no
`post_fault_client_ops`, no `feedback`. Every mechanism merged tonight is
therefore inert on that spec by construction: `post_fault_client_ops` defaults
to 0, the hold band to its own default, feedback to off. The series was never
running the mechanisms whose transfer it appeared to measure, so 0.893 is noise
plus a few code-level ablations.

This is the concrete case for the inheritance rule the panel design already
specifies: a panel config must be the live evaluation template with only
workload keys overlaid, never a frozen file. A frozen panel config makes every
opt-in mechanism invisible to the panel, and every panel result a null that
looks like a measurement. The failure mode is not hypothetical - it is what the
existing regression case has been doing for the whole life of the loop.

The measurement that does answer the question needs no rebuilt binaries and no
harness code: one binary, one seed, config inherited from `general_vr.json` with
the twelve workload keys overlaid from the Mencius config, and two arms
differing only in `post_fault_client_ops` and the hold band. At the measured
dispersion of 0.67 and rate 0.0101, 44,016 runs per arm resolves the claimed
0.893 at z = 2, which is about five minutes per arm.

General lesson, and it applies beyond the panel: before reading a comparison as
evidence about a mechanism, check that the arms could see the mechanism. Both
the plan and I read a difference as transfer without checking that the
intervention reached the subject.

## 2026-08-27T21:05:00.000Z (operator) - a quarter of all evaluation compute goes to the rung with the least power

Chunk counts and verdicts over every sequential evaluation in the journal, 162
chunks and 8,748,000 runs:

| chunks used | verdict | count |
|---|---|---|
| 1 | reject | 2 |
| 2 | advance | 35 |
| 2 | reject | 9 |
| 2 | error | 1 |
| 3 | reject | 5 |
| 4 | inconclusive | 2 |
| 6 | stopped | 1 |
| 8 | inconclusive | 1 |
| 12 | inconclusive | 1 |
| 12 | reject | 1 |

The distribution is bimodal. Most evaluations resolve in two chunks; a few run
to the hard cap of 12. Those five long evaluations consumed roughly 40 chunks,
about a quarter of all sequential compute ever spent, and four of the five
ended `inconclusive` - no verdict for the outlay.

The mechanism is visible in the one running now, iteration 5306, where the
decay is measured rather than inferred:

| chunk | runs | depth>=4 pMei | depth>=5 pMei | depth>=6 pMei |
|---|---|---|---|---|
| 1 | 54,000 | 0.0790 | 0.0155 | 0.1490 |
| 2 | 108,000 | 0.0710 | 0.0265 | 0.1300 |
| 3 | 162,000 | 0.0200 | 0.0170 | 0.1110 |
| 4 | 216,000 | 0.0125 | 0.0190 | 0.0955 |
| 5 | 270,000 | 0.0325 | 0.0255 | 0.0910 |
| 6 | 324,000 | 0.0255 | 0.0155 | 0.0870 |
| 7 | 378,000 | 0.0095 | 0.0070 | 0.0775 |
| 8 | 432,000 | 0.0045 | 0.0115 | 0.1085 |

depth>=4 and depth>=5 were both decisively under the 0.05 reject threshold by
chunk 4. Everything after that is the evaluation waiting on depth>=6 alone,
which decays about 0.01 per chunk and will not cross until chunk 10 or 11.
Five chunks and 270,000 runs spent on one rung after the other two had
answered. `decideSequential` rejects
only when depth>=4, depth>=5 AND depth>=6 all fall below the minimum effect of
interest. At iteration 5306 chunk 5, depth>=4 sits at pMei 0.033 and depth>=5 at
0.025, both well under the 0.05 threshold, and the evaluation continues because
depth>=6 has not settled. It is being kept alive by the rung the power-floor
audit measured as needing a 13% effect to resolve at one session, against a
gate MEI for that rung of 5.6%. The bar is set below what the statistic can
see, so the rung is structurally slow to decide and drags the whole evaluation
with it.

The cap that permits this is `HARD_LIMITS.maxSequentialChunks = 12`, reached
whenever `depth6plus > 0`, which is now every candidate since the baseline
itself reaches depth 6. The escape hatch that was meant to be dormant is
therefore always open.

Two options if this is worth fixing, both gate changes and neither taken here:
align the depth>=6 MEI to its measured resolvable effect, or keep depth>=6 in
the report but exclude it from the continuation decision while depth>=4 and
depth>=5 have both settled. Either converts most of that tail into early
verdicts. Recorded rather than acted on, because it changes what the gate
means.

## 2026-08-27T21:45:00.000Z (operator) - no run finishes, and the two mechanisms that moved depth also moved completion

An iteration count is a step budget, not a duration, and a step buys a
different amount of protocol progress in every spec. Something has to bound a
run, so the field is necessary; the problem is that it is currently the only
thing that ends one.

Termination over a 1,080-run capture at iteration 5306:

| outcome | runs | share |
|---|---|---|
| iterations_exhausted | 748 | 69.3% |
| plan_complete | 331 | 30.6% |
| of those, also plan_complete_with_pending_work | 331 | 100% |
| deadlock | 1 | 0.1% |

with 9,448 pending items and 6,325 planned events unfired at exit. Every run
recorded as complete still held outstanding work. **No run in this workload
terminates because it is finished.**

That makes `max_iterations` a crude instrument in a specific way: it does not
measure how much happened, it decides where we stopped looking. Depth is flat
across 1,500 to 24,000 steps, so raising it buys wall clock and nothing else,
and tuning any effect through it couples the result to the truncation confound.
The values in use - 6,000 for the general grid, 8,000 for Mencius, 5,000 for the
bench - are not comparable quantities of protocol progress.

**Completion looks like a signal rather than bookkeeping.** The two mechanisms
that moved depth furthest also moved completion, in both directions, and
neither was aiming at it:

| mechanism | completion | depth |
|---|---|---|
| client work outlasting a fault (5281 to 5283) | 27.5% to 29.4% | depth>=5 +29%, merged |
| holding deliveries to win timer races (5285 to 5287) | 30.5% to 25.7% | depth>=5 pGreater 0.0005, rejected |

Two points are not a law and neither is causal. But the sign is consistent, the
mechanisms were unrelated, and it reframes an earlier entry here: when the audit
argued depth gains were an artifact of truncated runs, the refutation was that
exhaustion fell while depth rose. That was read as merely rebutting the charge.
It is better read as the finding - the completion rise may be the mechanism
rather than a side effect.

**Three consequences worth carrying.**

A run that ends with work outstanding tells us less than one that finishes, so
steering toward termination is a mechanism family in its own right. Detecting a
condition that wastes a run and recovering from it is the shape; a timeout storm
is the obvious candidate, since general mode admits timers freely and has no
admission control.

Protocols differ in what completion requires, so a fixed constant is the wrong
instrument and adapting to the run is the right one. This is the clearest case
so far for adaptivity being worth building rather than tuning.

For a bug panel, completion is the only progress signal that is free across
hosts. Violations need porcupine, which works everywhere. Depth needs an oracle
DAG authored per protocol, which is the expensive part of adding a host.
Completion needs nothing - it is already in the termination counters and is
protocol-agnostic. It also supplies the detector for a liveness member such as
`Mencius_P.spur`, whose documented bug wedges the log and which porcupine
structurally cannot see.

## 2026-08-27T22:05:00.000Z (operator) - the mechanisms that raised VR depth lower Mencius detection, at just under the merge bar

The retrospective that claimed this was void: the panel member never ran the
mechanisms it was supposed to be testing. Measured properly, two arms on
`Mencius_opt1_2.spur`, 44,016 runs each, one binary, configs built from the
merged `general_vr.json` with the 12 Mencius workload keys overlaid, differing
only in:

| key | off | on |
|---|---|---|
| `post_fault_client_ops` | 0 | 1 |
| `purgatory.delay_duration_range` | [5, 100] | [5, 300] |

| arm | runs | violations | rate | wall |
|---|---|---|---|---|
| off | 44,016 | 408 | 0.009269 | 318 s |
| on | 44,016 | 357 | 0.008111 | 446 s |

Ratio 0.875, a 12.5% loss of detection. Against the seed-varying dispersion of
0.67 measured on this spec, z = **2.26**; uncorrected it is 1.85. Neither
reaches the 2.7 merge bar, so the honest verdict is **probable, unresolved**,
in the direction of overfitting.

Three limits on the claim. One seed per arm, with the dispersion factor
imported from a different config. The two mechanisms were varied jointly, so
this attributes nothing to either. And it is one protocol.

**Corrected below (22:20Z): one of the two mechanisms had no occasions to fire,
and the probe is structurally blind to the family it was meant to test.**

The point estimate lands within 2% of the 0.893 the void retrospective
reported. That is coincidence and must not be read as corroboration - the
earlier comparison had both arms running identical search, so it could not
have detected anything.

Two consequences for the panel. First, this is the case for building it: the
loop's merge criterion is a VR depth proxy, and the one measurement of what
those merges do elsewhere points down. Second, it sizes the thing. A 12.5%
effect reaches z = 2.7 at 62,823 runs per arm, 7.5 minutes per arm at the
measured 139 runs/s. A panel that wants to resolve effects this small on a
single member per validation cannot afford it; it needs either several members
voting or a gate set at collapse-detection rather than gradient resolution.

The `on` arm also took 40% longer for an identical run count, so the merged
hold band buys its depth with wall time that the panel would pay on every
member.

## 2026-08-27T22:20:00.000Z (operator) - correction: the transfer probe varied one mechanism, not two, and cannot see fault-path work at all

The 22:05Z entry above reports a 12.5% detection loss on `Mencius_opt1_2.spur`
and attributes it to "the mechanisms that raised VR depth". Both halves of that
attribution are wrong.

**`post_fault_client_ops` was inert in both arms.** The Mencius workload keys
overlaid onto the arms carry `num_crashes: {min: 0, max: 0}`. In
`spur-core/src/simulator/path/generator.rs:210` the post-fault pass iterates
`recover_indices`, collected from `EventAction::RecoverNode`. With no crashes
there are no recoveries, the list is empty, and the pass adds zero edges. The
arms therefore differ in exactly one effective way: the purgatory hold band,
[5,100] against [5,300]. The 12.5% belongs to the hold band alone, and it is a
cleaner single-mechanism result than the original entry claims - but it is not
a measurement of "the mechanisms merged tonight".

This is the failure the "a mechanism must count its own firing" rule in
GOAL.md exists to prevent, and it is the third time tonight the same shape has
appeared (the quick-fire multiplier, the dead cfg feedback path, now this).
The rule was applied to hypotheses and not to an operator measurement.

**The deeper problem is the probe itself.** `bin/spur/mencius/bug_opt1_2.md`
states the Rule 2 / Rule 3 interaction "does not require crashes, message loss,
or network partitions - only a concurrent revoke". The bug lives on a
fault-free path. The VR bug is reached through fault paths: all three tracked
hazards are crash hazards (H1 crash with an in-flight send, H2
stale-incarnation delivery, H3 two nodes crash and recover). So a
`Mencius_opt1_2` probe is blind by construction to the entire mechanism family
the loop actually merges for VR, and what it does measure is whether
fault-oriented scheduler effort steals budget from fault-free search. It does.

Consequences for the panel, which matter more than the number:

1. **Membership must be selected by bug reachability, not by protocol.** A
   panel weighted toward crash-free bugs will systematically penalise the
   mechanism family that helps VR, and the loop would learn to stop proposing
   it. At least one member must carry a bug that is reachable only after a
   crash and recovery.
2. **Every member needs its fault budget stated.** A member running
   `num_crashes: 0` silently disables every fault mechanism under test, and
   the panel would report that as a detection result rather than as a
   configuration that could not observe anything.
3. **The panel needs the firing rule applied to itself.** Before a member's
   detection rate is compared between two arms, the mechanisms that differ
   between those arms must be shown to have had occasions on that member.

## 2026-08-27T22:55:00.000Z (operator) - the liveness panel member fails its admission check before any code was written

The panel plan makes `Mencius_P.spur` a member whose detector is client
operations left outstanding, on the theory that its wedge - a slot promised
above ballot 0 by a revoker that then crashes - shows up as invocations that
never get a response. The existing `deadlock` counter cannot see it, because
`monitor_suspicions` (`Mencius_P.spur:634`) is an infinite `set_timer` loop, so
`all_queues_empty()` is never true.

The zero-code proxy is `traceanalyzer -grade`'s `unpaired_fraction`, which is
`unpaired_invocations / invocations` and needs no new counter. Admission asked
for the outstanding-op rate to be at least 5x higher with a crash than without.

Within-spec ablation, `Mencius_P.spur`, same overlay, 2,160 runs per arm:

| arm | invocations | unpaired | fraction | runs with unpaired |
|---|---|---|---|---|
| `num_crashes` 1..1 | 12,208 | 1,609 | 0.1318 | 1,285 |
| `num_crashes` 0..0 | 12,751 | 1,370 | 0.1074 | 1,125 |

Ratio **1.23x** against a bar of 5x. The difference is real (z = 5.9) and far
too small to admit: **the member is dropped.**

The reason it fails is the interesting part. **10.7% of client operations go
unanswered with zero crashes**, so baseline incompleteness dominates and the
wedge is buried inside it. This is the same fact as the 21:45Z entry - no run
finishes - arriving as a measurement problem: a detector built on "work left
outstanding" has no floor to measure against on a protocol where a tenth of the
work is outstanding anyway.

Two consequences. A completion-based detector needs a member whose fault-free
outstanding rate is near zero, and none of the Mencius family qualifies; the
cross-protocol completion signal has to be validated per host before it is
trusted anywhere. And `client_ops_outstanding` as a new counter in
`util_stats.rs` should not be built for this member - the proxy already shows
there is nothing here for it to resolve. Build it, if at all, for a host that
passes this same ablation first.

A cross-spec comparison run first, at a fixed one crash, gave `Mencius_P`
0.1318 against `Mencius_opt1_2` 0.2362. That comparison is uninformative - it
says the opt-1-2 spec blocks more, not that P wedges - and it is recorded only
so the number is not mistaken for evidence later.

## 2026-08-27T23:30:00.000Z (operator) - CRAQ.spur does not compile, and the panel's first spec set is built

`bin/spur/CRAQ.spur` cannot be run. It calls `@rpc_call(tl!, Read(key))` at
five sites and the parser rejects `@`; it is the only spec in the repo using
that syntax, so it was written against an older language version and never
ported. Compile-checked every reference spec at 200 runs to be sure it was the
only one:

| result | specs |
|---|---|
| runs | EPaxosStar, Gryff, Paxos, Raft, Raft_rtc, SDPaxos, VR, test_rmw, all five Mencius |
| fails to parse | CRAQ |

The panel plan named a CRAQ dirty-read injection as its second fault-free
member. That member is not buildable without first porting the host, and a
ported spec would then be serving as a **clean control** with nothing to
validate the port against - the same shape as the fixture that closed a
hypothesis for a defect of its own. Substituted `Paxos.spur` instead: deleting
the acceptor's ballot guard in `HandleP2a` lets a superseded proposer's pvalue
be accepted, so two commands can be chosen for one slot. It needs no crashes,
only two proposers duelling under timer pressure, so it holds the fault-free
slot the CRAQ member was there to fill.

First spec set, smoke-tested at 200 runs each:

| spec | role | runs | violations |
|---|---|---|---|
| `panel/raft_clean.spur` | control | 200 | 0 |
| `panel/raft_stale_vote.spur` | member | 200 | 0 |
| `panel/raft_commit_prev_term.spur` | member | 200 | 0 |
| `Paxos.spur` | control | 200 | 0 |
| `panel/paxos_accept_stale_ballot.spur` | member | 200 | 1 |

Both Raft members are built from `raft_clean.spur`, not from `Raft.spur`.
`Raft.spur` counts a reply whose term is below its own: neither
`AppendEntriesReply` nor `RequestVoteReply` checks `resp_term == current_term`
after the step-down test, so a vote granted in term T can be counted after the
candidate has advanced to T+1, and with three nodes that is a second leader in
one term. Raft's own description of the reply path requires dropping stale
replies, so this is an implementation bug in the translation rather than a
paper finding. `raft_clean.spur` adds the guard at both handlers, and each
member is exactly one defect away from it.

200 runs settles compile-and-run, not rates. Every rate is measured at
calibration, and the Paxos member's 1-in-200 is already below the admission
band, so its workload needs retuning before it can gate.

## 2026-08-28T00:05:00.000Z (operator) - a host has a detection ceiling, and Raft's is ten times below the panel's admission band

Three separate Raft injections detected at or near zero, so the fault machinery
was checked before any of them was tuned further. It fires abundantly: at
`num_crashes 2..4` over 20,016 runs, `crash_recovery` reports **60,048 crashes
and 60,048 recovers**, 7,694 runs with a crossing delivery, and
`post_fault_ops` reports 58,835 client operations invoked after the last
recover. Faults are not the missing ingredient.

A positive control settles it. `raft_clean.spur` with the vote guard replaced
by `if (true)` grants every vote request unconditionally, so split brain is
near certain in any run with two candidates:

| spec | injection | runs | violations | rate |
|---|---|---|---|---|
| `raft_always_vote` (control, not a member) | grant every vote | 20,016 | 42 | **0.0021** |
| `raft_stale_vote` | count a reply from a superseded term | 20,016 | 3 | 0.00015 |
| `raft_forget_vote` | recovered node forgets `voted_for` | 20,016 | 0 | 0 |
| `raft_commit_prev_term` | commit an entry from a previous term | 20,016 | 0 | 0 |
| `raft_clean` | none | 20,016 | 0 | 0 |

**A guaranteed safety violation surfaces as a linearizability violation only
0.2% of the time.** That is the host's ceiling, not the bug's rate: most Raft
divergence never reaches `ClientInterface` as an observable history, because
the client retries and redirects until some leader answers successfully. Every
Raft member is therefore bounded by 0.0021, ten times below the panel's [0.02,
0.20] admission band, and no workload tuning can lift it - tuning changes how
often the bug is *reached*, and the ceiling is about whether reaching it is
*seen*.

This is a missing admission criterion, and it is cheap. Before sizing any
member, measure its host's ceiling with a deliberately blatant injection of the
same class. A host whose ceiling sits below the band can supply members that
report, never members that gate, and the fix is a different host rather than a
different workload. Call it C0 and run it first: it costs one 20,000-run arm
and it would have saved every tuning cycle spent on Raft tonight.

Read the other results against that ceiling rather than against zero.
`raft_stale_vote` at 0.00015 is 7% of everything its host can express, so the
bug is genuinely being reached; the other two sit below what 20,016 runs can
resolve.

Paxos, by contrast, clears the band. At three to four concurrent writes and
four to six write operations with no crashes, `paxos_accept_stale_ballot`
detects at **0.0251** over 20,004 runs while `Paxos.spur` at the same workload
violates **0 times**, so its C1 passes and the member is admissible as it
stands. Its rate rose monotonically with concurrency (0.0064, 0.0170, 0.0251),
which is the responsiveness a gradient member needs.

## 2026-08-28T01:20:00.000Z (operator) - the panel's A/A test found the perf lane already blocked

First A/A run of the panel, both arms on the same binary and the same config
template, seed 20001:

| member | candidate | baseline | z |
|---|---|---|---|
| `paxos-accept-stale-ballot` | 102/5,928 | 110/5,928 | -0.55 |
| `mencius-opt1-2` | 109/12,960 | 100/12,960 | +0.63 |

Combined z **0.05**, nothing collapsed, wall 410 s against a 395 s estimate.
The four report members ran one arm each and correctly declined to judge.
`raft-stale-vote` fired 8 times in 20,016, consistent with its calibrated
0.00015. The pairing is unbiased on this evidence.

The run also failed its `throughput` case, and that failure was already there.
`tmp/loop/spur-baseline` dated from 12:04; the structural-multiplier-authority
merge later added `emit_multiplier_authority` to the evaluation template, and
the preserved binary rejects an unknown top-level key under
`strict_config_keys`. Every hypothesis that reached the throughput case would
have failed it, and the gate would have reported "regression suite failed" on
hypotheses that did nothing wrong - a total block on the perf lane, not a
degraded comparison. Iterations 5304 to 5306 all ended at sequential without
reaching regression, so nothing had tripped it yet.

This is the exact failure the operator reference warns about, and the interval
between the merge and the discovery is the point: about seven hours, during
which nothing would have looked wrong. Two things follow. The `cp` after a
merge deserves to be a step the harness performs rather than one the operator
remembers. And an A/A run of the full suite is cheap insurance that is worth
taking after any merge that touches the config template, not only when a panel
is being commissioned.

## 2026-08-28T01:55:00.000Z (operator) - the panel's A/A control passes over four seeds

Four A/A runs of the full suite, both arms on the same binary and the same
config template, seeds 20001 to 20004:

| seed | paxos z | mencius z | combined Z | wall |
|---|---|---|---|---|
| 20001 | -0.55 | +0.63 | +0.05 | 410 s |
| 20002 | +1.25 | +0.52 | +1.25 | 404 s |
| 20003 | -1.02 | -0.30 | -0.93 | 411 s |
| 20004 | -0.15 | +0.22 | +0.05 | 419 s |

Across eight paired comparisons the individual z has **mean +0.075 and sd
0.726**, range -1.02 to +1.25. No member sits off zero, no run reached the
-2.0 downgrade bar, and none of the eight reached the -2.7 collapse bar. The
pairing is unbiased on this evidence: 4 seeds bounds a gross miscalibration,
not the 0.35%-per-member false-block rate, which needs the real validation
series to confirm.

The sd is the part worth keeping. Under the null it should be 1.0. Observing
0.73 is the conservative variance choice made visible: the gate decides with
phi = 1 while the measured seed dispersion on these members is 0.35 to 0.56, so
every computed z is smaller than a correctly scaled one and the true
false-block rate sits **below** the nominal figure. The decision to reject the
measured dispersion for anything that blocks was made on the argument that a
deflated variance makes a blocking test fire on noise; this is that argument
holding up in measurement rather than in principle.

`throughput` passes in all three runs after the baseline binary was refreshed
(ratios 0.995, 1.018, 1.008), which confirms the stale `spur-baseline` was the
whole of that failure and not a symptom of the panel.

## 2026-08-28T02:35:00.000Z (operator) - the hold band costs Mencius a fifth of its detection and Paxos nothing

The panel's first real measurement. Two arms differing only in
`purgatory.delay_duration_range`, [5,100] against [5,300], same binary, same
seed, each member at its calibrated workload:

| member | hold100 | hold300 | ratio | z |
|---|---|---|---|---|
| `mencius-opt1-2` | 948/100,008 (0.00948) | 756/100,008 (0.00756) | **0.797** | **-4.67** |
| `paxos-accept-stale-ballot` | 1,709/94,751 (0.01804) | 1,678/94,752 (0.01771) | **0.982** | **-0.54** |

The Mencius effect is real and larger than first measured: the single 44,016-run
comparison earlier tonight gave ratio 0.875 at z = -2.26, under the merge bar
and easy to dismiss. At 100,008 runs per arm it is 0.797 at z = -4.67. **A
fifth of Mencius detection is spent on the wider hold band.**

Paxos shows nothing at 94,752 runs per arm, where a 12.5% effect would have
been caught with 80% power at z = 2.7. The observed change is 1.8%.

Both members are fault-free. The mechanism has occasions on both - the hold
band delays deliveries with no crashes needed - so this is not a firing
failure. The effect is a property of the host, not of the mechanism.

That retires the reading, not the number. The 22:05Z entry recorded the
Mencius decline; the 22:20Z correction narrowed it to the hold band alone and
said it measured whether fault-oriented effort steals budget from fault-free
search, concluding "it does". **That conclusion was still too general.** It
steals budget from *this* fault-free search. A second fault-free host, with a
bug of a different shape, pays nothing. Mencius's rule-2 violation needs a
concurrent revoke to land inside a specific gap-fill window, and holding
deliveries longer disperses that window; Paxos's superseded-ballot accept has
no such window to disperse.

This is the panel earning its cost on its first use, and the argument for more
than one member stated as evidence rather than as design. A single-member panel
would have reported a 20% erosion and blocked on it. Two members show it is
one host's sensitivity.

One consequence for the gate as sized. At the panel's operational 12,960 runs
per arm, a genuine 20.3% Mencius decline yields z = -1.68 - short of the -2.7
collapse bar, and combined with a neutral Paxos it is about -1.3, short of the
-2.0 downgrade. The panel would let this through on a single validation and
accumulate it over two or three. That is the design working as specified
(collapse gates within a validation, gradient accumulates across), and it is
also the honest limit: effects of this size are not caught the first time they
appear.

## 2026-08-28T09:15:00.000Z (operator) - the loop moved to a 16-core host; the ladder reproduced, the writer did not

New host: Ryzen 9 9950X, 16 cores, 32 threads, 30 GB, so `rayonThreads`
resolves to 30 against 14 before. Every calibrated number was retaken per
`research/TRANSFER.md`. The result worth recording first is that the
general-config ladder did not move:

| metric | old host, latest merged | new host, baseline 000 |
|---|---|---|
| meanPrefixDepth | 3.06 | 3.07 |
| P(depth>=4) | 0.366 | 0.367 |
| P(depth>=5) | 0.111 | 0.111 |
| P(depth>=6) | 0.015 | 0.017 |
| P(depth>=7) | 0.002 | 0.002 |
| P(depth>=8) | 0.000 | 0.000 |
| violations | 0 | 0 |
| runsPerSec | 273 | 603 |

Two seeds and four 54,000-run chunks agree to the third digit. The shared
feedback map is sensitive to thread count in principle; at 14 against 30 it
was not measurably so on this config.

**The explorer was writer-bound on this host, and the old host was one
Raft arm from the same OOM.** Every simulation thread handed its finished run
to one parquet-writer thread through an unbounded channel. On the Raft panel
members (5 servers, 12,000 iterations, about 1 MB of rows per run) the writer
drained ~600 runs/s while 30 threads produced ~1,000, so memory grew at 1 GB/s
and the 20,016-run arm was OOM-killed at 20 GB; the same arm at 14 threads
peaked at 12.8 GB against the loop's 14 GB cap. On the VR general config the
single writer sat at 88% of a core while every simulation thread waited on it
half the time. Bounding the queue (spur 8fb2891) fixed the memory at the same
wall, since the writer was already the ceiling; one writer per eight
simulation threads (spur 28a81df) lifted the ceiling: Raft arm 32.0 s ->
21.3 s, VR 5,400 runs 11.1 s -> 9.3 s, simulation threads 52% -> 90% busy.
Readers are unchanged: each writer owns its own interleaved `batch_NNNN`
series and porcupine, traceanalyzer and `spur debug` all glob the directory.

**Hyperthreads add nothing.** VR at 16 threads takes 9.31 s against 9.30 s
at 30, with 70% more CPU-seconds; the 16 cores were already saturated.
`rayonThreads` stays at the derived 30 because it costs nothing here and a
policy field would cost a parameter.

**Panel recalibration** (`research/panel/manifest.json`,
`PANEL_CALIBRATION.md`): rates reproduced across three passes (Paxos 0.0169
-> 0.0166, Mencius 0.0077 -> 0.0074, Raft members at or under 3e-4 beneath the
0.0021 ceiling); throughput rose 2.3x to 3.3x; gate arms resized to 6,024 and
13,488. `paxos-forget-promise` reported 4 against 3 on its own control and is
close to `Paxos.spur`'s background rate at this count.

**A/A over four seeds** (20001-20004), both arms on HEAD:

| seed | paxos z | mencius z | combined Z | throughput ratio |
|---|---|---|---|---|
| 20001 | +1.46 | +0.35 | +1.28 | 1.011 |
| 20002 | -0.92 | +1.00 | +0.06 | 1.014 |
| 20003 | +0.27 | +0.77 | +0.73 | 1.000 |
| 20004 | 0.00 | -0.94 | -0.67 | 1.012 |

Eight individual z: mean +0.249, sd 0.858 (old host: +0.088, sd 0.850). No
run approached the -2.0 downgrade bar. Panel wall per validation is 136 s
against 395 s before.

Two host facts that cost time and are now in TRANSFER.md: a systemd user
unit does not inherit the shell PATH, and the system node here is a
different major version from the nvm one better-sqlite3 was built against,
so the CLI segfaulted with an empty log until `--setenv=PATH` was passed;
and the daemon's build command pulled spur-bench's Formulog toolchain in
through feature unification until spur-bench left the default member set.

## 2026-08-28T23:50:00.000Z (operator) - the loop runs on one CCD with its own calibration

The host is shared from today: the loop is pinned to CPUs 0-7,16-23 (one CCD,
14 resolved threads) and the other CCD is free for other work. Calibration is
now keyed by thread count (`baseline:<threads>`, `000-baseline-<threads>.json`,
`panel/manifest.<threads>.json`), so switching masks is a restart. Pinning
goes through `taskset`: the cpuset controller is not delegated to user units,
and a unit started with `AllowedCPUs` ran unpinned and recorded a 30-thread
baseline before that was noticed.

The 14-thread ladder reproduces the 30-thread one per run (P(depth>=6) 0.0374
against 0.0366, P(depth>=8) 0.00128 against 0.00123, 0 violations on both)
at 82% of the runs per chunk (175k against 214k). The panel keeps its power
narrowly: Mencius lands at 108 expected events per arm against the 100 the
sizing demands. Four A/A seeds pass with combined Z between +0.05 and +0.79,
phi at most 1.44, throughput ratios 0.996 to 0.999; the observed panel wall is
465 s of a 560 s case wall, 17 s over the 80% the sizing reserves.

## 2026-08-29T02:40:00.000Z (operator) - the score's terms are named; the plan engine is reproducible; adaptive-operator replay compounds

Landed spur 9c2b928 (plan events released in index order), c5972f7 (the
score as named terms, bit-identical at defaults), 1a6cb6b (send ledger,
predicates, counters, queue authority) and b6b4275 (win-table selftest);
superproject d962012 and b8ec116 carry the pointers. PARAMETERS.md "Steer
terms" has the derivation and the evidence; the short form:

- A/A at 14 threads on HEAD: Paxos z +0.24, Mencius -0.00, combined +0.17,
  throughput 0.977, panel wall 465/560. Passes.
- Null-diff campaign chunk at zero weights against the 14-thread baseline:
  depth>=4/5/6/8 inside the four chunks' spread; depth>=7 high
  (0.00214 against 0.00120-0.00133), all of it in the `aos` arm.
- Two aos-only sessions at one seed, with and without the plan-order fix:
  depth>=6 0.01476 against 0.00785, depth>=7 unchanged. The adaptive
  operator replays recorded draw tapes, and a replayed tape only reproduces
  its run once the plan engine releases events in a fixed order; with
  faithful replay, refinement near a deep run compounds. The 14-thread
  baseline is re-recorded on this binary for that reason. A run on a
  one-worker pool is now a function of its seed for every spec except
  those that iterate an `imbl` map: `VR.spur` iterates `pending_requests`,
  whose hasher is seeded per process, so two identical 540-run standard
  sessions still differ on 70 runs.
- Base rates at zero weight, one 300 s chunk, 518M within-queue
  selections: crash_after_timer_sends present on 0.0005% (0.8% of crash
  selections), crash_after_delivery_sends 0.007% (11% of crashes),
  stale_late 0.19%, request_before_stale 0.31%. Every predicate is rare
  enough to steer on under GOAL.md rule 8. Stale and late deliveries are
  acted on 8.7% of the time, sender-restarted deliveries generally 15.9%.
- No flip and no routing draw at zero weight; on the relay fixture with
  weights, choices flip and the router routes.

Seeded `steer-term-base-rates` (meta) and `steer-term-factorial-campaign`
(arm) for the loop. Not changed: the `imbl` map hasher.

## 2026-08-29T07:06:11.482Z

**purgatory-rate-to-stale-late-arm** (closed): Falsified: the stale_late preference cannot substitute for the purgatory delay rate. Across 2 chunks / 343,680 runs the grid-stale-late arm (purgatory.delay_probability=0, steer_terms.stale_late=2.33) tracked grid-no-purgatory, not grid: pooled P(depth>=6) per run ~0.0256 vs grid ~0.0413 and no-purgatory ~0.0244; depth>=7 ~0.0048 vs grid ~0.0098. Sequential eval rejected with pMei 0.000 at every rung (d4/d5/d6), objective deltas depth>=5 -0.029, depth>=6 -0.044, depth>=7 -0.036. No throughput win either (108.8 runs/s vs grid 110.5, -0.5% overall), so the arm is strictly dominated: it pays no less and buys ~40% less deep-prefix yield. Mechanism evidence supports the red-team firing-rate argument: purgatory delayed 10.8M/112.4M deliveries (~9.6%) per chunk while total preferenceExpressed across ALL steer terms was only ~114k steps out of ~515M (0.022%), of which ~23% were honored — roughly 4 orders of magnitude fewer firing occasions. The delay rate's contribution is therefore volumetric (many small reorderings of ordinary sends), not a rare targeted stale-late ordering; the relaxation-gap ablation's story about which ordering matters does not imply that ordering is the only thing purgatory buys. Corollary: senderRestarted deliveries are only ~166k/chunk (0.15%) and receiverRestarted ~315k (0.28%), with acted_fraction 0.154 and 0.022 respectively vs 0.377 overall — the population stale_late can even see is tiny and low-yield, so no weight setting rescues it. Also confirmed: delayed deliveries act at 0.118 vs 0.377 overall, so the delay rate's value is not that delayed messages do more, it is that holding them reshapes what the un-delayed ones interleave with. Do not retry this substitution at other weights; the gap is structural. Zero violations in 343,680 runs across all six arms, consistent with the campaign's long-standing violation drought.

## 2026-08-29T07:35:02.970Z

**steer-term-factorial-campaign** (closed): Null on the factor grid, plus one unexpected perf finding. (1) All three main effects are inside counting noise on depth>=6/run, pooled over 3 seeds (~43k runs, ~400 depth>=6 events per arm, rel. SE ~3.5%): crash_after_timer_sends +2.9%, stale_late +2.6%, request_before_stale -4.5%; pairwise interactions likewise <1.5 sigma. Nothing approaches the 7.5% A/A floor for depth>=6. The relaxation-gap prediction that the three orderings must co-occur is untested, not refuted -- the terms never got the chance to act. (2) Mechanistic reason, from utilStats.steerAuthority: preferenceExpressed = 339,717 over 527M steps = 0.064% of steps, ~2.9 expressions/run, of which only 35% honored (preferenceHonored 119,762, ~1.03 honored/run) with blockedByTimerGate = 0. One honored preference per ~4,545-step run cannot reshape a prefix. At weight 2.33 the predicates have essentially zero reach; a 2^3 grid over weights was premature -- the binding constraint is firing rate and honor rate, not dose. (3) Throughput fell to 383 runs/s vs baseline median 575 (0.666, below the 0.8 floor) and that is what closed the hypothesis -- but arm 000 (all three weights 0, i.e. today's grid) ran at 14,656 runs / 37.69 s = 389 runs/s, identical to every steered arm, so the tax is not the steer weights. Per-arm wallMs ~37.6 s == 3 x 12.5 s slice budget, so slice-switch idle is ~0; the cost is per-step, inside the loop. Inference: steer_term predicates are evaluated unconditionally and then multiplied by their weight, so a zero-weight term still costs full evaluation. Every future steer campaign pays ~33% throughput for terms it has switched off. (4) Grader artifact: objectiveDeltas depth>=4..>=8 (-0.25 to -0.32) track throughput (-0.33) almost exactly, because depthAtLeast is an absolute count. Per-run depth>=4 was 0.7045 here vs a baseline implied ~0.69 -- flat to +2%. The reported 'depth regression' was a throughput regression wearing a depth costume; do not read count-based depth deltas without dividing by runs. Violations 0 in all three seeds, deadlocks 42-54/115k, no arm tripped the flip-fraction guardrail (steer_terms.<term>.flipped counters were not emitted at all -- the per-term counters named in the hypothesis notes are absent from the campaign arm records, only the aggregate steerAuthority block exists, so the schedule-rewrite guardrail could not have fired even if breached).

## 2026-08-29T07:57:52.210Z

**value-size-and-chunk-allocation** (auto_merge): Confirmed and merged: boxing ValueKind::List/Tuple's imbl::Vector plus imbl's small-chunks feature moved the bench from 499.3 to 563.1 rps (+12.8%, strict dominance across rounds), the second-largest perf win after reduce-explorer-memory-footprint (+29.9%) and won by the same lever — cutting bytes moved, not allocator overhead. The 5136-byte per-vector chunk was real and load-bearing: every non-empty list/tuple paid it regardless of length because imbl's inline predicate (48 / size_of Value) floored to 0 at Value=80. Semantics held exactly as predicted: screen seed 11 and promote seeds 11/23 all report 0 violations, 0 unknown, h1 .489-.500, h4 .924-.933, meanPrefixDepth 3.28-3.31, maxPrefixDepth 8, general config params 18 before and after — a pure representation change, no scheduling drift. The feared small-chunks downside (HASH_LEVEL_SIZE 5->3, ord-map 64->6 deepening ValueMap tries) did not cost enough to need the boxing-only fallback bench, so trie depth is not on the hot path at Spur's map sizes. Combined with the earlier ABBA result that mimalloc is 8% *slower* here, the pattern is now twice-confirmed: on this workload glibc malloc is fine and the win is always in reducing the count and size of >=1032-byte (tcache-limit) allocations. Cheap to run: three graded evaluations totalling ~64 s wall for a +12.8% merge, expectedCost 3 was about right.

## 2026-08-29T09:48:54.114Z

**purgatory-delay-probability-sweep-arms** (needs_human): Three-point sweep landed: delay_probability curve is non-monotone and 0.15 is at/near the depth optimum per run, while throughput falls off hard above it. Per-run P(depth>=6) by arm: 0 -> 0.0246 (548/22260), 0.05 -> 0.0302 (666/22080), 0.15 (grid) -> 0.0410 (880/21480), 0.30 -> 0.0463 (916/19800), 0.50 -> 0.0318 (528/16620). depth>=7 per run: 0.0042 / 0.0051 / 0.0090 / 0.0110 / 0.0060. So 0.30 is ~13% better than 0.15 per run on depth>=6 and ~22% on depth>=7, 0.50 is clearly worse than 0.15 on both — an interior peak somewhere in [0.15, 0.30], not a monotone knob. But runs/arm-slice falls monotonically with the rate (21480 @0.15, 19800 @0.30, 16620 @0.50 in equal ~37.6s wall), so per-second depth>=6 is 880/37.6=23.4 @0.15 vs 916/37.6=24.4 @0.30 vs 528/37.6=14.0 @0.50: 0.30 still edges 0.15 by ~4% per second, 0.50 loses ~40%. The 0.50 arm's rewardRate collapses to 55.8 vs 135-174 elsewhere, i.e. holding half of all sends starves termination (fewer completed plans) faster than it buys interleaving depth. Volumetric confirmation from utilStats: delayed accounted for 27.4M of 160.7M deliveries (17.1%) with 3.92M acted, against only 133k steer preferences expressed and 25.8k honored — the rate remains ~200x more mechanistically active than the preference channel. No violations in any purgatory arm (the single violation was the aos arm at 135.8s, unrelated to the sweep). Objective deltas are all negative on depth (-0.15 on depth>=6, -0.14 throughput) purely because six arms now split the same 300s round-robin budget instead of the prior four — the campaign-level aggregate dilution is an artifact of arm count, not a regression in any arm; verdict needs_human because arm changes require review in v1. Caveat: one seed, ~20k runs/arm, so 880 vs 916 at depth>=6 is within roughly 1.5 sigma — the 0.15-vs-0.30 ordering is suggestive, not established; only the 0.50 penalty and the 0-vs-nonzero gain are well separated.

## 2026-08-29T10:06:31.268Z

**post-fault-client-ops-sweep-retry** (closed): Sweep ran and the knob is live, not inert: 4-arm round-robin grid over post_fault_client_ops={0,1,2,3} on VR.spur, seed 1000, 173,460 runs / 300s, 0 violations, 0 unknown. Per-run depth fractions (depthAtLeast[k]/runs): d4 .4909/.4798/.4429/.4113, d5 .1483/.1691/.1539/.1379, d6 .0423/.0438/.0369/.0301, d7 .00859/.00948/.00759/.00562, d8 .00122/.00168/.00165/.00136 for doses 0/1/2/3. So the response is NOT flat: d4 is monotone decreasing in dose (-16% from 0 to 3), while d5-d8 are an inverted-U peaking at dose=1 (+14% d5, +10% d7, +37% d8 vs dose=0) and degrading monotonically for dose>=2. Reward rate rises monotonically with dose (151.1/162.8/172.5/186.0 runs-completed/s), i.e. more post-fault client work terminates runs earlier -- the plausible mechanism for the deep-tail loss at high dose: shallow-prefix churn trades against long branch prefixes. The override plumbing (config_override) is therefore validated end-to-end by behavioral divergence alone, even though utilStats exposes no post_fault_ops.edges_added counter to confirm actuation directly; the falsification clause ('flat curve while edges_added tracks knob') did not fire. Methodological lesson, arguably the larger result: a round-robin dose sweep scored as a candidate is structurally doomed -- 3/4 of exposure went to inferior arms, so the campaign aggregate lost to baseline (d4 per-run ratio 0.98, primary d6 -0.293) and the sequential gate rejected after 1 chunk. The best arm was never evaluated head-to-head against baseline, so we still do not know whether dose=1 beats the current default; the sweep bought a shape, not a verdict. Future sweeps should be run as measurement-only exposure, or the runner needs a per-arm accept path that promotes the argmax arm rather than the campaign mean. Ancillary: h2 +0.0051 (uniform, dose-insensitive), throughput -0.318 aggregate, termination iterationsExhausted 123,166/173,460 (71%) vs planComplete 50,219 (29%), deadlock 75; steerAuthority preferenceHonored 20,623/101,320 (20%) expressed.

## 2026-08-29T11:03:05.394Z

**end-run-at-plan-stall** (closed): Implemented and evaluated at sequential fidelity (seed 1000, 30 rayon threads, 5-arm round-robin, 300s): 369180 runs at 1229 runs/s, +45% throughput and +43-55% on every depth>=k rate vs baseline, regression+lint clean. Verdict closed: primary (violation rate) moved by 2.7e-6 with exactly 1 violation observed in 369k runs, and depth>=4 landed in both improved and regressed lists across arms (panelZ 0), so nothing separated on CI. Three concrete readings from utilStats. (1) The stall exit did NOT eliminate budget exhaustion: iterationsExhausted is still 110449/369180 (30%), planComplete 100478 (27%), deadlock 168; ~158k runs (43%) exit through neither counter, i.e. through the new abandon path. So the 500-iteration no-delivers detector catches under half of the wasted budget; another class of run still spins to the cap with live-but-unproductive events. stepsUsedSum/stepBudgetSum = 0.40, consistent with lots of partial burn. (2) planCompleteWithPendingWork == planComplete exactly (100478 == 100478): every 'completed' plan finished with outstanding work, so the completion predicate is decoupled from quiescence and the two counters carry one bit, not two. (3) Perturbation is mostly wasted at the delivery level: 53% of all deliveries cause the receiver to act, but only 15.2% of biased deliveries (3365980/22143838), 15.5% of delayed, 14.9% of sender-restart, and 2.3% of receiver-restart deliveries do. ~85% of the scheduler's interesting choices land on no-op deliveries. Steering is near-silent too: preferenceExpressed 216735 over 630.5M steps (3.4e-4), honored 42002 (19% of expressed), blockedByTimerGate 0. Methodological conclusion that dominates the result: at ~1 violation per 370k runs the primary objective cannot separate any intervention, so throughput and depth gains are unpurchasable in the currency being scored. Buying 45% more runs bought zero primary signal — further perf/throughput work on this bench is a dead branch until either the signal density or the primary metric changes. Also note the change added a config param (18->19) despite the 'no tunable' generality claim.

## 2026-08-29T11:08:27.929Z

### Audit @5315
Implement is 1095.3/2396.1 = 45.7% of all phase time; measurement (evaluate 520.4 + regression 560.1 + rejudge 153.7) is 51.5%; propose is 0.00036 (0.00002%) and build 0.15 (0.006%). Inside implement, model/think averages 342 s of ~442 s accounted per iteration (77%), with 13.3 edits and 3.6 cargo builds per iteration — i.e. the single largest line item in the whole loop is LLM deliberation, not compilation or measurement. Worse, implement time is frequently spent with no measurement attached: in the last 15 iterations, 5303 (20 s), 5310 (83 s), 5313 (867 s) and 5305 (0 s) ran implement/propose and never reached evaluate — ~970 s of implement with zero ladder output, ~24% of the implement time in the window. Evaluate cost is also wildly dispersed: 5306 spent 4320 s evaluating while 5309 spent 85.6 s, a 50x spread with no visible fidelity policy explaining it. Separately, wall-clock (not phase) waste dominates everything: iteration 5306 finished 2026-08-27T21:39Z and 5307 started 2026-08-29T06:48Z — 33.1 h of idle host with a 32-thread box provisioned. Campaign budget concentration: the 300 s campaign is split round_robin 20% each across 5 arms, so 40% of every evaluation's wall goes to grid-post-fault-2 (per-run P(d>=6) 0.0371 vs grid 0.0407, i.e. worse) and aos (whose own mechanism records tape_wins=0, config_wins=0). That is ~120 s of every 300 s chunk buying no discriminating signal.

Goodhart: Half the primary objective is manufactured by run truncation. grid-short (max_iterations 1500 vs 6000) contributes 77.69 of the 161.14 total d>=6/s across arms (48%) and 323.56 of 674.9 d>=5/s (48%). Its per-run rung probability is identical to grid (77.69/1924 = 0.0404 vs 22.70/558 = 0.0407 for d>=6; 0.1682 vs 0.1639 for d>=5) while running 3.45x more runs/s. The objective 'rung events per explore-second' therefore rewards shortening runs, and any change that makes runs terminate earlier scores as a discovery win.; The same fact is an unexploited efficiency finding being read as a metric artifact: 4 of 5 arms burn 4x the iteration budget for zero additional per-run rung probability, meaning ~75% of simulated iterations in those arms are dead compute.; Reference-config divergence is extreme and unaddressed: h4Rate is 0 in the reference (000) and 0.916 at baseline; P(depth>=4) is 0.034 vs 0.469 (13.8x); meanPrefixDepth 2.26 vs 3.28. The explore config is sampling a qualitatively different distribution from the reference the ladder is nominally calibrated against, so 'ladder improvement' may not correspond to any improvement on the reference workload.; The campaign reward (termination_completed) is not the objective. Arm reward rates (158.9 / 483.3 / 171.0 / 171.4 / 146.5) track runs/s almost perfectly (r ~ 1.0 against 558/1924/579/572/544) and not d>=6/s. Any future switch from round_robin to a bandit allocation would allocate budget to throughput, not depth.; 'merged' as a success counter is diluted by scaffolding: at least 3 of 28 merges (config-override-effectiveness-smoke, config-override-test-state-isolation, util-stats-parse-into-chunk-metrics) are enabling/instrumentation hypotheses that cannot move the objective. The pool even contains a parked hypothesis (enabling-merge-requires-nonempty-code-diff) acknowledging that enabling merges can land with no code diff.; Zero-cost propose phase (0.00036 s cumulative, 0.000 every iteration in the last 15) with 63 parked and 8-11 proposed items means the loop is draining a stale queue rather than generating hypotheses against current utilization evidence — the visible proposals are 3rd- and 4th-order refinements of steer and post_fault dosing, both of which utilization shows are inert or non-improving.

Utilization: steer / feedback timeline scoring=broken, multiplier_authority=broken, aos=unexercised, dedup=unexercised, curriculum=unexercised, timer gate / hold=unexercised, post_fault_client_ops=unrewarding, purgatory delay=healthy, crash_recovery / post-fault edges=healthy, recovery_window instrumentation=broken, rng_stream_isolation=scaffolding, campaign reward (termination_completed)=scaffolding

Policy suggestions: Invalidate the value-size-and-chunk-allocation merge result and re-measure it. Its 26 s exposure is below the 100 s minimum for one round_robin round over 5 arms at min_slice_sec = 20, so it never ran the campaign it is being scored against. Add a hard gate: no ladder row may be compared to baseline unless exposure >= 1 full campaign round (>= 300 s) AND arm coverage is complete; print arm coverage next to exposure in the status table.; Set max_iterations = 1500 as the default for all grid arms. grid-short achieves identical per-run rung probability (P(d>=6) 0.0404 vs 0.0407; P(d>=5) 0.1682 vs 0.1639) at 3.45x the throughput, so ~75% of simulated iterations in the other arms produce no rung events. This is a ~3x free gain on the primary objective and it dwarfs every open perf hypothesis. Then delete grid-short as a separate arm (it becomes the baseline) and re-derive the reference ladder at the new cap.; Freeze all new hypotheses on steer and multiplier_authority and run ablate-all-steer-terms-arm (7/1, currently parked) next. Evidence for the freeze: 2,111,158 steer evaluations with 0 divergent picks, 0 argmax flips at multipliers from 1x to 1000x, preference honored on 0.0029% of steps. Close placed-multiplier-authority-test, steer-term-base-rates, steer-term-zero-weight-shortcircuit and steer-term-reach-and-honor-diagnostic as answered-by-utilization rather than spending 4 more iterations on them.; Adopt a standing rule: a hypothesis whose target mechanism reports zero authority (0 flips / 0 divergent picks / 0 activations) in the latest utilization dump is auto-closed at propose time, not parked. Nine of the top-40 pool entries currently target mechanisms with a provably zero effect path, and 63 of 165 hypotheses (38%) are parked, so the queue is not self-clearing.; Drop the grid-post-fault-2 arm (per-run objective -9% vs grid after a completed sweep) and demote aos to an enabling hypothesis (tape_wins = 0, config_wins = 0 — nothing is being measured). That reclaims 40% of every 300 s campaign, which can go to 2 extra chunks of the arms that discriminate (grid, grid-no-purgatory, and the 0.20/0.25 purgatory refinement) and roughly halves the CI on the merge decision.; Either switch campaign allocation from round_robin to a bandit on the actual objective (d>=6 events per explore-second) or delete the reward block. As configured, reward = termination_completed is computed, reported, and unused, and would misallocate toward throughput if ever enabled.; Run a fresh A/A replicate (>= 8 seeds, full 4-chunk campaign) and publish the union-objective chunk-to-chunk CI in the status header, replacing the raw d>=7/d>=8 rows. At P = 0.008 and 0.001 those rungs cannot support decisions, and retire-d7-d8-from-decisions already closed on that basis — but they are still the most prominent numbers on the page.; Open a validity hypothesis on reference divergence before any further ladder tuning: h4Rate is 0.000 in the reference and 0.916 at baseline, and P(depth>=4) is 13.8x the reference. Either recalibrate the reference or demonstrate that ladder gains transfer to it; otherwise the loop is optimizing a distribution nobody asked for.; Cap implement at a hard turn/time budget tied to producing an evaluation. Mean model/think is 342 s per iteration (77% of accounted implement time), and 4 of the last 15 iterations (~970 s of implement) terminated before evaluate. Require an evaluate attempt or an explicit abort record; count no-evaluate iterations in the ledger so the waste is visible.; Fix or bound the recovery_window instrumentation: 301/1408 (21.4%) windows are unclosed with max open events 292 against a 1024 cap. Any metric derived from these is biased; either close windows at run end or report the censored fraction alongside p50/p90.; Add a host-idle alarm. The loop sat idle for 33.1 h between 5306 (finished 2026-08-27T21:39Z) and 5307 (started 2026-08-29T06:48Z). At ~1200 s of campaign exposure per chunk that gap is worth roughly 100 chunks of measurement — larger than every efficiency hypothesis in the pool combined.

## 2026-08-29T11:19:54.162Z

**steer-term-zero-weight-shortcircuit** (closed): Falsified as a throughput explanation. Skipping predicate evaluation for zero-weight steer terms (active-term slice resolved at config load + arm overlay, empty-slice fast path, new steer_terms.predicates_evaluated/active_terms counters) is correct and bit-identical at nonzero weights, but recovered only 5.7% throughput, not the ~33% predicted from arm 000 (389 runs/s) vs no-steer baseline (575 runs/s). Verdict closed: 5.7% at the 5% bar with dominance=false, i.e. not worth the 6-file surface. Conclusion: predicate evaluation is NOT where the steer tax lives; ~27 of the 33 points sit in fixed per-step overhead that the empty-slice path still pays -- candidate/ready-set materialisation handed to the scorer, utilStats.steerAuthority bookkeeping, or the scorer call boundary/state touch in scheduler.rs. The zero-weight arm was a bad proxy for 'steering off': it exercised the whole steer plumbing minus the inner loop. Secondary confirmation of the note: depthAtLeast is an absolute count, so the -0.27 depth>=6 delta tracked the -0.33 throughput delta almost exactly -- depth was flat per run and the grader could not say so. Any future steer campaign is unreadable on depth until that is normalised. Cost lesson: single-number attribution from one arm's wall clock ('per-step, not slice-switch') was too coarse to locate the cost inside a multi-stage hot path; bisect the path before optimising a stage of it.
