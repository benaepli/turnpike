# Provenance candidate export

Implemented the admitted `selector-composes-directions-by-search-provenance` specification from unchanged accepted Spur `b86baad3f94ce14dbdf20688b61fd92317a75cc2` in the isolated `tmp/loop/wt-lite-provenance` worktree. Main source and protected files are untouched. No commits, network, treatment bit, configuration field, campaign change, or grader run.

## Deliverables

- `cand-spur`: release binary; SHA256 `020acbb8a23c769adaeba56f1bdec8b6ccde58c59cc8867f025d8957d50998cd`.
- `spur.patch`: tracked-file patch.
- `untracked/spur-core/src/simulator/util_stats/selector_context.rs`: new telemetry module.
- `spur-full.patch`: tracked and untracked changes together; reverse apply check against the implementation tree passed.
- `super.patch`: empty; `general_vr.json` is byte-identical to the accepted template, SHA256 `f9daa01b6ee57083ba63fadc82634ef86a5945c28dc08c37e238e269f102fe6f`.
- `hashes.json`: binary/config/patch/hypothesis hashes.
- `tests-final.log`, `tests-export.log`, `build.log`: successful validation.
- Earlier test logs document the missing export member during implementation and the fixed-layout-gauge test correction. These were validation failures, not experiment results.

## Implementation

`arm_selector.rs` adds four fixed local evidence blocks to each existing learner/cell. Shared warmup, exploration share, coin decisions and update equations remain unchanged. The actual local context specializes only a learner draw after24 local credited observations. Shared/context posterior means and categorical probabilities are computed under the same existing cell guard. The existing selector stream still makes one categorical pick on each positive-weight axis; no extra shadow, workload or execution RNG draw is used.

The sampled Choice owns ten pre-execution reward means and fixed context/scope/learner identity. The sample uses exactly the frozen `CTXLOSS1` salt and1/16 phase. Observation scores those stored means against the matching run reward before its permitted credit, even if other runs have credited the cell meanwhile. Local credit occurs inside the shared entry guard and retains coin-to-all, own-to-own and probe exclusion. Contexts discount only carried directions.

`campaign.rs` uses actual GridRun branches; an unfilled prefix slot is Fresh. `explorer.rs` forces Fresh in run_recorded and TapeMutation in the actual tape operator branch, covering campaign, standalone AOS and curriculum reuse. Ordinary callers default Fresh. Attribution builders preserve context; an explicit fixed Grid/AOS/Other scope scalar supports diagnostics without interpreting a user-visible arm name. Neither new field enters history rows. Existing ghost-signal bit exclusion remains unchanged.

A caller-side fixed ContextRun guard records issued/completed/failed runs and sampled-but-unscored failures on early return. It does not enter execution state or change event accounting. Successful termination reasons continue to use the ordinary result and reward path.

The bounded telemetry module is reached through util_stats.rs and its normal snapshot/reset/render path. It exports `selector_context.specialized_learner_draws`, all supply/loss/TV/argmax counts and sums, per-scope/context/learner breakdowns, context creation counts and raw observation maxima, including pooled-cell maxima. Permitted credited runs and learner credits are separate; a coin run produces one credited run and three learner credits. Context blocks created means first actual credit to a block; all four slots are reserved in the fixed cell layout.

Counter route: `selector_context.scopes.{grid,aos,other}.contexts.{fresh,plan_reuse,prefix_replay,tape_mutation}` plus scope learner totals and context learner tables, with learner keys a/b/c/none. Issued/draw rows use assigned learner identity; coin/probe/actual learner counters distinguish realized behavior. Credit rows use the learner actually credited. Direct scope loss sums avoid relying on campaign delta/add, which drops floating fields. No new locks: floating sums use existing atomic add_f64. Snapshot maps are bounded serialization objects only, not maps inside cells or retained per-run data.

## Validation

`RUST_MIN_STACK=33554432 cargo test --manifest-path spur/Cargo.toml -p spur-core`, run from the worktree superproject root:462 tests passed across25 suite result rows, zero failures. Unit suite:421 passed. Coverage includes shared/local update parity, independent context visits, own/coin/probe rules, shared warmup and coin precedence, exact cold-context sampler preservation, selected-action posterior snapshots, later-credit snapshot stability, pre-credit scoring, categorical probabilities/ties, context reset, actual empty-slot/prefix/plan-only branches, AOS attribution override, failed sampled-run accounting and rendered export/delta completeness.

`cargo build --release --manifest-path spur/Cargo.toml --bin spur`: passed. Existing unrelated warnings remain. `git diff --check`: passed.

One2-second campaign smoke on the initial runtime build confirmed firing and exported diagnostics: specialized draws present in both grid and AOS;38 sampled and38 scored, zero simulation failures. No throughput, applicability, calibration or discovery conclusion was drawn. The initial `-e standard` invocation rejected the campaign configuration before any runs; the successful smoke used `-e campaign`. No additional smoke or supply experiment was run.

Actual release-exported layouts: context block200 bytes, CellLearner1016 bytes, Choice96 bytes, RunAttribution32 bytes. Fixed local numerical payload is800 bytes per learner/cell. No corpus growth or stored diagnostic dataset. Layout sizes are gauges, so the export test checks their rendered values but excludes them from the accumulated-counter test; normal session snapshots retain them.

## Prediction and deviations

No quantitative prediction or implementation-policy deviation. The complete cross-binary system comparison remains the admitted exception: no per-run treatment switch. The frozen grid depth>=8 per-run band is[1.12,1.30]; normal supply, prequential calibration, policy movement, throughput, AOS and panel guards remain for the root's grader decision. The small smoke is not evidence for any of those gates.

The permitted scalar diagnostic scope, caller lifetime accounting and separate telemetry source module make ownership/export obligations explicit; they do not change the scientific mechanism or protected scope. All source changes are confined to arm_selector.rs, campaign.rs, explorer.rs, util_stats.rs, the new util_stats/selector_context.rs module and util_stats_export_completeness.rs.

## Completed independent-review corrections

The actual empty-corpus GridArm::assign branch now passes its assigned learner to unfilled-slot telemetry. The exact fallback test checks the matching A/B/C bucket and zero in none; aggregate Grid/Fresh semantics are unchanged.

An asymmetric fixed-state reference test independently computes shared/local A,B,m,v and normalized coin-weighted q, uses four fixed schedule seeds with exactly five reference categorical variates, and checks ArmSets, saved reward means, exported TV and changed-argmax. It uses the unchanged normal CDF primitive but does not use the production posterior/variance/probability/pick helpers for its reference.

The final source has462 passing tests across25 suite rows and a successful release rebuild. Tests-reviewed.log and build-reviewed.log are also copied to the canonical final log paths. Runtime policy math did not change in this correction; there was no additional smoke or performance run. The retained smoke precedes the learner-attribution diagnostic correction and is only evidence of initial runtime firing.
