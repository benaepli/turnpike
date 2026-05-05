# Language: Spur

Full grammar and reference: `spur/design/language.md`

## Program Structure

A Spur program consists of top-level definitions: `role` blocks, a `ClientInterface` block, `type` definitions, and standalone functions.

```
role Node {
    var state: int = 0;         // state variables with initial values

    fn Init(me: int, peers: list<Node>) { ... }          // required, sync
    async fn RecoverInit(me: int, peers: list<Node>) { ... }  // optional, for crash recovery

    @trace
    async fn HandleRequest(...) { ... }   // protocol handlers
}

ClientInterface {
    async fn Write(dest: Node, key: string, uid: int) { ... }
    async fn Read(dest: Node, key: string): list<int> { ... }
}
```

## ClientInterface Contract (Linearizability)

The simulator verifies linearizability by feeding `ClientInterface` call-response pairs to Porcupine under an **append-log `kv` model**: each key's committed value is the ordered list of write uids that have been applied. These functions are **required**:

- `async fn Write(dest: Node, key: string, uid: int)` — must return `()` only after the write is committed. The simulator injects `uid` as a unique identifier; the protocol appends it to the log for `key`.
- `async fn Read(dest: Node, key: string): list<int>` — must return the full committed log of write uids for `key` (empty list if nothing has been committed), only after the read completes.

If these are missing, have wrong signatures, or return prematurely, linearizability results are meaningless. Retry loops (e.g., redirect to primary) are common — the function must not return until the operation truly succeeds.

### Optional: RMW (Read-Modify-Write)

For protocols that combine blind writes with read-modify-write commands, `ClientInterface` may also declare:

- `async fn RMW(dest: Node, key: string, uid: int): list<int>` — appends `uid` to the key's log and returns the **prior** committed list (empty if the log was empty). Like `Write`, it must return only after the operation is committed.

Under the `kv_rmw` model, `Write` is a **blind overwrite** rather than an append: `Write(key, uid)` sets `kv_store[key] = [uid]`. RMW is the operation that grows the log. `kv_store` keeps the same shape as the `kv` model — `map<string, list<int>>` — and `Read` still returns `list<int>`.

**Two model variants** — `kv`: `Write` appends, no RMW. `kv_rmw`: `Write` overwrites, `RMW` appends-and-returns-old. The corresponding Porcupine flag is `-model kv` or `-model kv_rmw`; a spec picks one set of semantics.

**Validation.** The model checks `Read` against current state (same as `kv`) and additionally checks each `RMW`'s return value against the state observed at that linearization point. RMW errors are caught directly from the RMW response; reads still add useful coverage.

## Type System

- **Primitives**: `int`, `string`, `bool`
- **Tuples/unit**: `()`, `(T, U)`, ...
- **Collections**: `list<T>`, `map<K, V>` (all immutable)
- **Channels**: `chan<T>`
- **FIFO links**: `FifoLink<Role>` — ordered RPC channel to a peer (see below)
- **Optionals**: `T?` — either a value of type `T` or `nil`
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

- `Init` runs synchronously at startup (required)
- `RecoverInit` runs on crash recovery (optional); node starts receiving messages after first yield point
- Messages to crashed nodes are buffered and re-delivered on recovery
- Crashed nodes lose all in-memory state; only `persist_data` survives
- Timers are dropped on crash
