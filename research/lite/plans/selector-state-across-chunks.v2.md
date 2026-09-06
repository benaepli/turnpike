# Plan: selector learner state carried across a grader session's chunks (revision 2)

Tree at planning time: superproject `7579c99` (plan `72b6445`, review on top), spur `b86baad` (iteration-61 pooled cells). Independent cache `research/lite/baselines/34b5ef40e3bf-30-f9daa01b-300-g870d4c11-s3d907a50.json`: seeds 1000 and 1001 only (606,180 and 603,480 runs; 2,018 and 2,010 runs/s; 55 cells = 54 pooled + 1 aos). Every "CORRECTED"/"MISSED" item of the review is adopted; one review item is extended (utilization is dumped once, so the pilot's quarter bins come from run rows, below).

## Hypothesis JSON

```json
{"id": "selector-state-across-chunks", "kind": "harness+explorer", "origin": "user",
 "title": "Carry the per-cell selector's three learners' cells across the chunks of a grader session",
 "mechanism": "chunk k of a session starts its explorer with the CELLS the chunk k-1 explorer wrote at session end; run-cap, crash-placement, timer-context learners and the replay corpus stay per chunk",
 "prediction": {"primary": "depth>=8 per run; first session: a four-chunk trajectory of the current binary against its own independent chunks on seeds 1000-1003",
   "band": [1.03, 1.08], "positionBand": [1.03, 1.08], "refute": "pooled < 1.02, or any of positions 1-3 not above 1.03 on both seed sets, or position 0 outside the layout band",
   "observables": "warmup_coin_runs 1,360 on position 0 (55 cells x 24) and ~0 on positions 1-3; grid-arm coin share 0.11 -> 0.05-0.08 on positions 1-3; mean top margin 0.92 -> 0.94+; no change past depth 10; aos unchanged; throughput unchanged"},
 "expectedGain": 5, "expectedCost": 7, "cannotBeTurnedOffPerRun": true}
```

## What the change buys, priced honestly

- Warm-up is 1,360 coin runs per fresh chunk (55 cells x `WARMUP_OBSERVATIONS` 24, arm_selector.rs:79), 0.24% of 568,100 draws; the warm-start term that exists is the coin-share ramp (0.378/0.239/0.191/0.183 by grid arm in the iteration-61 60 s smoke, observations.md:5683-5688) against 0.11 at chunk scale, plus the runner-up directions' evidence (~450 observations per chunk at share 0.11).
- The learners' rewards on control runs are 0.8-2.3% per run (0.0136, 0.023, 0.0077), learner runs 5-18%. The 0.001-0.003 rate is the direction review's figure for events past depth 10 (observations.md:6287-6290), which the selector never learns; `DISCOUNT` 0.998 (arm_selector.rs:75) caps a direction at 500 own observations, so carried state does nothing for the base-rate wall unless `DISCOUNT` changes with it.
- Expected gain: a depth-8 gain from a lower coin share on positions after the first (a coin run turned into a pick is worth ~0.015 depth>=8 events; iteration 61 paid +5.2% for 0.147 -> 0.110). Priced at +3 to +8% per later position, +2 to +6% pooled over four, none past depth 10. Slices stay 20 s at a 1,200 s budget (`unit_sec = min(min_slice_sec, wall/2k)`, campaign.rs:725-728; template `min_slice_sec` 20), so the pilot's quarters are the same round-robin mix as a chunk.

## Stage A: the pilot (gating; no explorer or grader code)

One 1,200 s campaign explore of the current binary, seed 1000, graded by the same calls the evaluator makes, then binned by quarter. `HARD_LIMITS.maxExploreBudgetSec` is 600 (policy.ts:107) and `runOneEvaluation` always explores (evaluate.ts:342-407), so this runs spur and the analyzers directly. `D=tmp/loop/lite/pilot-1200` (precedent: `tmp/loop/lite/acceptdist{,.campaign.json,.session.json}`); siblings land beside `out` as the CLI writes them (spur-cli/src/main.rs:650-655).

```
jq '.session_seed=1000' scheduler_configs/loop/general_vr.json > $D.config.json     # what materializeConfig does, runners.ts:178
RAYON_NUM_THREADS=30 RUST_LOG=info spur/target/release/spur explore -e campaign --config $D.config.json -y \
  --output-dir $D/out --set campaign.wall_budget_sec=1200 bin/spur/VR.spur > $D.log 2>&1
porcupine/batch -input $D/out -model kv -timeout 3000 > $D.porcupine.json                          # runners.ts:382-386
traceanalyzer/main -input $D/out -grade -dag-config research/oracle/relax_minimal_general_v2.json \
  -grade-max-runs 0 -grade-budget-ms 7200000 -format json -grade-run-depths > $D.grade.json        # runners.ts:352-360; policy.json:29-31; 4x the chunk's 1,800 s
traceanalyzer/main -input $D/out -runs -runs-columns run_id,arm,steps_used,end_reason,session_offset_ms,variant > $D.runs.json   # main.go:32-33
```

Readers. There is no DuckDB CLI or python `duckdb` module on the host; the output is a parquet directory (`history.rs:561, :722`) read only through `traceanalyzer -input <dir>` (main.go:20). `utilization.json` is written once, at session end (main.rs:650-655), and campaign.json's per-slice `history` carries only runs/wall/reward (campaign.rs:899-908, :923), so quarter bins must come from the run rows: `session_offset_ms` (explorer.rs:945-965, row :996), `variant` (history.rs:116), joined to `grade_dags[0].run_depths` `[run_id, depth]` pairs (main.go:29; evaluate.ts:412). `research/lite/tools/ghost_census.py:768-777` already has both loaders; add `research/lite/tools/quarter_bins.py` over them (a tool, not a harness change). Quarter `q = floor(session_offset_ms / 300000)`. Per quarter and per arm (arm mode from `$D/out.campaign.json` `arms[].mode`, aos apart):
- depth>=8 and depth>=10 per graded run, on all rows and on fresh rows only (`variant & (1<<20) == 0`, `REPLAY_SLOT`, run_variant.rs:71; `REPLAY_PREFIX` 1<<21 at :74). Fresh-only over quarters is the selector+cap+placement read; all-rows minus fresh-only is corpus maturity. Session-total `replay.parents_admitted` and `replay.children` (util_stats.rs:4927-4936) are the end check.
- coin share = rows with no learner bit (`ARM_SELECTOR_BITS` = bits 5|6|7, run_variant.rs:82-89) among rows that are not probes (`RUN_CAP_PROBE` 1<<1, `TIMER_STEER_OFF` 1<<2, the `PROBES` mask pool_cells.py:26). Exact draw-weighted share exists only session-total (`arm_selector_axis.explore.share_micro / draws`).
- run cap: share of `end_reason == learned_cap_reached` (explorer.rs:980-983) and mean `steps_used`; replay-slot share of rows.
- Sanity: quarter 1 must reproduce the cache's 9,300-9,600 depth>=8 events and ~2,010 runs/s; `arm_selector_axis.explore.warmup_coin_runs` 1,360.

Decision rule (quarter 4 over quarter 1, fresh rows, grid arms pooled with aos excluded as `RATE_EXCLUDED_ARM_MODES` does, decide.ts:29): go to Stage B if >= 1.03 with coin share lower by >= 0.02 absolute on at least two of the three long grid arms and depth>=10 not below 0.95; stop if < 1.02, or if the all-rows ratio is >= 1.03 but fresh-only is < 1.02 (the gain is the corpus, which the harness change does not carry). Between 1.02 and 1.03: run the DISCOUNT explore below before deciding. Write the read to `observations.md`.

DISCOUNT pairing: `pub const DISCOUNT: f64 = 0.998` (arm_selector.rs:75) has no config key (no `discount` in explorer.rs, campaign.rs, plan_config.rs), so 0.9995 needs a second binary from a worktree (build under the 600 s `maxBuildSeconds`). Recommendation: not paired in Stage A. It is a distinct explorer hypothesis aimed at the base-rate wall, with its own independent-chunk grade; running it in the same pilot confounds two mechanisms in one quarter read. Run it as Stage A' (about 45 minutes: build, 1,200 s explore, grade, same readers) only if the pilot's coin share and top margin plateau by quarter 2 (the window's signature) and the user wants the wall addressed. Stage A cost: 20 min explore, ~25 min porcupine and grading on ~2.4M runs.

## Stage B: explorer save/load plus a hand-run trajectory

1. `spur/spur-core/src/simulator/arm_selector.rs`: `SelectorState { fingerprint, written_by, learners: [Vec<CellRecord>; 3] }`, `CellRecord { arm, config, alpha: [f64; 12], beta: [f64; 12], reward_mass, mass, observations }` (the five fields of `CellLearner`, :211-221). `Fingerprint { axes 5, directions 12, axis_start [0,3,5,7,9,12], discount 0.998, warmup 24, rewards [OvertakenGhost, AbsorberCycle, CycleBeforeRequest], format 1 }`. `WriterInfo { session_seed, spec_sha256, wall_budget_sec, runs_observed }`; drop `spur_commit`: nothing in spur sets `SPUR_GIT_SHA` (grep over spur/ finds no build.rs or env use), so provenance is the grader's chunk record. `export_state`, `import_state(&SelectorState, expect_spec_sha) -> Result<LoadReport, String>`, `save_to`, `load_from`. Import replaces `CELLS` (:378-382) after `reset()`, checks every number is finite, refuses any fingerprint or spec mismatch, and calls `util_stats::record_arm_selector_cell_created(learner.reward(), pooled)` per imported cell (:436-441 -> util_stats.rs:2367-2373), so `arm_selector_axis.*.cells` and `pooled.cells_by_learner` (:4808-4816) read 55/54 on positions > 0 and the iteration-61 chunk gate and the `observations_by_learner / cells_by_learner` ratio hold. Tests: save -> reset -> load -> `choose` equal per learner at fixed `schedule_seed` with `schedule.draws == 0` (extends :724-725); fingerprint with discount 0.999 refused; a loaded warm cell serves no warm-up coin run; a NaN in the file is refused. Size: 55 x 3 x 27 numbers, under 150 KB.
2. `util_stats.rs`: `ArmSelectorStateStats` beside `ArmSelectorPooledStats` (:4799): `loaded`, `written`, `refused`, `loaded_cells_by_learner`, `loaded_warm_cells_by_learner`, `loaded_observations_by_learner`, `loaded_mass_micro_by_learner`, `written_cells_by_learner`; all reach `utilStats.counters` through `numericLeaves` (evaluate.ts:235-245).
3. `explorer.rs`: `selector_state_in: Option<PathBuf>`, `selector_state_out: Option<PathBuf>` on `ExplorerConfig` (:183), `#[serde(default)]` only, no `skip_serializing_if` (`check_override_paths` re-serializes the config and needs the null key present, config_override.rs:162-196); both in `EXPLORER_CONFIG_KEYS` (:359); load after `arm_selector::reset()` (:1221), save at the end of `run_explorer_impl`. A bare path in `--set` parses as a JSON string (config_override.rs:150-151).
4. `campaign.rs`: both keys in `SESSION_LEVEL_KEYS` (:48); load after the reset at :970 (refused or missing file is a hard error); save right after `writer.shutdown()` (:1120), which also runs on the cancelled path (:1045-1064).

Hand-run trajectory `S=tmp/loop/lite/traj-a`, seeds 1000-1003 in order, 300 s each, the same porcupine/grade/runs calls as Stage A (`-grade-budget-ms 1800000`):
```
spur explore -e campaign --config $S/c$seed.config.json -y --output-dir $S/out-$seed --set campaign.wall_budget_sec=300 \
  [--set selector_state_in=$S/state-$((seed-1)).json]  --set selector_state_out=$S/state-$seed.json bin/spur/VR.spur
```
Baseline side: the cache lacks 1002 and 1003; `cmdBaseline` (grader.ts:1067-1119) fills seeds from 1000 upward skipping cached ones, so `cd research/orchestrator && npx tsx ../lite/grader.ts baseline --chunks 4 --base-bin ../../spur/target/release/spur --base-template ../../scheduler_configs/loop/general_vr.json` adds exactly those two (identity unchanged: `identityFor` hashes the template, :172-181). Compare by hand: per position, depth>=8 and depth>=10 per run against the cache chunk of the same seed; pooled ratio with the 1.3-charged binomial; coin share, `warmup_coin_runs`, `arm_selector_state.*`, `chosen_by_direction` per position; aos apart; runs/s.

Go/no-go for Stage C: position 0 within the layout band (same binary: the counting null with 1.3 charged); positions 1-3 each above 1.03; the three long grid arms each above one; aos not read as signal; runs/s within 3%. Stop if pooled < 1.02 or a position > 0 shows `loaded == 0` (a harness fault to fix first, not a null).

## Stage C: grader adoption (`research/lite/grader.ts`, operator-owned)

- Identity: `BaselineIdentity.selectorState: "independent" | "trajectory:<len>"` in `identityKey` (:195) and `cacheFileFor` (:199, suffix `-traj4`); `tryAdoptRecord` (:281-328) returns null for a trajectory identity; `cmdFreezeEpoch` (:1125-1162) records it.
- Modes, named explicitly in `SessionState.trajectory.mode`: `"trajectory-vs-independent"` (the first session: candidate trajectory against the independent cache; no baseline state files exist and none are required) and `"trajectory-vs-trajectory"` (position p > 0 refused when the trajectory cache lacks the accepted position p-1 state). `cmdStart --trajectory-len <n> [--trajectory-baseline independent|trajectory]`, default off.
- Positions: `p = usedSeeds.length % len` (`usedSeeds` grows only on accepted chunks, :942). State in = the `selectorStateSha`/path stored in the accepted chunk record of position p-1 (failed and excluded chunks also write a state file because the campaign saves after `writer.shutdown()`; keying on the record, not the seed, ignores them). State out = `research/lite/state/<name>/selector-<seed>.json` (`chunkDirFor`, :357-358); baseline files beside the cache as `<cacheBasename>.selector-<seed>.json`.
- Retries: on both drop paths (:854 baseline dropped, :868 after the candidate call) a trajectory session holds `nextSeed` and re-runs the same seed from the same input file, at most two retries per position, then errors.
- Transport: `OneEvalOpts.sets?: string[]` appended to `sets` in `runOneEvaluation` (evaluate.ts:379-381) and the same two assignments folded into `extra` (:385-388) so the materialized `<outputDir>.config.json` that `preserveViolations` copies (:311-313) names the state. No env variable; if any env is ever used, set and delete it in `try/finally` around each `runOneEvaluation`.
- `buildStatus`/`cmdFinish`: a `trajectory` block (mode, len, per-position candidate/baseline depth>=8 and depth>=10 per run and ratios, coin share, `warmup_coin_runs`, `arm_selector_state.loaded`, aos apart) and the standing blocker text: "trajectory session: chunks are one sample path; the 1.3 overdispersion was calibrated on independent chunks and positions 1-3 share one leader set, so the interval is optimistic. Merge only if position 0 is within the layout band; positions 1-3 are each above 1.03 on both seed sets 1000-1003 and 1004-1007; the three long grid arms are each above one; aos is read separately as the negative control; throughput is unchanged." `adviceVerdict` is not a merge signal on a trajectory session.
- `cmdSelftest`: trajectory caches hold contiguous seeds from 1000 with a state sha per chunk; a session with `trajectory` on an independent cache must carry mode `trajectory-vs-independent`; trajectory sessions are excluded from the dispersion measurement (:1273-1307); trajectory and independent identity keys differ.
- `cmdBaseline --trajectory-len`; `cmdPanel`/`cmdRegression` unchanged; `lite.json` `budgets.trajectoryLen` (absent = off); docs `docs/agent/lite-grader-status.md`, `research/lite/README.md`.
- Calibration shrinkage: the per-direction tables are coin-only (arm_selector.rs:461-471). A share of 0.05 cuts control rows from ~63k to ~28k per chunk on positions > 0, so every later proposal's control-versus-treated read on those tables has 2.2x the counting variance and per-direction rows fall to "directional only". Before adopting trajectory as the standard, price it on session a's tables: if a direction row's 1.3-charged interval on the pooled four chunks is wider than today's on two chunks, adoption costs more than a chunk of resolution and the answer is to keep independent sessions for table-read proposals.

Go/no-go for adoption: sessions `selector-state-traj-a` (seeds 1000-1003, mode trajectory-vs-independent, same binary both sides) and `-b` (seeds 1004-1007, baseline measured fresh as independent chunks) both meet the blocker text; sign agreement on positions 1-3; the shrinkage read is affordable. Then: `trajectoryLen` in `lite.json`, a trajectory cache measured, epoch identity re-frozen with the trajectory term.

## Carried state

Carried: the three learners' `CELLS` only (alpha[12], beta[12], reward_mass, mass, observations per cell; the aos cell `(arm_index, -1)` with the rest). Not carried: `run_cap`, `fault_timing`, `timer_context`, the replay corpus (campaign.rs:387, :413), the `AX_POOLED` counters and the `cells` gauges (per-chunk telemetry, re-set on import). Reasons: the others reach their asymptote inside a chunk; probes are the untreated population and the invariance controls; iteration 53 (observations.md:3699-3703) showed cap and span are campaign-wide couplers that re-tune every arm, and carrying them would let chunk k-1's sample set chunk k's run lengths, which throughput and the `steps per run` balance guard read.

## Firing counters

`arm_selector_state.loaded == 1`, `loaded_warm_cells_by_learner` about [55, 55, 55] and `pooled.cells_by_learner` [54, 54, 54] on positions 1-3 (0 and absent on position 0); `arm_selector_axis.explore.warmup_coin_runs` near 0 on positions 1-3 against 1,360 on position 0; `written == 1` on every position. `loaded == 0` on a position above 0 is a harness fault, not a null result.

## Risks

- Lock-in of a wrong leader across positions: a runner-up gathers ~70 observations per chunk at share 0.04, so a wrong leader lasts positions. Read `chosen_by_direction` (util_stats.rs:4696) per position against the coin table's per-direction rates; a leader whose coin-row rate is below the runner-up's for two positions is the lock-in signature and stops adoption.
- Cold run cap meeting a warm selector: the cap is a per-budget quantile of unsteered probe lengths (run_cap.rs:2-8, :17-18) with a 200-completed-probe floor (:29), so the mismatch lasts the floor; small and bounded; the `steps per run` balance guard reads it; the pilot's per-quarter `learned_cap_reached` share is the check.
- aos: its cell is at the floor already (~35k observations per learner per chunk), so no change is expected; it is the negative control, and its 0.88 from iteration 61 is not re-read as signal.
- Grid-arm cold start: removed on positions > 0 only; position 0 keeps it, so the trajectory's pooled ratio is diluted by one quarter by construction.
- Calibration-table shrinkage (above). Determinism: run ids restart at 0 per chunk, so learner and probe phases are identical at every position; only wall-timed counts vary, as today.
- `core/exec.rs`, `history.rs`, event accounting, the linearizability recording path: untouched. Touched: arm_selector.rs, explorer.rs config struct and key list, campaign.rs two calls, util_stats.rs counters, evaluate.ts three lines, grader.ts.

## Determinism and identity

Every selector draw stays `derive_seed(schedule_seed, run_id, DRAW_SALT)` (arm_selector.rs:413) and the unit draw `salted_unit(run_id, EXPLORE_SALT)`; the run's own schedule stream is never read. Loaded state changes which learner runs exist and which arms they pick; a coin-drawn or probe run's arms are `ArmSet::coins(run_id)`, so its schedule stream is identical with or without state (not byte-identical: the template's timeline feedback with `steer: true` and the learned cap are shared across runs). The file is keyed to the tree twice: the fingerprint and spec hash in the explorer, and the grader handing a chunk only the file recorded under the same session or cache identity.

## Cost

Stage A ~45 min (A' ~45 min more). Stage B: explorer work ~half a day plus tests; two baseline chunks ~12 min; the hand-run chain ~24 min; hand comparison. Stage C: most of the work (identity, modes, retries, transport, selftest, finish block, docs), about a day; session a ~30 min (candidate side only), session b ~50 min; a trajectory baseline per tree thereafter 22-24 min and ~100 min per two-seed-set decision against 50 today. `expectedCost` 7.

## Open decisions (with recommendations)

1. Transport: `OneEvalOpts.sets` folded into `extra` (three lines in evaluate.ts); not the env variable.
2. Pilot first: yes, gating, with the fresh-only corpus split; go at >= 1.03, stop under 1.02.
3. DISCOUNT 0.9995 explore: not paired; Stage A' only on a quarter-2 plateau, as its own hypothesis and binary.
4. Replicates: two seed sets for the adoption decision (n = 2, a sign not an interval); a bit-randomized candidate may still be graded on one trajectory since its contrast is within chunks.
5. `maxChunks`: 4 per trajectory, second seed set over longer trajectories; `maxSequentialChunks` 12 (policy.ts:110) allows two back-to-back trajectories in one session if preferred.
6. Trajectory as the standard: only after sessions a and b agree in sign and the calibration-shrinkage read is affordable; otherwise keep trajectory sessions for selector-side candidates and independent sessions for table-read proposals.
7. New: `spur_commit` dropped from the header (no `SPUR_GIT_SHA` at build); provenance is the chunk record's `spurTree` and state-file sha.
8. New: the pilot reader lives in `research/lite/tools/quarter_bins.py`, kept, so Stage B's hand comparison reuses it.
