# Language: Spur

Full grammar and reference: `spur/design/language.md`

## Program Structure

A Spur program consists of top-level definitions: `role` blocks, one `client`
block, `type` definitions, standalone functions, and at least one `@deploy`
function that builds the deployment.

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
- Calling an async function **spawns a new background task** (record). If you don't await the returned channel, the task runs concurrently in the background while the caller continues. This is how you spawn background work like timeout monitors or replication handlers.

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

No duration parameter — the simulator controls when timers fire to explore different orderings.

## Simulator Semantics

- Role variable initializers run first, at startup and again on recovery
- `Init` runs at startup if the role defines it (optional, no parameters)
- `RecoverInit` runs on crash recovery (optional); node starts receiving messages after first yield point
- A node's role parameter is supplied again from the deployment on every recovery; it is never persisted
- Messages to crashed nodes are buffered and re-delivered on recovery
- Crashed nodes lose all in-memory state; only `persist_data` survives
- Timers are dropped on crash
