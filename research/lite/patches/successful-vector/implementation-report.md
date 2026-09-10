# successful-vector: implementation report

Hypothesis: `selector-successful-joint-arms-with-uncertain-axis-mutation`
(research/lite/plans/iteration-73-admitted.json). Baseline spur commit
b86baad3f94ce14dbdf20688b61fd92317a75cc2. No config field, no campaign arm,
no treatment bit, no harness edit, no commit.

## Files changed (spur submodule; see spur.patch)

- `spur-core/src/simulator/arm_selector.rs` (+1175/-7): the population and
  the supported draw; new tests; two fixtures adjusted (see below).
- `spur-core/src/simulator/util_stats.rs` (+315): the
  `arm_selector_population` block, its record helpers, reset paths.
- `spur-core/tests/util_stats_export_completeness.rs` (+123): the new
  block's constructor and leaves, block name registered.

Superproject: nothing beyond the seeded `scheduler_configs/loop` and the
submodule pointer. `super.patch` contains only the `-dirty` gitlink line.
`general_vr.json` is exported unchanged.

## Mechanism as implemented

- Each `CellLearner` owns one `Population`: a ring of at most 24
  `Success { at: u64, arms: u8 }` entries (`ArmSet::index` of the rewarded
  set, credited-observation index at insertion), plus `multiplicity[72]`,
  `distinct`, `top_multiplicity`, cached `axis_weights[5]`, cached
  `mixture[72]` with its total, and an `AtomicU64` of supported draws.
- `CellLearner::credit` keeps the marginal equations byte for byte, then:
  expire entries with `observations - at > 500` (age 500 stays), insert the
  carried set when this learner's own Boolean reward is true (stamped with
  the completed credit's observation index), refresh `axis_weights` when
  `observations % 24 == 0`, and rebuild the mixture when membership changed
  or the weights were refreshed. Aging happens on every admitted outcome,
  zero rewards included. The initial weights are uniform; since a learner
  draw needs 24 observations, the first refresh always precedes the first
  supported draw.
- Entropy interpretation per `admissionDecisions.entropyInterpretation`:
  `leading_probability(a)` normalized within the axis, Shannon entropy per
  axis (zero terms contribute zero), the five entropies normalized; all-zero
  gives uniform axes; no floor, no width correction.
- Mixture: for every live entry, axis `a` with weight `e[a] > 0`, and
  replacement `d != parent[a]`, add `(1/M) * e[a] * coin(d) / sum_{j !=
  parent[a]} coin(j)` onto the set that differs from the parent on `a` alone.
  Collisions add. A parent's axis whose other directions all have zero coin
  share contributes nothing on that axis (its conditional is undefined); the
  draw samples the mass that remains, and `mixture_total` records it.
- `choose`: warmup, explore share, coin decision unchanged and first. Then
  the private generator is seeded exactly as before. Supported (>= 8 live,
  >= 2 distinct): one `f64` variate inverts the normalized mixture in
  `ArmSet::index` order; the same variate inverts the product of the current
  normalized marginals (fallback one-hot on the first direction where `pick`
  falls back) in the same order for the comparator; Hamming, exact TV and
  the cached axis weights are recorded. Unsupported: the unchanged five
  `sample_axis_leading` picks with identical generator consumption. Coin and
  probe paths consume nothing, as before. Supported draws still go through
  `record_arm_selector_learner_run`, so `chosen_runs`, `departures` (against
  the coins) and the direction/combination tables keep counting every
  learner run with their old meaning.
- `Choice` gained `population: bool`. In `observe`, a learner run with the
  marker records `record_arm_selector_population_outcome(learner, r)` with
  the run's own unchanged reward, without rereading the cell.
- Per-cell supported-draw count is an atomic inside the cell, incremented
  under `choose`'s shared guard; crossing 1/10/100/1000/10000 bumps
  `cells_reaching_supported_draws[i]` (and the per-learner split at 100).
  No nested guards; no cell scanning at snapshot time.

## Export (`arm_selector_population`)

`changed_joint_draws` is the firing counter: supported draws whose set
differs from the coupled product-marginal set. Also: `supported_draws`,
`unsupported_draws`, per-learner splits, `hamming_hist[6]`,
`tv_at_least_tenth`, `tv_micro_sum`, `tv_hist[10]` (tenths),
`mutation_axis_mass_micro[5]` (sum of `e[a]` in millionths over supported
draws; divide by `supported_draws * 1e6` for the share),
`live_entries_hist[25]`, `distinct_hist[25]` (every learner draw past
warmup), `supported_draws_with_four_distinct`,
`supported_top_multiplicity_sum`, `supported_top_share_micro`
(repeated-vector concentration), `supported_completed_runs_by_learner`,
`supported_successful_runs_by_learner`, gauges `cells_created`,
`cell_draw_thresholds`, `cells_reaching_supported_draws`,
`cells_reaching_hundred_supported_draws_by_learner`, `layout_bytes`
(`[cell, population]`), `storage_bytes`, `population_storage_bytes`.
Counters clear on `util_stats::set_enabled(true)`; the cell-bound gauges
clear with `arm_selector::reset`.

## Layout sizes (actual `size_of`)

- `CellLearner`: 1336 bytes
- `Population`: 1120 bytes

Exported as `layout_bytes: [1336, 1120]`. The smoke session created 165
cells: 220,440 bytes of cell state, 184,800 of it population.

## Tests

Command (the repo's established form; the baseline `path` test overflows
the default test stack without it):

    RUST_MIN_STACK=33554432 cargo test --manifest-path spur/Cargo.toml -p spur-core

Verbatim result rows (test.log): 25 rows, 464 passed, 0 failed, 0 ignored.
Unit suite row: `test result: ok. 423 passed; 0 failed; 0 ignored; 0
measured; 0 filtered out`. The completeness suite row: `test result: ok. 2
passed; 0 failed`.

New tests in `arm_selector.rs` covering the map's eight check groups:
ring retention/expiry (7 vs 8, 1 vs 2 distinct, repeats, 24 vs 25, ages
499/500/501, zero-reward aging, support lost and regained); credit exposure
(coin-to-all with differing rewards, own-learner only, probe, no admission
without the learner's own reward, one tick per outcome, marginal state
against the hand-computed discounted update); exact mixture against an
independent parent/axis/replacement enumeration (repeated parents,
nonuniform weights and coins, mass one, every mass-bearing set one axis
from a parent, zero-weight axis unreachable, collision added by hand to
0.14375, zero-share alternatives dropping mass and draws still landing on
mass); entropy weights (ln 3 / ln 2 flat case, fully separated axis at zero,
all-separated uniform); cache lifecycle (initial cache, boundary refresh,
frozen between boundaries, membership-only rebuild, entropy-only rebuild,
expiry rebuild on a zero credit, finiteness); coupled inversion (72 index
round-trip, same order both sides, boundary examples, TV and Hamming by
hand); counters against an independent recomputation through the exported
snapshot, including reproducibility and the cell thresholds; unsupported
cells taking exactly the independent pick from the same generator seed;
outcome timing with the population changing or expiring between draw and
completion; cell isolation, pooled keys, table/gauge reset and counter
reset through snapshot.

Fixture adjustments (no assertion weakened): `separate_retarget` no longer
rewards the no-retarget direction (previously one in fifty), so its rewarded
runs carry one set and the cell stays unsupported; in
`flat_posteriors_...`, learner B is rewarded on the mixed runs that took the
last combination instead of every other mixed run, for the same reason.
Both fixtures assert `!supported()` explicitly.

## Smoke (numbers discarded)

`spur explore -e campaign --config scheduler_configs/loop/general_vr.json
--set campaign.wall_budget_sec=30 ... bin/spur/VR.spur` (the committed
config is untouched; the override is a command-line flag). The block
reached `utilization.json`: `changed_joint_draws` 12351 of
`supported_draws` 15233 (`unsupported_draws` 16512), Hamming histogram
[2882, 4474, 4253, 2588, 883, 153], TV >= 0.10 on every supported draw,
mutation mass split across all five axes, 51 cells at >= 100 supported
draws in 30 seconds, `supported_successful_runs_by_learner` [334, 361, 174]
of [6051, 5586, 3596]. See smoke-population-block.json.

## Predicted effect

Per the frozen prediction: paired candidate/baseline depth>=8 per-run ratio
in [1.07, 1.18] on the four grid arms, primary events per explore-second
>= 1.04, throughput >= 0.97, and the reward-rate clause over four chunks.
Firing floor 50000 `changed_joint_draws` per 300-second chunk; the
30-second smoke gave 12351, so the floor looks reachable but that is not a
measurement.

## Deviations and choices to flag

1. `layout_bytes` is an array rather than two integer leaves. The
   completeness test's difference-and-accumulate path subtracts a fresh
   session's snapshot from the marked one and requires every integer leaf
   to survive; a constant per-cell size is nonzero in a fresh session and
   cannot pass it, so the two sizes ride in a documented two-element array
   (excluded from the difference path like `cell_draw_thresholds`), while
   `storage_bytes` and `population_storage_bytes` stay integer leaves.
2. A parent axis with no alternative direction of positive coin share
   contributes nothing on that axis; the mixture total then falls below one
   and the draw normalizes over the remaining mass (`pick`-style fallback to
   index zero only when nothing has mass). The map did not define this case.
3. Supported draws are still counted by `record_arm_selector_learner_run`
   (with agreements against the current leaders), so the existing learner-run
   counters include them; `departures` keeps its coin comparison.
4. The `cargo test` command had to be run from the superproject root with
   `--manifest-path` (mold is not installed; `spur/.cargo/config.toml` asks
   for it) and with `RUST_MIN_STACK=33554432` for a baseline `path` test.
5. The coordinator's resume message said the worktree held edits; the
   submodule had none (fresh clone after the host restart), so the work was
   implemented from the clean baseline in this session.
