---
name: implement-protocol
description: Generate a Spur protocol specification from pseudocode, with support for incremental implementation and optional paper PDF reference.
user-invocable: true
---

# Implement Protocol Specification

You are implementing a distributed protocol as a Spur specification from pseudocode. You will generate a `.spur` file, then test it with the debug workflow.

## Inputs

- **Pseudocode file** (required): text or markdown with the algorithm.
- **Scope description** (optional): natural language describing what to implement. Examples:
  - `"full"` or omitted: implement everything
  - `"core replication only, no view changes or recovery"`: subset
  - `"add crash recovery"`: incremental addition to existing spec
- **Paper PDF** (optional): a paper PDF for additional context.
- **Existing spec** (optional): an existing `.spur` file to modify instead of creating from scratch.
- **Scheduler config** (optional): config for testing; ask the user if not provided.

## Phase 1: Understand

1. **Read the pseudocode file**. Identify all procedures, message types, state variables, and invariants.

2. **If PDF provided**: Read the paper (focus on system model, algorithm sections, and correctness arguments — skip proofs, evaluation, and related work). Extract:
   - Fault model (how many faults tolerated, crash vs Byzantine)
   - Message delivery assumptions (reliable, FIFO, etc.)
   - Consistency guarantee (linearizability, sequential consistency, etc.)

3. **If existing spec provided**: Read it thoroughly. Understand what's already implemented and what's missing.

4. **Read existing specs for reference**: Look at specs in `bin/spur/` to understand idiomatic Spur patterns and conventions. Use these as style guides.

5. **Parse scope**: Determine what subset of the protocol to implement. Common scopes:
   - **Full**: all features including crash recovery, view changes, etc.
   - **Core only**: basic replication/consensus without fault tolerance
   - **No persistence**: skip `persist_data`/`retrieve_data`/`RecoverInit`
   - **Add feature X**: modify existing spec to add a specific feature

6. **Flag ambiguities and underspecifications**: As you read the pseudocode, actively look for and record:
   - Cases where the pseudocode doesn't specify what happens in an error or edge case
   - Ambiguous ordering (does step A happen before or after step B?)
   - Implicit assumptions not stated in the paper (e.g., "messages arrive in order")
   - Missing state transitions or unhandled message types
   - Do NOT silently resolve these — note each one and report them to the user.

## Phase 2: Design

Present a design to the user for approval before writing any code. Include:

1. **Message types** needed (structs/enums)
2. **Node state variables** and their roles
3. **Function mapping**: which pseudocode procedures map to which Spur functions, and whether each is sync or async
4. **Client design**: how Read and Write will work (which node they contact, retry logic), and whether the protocol also needs `RMW`
5. **What's in scope vs out of scope** based on the scope argument
6. **Deployment shape**: the types the deploy builds (a flat cluster, shards, routers), what each role receives as its parameter, and which explorer parameters the deploy takes
7. **Crash recovery strategy** (if in scope): what state to persist, how RecoverInit works

Wait for user approval before proceeding.

## Phase 3: Implement

### If creating a new spec:

Write the spec file to `bin/spur/<ProtocolName>.spur`. Follow this structure:

1. **Type definitions** — message types, log entry types, response types, the deployment type the roles share, and the deploy parameter struct:

```
type Cluster {
    @quorum nodes: list<Node>;
};

type ClusterParams {
    @scale n: int;
};
```

2. **`role Node(cluster: Cluster)`** block:
   - Identity and peers as variable initializers: `var me: int = index_of(cluster.nodes, self)!;` and `var replicas: list<Node> = cluster.nodes;`. They run at startup and again on recovery, so neither needs to be rebuilt by hand.
   - Remaining state variables with initial values
   - `fn Init()` — no parameters; side effects only, such as `spawn monitor_timeouts()`
   - `async fn RecoverInit()` — no parameters; if crash recovery is in scope
   - Protocol handlers (async functions for message processing)
   - Timeout monitors if needed (`async fn monitor_timeouts()`)
   - Node-local RPC handlers that the client calls (e.g., `async fn Write(key, uid)`, `async fn Read(key)`)
3. **Deploy function** — a free builder plus the entry point:

```
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
```

   Every spawned handle must be provided exactly once. Return `nil` for a parameter tuple the protocol cannot run, and the explorer skips it. A deploy may not use `self`, RPCs, channels, timers or persistence.

4. **`client KVClient(sys: Cluster)`** block:
   - `async fn Write(dest: Node, key: string, uid: int)` — must retry until committed
   - `async fn Read(dest: Node, key: string): list<int>` — must return the committed log of write uids for the key
   - `async fn RMW(dest: Node, key: string, uid: int): list<int>` — optional; appends `uid` and returns the prior list. Declaring it selects the `kv_rmw` model, where `Write` is a blind overwrite.
   - `dest` is optional per operation. Drop it when the client routes itself from `sys`.
   - All may handle redirects if appropriate
   - None may return until the operation truly completes

### If modifying an existing spec:

- Edit the existing file in place
- Preserve existing structure and working code
- Add new functions, state variables, and types as needed
- Mark any TODO items for features not yet implemented

### Implementation guidelines

- Use `@trace` on key protocol functions (message handlers, state transitions)
- Mark out-of-scope features with `// TODO: <feature>` comments
- Use `persist_data()` before yield points if crash recovery is in scope
- Collections are immutable — use `:=` for updates
- Sync functions are atomic and cannot use channel ops
- Calling an async function spawns a background task. Write `spawn f(args)` for one you do not wait for and `<- f(args)` for one you do; discarding a local async call's channel is a compile-time error. `spawn` applies to a local async call only, never to an RPC or a sync call.

## Phase 4: Review

Before moving to testing:

1. Verify every pseudocode procedure has a corresponding Spur function
2. Verify the client's `Read`/`Write` don't return prematurely
3. Verify variable initializers derive identity and peers from the role parameter, and that `Init` spawns the background tasks (timeout monitors, etc.) with `spawn`
4. If crash recovery is in scope: verify `persist_data` is called for critical state before yield points
5. Check all message type match arms are handled
6. Run `spur deploy bin/spur/<ProtocolName>.spur --params '{...}'` and confirm the node count, paths and groups are what the design intended
7. **Report implementation choices**: Explicitly list every point where the implementation had to make a choice not dictated by the pseudocode (e.g., "the paper doesn't specify whether to reset the vote counter on duplicate votes — I chose to ignore duplicates"). These are potential sources of bugs and may represent real underspecifications in the paper.
8. **Report flagged ambiguities**: Present the list of ambiguities and underspecifications identified in Phase 1. These are candidates for protocol bugs that testing may expose.

Present the complete spec to the user for final review.

## Phase 5: Test

1. If no scheduler config was provided, ask the user which scheduler config to use. Suggest starting with a small config for initial testing.

2. Chain into the debug workflow by invoking the debug-protocol skill with:
   - The generated/modified spec file
   - The selected scheduler config
   - The pseudocode file as the reference (the pseudocode reference input to debug-protocol)

## Important Reminders

- The Spur language reference is in `spur/design/language.md` and `docs/agent/language.md`
- Simulator semantics are in `docs/simulator_semantics.md`
- Debugging heuristics are in `docs/agent/debugging.md`
- Existing specs in `bin/spur/` are the best style reference
- The `client` block MUST have Read and Write, and a `@deploy` function must name it — Porcupine checks linearizability through these
- New specs go in `bin/spur/`
