# Spur Async Call Semantics: Implementation

This document sequences the contract in
[Async Call Semantics](async-call-semantics.md). The contract says which
executions are allowed; this document says which files change, in what order,
and what reading each step owes before it merges. Where the two disagree, the
contract wins and this document is wrong.

## Rules that apply to every phase

- Two interpreter paths exist in `spur/spur-core/src/simulator/core/exec.rs`:
  the label path (`Label::Instr(Instr::Async, ..)`, `exec_legacy`,
  `execute_common_label`, `exec_sync_inner`) and the compiled path
  (`Op::Async`, `exec_ops`, `run_common_op`, `run_sync_ops`). Every operation
  lands in both, and every behavioral test runs both.
- Simulator-core wiring lands only at a research-loop iteration boundary, with
  loops stopped, rebased on the latest merged state, verified on release builds
  only, with a perf grader session (`docs/agent/perf-grader-status.md`) and the
  lite panel reading. Boundary scaffolding is removed when the boundary closes;
  behavioral tests stay.
- Front-end work, specification migration and new files land between
  iterations.
- Every mechanism counts its own firing in
  `spur/spur-core/src/simulator/util_stats.rs`. A null result from an uncounted
  mechanism cannot be told apart from one that never ran.
- This change has no run-variant bit. It is a global semantics change, not a
  treatment applied to part of a session, so both graders read it on the
  cross-binary path: a candidate binary against a baseline binary, with the
  declaration written out. A bit would be wrong and the perf grader refuses one
  that names an instrument.
- `spur/` and `porcupine/` are submodules. Changes land there first; the
  superproject pointers move after.
- Code and documents follow `research/STYLE.md`.

## Phase 1: `spawn`, the discarded-channel error, and the migration

Lands between iterations. Goal: every local async call site says which of the
two meanings it has, and no execution changes. `spawn f()` compiles to exactly
what `f()` compiles to today.

### One instruction, two kinds

`Instr::Async` gains a kind, inline or detached, rather than a second
instruction. The compiler already knows which is which: `compile_rpc_call` in
`spur/spur-core/src/compiler/cfg.rs` emits remote calls, and
`compile_async_call_internal`, reached from `compile_func_call` with the target
fixed to `SELF_SLOT`, emits local ones. A remote call is always detached. A
local call is detached when it is written `spawn f()` and inline otherwise.

Touch points, from `rg -n 'Async' spur -g '*.rs'`:

- `spur-core/src/lexer.rs` - no change. `spawn` is already `TokenKind::Spawn`
  in the keyword map.
- `spur-core/src/parser.rs` - one alternative beside the existing
  `spawn<T>(e)` form in `primary_parser`, tried after it, so the `<` decides.
  A new `ExprKind` for the detached call, or a flag on the call expression.
- `spur-core/src/parser/format.rs` - the reformatter prints the new form.
- `spur-core/src/analysis/checker.rs` - `spawn` on anything but a local async
  call is a type error; a local async call in statement position is an error.
- `spur-core/src/compiler/cfg.rs`, `cfg/ir.rs`, `cfg/compiled.rs`,
  `cfg/compiled/check.rs`, `cfg/frame_layout.rs` and its test - the kind rides
  along. `frame_layout` reads the same slots either way.
- `spur-core/src/compiler/threaded/lower.rs`, `pure/lower.rs`, `pure/print.rs`
  - the state-threading and pure passes carry the kind.
- `spur-core/src/visualization/cfg.rs` - the rendered label says which kind.
- `spur-liquid/src/lower.rs`, `spur-liquid/src/ir.rs` - mark the new form the
  way the existing async call is marked. If the refinement crate is being
  removed, this touch point goes with it.
- `spur/editors/code/syntaxes/spur.tmLanguage.json` - no change is required.
  `spawn` is already in the `storage.type.spur` alternation and highlights in
  both forms. Moving it to `keyword.control.spur`, beside `for` and `return`,
  is optional and cosmetic.

### The discarded-channel error

The checker rejects a local async call whose value is discarded. The message
names `spawn f(args)` and `<- f(args)`. An RPC in statement position stays
legal.

This error is what makes the phase-3 flip visible. Every site it rejects is a
site whose meaning would otherwise change without anyone reading it.

### Migration

183 local async call sites, in 40 files. Nothing in the standard library:
`spur-core/src/stdlib/*.spur` declares no async function at all, because a free
function cannot be async.

| scope | files with sites | sites | received from | detached |
| --- | --- | --- | --- | --- |
| `bin/spur/` and `bin/spur/mencius/` | 13 | 95 | 14 | 81 |
| `bin/spur/panel/` | 17 | 69 | 0 | 69 |
| `spur/spur-core/tests/fixtures/` | 10 | 19 | 0 | 19 |

The 14 received-from sites are all `<- F(args)` in one expression, in
`Gryff.spur` (6), `EPaxosStar.spur` (6) and `sharded.spur` (2). They keep their
spelling and their meaning is the one the contract gives them.

The 169 detached sites collapse to nine idioms, and four of them cover 104
sites:

- `monitor_timeouts()` - 42 sites, in `Paxos.spur`, `Raft.spur`,
  `Raft_rtc.spur`, `VR.spur` and 17 panel clones, once in `Init` and once at
  the end of `RecoverInit`. Becomes `spawn`.
- `send_async(ch, resp)` - 38 sites, in `Raft.spur`, `Raft_rtc.spur`, `VR.spur`
  and 9 panel clones. The body is one `send`. Becomes a plain call.
- `resolve(ch, resp)` and `resolve_ch(ch, resp)` - 14 sites, in `Paxos.spur`,
  8 panel clones and 5 mencius variants. The body is one `>-`. Becomes a plain
  call.
- `monitor_suspicions()` - 10 sites, in the 5 mencius variants. Becomes
  `spawn`.

The rest are per-file decisions and each needs reading:

- `SDPaxos.spur`, 19 sites. `monitor_execution`, `do_view_changes`,
  `send_c_accept`, `send_v_request` and `send_new_view_and_wait` block before
  any effect and become `spawn`. `submit`, `handle_sequencer_accept`,
  `try_execute`, `start_view_change` and `send_c_commit` do not block first and
  are the ones to argue about: `try_execute` in particular drains an execution
  queue and would run to completion before its caller's next statement.
- `EPaxosStar.spur`, 23 detached sites. 17 are `BroadcastAccept` and
  `BroadcastCommit`, whose second statement receives from a local call that
  applies the decision to this node. Inline, applying locally and dispatching
  every peer's message becomes one segment with the caller. That is what a
  direct call does, and it is a decision to take deliberately.
- The 19 fixture sites are `Heartbeat`, `Sweep`, `Tick`, `Idle`, `Poll`,
  `Renew` and `Hold`, all called from `Init` or `RecoverInit`. All become
  `spawn`, so the fixtures keep testing what they test. `Renew`, `Poll` and
  `Hold` write state or read a clock before their first receive, so they are
  the fixtures that would change if they did not.

The rule for the migration: a call site becomes `spawn` when its caller must
not wait for the callee's first boundary, and a plain call otherwise. A helper
whose whole body is a send is never the first; a monitor loop is always the
second. Any site whose classification is not obvious gets `spawn`, which is the
behaviour it has now.

**When each half of that rule is written.** The `spawn` half is written in
phase 1. The plain-call half is written in phase 3, because until phase 3 a
plain call still means a task and a discarded one is the error above, so there
is no statement-position spelling in phase 1 that means "run inline". Phase 1
therefore writes `spawn` at all 169 sites, which is what keeps it from changing
execution or invalidating the panel, and phase 3 removes the keyword from the
sites this table classifies as inline. The classification is the reading work
and it is recorded here; the edit that acts on it belongs to the phase that can
carry it.

### Documents

- `spur/design/language.md` - the `Concurrency` section at `:712`, the
  `Restrictions` at `:824`, the `statement` production at `:84`, and the
  `primary_base` production at `:170`, which gains the second `spawn` form.
- `docs/agent/language.md` - the `Sync vs Async` section at `:249`, whose third
  bullet is the sentence this change makes false.
- `docs/simulator_semantics.md` - the three-queue routing table at `:106` names
  a locally spawned call as a local-queue record, which stays true of `spawn`
  and becomes false of a plain call.
- `.agents/skills/implement-protocol/SKILL.md` - two statements of the current
  rule, at `:129` and `:83`, and the checklist at `:137`.
- `docs/simulator_options.md`, `docs/tracing.md` and `AGENTS.md` state nothing
  about async call semantics and need no change. `AGENTS.md` carries only a
  pointer to the language reference.

In phase 1 these documents say that a detached task is written `spawn`. They
are rewritten again in phase 3, when a plain call stops meaning a task.

### Tests

- Parser and checker fixtures under `spur-core/tests`: `spawn f()` accepted in
  async bodies, synchronous bodies and `Init`; `spawn peer->H()` rejected;
  `spawn sync_helper()` rejected; a discarded local async call rejected with
  the message that names both forms; a discarded RPC accepted;
  `spawn<R>(k)` unchanged in a deploy function; `spawn<R>(k)` and `spawn f()`
  in one file.
- `spur check` passes on every specification under `bin/spur/` that compiled
  before, and on every fixture.
- A compiled-form test that `spawn f()` and the old `f()` produce the same
  instruction, so the phase changes no execution.

### Reading owed

None beyond the test suite. No execution changes, so no grader session.

## Phase 2: the frame stack

Lands at an iteration boundary. Goal: both interpreters keep an explicit frame
stack, and no execution changes. Declared search-neutral, with this argument:
the stack replaces Rust recursion for synchronous calls and is empty for every
record, so the runnable queues, the draw streams and the state signatures are
what they were. Parity compares existing semantic fields.

This is the phase that can lose throughput, and it is isolated here so that the
perf grader reads it alone.

### The frame

A frame is a program counter, a local environment, and what to do with the
return value: store it into a destination in the frame below, or deliver it to
a channel. `Record` gains a frame stack, empty unless the record was suspended
inside a nested call.

- `spur-core/src/simulator/core/state.rs` - the field, its entry in
  `Record`'s `Hash`, and `Record::reset` clearing it for crash re-delivery.
  Eight non-test sites construct a `Record` literal, in `core/exec.rs`,
  `core/partition.rs`, `core/scheduler.rs`, `core/state.rs` and `path.rs`.
- `PauseSlot` needs no change: it holds a `Record` and hashes it.
- `State::signature` needs no change: it hashes the records in the queues.
- The waiting-reader layout assertions in `state.rs` still hold; a `Vec` is
  three words and the reader stays behind its `Arc`.

### The interpreter

`StepOutcome` and `Flow` gain a variant that enters a frame. Both record loops
and both synchronous entries handle it the same way:

- On entering a frame, the current environment is swapped out into the stack
  and the callee's environment becomes the hot local. Environment access stays
  a direct local read on every instruction; the stack is touched only at a call
  and a return.
- On returning, the top frame is popped, the hot local is swapped back, and the
  value is stored or delivered.
- On a scheduling boundary, the hot local and the stack move into the record.
- `Instr::SyncCall` and the synchronous op stop calling `exec_sync_inner` and
  `run_sync_ops` recursively and push a frame instead. A synchronous entry runs
  the same machine with a root frame that may not suspend, which is the error
  it raises today.
- A depth limit with a new `RuntimeError` variant naming the function and the
  limit. `spur-core/src/simulator/core/error.rs`.

### Counters

`util_stats` counts frames pushed, the deepest stack reached in a run, and
depth-limit errors. Without them a run that never nests cannot be told from a
mechanism that never fired.

### Tests

On both interpreter paths: deep synchronous call chains return the same values;
a synchronous call that reaches a channel operation still errors; the depth
limit fires with its own error; a crash during a nested synchronous call
discards the frames and re-delivery restarts at the entry.

### Reading owed

A perf grader session on the cross-binary path, declared `neutral`, with the
argument above written out. The primary reading is throughput. A parity run
over the panel specifications confirms identical outcomes, since nothing about
the schedule changed.

## Phase 3: the inline default

Lands at an iteration boundary, on its own, with nothing else in the candidate.
Goal: a local async call that is not `spawn` runs inline.

### Execution

`run_async_op` and the label-path arm split on the kind:

- Detached, or remote: what they do now. The delay draw, the priority draw,
  the record, the queue.
- Inline: allocate the channel, store it into the destination, push the
  caller's frame, continue in the callee's. No priority draw, no send-delay
  draw, no record: there is no send, so there is nothing a hold could apply to.
  The rule that every send takes the roll and the draw still governs detached
  local calls and RPCs, and is what keeps `purgatory.hold_local_sends` from
  moving any other send's values.

At a scheduling boundary the interpreter peels the frames above the caller's
call site into a record whose continuation delivers to the result channel, and
resumes the caller. The peeled record's entry function and arguments are the
callee's, so crash re-delivery rebuilds the callee's entry frame, as it does
for a spawned call now.

### Identity and replay

- `CLOCK_SEMANTICS_VERSION` in `spur-core/src/simulator/explorer.rs` is bumped,
  so an artifact taken before the change is refused rather than replayed
  against different semantics. `check_identity` in
  `spur-core/src/simulator/replay_artifact.rs` already enforces it.
- The replay corpus is invalidated and regenerated.
- Seeds do not carry across: the draw streams lose the per-call priority and
  delay draws.

### Counters

`util_stats` counts calls run inline, calls that returned without a boundary
and so never became a record, and calls that detached at a boundary. The second
of these is the number the throughput argument rests on.

### Tests

On both interpreter paths:

- A callee that returns without blocking creates no record, buffers its value,
  and lets a receiving caller continue in the same step.
- A callee that blocks on its first statement is indistinguishable from
  `spawn`.
- A callee that writes node state and then blocks: the caller sees the write
  when it resumes.
- A callee that issues an RPC and does not wait for the reply keeps running
  inline.
- A receive that finds a buffered value does not detach.
- Nested inline calls: the innermost blocks, the middle one returns, the outer
  caller resumes, all in one step.
- An inline call from a synchronous body and from `Init`.
- `spawn` keeps its record, its draws and its queue position.
- A crash while a callee is running inline leaves nothing behind; a crash after
  it detached re-delivers it at its entry.
- A pause reservation on a checkpoint inside an inline callee: until phase 4,
  the case must have a stated behaviour and a test that pins it, whether that
  is parking the whole stack or not offering the checkpoint.

### Reading owed

- A lite grader session on the cross-binary path, declared search-affecting.
- A perf grader session, throughput and the record-count counter.
- Panel recalibration, below. The boundary does not close until the manifest
  carries new rates.

## Phase 4: checkpoints in nested frames

Optional, and only after phase 3 has merged. With frames that survive a
scheduling boundary, a process checkpoint inside a synchronous helper or inside
an inline callee can park the whole stack and resume it, which is the
"finer process interruption" entry deferred in
[Time Handling](time-handling.md#deferred-extensions). It changes the atomicity
statement in `docs/simulator_semantics.md` that a helper is atomic with its
caller, so it is a contract change of its own and needs its own argument,
counters and boundary.

## Panel recalibration

Every member of `research/panel/manifest.json` carries an `expectedRate` and a
`calibration` block measured under the current rule. Eight members over twelve
specification files, each calibrated on tens of thousands of runs.

Phases 1 and 2 change no execution and invalidate nothing. Phase 3 does, and
the following have to be measured again before the boundary closes:

- `expectedRate` and `calibration.rateRuns` / `rateViolations` for each member.
  The search space is smaller, so a member's rate can move in either direction:
  fewer wasted schedules per run, but also fewer schedules that reach the bug.
- `calibration.cleanRuns` / `cleanViolations` and `hostCeiling`. The clean
  specification's false-positive count is a property of the same search and is
  not carried over.
- `runsPerSec`, `eventsPerSec` and `tauBestSec`, which are sizing inputs
  derived from the rates and the throughput, both of which move.
- `budgetRatio` and the panel wall, since a member's replicate count is sized
  against them.

The procedure is the one in `research/observations/PANEL_CALIBRATION.md`:
`cli panel-calibrate` at the host's thread count, every member on the candidate,
several seeds of its manifest replicates. A member whose rate collapses is
resized or retired, and the reason is recorded: a bug that was only reachable
through a window between a call site and a callee's entry is a bug in the
model, not in the protocol, and retiring it is the correct outcome rather than
a loss.

An A/A reading on the candidate binary, both arms at the same commit, comes
first. Without it a moved rate cannot be separated from the panel's known
over-dispersion.

## Order and risks

The three phases are ordered by what they can break.

1. Phase 1 breaks compilation and nothing else. Its failure mode is a
   specification that no longer compiles, caught by `spur check`.
2. Phase 2 breaks throughput. Its failure mode is a slower simulator, caught by
   the perf grader, and it is reversible on its own.
3. Phase 3 breaks the panel. Its failure mode is a search space that is
   different in a way nobody argued for, caught by the panel reading, and it is
   not reversible without a second recalibration.

Risks, in the order they are likely to bite:

- **The frame stack costs more than the records save.** The interpreter's inner
  loop is the simulator's hottest code and phase 2 touches it for every
  synchronous call, of which there are far more than async calls. The swap of
  the hot environment local is what keeps per-instruction cost flat; if it does
  not, phase 2 does not merge and phase 3 has no foundation. Phase 2 is
  sequenced first for exactly this reason.
- **The migration decides the result.** The contract does not reduce the search
  space; the 169 migration decisions do. A migration that writes `spawn`
  everywhere is correct, compiles, and buys nothing. A reviewer should read the
  52 sites whose callees do not block first, and treat a `spawn` there as a
  claim that the protocol tolerates an unbounded delay at that point. Those are
  the 52 single-send helpers, plus the `SDPaxos.spur` and `EPaxosStar.spur`
  sites whose callees do not block first and the four fixture sites that write
  state or read a clock before their first receive.
- **Panel rates move for two reasons at once.** Phase 3 changes both the search
  space and the throughput, so a rate per second moves even if the rate per run
  does not. Both numbers are reported.
- **A specification that depended on the window.** A protocol whose bug is only
  found through the call-to-entry window will stop being found. That is the
  intended outcome and it must be written down per member, not absorbed into a
  changed rate.
- **`EPaxosStar.spur` and `SDPaxos.spur` are the hard migrations.** Between
  them they hold 42 of the 169 detached sites and most of the ones whose
  callees do not block first. Neither is a panel member, so a wrong decision
  there is invisible to the panel reading and shows up only as a changed
  violation rate on a specification nobody is watching.
