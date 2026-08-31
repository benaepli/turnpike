# Implementation Plan: timer-admission-context-odds-probe

Status: awaiting-approval (moderated lane; origin: user). Prediction freezes at
approval. All spur paths below are under `spur/`.

Judge scores at planning time: expectedGain 6, expectedCost 0 (rubric cost —
touches scheduler.rs admission, state.rs read helper, new module; none of
exec.rs / history.rs / event accounting / linearizability recording).

## 1. Hypothesis JSON (frozen prediction)

```json
{
  "id": "timer-admission-context-odds-probe",
  "parent": "timer-refire-outcome-quantile",
  "kind": "add",
  "title": "Steer effective p_timer at queue selection by learned per-context-cell timer acted odds",
  "description": "New module spur-core/src/simulator/timer_context.rs cloned from the run_cap.rs pattern. Runs with run_id % 32 == 16 are steer-off probe runs (disjoint from run_cap's phase-0 probes): they apply no bias and are the only runs that feed the learner, which accumulates per-context-cell (fired, acted) tallies from the existing per-firing acted probe at scheduler.rs's timer_probe resolution site. All other runs are steered: at the queue-selection roll, when the Probabilistic selector is in effect and an eligible timer is queued, effective p_timer is multiplied by clamp(cell_acted_rate / global_acted_rate, 0.25, 4.0) for the head-of-queue eligible timer's context cell. The cell is keyed on structural features of the timer's owner node: pending-deliveries bucket {0, 1-2, 3+} x in-flight-sends bucket {0, 1+} x node-max inert-streak bucket {none, short(1-2), medium(3-7), long(8+)} x recently-restarted bit (incarnation > 0 and entries_since_restart < 8) = 48 cells. A cell engages only past a 200-firing probe floor; the learned global acted rate is the comparison threshold; the 200 floor and the [0.25, 4.0] clamp are the only constants. Steering is scoped to the Probabilistic selector; steps where a Preemptive selector would have been biased are counted in timer_context.steps_excluded_selector. No config field; decay and reset are wired exactly like run_cap.",
  "category": "scheduler",
  "origin": "user",
  "buildsOn": ["run_cap", "timer_effects per-firing acted probe (TimerKey)", "timer_steer contested-step counters"],
  "expectedGain": 6,
  "expectedCost": 0,
  "rationale": "Baseline acted-rate separation across cells is large (with_inflight 0.202 vs idle 0.080; inert-streak none/short/medium/long 0.589/0.312/0.185/0.0099), so which timer firings a run buys differs up to 60x by context. The queue selector spends p_timer uniformly; reallocating it toward high-acted cells and away from long-streak dead cells buys more state-changing timer work per step without changing timer volume knobs or any config.",
  "generalityArgument": "The cell features (pending deliveries, in-flight sends, inert streaks, restart recency) are protocol-agnostic structural properties of any node in any spec; the learner is self-calibrating against the session's own global acted rate, with no protocol-specific constant.",
  "prediction": {
    "firingCounter": "timer_context.biased_steps",
    "firingFloor": 50000,
    "rung": "depth>=6",
    "sizePct": { "min": 0.02, "max": 0.06 },
    "mechanism": "Contested steps (~548M/chunk) are the only steps the lever touches, and ~92% of timer firings happen at uncontested steps; within that authority, promoting high-acted cells (clamp x4 lifts stock p_timer 0.03 toward 0.12) and suppressing long-streak cells (x0.25, reaching ~6-8% of firing mass at contested steps) shifts timer admissions toward firings that change node state, raising productive interleavings per run and thus depth>=6 per explore-second.",
    "independentObservable": "timer_context.probe_acted/probe_firings (unsteered acted rate) stays near baseline while pooled timer_effects.all.acted_fraction (dominated by steered runs) rises; timer_effects.inert_streak.long.fired share falls in steered chunks.",
    "falsifier": "Graded against a SAME-SESSION A/A drift-controlled null band (baseline-vs-baseline chunks run in the same session window, because baseline caches go stale ~3%/hour on this host). Falsified if the depth>=6 rate improvement over that drift-controlled A/A floor is < +2% with timer_context.biased_steps >= 50000 pooled over the session's chunks. Closed without a rate read if biased_steps stays below 50000, or if the timer_context.cells_engaged gauge is < 2 at the end of chunk 2 (the mechanism never had two distinguishable contexts, so no reallocation was possible)."
  },
  "notes": "Band honesty: the proposer drafted +2..10%; trimmed to +2..6% because the lever is promotion-only at contested steps (~8% of firing mass) and suppression reaches only ~6-8% of mass despite ~71% of firings sitting in clamp-floor long-streak cells. Per-run P(depth>=6) preservation is read POOLED across all arms only, never per-arm (aos d>=6 swings to 0.49 under null at chunk scale)."
}
```

Band reasoning: timer wins are ~17.8M of ~548M contested steps per chunk, and
only ~8% of firings are at steps the roll can move; the acted-rate separation
is large enough that a few percent on the rung is plausible, but +10% would
require authority the contested-step census says the lever does not have. The
falsifier floor (+2%) equals the band minimum, so the band is refutable on
both sides.

## 2. Files and mechanisms, function by function

### 2.1 New: `spur-core/src/simulator/timer_context.rs`

Register in `spur-core/src/simulator.rs` beside `pub mod run_cap;` (line 13).
Module layout, mirroring run_cap.rs:

- Constants:
  - `pub const PROBE_PHASE: i64 = 16;` — comment that this reuses
    `run_cap::PROBE_PERIOD` (32) so phase-16 is structurally disjoint from
    run_cap's phase-0 probes, plus a code comment noting the grid
    interleaved-mode phase-aliasing artifact: gcd(32, 54) = 2, so with 54
    interleaved configs some configs see phase-16 at half/double the average
    rate; campaign mode is unaffected (run_ids come from one shared atomic,
    campaign.rs `ctx.run_counter.fetch_add`).
  - `const MIN_CELL_SAMPLES: u64 = 200;`
  - `const CLAMP_LO: f64 = 0.25; const CLAMP_HI: f64 = 4.0;`
  - `const CELLS: usize = 48;`
- `#[derive(Clone, Copy, PartialEq, Eq)] pub enum RunMode { Probe, Steered }`
  and `pub fn run_mode(run_id: i64) -> RunMode` — Probe iff
  `run_id.rem_euclid(run_cap::PROBE_PERIOD) == PROBE_PHASE`.
- `#[derive(Clone, Copy)] pub struct CellKey(u8)` (index 0..48) with
  constructor
  `pub fn cell_key(pending_deliveries: usize, in_flight_sends: u32, node_max_inert_streak: u32, recently_restarted: bool) -> CellKey`.
  Bucketing: pending {0 -> 0, 1..=2 -> 1, _ -> 2}; in_flight {0 -> 0, _ -> 1};
  streak reusing TimerKey's edges {0 -> 0, 1..=2 -> 1, 3..=7 -> 2, _ -> 3}
  (util_stats.rs:244-249); restarted bit. Index =
  `pending*16 + inflight*8 + streak*2 + restarted`. Bucket edges are
  structural mirrors of the existing `TimerKey` bucketing, not tuned
  constants; the only tunables are the 200 floor and the clamp.
- Table: `static CELL_FIRED: [AtomicU64; CELLS]`,
  `static CELL_ACTED: [AtomicU64; CELLS]`, plus `static GLOBAL_FIRED` /
  `GLOBAL_ACTED` (dedicated globals so the per-roll read is 4 relaxed loads,
  not a 48-cell sum). Atomics rather than run_cap's DashMap because the read
  side sits on the per-step hot path; decay runs between batches (no run in
  flight, explorer.rs:2291-2292) so load/store scaling on atomics is
  race-free in practice.
- Learn API: `pub fn record_firing(cell: CellKey, acted: bool)` — bumps cell
  + global tallies and `util_stats::record_timer_context_probe(acted)`; when
  the cell's fired count crosses `MIN_CELL_SAMPLES`, recomputes and publishes
  the `cells_engaged` gauge (crossing-only recompute keeps the hot path
  cheap; this merges per firing, unlike run_cap's per-run merge).
- Bias API: `pub fn multiplier(cell: CellKey) -> Option<f64>` — `None` if
  `cell_fired < MIN_CELL_SAMPLES` or `GLOBAL_FIRED == 0` or
  `GLOBAL_ACTED == 0`; else
  `Some(((cell_acted/cell_fired) / (global_acted/global_fired)).clamp(CLAMP_LO, CLAMP_HI))`.
  Pure read, no locks, no rng.
- `pub fn decay(factor: f64)` — scale every cell and the globals by the
  clamped factor (floor semantics like run_cap.rs:134-145), then
  `publish_gauges()`.
- `pub fn reset()` — zero everything,
  `util_stats::set_timer_context_cells_engaged(0)`.
- `fn publish_gauges()` — count cells with `fired >= MIN_CELL_SAMPLES`,
  publish via `util_stats::set_timer_context_cells_engaged(n)`.
- Engagement-guard simplification (stated choice): no binomial confidence
  band on cell rates. At ~7M probe cell-samples per chunk a 95% band is
  decorative; the 200-firing floor plus the between-batch decay are the real
  controls, exactly as in run_cap.

### 2.2 `spur-core/src/simulator/core/queue_selector.rs`

- Extend the `QueueSelector` trait with two defaulted methods (no rewrite of
  `AnySelector`'s API, existing impls untouched):
  `fn supports_timer_bias(&self) -> bool { false }` and
  `fn select_timer_biased(&mut self, info, _timer_bias: f64, rng) -> Option<QueueSelection> { self.select(info, rng) }`.
- `ProbabilisticSelector`: `supports_timer_bias() -> true`;
  `select_timer_biased` is a copy of `select` (lines 94-107) with one change:
  `let p_timer_eff = (self.p_timer * timer_bias).min((1.0 - self.p_local).max(0.0));`
  and thresholds `roll < p_local` / `roll < p_local + p_timer_eff`. Exactly
  one `rng.random()` draw, same as `select`; `p_local` untouched;
  suppression gives freed mass to network, promotion takes it from network.
  The `min(1.0 - p_local)` guard matters for aos-sampled arms (p_local up to
  0.95, p_timer up to 0.2 at explorer.rs:629-634; 0.2 * 4.0 would otherwise
  overflow the unit interval).
- `PreemptiveSelector`: no override (default = unbiased `select`); its
  p_timer check is a different path (line 124), out of scope per the (d)
  decision.
- `AnySelector`: `supports_timer_bias()` returns
  `matches!(self, AnySelector::Probabilistic(_))`; `select_timer_biased`
  dispatches Probabilistic to the biased method, Preemptive to plain
  `select`.

### 2.3 `spur-core/src/simulator/core/scheduler.rs`

Two touch points inside `schedule_runnable` (line 690), plus a signature
change:

- Signature: add one parameter `timer_ctx_mode: timer_context::RunMode`
  (after `partial_fanout_crash_bias`, matching how that flag was threaded).
  Single caller: path.rs:584. Chosen over a thread-local because it is
  explicit, testable, and the codebase already threads per-run knobs this
  way.
- Bias entry: between `route_by_terms` (line 848) and the `selector.select`
  call (line 852), only on the `routed == None` arm so a term-routed step is
  never double-steered — see section 3 for the exact logic. Borrow note:
  compute everything into a local `Option<f64>` before the selector call;
  the reads (`state.timer_queue`, `state.pending_deliveries_to`,
  `state.send_ledger`, streaks, incarnation) are all `&self` methods on
  `state`, and the selector call does not borrow `state` — use owned locals
  only, hold no reference into `state` across the call.
- Probe learning hook: extend the existing `timer_probe` closure (lines
  1114-1123) to also capture the cell:

  ```rust
  let timer_probe = (util_stats::acted_fraction_enabled() && timer_entry).then(|| {
      let pending = state.pending_deliveries_to(record_dest);          // count, not bool
      let inflight = pending > 0;
      let key = util_stats::TimerKey::new(...);                        // unchanged
      let ledger = state.send_ledger.get(record_dest.index).copied().unwrap_or_default();
      let cell = timer_context::cell_key(
          pending,
          ledger.in_flight,
          state.max_timer_inert_streak(record_dest.index),
          state.incarnation(record_dest) > 0
              && state.entries_since_restart(record_dest.index) < 8,
      );
      (r.pc, key, inflight, cell, state.node_state_token(record_dest))
  });
  ```

  and at the resolution site (lines 1145-1148), after
  `util_stats::record_timer(key, acted)`:

  ```rust
  if timer_ctx_mode == timer_context::RunMode::Probe {
      timer_context::record_firing(cell, acted);
  }
  ```

  Only phase-16 runs feed the learner, so learned rates are steer-free by
  construction. Learning piggybacks on the `acted_fraction_enabled` gate
  exactly like the existing probe; general_vr.json already sets
  `emit_acted_fraction: true` (line 63). Document this requirement in the
  module header.

### 2.4 `spur-core/src/simulator/core/state.rs`

One read-only helper. Needed because `Timer.pc` is the SetTimer continuation
(exec.rs:256) while the streak table `timer_inert_streaks` is keyed by the
woken reader's pc via `note_timer_effect` — the two vertices differ in
general, so a per-vertex lookup keyed by `Timer.pc` at the decision point
would systematically read 0:

```rust
/// The node's largest current consecutive inert-firing streak across vertices.
pub fn max_timer_inert_streak(&self, node: usize) -> u32 {
    self.timer_inert_streaks.iter()
        .filter(|(n, _, _)| *n == node)
        .map(|(_, _, s)| *s).max().unwrap_or(0)
}
```

The cell's streak feature is node-max at BOTH the decision point and the
learning site, so the two sites key identically by construction.
`timer_inert_streaks` and `send_ledger` are `signature()`-excluded
(state.rs:583-592), so neither reading them nor steering on them can perturb
deduplication. No other state.rs change.

### 2.5 `spur-core/src/simulator/path.rs`

In `exec_plan` (line 285), beside the run_cap designation (lines 305-310):
`let timer_ctx_mode = timer_context::run_mode(run_id);`, passed to the
`schedule_runnable` call at line 584. Nothing at the merge_probe sites
(408/445/813) — timer_context learns per firing inside the scheduler, not
per run outcome.

### 2.6 `spur-core/src/simulator/util_stats.rs`

New block beside run_cap's (statics near line 277, record fns near
1861-1885, struct near 2713, snapshot field near 2759):

```rust
#[derive(Serialize)]
pub struct TimerContextStats {
    pub probe_firings: u64,            // firings folded into the learner (phase-16 runs only)
    pub probe_acted: u64,              // the subset that changed node state
    pub biased_steps: u64,             // steered-run selector rolls where an engaged cell's multiplier was applied
    pub biased_steps_promoted: u64,    // multiplier > 1.0
    pub biased_steps_suppressed: u64,  // multiplier < 1.0
    pub steps_excluded_selector: u64,  // engaged-cell opportunity on a non-Probabilistic selector
    pub cells_engaged: u64,            // gauge: cells at/above the 200-firing floor
}
```

Functions: `record_timer_context_probe(acted: bool)`,
`record_timer_context_bias(multiplier: f64)` (increments biased_steps and
the promoted/suppressed split), `record_timer_context_excluded()` — all
gated on `enabled()` like the neighbors;
`set_timer_context_cells_engaged(u64)` ungated, gauge semantics identical to
`set_run_cap_learned` (util_stats.rs:1880-1885). Add
`timer_context: TimerContextStats` to `UtilizationSnapshot` (line 2735) and
to `snapshot()`. All integer fields, so the delta/add campaign attribution
path (2779-2825) carries them; `cells_engaged` is a gauge and must be read
from raw per-chunk snapshots, not deltas (same caveat as
`run_cap.current_cap_max_scope`). Add the new statics to the `set_enabled`
reset list.

### 2.7 `spur-core/src/simulator/explorer.rs` and `campaign.rs`

- Decay: `timer_context::decay(self.decay_factor);` beside
  `run_cap::decay(...)` at explorer.rs:2295 (inside the
  `decay_factor < 1.0` guard — same no-run-in-flight safety argument).
- Resets: `timer_context::reset();` beside every `run_cap::reset()`:
  explorer.rs:1138, 1531, 1969, 2618 and campaign.rs:835.
- No change to `SingleRunConfig::random` (explorer.rs:616-636): aos arms
  keep sampling ~20% Preemptive; those runs hit the exclusion counter.

### 2.8 `spur-core/tests/util_stats_export_completeness.rs`

Mirror the run_cap extension: add a `timer_context` marker fn and
`timer_context_leaves`; mark it in `marked_snapshot()` (line 515) and add
`"timer_context"` to the block loop at line 557 and to `block_names` (the
rest-pattern-free destructure at line 405 forces this at compile time).
`TimerContextStats` needs public fields constructible from the test — follow
`RunCapStats`' visibility exactly.

## 3. How the bias enters the roll, concretely

At scheduler.rs, replacing lines 850-859's selector arm:

```rust
let selection = match routed {
    Some(s) => s,
    None => {
        // Steer-off probe runs and empty timer queues take the stock roll.
        let bias: Option<f64> = (timer_ctx_mode == timer_context::RunMode::Steered
            && info.timer_queue_size > 0)
            .then(|| { /* head-of-queue eligible timer -> features -> cell */
                       timer_context::multiplier(cell) })
            .flatten();
        let picked = match bias {
            Some(m) if selector.supports_timer_bias() => {
                util_stats::record_timer_context_bias(m);
                selector.select_timer_biased(&info, m, rng)
            }
            Some(_) => {
                util_stats::record_timer_context_excluded();
                selector.select(&info, rng)
            }
            None => selector.select(&info, rng),
        };
        match picked { Some(s) => s, None => { record_unscheduled(&audit); return Ok(ScheduleResult::None); } }
    }
};
```

(`rng.use_stream(Stream::QueueChoice)` at line 849 stays exactly where it
is, before this block; the feature reads use no rng.)

The (d) decision: steering is scoped to the Probabilistic selector.
`PreemptiveSelector` consults p_timer on a structurally different path (an
unconditional pre-check at queue_selector.rs:124, before local-queue
affinity), so a multiplicative bias there has different semantics (it gates
preemption frequency, not a three-way allocation); aos arms sample
Preemptive for only ~20% of runs (explorer.rs:617-627) while the grid arms
are stock Probabilistic (general_vr.json has no `queue_policy` key; default
`{p_local: 0.80, p_timer: 0.03}` at queue_selector.rs:184-191). Every step
where an engaged cell produced a multiplier but the selector was not
Probabilistic counts in `timer_context.steps_excluded_selector`, so the
exclusion is measurable per chunk rather than silent. Steps routed by
`route_by_terms` bypass the roll entirely and are neither biased nor
counted.

The biased Probabilistic roll makes exactly the same rng draws as the stock
roll (one `rng.random::<f64>()`, then `try_select`/`pick_local` unchanged);
only the comparison thresholds move. No new draw, no new stream.

## 4. Which timer's cell is read at the decision point

Head-of-queue: the first eligible `Runnable::Timer` in `state.timer_queue`
Vec order, applying the same eligibility predicate the `timer_queue_size`
count already uses (strict_timers label check at lines 810-829 plus
`is_ineligible`), skipping any non-Timer entry defensively. From it take
`t.node`, then read the four features for that node.

Justification: the timer queue is short and typically holds at most one
eligible timer per node in the specs this loop runs, so the head's context
is the whole queue's context in the dominant case, and an aggregate would
blur 48-cell resolution for no measured benefit. Risk noted in section 8:
when multiple queued timers have different owners, the bias reflects the
head timer's context while within-queue selection (tournament/proportional,
lines 934-943) may then pick a different timer.

## 5. Config surface

None. No new config field, no change to any `scheduler_configs/**` file, no
envelope flag. The mechanism is always-on in steered runs, self-disabling
below the 200-firing floor, steer-off in phase-16 probes, observable purely
through the new utilStats block. Operational dependency, not config:
learning requires the session's existing `emit_acted_fraction: true`, which
general_vr.json already sets.

## 6. Firing counter and what "fired" means

- `timer_context.biased_steps` >= 50000, pooled over the session's chunks
  (sum of per-chunk deltas). One count = one steered-run Probabilistic
  selector roll that actually applied an engaged cell's multiplier to
  p_timer. Rolls with no eligible timer, probe-16 rolls, under-floor cells,
  term-routed steps, and Preemptive-selector steps do not count.
- `timer_context.cells_engaged` — exported gauge (admission condition (b)):
  cells at/above the 200-firing floor; read from the raw chunk snapshot.
  The "cells_engaged < 2 at end of chunk 2" close clause reads this
  directly.
- `timer_context.steps_excluded_selector` — the (d) exclusion tally,
  expected nonzero only in aos arms.

## 7. Predicted observables beyond the rung

Per chunk, from the utilization block:

- `timer_context.probe_acted / probe_firings` — the unsteered (phase-16)
  acted rate; should sit near the baseline ~0.08 pooled rate and stay flat
  across chunks (the control for the next line).
- `timer_effects.all.acted_fraction` (pooled, dominated 31:1 by steered
  runs) — predicted to rise above the probe-only rate as cells engage; the
  steered-vs-probe comparison is exactly these two numbers.
- `timer_effects.inert_streak.long.fired` share of `timer_effects.all.fired`
  — predicted to fall (suppression of long-streak cells), bounded by the
  ~6-8%-of-mass authority.
- `timer_steer.raised / evaluated` (scheduler.rs:955-957,
  util_stats.rs:2296-2325) — contested-step timer-win share (~17.8M/548M
  baseline) should move up in promoted contexts; direction up, magnitude
  small.
- `run_cap.probes / probe_completions` and `run_cap.current_cap_max_scope` —
  diagnostic per admission condition (c), see section 9.
- `timer_context.biased_steps_promoted` vs `biased_steps_suppressed` — which
  side of the clamp carries the effect (baseline separation predicts
  suppression-dominant by mass, promotion-dominant by per-step delta).

## 8. Risk flags

- Files it must not touch, and does not: `core/exec.rs` (read to confirm
  Timer.pc semantics; no edit), `history.rs`, event accounting,
  linearizability recording, `state.rs` `signature()`. The one state.rs
  addition is a `&self` read helper; every feature read is
  signature-excluded state (state.rs:583-592), so dedup and history hashing
  are untouchable by construction.
- Run-cap coupling (admission condition (c)): run_cap's phase-0 probes are
  steered runs here (0 != 16), so the learned step cap tracks the steered
  population's completed lengths — intended, but steering can move
  `run_cap.current_cap_max_scope`, which moves depth/s for cap reasons;
  graded per section 9's diagnostic. Conversely, phase-16 timer-context
  probes run under the learned cap (they are not run_cap probes);
  truncation is harmless to the learner because it learns per firing, not
  per run outcome.
- RNG determinism: the bias adjusts thresholds applied to the existing
  single QueueChoice-stream draw; no new draws, no conditional draw counts.
  Trajectories still diverge from baseline (that is the mechanism), and a
  steered run's trajectory depends on session-global learned state: exact
  re-execution from seed/tape (RecRng record-and-replay explorer.rs:1018,
  AOS Mode B at 1909) will diverge if the table differs at replay time —
  the same accepted nondeterminism class as run_cap's `effective_cap`.
  Phase-16 probe runs remain exactly reproducible.
- Probe-phase interaction: phase 16 vs run_cap's phase 0 are disjoint by
  `rem_euclid` on the same period constant, enforced by a unit test. Grid
  interleaved mode's gcd(32,54)=2 aliasing gets a code comment only.
- Head-of-queue proxy: the biased roll may admit a different timer than the
  one whose cell set the multiplier (within-queue tournament picks by
  score); acceptable because queues are short — dilutes the effect rather
  than inverting it.
- Decision-point vs learning-site skew: the learner reads features when the
  woken record executes (scheduler.rs:1113-1148), the bias reads them at
  admission; the woken record usually runs within a few steps (local queue
  under p_local 0.80), and both sites use identical feature definitions
  including the node-max streak helper, so the skew blurs cells slightly
  rather than mis-keying them.
- Per-step cost: one `pending_deliveries_to` scan (O(network_queue +
  purgatory)) plus O(timer_queue) head lookup and four relaxed atomic
  loads, only on steered steps with an eligible timer under a Probabilistic
  selector. The QueueInfo build already does same-order scans (lines
  831-840). Verified via the A/A throughput comparison; if A/A shows a
  throughput regression, that is a harness finding, not a graded effect.
- Learning volume: ~223.6M firings/chunk / 32 = ~7M probe firings/chunk
  across 48 cells — floors engage in the first chunk for all populated
  cells; `cells_engaged` confirms.

## 9. Grading plan

- Rungs: primary `depth>=6` (frozen); watch `depth>=5` and `depth>=7` for
  consistency; throughput as the cost guard.
- Chunks: minChunks 2, maxChunks 4, sequential decision rules as the lite
  grader defines.
- Same-session A/A control (admission condition (a)): in the same session
  window as the treatment chunks, run baseline-vs-baseline chunk pairs to
  measure the drift null band — a cross-session baseline is not a valid
  null (~3%/hour drift). The falsifier band is treatment-vs-baseline
  improvement measured against that same-session A/A band plus the +2%
  floor.
- run_cap trajectory diagnostic (admission condition (c)): each chunk,
  record `run_cap.current_cap_max_scope` and `run_cap.scopes_learned` from
  raw snapshots for both treatment and A/A control. If the treatment's cap
  trajectory diverges from the control's, report the depth/s comparison
  both raw and normalized by steps actually spent
  (`termination.all.steps_used_sum`), and do not attribute cap-driven
  depth/s movement to steering.
- Operator reads per chunk (deltas unless marked gauge):
  `timer_context.{biased_steps, biased_steps_promoted,
  biased_steps_suppressed, steps_excluded_selector, probe_firings,
  probe_acted}`; `timer_context.cells_engaged` (gauge) — close check after
  chunk 2; `timer_effects.all.{fired, acted}` and
  `timer_effects.inert_streak.long.fired`; `timer_steer.{evaluated,
  raised}`; `run_cap.{current_cap_max_scope (gauge), scopes_learned
  (gauge), probes, probe_completions}`; `termination.all.steps_used_sum`.
- Firing gate first: if pooled `biased_steps` < 50000 or `cells_engaged` <
  2 at end of chunk 2, close without reading a rate.
- Per-run P(depth>=6) preservation clause: read POOLED across all arms
  against the same-session A/A calibration; never per-arm.

## 10. Test plan

- Unit tests in `timer_context.rs` (`config_override::exclusive_session()`
  + `reset()` bracketing like run_cap.rs:168-274):
  - Floor: 199 firings in one cell yield `multiplier == None`; the 200th
    engages it.
  - Ratio and clamp: cell far above/below global rate returns 4.0 / 0.25; a
    cell at the global rate returns ~1.0; zero global acted returns None.
  - Decay: an engaged cell drops under the floor after `decay(0.5)` and
    disengages; repeated decay empties; `reset()` empties and zeroes the
    gauge (with `util_stats::set_enabled(true)` where counters are
    asserted).
  - Phase disjointness: for all phases 0..32,
    `!(run_mode(id) == Probe && run_cap::is_probe(id))`; `run_mode(16)` and
    `run_mode(48)` are Probe; negative ids via rem_euclid.
  - Gauge: crossing the floor in cell A then cell B moves
    `snapshot().timer_context.cells_engaged` 0 -> 1 -> 2.
- Unit tests in `queue_selector.rs` (deterministic rng): (a) bias 1.0
  matches `select` for identical rng state; (b) draw-count parity between
  paths; (c) bias 4.0 at stock 0.80/0.03 gives timer frequency ~0.12, bias
  0.25 gives ~0.0075; (d) the `1.0 - p_local` cap holds for p_local 0.95,
  p_timer 0.2, bias 4.0.
- Export completeness: the extended
  `tests/util_stats_export_completeness.rs` (section 2.8).
- Scheduler-level sanity (optional, cheap): with `RunMode::Probe`,
  `biased_steps` stays 0 while `probe_firings` moves; with
  `RunMode::Steered` and an empty table, selection matches stock.
- Full check: `cargo test -p spur-core`, plus
  `cargo test -p spur-core --test util_stats_export_completeness`
  explicitly.

Implementation order: state.rs helper -> timer_context.rs with unit tests ->
queue_selector.rs trait methods with tests -> util_stats.rs block ->
scheduler.rs (signature, bias site, learn hook) -> path.rs threading ->
explorer.rs/campaign.rs decay+reset wiring -> export-completeness test ->
full test run.
