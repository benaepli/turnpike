# Simulator Semantics

This document details the expected execution behavior of the Spur simulator, specifically around node failures and process initialization.

## Node Initialization & Recovery

All nodes in the simulator have a lifecycle that handles startup and potential crash-recovery cycles.

### Normal Initialization

A node starts by running its role's variable initializers, then its `Init`
function if the role declares one.

- **Variable initializers:** At startup they run for every node in index order,
  before any `Init`. They may read `self` and the role parameter, so identity and
  peer lists are derived there.
- **No parameters:** `Init` takes no parameters and returns unit. It may be sync
  or async.
- **Optional:** A role without `Init` starts with just its variable initializers.

### Recovery Initialization

Nodes can experience simulated crashes. When the simulator revives a node from a crashed state, it runs the role's variable initializers again and then its `RecoverInit` function. `RecoverInit` takes no parameters and returns unit.

- **Optional Implementation:** `RecoverInit` is optional. Without it, recovery ends after the variable initializers.
- **Role parameter:** The role parameter is supplied again from the deployment on every recovery. It is never persisted, so a node's context and derived identity survive a crash even though its in-memory state does not.
- **Behavior After Recovery:** On recovery, the user's node starts receiving messages from other nodes in the network _immediately_ after the **first yield point** (the first blocking call or channel receive) of `RecoverInit`. Prior to that yield point, incoming messages will not be processed, ensuring the node can safely reinitialize critical state.

## Message Delivery During Crashes

During a crash, a node is offline and unable to process its message queue. This raises a question regarding the delivery semantics of messages dispatched to the crashed node by other active participants.

Spur handles this transparently:

- Messages sent _to_ a crashed node are **not dropped**, regardless of whether the sending node is alive or crashed.
- Instead, the simulator identifies the recipient is offline and buffers these records.
- Upon recovery, all buffered incoming messages are automatically re-injected into the node's runnable tasks queue.

This mechanism simulates a network where packets sent during a temporary outage are eventually delivered upon the target's return, preventing silent message loss.

### Return channels for buffered messages

When a message is buffered because the destination is crashed, it retains its original return channel (the `Continuation::Async` channel created by the RPC call). If the _sender_ also crashes before the destination recovers, the sender's record that was waiting on the return channel is dropped along with all of its in-memory state. When the destination eventually recovers and processes the buffered message, the return value is sent into the channel — but since no record is waiting to receive from it, the value is simply buffered in the channel and never consumed. This is safe and requires no special handling.

## Network Partitions

Spur supports network partitions that block message delivery between groups of nodes without crashing them. During a partition, nodes continue executing locally but cross-partition messages are buffered instead of delivered.

### Partition Types

Four partition shapes are available. `halves`, `majorities_ring` and `bridge`
apply to one **group** of the deployment: a `list<R>` value named by its path,
such as `nodes` or `shards["east"].nodes`. They constrain a message only when
both of its endpoints are members of that group. A message with an endpoint
outside the group — a client, a router, a node of another shard — is delivered.
Membership compares whole node identities, so a group's global indices need not
be contiguous. Self-messages are always delivered.

- **`isolate_one`** — One node is completely isolated from all others. No messages flow to or from the isolated node. This shape names a node, not a group.
- **`halves`** — The group is split into two sides. Messages between members on opposite sides are blocked; members on the same side communicate normally.
- **`majorities_ring`** — The group's members are laid out on a ring in group order. Two members are linked when their ring distance is at most `n / 4 + (n % 4) / 2` in integer arithmetic, the smallest symmetric radius that gives every member a direct majority counting itself. A valid ring has at least four distinct members; below that the rule links everyone, so it is not a fault at all and the event is rejected. The neighborhoods overlap and every supported size blocks some direct links, but the graph is not disconnected and protocols may still relay messages through members.
- **`bridge`** — The group is split into two halves connected only through a single bridge member. The bridge reaches every member; other members reach only their own half.

| Ring size | Radius | Members position 0 reaches | Blocked from 0 |
| --- | --- | --- | --- |
| 4 | 1 | 0, 1, 3 | 2 |
| 5 | 1 | 0, 1, 4 | 2, 3 |
| 6 | 2 | 0, 1, 2, 4, 5 | 3 |
| 7 | 2 | 0, 1, 2, 5, 6 | 3, 4 |
| 8 | 2 | 0, 1, 2, 6, 7 | 3, 4, 5 |

A generated partition picks its group among the deployment's groups:
`majorities_ring` among groups of at least four distinct members, `bridge` and
`majorities_ring` preferring `@quorum` groups when eligible ones exist, `halves`
among all non-empty groups, and `isolate_one` among all deployed nodes. A shape
with no eligible group is redrawn.

### Message Buffering During Partitions

Messages blocked by a partition are buffered in a **separate partition queue**, distinct from the crash queue:

- When a partition is activated, existing runnable messages that it blocks are moved to the partition queue.
- New messages created during the partition are checked at both creation time (for async RPCs) and dispatch time (for all message types). If the partition blocks that sender and receiver, the message is buffered.
- Messages the partition does not block are delivered normally.

### Crash–Partition Implementation and Interaction

Crashes and partitions are orthogonal. When both are active, the **crash check takes priority** over the partition check:

- A message to a crashed node always goes to the **crash queue**, even if a partition would also block it.
- A message to an alive node that the partition blocks goes to the **partition queue**.
- A message to an alive node that the partition allows is delivered normally.

### Healing

When a partition is healed, all messages in the partition queue are drained with crash-awareness:

- Records destined for alive nodes are converted back to runnable tasks.
- Records destined for crashed nodes are moved to the crash queue (they will be delivered when that node recovers).
- Channel sends destined for crashed nodes are dropped, matching crash semantics for channel sends.

### Double Partition

Activating a partition when one is already active is a **no-op with a warning**, consistent with how `crash_node` handles double-crashes. Heal the existing partition before activating a new one.

## Three-Queue Architecture

The scheduler maintains three queue groups rather than a single flat queue:

- **Local queues** — one per node, for local continuations and fault events.
- **Network queue** — a single shared queue for cross-node messages and partition/heal events.
- **Timer queue** — a single shared queue for all pending timers.

### Routing Rules

When a new runnable is created, it is routed to its queue based on type:

| Runnable type                      | Destination                    |
| ---------------------------------- | ------------------------------ |
| `Timer`                            | Timer queue                    |
| `ChannelSend`, `Partition`, `Heal` | Network queue                  |
| `Crash`, `Recover`                 | Local queue of the target node |
| `Record` (local: origin == node)   | Local queue of the node        |
| `Record` (remote: origin != node)  | Network queue                  |

A local `Record` is what `spawn f()` creates. A remote one is what an RPC
creates.

### Scheduling

Each simulation step proceeds in two phases:

1. **Queue selection** — the configured queue policy (`Probabilistic` or `Preemptive`) picks which queue group to draw from, falling through to non-empty alternatives if the chosen group is empty.
2. **Beam selection** — a K-tournament (K=10) over the chosen queue scores each candidate as `0.25 × novelty + 0.75 × priority` and picks the highest-scoring entry.

## Purgatory (Message Delays)

Purgatory is an optional mechanism that temporarily removes messages from the scheduler's view, simulating variable message latency.

- A hold applies to the **request half** of a message: the `Record` an async call creates (an RPC, or a client operation's call into a node) and a `ChannelSend` to a channel owned by another node. The reply to an awaited call is written into the caller's channel directly and is never held. Timers and fault events are never held.
- A send whose destination is the sending node itself, such as an async call a node makes on its own role, is a task on that node rather than a message on the network. It is never held unless `purgatory.hold_local_sends` is set.
- A send selected for a hold into a node that is currently crashed is let through when `purgatory.hold_down_receivers` is false.
- When a send is created, it has a `delay_probability` chance of entering purgatory instead of its queue. The selection roll and the duration draw happen for every send, including one the two toggles above let through, so switching a toggle changes only the sends it names and leaves every other send's draws in place. Exact replay records one delay entry per send.
- The delay duration is sampled log-uniformly from `delay_duration_range` (measured in simulation steps). The item becomes eligible for release after `current_step + duration` steps.
- At the start of each simulation step, eligible items are released from purgatory into their normal queue. Normal crash and partition checks then apply at scheduling time.

### Crash Interaction

A crash drops the held tasks the crashed node spawned on itself, with the rest of its volatile state. A held message from another node stays held: it is on the network, and meets the crash when it is scheduled, where it is buffered for redelivery on recovery like any other message to a crashed node.

### Partition Interaction

Purgatory bypasses partition checks at entry time — a message can be delayed even if no partition is active. On release, the message enters the normal scheduling path where partition checks apply. If a partition is active at release time and blocks the message, it is moved to the partition buffer.

## Quick-Fire Priority Boosting

When beam selection encounters a `Recover` event whose target node is currently crashed, the priority component of the score is boosted by `quick_fire_multiplier` (default 5.0):

- Normal score: `(0.25 × novelty + 0.75 × priority)`
- Quick-fire score: `(0.25 × novelty + w × priority) / (0.25 + w)` where `w = 0.75 × quick_fire_multiplier`

This makes recovery events more likely to be scheduled promptly after a crash.

## Timeouts

Spur models timeouts with the `set_timer()` built-in. It accepts an optional string label and returns a `chan<()>`.

```
var timeout_ch: chan<()> = set_timer();          // unlabeled timer
var election_ch: chan<()> = set_timer("election"); // labeled timer
<- timeout_ch;
// timeout has fired
```

The key design decision is that `set_timer` has **no duration parameter**. The simulator decides when the timer fires, allowing it to explore different timeout orderings across executions. This is essential for finding bugs that depend on the relative timing of timeouts, message deliveries, and other events.

The typical pattern is to receive from the timer channel in a loop, checking conditions after each timeout:

```
async fn monitor_timeouts() {
    for ;; {
        <- set_timer();
        // check conditions and act
    }
}
```

### Labeled Timers and DAG Plans

Labels give the plan system fine-grained control over timer ordering. When `strict_timers` is enabled in a plan config, labeled timers only fire when explicitly allowed by an `AllowTimer` event in the DAG:

```json
{
  "strict_timers": true,
  "events": {
    "w1": { "write": { "dest": "nodes[0]", "key": "x" } },
    "allow_election": { "allow_timer": { "node": "nodes[2]", "label": "election" } }
  },
  "dependencies": [["w1", "allow_election"]]
}
```

This means the `"election"` timer of `nodes[2]` can only fire after the write `w1` completes. Unlabeled timers are unaffected by `strict_timers` and may fire at any time.

### Timed Timers

`set_timer_after(duration [, label])` and `set_timer_at(deadline [, label])`
add a clock constraint to the same timer. `set_timer_after` samples the
node's monotonic clock and registers `reading + duration`; `set_timer_at`
registers the deadline it is given. Both return `chan<()>`, and the plain
`set_timer` is unchanged.

A timed timer becomes **eligible** only when its owner's monotonic clock
reaches its deadline. Eligibility, delivery and the resumption of the waiting
task are three separate events: an eligible timer may be delivered much
later, and there is no maximum lateness. A negative duration is a runtime
error; a zero duration, and a deadline already at or behind the reading, are
eligible immediately.

Under `strict_timers` a labeled timed timer needs both its `allow_timer`
permission and a reached deadline. A permission never advances time, and an
advance never grants a permission.

### Timers and Crashes

- When a node crashes, all of its pending timers are **dropped**, including
  a timed timer already past its deadline.
- If a timer fires while its node is crashed, it is silently discarded.

## Virtual Time

The public API uses `Duration`, `MonoInstant`, and `Timestamp`, with
[typed time algebra](../spur/design/language.md#time-values). Arithmetic is
exact rational arithmetic. Monotonic instants retain their clock owner and
epoch through messages and persistence; direct cross-clock comparisons and
foreign timer deadlines are runtime errors. The epoch survives process recovery.
There is no time-to-integer conversion. A fractional timer bound becomes
eligible at its ceiling on the concrete clock lattice. Negative durations
are rejected before rounding, and unrepresentable timer bounds fail.
Typed operations remain distinct through both interpreters. This introduces
no symbolic runtime or solver calls, and uses no refinement machinery.

A specification can declare [named durations](../spur/design/language.md#named-durations)
and relationships without choosing numeric timeout values. Before any role
initializer runs, each module-qualified timing block receives one positive
assignment, shared by all nodes and preserved across process recovery. The
assignment has a separate deterministic seed stream derived from the run's
clock seed and block name. A program without timing blocks consumes no duration
sampling draws.

The sampler solves homogeneous linear requirements with exact rational
arithmetic, samples a feasible rational witness, then clears denominators and
adds an internal scale based on distance from strict constraint boundaries.
The scale leaves at least 64 internal units of separation in duration space
from each strict boundary, without changing any ratio. If this precision
cannot fit the integer range, that witness fails as unrepresentable.
It never rounds a witness onto a grid that invalidates
a relationship. Equalities and strict inequalities remain exact. Contradictory
requirements, finite projection limits, and an unrepresentable sampled witness
are distinct run failures. The limits are 32 fields, 8192 projected inequalities,
and 4096 bits per rational component. This solves only the parameter domain;
protocol execution and scheduling remain concrete and incomplete exploration.
No unmentioned safety condition is added by the sampler.

Time advances prefer pending timer deadlines and include single internal-unit
steps. Other sampled advances also track the magnitude of the assigned durations,
so a large internal scale does not leave a clock-only wait effectively frozen.
Plans can advance a named duration or a rational multiple of it. Fractions round
up to a positive internal unit; no positive advance becomes a no-op.

The domain relationships are scale invariant. Whole executions need not be:
integer clock rounding and legacy `tt_width`
and `origin_spread` settings use internal units. Named durations do not silently
rescale those TrueTime assumptions. A domain accessor alone introduces no
process checkpoint and does not observe elapsed time.

The simulator keeps a hidden, nondecreasing global time `T`, counted in
abstract ticks. A tick is not an interpreter instruction, a scheduler step,
or a unit of host time. Protocol code cannot read `T`.

- `mono_now()` reads the executing node's monotonic clock,
  `origin_i + floor(rate_i * T)`, with `rate_i` inside `[1 - rho, 1 + rho]`.
  Origins and rates are drawn per node and recorded, and each reading is
  recomputed from `T`, so fractional progress survives many small advances.
  Readings never decrease but consecutive ones may be equal, and the clock
  keeps running while the process is paused or crashed.
- `tt_now()` returns a `std::time::Interval` that contains the global time at
  which it was taken, with a full width at most the configured `tt_width`.
  Its width and its placement around that time are both drawn, so the
  midpoint is not an exact clock. The value is immutable: it does not advance
  while it is stored, sent or persisted, and it need not contain the time at
  which its holder acts on it.
- `std::time::tt_after(t)` and `std::time::tt_before(t)` each take one fresh
  observation and compare one endpoint strictly. A false result means the
  observation does not establish the predicate, not that its opposite holds.

A **time advance** is a scheduler action of its own. It runs no protocol
code, fires no timer and costs one step whatever its size. It is offered
beside ordinary work, and it is the only action left when every queue is
empty, so a clock-only protocol and a durationless polling wait both make
progress without any timed timer in the deployment. A run with an advance
still available is never reported as deadlocked. In `run-plan` the scheduler
samples no advances: time moves only through `advance_time` events.

Process failure is a **process restart**, not a machine reboot: the
monotonic clock continues in the same epoch across a crash, with its rate and
origin unchanged, and persisted time values come back as the same integers.
Nothing inserts a recovery wait, a deadline conversion or a lease grace
period.

Numbers are signed 64-bit, like Spur's `int`. Negative origins, negative
readings and past deadlines are all valid; a clock result, a deadline sum or
a time advance outside the representable range is a runtime error rather than
a wrap.

A recorded execution can be taken again exactly: `record_replay` writes an
artifact per run and `spur replay` executes its actions and observations
rather than redrawing them. See
[Simulator Options](simulator_options.md#record_replay).

Lease validity, commit waits and recovery waits stay protocol code. The
simulator never supplies a missing safety check and never revokes authority
when a lease expires.

## Process Checkpoints and the Placed Pause

A clock read or a timed-timer registration written **directly in the body of
an async function** is a *process checkpoint*. The same operation inside a
synchronous helper is not: a helper runs to completion, atomic with its
caller.

With no reservation a checkpoint costs nothing: the read completes and
execution continues inside the same scheduling step. With one, the process
**pauses** after the read, holding the value it captured.

A pause is an injected fault, in the same sense as a crash:

- All protocol execution on that node freezes. Other nodes run, global time
  and the clocks advance, and incoming messages queue.
- Timers may become eligible and deliver their notifications, but no timer
  consumer or other handler on the paused node runs.
- A crash of the paused node is still selectable. It cancels the pause,
  discards the saved frame and the notifications and waiting tasks that were
  volatile, and settles any matching resume, so no old continuation resumes
  after recovery.
- A pause in `RecoverInit` does not release the initialization barrier: the
  node's buffered handlers stay queued.
- Resuming clears the slot and runs the interrupted segment until its next
  ordinary scheduling boundary, reserved checkpoint or return, all in one
  scheduler action. No other handler on the node can run in between,
  whatever the queue policy prefers.

`faults.pause_fraction` sets the share of runs that reserve one pause,
addressed as the k-th checkpoint the run reaches; it is `0` by default. A
plan arms its own with `pause { node [, checkpoint] }` and ends it with
`resume { node }`; a planned pause offers no automatic resume, and
`pause -> advance_time -> resume` orders an actual interval of time the
process spent held.

A successful lease check can therefore go stale before its caller acts. The
simulator preserves the result across the pause and lets the protocol take
its next action; it does not revalidate on the protocol's behalf.

Code between checkpoints and ordinary scheduling boundaries is
instantaneous. This first version does not model interruption between every
pair of statements, and a finding carries that atomicity assumption.

## Persistence

Spur provides three built-in functions for data that must survive crash/recovery cycles:

- **`persist_data(value)`** — Stores a value in durable storage for the current node. Each node has a single persistence slot; calling `persist_data` overwrites any previously stored value.
- **`retrieve_data<T>()`** — Returns `T?`. Yields the stored value if one exists, or `nil` otherwise. A runtime error occurs if the stored value's type does not match `T`.
- **`discard_data()`** — Removes the persisted value for the current node.

Persisted data lives outside the node's regular state. When a node crashes, all of its in-memory state (variables, channels, continuations) is wiped, but persisted data remains intact. This allows `RecoverInit` to restore critical state:

```
fn RecoverInit() {
    var saved = retrieve_data<MyState>();
    if saved != nil {
        // restore fields from saved!
    }
}
```
