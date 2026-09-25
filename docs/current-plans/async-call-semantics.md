# Spur Async Call Semantics

## Goal and scope

A call to an async function on the calling node runs inline, in the caller's
own task, until the callee reaches its first scheduling boundary. A call that
is meant to detach immediately says so with `spawn`.

This is a proposed contract. It covers local async calls only. RPCs
(`peer->Handler(args)` and `link->Handler(args)`) keep the semantics they
have: a message, delivered later, with no inline execution.

The reason is falsification fidelity. Between a call site and the first
statement of the callee, the current rule lets the caller's task end and
arbitrary other tasks on any node run. No implementation of a direct function
call can do that. Schedules that exploit that window are not schedules of the
system under test, so the budget spent on them is spent outside the search
space, and a violation that depends on one is a modelling artifact that has
to be recognized and discarded by hand.

The sequencing, the migration of every specification, and the panel
recalibration are in
[Async Call Semantics Implementation](async-call-semantics-implementation.md).

## Current implementation

- A local async call and an RPC are the same instruction. `Instr::Async` and
  `Op::Async` in `spur/spur-core/src/simulator/core/exec.rs` build a `Record`
  and enqueue it, differing only in the node the target operand evaluates to.
  The compiler already distinguishes the two: a local call is emitted by
  `compile_async_call_internal` with the target fixed to `self`, an RPC by
  `compile_rpc_call` in `spur/spur-core/src/compiler/cfg.rs`.
- A `Record` holds one `Env` and one `Continuation`. There is no call stack.
  Every async call is a channel round trip precisely so that none is needed.
- A synchronous call recurses on the Rust stack (`exec_sync_inner`,
  `run_sync_ops`), which is why a synchronous function cannot suspend: the
  interpreter has nowhere to put its frame.
- A local async call takes the selection roll and the duration draw from the
  send-delay stream like any other send, but purgatory no longer holds a node's
  sends to itself unless `purgatory.hold_local_sends` is set. The draws are
  taken whether or not the hold applies, so the toggle moves no other send's
  values.
- `Init` runs through `exec_sync_on_node`, so an async call made from `Init`
  already reaches the async instruction from a synchronous interpreter entry.
  Ten fixtures and several specifications rely on this.

## The contract

### Local and remote

A call is local when the callee is a function of the calling role or client
and no target is written. A call is remote when it is written with `->`,
whatever node the target names. `self->Handler()` stays a message to itself.
The two forms are distinguished by the compiler, not by comparing node
identities at run time, so a remote call whose target happens to be the caller
keeps message semantics.

### Running inline

A local async call:

1. Evaluates the target and the arguments in the caller's frame.
2. Allocates the result channel and stores it into the call's destination.
3. Builds the callee's frame and continues execution in it, in the caller's
   task, in the same scheduling step.

No `Record` is created at the call. The caller's task does not end, is not
re-queued, and takes no priority or delay draw.

### Detaching

The callee runs inline until its first scheduling boundary. A scheduling
boundary is exactly what makes a running task stop today:

- a receive from a channel with no buffered value;
- an explicit task yield, and a spin-await whose condition is false;
- a process checkpoint that the run's pause reservation interrupts.

At that boundary the callee's frame, and any frames it pushed, become a fresh
`Record` whose continuation delivers the return value to the result channel.
The record is registered where the boundary requires: as the channel's waiting
reader, on the node's runnable queue, or in the node's pause slot. The caller
then resumes at the instruction after the call, in the same scheduling step.

The callee suspends; the caller does not. This is what lets a synchronous
caller make an inline async call. `Init`, `RecoverInit` and every synchronous
helper run on the interpreter's own stack and cannot suspend, and they do not
have to: an inline callee that reaches a boundary spills into a record and goes
to the background, and the synchronous caller carries on at the next
instruction. The rule that a synchronous function cannot suspend is unchanged,
because it is the callee that suspends and the callee is async.

A receive that finds a buffered value is not a boundary. Sending on a channel
is not a boundary, local or remote. Issuing an RPC is not a boundary; only
receiving its reply is. Returning is not a boundary.

A callee that returns without reaching a boundary never becomes a record at
all. Its return value is placed in the result channel, and a caller that
receives from that channel finds it buffered and does not block either.

### Atomicity

The atomicity model is unchanged, and this is the point of defining the detach
rule this way: a task runs from its dispatch to its next scheduling boundary,
and a local async call introduces no boundary of its own. Everything from the
caller's dispatch, through the call, through the callee's body up to the
callee's first boundary, and on through the caller's remaining code to the
caller's own first boundary, is one segment.

An observer elsewhere on the node therefore cannot run between the call site
and the callee's first boundary. It can observe everything the callee wrote
before that boundary as soon as the caller's segment ends, which is no later
than it could observe them now.

Node variables are shared with the callee rather than copied. The interpreter
holds one node environment for the segment and writes it back at the segment's
boundary, so a callee sees the caller's writes made before the call and the
caller sees the callee's writes when it resumes. Under the current rule the
callee reads the node environment as it stands when the record is dispatched,
which is some later and unrelated point.

### `spawn`

`spawn f(args)` is an expression of type `chan<T>`. It evaluates the arguments,
allocates the result channel, builds the callee's frame, and enqueues it as a
task, exactly as a local async call does today. The callee has not run when the
expression completes.

- `spawn` applies only to a local async call. `spawn peer->H()` and
  `spawn sync_helper()` are type errors. An RPC already detaches and already
  says so with `->`; a second spelling for the same meaning would let one
  intent be written two ways and neither would be wrong.
- It is allowed wherever a local async call is allowed, which includes
  synchronous bodies and `Init`.
- It is the form to use for a task whose start time is meant to be free: a
  timeout monitor, a background replication loop, work whose completion the
  caller does not wait for and whose delay the protocol tolerates.

The keyword already exists: `spawn` is a reserved word in the lexer and is
used by the deploy-only allocation form `spawn<R>(k)`. The two are separated by
one token of lookahead, since the allocation form requires `<` immediately
after the keyword, and `<` and `<-` are distinct tokens. No specification uses
`spawn` as an identifier.

### Discarding a result channel

A local async call whose result channel is discarded is a compile error. The
message names both replacements: `spawn f(args)` for a detached task, and
`<- f(args)` to wait for the result.

This is not a transitional rule. Under the inline default, `f(args);` in
statement position asks for a call whose result is thrown away and whose
detach behaviour is invisible at the call site, which is the shape that is
being removed. An RPC in statement position stays legal: a message whose reply
is ignored is an ordinary thing to write.

Binding the channel is always legal: `var ch = f(args);` runs `f` inline until
it blocks and hands back the channel, and the caller may receive from it later.

### What does not change

RPC dispatch, FIFO link ordering and sequence numbers, client operation
dispatch, `Init` and `RecoverInit` entry, the crash and recovery model,
synchronous call semantics, and the rule that channel operations appear only
in async functions.

## Why not lazy

A third rule was considered: nothing runs until the result channel is received
from, as a Rust future does. It is rejected.

- A call whose channel is never received from becomes a silent no-op. Under
  both other rules that call has an effect; under this one the protocol
  quietly does nothing, and the specification still compiles and still passes.
- It removes the background task idiom, which every specification in the
  repository uses for timeout monitors. Expressing it would require a `spawn`
  keyword anyway, so the rule adds a failure mode without removing a keyword.
- The falsification argument does not support it. A lazy call moves protocol
  work to the point of the receive, which is a position no implementation of a
  direct call has either. It trades one unrealistic window for another.

## What the change buys, and what it does not

The saving is not automatic. Of 183 local async call sites in the
repository, 14 are received from immediately and 169 are detached today. The
169 do not all become inline calls: those that are genuinely background tasks
migrate to `spawn` and keep every interleaving they have now. The change buys
three things instead.

- **The call sites that were never tasks.** 52 of the 169 detached sites call a
  helper whose entire body is one channel send. Each costs a record, a priority
  draw, a delay draw, a queue insert, a dispatch and a node environment clone,
  once per client response, and buys a window that a direct call does not have.
  Inline, each costs a frame push.
- **The received-from sites.** Each of the 14 costs two scheduling boundaries
  today: one when the caller blocks on the channel, one when the callee's
  record is dispatched. Inline, a callee that does not block costs none.
- **The distinction itself.** The language has no way today to write "call this
  helper now". An author who means a call has to write a task, and a reader
  cannot tell which was meant. `spawn` makes the intent local to the call site
  and reviewable.

About 100 of the 169 detached sites call a function that blocks before it does
anything observable, usually `for ;; { <- set_timer(...); ... }`. Those behave
identically under both rules, so whether they are written `spawn f()` or `f()`
does not change any execution. They are still migrated to `spawn`, because the
spelling should say what the call is for.

## Failure and recovery

A crash discards every in-memory frame, including the caller's frames beneath
a suspended callee. A record re-delivered after recovery restarts at its entry
with its recorded arguments and an empty frame stack: a frame stack is
in-memory state and does not survive a crash any more than a local variable
does.

A callee that detached before the crash is an ordinary record and is handled as
one. A callee still running inline when the node crashes was never a record and
leaves nothing behind.

`RecoverInit` releases the initialization barrier at its first yield point.
Inlining moves work that used to happen after that release to before it. A
monitor called from `RecoverInit` arms its first timer before `RecoverInit`
returns, rather than at an arbitrary later dispatch. Migrating those call sites
to `spawn` preserves the current release point.

## Exploration and replay

- Fewer records means smaller runnable queues, so a scheduling step has fewer
  choices and the branching factor of the search falls. Whether that finds
  bugs faster is a measurement, not a claim.
- The state signature hashes the runnable queues and therefore the records in
  them. A record's frame stack is part of its identity and must be hashed:
  two states that differ only in the frames beneath a suspended callee are
  different states.
- The draw streams change. An inlined call takes no record priority draw and no
  send delay draw, so a seed does not reproduce the same execution across the
  change.
- Exact replay addresses a dispatch by queue position, node and program
  counter. Positions and counters both move: a detached callee enters a queue
  at its suspension point, not at its entry. Artifacts taken before the change
  must be rejected rather than replayed, which the recorded semantics version
  already provides for.
- Traces of an inlined callee record entry and exit within one scheduling step,
  so its dispatch latency is zero and its interleaving count is the caller's.

## The frame stack

Running a callee inline until it suspends requires the callee's frame to sit
above the caller's until the suspension, which the current `Record` cannot
express. The interpreter gains an explicit frame stack: a call pushes the
caller's return position and environment and continues in the callee's frame,
a return pops, and a suspension turns the top frame, or the whole stack, into a
record.

An explicit stack rather than Rust recursion, because:

- Spilling into a `Record` at a boundary is a move of an owned `Vec`, with no
  unwinding and no second representation of a frame.
- A checkpoint that interrupts a nested call has to save the caller's frames
  too, and they must survive a scheduling boundary. Rust frames cannot.
- The depth limit is a number rather than a stack probe, so the error is
  reported rather than a crash.

The same stack lets a synchronous call stop recursing on the Rust stack, which
is the one thing standing between the simulator and process checkpoints inside
synchronous helpers, deferred in
[Time Handling](time-handling.md#deferred-extensions). The two changes are the
same machinery: this one needs frames that outlive a call, that one needs
frames that outlive a scheduling boundary, and a stack that does the second
does the first.

Splitting them is still right. The frame stack alone changes no execution and
can be measured as a pure throughput change. The inline default changes
executions and needs the panel.

## Hazards

- **A callee that never reaches a boundary and never returns.** The caller is
  inside it forever. This is not new: a task in a loop with no receive hangs
  the run today, once it is dispatched. The change moves the hang from the
  dispatch to the call.
- **Unbounded inline recursion.** `async fn f() { f(); }` grows the frame
  stack without bound. Today the same program grows the runnable queue without
  bound, and the run dies on the step cap or on memory. A depth limit on the
  frame stack, with an error naming the function and the limit, is better than
  either. The limit is a constant, deeper than any specification a person
  writes and shallow enough that the stack stays small.
- **A silent change of meaning.** Every panel member carries a violation rate
  measured under the current rule. Flipping the default without migrating call
  sites first invalidates all of them at once and is indistinguishable from a
  mechanism regression. The `spawn` keyword, the discarded-channel error and
  the migration land before the default flips, so that every site that changes
  meaning was looked at.
- **Cost per record.** `Record` is the hottest structure in the simulator and
  gains a `Vec`. It is empty for a record that never suspended inside a nested
  call, which is every record a specification produces today, but it is a clone
  and a hash that were not there. Against that, records become fewer. This is a
  throughput measurement, not an argument.

## Open questions

- Whether a receive that finds a buffered value should detach anyway. Treating
  it as a boundary would make detachment a static property of the callee's
  text rather than of the run. It would also reintroduce a boundary where the
  current model has none, so the contract above does not do it.
- Whether a per-segment instruction budget is worth its cost, as a way to turn
  a non-terminating segment into an error instead of a hang. It is a check on
  the hottest loop for a hazard that already exists.
