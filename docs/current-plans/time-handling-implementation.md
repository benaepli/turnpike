# Spur Time Handling: Implementation

This document sequences the contract in [Time Handling](time-handling.md).
The contract says what executions are allowed; this document says which
files change, in what order, and what reading each step owes before it
merges. Where the two disagree, the contract wins and this document is
wrong.

## Rules that apply to every phase

- Two interpreter paths exist in `spur/spur-core/src/simulator/core/exec.rs`:
  the label path (`Label::SetTimer`, record loop around `Label::Recv`) and
  the compiled path (`Op::SetTimer`, record loop around `Op::Recv` and
  `Op::Pause`). Every operation lands in both, and every behavioral test
  runs both.
- Simulator-core wiring lands only at a research-loop iteration boundary,
  with loops stopped, rebased on the latest merged state, verified on
  release builds only, with a perf grader session
  (`docs/agent/perf-grader-status.md`) and the lite panel reading. Boundary
  scaffolding is removed when the boundary closes; behavioral tests stay.
- Front-end work and new files land between iterations.
- New panel specs are additive files under `bin/spur/panel/`. No existing
  spec under `bin/spur/` is edited.
- Every mechanism counts its own firing in
  `spur/spur-core/src/simulator/util_stats.rs`. A null result from an
  uncounted mechanism cannot be told apart from one that never ran.
- A run-variant bit added to `spur/spur-core/src/simulator/run_variant.rs`
  is named in `research/orchestrator/src/decide.ts` in the same commit; the
  perf grader refuses an unnamed bit. Bits are sparse, so there is room.
- `spur/` and `porcupine/` are submodules. Changes land there first; the
  superproject pointers move after.
- Code and documents follow `research/STYLE.md`.

## Phase 1: front end

Lands between iterations. Goal: the language accepts the API, the checker
enforces contexts, and execution refuses the operations until phase 2.

### One expression shape

Extend the existing timer expression rather than adding three new ones:

- `SetTimer(label)` becomes `SetTimer { label, bound }`, where `bound` is
  none, after a duration operand, or at a deadline operand. Every existing
  `SetTimer` touch point changes one arm.
- One new expression `ClockRead(kind)` with kinds monotonic and truetime.

The touch points are the ones `rg -n SetTimer spur -g '*.rs'`
lists: `spur-core/src/lexer.rs`, `parser.rs`, `spur-ast/src/types.rs`,
`spur-ast/src/pure.rs`, `spur-core/src/analysis/checker.rs`,
`compiler/lowered/remove_loops.rs`, `compiler/anf/lower.rs`,
`compiler/threaded/lower.rs`, `compiler/pure/lower.rs`, `compiler/cfg.rs`,
`compiler/cfg/ir.rs`, `compiler/cfg/compiled.rs`,
`compiler/cfg/compiled/check.rs`, `compiler/cfg/frame_layout.rs` and its
test, `visualization/cfg.rs`, and `spur-liquid/src/lower.rs`, which marks
both expressions disallowed the way it marks `set_timer`. The editor
grammar `editors/code/syntaxes/spur.tmLanguage.json` gains the new names.

Types: the monotonic read is `int`; the truetime read is
`std::time::Interval`; a bound operand is `int`; the timer result stays
`chan<()>`.

### Context checks

The topology pass in `spur-core/src/analysis/checker/topology.rs` sets a
node-bound effect for `unique_id`, and that effect already rejects deploy
functions through helper calls. Both new expressions set the same effect.
The pure-context and initializer rejections that name `set_timer` in
`parser.rs` and `compiler/pure/lower.rs` name the new expressions too.

The checker also records, per expression, whether it sits directly in an
async function body. That bit is carried to both `Label` and `Op` so the
executor knows which reads and timed registrations are checkpoints without
a runtime walk of the call stack.

### Standard library

Add `spur-core/src/stdlib/time.spur` holding the `Interval` record and the
synchronous predicates `tt_after` and `tt_before`, and register it in
`STD_MODULES` in `spur-core/src/stdlib.rs`.

The loader (`spur-core/src/loader.rs`, `mentions_std`) loads the library
only when a module writes `std::` in a path position. A program that calls
the truetime read without naming the library still needs the record type,
so the token check also counts the truetime read token as a mention. If
that proves awkward the fallback is to type the read as `(int, int)` and
drop the record; the contract would then change, so decide this first.

The runtime builds the record with `Value::struct_of` in
`spur-core/src/simulator/core/values.rs` from the shape the compiler
resolves for the type.

### Unwired execution

Both interpreters return a new `RuntimeError` variant for the new
operations until phase 2 wires them.

### Tests

Compile-only fixtures under `spur-core/tests`, following `modules.rs`:

- Accepted in handlers, clients, `Init`, `RecoverInit` and synchronous
  helpers.
- Rejected in deploy functions directly and through a helper, in
  declaration initializers, and in pure contexts.
- `set_timer` with only a label is unchanged.
- `spur check` still passes on every spec under `bin/spur` and its
  subdirectories that compiled before.

## Phase 2: clocks and timed timers

Lands at an iteration boundary. Declared search-neutral for the existing
panel with this written argument: no existing spec constructs a timed
timer or reads a clock, so it consumes no clock draws and offers no
automatic advances. The compiler records whether the loaded program uses
either operation, including through helpers, and the scheduler gates the
new path on that flag. Clock initialization is lazy on programs without
these operations. Timer bookkeeping and the extra dispatch branch still
need a throughput measurement. Parity compares existing semantic fields;
additive recording columns and tables change the output schema.

### Clock state

Add a clock block to `State` in `spur-core/src/simulator/core/state.rs`:

- Global time in ticks as `u64`, limited to `i64::MAX`.
- Per node, a rate as a fixed rational with positive `i64` numerator and
  denominator, a signed `i64` origin, and a clock epoch identifier.
- The configured rho bound and uncertainty width.

A node's reading is computed on demand as
`origin + floor(numerator * T / denominator)`. Use checked `i128`
intermediates and checked conversion to `i64` for readings, endpoints, and
deadlines. Keep the fractional clock progress by recomputing from `T`;
never round each incremental advance. Negative origins and readings are
valid. A negative duration is an error; a negative deadline is compared
as signed and is immediately eligible if it is at or below the reading.

With integral origin and rate `p/q`, the smallest integer global time
reaching deadline `e` is `ceil((e - origin) * q / p)`, clamped to zero.
Compare it with the current `T` before proposing a positive advance. The
subtraction, product, ceiling division, and conversion are checked. A
clock result or timer-constructor sum outside its domain is a runtime
error. Ordinary Spur arithmetic remains unchanged, so a spec computing
its own deadline must respect the language's integer limits.

Assign clocks before `Init`, `RecoverInit`, or any client code can read
them. Include client nodes in the clock table, assigning an entry on
client allocation if necessary. Process recovery preserves the assignment.

### Random stream

Add a clock stream to `spur-core/src/simulator/rng.rs` for rate assignment,
origins, interval width, interval placement, and automatic advance
selection. It must stay independent even when `rng_stream_isolation` is
false; adding a `Stream` variant alone does not provide that guarantee.
Wire it into recording and replay, including the plan runner, which
currently uses a plain `SmallRng`. Existing specs consume no clock draws.

### Rate assignment

Under rho zero every rate is one and every origin is zero. Otherwise each
node draws its rate from the two extremes and one, and its origin from a
small range, all from the clock stream. The assignment is recorded per run.

### Timer deadline and eligibility

`Timer` in `core/state.rs` gains `deadline: Option<i64>` in the owner's
ticks. A timed timer is eligible when the owner's reading is at or above
it. `Ineligibility::rejects` in `core/scheduler.rs` rejects an unmet
deadline for delivery. Queue counts, queue routing, and within-queue
selection use that same predicate. A queued timer can supply a target
for a separate advance even while it is rejected for delivery.

`State` keeps a maintained count of timed timers, updated on push, take,
and the crash filter, so `only_crashes_can_be_ineligible` adds a
`timed_timers == 0` term. Durationless timers use the existing path.

### Time advance

Add an advance action to scheduler dispatch, separate from timer
delivery. At each scheduling boundary of a clock-using program, ordinary
exploration offers that action alongside local, network, and eligible
timer work. The choice can take a positive sampled increment even when
no timed timer exists. The initial sampler includes one-tick advances,
broader log-uniform increments, and the smallest positive advance reaching
a queued timed-timer deadline. Its selection weights and sampling range
are recorded with the run's search settings; it is a heuristic, not a
clock assumption. It must give both ordinary work and advances a nonzero
chance when both are possible.

Selecting an advance updates `T`, records a clock-advance event, and ends
that scheduler action without firing a timer or running protocol code.
It costs one search step regardless of the number of ticks. On a later
action, the timer branch can select any timer now eligible, with no
maximum lateness guarantee. Deadline targets cannot replace general
sampling: clock-only programs and durationless rechecks need time too.

Wire the offer into `schedule_runnable` and the dispatch/termination logic
in `spur-core/src/simulator/path.rs`. Empty queues cannot skip the advance
path or cause a deadlock while an advance is available. Time advance
alone does not complete a client operation or reset every stall counter;
finite search caps still apply. A budget or numeric limit is distinct
from protocol deadlock. An unfinished explicit plan blocked on unmet
deadlines with no remaining advance is reported as incomplete. Background
timers do not keep a completed workload open.

`run-plan` enables only explicit `advance_time` events; exact replay takes
the recorded advances. Neither mode samples extra advances. Under
`strict_timers`, a labeled timed timer needs both permission and a reached
deadline. `allow_timer` never advances time, and time advance never grants
a timer permission. Unlabeled timers retain their existing permission
treatment.

### State identity

Extend `Timer::hash` with a deadline tag and signed value for timed timers;
preserve the durationless timer hash when the deadline is absent. Extend
`State::signature()` with global time, the clock assumptions, and the
per-node rates, origins, and epochs. Rates have a canonical reduced
rational representation. Preserve the no-clock signature when clock
state is absent. Any code using hashes as a state index must include
these semantic fields and compare full state where equality is required;
performance counters and text logs remain excluded. This requirement
does not imply that current ordinary exploration deduplicates whole states.

### Reads and registration

In `run_common_op` and its label-path twin:

- The monotonic read returns the owner's reading.
- The truetime read draws integer width `w` in `[0, U]` and integer left
  extent `a` in `[0, w]` from the clock stream, then returns
  `[T - a, T + (w - a)]` using checked signed arithmetic. This contains
  `T` and has full width exactly `w`, including asymmetric intervals and
  negative lower endpoints near time zero. Replay supplies the recorded
  endpoints after validation instead of sampling.
- After-registration samples the reading and adds the duration. A negative
  duration is a runtime error; zero is immediately eligible.
- At-registration stores the operand as the deadline.

`crash_node` in `core/scheduler.rs` already drops the node's timers; update
the timed-timer count and cancellation records along that path. Verify
that buffered notifications and waiting frames owned by the failed
process are discarded too. The clock epoch lives in `State` rather than
the node environment, so it survives recovery.

### Recording

- `runs` (`PersistableRun` in `spur-core/src/simulator/history.rs`) gains
  the rho and width assumptions, tick resolution, clock/failure/checkpoint
  semantics version, and the clock sampler settings.
- A `run_clocks` table records run, node, rate numerator, rate denominator,
  origin, and epoch, including client clocks.
- `executions` gains an additive `global_time` column. Use a shared
  per-run event order to relate execution rows to clock and timer rows.
  `OpKind` gains `ClockAdvance`, carrying the old time, new time, and
  whether the advance came from sampling, a deadline target, or a plan.
- A structured `clock_observations` table records node, incarnation,
  epoch, operation site, occurrence, global time, and result. Monotonic
  reads store one value; truetime reads store both endpoints together.
  An after-timer's internal sample is identified as registration, so it
  cannot be mistaken for a separate checkpoint.
- Structured timer events record the per-run timer identity, owner,
  incarnation, label, registration time, optional deadline, delivery,
  and cancellation. Unlabeled timed timers need this evidence too.
- These structured records are retained independently of text logging.
  Measure their cost with clock-using specs as well as the existing panel.
- Porcupine's reader in `porcupine/checker/duckdb_reader.go` filters
  `kind <> 'TimerFired'`. Change it to keep only the kinds the checker
  consumes, so every later system kind is skipped without another edit.
- Traceanalyzer selects columns by name; verify its queries against the
  new columns and system event kinds before merging. Audit the Rust
  checker's system-event filters and the plan stall counters too.

### Exact replay

Persist a versioned replay artifact for time-using executions containing
the compiled-program identity, deployment, resolved workload and settings,
clock assignments, structured observations, and concrete scheduler actions
in execution order. Dispatch choices use stable per-run record/timer IDs
and execution positions, including occurrences of a resumed record.
Include client issuance and plan-event actions so a partial DAG cannot
reorder them during replay. Random draw tapes may accompany this evidence;
a seed alone is insufficient when adaptive scheduling influences choices.

Add a strict replay consumer in the plan execution path. It executes the
next recorded action after checking that it is allowed by the current
state and plan, bypassing stochastic selectors and adaptive preferences.
It installs the recorded clock assignments, consumes each observation at
the matching node/incarnation/site/occurrence and `T`, and validates rate
bounds, interval containment, width, and numeric limits. It checks
monotonic results against the installed clocks. No missing choice falls
back to sampling. Unexpected observations, ineligible actions, unused
records at the recorded endpoint, and incompatible program or semantics
identities are replay errors. The artifact carries the endpoint and run
outcome, so a recorded capped execution can also be reproduced.

For a given compiled program, replay through both interpreter paths must
produce the same clock observations and client history, including when
text logging is disabled. Phase 3 extends this same format with pause
reservations, checkpoint identities, and resume/cancellation actions.

### Configuration

A `clock` block on `ExplorerConfig` in `spur-core/src/simulator/explorer.rs`
and on `PlanFileConfig` in `spur-core/src/simulator/plan_config.rs`:

- `rho`, default 0.
- `tt_width`, default 0.
- `rates`, `sampled` or `extremes`, default `extremes`.

A plan event `advance_time { ticks }` in `spur-core/src/simulator/path/plan.rs`
(`EventAction`), with parser/resolver support in `plan_config.rs`, requires
positive ticks. It completes when the advance executes, so dependencies
can order later reads or timer permissions. Add the strict replay artifact
input to the plan runner and validate that it matches the chosen program
and workload. Register `clock` with strict config-key validation and carry
it through grid, random, campaign, and per-run configurations. The generic
`--set` override mechanism needs no new syntax. The documentation in
`docs/simulator_options.md` lands with the fields.

### Counters

Clock reads, truetime reads, timed registrations, time advances, and
timers fired late, meaning eligible for more than one step before
delivery.

### Tests

`spur-core/tests/clock_effects.rs`, modeled on `timer_effects.rs`, with
fixtures under `tests/fixtures`:

- Readings never decrease across reads on one node.
- With equal origins and enough elapsed time to distinguish integer
  readings, a fast node reads ahead of a slow one at the same global time.
- A timed timer is excluded from delivery counts before its deadline,
  while a separate advance remains selectable. The firing row follows
  the advance in a later scheduler action, and delivery may be delayed.
- Clock-only protocols and the durationless `wait_after` example can
  advance time without any timed timers, even while work is runnable.
- An advance remains available with all protocol queues empty or all
  nodes blocked/crashed. Search exhaustion is not labeled deadlock.
- Zero duration is immediately eligible; negative duration is a runtime
  error. Negative origins and signed past deadlines work, and constructor
  overflow or an out-of-range clock result fails without wrapping.
- Fractional progress survives many small advances. Deadline conversion
  reaches the first eligible global tick for slow and fast rates.
- Intervals contain the observation time and respect the full width at
  zero, at either endpoint, and for asymmetric placement.
- The epoch survives a crash: the reading after recovery is at least the
  reading before.
- Under strict timers a labeled timed timer fires only with both the
  permission and the deadline. Permission alone leaves `T` unchanged.
  A plan without a needed advance reports incomplete execution.
- Durationless timers are unchanged.
- Exact replay preserves observations, dispatches, and client history
  with text logs on and off; malformed or mismatched artifacts fail.
- State identity and hashing cover changes to time, rate, origin, epoch,
  uncertainty, and timer deadline, using otherwise identical states.
- Both interpreter paths.

### Boundary reading

A perf grader session declared neutral with the argument above, and the
lite panel run with no `clock` block, which must read as parity.

## Phase 3: the placed pause

Lands at a later iteration boundary. It adds pause choices to clock-using
programs and fires nowhere on the existing panel because no existing spec
has a checkpoint.

### Placement

New `spur-core/src/simulator/pause_placement.rs`, modeled on
`fault_timing.rs`. A settable share of runs, `faults.pause_fraction` with
default 0, reserve one pause addressed as the k-th checkpoint the run
reaches, with k drawn log-uniformly from the clock stream. The other runs
reserve none, which forms the same internal placed-versus-stock contrast
the crash placement uses. Run-cap probes are exempt.

### Checkpoint execution

Only the record loops reach a checkpoint; synchronous helpers run through
their sync executor and never pause. On a reserved checkpoint the executor:

1. Completes the read or timed registration and stores its result.
2. Saves the local environment, trace/continuation state, and program
   counter at the next vertex, and commits the node environment.
3. Stores the interrupted record in a per-node pause slot on `State`,
   outside the runnable queues. The slot identifies the process
   incarnation, pause ID, checkpoint occurrence, and reservation source.
4. For an explorer reservation, queues
   `Runnable::Resume { node_id, incarnation, pause_id }` in that node's
   local queue with a priority drawn from the recover band. A plan
   reservation queues no automatic resume.

Without a reservation execution continues in the same step after the
read or registration.

### Ineligibility

`Ineligibility::rejects` blocks protocol `Record` execution on a paused
node, including records in the network queue. Other nodes continue to
run. Timers, channel notifications, time advances, and applicable system
fault actions are exempt from the pause gate and still obey their other
constraints. In particular, a crash of the paused node remains selectable.
`only_crashes_can_be_ineligible` adds a no-paused-nodes term, and all queue
counts and selections use the same gate.

Channel delivery may buffer a notification or queue a waiting record;
the woken record cannot execute until resume. Incoming handler records
remain queued. `crash_node` cancels the pause reservation, drops the
saved frame and matching resume, and discards volatile notifications and
waiting tasks. The interrupted frame is never put through crash
redelivery as a fresh external request.

Selecting a resume verifies its incarnation and pause ID, removes the
pause slot, records the resume, and directly executes the saved record
until its next scheduling boundary, reserved checkpoint, or return. These
are one scheduler action, so another handler cannot run between clearing
the pause and the saved record's first segment. Normal queue competition
resumes afterward. A stale resume cannot act on a recovered incarnation.
The saved record preserves any initialization continuation/barrier.

Extend `State::signature()` and semantic equality with pause slots,
their saved frames and identities, and armed checkpoint reservations.
Include checkpoint counts used to target a reservation, and the resume
identity in `Runnable::hash`. A state comparison cannot merge a paused
state with a runnable state or discard a pending resume obligation.
Diagnostic firing counters remain outside semantic identity.

### Plans and recording

- Plan events `pause { node [, checkpoint] }` and `resume { node }`.
  A pause arms a reservation for the current incarnation; optional
  `checkpoint` is a positive per-node occurrence in that incarnation,
  counting async-body clock reads and timed registrations. If omitted,
  use the next checkpoint. Synchronous helper reads do not count.
- A pause event completes only when the checkpoint is interrupted, so
  `pause -> advance_time -> resume` orders an actual pause interval.
  Explicit plans use only their own pause reservations. A resume event
  must depend on its matching pause, and queues its identified resume
  only when its dependencies are ready. Permit at most one armed or
  active pause per node; reject already-passed checkpoint targets.
- A crash cancels the armed or active pause and any matching unexecuted
  resume plan event. Mark canceled events as settled for dependency
  processing, record cancellation separately from completion, and never
  let them arm a pause or resume after recovery. An unreached checkpoint
  at the run limit leaves an incomplete plan.
- `OpKind::Pause` and `OpKind::Resume` rows identify node, incarnation,
  pause ID, checkpoint, and global time. Replay also records reservation
  placement and cancellation, including reservations that never fired.
- Run-variant bits for "pause reserved" and "pause fired".

### Counters

Checkpoints reached, pauses reserved, pauses fired, and pauses that
spanned a time advance.

### Tests

Extend `clock_effects.rs`:

- A paused node's handlers do not run while other nodes do.
- The interrupted task resumes before competing local and network
  handlers under every queue policy and within-queue selector.
- A timer notification can be delivered during the pause; its consumer
  executes only after the interrupted segment resumes and yields/returns.
- A crash during a pause is selectable and discards the saved frame,
  notifications, and resume. No old frame or resume runs after recovery.
- A pause in `RecoverInit` does not admit buffered handlers.
- A plan pause stays active until its explicit resume executes. Dependencies
  wait for the actual checkpoint, and crash cancellation settles them
  without applying a stale pause/resume to the recovered process.
- Exact replay preserves checkpoint choices and saved readings, including
  crash/cancellation and pauses after timed registration.
- State identity and hashing include the pause slot, saved frame,
  checkpoint reservation, and resume identity.
- A checkpoint with no reservation costs no step: steps per run are equal
  with `pause_fraction` 0 and with the reservation never drawn.

### Boundary reading

Declared neutral on the existing panel, since no checkpoint exists in it.
The panel members of phase 5 carry the search-affecting evaluation under
the lite loop's non-inferiority protocol.

## Phase 4: search heuristics

Not part of either boundary. Each is a proposal for the lite loop with its
own counter and non-inferiority reading, and each changes how the explorer
searches rather than adding a knob:

- Offer advances to representable global ticks immediately before, at,
  and after a deadline crossing, with protocol execution between advances.
  A fast clock may skip an integer local reading; do not invent a global
  time at which that reading exists.
- Aim a subsequent run's rate assignment using nodes that registered
  timed timers in prior runs. Do not change a rate within an execution.
- Bias the pause reservation toward a checkpoint that is followed by a
  persist or a send within the same segment.
- Comparison recognition through a compiler tag on `mono_now() + d`, only
  if the first three find nothing.

## Phase 5: acceptance specs and panel entries

Additive files under `bin/spur/panel/`. Clock-only cases can run once
phase 2 builds; pause cases require phase 3. Each has a clean control and
a manifest entry in `research/panel/manifest.json` under a new fault
class; the existing classes are F0, F2 and F3.

- `raft_lease_read_recv_anchor.spur` with `raft_lease_read_clean.spur`:
  Raft with lease reads (thesis section 6.4.1). Election and heartbeat
  timers are timed. The bug anchors the lease at acknowledgment receipt;
  the control anchors it at send time with a drift margin. Needs clocks,
  rates and purgatory; no pause.
- `raft_lease_cached_flag.spur`: the leader caches lease validity from a
  periodic clock read; the control checks per request. This is the
  pause-specific entry, and the manifest calls it an implementation-pattern
  mutant rather than a paper bug.
- `paxos_master_lease_forget.spur` on top of `paxos_host.spur`: a master
  lease grantor that forgets an outstanding grant after a crash; the
  control persists the expiry.

Traceanalyzer gains per-run time-advance and pause counts. The documents
that change with the specs: `spur/design/language.md`,
`docs/simulator_semantics.md`, `docs/simulator_options.md`,
`docs/tracing.md` and `docs/agent/language.md`.

## Order and risks

- Phase 1 now. Phase 2 at the next boundary. Phase 3 at the one after.
  Phase 5 clock cases as soon as phase 2 builds, and pause cases after
  phase 3. Phase 4 through the loop.
- The `Timer` struct grows by sixteen bytes for the optional deadline;
  recording, queue filtering, and advance selection add further costs.
  Measure these with clock-using acceptance specs as well as panel parity.
- The loader change for the truetime token is the one phase 1 item with a
  contract consequence; decide it before starting phase 1.
- The pause is worth its boundary only if the cached-flag panel entry
  finds its bug and the receipt-anchor entry does not need it. If both
  fall to clocks and delay alone, phase 3 waits for a protocol that needs it.
