# Symbolic Time: Online Integration Plan

Line numbers refer to the main checkout unless the path starts with
`.claude/worktrees/symtime`, which is the unmerged experiment (superproject
branch `research/symtime` at 59b0a13, `spur` branch
`experiment/time-constraints`). What the experiment measured is in its
`docs/current-plans/symbolic-time-findings.md`, cited below as "findings".
Nothing in this plan has been built or run online. Every number below is an
offline measurement: a recorded concrete run replayed through the solver, one
thread, solver time over the run's own execution time.

## 1. Context, goal, non-goals

**Context.** The experiment established five things:

- The constraints are not always two-point. Lease specs are, but a fixture of
  ordinary idioms has 39% of comparisons outside that form, and the harder
  fixtures 30% to 55% (findings, "The simplex across spec shapes", "Three
  harder fixtures"). The solver has to be a general LP.
- A general exact simplex written for this is fast enough on every realistic
  shape. On the five panel-derived datasets and `forms` it adds 9% to 25% to a
  run under every policy, with a p99 at half a run or less, and it agrees
  with Z3 on every comparison of 14 checked cells.
- On the three synthetic fixtures built to break it (`webs`, `chains`,
  `crossclock`), the exact solver alone costs 2.5 to 8.1 times the run, and
  crossclock outgrows 128-bit numbers in 7 of 400 runs with durations open.
  A policy is needed there; section 3 names the one measured best.
- A solved timeline with a floor margin survived integer ticks in 100% of
  60,000 runs, and 600 of 600 rewritten artifacts replayed. That was measured
  on the difference-constraint path only; the general-LP witness is untested.
- Reach was not shown: offline, no single comparison outcome was rare under
  concrete sampling (rarest taken in 24.6% of runs). Conjunctions across
  nodes were not measurable offline.

**Goal.**

- Online use inside the explorer: add `TimeMode::Symbolic` to the simulator,
  where a time comparison is decided by a branch chooser and checked by the
  solver, and leave `TimeMode::Concrete` untouched.
- One solver library. The offline driver is a measurement and regression
  harness, never a product path.
- Measure reach online at an early go/no-go, before any learner work.

**Non-goals.**

- No external solver at runtime. Z3 is a reference in the offline harness
  only; nothing under `spur/` links it.
- No special-purpose difference-constraint solver.
- No arbitrary-precision arithmetic. Past 128 bits a run concedes the rest of
  its comparisons to concrete time (4.7).
- No row budget and no other mechanism that fixes finished columns (3.3).
- No symbolic rates. Durations and rates open together multiply two unknowns.
- No scale anchor: it changes exact answers on any run with an absolute
  constant (177 of 32,020 on idioms).
- No refinement types and no static shape analysis of time values.
- No change to Concrete output bytes or cost.
- No liveness or fairness claims, no machine-reboot epochs, no bounded-delay
  assumption (`docs/current-plans/time-handling.md:629-634` keeps it
  deferred).

**One deviation from the existing doc.** `time-handling.md:615-624` says to
pilot symbolic TrueTime endpoints first. This plan does event times first,
because no spec in the repo uses `tt_now`. That section should point here.

## 2. What the code makes awkward

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| A1 | `time::evaluate` cannot reach the solver or a choice generator. It takes `(op, left, right)` and is called from two pure evaluators. | `spur/spur-core/src/simulator/core/time.rs:82-150`, `core/eval.rs:293-297`, `core/compiled_eval.rs:141-145` | Keep the engine in `State` and set a scoped thread-local pointer for the length of one record execution, read only on the symbolic slow path. Hoisting comparisons into statement-level ops would evaluate operands that short-circuiting skips, such as `x != nil && now < x!`. |
| A2 | A timed timer is always fireable by feasibility: a fire creates a fresh time unknown bounded only from below. | Offline, fires never failed (findings, H3). | A fire is a requirement with no trial. What is missing is a priority; see 4.5. |
| A3 | The experiment gave every observation and fire its own unknown. The concrete engine gives every read in one scheduler step the same `T`. | `.claude/worktrees/symtime/research/symtime/src/model.rs:102-107, 355-360`; `time-handling.md:314-317` | Online uses one unknown per step, created at the step's first time event. The offline harness must use the same model, which needs a step marker in the record. |
| A4 | `TimeValue` derives `Eq/Hash/Ord`, and the value feeds `Value.sig` and map keys. | `core/time.rs:16-21`, `core/values.rs:231, 591, 666` | A concrete value must hash exactly as today, or Concrete output changes. |
| A5 | Rows are written before the linearizability check runs, the check is asynchronous in a pool, and learner tables are process statics. | `linearizability/pool.rs:373` inside `write_finished` (349-415). Statics: `run_cap.rs:109`, `stall_cap.rs:108`, `fault_timing.rs:160`, `arm_selector.rs:378`. | A symbolic violation is a candidate until a concrete replay confirms it, and an in-process replay must not write to the session's statics. |
| A6 | Online, the explorer draws an outcome before asking the solver. It never learns whether an outcome it did not draw was open. | The draw policy (findings, "Draw, then verify") leaves 13% to 42% of comparisons unasked. | Online reports count draws, taken flips and refused flips, not both-open shares. The both-open share is measured only by a `trials: "all"` arm or by the audit (4.9). |
| A7 | Offline, a run that overflowed is played again from a copy in a wider tier, and a run that conceded is played once more with a different search, keeping whichever answered more. | `simplex.rs:4162-4263` (`play_within`, `play_once`) | Online, a widening replays the engine's own log from its last copy, taking recorded outcomes only; answers already acted on are fixed. The second play is not available online. |
| A8 | The recommended cap is on time, and wall time is not deterministic. | `main.rs:691-696` caps by the recorded wall time. | Online the cap needs a deterministic measure (4.7, D4). |
| A9 | `Script::recording` is on only when `record_replay` is set. | `explorer.rs:1278` | Symbolic mode needs the run's actions for every run to build a witness. Keep them in memory; do not write them to disk. |
| A10 | `rates: sampled` gives denominators up to 1e6. | `clock.rs:28, 149` | Numbers outgrow 64 and 128 bits sooner than under `extremes`; the products of rates in cross-clock comparisons are what grows (findings, "Falling back to concrete time"). Validate on `extremes` first. |
| A11 | With no `Advance` action, a symbolic run uses fewer steps. Step caps, purgatory holds and learned caps are counted in steps. | `path.rs:700-749`; `advance_weight` 0.25 at `clock.rs:99` | Compare modes per wall-second and per run, not per step. |
| A12 | `sample_timing` already fixes the first field to one before integer scaling. | `timing.rs:58-67` | Affects only sampled durations; no conflict with "no anchor" for open ones. |

## 3. The solver being integrated

### 3.1 What it is

`research/symtime/src/simplex.rs`, `num.rs` and `linear.rs` on the experiment
branch. It is ported, not rewritten.

- **Method.** An incremental bounded-variable simplex (the general simplex of
  Dutertre and de Moura). Every row defines a slack; a constraint is a bound
  on its slack; a check pivots until every basic unknown is inside its bounds
  or a row proves it cannot be. A strict bound is carried as a value plus an
  infinitesimal (`D<N>`). Withdrawing a trial restores bounds only; the
  tableau and assignment stay, which is what makes the next trial cheap.
- **Numbers.** Rows are whole numbers over one positive denominator, so a
  pivot is two multiplications and an addition per entry; a row is brought
  to lowest terms only when its denominator grows large. Tiers:
  `R` (64-bit rationals), `H` (128-bit values over 64-bit rows), `W` (128-bit
  throughout). Every operation is checked; overflow raises a thread-local
  flag. Copies of the solver state are taken at pivot counts spaced further
  apart as a run grows, and a widening resumes from the last copy. Past `W`
  the run concedes (4.7). A fourth type `F` (`f64`, relative tolerance 1e-7,
  a check that passes 4,096 pivots gives the run up) runs the same generic
  code; `--backend float` in the harness.
- **Durations as parameters.** Named durations are frozen columns that never
  enter the basis. A trial first probes with them held; when that fails, the
  row that could not be repaired yields a cut over the durations alone. New
  duration values come from a line search along the newest cut, then from a
  small LP over the durations started from their present values, snapped to a
  grid of halves when that meets every cut. An outcome is open when some
  duration values let the probe reach it, closed when no values meet the
  cuts. The answer does not depend on where values are chosen, only the cost.
- **History handling.** Dead unknowns are eliminated as soon as they can be;
  a new time enters the basis through its ordering row (the gap stays
  outside, rows of at most 96 entries); a time's row mentions the time before
  it by reference once that row has 16 entries (`by_reference`); a finished
  time whose accepted rows all let it move one way is glued to its neighbour
  (`linear.rs` `Step::Glue`, 48% of times on chains). A taken outcome that is
  already implied adds no row.
- **Choice rules.** Entering unknown: the least harmful of the four cheapest
  candidates, a mild preference for unit pivots. Cycle guard: a hash of the
  basis; on a repeat, seeded random entering choices, smallest index as last
  resort. Nothing reads a clock; a run pivots the same way every time.
- **Two tableaus.** A run that shows 8 conflicts between costly trials (16
  pivots or more) of different comparisons keeps a second tableau; every
  accepted row goes into both, and a conflicting comparison's trials move to
  the other. A trial that would have to move the durations first asks every
  tableau without moving (probe-everywhere); 22% to 26% of such trials are
  answered there.
- **Allocation.** Row and column buffers are pooled per thread between runs.

### 3.2 Recommended online configuration

Exact arithmetic, draw-then-verify, and a per-run cap at 5 times the run's own
cost.

**Decided in phase 5 (D2): exact online; float stays in the offline
harness.** Online, a float answer the run acts on must be made sure of
exactly, and the only way that held was an exact engine beside the float one
accepting every row the run accepts. That exact engine alone costs about
what exact arithmetic costs, so float plus its certificate cost more than
exact on every dataset measured: with durations open and no cap, engine time
over the run's own concrete time was 0.30 (certify every taken flip) and
0.27 (accept drawn flips exactly) against 0.06 for exact on the clean spec,
and 4.1 to 4.2 against 2.6 on idioms (`research/symtime/results/phase5`).
The offline float figures below are kept as what they measured: float with
no certificate.

- **Draw-then-verify.** The chooser draws an outcome first. If the current
  assignment already witnesses it, it is accepted with no trial. If not, the
  trial of that outcome is also its accept: it either succeeds and the run
  takes it, or fails, the bounds are restored, and the run takes the
  witnessed outcome, which the failure has just shown to be implied.
- **Float.** 1.5 to 2.2 times faster than exact on the synthetic fixtures; up
  to 13% slower on cheap ones.
- **Cap.** When solver cost passes 5 times the run's own cost, the rest of
  the run is conceded to concrete time.

Solver time over the run's own time, durations open (findings, "The policies
across every spec, against the run's own time", and the capped reading after
it):

| Spec | Exact alone | Exact + draw | Float + draw + cap 5x | Unasked under draw |
|---|---|---|---|---|
| clean | 0.09 | 0.09 | 0.10 | 27% |
| receipt anchor | 0.09 | 0.09 | 0.11 | 34% |
| cached flag | 0.13 | 0.12 | 0.14 | 37% |
| long | 0.09 | 0.09 | 0.10 | 13% |
| forms | 0.25 | 0.22 | 0.23 | 24% |
| idioms | 0.89 | 0.67 | 0.58 | 37% |
| webs | 2.52 | 1.70 | 0.89 | 40% |
| chains | 3.69 | 4.03 | 2.23 | 41% |
| crossclock | 8.13 | 5.71 | 2.18 | 41% |

- On the panel specs no policy is needed: exact alone costs 9% to 25%.
- The cap moves the averages little and cuts the worst run from 9.5 to 6.0
  times on chains and from 9.8 to 6.3 on crossclock, for 0.7% and 1.5% more
  comparisons left to concrete time. It is checked between comparisons, so a
  run ends a little past it.
- "Unasked" comparisons are those whose other outcome the chooser did not
  draw. They are not lost answers.
- Exact plus draw is the no-approximation alternative: 0.67 to 5.7 times the
  run on the heavy fixtures.

**Float errors, against Z3 and the exact solver.**

- False open: 3 of 6,097 on webs (0.05%). This is the dangerous direction: a
  run acts on a branch no concrete run can take.
- False closed: about 2% of open outcomes on chains (1.9%). A flip never
  offered; nothing catches it.
- Zero on crossclock (20 runs), idioms (100), forms (150), long (200) and
  the cached flag (300).
- Webs gives up 3.6% of comparisons at the 4,096-pivot check limit.
- The float tier's tolerance is relative above magnitude one and absolute
  below it (`F_EPS` 1e-7 in `num.rs`), so its answers depend on the scale
  the durations sit at. The exact tier's do not. The offline figures are at
  tick scale, where every value is large; a run whose durations drift below
  one tick would compare differences under 1e-7 as zero. The starting point
  (4.5) and the nearby-values rule keep durations at the sampled scale, but
  nothing bounds them from below. Phase 0 makes the tolerance relative to
  the run's sampled duration scale and tests a fixture scaled by 1e-6.

A float open must be certified exactly before a finding rests on it.
Certifying from the float point does not work: a rational point read off it
satisfies every accepted row for only 2% to 3% of answers, since the point
sits on its bounds, and it costs more than the trial. A certificate has to
solve the basis exactly, once per flip that is acted on, or the accept itself
has to be done exactly. See 4.9.

### 3.3 Rejected, with reasons

Each was measured; none is reopened by this plan.

| Mechanism | Why not |
|---|---|
| Row budget (fix oldest finished columns) | Answers every comparison but closes what was open: counting runs that leave the record, it keeps 20% to 50% of open outcomes on the hard fixtures and 74% to 77% on idioms and the cached flag; float at budget 64 keeps 29% to 43%. The cap keeps 75% to 96% at the same cost. |
| Per-trial pivot cap (`SIMPLEX_TRIAL_CAP`) | Cost is in the bulk of short trials (about 14 pivots each), not in long ones; at 16 pivots chains got slower (258 to 233 runs/s) and left 2.5% of comparisons. |
| Skipping a site after repeated closed trials | Chains 258 to 193 runs/s: each trial kept the tableau laid out for the next, and skipped trials stop maintaining it. |
| Side problem to show a move futile before making it | Closes 37% to 65% of trials that would move, and runs 0.75 to 0.88 as fast: a futile move still positions the durations for the site's next trial. |
| No move for a trial (answer "unknown" instead) | Worked offline only because the recorded run moved the durations. Online nothing moves them; it degenerates to a fixed duration point, 58% of open outcomes on the lease spec, 78% to 89% on the fixtures. |
| Priced opens (offer, pay the move at the accept) | Taken offers mostly fail at the accept: chains 27.1 times the run exact, 10.4 float. |
| Revised simplex over a factored basis | Estimated 1.5 to 2 times on crossclock only. Its rationale is gone: a run in 128 bits throughout costs 1.15 times its 64-bit self, and the regions the durations move between are one per comparison, so there are no bases worth keeping. A new solver. |
| More than two tableaus, or tableaus spawned per comparison | Three and four no better than two; spawning 0.63 to 1.09. |
| Scale anchor | Changes exact answers on non-homogeneous runs. |
| Many micro-optimisations | The findings' "tried and dropped" lists (other pivot rules, journals that undo trials, returning to earlier duration values, value forms, lazy reductions, row screens and redundancy sweeps) each gave the same answers and no gain. Not ported, not retried. |

## 4. Architecture

### 4.1 Crates

| Location | Contents | Origin |
|---|---|---|
| `spur/spur-time/`: new workspace member, no dependency on `spur-core`; depends on `num-rational`, `num-integer`, `num-traits` only | `num.rs`: `R`, `H`, `W`, `F`, the overflow flag, `simplest_between`. `log.rs`: `Row`, `Step` (including `Glue`), the engine log. `simplex.rs`: the tableau and the duration-parameter machinery. `engine.rs`: the online API (4.4). `witness.rs`: the margin solve and rounding. `certify.rs`: the exact certificate (4.9). `report.rs`: per-run counters. | `num.rs` moves as is. `simplex.rs` moves with the budget mode, `Policy` margins, priced opens, the side problem, spawning, `SIMPLEX_DEBUG` and every diagnostic static removed. Environment switches become fields of an options struct; the defaults are the measured defaults. `play_*` become engine methods. |
| `spur/spur-core/src/simulator/symbolic_time.rs`: new | The adapter: forms, the liveness sweep, the step unknown, the chooser call, the timer side table, the shadow timeline, concession, report assembly. | New. |
| `spur/spur-core/src/simulator/time_constraints.rs` | The recorder, behind the `time-constraints` feature. | From `experiment/time-constraints`, plus step and drop events (4.12). |
| `research/symtime/` in the superproject: own `Cargo.toml` and `[workspace]`, path dependency on `../../spur/spur-time` | The offline harness: passes from `main.rs`, the record reader (`model.rs`), the script builder (`linear.rs`), `smt_z3.rs`, `general.rs`, optional `smt_yices.rs`, configs, fixtures, `capped.sh`, results. | Stays here so Z3 never enters `spur/Cargo.lock`. Removed: `solver.rs` (the difference solver), `yices.rs`, and `model.rs::retime`/`rewrite`, replaced by `spur-time::witness`; keep one regression test that reproduces the 600 of 600 replays. |

Rewritten, not moved: the hard-coded lease timing block in `linear.rs`
becomes a translation of `TimingSpec` through `timing.rs::inequalities`, made
`pub(crate)`; dead-marking by last mention becomes the recorded drop signal;
the `Anchor` code stays in the harness only.

### 4.2 Configuration surface

- A top-level key `time` on `ExplorerConfig` and `PlanFileConfig`. Absent
  means Concrete. Register it in `EXPLORER_CONFIG_KEYS`. It does not go in
  `ClockConfig`, which is serialised whole into `runs.clock.assumptions`.

  ```json
  "time": { "mode": "symbolic", "durations": "open", "arithmetic": "float",
            "trials": "drawn", "cap": 5, "early_fire_weight": 0.25,
            "confirm": "violations", "audit_share": 0.01 }
  ```

  `durations`: `"sampled"` or `"open"`. `arithmetic`: `"float"` or
  `"exact"`. `trials`: `"drawn"` (draw-then-verify) or `"all"` (trial every
  outcome, a measurement arm). `cap`: a multiple, or `null` for none.
  `confirm`: `"violations"`, `"all"` or `"none"`. `audit_share`: the share of
  runs whose engine log is kept for the exact audit (4.9).
- CLI: no new flag; `--set time.mode=symbolic` works through
  `config_override`.
- `runs` row: a `"time"` object inside the existing `runs.clock` JSON,
  written only under Symbolic. The Concrete row stays byte-identical
  (`explorer.rs:1182-1194`).
- One new run-variant bit, "symbolic time", named in
  `research/harness/src/decide.ts` in the same commit, as
  `time-handling-implementation.md:27-29` requires.
- Runtime type: `TimeMode::Concrete | Symbolic(SymbolicOptions)`.

### 4.3 Symbolic `TimeValue`

**Representation.** `TimeValue { kind, clock, magnitude }` with `magnitude`
`Concrete(BigRational) | Symbolic(Arc<Form>)`. An enum, so reading a number
from a symbolic value is a compile error (`time-handling.md:617` forbids
silent concretisation). Six call sites outside `time.rs` touch the value:
`exec.rs:804, 807, 1698, 1701`, `eval.rs:300`, `compiled_eval.rs:148`.

**`Form`.** Canonical: terms sorted by unknown, no zero coefficient,
`Ratio<i128>` coefficients with checked arithmetic. Each term holds an
`Arc<UnknownCell>` for liveness (4.6). Overflow in a form concedes the run.

**Eq, Hash, Ord.** Written by hand. The `Concrete` arm hashes and orders
exactly as the derived impl does today; a test pins this against recorded
`sig` values under both hash policies. The `Symbolic` arm is structural on
the canonical form, which is sound for "equal" and not for "not equal",
hence the barrier in 5(b).

**`println` and `TimeToString`** print the form. The displayed magnitude is
already an internal witness that cannot be formatted into reusable state
(`spur/design/language.md:956-964`).

**Operations in `time::evaluate`.** When both operands are concrete, today's
code runs behind one added branch.

- Add, Subtract, Difference, Scale, Divide: form arithmetic, no solver call.
- Less, LessEqual, Greater, GreaterEqual: a two-outcome decision (4.5).
- Equal, NotEqual: a three-outcome decision mapped to bool. An equality
  outcome has no rounding margin and is reported as fragile.
- Min: a decision whose result is the chosen operand.
- `timer_bound` on a symbolic duration: a requirement that it is not
  negative; if infeasible, `NegativeTimerDuration` as today.
- No floor or ceiling is applied symbolically; they are paid at witness time.

**Sources.** `read_clock` (`exec.rs:497-526`) returns `origin + rate *
t_step`. A TrueTime read returns two unknowns (5(d)). `Label::Duration` and
`Op::Duration` return the duration's frozen column under `open` and a
concrete value under `sampled`. `register_deadline` (`exec.rs:551-579`)
produces a deadline form kept in a side table keyed by `Timer.id`; the
`Timer` struct and its hash do not change.

### 4.4 Engine API (library)

```
Engine::new(options, seed)
unknown() -> U                    duration(name) -> U     // a frozen column
require(rows) -> Holds | Infeasible                        // no trial
witnessed(rows) -> bool           // under the current assignment; no pivots
take_witnessed(rows)              // accept; the rows become bounds, no repair needed
try_take(rows) -> Taken | Refused // the trial is the accept; Refused restores bounds
forget(U)                         // from the liveness sweep; may glue
point() -> Option<Point>          // a rational point meeting every accepted row
state() -> Solving | Conceded(reason)
log() -> &Log                     report() -> Report
```

- `try_take` on a three-outcome decision tries the drawn outcome only. On
  `Refused` the adapter takes the witnessed outcome; it never draws twice.
- Under `trials: "all"`, the adapter calls `try_take` in a withdrawing mode
  for every non-witnessed outcome, then accepts the drawn one. This is the
  measurement arm and the only way to report an open set.
- **Tiers online.** The engine starts in `R` (exact) or `F` (float). On
  overflow it widens: restore the last copy in the wider type, replay the log
  from there taking recorded outcomes only, then redo the operation that
  overflowed. Answers already given stand. Past `W`, or when `F` gives up,
  the engine concedes (4.7). The long-run start-wide settings
  (`SIMPLEX_START_WIDE_FROM`) stay options, off.
- **Determinism.** Seeded cycle breaking and trial-count rules only; no clock
  is read. The cap is the one exception to design around (4.7).
- **Log.** Every unknown, requirement, accept, refusal, forget and glue, in
  order. The confirmation job, the audit and the widening replay all read it.

### 4.5 Scheduler and the branch chooser

**No advance action.** Under Symbolic, `schedule_runnable`
(`scheduler.rs:1267`) skips the block at 1302-1339, and `takes_advance` and
`sample_advance` are never called. `nothing_schedulable` must not count "can
advance"; a timed timer is always work.

**Timers.** `Ineligibility.clocks` (`scheduler.rs:1137-1144`) is `None` under
Symbolic. A fire is a requirement that the step's time has reached the
deadline. It never fails and costs no trial.

**Shadow timeline: a priority, not a gate.** A timed timer is "due" when its
deadline, read under the current assignment, is at or below the newest step
unknown's value. Timers not due are withheld, except that with probability
`early_fire_weight` the step releases the earliest not-due timer, and when no
other work exists it does so always. This mirrors `clock.rs:433-461`. Every
timed timer stays fireable; the weight changes which schedules are likely,
not which are allowed.

**Starting duration point.** Under `open`, each run starts its duration
columns at a point sampled as `sample_timing` would sample them, from the
run's own seed. Offline this had no effect on cost (findings, sixth pass and
"A pass at yet another two times"). Online it matters for coverage: under
draw-then-verify the witnessed outcome is free, so where the assignment
starts decides which outcomes a run takes without a trial.

**The chooser contract.**

- `BranchChooser::choose(site, node, outcomes, witnessed, rng) -> outcome`.
  It draws first; the engine decides feasibility. It never sees an open set.
- Default: uniform over the decision's outcomes, independent of `witnessed`.
- Its generator is its own, as `Stream::Clock` is (`rng.rs:51-55`), seeded
  from `schedule_seed` with a new salt, independent of
  `rng_stream_isolation` and off the draw tape.
- Every decision is appended to the run's script as
  `TimeDecision { step, site, drawn, witnessed, taken, refused }`, carried in
  artifacts, not as a scheduler `Action`, since it happens inside a dispatch.
- Per-site draw, take and refusal counts use a `Feedback`-shaped local and
  merge. A "prefer the rarer outcome" chooser goes through the lite loop.

**Site ids.** `TimeOp` gains a compiler-assigned `site: u32` marked
`#[serde(skip)]`, so `program_digest` (`replay_artifact.rs:288-315`) and
Concrete artifacts do not change.

### 4.6 Liveness by reachability

- Each unknown has an `Arc<UnknownCell>`; forms hold clones and the engine
  holds one. At the start of each step that touches time the engine scans
  its live table and forgets every unknown whose strong count is one. The
  sweep runs at fixed points on the run's thread, so it is deterministic.
- What keeps an unknown alive: pending timers through the side table
  (removed at fire and in `retain_timers` on crash, `state.rs:1557-1575`),
  `persisted_data` (`state.rs:1042`), paused frames, buffered messages.
- The newest step unknown is always alive through the ordering chain.
- Gluing needs "no later row mentions it", which is exactly a forget.
- Open, settled in phase 1: how much later an unknown dies online than at its
  offline last mention. Every cost figure in 3.2 assumes last mention.

### 4.7 Concession to concrete time

One path serves three causes: a number outgrows `W`; the float tier gives up
a check; the cap is reached.

1. The engine stops answering. Answers already given stand.
2. It computes a continuation point: the accepted rows solved with the floor
   margin, then rounded as the witness is (4.8), giving an integer global
   time and a concrete value for every live unknown and duration.
3. Every live symbolic value is replaced by its concrete value, and the run
   continues under Concrete rules from that global time: advance actions on,
   timers gated by clocks, comparisons evaluated concretely.
4. If no point is found, the run ends with `end_reason =
   "time_conceded_without_point"`, counted.

Offline a rational continuation point was found for almost every conceded
run: none missing on overflow alone, and 2 to 4 of 400 crossclock runs
without one under a cap of 2 to 5 times. Rounding it to integer ticks
mid-run is unmeasured.

**The cap online.** Offline the cap compared solver time with the run's
recorded wall time. Online it must compare solver cost so far with the run's
own cost so far, and it must not make a run depend on the machine. The
proposal: both in deterministic units, solver merge work and pivots against
interpreter instructions and scheduler steps, with an exchange rate
calibrated once against the offline wall-time figures and fixed in code;
wall time is reported beside it but decides nothing. The concession step is
recorded in the artifact either way, so replay reproduces it. See D4.

### 4.8 End-of-run witness and concrete replay

**Order.** The symbolic run ends; its history goes to the linearizability
check in the existing pool, which orders by sequence, not time. A legal
verdict ends the work. An illegal verdict is a **candidate**, not a
violation.

**Confirmation job.** Carries the log, actions, delays, settlements, plan,
clocks, decisions and any concession point; its size is charged to
`queue_bytes`.

1. **Solve exactly.** Replay the log in the exact tier, whatever tier the
   run used. A float run whose accepted rows are infeasible exactly ends here
   as `candidate_unconfirmed`, reason `float_infeasible`. Tighten every
   accepted row by the floor margin (sum of positive coefficients on floored
   readings) and a rounding margin (sum of absolute coefficients over
   unknowns rounded up). Solve under a pivot limit.
2. **Round.** Ceiling of every step time; the order chain survives because
   ceiling is monotone. TrueTime endpoints are rounded the same way. Under
   `open`, durations become integers through `timing.rs::integer_witness`,
   which keeps ratios, and all times scale by the same factor; valid only
   when the run is homogeneous (5(d)).
3. **Build a version-3 artifact** (5(a)).
4. **Replay concretely** and judge the replay's own history.

**Verdicts.** Illegal with reason `confirmed_by_replay`; or
`candidate_unconfirmed` with a reason naming the comparison where the replay
diverged, counted as unknown so the exit code is 4.

**Isolation (A5).** Confirmation runs `spur replay` as a child process by
default. An in-process path may replace it after an audit shows replay writes
no static; `run_replay` itself calls `fault_timing::set_fraction`
(`explorer.rs:1874-1875`).

**Overflow policy.** Under Symbolic, `linearizability.overflow` defaults to
`block`, so a deferred check cannot let the Go checker report candidates as
violations.

A reported violation is sound whatever the tier: it is the concrete replay's
verdict. Float errors cost wasted runs and unconfirmed candidates, not wrong
findings.

### 4.9 Float answers: certificate and audit

- **Certificate.** A float `Taken` on a drawn flip is certified before the
  run leaves the step that took it: the float basis is solved exactly
  over the accepted rows (the rows tight at the float point, as an exact
  square system), and the resulting point is checked against every accepted
  row. A failure concedes the run at that step (4.7). Two options, D2:
  certify every taken flip, or do only the accept of a drawn flip in the
  exact tier and keep float for trials of everything else. Per-trial
  certification from the float point is not an option (97% fail).
- **Audit.** A seeded share of runs (`audit_share`) keeps its engine log.
  The harness replays each through the exact tier and, where it finishes,
  Z3, and reports online false opens (float `Taken`, exact refuses) and false
  closeds (float `Refused`, exact takes), per spec and per site. This is the
  online counterpart of the offline 0.05% and 2% figures.
- **Failed accepts.** A `Refused` try_take costs a trial and leaves the
  durations where the trial last had everything holding. The offline draw
  figures already pay for these: the proxy tries the other outcome for half
  the witnessed comparisons, exactly as a uniform chooser would, and a
  closed one is refused and the recorded outcome taken, as online. What the
  proxy does not model is a flip that succeeds, after which the online run
  differs from the recorded one; its cost after the flip is unmeasured
  until phase 2.

### 4.10 Offline harness

- The same `spur-time` crate and log format. Inputs: a recorder file from a
  Concrete run, each step carrying its recorded outcome as taken; or an
  engine log from a Symbolic run, dumped under the `time-constraints` feature
  or by the audit.
- Passes kept: `check`, `classify`, `linear`, `linear-threads` (with
  `--walls`, `--backend float`, draw and cap), `slowest`, `anchors`.
- Passes added: `agree` (an online log against Z3, decision by decision),
  `audit` (4.9), `liveness` (drop signal against last mention), `witness`
  (margin solve, then `spur replay`).
- Every run goes through `research/symtime/capped.sh`, one solver process at
  a time: several at once have exhausted the host's memory.

### 4.11 Per-run reporting

`runs.clock.time` fields: `mode`, `durations`, `arithmetic`, `trials`, `cap`;
`comparisons`, `witnessed_taken`, `flips_drawn`, `flips_taken`,
`flips_refused`, `implicit_decisions`, `barrier_fallbacks`; `widened`,
`conceded` (with cause: overflow, float limit, cap), `conceded_at_step`,
`certified`, `certificate_failures`; `peak_rows`, `pivots`, `solver_work`,
`solver_us`; `unknowns`, `peak_live`, `glued`, `tableaus`; `homogeneous`.

Witness and confirmation status go in the check record, because the run row
is written before the check (`pool.rs:373`).

Every mechanism has a counter in `util_stats.rs`: draws, flips taken and
refused, widenings, concessions by cause, certificates, sweeps and forgets,
glues, second tableaus, shadow releases, witness solves, replays confirmed
and diverged, audits.

Tables: symbolic rows carry `global_time = 0` up to a concession and real
times after it; `clock_observations`, `timer_events` and `run_clocks` are
written only for the conceded part. A confirmed replay writes its own
complete output directory under `<output>/confirmed/run_<id>/`, which is the
evidence for the finding.

### 4.12 Recorder (permanent, feature-gated)

Hooks as in the experiment (`time.rs`, `exec.rs`, `state.rs`, `clock.rs`,
`explorer.rs`, about 70 lines, all behind
`#[cfg(feature = "time-constraints")]`), with these changes:

| Change | Reason |
|---|---|
| The `known` table holds `Weak<TimeValue>`, not `Arc`. | A strong table keeps every value alive and hides drops. |
| Emit a drop event when a sweep at a step boundary finds a value gone. | Offline then uses the signal online will use, not the future. |
| Emit a step event at each dispatch. | The one-unknown-per-step model (A3). |
| Use site ids from `TimeOp.site`. | Removes the four hooks from the interpreter loops. |

## 5. Proposals for the unresolved items

| Item | Proposal | Rejected alternative, and why |
|---|---|---|
| **(a) Advances cost steps** | Artifact version 3 adds `advance: u64` to `Action::Dispatch`, skipped when zero. Replay moves time, then dispatches, in one step. The reader accepts versions 2 and 3; the Concrete recorder keeps writing 2. Step-counted delays are search controls, not semantics (`time-handling.md:218-219`). | Inserting `Advance` actions and renumbering: every step-keyed item shifts. A placeholder advance before each time-touching dispatch: the scheduler cannot know a record will read time, and `advance(0)` is an error (`clock.rs:398-400`). |
| **(b) Map keys, aggregate `==`/`!=`** | Direct time `==`, `!=` and `min` are decisions. For structural uses, a barrier at a finite op list: map key insert, lookup, `exists`, `erase`; `index_of`; aggregate equality whose static type contains a time; map iteration order. At the barrier a symbolic value is settled: its unknowns are fixed at their current values as equality rows (an accept that removes solutions only), and the value becomes concrete. The compiler sets a program flag from types alone, so programs that cannot reach the barrier never test for it. | Exact n-way decisions inside `Eq/Hash/Ord`: they run inside `imbl` with no engine access. Revisit only if phase 2 counts barrier hits on real specs; the expected count on the lease panel is zero. |
| **(c) Pauses, crash, `persist_data`** | No special case. A paused frame, a buffered message and `persisted_data` hold the `Arc`. A crash drops frames and timers; the next sweep forgets them. Tests: a pause holding a form across other nodes' steps; a crash dropping it; a persisted expiry compared after recovery; both interpreters. | Concretising on persist: loses exactly the forgotten-grant scenario. |
| **(d) TrueTime** | One read gives unknowns `e` and `l` with `e <= t_step <= l` and `l - e <= tt_width`. `tt_width` is an absolute constant, so such a run is not homogeneous and integer scaling of a duration witness is invalid. `durations: open` is refused at session start when the program uses `tt_now` and `tt_width > 0`; the session runs as `sampled` and says so in every `runs` row. | Margins that absorb duration rounding: they fight `require` equalities, and no spec exists to test them. |
| **(e) `run-plan` and `replay`** | `run-plan` rejects `time.mode = symbolic`: a plan with numeric `advance_time` is concrete from `T = 0`. `replay` takes version 2; a version-3 witness, replayed concretely (confirmation); and a symbolic run's own artifact, replayed symbolically (the determinism test). | Turning `advance_time` into a lower bound: changes the meaning of existing plans. |
| **(f) Other explorers** | The engine lives below `run_single_simulation` and `run_single_plan`, so genetic, AOS, continuous and campaign inherit it. The chooser's stream is off the tape, so an AOS tape-mutated child redraws time decisions. `standard` is tested in full; the others get a smoke test that completes, is deterministic, and leaves Concrete unchanged. | Time decisions on the draw tape: mutation would flip decisions blindly and shift every later draw. |
| **(g) Output tables** | As in 4.11. `traceanalyzer` must tolerate missing time tables when `runs.clock.time` is present. | Writing the current assignment as `global_time`: it moves as repairs happen, so the numbers would look right and be wrong. |
| **(h) Beyond 128 bits** | Concession (4.7). crossclock outgrows 128 bits in 7 of 400 runs with durations open; float gives nothing up there. | A `BigRational` tier: owner decision against arbitrary precision; `Num` is `Copy` throughout. The offline "second play" that keeps the better of two runs: answers online are already acted on. |

## 6. Phases

Rules for every phase: both interpreter paths; release builds only;
`cargo ... --manifest-path spur/Cargo.toml` from the superproject root;
`spur/` commits land first, then the pointer moves; `research/STYLE.md`
applies; scaffolding is removed when the phase closes and behavioural tests
stay. Offline solver runs go through `capped.sh`, one process at a time.

### Phase 0: the library and the offline driver

No `spur-core` change; between iterations.

- **Entry test.** The experiment branch at 59b0a13 reproduces its own policy
  table (3.2) on this host; the numbers are saved as the reference.
- **Work.** `spur/spur-time/*`; `spur/Cargo.toml` members; `research/symtime`
  re-pointed at the crate. The engine API of 4.4, driven offline by the
  harness in draw mode (the recorded outcome is the draw). Rejected
  mechanisms (3.3) are not ported.
- **Exit.** Exact tier: every answer equals Z3 on the 14 cells of the gluing
  cross-check (chains 5 runs to cached flag 300, durations open and
  concrete). Float tier: false opens and false closeds no higher than 3.2's
  figures on the same runs. Solver time over run time within 10% of the
  reference on every spec, for exact, exact + draw and float + draw + cap
  5x. Concession reproduces the reference count of comparisons left to
  concrete time on crossclock and a continuation point wherever the
  reference found one. The cycle guard has unit tests on the fixtures that
  broke it.
- **Removed at close.** `solver.rs`, `yices.rs`, and the per-event script
  path once phase 1's step model lands.

### Phase 1: recorder lands, liveness is measured. Boundary A.

- **Files.** `spur-core/Cargo.toml` and `spur-cli/Cargo.toml` (feature);
  `simulator.rs`, `simulator/time_constraints.rs`; hooks in `core/time.rs`,
  `core/exec.rs`, `core/state.rs`, `clock.rs`, `explorer.rs`;
  `spur-ast/src/clock.rs` (`TimeOp.site`, serde-skipped) and the checker at
  `analysis/checker.rs:2015, 2833`.
- **Entry test.** Phase 0 exit.
- **Exit.** Replay artifacts byte-identical under a fixed `session_seed` in
  three builds (parent, feature off, feature on); program digests unchanged;
  the offline `check` pass finds no mismatch and no operand of unknown
  origin; step markers group every read of one step under one unknown.
- **Go/no-go L.** Replay the recommended configuration with drop-signal
  liveness and step unknowns on the lease specs, idioms and crossclock.
  Pass: panel specs stay at or under 0.25 of a run, and no dataset exceeds
  1.5 times its last-mention figure. Report the lag from last mention to
  drop. On fail, redesign 4.6 (sweep more often, drop environment slots at
  scope exit) before phase 2.
- **Boundary reading.** Perf grader declared neutral (hooks compiled out);
  lite panel parity.

### Phase 2: symbolic execution core. Boundary B.

- **Files.** `core/time.rs`; `core/values.rs` (impls, barrier helpers);
  `core/exec.rs` (reads, registrations, durations, barrier ops, the scoped
  engine pointer, concession switch); `core/scheduler.rs` (no advance,
  timers ungated, shadow release); `core/state.rs` (symbolic state, timer
  side table, deadlock rule); `path.rs`; `explorer.rs` (config, always-on
  script, report); `replay_artifact.rs` (`time_decisions`, `time_mode`);
  `rng.rs` (chooser stream); `run_variant.rs`, `decide.ts`,
  `util_stats.rs`; new `symbolic_time.rs`.
- **Scope.** `durations: sampled`; exact tier with widening; draw-then-verify
  and `trials: "all"`; default chooser; concession on overflow; no cap, no
  float, no witness yet.
- **Entry test.** Go at L.
- **Exit, fixtures** (new `spur-core/tests/symbolic_time.rs`, from
  `research/symtime/specs/forms.spur`, `idioms.spur`, `crossclock.spur`):
  both outcomes of a lease comparison reached within N runs; a drawn outcome
  that is closed is refused and the witnessed one taken; two reads in one
  step compare equal; `min`, three-way equality, a negative-duration
  requirement; a pause holding a form; a crash freeing unknowns with
  peak-live bounded on a long run; a persisted expiry compared after
  recovery; the barrier settling a time map key; a cross-clock comparison
  still an error; a crossclock run that overflows concedes and completes in
  concrete time; symbolic replay of a symbolic artifact reproduces its
  decisions, concession step and endpoint; `run-plan` rejects the mode;
  genetic, AOS, continuous and campaign smoke tests.
- **Exit, agreement.** Engine logs dumped under the feature; `agree` finds
  no difference from Z3 on any answered decision over at least 3,000 runs
  per lease spec and both fixtures.
- **Exit, neutrality.** Concrete artifacts and Parquet outputs byte-identical
  to the parent under a fixed `session_seed`.
- **Boundary reading.** Perf grader neutral for Concrete; lite panel parity
  with no `time` key. Symbolic throughput on the lease specs recorded as a
  reading, not a gate.

### Phase 3: witness and confirmation. Boundary C.

- **Files.** `spur-time/src/witness.rs`; `replay_artifact.rs` (version 3);
  `core/scheduler.rs` (inline advance in the scripted branch near
  1297-1323); `linearizability/pool.rs` and `linearizability.rs` (candidate
  verdict, confirmation job, counters, `block` default under Symbolic);
  `explorer.rs` (job payload); `porcupine/` (a warning when
  `runs.clock.time` is present); docs: `docs/simulator_options.md`,
  `docs/simulator_semantics.md`, `spur/design/language.md:966-970`.
- **Entry test.** The harness `witness` pass on recorded concrete runs of
  `forms` and `idioms` replays at least 99% (risk 3; it needs no engine and
  can run during phase 1).
- **Exit, with `confirm: all` in a test configuration.** At least 99% of
  completed symbolic runs on the lease specs, `forms` and `idioms` yield a
  witness that `spur replay` accepts to the recorded endpoint with every
  comparison matching, the rest reported by reason; conceded runs replay
  across their concession step; both interpreters give the same replay
  history; an equality-only case reports `candidate_unconfirmed`; a
  version-2 artifact still replays; Concrete `record_replay` output
  byte-identical.
- **Boundary reading.** Perf grader neutral for Concrete; lite parity.

### Phase 4: reach measurement. Go/no-go R. No code boundary.

- **Arms.** Concrete; Symbolic, sampled, exact, drawn; Symbolic, sampled,
  exact, `trials: "all"` (for open shares only).
- **Conditions.** The findings' specs, overlay and session seeds; equal
  wall-clock; lite grader thread counts; the sequential rule from
  `research/harness`.
- **Measured.**
  1. Open shares from the `all` arm against the offline 42% to 85%.
  2. Confirmed violations per wall-hour: `raft_lease_cached_flag` (concrete
     about 1 in 300,000 runs), `raft_lease_read_recv_anchor` (never
     falsified), and the clean control, which must stay at 0.
  3. What taking the flip finds: CFG and timeline novelty of runs that took a
     non-witnessed outcome against matched runs that did not.
  4. Conjunctions: distinct joint `(node, site, outcome)` patterns per
     100,000 runs, symbolic against concrete (the concrete side from the
     recorder), and the share of runs with "holds" on two nodes in one run.
  5. Costs: solver share of wall time, refusals, widenings, concessions,
     barrier fallbacks, unconfirmed share, shadow-release rate.
- **Go.** At least one mutant at 3 times or better in confirmed violations
  per wall-hour, or `recv_anchor` falsifies at all; the clean control has no
  confirmed violation; the unconfirmed share of candidates is under 10%.
- **No-go.** Under 1.5 times on every entry: stop, and keep the crate, the
  recorder, the harness and the witness path as a reporting tool (findings,
  "What follows", item 2).
- **In between.** D1.

### Phase 5: open durations, float, cap, certificate, audit

Only after Go. Boundary D.

- **Work.** Duration columns under `open` with the sampled starting point;
  the `F` tier; the deterministic cap and its calibration (4.7); the
  certificate (4.9); the audit share and the harness `audit` pass; refuse
  `open` when the configuration is not homogeneous (5(d)).
- **Entry test.** Phase 0's offline float + draw + cap figures hold with the
  phase 1 liveness model.
- **Exit.**
  - Online solver share within 1.5 times the offline figures of 3.2 on every
    dataset, worst run under 8 times on chains and crossclock.
  - Audit over at least 1% of runs: false opens under 0.1% of taken flips and
    false closeds under 3% of refusals on every dataset; every false open
    caught by the certificate before it is relied on.
  - Failed-accept cost reported per site: share of drawn flips refused, and
    solver time in refused trials over all solver time.
  - Starting point: the share of comparisons whose witnessed outcome differs
    across seeds, against a fixed starting point.
  - Identical output for the same seed on one thread, cap included.
- **Then** measure reach again as in phase 4 with the Phase 5 arm added.

### Phase 6: heuristics and edges, through the loop

A chooser that prefers rarer outcomes or down-weights sites that keep
refusing; shadow-timeline variants; where durations are kept as a learned
lever; `rates: sampled` after overflow is measured; a plan with a free
timeline (D6); in-process confirmation after the statics audit. Each through
the lite loop with its own counter.

## 7. Risks, ordered, with the cheapest early test

| # | Risk | Cheapest test | When |
|---|---|---|---|
| 1 | Reach is not there; symbolic finds nothing concrete does not. | Phase 4 itself, which needs only `sampled`, exact and the panel specs, where the solver costs 9% to 25%. | Phase 4 |
| 2 | Timers firing in arbitrary order destabilise protocols and confound the reach reading. | Completed client operations per run, symbolic against concrete, on the clean spec with shadow release on and off. | Phase 2 |
| 3 | The general-LP witness, with rounding and integer durations, fails where the difference path gave 600 of 600. | The harness `witness` pass on recorded `forms` and `idioms` runs. | Phase 1 |
| 4 | Reachability liveness lags last mention enough to bring back the quadratic tail. | Go/no-go L, recorder only. | Phase 1 |
| 5 | Runs that take a flip cost more after it than the recorded runs the offline figures come from. | Solver share per run, split by runs that took a flip and runs that did not, on the phase 2 fixtures. | Phase 2 |
| 6 | The mid-run continuation point cannot be rounded to integer ticks. | A crossclock fixture forced to concede early (`SIMPLEX_TIERS=1` equivalent option). | Phase 2 |
| 7 | Float errors online exceed the offline 0.05% and 2%. | The audit. | Phase 5 |
| 7a | Float answers change with the scale the durations sit at (tolerance absolute below one). | The phase 0 fixture scaled by 1e-6 and 1e6, float against exact. | Phase 0 |
| 8 | The exact certificate is as costly as the trial it certifies. | Time it on webs and crossclock flips offline. | Phase 0 |
| 9 | A deterministic cap measure does not track wall time. | Correlate it with wall time over the phase 0 datasets. | Phase 0 |
| 10 | Concrete perf or bytes move: the `TimeValue` enum, the hash, the extra branch. | A hash-pinning unit test; an artifact diff; the perf grader. | Phase 2 |
| 11 | Barrier or implicit decisions are common in real specs. | Counters on the whole `bin/spur` tree under Symbolic. | Phase 2 |
| 12 | Child-process confirmation is too slow when candidates are common. | Measure; `stop_on_violation` bounds it; cap concurrent confirmations. | Phase 3 |
| 13 | The evidence base is narrow: three specs, one idiom; the heavy shapes are synthetic. | Add `paxos_master_lease_forget` and the fixtures to every reading. | Phase 4 |

## 8. Decisions for the owner

- **D1.** The go/no-go R thresholds (3 times, 1.5 times, 10% unconfirmed),
  and what to do in the middle band.
- **D2.** Decided: exact online (see 3.2). Float with either certificate
  sub-choice (certify every taken flip, or accept drawn flips in the exact
  tier) needs an exact engine accepting every row beside it, and measured
  more costly than exact alone on every dataset. Float stays in the offline
  harness.
- **D3.** Open for the owner; built default `trials: "drawn"`. Whether the
  explorer needs the full open set before choosing. Draw-then-verify never
  gives it; a chooser that weighs outcomes by feasibility, or a reach report
  of both-open shares, needs `trials: "all"` and its cost (the "exact" and
  "float" columns of the findings' policy table rather than the "draw"
  ones).
- **D4.** The cap measure: deterministic work units with a calibrated
  exchange rate (recommended), or wall time with the concession step
  recorded so replay still reproduces it, giving up same-seed identical
  output.
- **D5.** Decided: as built, one unknown per step (A3). It changes the
  offline numbers slightly; phase 1 re-measured under it.
- **D6.** Whether a `run-plan` with a solver-found timeline is wanted.
- **D7.** Refuse `open` when `tt_now` is used and `tt_width > 0`
  (recommended), or invest in a non-homogeneous integer witness.
- **D8.** Decided: under Symbolic, `overflow: block` plus a Go-checker
  warning. The explorer blocks unless the config names an overflow policy,
  and porcupine warns when an output's `runs.clock` carries a `time` object.
  Persisting candidate inputs for a `spur confirm` command is not built.
- **D9.** Open for the owner; built default `early_fire_weight: 0.25`, and
  an early fire costs no step of its own. The default weight, and whether an
  early fire should cost a step as the concrete advance does.
- **D10.** Open for the owner; built default a uniform draw over outcomes.
  Uniform, or weighted towards the non-witnessed outcome (more flips, more
  refusals).

## 9. End-to-end verification

**Build and run.**

```bash
cargo build --release --manifest-path spur/Cargo.toml --bin spur
cargo build --release --manifest-path spur/Cargo.toml --bin spur --features time-constraints
cargo run --release --manifest-path spur/Cargo.toml --bin spur -- explore -e standard \
  --config research/symtime/configs/lease.json --set time.mode=symbolic --set time.durations=sampled \
  --set session_seed=1000 -y --output-dir out/sym bin/spur/panel/raft_lease_cached_flag.spur
research/symtime/capped.sh cargo run --release --manifest-path research/symtime/Cargo.toml -- agree --records out/sym_tc
```

**Must be byte-identical (Concrete).** Replay artifacts and every Parquet
table under a fixed `session_seed`, across the parent commit, feature off,
feature on, and a build with the `time` key absent. Program digests.
`Value.sig` for concrete time values under both hash policies.

**Must match Z3.** In the exact tier, every answered decision on at least
3,000 runs for each lease spec and each fixture, at both duration levels. In
the float tier, the audit's false-open and false-closed rates reported per
dataset; no false open survives the certificate.

**Must replay.** Every confirmed violation, which holds by construction
because the verdict is the replay's. Under `confirm: all`, at least 99% of
completed runs, conceded runs included, with failures listed by reason. A
symbolic artifact replayed symbolically reproduces its decisions, concession
step and endpoint in both interpreters.

**Boundary readings owed.** Boundaries A, B, C and D each owe a perf grader
session and a lite panel parity reading with no `time` key, as
`time-handling-implementation.md:16-20` requires.
