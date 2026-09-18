# Language: Spur

Full grammar and reference: `spur/design/language.md`

## Program Structure

A Spur program consists of top-level definitions: `role` blocks, one `client`
block, `type` definitions, standalone functions, and at least one `@deploy`
function that builds the deployment. A file may open with `use` declarations,
which import from other modules (see "Modules" below).

```
type Cluster {
    @quorum nodes: list<Node>;   // a group majorities are drawn from
};

type ClusterParams {
    @scale n: int;               // the explorer varies this field
};

role Node(cluster: Cluster) {
    var me: int = index_of(cluster.nodes, self)!;   // integer identity
    var replicas: list<Node> = cluster.nodes;
    var state: int = 0;

    fn Init() { ... }                    // optional, no parameters
    async fn RecoverInit() { ... }       // optional, for crash recovery

    @trace
    async fn HandleRequest(...) { ... }  // protocol handlers
}

fn cluster(n: int): Cluster {
    var nodes: list<Node> = spawn<Node>(n);
    var c: Cluster = Cluster { nodes: nodes };
    provide_all(nodes, c);
    c
}

@deploy(client = KVClient)
fn Main(p: ClusterParams): Cluster? {
    if (p.n < 1) { return nil; }
    cluster(p.n)
}

client KVClient(sys: Cluster) {
    async fn Write(dest: Node, key: string, uid: int) { ... }
    async fn Read(dest: Node, key: string): list<int> { ... }
}
```

### Roles and `self`

- A role and a client each take exactly one read-only parameter, in scope in the
  block's variable initializers and in all of its functions.
- `self` is a keyword: inside `role R` it is a handle of type `R`, inside
  `client C` a handle of type `C`. The integer identity is an ordinary role
  variable, by convention `var me: int = index_of(cluster.nodes, self)!;`.
- `Init` and `RecoverInit` take no parameters and return unit. Both are
  optional, and either may be `async`.
- Variable initializers run before `Init` at startup, and again on recovery
  before `RecoverInit`, so identity and peer lists are recomputed after a crash.
- A role's parameter is supplied by the deploy function. A client's parameter is
  the deployment root.

### Deploy functions

A `@deploy(client = C)` free function builds the nodes of a run:

- `spawn<R>(k): list<R>` allocates `k` handles of role `R`. No node runs yet.
- `provide(h, v)` and `provide_all(hs, v)` bind a role parameter to a handle or
  a list of handles. Every spawned handle must be provided exactly once.
- The function returns `T?`. `nil` rejects the parameter tuple, which the
  explorer skips; it is not an error. `T` must equal the client's parameter type.
- A deploy may not do anything requiring a running node (`self`, RPCs, channels,
  timers, `fifo`, `unique_id`, persistence). The restriction follows calls, so
  helper functions such as `cluster` above are covered too.
- The allocation builtins work only while a deploy runs. Calling one from role or
  client code is a runtime error.
- Spawn order assigns global node indices `0..N`; these indices are the node
  identity in every log, trace and payload. Every `list<R>` in the returned value
  is a group that plan configs and partitions can name by its path, for example
  `nodes` or `shards["east"].nodes`.

### Parameter tags

The deploy parameter struct's fields carry exactly one tag each:

- `@scale` on an `int` — the config gives `{ "min", "max", "step" }`, and the
  explorer prefers small values.
- `@choice` on `int`, `bool`, `string`, or a payload-free enum — the config gives
  a JSON array of values.

`@quorum` on a `list<R>` field marks a group that generated `majorities_ring` and
`bridge` partitions prefer. `@trace` on a role or client function is unchanged.

## Modules

A file is a module and the module tree is the directory tree. A one-file spec is
a one-module program and needs nothing: no `spur.json`, no `pub`, no `use`.

- The module path `s1::s2::...::sn` names `<root>/s1/s2/.../sn.spur`, where
  `<root>` is the directory holding the crate's `spur.json`, or the entry spec's
  own directory when there is none.
- Only files a `use` reaches are loaded.
- `::` separates module and item segments. `.` keeps every meaning it has.

```
use raft;                    // the module
use raft::Node;              // an item
use raft::Node as Replica;   // under another name
pub use raft::Node;          // and re-export it
use std::quorum;             // the standard library

type ShardedKV {
    shards: list<raft::Cluster>;   // an inline path needs `use raft;` here
};
```

A `use` path is **crate-absolute**: its first segment is a dependency alias,
`std`, or a top-level module of this crate. An inline path is
**binding-relative**: its first segment is a module bound in this file, which is
what a `use` installs. The entry spec's own items cannot be imported, so shared
items live in a library module.

**Visibility.** An item is `pub` or private; private means visible in the
declaring module and its descendants. A role's functions carry the bit too, and
an RPC call to a handler private to another module is a type error. Runtime
lookups ignore it, so `Init`, `RecoverInit`, `Write`, `Read` and `RMW` are
dispatched whatever the bit says.

**Qualified names.** An item's display name is `<module path>::<name>`, and a
compiled function is `raft::Node.AppendEntries` -- `::` for the module part, `.`
between a role and its function. `traces.function_name` and a plan's
`deliver.function` use that spelling. A one-module program's names are unchanged,
so every config in this repository stays correct.

**Crates.** A `spur.json` names `root`, `deps` (paths only) and `presets`. It
never lists modules. A `.spur` path given to the CLI is always its own entry
under an implicit manifest, even when a `spur.json` sits beside it.

**Standard library.** `std` is compiled into the binary and bound in every
module, so `std::quorum::f(n)` needs no `use`. It holds `std::quorum`,
`std::lists`, `std::maps`, `std::route` and `std::retry`, all over primitives and
collections of primitives -- `spawn<R>` takes a concrete role, so a cluster
builder or a retry-to-leader loop belongs in the protocol's own module. `lists`
and `maps` are plural because `list` and `map` are keywords and cannot be path
segments. A free function cannot be `async`, so a retry loop that awaits an RPC
lives on a role rather than beside it.

## Client Contract (Linearizability)

The simulator verifies linearizability by feeding the client's call-response
pairs to Porcupine under an **append-log `kv` model**: each key's committed value
is the ordered list of write uids that have been applied. These functions are
**required**:

- `async fn Write([dest: R,] key: string, uid: int)` — must return `()` only
  after the write is committed. The simulator injects `uid` as a unique
  identifier; the protocol appends it to the log for `key`.
- `async fn Read([dest: R,] key: string): list<int>` — must return the full
  committed log of write uids for `key` (empty list if nothing has been
  committed), only after the read completes.

`dest` is optional per operation. When present it is the first parameter and its
type is a role; the simulator draws a destination among that role's nodes. When
absent the operation routes itself from the client parameter. Other functions in
a client are helpers and are never called by the simulator.

If these are missing, have wrong signatures, or return prematurely,
linearizability results are meaningless. Retry loops (e.g., redirect to primary)
are common — the function must not return until the operation truly succeeds.

The `executions` table records these as `Client.Write`, `Client.Read` and
`Client.RMW`, whatever the client is named.

### Optional: RMW (Read-Modify-Write)

For protocols that combine blind writes with read-modify-write commands, the
client may also declare:

- `async fn RMW([dest: R,] key: string, uid: int): list<int>` — appends `uid` to
  the key's log and returns the **prior** committed list (empty if the log was
  empty). Like `Write`, it must return only after the operation is committed.

Under the `kv_rmw` model, `Write` is a **blind overwrite** rather than an append:
`Write(key, uid)` sets `kv_store[key] = [uid]`. RMW is the operation that grows
the log. `kv_store` keeps the same shape as the `kv` model —
`map<string, list<int>>` — and `Read` still returns `list<int>`.

**Two model variants** — `kv`: `Write` appends, no RMW. `kv_rmw`: `Write`
overwrites, `RMW` appends-and-returns-old. The model follows from the client and
is recorded in the `deployments` table, so Porcupine's `-model` flag is optional.

**Validation.** The model checks `Read` against current state (same as `kv`) and
additionally checks each `RMW`'s return value against the state observed at that
linearization point. RMW errors are caught directly from the RMW response; reads
still add useful coverage.

## Type System

- **Primitives**: `int`, `string`, `bool`
- **Tuples/unit**: `()`, `(T, U)`, ...
- **Collections**: `list<T>`, `map<K, V>` (all immutable)
- **Channels**: `chan<T>`
- **FIFO links**: `FifoLink<Role>` — ordered RPC channel to a peer (see below)
- **Optionals**: `T?` — either a value of type `T` or `nil`
- **Role handles**: `R` for a role or client `R` — the type of `self` and of `spawn<R>` results
- **Structs**: `type Name { field: Type; ... };`
- **Enums**: `type Name enum { Variant1, Variant2(T), ... };`

## Key Syntax

### RPCs

```
var result_chan: chan<Response> = other_node->some_handler(arg1, arg2);
var result: Response = <- result_chan;   // blocks until response
```

Direct RPCs have **no ordering guarantee** between successive calls from A to B.

### FIFO RPC links

For protocols that assume TCP-like ordering between a pair of nodes, route
RPCs through a `FifoLink<T>`:

```
var link: FifoLink<Node> = fifo(peer);
var ch1 = link->Handler(args1);
var ch2 = link->Handler(args2);   // guaranteed to be delivered after ch1
```

- Multiple `fifo(peer)` calls create independent links (independent ordering).
- Link state is simulator-side, so ordering **survives receiver crash** —
  messages buffer across the crash and deliver in send order on recovery.
- Sender crash drops the in-memory link. Messages already enqueued drain in
  order; post-recovery `fifo(peer)` returns a fresh link unrelated to the old.
- FIFO orders _delivery_ (handler dispatch), not handler execution. Handlers
  at the receiver still run concurrently.

### Channels

- Create: `var ch = make();`
- Send: `value >- ch;` or `send(ch, value);`
- Receive: `var v = <- ch;` or `var v = recv(ch);`
- Channel ops only allowed in `async` functions

### Sync vs Async

- **sync** (default): blocking, atomic, cannot use channel ops
- **async**: returns `chan<T>` immediately, caller must `<-` to get result
- A **local** async call **runs in the caller**: the callee starts at once and
  the caller waits at the call site until the callee returns or reaches its
  first yield point (a receive with nothing buffered, a timer, a yield). Only
  then does the callee become a background task and the caller carry on.
- `spawn f(args)` starts the task without running any of it, so the caller does
  not wait even for the first yield point. Use it for work that must not run
  before the caller finishes -- a timeout monitor armed in `Init`, say.
- `<- f(args)` runs the callee in the caller and waits for its value.
- A sync function may call an async one: the callee spills into a task at its
  first yield point, so the synchronous caller never suspends. It still cannot
  `<-`.
- `spawn` applies only to a local async call. `spawn peer->H()` is an error
  because an RPC already starts a task, and `spawn sync_helper()` is an error
  because a synchronous call has no task. The deploy-only allocation
  `spawn<R>(k)` is a separate form.
- A **remote** call (`peer->H()`) always starts a task; it is a message.

### Immutable Updates (`:=`)

```
var updated = record.field := new_value;       // struct field update
var updated = my_map["key"] := new_value;      // map update
var updated = my_list[0] := new_value;         // list update
```

Desugars to `store(x, key, value)`. Original is unchanged.

### Safe Navigation

```
var val = optional_thing?.field;        // nil if optional_thing is nil
var val = optional_map?["key"];         // nil-safe index
var val = thing?.field ?? "default";    // with fallback
```

### Unwrap

`optional!` — unwraps the optional or panics if nil.

### Pattern Matching

```
match msg {
    MessageType.Prepare(data) => { ... },
    MessageType.Commit(data) => { ... },
    _ => { ... },
}
```

### Loops

```
for ;; { ... }                         // infinite loop
for i = 0; i < n; i = i + 1 { ... }   // C-style
for item in my_list { ... }            // for-in
for (key, val) in my_map { ... }       // destructuring
```

## Built-in Functions

- `println(s)` — print a string (shows in debug logs)
- `int_to_string(n)` — convert int to string
- `head(list)`, `tail(list)`, `len(collection)` — list operations
- `append(list, elem)`, `prepend(list, elem)` — return new list
- `store(collection, key, value)` — immutable update (usually via `:=` syntax)
- `exists(map, key)` — check if key exists in map
- `erase(map, key)` — return map without key
- `min(a, b)` — minimum of two values
- `index_of(xs, x)` — position of the first element equal to `x`, or `nil`
- `spawn<R>(k)`, `provide(h, v)`, `provide_all(hs, v)` — allocation, deploy functions only

## Persistence API

For data that survives crash/recovery:

- `persist_data(value)` — store to durable storage (one slot per node, overwrites)
- `retrieve_data<T>()` — returns `T?`, the stored value or nil
- `discard_data()` — remove persisted value

## Timers

```
var timeout_ch: chan<()> = set_timer();
<- timeout_ch;    // blocks until simulator fires the timer
```

`set_timer` has no duration — the simulator controls when it fires, to
explore different orderings.

Two constructors add a clock constraint. Both take the label as a trailing
argument and return `chan<()>`:

```
<- set_timer_after(100, "lease");     // 100 ticks on this node's clock
var deadline: int = mono_now() + 100;
<- set_timer_at(deadline);            // at that monotonic reading
```

A timed timer is not delivered before its owner's clock reaches its deadline,
and may be delivered much later. A negative duration is a runtime error; zero
is eligible at once. `set_timer_after` samples and registers in one step;
`set_timer_at` keeps an earlier reading, so a pause in between consumes part
of the interval.

## Clocks

```
var now: int = mono_now();        // this node's monotonic clock, in ticks
var bounds = tt_now();            // std::time::Interval { earliest, latest }
if (std::time::tt_after(t)) { }   // one fresh observation, strict compare
if (std::time::tt_before(t)) { }
```

- `mono_now()` is this node's own tick domain. Clocks run at rates inside
  `[1 - rho, 1 + rho]` with per-node origins, so a slow holder can still
  think a lease holds after a fast grantor thinks it expired. A reading sent
  to another node does not become a reading in its domain.
- `tt_now()` bounds absolute time at the moment of the read, with a full
  width at most `tt_width`. The value never advances afterwards; it need not
  contain the time at which its holder acts on it. Do not read the midpoint
  as an exact clock.
- Both need a running node: they are rejected in a deploy function and in a
  declaration initializer, through helper calls as well as directly.
- Reads are effectful. Order and count are preserved, a repeated read is
  never folded, and one `tt_now()` captures both endpoints together.
- Global time is hidden. The scheduler advances it as an action of its own,
  which runs no protocol code and fires no timer.

A read or a timed registration written directly in an async body is a
**process checkpoint**: with `faults.pause_fraction` set, the simulator may
freeze the process there, holding the value it captured while other nodes run
and time moves on. The same operation inside a synchronous helper is atomic
with its caller and never pauses.

## Simulator Semantics

- Role variable initializers run first, at startup and again on recovery
- `Init` runs at startup if the role defines it (optional, no parameters)
- `RecoverInit` runs on crash recovery (optional); node starts receiving messages after first yield point
- A node's role parameter is supplied again from the deployment on every recovery; it is never persisted
- Messages to crashed nodes are buffered and re-delivered on recovery
- Crashed nodes lose all in-memory state; only `persist_data` survives
- Timers are dropped on crash, including a timed timer already past its deadline
- The monotonic clock survives a crash: process failure is a process restart, not a reboot, so the clock keeps its rate, origin and epoch
- A crash cancels a paused process: its saved frame, its notifications and its resume are all discarded
