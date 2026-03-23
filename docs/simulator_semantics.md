# Simulator Semantics

This document details the expected execution behavior of the Spur simulator, specifically around node failures and process initialization.

## Node Initialization & Recovery

All nodes in the simulator have a lifecycle that handles startup and potential crash-recovery cycles.

### Normal Initialization

Each node is required to have an `Init` function.

- **Synchronous Execution:** The `Init` function is executed synchronously at node startup.
- **Required:** Every node explicitly requires an `Init` block to specify its starting state.

### Recovery Initialization

Nodes can experience simulated crashes. When the simulator revives a node from a crashed state, it must run a recovery routine. In Spur, this is achieved by specifying an optional function, typically named `RecoverInit`.

- **Optional Implementation:** Unlike `Init`, `RecoverInit` is entirely optional.
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

Four partition shapes are available:

- **`isolate_one`** — One node is completely isolated from all others. No messages flow to or from the isolated node.
- **`halves`** — Nodes are split into two explicit groups. Cross-group messages are blocked; intra-group messages flow normally.
- **`majorities_ring`** — Each node can reach `floor(n/2)+1` nearest neighbors (including itself) arranged in a ring. No global quorum exists, which can expose bugs in majority-based protocols.
- **`bridge`** — Two halves connected only through a single bridge node. The bridge can communicate with everyone; non-bridge nodes can only reach nodes in their own half.

### Message Buffering During Partitions

Messages blocked by a partition are buffered in a **separate partition queue**, distinct from the crash queue:

- When a partition is activated, existing runnable messages that cross the partition boundary are moved to the partition queue.
- New messages created during the partition are checked at both creation time (for async RPCs) and dispatch time (for all message types). If the sender and receiver are on opposite sides of the partition, the message is buffered.
- Messages to the _same_ side of the partition are delivered normally.

### Crash–Partition Implementation and Interaction

Crashes and partitions are orthogonal. When both are active, the **crash check takes priority** over the partition check:

- A message to a crashed node always goes to the **crash queue**, even if a partition would also block it.
- A message to an alive node on the other side of a partition goes to the **partition queue**.
- A message to an alive node on the same side of the partition is delivered normally.

### Healing

When a partition is healed, all messages in the partition queue are drained with crash-awareness:

- Records destined for alive nodes are converted back to runnable tasks.
- Records destined for crashed nodes are moved to the crash queue (they will be delivered when that node recovers).
- Channel sends destined for crashed nodes are dropped, matching crash semantics for channel sends.

### Double Partition

Activating a partition when one is already active is a **no-op with a warning**, consistent with how `crash_node` handles double-crashes. Heal the existing partition before activating a new one.

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
    "w1": { "write": [0, "x", "1"] },
    "allow_election": { "allow_timer": [2, "election"] }
  },
  "dependencies": [["w1", "allow_election"]]
}
```

This means node 2's `"election"` timer can only fire after the write `w1` completes. Unlabeled timers are unaffected by `strict_timers` and may fire at any time.

### Timers and Crashes

- When a node crashes, all of its pending timers are **dropped**.
- If a timer fires while its node is crashed, it is silently discarded.

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
