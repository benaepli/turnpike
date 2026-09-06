# Review: selector-state-across-chunks revision 2 (read-only; tree as of this session, spur b86baad)

Verdict: revision 2 adopted every CORRECTED/MISSED item of the first review (one declined with a stated reason, one over-corrected). Its new claims are nearly all right; the errors are small and mostly in the pilot's reader and decision rule. The pilot is worth running, but its decision rule needs a selector-free control and a noise price before it can gate Stage B.

## 1. Adoption of the first review's items

| First-review item | v2 | Where |
|---|---|---|
| Slices stay 20 s at 1,200 s | yes | v2:21 |
| `cells` gauges must be set on import (MISSED) | yes | v2:49, calls `record_arm_selector_cell_created` per imported cell |
| Materialized config does not carry `--set`/env; fold into `extra` via `OneEvalOpts` | yes | v2:69, decision 1 |
| "byte-identical" -> "schedule stream identical" | yes | v2:96 |
| No t-interval exists in code (reporting note) | yes | v2:59 reads the 1.3-charged binomial only |
| Position-p refusal vs first session on the independent cache (INCONSISTENT) | yes | v2:66 names the two modes |
| Warm-up 21,177 -> 1,360 | yes | v2:13, :19 |
| Reward rate 0.001-0.003 belongs to the base-rate wall | yes | v2:20 |
| Hold `nextSeed` on both drop paths (:854, :868) | yes | v2:68 |
| Key input state on the accepted chunk record, not the seed | yes | v2:67 |
| Env transport in try/finally if ever used | yes | v2:69 |
| `spur_commit` from `SPUR_GIT_SHA` unverifiable | resolved: dropped | v2:49, decision 7 (verified: no `SPUR_GIT_SHA` anywhere under spur/; the one build.rs, spur-liquid/build.rs, is the formulog hook, so "no build.rs" is wrong in letter, right in substance) |
| Pilot: bin replay/cap counters by quarter with depth | partially | v2:38-40 uses the per-run `REPLAY_SLOT` bit and `end_reason` instead of counters, because utilization is dumped once (main.rs:555, one call). Right substitution; see the caveat in 3 below |
| Pair the pilot with a DISCOUNT 0.9995 explore | declined with reason | v2:45, decision 3. I agree: two mechanisms in one quarter read confound; Stage A' as a separate binary is the honest form |
| Blocker text for a trajectory session | yes, verbatim | v2:70 |
| Calibration-table shrinkage priced before adoption | yes | v2:73 |
| Lock-in read via `chosen_by_direction` | yes | v2:87 |
| `expectedCost` 4 is light | over-corrected to 7 | v2:14; see 2 |
| Order: pilot, then items 1-4 plus hand trajectory, then adoption | yes | Stages A/B/C |

## 2. New claims: verification, and errors introduced

Verified (file:line): `materializeConfig` sets `session_seed` (runners.ts:178) and `-e campaign`/`--set campaign.wall_budget_sec` is the budget route (evaluate.ts:379-381); siblings `<out>.campaign.json` (main.rs:592), `<out>.session.json` (:616), `<out>.utilization.json` (:655), utilization written once (:555); `porcupine/batch` is what the loop invokes (runners.ts:382) and exists built (Aug 28, no newer source), `-timeout 3000` matches evaluate.ts:394; grade flags incl. `-grade-run-depths` (main.go:29) and `-grade-max-runs 0` = all runs (main.go:26); `-grade-budget-ms 7200000` is 4x `sequential.wallSecPerChunk` 1800 (policy.json:61, grader.ts:417); `-runs -runs-columns` (main.go:32-33) and every named column exists in the runs schema (history.rs:473-489, `session_offset_ms` :481, `variant` :489); no `duckdb` CLI and no python module; parquet writer (history.rs:559-561, :719-722); `read_depths` (ghost_census.py:765-768); `PROBES = 2 | 4` (pool_cells.py:26); bits RUN_CAP_PROBE 1<<1 (:40), TIMER_STEER_OFF 1<<2 (:43), REPLAY_SLOT 1<<20 (:71), REPLAY_PREFIX 1<<21 (:74), learner bits 5|6|7 (:80-89); `learned_cap_reached` (explorer.rs:984); `ReplayStats.parents_admitted/children` (util_stats.rs:4927-4930); `chosen_by_direction` (:4696); `share_micro`, `warmup_coin_runs` (:293-294); `RATE_EXCLUDED_ARM_MODES` (decide.ts:29); cache depth>=8 9,551 / 9,285, 2,018 / 2,010 runs/s, `warmup_coin_runs` 1,360 / 1,358; `DISCOUNT` 0.998 (:75), `WARMUP_OBSERVATIONS` 24 (:79), no `discount` key in explorer.rs/campaign.rs/plan_config.rs/config_override.rs; `maxBuildSeconds` 600 (lite.json:18); `record_arm_selector_cell_created(reward: Reward, pooled: bool)` (util_stats.rs:2367-2373); `cells_by_learner` (:4800-4816); bare `--set` value falls back to a JSON string (config_override.rs:150-151); `cmdBaseline` (grader.ts:1067-1119) fills seeds from 1000 skipping cached ones, so `--chunks 4` adds 1002 and 1003 unless one drops (then 1004); flags match the usage line (:17); `chunkDirFor` (:357-359), `usedSeeds.push` (:942), drop paths (:854, :868), `cmdFreezeEpoch` (:1125), dispersion (:1273-); `OneEvalOpts` (evaluate.ts:196-204, no `sets` today), `sets`/`extra` (:379-388), `preserveViolations` copies the materialized config (:311-313); `run_explorer_impl` has one exit after `writer.shutdown()` (explorer.rs ~1347, the early returns are inside the producer and worker closures); the campaign does not call `run_explorer` per slice (`run_campaign_impl` drives slices itself, campaign.rs:1044-1115), `arm_selector::reset()` runs once per session (:970), so state is not reset between slices and the save at :1120 is the right place.

Corrected:
- v2:37 "ghost_census.py:768-777 already has both loaders": `read_runs_table` (:771-777) keeps only `steps_used, end_reason, variant`; it drops `session_offset_ms` and `arm`. The quarter reader must extend it, not reuse it.
- v2:28 `jq '.session_seed=1000'` is not all `materializeConfig` does: for a campaign it also sets `num_runs_per_config` to `sequential.maxRunsPerConfig` 4000 (runners.ts:177, policy.json:52) over the template's 100 (general_vr.json:68), and the campaign reads it in `epochs()` (campaign.rs:586). Add `.num_runs_per_config=4000` so the pilot's config equals a chunk's.
- v2:37 campaign.json history "only runs/wall/reward": `HistoryEntry` also carries `slice, arm, round, budget, started_ms` (campaign.rs:899-908). Per-quarter run counts per arm are available from it; depth is not, so the conclusion (bins from run rows) stands.
- v2:38 "fresh rows (`variant & (1<<20) == 0`)": right population, wrong label for the remainder. `REPLAY_SLOT` is a pure function of the run id (run_variant.rs:67-71: a slot "ran as a child when the arm held a parent, and fresh otherwise"); there is no per-run bit for an actual child. Non-slot rows are never replayed, so fresh-only is clean; "all-rows minus fresh-only" is the slot population, whose fill rate itself matures with the corpus. Say "slot rows", and read `replay.children / slots` session-total only.
- v2:45 "~25 min porcupine and grading on ~2.4M runs": the cache prices a 606k-run chunk at 35 s + 150 s, so ~12-13 min.
- v2:73 "control rows from ~63k to ~28k": 63k is per axis (direction sums 5,142+29,122+29,003 = 63,267); per direction the rows are 5.1k (direction 0) to 32k, so at share 0.05 direction 0 falls to ~2.3k and directions 10/11 to ~7k. The 2.2x variance figure holds per axis; the "directional only" verdict is set by the small directions and should be stated per direction.
- v2:8-14 hypothesis JSON: `kind: "harness+explorer"`, `origin`, `positionBand`, `cannotBeTurnedOffPerRun` are not fields of `HYPOTHESIS_JSON_GUIDE` (agents.ts:223-234: kind is add|ablate|meta|enabling|grader|perf|arm; prediction needs firingCounter/rung/sizePct/falsifier). Harmless while the plan stays user-originated and outside the pool; it will not parse if recorded with the loop's tools.
- v2:14 `expectedCost` 7: the judge rubric's anchors (agents.ts:270) top out around 1.5 for instrumentation/plumbing plus 1 for exec.rs/history.rs, which this does not touch; 7 is off the loop's scale. Price it in the rubric's units (about 2.5-3) and put the day-of-work figure in the Cost section only.

Unverifiable here: the observations.md line cites (first review verified them; v2 did not change them); the pilot's counting-noise, computed below from the cache rather than measured.

## 3. The pilot's decision rule

It separates two of the three maturing things, not three. Fresh-only rows remove the corpus. Nothing in the rule removes cap/span/timer-context maturity from the selector's: the plan lists `learned_cap_reached` share and `steps_used` per quarter as checks (v2:40) but the ratio it gates on is fresh depth>=8 Q4/Q1, which carries both. The selector-free control is already in the rows: coin-drawn non-probe runs (no learner bit, not `PROBES`) take `ArmSet::coins(run_id)` whatever the cells hold, so their depth>=8 rate per quarter moves only with cap/span/timer/corpus. Read the ratio of ratios: (fresh all-rows Q4/Q1) / (fresh coin-rows Q4/Q1) is the selector term; the coin-row Q4/Q1 alone is the cap/span term. Probe rows are a second, cruder control (unsteered in length or timer, not both).

The go threshold is also mis-scaled in two ways. (a) Position k of the harness starts with k chunks of observations, i.e. quarter k+1's starting state; so pilot Q2/Q1 is the proxy for position 1 and mean(Q2,Q3,Q4)/Q1 for the pooled positions 1-3, not Q4/Q1. Q4 is fully warm on every learner and every runner-up direction (450 observations per chunk at share 0.11 reaches the 500-observation `DISCOUNT` window by quarter 2-3), so Q4/Q1 is an upper bound on position 3 and a looser one on the pooled read. If Q4/Q1 (after the coin control) is only 1.03, positions 1-3 pooled land below the plan's own band [1.03, 1.08] by construction. Set go at coin-controlled mean(Q2-Q4)/Q1 >= 1.03 and Q4/Q1 >= 1.05; keep stop under 1.02 on the mean. (b) Noise: ~9.4k depth>=8 events per quarter, of which fresh rows hold roughly 60%, gives a Q4/Q1 SE of about 1.9% Poisson, 2.4% with 1.3 charged; the 1.02/1.03 boundaries sit inside one SE, and the per-arm and per-direction reads are noisier still. Either accept the pilot as a sign read, or run seeds 1000 and 1001 (another 20 min explore) and pool quarters across the two.

The sanity check (Q1 reproduces the chunk's 9,300-9,600) is fine at +-2%, given the config amendment above.

## 4. Stage B as the end state

Stage B (save/load in the explorer, driven by `--set selector_state_in/out`, graded by the same three calls, compared by hand against the cache) answers the scientific question: does a warm selector lift depth>=8 on later positions, by how much, and does the leader set lock in. Stage C buys automation of that read plus a new identity, retries and modes, a second overdispersion regime the 1.3 was not calibrated on, and a standing 2.2x shrinkage of the calibration tables every later proposal reads. The plan's own adoption gate (v2:75) requires the shrinkage read to be affordable, and its decision 6 keeps independent sessions for table-read proposals regardless. Recommend: make Stage B the planned end state, kept as an operator tool with `quarter_bins.py` and a short README note; reopen Stage C only if the hand trajectory shows positions 1-3 each above ~1.05 on both seed sets and the shrinkage read passes. A selector-side candidate can be graded by hand on a trajectory with Stage B alone, and decision 4's bit-randomized case is served by the ordinary independent session (its contrast is within chunks and does not need carried state).

On sessions a and b: both are same-binary trajectory-vs-independent reads; b is a replicate on 1004-1007, not a different design, and "baseline measured fresh" only means those seeds are uncached. That is coherent as an n = 2 sign check; the plan should say "replicate", not present b as adding a kind of evidence a lacks. Decision 4's claim that a bit-randomized candidate grades properly inside a trajectory is right for the point estimate (both bit values run under the same carried state) but not for the chunk-variance term (decide.ts:548-560 assumes independent chunks; positions share a leader set).

## 5. Recommendation

Proceed with Stage A, amended; hold Stage B until the pilot's coin-controlled read is in observations.md; plan Stage B as the end state.

1. Pilot reader and rule: add the coin-run depth rate per quarter as the selector-free control and gate on the ratio of ratios; gate on mean(Q2-Q4)/Q1 >= 1.03 and Q4/Q1 >= 1.05 rather than Q4/Q1 >= 1.03; state the ~2.4% SE and either treat the pilot as a sign read or run both cached seeds.
2. Pilot config and reader mechanics: `.num_runs_per_config=4000` in the `jq` line; extend `read_runs_table` for `session_offset_ms` and `arm`; call the non-fresh remainder "slot rows".
3. Scope: declare Stage B the end state; move Stage C behind an explicit gate (positions 1-3 each above ~1.05 on both seed sets, shrinkage affordable per direction, not per axis); re-price `expectedCost` in the rubric's units and fix the hypothesis JSON's field names if it is ever to be recorded.
