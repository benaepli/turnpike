# Plan: selector learner state carried across a grader session's chunks

Tree at planning time: superproject `84c7f07`, spur `b86baad` (the iteration-61 pooled-cells merge), current independent cache `research/lite/baselines/34b5ef40e3bf-30-f9daa01b-300-g870d4c11-s3d907a50.json` (2 chunks, depth>=8 events [9551, 9285], 2,014 runs/s).

## Hypothesis JSON

```json
{"id": "selector-state-across-chunks", "kind": "harness+explorer", "origin": "user",
 "title": "Carry the per-cell selector's three learners' cells across the chunks of a grader session",
 "mechanism": "chunk k of a session starts its explorer with the CELLS the chunk k-1 explorer wrote at session end; the run-cap, crash-placement and timer-context learners stay per chunk",
 "prediction": {"primary": "depth>=8 per run, trajectory of four chunks against the same binary's independent chunks on the same seeds", "band": [1.03, 1.10], "refute": "< 1.02 pooled, or positions 2-4 not above position 1",
   "observables": "warmup_coin_runs ~0 on positions 2-4 (21,177 on a fresh chunk); campaign coin share 0.11 -> 0.03-0.05 by position 4; mean top margin 0.92 -> 0.95+"},
 "expectedGain": 7, "expectedCost": 4, "cannotBeTurnedOffPerRun": true}
```

## Pilot first (no harness change, about 40 minutes)

One explore of 1,200 s on the current tree, the baseline template, seed 1000, kept output directory, then the same porcupine + grade the evaluator runs, cut by run start time into four 300 s quarters.

```
RAYON_NUM_THREADS=30 spur/target/release/spur explore -e campaign \
  --config tmp/loop/lite/pilot-1200.config.json   # template with session_seed 1000, "stats": true
  -y --output-dir tmp/loop/lite/pilot-1200/out --set campaign.wall_budget_sec=1200 bin/spur/VR.spur
```

Then `porcupine/batch` and `traceanalyzer -runs` with run depths (the calls `runOneEvaluation` makes in `research/orchestrator/src/evaluate.ts` lines 397-418; `HARD_LIMITS.maxExploreBudgetSec` is 600 in `policy.ts`, so the grader cannot buy a 1,200 s chunk and the pilot runs spur directly). The run rows carry `session_offset_ms` (`explorer.rs` `run_row`), so depth>=8 per run and steps per run bin by quarter; quarter 1 is the fresh-chunk regime and should reproduce the cache's 9,300-9,600 events per 300 s. Read: (1) depth>=8 per run in quarters 2-4 against quarter 1 and against the cache's chunks; (2) `utilization.json` `arm_selector_explore.warmup_coin_runs`, `share_micro/draws`, `margin_micro_by_arm`; (3) per arm, the aos arm separately (its single cell is already mature at 87,000 runs and is the control for "maturity pays").

Caveats the pilot carries: the campaign planner sizes slices from `wall_budget_sec` (`campaign.rs` around line 728), so slices are four times longer; and the run-cap, placement and timer learners mature too, which the harness change will not carry. So the quarter-4-over-quarter-1 read is an upper bound on the harness change; if it reads under 1.03 the plan stops here. Cost: 20 minutes explore, about 15 minutes porcupine and grading on 2.4M runs.

## Files and mechanisms to change (in order)

1. `spur/spur-core/src/simulator/arm_selector.rs`
   - `#[derive(Serialize, Deserialize)] pub struct SelectorState { fingerprint: Fingerprint, written_by: WriterInfo, learners: [Vec<CellRecord>; 3] }`, `CellRecord { arm: i32, config: i32, alpha: [f64; 12], beta: [f64; 12], reward_mass: f64, mass: f64, observations: u64 }`. `Fingerprint { axes: 5, directions: 12, axis_start: [0,3,5,7,9,12], discount: 0.998, warmup: 24, rewards: ["OvertakenGhost","AbsorberCycle","CycleBeforeRequest"], format: 1 }`. `WriterInfo { spur_commit: Option<String> (from option_env!("SPUR_GIT_SHA")), session_seed, spec_sha256, wall_budget_sec, runs_observed }`.
   - `pub fn export_state(info) -> SelectorState`, `pub fn import_state(&SelectorState, expect_spec_sha) -> Result<LoadReport, String>` (refuses on any fingerprint field or spec mismatch; `LoadReport { cells, observations, mass, warm_cells }` per learner), `pub fn save_to(path)`, `pub fn load_from(path)`. Import replaces CELLS after `reset()`; nothing else in the module changes. `serde_json` round-trips f64 exactly, so a save-load is bit-identical.
   - Tests: save -> reset -> load -> `choose` is equal for every learner id at fixed `schedule_seed` (extends `no_run_touches_the_schedule_stream_and_the_choice_is_reproducible`, line 724, which keeps `schedule.draws == 0` unchanged); a fingerprint with `discount` 0.999 is refused; a loaded warm cell serves no warmup coin run.
   - Size: 54 pooled cells + 1 aos cell per learner on this template (217 was the pre-pooling count), 3 learners, 27 numbers per cell: about 4,500 numbers, under 150 KB of JSON.
2. `spur/spur-core/src/simulator/util_stats.rs`: an `ArmSelectorStateStats` block beside `ArmSelectorPooledStats` (line ~4790): `loaded` (0/1), `written` (0/1), `refused` (0/1), `loaded_cells_by_learner`, `loaded_warm_cells_by_learner`, `loaded_observations_by_learner`, `loaded_mass_micro_by_learner`, `written_cells_by_learner`. These land in `utilStats.counters` of every chunk record through `utilSubset`'s `numericLeaves`.
3. `spur/spur-core/src/simulator/explorer.rs`: two envelope fields on `ExplorerConfig` (line 183), `selector_state_in: Option<PathBuf>` and `selector_state_out: Option<PathBuf>`, `#[serde(default)]`, added to `EXPLORER_CONFIG_KEYS` (line 359). In `run_explorer` after `arm_selector::reset()` (line 1221): `if let Some(p) = &config.selector_state_in { arm_selector::load_from(p, spec_sha)? }`; the save at the end of `run_explorer_impl` before the summary returns. Standard mode gets the hooks for symmetry; the panel and regression never set them.
4. `spur/spur-core/src/simulator/campaign.rs`: both keys into `SESSION_LEVEL_KEYS` (line 48); the load after `arm_selector::reset()` at line 970 (a refused load is a hard error, never a silent fresh start); the save in `run_campaign_impl` right after `writer.shutdown()` (line ~1120), so a cancelled session still writes what it learned. The aos arm's own cell `(arm_index, -1)` is in CELLS and is carried with the rest.
5. `research/lite/grader.ts` (operator-owned):
   - `BaselineIdentity.selectorState: "independent" | "trajectory:<len>"`; into `identityKey` (line 195) and `cacheFileFor` (line 199, suffix `-traj4`); `tryAdoptRecord` returns null for a trajectory identity; `BaselineCache.trajectory?: { len: number; stateFiles: Record<string, string> }`.
   - `SessionState.trajectory?: { len: number; stateDir: string }`; `cmdStart` takes `--trajectory-len <n>` (default off, so every existing session and cache is untouched).
   - `cmdChunk`: position `p = state.usedSeeds.length % len`; state in = the file of position p-1 (none at p == 0), state out = `research/lite/state/<name>/selector-<seed>.json`; baseline state files beside the cache as `<cacheBasename>.selector-<seed>.json`. The paths reach the explorer as `SPUR_CONFIG_SET="selector_state_in=<a>;selector_state_out=<b>"` set on `process.env` around each `runOneEvaluation` call (both `measureBaselineChunk` and the candidate call) and deleted after; `config_override.rs` reads that variable and `explore()` in `runners.ts` inherits `process.env`, so `research/orchestrator/` is not edited. A dropped, failed or excluded chunk in trajectory mode re-runs the same seed from the same input file (today it skips the seed on both sides, line 854) with a cap of two retries per position; a candidate chunk at position p > 0 is refused when the baseline cache lacks the position p-1 state file.
   - `buildStatus`/`cmdFinish`: a `trajectory` block (len, positions folded, per-position candidate and baseline depth>=8 per run and their ratio, coin share and `warmup_coin_runs` per position from the chunk records, the aos arm apart) and a standing blocker `"trajectory session: chunks are one sample path, not independent replicates; decide by hand on the per-position read and the second seed set"`. `perChunkRatios` and the chunk-variance term in `internalPrimary` (decide.ts 548-560) are reported but labelled conditioned.
   - `cmdBaseline` takes `--trajectory-len`; `cmdFreezeEpoch` records `selectorState` in the identity block.
   - `cmdSelftest`: trajectory caches must hold contiguous seeds from 1000 in order with a state file per seed; a session with `trajectory` on an independent cache is a failure; trajectory sessions are excluded from the chunk-to-chunk dispersion measurement (lines 1277-1307), since their per-chunk ratios are conditioned; `identityKey` of trajectory and independent identities differ.
   - `cmdPanel`, `cmdRegression`: unchanged; no state. Panel members are other specs on their own grids, so a VR state file is meaningless there and the loader's spec check refuses it anyway.
6. `research/lite/lite.json`: `"trajectoryLen": 4` under budgets; `maxChunks` stays 4 for the first session (decision 4 below).
7. `docs/agent/lite-grader-status.md`, `research/lite/README.md`: the `trajectory` block, the blocker, the cache suffix, the state files under `state/<name>/` and `baselines/`.

Nothing in `research/orchestrator/src/` changes on the env-var route; if the user prefers an explicit seam, `OneEvalOpts.sets?: string[]` appended to `sets` in `runOneEvaluation` (evaluate.ts line 379) is a three-line edit and the grader passes the two assignments there instead.

## Config surface

Two envelope fields, default null, session-level, never written into `scheduler_configs/loop/general_vr.json`. The baseline identity hashes the template file (`identityFor`, line 175), not the materialized `<outputDir>.config.json`, and `--set`/`SPUR_CONFIG_SET` are applied in-process after the file is read, so `templateSha` and the epoch identity's template term are unchanged; the trajectory term enters the identity explicitly instead. The materialized config carries the two paths, so a preserved violation's `config.json` records which state the run had.

## What is carried and what is not

Carried: the three learners' `CELLS` only (per cell: `alpha[12]`, `beta[12]`, `reward_mass`, `mass`, `observations`). Not carried: `run_cap` (a step cap per scope, recomputed at doubling checkpoints from probe lengths; stable within a few hundred runs of 600,000), `fault_timing` (the placement span, the median probe length), `timer_context` (per-context acted odds), the corpus. Reasons: they reach their asymptote inside a chunk, so carrying buys nothing measurable; they are the invariance controls of their own contrasts (probes are the untreated population); and iteration 53 showed they are campaign-wide couplers - the cap and span re-tune every arm, and carrying them would let chunk k-1's sample set chunk k's run lengths, which throughput tracks and the `steps per run` balance guard reads. Carrying the selector alone leaves the untreated runs' schedule streams byte-identical to today.

## Firing counter

`arm_selector_state.loaded == 1` and `loaded_warm_cells_by_learner` about [55, 55, 55] on positions 1-3 (0 and absent on position 0); `arm_selector_explore.warmup_coin_runs` near 0 on positions 1-3 against about 21,000 on position 0; `arm_selector_state.written == 1` on every position. A chunk on a position above 0 with `loaded == 0` is a harness fault, not a null result.

## Predicted observables

Position 0 reads exactly as an independent chunk. Positions 1-3: campaign coin share 0.11 falling toward 0.03-0.05 (the aos cell sits at 0.014-0.017 on 87,000 runs; a pooled grid cell reaches about 14,000 observations by position 3), mean top margin 0.92 to 0.95+, learner agreement up, depth>=8 per run +7 to +13 percent on positions 1-3, which is +5 to +10 percent on the whole trajectory against independent chunks; depth>=10 per run leaning the same way on 100-150 events per chunk. Throughput unchanged within layout noise (the selector's cost is the same per draw). The aos arm unchanged.

One bound to state plainly: `DISCOUNT` 0.998 caps a direction's discounted mass at 500 of its own observations, so carried state cannot make a cell "see" a reward at 0.001-0.003 per run any better than about one reward per window; what it buys is the warm start and the non-leading directions' evidence, which at a coin share of 0.11 collect 100-200 observations per chunk and need three or four chunks to fill the window. The pilot's quarter-by-quarter margins show whether they plateau at quarter 2 (the window's signature) or keep rising. Loosening the window is a constant, in-explorer, and a separate decision after the pilot.

## Statistics and pairing

Under a trajectory the four chunks are one sample path measured four times; the per-chunk t-interval and the chunk-variance term in `internalPrimary` assume replicates they no longer have.

(a) Cross-binary: keep the pooled binomial on the trajectory against the paired baseline trajectory on the same seeds, overdispersion 1.3 charged, and drop the t-interval. Replicates are sessions on disjoint seed sets: 1000-1003 and 1004-1007. The first session is the same binary on both sides (trajectory candidate against the existing independent cache, seeds 1000-1003), so no layout floor applies and the counting null band with 1.3 is the read; later sessions (candidate trajectory against baseline trajectory) keep the 5 percent layout floor as today.

(b) The internal treated-versus-untreated contrast within a chunk is unaffected; its marginal-effect caveat grows, since a learner-feeding mechanism's treated runs now also shaped the state chunk k inherited.

Until `finish` prints the trajectory block, the operator reads by hand from the chunk records: per position, depth>=8 and depth>=10 per run on both sides and their ratios; the pooled ratio with the 1.3-charged binomial interval; coin share and warmup runs per position; the aos arm apart; and, on the second seed set, sign agreement with the first. The typed rule's `adviceVerdict` is not a merge signal on a trajectory session; the standing blocker enforces that.

The baseline cache must be a trajectory cache under trajectory sessions: measured in seed order as one entry, the identity carrying the trajectory term, so trajectory chunks and independent chunks never pool. The epoch ledger's `measuredRps` comes from whichever cache the merge's session used, named in the row's `cacheFile` as today; the ledger's ratio convention (cache to cache) is unchanged and the drift check tolerates the two kinds since throughput per chunk does not depend on the state.

## Cost

A trajectory baseline per tree is four chunks in order, about 22-24 minutes idle-host (300 s explore plus about 60 s porcupine and grading each), and it invalidates on every merge like today. Two seed sets double that: about 48 minutes of baseline plus 48 of candidate per decision, so about 100 minutes per session against 50 today. The first session against the existing independent cache costs only the candidate side plus two missing baseline seeds (1002, 1003 are not cached).

## Determinism and identity

Every selector draw stays `derive_seed(schedule_seed, run_id, DRAW_SALT)` and the unit draw stays `salted_unit(run_id, EXPLORE_SALT)`; the run's own schedule stream is never read (the CountingRng test keeps `draws == 0`). Loaded state changes which learner runs exist and which arms they pick; a coin-drawn or probe run's arms are `ArmSet::coins(run_id)`, a pure function of the run id, and its stream is untouched, so each untreated run is byte-identical with or without state. The CountingRng property becomes: given (run id, schedule seed, state), `choose` is reproducible, and a save-load round trip preserves it. The file is keyed to the tree twice: the explorer refuses on the fingerprint (axis layout, discount, warmup, reward set, spec hash), and the grader only ever hands a chunk the file written under the same session identity (cache identity for the baseline, session name for the candidate), so a file from another binary cannot be reached by construction; `spur_commit` in the header is provenance, filled when `SPUR_GIT_SHA` is set at build.

## Risk flags

`spur-core/src/simulator/core/exec.rs`: untouched. `history.rs` and the recording path: untouched; `PersistableRun` already records the learner bit. Event accounting and the oracle: untouched. Touched: `arm_selector.rs` (serialization and an import that replaces CELLS after reset), `explorer.rs` config struct and key list only, `campaign.rs` two calls, `util_stats.rs` counters, `grader.ts`. The one hazard is a chunk at position > 0 silently starting fresh; the loader errors on a missing or refused file and the counter makes it visible.

## Grading plan for the first session

Session `selector-state-traj-a`, `--trajectory-len 4`, no treatment bit (the state is session-global; cross-binary fallback), candidate binary = the current tree's own binary, seeds 1000-1003 against the independent cache. Rungs: depth>=8 per run (primary), depth>=9 and depth>=10 per run (advance), throughput. Expected: position 0 at 1.00; positions 1-3 at 1.07-1.13; trajectory 1.05-1.10; coin share by position 0.11, 0.06, 0.04, 0.03; `warmup_coin_runs` 21k then ~0. Refuted if positions 1-3 do not clear position 0 or the pooled ratio sits under 1.02. Then `selector-state-traj-b` on seeds 1004-1007 (baseline measured fresh, four independent chunks) for sign agreement. Merge of the harness change = adopting `trajectoryLen` in `lite.json`, measuring the trajectory baseline cache, and re-freezing the epoch identity with the trajectory term.

## Open decisions for the user (with recommendations)

1. Path transport: `SPUR_CONFIG_SET` env from the grader (no orchestrator edit) or `OneEvalOpts.sets` (three lines in evaluate.ts). Recommend the env route for the first session, the seam later.
2. Pilot before building: yes; stop if quarter-4-over-quarter-1 depth>=8 per run is under 1.03.
3. Replicates: two seed sets per decision, at about double the session cost. Recommend yes for the adoption decision and for any later candidate that is not resolved by the within-chunk internal contrast; a bit-randomized candidate can still be graded on one trajectory since its contrast lives within chunks.
4. `maxChunks`: keep 4 per trajectory; use the second seed set rather than longer trajectories, since the 500-observation window saturates the leader directions inside one chunk and the rest by chunk 3-4. `HARD_LIMITS.maxSequentialChunks` is 12, so one session of two back-to-back trajectories (`maxChunks` 8, position resets every 4) is possible if one session file is preferred over two.
5. `DISCOUNT`: unchanged for this change. If the pilot's margins plateau at quarter 2, a longer window (0.9995, window 2,000) is the follow-up mechanism that turns four chunks of life into four chunks of evidence for the rare rewards; it is an explorer constant and a separate grade.
6. Trajectory as the standard: after adoption, every session runs as a trajectory and the independent caches are kept but no longer extended. Recommend adopting only if session b agrees in sign with session a.
