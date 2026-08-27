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
