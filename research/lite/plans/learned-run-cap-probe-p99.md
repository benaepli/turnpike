All anchors verified in the base worktree. Here is the implementation plan.

# Implementation Plan: learned-run-cap-probe-p99

## 1. Hypothesis JSON summary

```json
{
  "id": "learned-run-cap-probe-p99",
  "origin": "user",
  "title": "Session-learned primary run cap at p99 x 1.5 of probe-completed lengths; config max_iterations demoted to backup terminator",
  "mechanism": "New simulator module run_cap.rs holds a session-global LazyLock+DashMap learner keyed by the run's post-arm-overlay max_iterations (the backup budget). Runs with run_id % 32 == 0 are probes: they always run to the backup cap and are the only runs feeding the learner. Non-probe runs get effective cap = min(backup, ceil(1.5 * p99 of the scope's completed-probe lengths)), identity until 200 completed probe samples exist in the scope. A non-probe run reaching the learned cap exits through a new termination class (RunEnd::LearnedCapReached, RunOutcome::LearnedCapReached, TerminationTally.learned_cap_reached). Completed-probe lengths exceeding the then-current cap are counted per scope as over_cap_completions. Zero config fields.",
  "constants": { "PROBE_PERIOD": 32, "QUANTILE": 0.99, "HEADROOM": 1.5, "MIN_COMPLETED_SAMPLES": 200 },
  "prediction": {
    "firingCounter": "termination.all.learned_cap_reached (JSON leaf; frozen name termination.learned_cap_reached)",
    "floor": 1000,
    "rung": "depth>=6 events per explore-second, sizePct +30% to +120%",
    "falsifier": "per-run P(depth>=6) falls >5% below same-seed baseline in any capped arm after an A/A drift control; or rate gain < +30% with the cap engaged; or learned_cap_reached stays 0 while the 6000 scope has >= 200 completed probe samples"
  }
}
```

## 2. Files and mechanisms

All paths under `/home/benaepli/Rust/turnpike/tmp/lite/base/spur/spur-core/` unless noted. Line numbers verified against the base worktree.

### 2a. New module: `src/simulator/run_cap.rs`

Modeled on the archived `timer_budget.rs` (LazyLock + DashMap, snapshot-per-run discipline, Laplace-smoothed quantile, decay/reset). Contents:

```rust
pub const PROBE_PERIOD: i64 = 32;
const QUANTILE: f64 = 0.99;
const HEADROOM: f64 = 1.5;
const MIN_COMPLETED_SAMPLES: u64 = 200;
const HIST_CELLS: usize = 256;

struct ScopeAccum {
    bucket_width: u32,          // max(1, backup.div_ceil(256)), fixed at scope creation
    hist: [u32; HIST_CELLS],    // saturating_add, same as timer_budget
    completed: u64,             // completed-probe samples folded in
    over_cap: u64,              // completed probes whose length exceeded the then-current cap
}
static TABLE: LazyLock<DashMap<i32, ScopeAccum>> = LazyLock::new(DashMap::new);

pub enum Outcome { Completed, Exhausted, Deadlocked }

pub fn is_probe(run_id: i64) -> bool { run_id.rem_euclid(PROBE_PERIOD) == 0 }
pub fn effective_cap(backup: i32) -> i32;       // min(backup, learned) or backup (identity)
pub fn merge_probe(backup: i32, outcome: Outcome, steps: i32);
pub fn decay(factor: f64);                      // scale hist/completed/over_cap, retain non-empty
pub fn reset();
```

- `ScopeAccum::cap(backup)`: `None` while `completed < MIN_COMPLETED_SAMPLES`; else scan cells with the timer_budget smoothing `(cum + 1) / (samples + 2) >= QUANTILE`, read p99 as the cell's **upper step edge** `(c + 1) * bucket_width - 1`, return `min(backup, ceil(HEADROOM * p99))`. The learned cap is engaged only when it is `< backup`.
- `merge_probe`: increments `util_stats::record_run_cap_probe(completed)` for every probe outcome; **only `Outcome::Completed` folds into the histogram**. It computes the then-current cap *before* folding; if a cap is engaged and `steps > cap`, increments `over_cap` and `util_stats::record_run_cap_over_cap_completion()`. After folding it republishes gauges via `util_stats::set_run_cap_learned(scopes_learned, current_cap_max_scope)` (cap of the scope with the numerically largest backup key; 0 when none learned).
- **Probe runs that exhaust or deadlock count toward `run_cap.probes` only** — not the histogram and not the 200-sample floor. Decision rationale: the floor is defined on completed samples; an exhausted probe carries no completion length, and a deadlocked length is a truncation that would bias p99 downward (unsafe direction). This differs from timer_budget, where non-completed runs fed a separate firing floor — here the floor and the histogram are the same population by hypothesis text.
- Thread safety / rng: no RNG anywhere in the module; `effective_cap` is one DashMap read plus a 256-cell scan taken **once at run start**, so the loop bound is frozen per run (the snapshot-per-run discipline of timer_budget — here the "snapshot" is a single `i32`). Merges happen only for probes (~3% of runs), off the scheduling hot path, at run end. Racing merges can make `over_cap` off by one run against the "then-current" cap; acceptable for a diagnostic.

Register the module in `src/simulator.rs` (13-line module list): add `mod run_cap;` after `pub mod rng;`. `dashmap` is already a `simulator`-feature dependency (`spur-core/Cargo.toml:20,:50`) used by `coverage.rs` and `feedback.rs` — no manifest change.

### 2b. `src/simulator/path.rs` — cap computation and the new exit

**Decision: the effective cap is computed inside `exec_plan`, with no signature change.** `exec_plan` (`:281-298`) already receives both `run_id` (`:289`) and the post-overlay `max_iterations` (`:285` — call sites pass `config.max_iterations` from the arm-overlaid `SingleRunConfig`, explorer.rs `:1055`, and `max_iterations` at `:1363`). This is the smallest honest surface, and it matches where timer_budget took its snapshot (patch added it right after `util_stats::begin_run()` at the same spot). The probe flag is a local in `exec_plan`.

- After `util_stats::begin_run()` (`:299`):
  ```rust
  let backup = max_iterations;
  let is_probe = run_cap::is_probe(run_id);
  let effective_cap = if is_probe { backup } else { run_cap::effective_cap(backup) };
  ```
- Loop bound `:383`: `for step in 0..max_iterations` becomes `for step in 0..effective_cap`.
- PlanComplete exit (`:384-397`): after `record_termination`, add `if is_probe { run_cap::merge_probe(backup, run_cap::Outcome::Completed, step); }`.
- Deadlock exit (`:412-434`): add `if is_probe { run_cap::merge_probe(backup, run_cap::Outcome::Deadlocked, step); }`.
- Post-loop exit (`:765-781`) splits on `effective_cap < backup` (mutually exclusive with `is_probe`, since probes run at backup):
  - capped: `record_termination(RunEnd::LearnedCapReached, run_id, &path_state.state, &engine, effective_cap, backup, ...)` then `return Ok(RunOutcome::LearnedCapReached { cap: effective_cap, outstanding_events: engine.outstanding_count() })`. `steps_used = effective_cap`, `step_budget = backup` keeps `step_budget_sum` meaning the configured budget.
  - otherwise: existing `IterationsExhausted` path unchanged, plus `if is_probe { run_cap::merge_probe(backup, run_cap::Outcome::Exhausted, backup); }`.
- `RunOutcome` (`:206-212`): add variant `LearnedCapReached { cap: i32, outstanding_events: usize }`. The cap rides in the variant because `run_row` (explorer.rs `:923`) only receives the backup `max_iterations`.
- `record_termination` (`:245-279`): unchanged (takes `RunEnd` by value).

Merge-at-run-end therefore lives entirely in `exec_plan`'s three Ok exits, mirroring the timer_budget patch. Runs that error out mid-run (`?` returns) feed nothing, same as precedent.

### 2c. `src/simulator/util_stats.rs` — termination class + run_cap block

- `RunEnd` (`:1483-1491`): **append `LearnedCapReached` after `Deadlock`** — appending last keeps the by_end declaration-order rows 0-2 stable (see section 3).
- `TerminationTally` (`:1496-1543`): new field `pub learned_cap_reached: u64` (after `deadlock`), init in `new()`, new arm in `add()` (`:1526-1537`): `RunEnd::LearnedCapReached => self.learned_cap_reached += 1`. Serde is snake_case-by-field-name already; the JSON leaf becomes `termination.all.learned_cap_reached` (plus the three `by_recovered_nodes` splits).
- `RunExtension::stop()` (`:1639-1655`): change the last arm to `RunEnd::IterationsExhausted | RunEnd::LearnedCapReached => { ... }`. **Decision:** the prefix-extension buckets classify the frontier state at stop (releasing / blocked / idle), not the stopping authority; the authority split lives in the termination tally and quiet-stretch row. Adding three parallel `CapReleasing/...` variants would grow `PrefixExtensionTally` for a diagnostic no prediction reads. This is a match-exhaustiveness site, so the compiler forces the decision to be explicit.
- Quiet-stretch: see section 3.
- New `run_cap` block: statics `RUN_CAP_PROBES`, `RUN_CAP_PROBE_COMPLETIONS`, `RUN_CAP_OVER_CAP_COMPLETIONS` (counters) and `RUN_CAP_SCOPES_LEARNED`, `RUN_CAP_CURRENT_CAP_MAX_SCOPE` (gauges, overwritten like `TIMER_REFIRE_CLASSES_LEARNED` in the precedent patch); add all five to the reset loop in `set_enabled` (`:287+`). Recording fns `record_run_cap_probe(completed: bool)`, `record_run_cap_over_cap_completion()`, `set_run_cap_learned(scopes: u64, cap_max_scope: u64)` — counters gated on `enabled()`, gauge setter ungated (precedent: `set_refire_classes_learned`).
  ```rust
  #[derive(Serialize)]
  pub struct RunCapStats {
      pub probes: u64,
      pub probe_completions: u64,
      pub over_cap_completions: u64,
      pub scopes_learned: u64,
      pub current_cap_max_scope: u64,
  }
  ```
  Field `pub run_cap: RunCapStats` in `UtilizationSnapshot` (`:2664-2690`, insert after `quiet_stretch`) and populate in `snapshot()` (`:2758+`). All five surface as numeric leaves `run_cap.*` in the chunk records' `utilStats.counters` (the orchestrator flattens every numeric leaf: `research/orchestrator/src/evaluate.ts:141-149,:161-162`).

### 2d. `src/simulator/explorer.rs` — run row + session hooks

- `run_row` match (`:927-931`): add `RunOutcome::LearnedCapReached { cap, .. } => (*cap, "learned_cap_reached"),`. The two `if let RunOutcome::Deadlock` sites (`:1070`, `:1378`) are non-exhaustive and need no edit.
- `run_cap::reset()` at the five session entries, immediately after `util_stats::set_enabled(...)`, exactly where the timer_budget patch put its resets: explorer.rs `:1133` (`run_explorer`), `:1525` (`run_explorer_genetic`), `:1962` (`run_explorer_aos`), `:2609` (`run_explorer_continuous`), and campaign.rs `:834` (`run_explorer_campaign`).
- Decay: the one existing decay cadence is `CurriculumExplorer::step` (`:2286-2288`); add `run_cap::decay(self.decay_factor);` inside the same `if self.decay_factor < 1.0` block (grid/aos arms never decay — same as the timer_budget precedent).

### 2e. Untouchable, confirmed

`scheduler_configs/loop/general_vr.json` needs no change: the campaign block's arms already set the backup budgets the learner keys on (`grid-short` overlay `max_iterations: 1500`; the other four arms inherit 6000). Run ids come from the shared session `run_counter` (campaign.rs `:408`) and the batch is precomputed as `(run_id, config_index)` pairs (`:406-413`), so `run_id % 32` designates ~1/32 probes uniformly per arm without perturbing any other run's seeds (`derive_seed(arm_seed, run_id, ...)`, `:428-429`).

## 3. by_end row-mapping decision (quiet-stretch)

`QuietStretchState.by_end` is `[[u64; HIST_BUCKETS]; 3]` (`:1763`, comment: "in the order RunEnd is declared"). **Decision: grow the array to 4** — `[[u64; HIST_BUCKETS]; 4]` (`:1763`, `:1771`), map `RunEnd::LearnedCapReached => 3` in `record_quiet_stretch` (`:1820-1824`), and add `pub learned_cap_reached: Vec<u64>` to `QuietStretchStats` (`:1784-1792`) read from `q.by_end[3]` (`:1799-1806`). Rows 0-2 keep their exact meaning and JSON names (`plan_complete`, `iterations_exhausted`, `deadlock`); the new row is additive (and being an array, it is invisible to the counter flattener, which skips arrays). Appending the enum variant last keeps the declaration-order invariant the comment states.

## 4. New termination class plumbing — complete consumer list

Every `RunEnd` / `RunOutcome` consumer in the workspace (verified by grep over `spur/`):

| Consumer | Anchor | Edit |
|---|---|---|
| `RunEnd` enum | util_stats.rs:1483 | append `LearnedCapReached` |
| `TerminationTally::add` | util_stats.rs:1526-1537 | new arm -> `learned_cap_reached += 1` (new field) |
| `RunExtension::stop` | util_stats.rs:1639-1655 | fold into the `IterationsExhausted` arm (`\|` pattern) |
| `record_quiet_stretch` row match | util_stats.rs:1820-1824 | row 3; by_end grows to 4 |
| `record_termination` | path.rs:245-279 | no edit (passes `RunEnd` through) |
| exec_plan exit sites | path.rs:384-397, :412-434, :765-781 | as in 2b |
| `RunOutcome` enum | path.rs:206-212 | add `LearnedCapReached { cap, outstanding_events }` |
| `run_row` match | explorer.rs:927-931 | `(*cap, "learned_cap_reached")` |
| `if let Deadlock` | explorer.rs:1070, :1378 | none (non-exhaustive) |
| util_stats internal tests | util_stats.rs:3221+, :3265+ | additive assertions only (section 9) |

Confirmed untouched: `core/exec.rs` (the step-loop bound lives in path.rs, not the interpreter), `history.rs` (`PersistableRun.end_reason` is a plain `&'static str` column, `:108`, Utf8 field `:485`, no enum or constraint), and the linearizability recording path (porcupine has zero references to `end_reason`; grep confirms). Traceanalyzer aggregates `end_reason` into `map[string]int64` (`traceanalyzer/metrics/runs.go:14`, `reader/runs.go:20,:119`) — a new string value is additive-safe. The campaign reward (`Reward::TerminationCompleted` reads `termination.all.plan_complete`, campaign.rs:206) is structurally unaffected; completions the cap forecloses are bounded by the over-cap probe rate, which `run_cap.over_cap_completions` measures.

## 5. Histogram design

Raw 256 saturating u32 cells (timer_budget's `HIST_CELLS`) cannot hold step counts to 6000/10000+. **Decision: per-scope fixed-width bucketing** — `bucket_width = max(1, backup.div_ceil(256))`, kept in the `ScopeAccum` at creation. For backup 6000: width 24 (covers 6144); for 1500: width 6 (covers 1536). Completed-probe lengths are always `< backup` (`is_complete` is checked before the step executes, so `steps <= backup - 1 < 256 * width`), so the last cell never saturates and the timer_budget "saturated cell = unbounded" special case is unnecessary. p99 is read at the winning cell's **upper edge**, so quantization only ever rounds the cap **up** (the safe, conservative direction). Max error: `width - 1` steps at the p99 read — 23 steps for the 6000 scope (0.38% of backup), 5 steps for 1500 — and at most `ceil(1.5 * 23) = 35` steps in the final cap. That resolution cannot coarsely quantize a cap whose engagement threshold is hundreds of steps below backup.

## 6. Risk flags

- **exec.rs / history.rs / event accounting / linearizability: untouched — verified.** The interpreter (`core/exec.rs`) never sees the loop bound; history schema/writer untouched; `begin_run`/`finish_run` pairing preserved because the new exit goes through `record_termination` -> `record_run_termination` -> `finish_run` (util_stats.rs:1578-1594) exactly like `IterationsExhausted`.
- **Porcupine corpus assumptions hold.** A capped run returns `Ok(...)` from `exec_plan`, and `run_single_simulation` then runs the identical tail as an exhausted run: `serialize_history` + `writer.write` + `writer.write_run` (explorer.rs:1086-1099; same for `run_single_plan` at :1388-1401). History rows flush; the run row carries `end_reason = "learned_cap_reached"` and `steps_used = cap`. Porcupine reads call/response pairs and never filters on end_reason.
- **RNG stream isolation.** The learner consumes no RNG; `is_probe` is arithmetic on `run_id`; per-run seeds stay `derive_seed(arm_seed, run_id, SALT)` so no other run's stream is perturbed. Below the floor, every run is bit-identical to baseline (probes run the full backup budget, which *is* the status quo; non-probes get identity cap).
- **Replay (AOS TapeMutate, explorer.rs:1906).** A replayed child's loop bound can differ from its parent's if the learned cap moved between record and replay; the replay then consumes a prefix (or live-extends past) the tape. Mechanically safe, and the same class of within-session nondeterminism as timer_budget changing selection scores mid-session — accepted precedent. Note it in the PR text.
- **`run_plan` path** (explorer.rs:1359) also flows through `exec_plan`, so probe designation and (after 6400+ runs of one plan) capping apply there too; that entry point does not call `reset()` — the timer_budget patch made the same choice, mirror it.
- **Same-seed comparability for grading**: a capped arm's runs above the floor diverge from baseline only in when they stop; this is exactly what the A/A control plus same-seed depth comparison in section 7 measures.

## 7. Grading plan

Lite grader: 300 s chunks, min 2 / max 4 (`research/lite/lite.json`), baseline throughput ~347,880 runs/chunk at 30 threads (`research/lite/baselines/d22321ae599f-30-1497728c-300.json`).

- **A/A drift control first (REQUIRED per the 2026-08-31 finding): do not credit any depth delta before a same-seed base-vs-base chunk pair bounds drift.**
- **Warmup arithmetic (chunk 1 dilution):** probes ~= runs/32 ~= 10.9k/chunk; the 6000 scope collects probes from 4 of 5 arms (~8.7k) at ~28% completion (baseline plan_complete 96,778 / 347,880) -> ~2.4k completed probes/chunk, so the 200-sample floor falls ~8-10% into chunk 1; the 1500 scope (~2.2k probes, lower completion) engages near mid-chunk. Net: the admitted ~12% identity warmup diluting chunk 1; expect chunks 2-4 to carry the effect.
- **utilStats reads per chunk** (leaves in `utilStats.counters` of each chunk record):
  - `termination.all.learned_cap_reached` — firing counter, floor 1000 (note the `all.` segment; the frozen name omits it).
  - `termination.all.iterations_exhausted` — expect its share in 6000-backup scopes to collapse toward the probe share (~1/32) once engaged.
  - `run_cap.probes` ~= runs/32; `run_cap.probe_completions`; `run_cap.over_cap_completions` (small expected; large = conservatism warning, the absorbed variant-3 safety measurement); `run_cap.scopes_learned` (expect 2); `run_cap.current_cap_max_scope` (diagnostic only).
  - Rung: depth>=6 events per explore-second from `metrics.depthAtLeast[6]` and `exposureMs`, +30% to +120% vs same-seed baseline.
- **Falsifier checks:** per-run `depthAtLeast[6]/runs` more than 5% below same-seed baseline in any capped arm (after A/A); rate gain < +30% with cap engaged; `learned_cap_reached == 0` while `run_cap.scopes_learned` shows the 6000 scope past floor (cross-check `probe_completions >= 200`).

## 8. Deviations forced by code reality

- **DEVIATION (naming):** the frozen firing counter `termination.learned_cap_reached` materializes at JSON leaf `termination.all.learned_cap_reached` because `TerminationStats` nests tallies under `all` / `by_recovered_nodes` (util_stats.rs:1561-1565). The grader's flattener exposes the `all.` path; the firing check must read that leaf.
- **DEVIATION (surface):** no new `exec_plan` parameter or plan/config field. The hypothesis left threading open; since `exec_plan` already owns `run_id` and post-overlay `max_iterations`, cap computation and the probe flag live as locals inside `exec_plan` — zero API change, matching where timer_budget hooked.
- **DEVIATION (floor semantics vs precedent):** timer_budget let non-completed runs feed a floor; here exhausted/deadlocked probes feed nothing but the `probes` counter, because the hypothesis pins the floor to *completed* probe samples.
- Minor: `steps_used` for a capped run is recorded as `effective_cap` while `step_budget` stays the backup, so `TerminationTally.step_budget_sum` keeps its configured-budget meaning.

## 9. Test plan

**Unit tests in `run_cap.rs`** (each under `config_override::exclusive_session()`, the session-serialization guard the timer_budget tests used — `config_override.rs:84`):
1. Identity below floor: 199 completed probes -> `effective_cap(6000) == 6000`; the 200th engages it.
2. Quantile with bucketing: 200 completed probes at length 1200 in the 6000 scope (width 24, cell 50, upper edge 1223) -> `effective_cap(6000) == ceil(1.5 * 1223) == 1835`; `effective_cap(1500) == 1500` (scope separation).
3. Over-cap counting: after a cap is engaged, a completed probe longer than the then-current cap bumps `over_cap` (assert via `util_stats::snapshot().run_cap` with stats enabled) and still folds in.
4. Probe-only / outcome filtering: `Exhausted` and `Deadlocked` merges change neither the histogram nor the floor; cap unchanged.
5. Decay drops a scope below the floor back to identity and eventually empties the table; `reset()` empties it.
6. `is_probe`: 0 and 32 true, 1..31 false, negative run_id safe (`rem_euclid`).

**util_stats unit tests** (in-module, near :3221/:3265): `record_quiet_stretch(_, RunEnd::LearnedCapReached)` lands in row 3 and leaves rows 0-2 untouched; `TerminationTally::add` with the new variant increments only `learned_cap_reached`; `RunExtension::stop` on `LearnedCapReached` yields the Budget* classes.

**Existing suites needing edits** (`spur-core/tests/`):
- `util_stats_export_completeness.rs`: `termination_tally` builder (:103-115) and `termination_tally_leaves` (:117-148) gain `learned_cap_reached`; `block_names` destructure/name list (:375-430) gains `run_cap`; add a `RunCapStats` marks-builder + leaves; extend the quiet-stretch builder for the new `learned_cap_reached` vec. The compiler's exhaustive-destructure pattern in this test is what guarantees export completeness — it will fail to build until updated, which is the point.
- `stats_export_parity.rs`: no edit expected (serializes the whole snapshot); run to confirm.
- `timer_effects.rs`: no edit — its 24-run fixture is far below the 6400-run floor, so the learner is identity and probes run the status-quo full budget; behavior is bit-identical. Run to confirm parity.

**Integration-level assertion** (new `spur-core/tests/run_cap_exit.rs`, modeled on the `timer_effects.rs` duckdb-scratch harness): under `exclusive_session`, pre-seed the learner with 200 `merge_probe(backup, Completed, small)` calls to force a tiny cap, then drive `run_single_simulation` directly (not `run_explorer`, which would `reset()` the table) with that backup and a non-probe `run_id`; assert the outcome is `RunOutcome::LearnedCapReached { .. }`, the runs table row has `end_reason == "learned_cap_reached"` with `steps_used` equal to the cap, and the run's history rows flushed — the porcupine-facing guarantee of section 6.

Suggested sequencing: (1) `run_cap.rs` + module registration + unit tests; (2) `RunEnd`/`RunOutcome` plumbing in util_stats.rs, path.rs, explorer.rs (compiler-driven via exhaustive matches); (3) util_stats `run_cap` block + export test updates; (4) session reset/decay hooks; (5) integration test; (6) full `cargo test -p spur-core` and one local explore smoke against `general_vr.json`.

### Critical Files for Implementation
- /home/benaepli/Rust/turnpike/tmp/lite/base/spur/spur-core/src/simulator/path.rs
- /home/benaepli/Rust/turnpike/tmp/lite/base/spur/spur-core/src/simulator/util_stats.rs
- /home/benaepli/Rust/turnpike/tmp/lite/base/spur/spur-core/src/simulator/explorer.rs
- /home/benaepli/Rust/turnpike/tmp/lite/base/spur/spur-core/src/simulator/campaign.rs
- /home/benaepli/Rust/turnpike/research/lite/state/timer-refire-outcome-quantile/untracked/timer_budget.rs (pattern precedent; new file `run_cap.rs` mirrors it)
