# recover-deps (merge form): implementation report

Hypothesis `recover-events-exempt-from-client-dependencies` (iteration 75), merge form: the exempt
cell only. Built on the as-built worktree; submodule base spur b86baad3f94ce14dbdf20688b61fd92317a75cc2.
No commits made.

## Files changed

Submodule `spur` (`spur.patch`, 6 files, plus `untracked/` for the new file):

- `spur-core/src/simulator/recover_deps.rs` (new, untracked): `RecoverDeps { Stock, Exempt }`,
  `DEPS_SALT` (unchanged, 0x5245434F56444550), `of_workload_seed(seed)` =
  `run_phase::salted_phase(seed as i64, DEPS_SALT, 2)`: phase 1 exempt, phase 0 stock. Tests: the
  cell is a function of the seed alone; each cell takes about half of derived workload seeds; the
  seed's cell agrees with the id's own phase under the same salt only at chance (1/2).
- `spur-core/src/simulator.rs`: registers the module.
- `spur-core/src/simulator/path/generator.rs`: `GeneratorConfig.recover_deps`; in the probabilistic
  pass an edge whose target is a `RecoverNode` is added as in stock (so the cycle guard sees the stock
  graph) and removed after the pass under the exempt cell; `record_plan_deps_edges(dropped)`. Tests:
  stock plans byte-identical to fingerprints captured from the unmodified generator; exempt equals
  stock minus exactly the non-mandatory edges into recovers (64 seeds, density 0.3, two crashes, write
  chain, post-fault edges); exempt inert at density 0.0. The two existing generator tests keep their
  assertions.
- `spur-core/src/simulator/run_variant.rs`: `RECOVER_DEPS_EXEMPT = 1 << 13`, `recover_deps_bits(cell)`,
  docs that the plan-cell bit follows the workload seed and `from_run_id` cannot name it; test
  `the_plan_cell_bit_is_disjoint_from_every_id_bit` (also checks the exempt share is about half).
- `spur-core/src/simulator/explorer.rs`: `run_single_simulation` draws the cell from `workload_seed`
  before `generate_plan`, sets `gen_config.recover_deps`, registers the run's cell and density;
  `run_row` ORs `recover_deps_bits(RecoverDeps::of_workload_seed(workload_seed))` into `variant`.
- `spur-core/src/simulator/util_stats.rs`: `plan_deps` block, record functions, per-run crash and
  recover counts, fold at `record_run_termination`, snapshot wiring, reset in `set_enabled(true)`;
  test `plan_deps_folds_each_run_into_its_cell_by_density_and_resets`.
- `spur-core/tests/util_stats_export_completeness.rs`: `plan_deps` block leaves.

Removed relative to the as-built form, with no trace left: the `Forced` value, the forced pass, the
`recover_edges_forced` counter and the `forced` cell, `RECOVER_DEPS_FORCED`, the forced generator test,
the forced half of the tag test, and the `is_client` test helper the forced test used.

Superproject (`super.patch`): `research/orchestrator/src/decide.ts` renames row 8192 to
`recoverDepsExempt`; row 2048 keeps `newsBeforeReply`. Exactly one changed row plus the submodule
pointer line. `scheduler_configs/loop/general_vr.json` unchanged (copied here).

Config field: none.

## Integration fixtures

The as-built form changed `ghost_absorber_retarget.rs` and `pair_order_dispatch.rs` to draw ids off
the forced cell, because a forced plan ordered a client request before a restart and could not
complete. With the forced cell gone there is no stalling cell (exempt is inert on those density-0.0
fixtures), so both files were reverted to their committed content with `git checkout`. Both test
binaries pass unchanged (`ghost_absorber_retarget` 2 passed, `pair_order_dispatch` 3 passed).

## Counter block `plan_deps`

```
plan_deps.recover_edges_dropped         session total (firing counter)
plan_deps.{stock,exempt}.{density_zero,density_positive}.{
    runs, crashes, unrecovered_crashes, zero_recovery_runs, plan_complete, steps_used_sum }
```

Definitions as in the as-built form: `unrecovered_crashes` is the run's crash events minus recover
events (the same events `crash_recovery` counts), `zero_recovery_runs` uses the `recovered_nodes == 0`
predicate of `termination.by_recovered_nodes[0]`. On the smoke run the identities held exactly:
unrecovered by cell 6,627 = 104,022 - 97,395; zero-recovery by cell 3,108 =
`termination.by_recovered_nodes[0].runs`; runs by cell 53,440 = `termination.all.runs`.

## Tests

`RUST_MIN_STACK=33554432 cargo test --manifest-path spur/Cargo.toml -p spur-core --no-fail-fast`
(`test.log`): 25 test binaries, 462 passed, 0 failed, 0 ignored.

## Smoke run

`spur explore -e campaign --config scheduler_configs/loop/general_vr.json --set campaign.wall_budget_sec=30 -y
--output-dir tmp/loop/recover-deps-merge/out bin/spur/VR.spur` with the built binary (`smoke.log`,
`smoke-utilization.json`, `plan_deps.json`). `plan_deps.recover_edges_dropped` = 34,865 in 30 s. A
throwaway census over the `runs` table (removed before export): 53,440 runs, 26,595 carry bit 8192
(49.8%), 0 carry bit 2048, 26,845 stock; 0 runs whose tag disagreed with the cell of their
`workload_seed`; 1,613 probe runs carry the bit (probes are not exempt: the cell is a plan property).
Numbers are discarded per instructions.

## Predicted effect

As frozen for the exempt cell: per-run depth>=8 ratio of the exempt half to the stock half, probe-free
and matched on co-bits, in [1.02, 1.12] pooled over both densities; on density-0.3 runs the exempt
cell's unrecovered-crash share <= 0.75x stock and zero-recovery share <= 0.70x stock; on density-0.0
runs exempt equals stock within noise. Firing floor `plan_deps.recover_edges_dropped` >= 60,000 per
chunk (the exempt half is twice the as-built quarter, so the counter fires at about twice the
as-built rate).

## Decisions to note

1. Exempt remains "add during the pass, remove after", so the exempt plan is exactly the stock plan
   minus the probabilistic edges into recovers and the cycle guard is unchanged.
2. The enum lives in `simulator/recover_deps.rs` because `path` is a private module.
3. Qualitative smoke observation, not a measurement: exempt density-positive runs recorded 0
   unrecovered crashes against 6,627 of 22,709 in stock; the grader's chunk decides.
