# stall-release: implementation report

Hypothesis: `stall-release-of-client-blocked-plan-events` (research/lite/plans/iteration-77-admitted.json).
Baseline: spur submodule `3d885103e7983fe583cb11b6ea133451bc0dc7bc` (merged stall cap), lite branch config and orchestrator.

## Mechanism as built

- Cell: `spur/spur-core/src/simulator/stall_release.rs` (new). `cell(run_id)` is `Exempt` unless the stall cap treats the run; among treated runs a salt of its own (`STALL_RELEASE_SALT`, period 2) splits `Release` from `Cut`. Pure function of the run id; probes are never treated because the stall cap never treats them.
- Tag: `run_variant::STALL_RELEASE = 1 << 12`, joined in `stall_cap_bits` (used by both `of` and `from_run_id`) as `STALL_CAP | STALL_RELEASE` on release-cell runs. No prior `1 << 12` tag existed in `run_variant.rs`. `VARIANT_BITS` row 4096 renamed `recoverWindowFreshOnly` -> `stallRelease` in `research/orchestrator/src/decide.ts` (only orchestrator edit).
- Release (`path.rs`, the stall exit of `exec_plan`): on a release-cell run whose first over-cap gap finds client operations in `in_progress`, `settle_in_progress` marks each operation's plan node completed (`PlanEngine::mark_event_completed`, in op-id order) and records its id in `settled`; the operation stays in `in_progress`. Dependents made ready are counted by kind from the returned list (`mark_event_completed` now returns the newly ready children; `PlanEngine::event` exposes the node). `RunClock::release()` closes the open gap as a release mark (counted under `stall_cap.marks.releases`). The run continues; it ends by plan completion, at its next stall (StallCapReached, one stall-cap stop, termination.stall_cap_reached), deadlock, or budget, exactly as the parent would end it.
- Late response: the per-step response scan skips `mark_event_completed` for an id in `settled` and counts `late_responses` instead; the response row is pushed to the history unchanged (`exec.rs` and `history.rs` untouched; the invocation stays pending until a real response).
- Release-cell run whose first stall finds no in-progress operation: nothing to settle, the run stops as the cut cell does; counted under `stalls_without_ops` (extra counter, see deviations).
- Counters (`util_stats.rs`, block `stall_release`, reset with `set_enabled(true)`, exported through the snapshot and the difference/accumulate path): `releases` (firing counter), `ops_settled`, `dependents_released.{client,fault,other}`, `late_responses`, `plan_completed_after_release`, `second_stall_stops`, `steps_after_release_sum`, `stalls_without_ops`, `release_cell.{runs,invocations,plan_complete}`, `cut_cell.{runs,invocations,plan_complete}`. `invocations` is the run's ClientInterface invocation count (`op_id_counter`).

## Files changed

Submodule `spur` (see `spur.patch`, untracked files under `untracked/`):
- `spur-core/src/simulator.rs` - module declaration
- `spur-core/src/simulator/stall_release.rs` - new: cell, salt, unit test
- `spur-core/src/simulator/path.rs` - settlement at the stall exit, late-response guard, per-run end accounting
- `spur-core/src/simulator/path/plan.rs` - `mark_event_completed` returns released children; `event(idx)`
- `spur-core/src/simulator/stall_cap.rs` - `RunClock::release()` (shared `close_gap`)
- `spur-core/src/simulator/run_variant.rs` - `STALL_RELEASE`, joined in `stall_cap_bits`; tests for share and implication
- `spur-core/src/simulator/util_stats.rs` - counters, record functions, `StallReleaseStats`, snapshot wiring
- `spur-core/tests/stall_cap_exit.rs` - existing test now takes its treated id from the cut cell and adds a release-cell run (plan completion at the first stall when nothing is planned behind the write); new tests: second-stall stop with the write-chain successor issued; late response recorded once with plan completion; tag bits read from the runs table
- `spur-core/tests/fixtures/stall_release.spur` - new fixture for the late-response case
- `spur-core/tests/util_stats_export_completeness.rs` - `stall_release` block leaves

Superproject (`super.patch`): `research/orchestrator/src/decide.ts` rename only, plus the submodule pointer line. `scheduler_configs/loop/general_vr.json` unchanged (copied here; identical to research/lite).

Config field: none.

## Build and tests

- `cargo build --release --manifest-path spur/Cargo.toml --bin spur`: ok (`build.log`; the three dead-code warnings are pre-existing).
- `RUST_MIN_STACK=33554432 cargo test --manifest-path spur/Cargo.toml -p spur-core` (`test.log`): every binary ok; totals 477 passed, 0 failed, 0 ignored (lib 433; stall_cap_exit 3; util_stats_export_completeness 2; the rest unchanged).

## Smoke (numbers discarded; mechanism-firing check only)

60 s campaign on `general_vr.json` with `--set campaign.wall_budget_sec=60` (`smoke.log`, `smoke-utilization-blocks.json`):
- `stall_release.releases` 20582, `ops_settled` 84154, `dependents_released` client 19485 / fault 2157 / other 0, `late_responses` 62, `plan_completed_after_release` 6654, `second_stall_stops` 9436, `steps_after_release_sum` 8082840, `stalls_without_ops` 12; release cell runs 45333 / invocations 338932 / plan_complete 17186; cut cell runs 45072 / 313049 / 10296.
- `stall_cap`: stops 29986, treated_runs 90405 (= release + cut cell runs); `termination.all.stall_cap_reached` 29986 (= stops).
- Tag check (`smoke-tag-check.txt`, read off the runs table): 128704 runs, 90405 carry bit 1024, 45333 carry bit 4096, zero carry 4096 without 1024, zero probes (by id or by probe bits) carry either bit.
- Per-cell reads the frozen prediction defines, computable from the block: invocations per run release 7.48 vs cut 6.95 (difference 0.53); plan_complete share release 0.379 vs cut 0.228 (ratio 1.66); late_responses / ops_settled 0.07%. These are one 60 s process and are reported only to show the reads are computable; measurement is the grader's.

## Predicted effect

Release-cell runs no longer end at their first stall with their planned successors unissued: the write-chain and density successors (client requests and crash/recover, partition/heal pairs) issue into the post-fault state, and a share of released runs reaches plan completion. Expected: more ClientInterface invocations per run and a higher plan-completion share on the release cell than on the cut cell, longer release-cell runs, a fault-dependent release count on the order the hypothesis floors, late responses a small fraction of settled operations, and whole-candidate depth>=8 events per explore-second in the frozen band against the merged-tree cache. Cut-cell and untreated runs, and all probes, are bit-for-bit the parent's behavior (asserted by the existing exact-step test).

## Deviations and decisions

- Extra counter `stalls_without_ops`: a release-cell run whose first stall has nothing in progress cannot be released; it stops as the parent does and is counted here so `releases`, `second_stall_stops` and the cell's `runs` reconcile. The hypothesis did not list it; nothing else was added.
- Plan completion counts even when settled operations are still pending in the history (as the hypothesis states: "ends by plan completion"); in particular a run with nothing planned behind its stuck operations completes on the step after its release with zero `steps_after_release`.
- `late_responses` can only fire while the plan is still incomplete after settlement; a response arriving after plan completion is not observed because the run has ended (the history row is not affected either way).
- `mark_event_completed`'s return value is ignored at every existing call site; its behavior is unchanged.
- No other discrepancy between the frozen hypothesis and the source was found: the stall exit, `mark_event_completed`, and `Marks.release` are where the record says.
