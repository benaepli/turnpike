# Topology as Code in Spur

Design document. Every line reference below is to the tree at commit aea8a6f
(repository root /home/benaepli/Rust/turnpike, `spur` submodule at 45517fd)
unless stated otherwise. Paths under `spur/` are relative to the repository
root.

Contents

1. Summary and goals
2. Language surface
3. Static semantics
4. Dynamic semantics
5. Config schema
6. Explorer integration
7. Simulator and tooling changes
8. Worked examples
9. Migration of existing specs
10. Open questions
11. Phased implementation plan
- Appendix A. Rejected alternatives
- Appendix B. Deferred features and follow-up changes

---

## 1. Summary and goals

### 1.1 What exists today

The shape of a deployment is fixed in Rust and a single integer knob:

- The server role is found by the string "Node":
  - `spur/spur-core/src/simulator/explorer.rs:791` (`initialize_state`), `:847` (`init_topology`), `:1049` (`run_single_simulation`), `:1401` (`run_single_plan`).
  - `spur/spur-core/src/simulator/path.rs:679` (`exec_plan`), `:1338` (test).
  - `spur/spur-core/src/simulator/core/exec.rs:661` (timeline capture in `exec_legacy`).
  - `spur/spur-core/src/compiler/cfg/compiled.rs:219` (`CompiledProgram.server_role`, read at `exec.rs:1486`).
- The client role is found by the string "ClientInterface" (`explorer.rs:1055`, `:1407`). The parser rewrites the `ClientInterface` block into a role with that name (`spur/spur-core/src/parser.rs:1393-1402`).
- The simulator builds `Init(me: int, peers: list<Node>)` arguments itself (`explorer.rs:851-866`). The same arguments are rebuilt for `RecoverInit` (`spur/spur-core/src/simulator/core/scheduler.rs:2251-2269`). Function names are hard-coded strings: `"Node.Init"` (`explorer.rs:838`), `"Node.BASE_NODE_INIT"` (`explorer.rs:802`, `scheduler.rs:2200`), `"Node.RecoverInit"` (`scheduler.rs:2251`), `"ClientInterface.Write"` and friends (`path.rs:212-240`).
- `NodeId { role: NameId, index: usize }` (`core/state.rs:290-299`):
  - `State::with_channel_capacity` (`state.rs:908-926`) lays out `(role, count)` pairs with one global index counter. It stores the node's own handle in env slot 0 (`state.rs:922`).
  - Clients are appended later by `ClientPool::get` -> `State::add_node` (`path.rs:137-144`, `state.rs:1067-1079`). Every client index is therefore `>= num_servers`.
  - Many heuristics rely on "servers are indices `0..num_servers`", e.g. the doc comment at `scheduler.rs:1795-1797`.
- `path.rs:41-49` holds `enum Topology { Full }` and `TopologyInfo { topology, num_servers }`. `TopologyInfo` is threaded into `exec_plan` and the scheduler only to supply `num_servers`.
- Configuration:
  - `ExplorerConfig.num_servers_range` (`explorer.rs:185-186`) is the outermost grid loop (`explorer.rs:513`), drawn uniformly by the genetic explorer (`explorer.rs:674-676`) and mutated by +-1 (`explorer.rs:728`).
  - `curriculum.rs:148-151` rounds it to odd.
  - `PlanFileConfig.num_servers` (`plan_config.rs:188`) bounds integer node targets in every `EventSpec` (`plan_config.rs:91-154`).
  - `PartitionSpec` (`plan_config.rs:42-88`) is defined over `0..num_servers` of one role. Two of its shapes misbehave for client endpoints today (Section 7.12).

### 1.2 Goals

1. **The spec owns the deployment shape.** A spec says which roles exist, how many instances each has, and what every instance knows about the others. It says this in Spur, with Spur types, and it can express shapes beyond one flat cluster: several Raft groups, routers in front of shards, witnesses.
2. **The explorer varies typed parameters, not node counts.** The explorer knows a struct of parameters with tagged fields. It knows nothing about roles. Heuristics that want a "server count" or a "quorum" read them from the built deployment.
3. **Configs name nodes by meaning.** Plan configs refer to nodes and groups by typed paths into the deployment value (`shards[1].nodes[0]`), checked when the config loads.
4. **No hot-path cost.** A deployment is built once per parameter tuple, before any run with that tuple. It is shared by `Arc` across runs. A run's per-step work does not change: the node table has the same shape as today, the role parameter lives in an env slot, and no string lookups remain on any path that runs per record.
5. **No backwards compatibility.** Every spec in `bin/spur`, every JSON under `scheduler_configs/`, and the research harness inputs are rewritten. No phase keeps the old syntax parsing.
6. **Separate structural validation from fault semantics.** Phase 3a preserves behavior, including partitions. The coordinated topology migration includes the partition membership and ring adjacency fixes in separate commits (Sections 4.12 and 10.11). Single-cluster grid runs without partitions retain table parity, apart from the client action rename and removed Init arguments. Partitioned runs are checked against the new connectivity rules and measured separately before and after each fix (Section 11).

### 1.3 Non-goals

- Crash domains, oracle implementations behind interfaces, several clients per deployment, and the module system. Appendix B describes how the design leaves room for each.
- Bounding how many nodes are down at once is a follow-up change (Appendix B.6).
- Explorer-config restrictions on crash and partition candidates, and a string hash builtin for key routing (Appendix B.7, B.8).
- Refinement types. Nothing in this design reads or produces them. Parameter validity is expressed by a deploy function returning `nil`.

---

## 2. Language surface

### 2.1 Grammar changes

Written as a delta to `spur/design/language.md`. Productions not listed are unchanged.

```ebnf
top_level_def ::=
  role_def
  | client_def
  | type_def_stmt
  | func_def

(* A role and a client each declare exactly one parameter. *)
role_def   ::= 'role' ID role_param '{' var_inits func_defs '}'
client_def ::= 'client' ID role_param '{' var_inits func_defs '}'
role_param ::= '(' ID ':' type_def ')'

(* Annotations generalize the '@trace' prefix. *)
annotation      ::= '@' ID ( '(' annotation_args? ')' )?
annotation_args ::= annotation_arg ( ',' annotation_arg )* ','?
annotation_arg  ::= ID '=' qualified_name
qualified_name  ::= ID ( '.' ID )*

func_def  ::= annotation* ( 'async' )? 'fn' ID '(' func_params? ')' ( ':' type_def )? block
field_def ::= annotation* ID ':' type_def

primary_base ::=
  ...                                   (* existing alternatives *)
  | 'self'
  | 'spawn' '<' type_def '>' '(' expr ')'
```

Keyword changes:

- `ClientInterface` stops being a keyword. The `client_def` alternative that parses it (`parser.rs:1393-1402`) and the recovery token at `parser.rs:1421` are removed.
- `client`, `self` and `spawn` become keywords.
- `provide`, `provide_all` and `index_of` are ordinary builtin function names. They are parsed as `func_call` and resolved through `BuiltinFn` (`spur/spur-ast/src/name.rs:15-36`), like `role_to_string`. They need checker special cases, not grammar.
- `spawn` needs a type argument, so it is parsed like `retrieve_data<T>()` (`parser.rs:967-974`).

A grep of every `.spur` file found none of the new words used as an identifier except `self`. In 26 specs `self` is a role variable holding the node's integer index (e.g. `bin/spur/Raft.spur:27`). Section 9 renames it.

### 2.2 Role parameter and `self`

```
role Node(cluster: Raft) {
    var me: int = index_of(cluster.nodes, self)!;
    fn Init() { ... }
    async fn RecoverInit() { ... }
    async fn AppendEntries(...) { ... }
}
```

- The parameter name (`cluster`) is in scope in the role's variable initializers and in every function of the role.
- The parameter is read-only.
- `self` is an expression of type `R` inside role `R`, and of type `C` inside client `C`. It is the node's own handle, which today is env slot 0 (`spur/spur-core/src/compiler/cfg/ir.rs:22-34`).
- `Init` and `RecoverInit` take no parameters.

### 2.3 Handle allocation builtins

| Builtin | Type | Meaning |
| --- | --- | --- |
| `spawn<R>(k: int): list<R>` | `R` names a role (not a client) | Allocates `k` fresh handles of role `R`. No node runs yet. |
| `provide(h: R, v: P_R): ()` | `P_R` is `R`'s parameter type | Binds `v` as the parameter of the node `h`. |
| `provide_all(hs: list<R>, v: P_R): ()` | same | `provide(h, v)` for each `h` in `hs`, in list order. |

These builtins do something only while a deploy function is being evaluated (Section 3.4). Plain free functions may call them, so a library builder is an ordinary function:

```
fn cluster(n: int): Raft {
    var nodes: list<Node> = spawn<Node>(n);
    var r: Raft = Raft { nodes: nodes };
    provide_all(nodes, r);
    r
}
```

### 2.4 Other new builtins

| Builtin | Type | Meaning |
| --- | --- | --- |
| `index_of(xs: list<T>, x: T): int?` | `T` any type with equality | Position of the first element equal to `x`, or `nil`. |

`index_of` is the supported way to derive "my index". A spec that needs its
own position computes it as `index_of(group, self)!`.

A string hash for key routing is not part of this design (Appendix B.8).

### 2.5 Deploy functions

```
type RaftParams {
    @scale n: int;
};

@deploy(client = KVClient)
fn Single(p: RaftParams): Raft? {
    if (p.n < 1) { return nil; }
    cluster(p.n)
}
```

- `@deploy` marks a free function as an entry point. Its argument `client = C` names the client declaration that drives the deployment.
- The function takes one parameter whose type is a struct of explorer parameters. It may also take no parameters (Section 3.5).
- It returns `T?`, where `T` is the deployment root type. Returning `nil` rejects the parameter tuple.
- The function may coerce parameters, for example rounding an even replica count up to odd.
- A program may define several `@deploy` functions. The config or the CLI selects one (Section 5.1).

### 2.6 Parameter tags

These are written on fields of the deploy parameter struct.

| Tag | Field type | Config supplies | Consumed by |
| --- | --- | --- | --- |
| `@scale` | `int` | `{ "min", "max", "step" }` | Grid order (small first), genetic draw (biased small) and mutation (one step), curriculum `scale` knob |
| `@choice` | `int`, `bool`, `string`, or an enum whose variants carry no payload | a JSON array of values | Grid product (declaration order), genetic draw and mutation (uniform resample) |

A tag exists only together with a heuristic that consumes it. Section 6 specifies each consumer.

### 2.7 Protocol-structure tags

These are written on fields of any struct by the protocol module author.

| Tag | Field type | Consumed by |
| --- | --- | --- |
| `@quorum` | `list<R>` for a role `R` | Generated majority-style partitions (`majorities_ring`, `bridge`) choose among quorum groups (Section 4.12). This is the tag's only consumer. |

```
type Raft {
    @quorum nodes: list<Node>;
};
```

### 2.8 Clients

```
client KVClient(sys: Raft) {
    async fn Write(dest: Node, key: string, uid: int) { ... }
    async fn Read(dest: Node, key: string): list<int> { ... }
}
```

- A client has exactly one parameter. Its type must equal the root type `T` of every deploy that names it.
- Client operations are `Write`, `Read`, and optionally `RMW`. An operation may or may not take a `dest` parameter of a role type (Section 3.7).
- The Porcupine model follows from the client: `kv_rmw` if it defines `RMW`, otherwise `kv`.

---

## 3. Static semantics

### 3.1 Deployable types

A type is **deployable** when it is built only from:

- `int`, `string`, `bool`, `()`
- tuples, `list<T>`, `map<K, V>` and `T?` of deployable types
- structs whose field types are deployable
- enums whose payload types are deployable
- role handle types `R` (`Type::Role`, `spur/spur-ast/src/types.rs:19`)

Channels (`chan<T>`), FIFO links (`FifoLink<T>`), iterators and client handle types are not deployable. Channels and links are owned by a running node, and a deployment exists before any node runs. A client handle type cannot occur because clients are never spawned.

These three types must be deployable:

- a role parameter type
- a deploy parameter struct
- a deploy root type `T`

Recursive type references between roles are allowed: `role A(ctx: list<B>)` and `role B(ctx: list<A>)` type-check, because handles are plain values.

### 3.2 Role and client declarations

1. **Parameter.** The parameter is declared with a deployable type. Violations raise error `RoleParamNotDeployable`.
2. **Scope.** The resolver (`spur/spur-core/src/analysis/resolver.rs:584-615`) binds the parameter name in the role scope before variable initializers and function bodies are resolved.
3. **Name clashes.** A role variable, function parameter, or local with the same name raises `DuplicateName`. This is the existing duplicate-declaration error, extended to the role scope.
4. **Read-only.** Assigning to the parameter raises `AssignToRoleParam`. It cannot be updated with `:=` in place either; `ctx.f := v` produces a new value and does not rebind `ctx`.
5. **Init.** `Init` and `RecoverInit`, when present, must have zero parameters and unit return type. Violations raise `InitSignature`. Either may be sync or async; existing specs use both, e.g. `bin/spur/VR.spur:76` declares `async fn Init`. Both are optional.
6. **self.** `self` has type `Type::Role(R)` in role `R` and `Type::Role(C)` in client `C`. Outside roles and clients (free functions, deploy functions) it raises `SelfOutsideRole`.

### 3.3 `spawn`, `provide`, `provide_all`, `index_of`

1. **spawn.** `spawn<X>(k)`: `X` must resolve to a role declared with `role`, otherwise `SpawnNotRole`. A client name gets a dedicated message. `k` must have type `int`. The result type is `list<X>`.
2. **provide.** `provide(h, v)`: the static type of `h` must be `Type::Role(R)`, otherwise `ProvideTargetNotRole`. `v` must be assignable to the declared parameter type of `R` under the checker's ordinary assignability, otherwise `ProvideValueType`. The result type is `()`.
3. **provide_all.** `provide_all(hs, v)`: `hs` must have type `list<R>`. Otherwise the rules are those of `provide`.
4. **index_of.** `index_of(xs, x)`: `xs: list<T>` and `x` assignable to `T`. The result type is `int?`.

The handle's static type names the role, so `provide` needs no role argument.

### 3.4 Effects: node-bound

The checker computes one effect bit for every function, as a fixed point over the call graph.

- **node-bound**: the body contains an operation that needs a running node:
  - `self`, a role parameter or role variable, `->` RPC
  - `make`, `send`, `recv`, `<-`, `>-`
  - `set_timer`, `fifo`, `unique_id`
  - `persist_data`, `retrieve_data`, `discard_data`

  A function is also node-bound if it calls a node-bound function.

The only static effect rule: a `@deploy` function must not be node-bound (error `DeployNodeBound`). Because the bit propagates through calls, this also covers every function the deploy calls. Deploy functions are sync by construction, because free functions are already sync (`parser.rs:1404-1409`).

Today free functions are not restricted from calling `persist_data` and similar builtins. They run on the calling node; the checker only tracks sync versus async (`spur/spur-core/src/analysis/checker.rs:1947`, `:1976`). The node-bound bit is new.

`println` is not node-bound. During deploy evaluation its output goes to the session log.

Allocation is not tracked statically. `spawn`, `provide` and `provide_all` may appear in any function, and a free function that calls them may be called from role or client code. Executing one of them outside deploy evaluation raises the runtime error `AllocationOutsideDeploy` (Section 4.3). It is a spec bug, so it stops the session. When it surfaces depends on the mode:

- Deploy errors (Section 4.5) surface before any run in grid mode, which evaluates every tuple at session start. Genetic, AOS, continuous and campaign modes evaluate a tuple lazily, so its deploy errors surface at that tuple's first run.
- `AllocationOutsideDeploy` from role or client code surfaces in every mode at the first run that executes the call.

### 3.5 Parameter struct

A deploy's parameter type must be a struct (error `DeployParamNotStruct`). Every field must carry exactly one of `@scale` or `@choice` (errors `ParamFieldUntagged`, `ParamFieldTwoTags`):

- `@scale` requires `int` (`ScaleType`).
- `@choice` requires `int`, `bool`, `string`, or an enum none of whose variants carries a payload (`ChoiceType`).

A deploy may declare zero parameters: `@deploy(client = C) fn Name(): T?`. Its parameter space has exactly one tuple, the empty one.

### 3.6 `@deploy` signature

`@deploy(client = C) fn Name(p: P): T?`

1. The function is free. `@deploy` on a role or client function raises `DeployNotFree`.
2. It has zero parameters or one parameter of struct type `P` (Section 3.5).
3. The return type is `T?`, where `T` is deployable and not itself optional (`DeployReturnType`).
4. The `client` argument is required and must name a `client` declaration (`DeployClientMissing`, `DeployClientUnknown`).
5. `C`'s parameter type must equal `T` (`ClientParamMismatch`). Equality is by type identity, not assignability, so `Raft?` does not match `Raft`.
6. The function is not node-bound (Section 3.4).
7. Deploy names are unique among `@deploy` functions in the program.

Untagged functions that return deployment values are ordinary library code and are not entry points. A `@deploy` function may itself be called as an ordinary function.

### 3.7 Client operations

With `C` a client and `R` any role, the operation signatures are:

```
async fn Write([dest: R,] key: string, uid: int)
async fn Read([dest: R,] key: string): list<int>
async fn RMW([dest: R,] key: string, uid: int): list<int>      (optional)
```

Rules:

- `Write` and `Read` are required (`ClientOpMissing`). All three must be async (`ClientOpSync`) and must match these parameter and return types (`ClientOpSignature`).
- The `dest` parameter is optional per operation. If present it is the first parameter and its type is a role, never a client. Different operations may name different roles.
- An operation without `dest` routes itself using the client parameter and must not be node-bound in any way beyond what any async client function may do.
- Other functions in a client are allowed helpers. The explorer never calls them.
- The Porcupine model is `kv_rmw` if `RMW` is defined, otherwise `kv`. It is recorded per deployment (Section 6.7).
- Configs with `num_rmw_ops > 0` against a client without `RMW` are rejected when the config loads.

### 3.8 Tags

| Tag | Allowed on | Errors |
| --- | --- | --- |
| `@trace` | functions in roles and clients | `TagPlacement` elsewhere |
| `@deploy(client = C)` | free functions | Section 3.6 |
| `@scale`, `@choice` | fields of a struct | Type errors in 3.5. A struct with such fields that is not the parameter type of any deploy gets warning `TagWithoutConsumer`. |
| `@quorum` | struct fields of type `list<R>` | `QuorumType` otherwise. A struct not reachable from any deploy root type gets warning `TagWithoutConsumer`. |

Unknown tags raise `UnknownTag`. Repeating a tag on one item raises `DuplicateTag`.

### 3.9 Error catalog

All of the following are new `TypeError` or `ResolutionError` variants. Each needs an LSP diagnostic mapping in `spur/spur-lsp/src/diagnostics.rs`, next to `RpcCallTargetNotRole` at `:186-187`.

`RoleParamNotDeployable`, `AssignToRoleParam`, `InitSignature`, `SelfOutsideRole`, `SpawnNotRole`, `ProvideTargetNotRole`, `ProvideValueType`, `DeployNodeBound`, `DeployParamNotStruct`, `ParamFieldUntagged`, `ParamFieldTwoTags`, `ScaleType`, `ChoiceType`, `DeployNotFree`, `DeployReturnType`, `DeployClientMissing`, `DeployClientUnknown`, `ClientParamMismatch`, `ClientOpMissing`, `ClientOpSync`, `ClientOpSignature`, `TagPlacement`, `QuorumType`, `UnknownTag`, `DuplicateTag`.

Warning: `TagWithoutConsumer`.

New runtime errors, not checker errors: `RuntimeError::AllocationOutsideDeploy` (Section 4.3), and the deploy errors of Section 4.5.

---

## 4. Dynamic semantics

### 4.1 The deployment record

Evaluating a deploy function on one parameter tuple produces either a rejection or a `Deployment`. A new module, `spur/spur-core/src/simulator/deploy.rs`, defines:

```rust
pub struct Deployment {
    pub deploy: NameId,                    // the @deploy function
    pub client_role: NameId,               // the client declaration
    pub model: PorcupineModel,             // Kv or KvRmw, from the client
    pub root: Value<NoHashing>,            // the returned T
    pub nodes: Vec<DeployedNode>,          // index = NodeId.index
    pub role_counts: Vec<(NameId, usize)>, // for reporting only
    pub groups: Vec<Group>,                // Section 4.6
    pub canonical_params: ParamTuple,      // first tuple that built this deployment
    pub hash: u64,                         // Section 4.6
    // Per-node lookups precomputed once for heuristics (Section 7.3).
    pub fanout_width: Vec<u32>,
    pub crash_candidates: Vec<usize>,
}

pub struct DeployedNode {
    pub id: NodeId,               // role and global index
    pub ordinal: usize,           // position among nodes of the same role
    pub ctx: Value<NoHashing>,    // the provided role parameter
    pub path: Option<String>,     // canonical path from the root, if reachable
    pub groups: Vec<u32>,         // indices into Deployment.groups
}

pub struct Group {
    pub role: NameId,
    pub members: Vec<NodeId>,     // in list order
    pub quorum: bool,             // found under a @quorum field at any alias
    pub paths: Vec<String>,       // canonical first, then aliases, in walk order
}
```

Runs use `NoHashing` values (`explorer.rs:1060`, `:1412`), so the deployment stores `Value<NoHashing>`. The deployment hash is computed by its own structural walk (Section 4.6), independent of `HashPolicy`.

### 4.2 Where and when a deploy runs

- **Explorer.** The deploy runs on the explorer's control thread, once per distinct parameter tuple, before the first run of that tuple. The `DeployCache` (Section 6.2) memoizes it.
  - Grid mode evaluates every tuple of the finite product at session start.
  - Genetic, AOS, continuous and campaign modes evaluate a tuple the first time one is drawn.
- **run-plan.** The deploy runs once at load, with the fixed tuple from the plan file. Plan paths are resolved once, at the same time.
- **Sharing.** The resulting `Arc<Deployment>` is shared by every run of that tuple. Per-run work that depends on it is:
  - building the node table
  - running variable initializers and `Init`

  None of it grows with the step count.

### 4.3 Evaluation

The deploy function compiles to a CFG like any free function (qualifier `__free`, `spur/spur-core/src/compiler/cfg.rs:258-262`). Evaluation uses the existing synchronous interpreter (`exec_sync_on_node`, `core/exec.rs:92`) on a scratch context:

- a `State` with one pseudo node whose role is a reserved `NameId`, discarded after evaluation
- a new field `State.allocator: Option<Box<Allocator>>`, set only during evaluation

Three new CFG labels and compiled ops, `Spawn { role, count, dest, next }`, `Provide { handle, value, next }` and `ProvideAll { handles, value, next }`, read and write the allocator. Because node-bound operations are excluded statically (Section 3.4), the pseudo node is never observable.

In a correct spec a run never executes these ops. The added match arms in `run_sync_ops` and `execute_common_label` are cold. Reaching one without an allocator raises `RuntimeError::AllocationOutsideDeploy`, which stops the session (Section 3.4).

Evaluation is deterministic:

- The function is sync, has no randomness, no `unique_id`, and no timers.
- Map iteration order is a function of the map's contents.
- The result depends only on the program and the parameter tuple.

### 4.4 Allocation order and NodeId assignment

- Each `spawn<R>(k)` call takes the next `k` global indices in call order: the first call gets `0..k`, the next continues from `k`, and so on. The handles are `NodeId { role: R, index }`.
- `DeployedNode.ordinal` counts per role in the same order. It is used for display only (`Raft[2]`).
- The global index is the node's identity everywhere: the node table, `logs.node_id`, `traces.node_id`, `executions.client_id`, payload `VNode` values, `role_to_string`.
- The deployment occupies indices `0..N`, where `N = nodes.len()`. Clients are appended after it at run time (Section 4.10).

This keeps the existing invariant that the nodes a heuristic may crash come first and clients follow (`scheduler.rs:1795-1797`). With "servers" read as "deployed nodes" and `num_servers` read as `N`, those heuristics keep their meaning (Section 7.3).

`State::with_channel_capacity` (`state.rs:908-926`) takes `(role, count)` pairs and assigns indices grouped by role. `spawn` may interleave roles (A, B, A), so the constructor changes to take the per-index role list `&[NameId]` from `Deployment.nodes`.

### 4.5 End-of-evaluation checks and evaluation errors

Once the function returns, the allocator checks:

1. **Exactly once.**
   - Every spawned handle has been provided exactly once. A second `provide` for a handle fails at that call, with both call spans.
   - A handle never provided is reported when the function returns, listing the handles by role and ordinal and the spawn call span.
   - This is the only allocation check at run time.
2. **The tuple is rejected**: the function returned `nil`. This outcome is not an error.
3. **Reachability.** A spawned handle not reachable from the root value raises warning `UnreachableNode`, once per deployment. The node still exists and still runs. It has no path, so configs cannot target it, but generated plans still crash it.

Any other runtime error during evaluation is a **deploy error**. Examples: `!` on `nil`, an out-of-range index, negative `k` in `spawn`, a failed exactly-once check. A deploy error is a bug in the spec, not a property of the tuple, so the session stops before or at the first run of that tuple. The error names the deploy, the tuple and the source span.

In grid mode every tuple is evaluated at session start, so all deploy errors surface before any run. In lazily evaluating modes a deploy error surfaces at the first run of its tuple (Open question 10.5).

### 4.6 Derived semantics: the root walk

After a successful evaluation the simulator walks `root`, guided by the static type `T`:

- Structs are runtime maps keyed by field name. `x.f := v` desugars to `store(x, "f", v)` (`spur/design/language.md:252-258`), so the static type is needed to tell a struct from a map.
- Walk order:
  - struct fields in declaration order
  - list elements by index
  - tuple elements by index
  - map entries in ascending key order
  - `nil` optionals contribute nothing
  - enum payloads are walked but contribute no path segment (Section 5.4)

The walk records:

1. **A canonical path per handle.** This is the first path at which each handle occurs, and it fills `DeployedNode.path`.
2. **Groups.**
   - Every value of static type `list<R>` is a candidate group, including empty and single-member lists.
   - Groups are deduplicated by `(R, member sequence)`. The first path is canonical and later paths are aliases.
   - A group is a quorum group if any of its occurrences sits in a field tagged `@quorum`.
3. **Per-role counts,** taken from the allocation table rather than the walk, so unreachable nodes are counted.

Derived per-node values for heuristics:

- `fanout_width[i]`: the size of the largest group containing node `i`, minus one. If node `i` is in no group, it is `N - 1`.
- `crash_candidates`: every deployed index, in index order.

For a single flat cluster these equal today's `num_servers - 1` and `0..num_servers`.

**Deployment hash.** A 64-bit structural hash over:

- the deploy `NameId`
- the root value, walked as above: handles hash by `(role, index)`, maps by sorted entries
- each node's `(role, ctx)` in index order

On a hash match the explorer also compares the structures exactly. Two tuples are then the same deployment only if they are equal, not merely hash-equal.

### 4.7 Run start

For each run of a deployment `D`:

1. **Node table.** `State::with_roles(&D.node_roles(), slots)` creates `N` node envs.
   - Slot 0 holds `self` (as today).
   - Slot 1 holds `ctx` (`CTX_SLOT`), cloned from `D.nodes[i].ctx`. This is a refcount increment.
   - Role variables start at slot 2; `begin_role` starts them at 1 today (`compiler/cfg.rs:139-146`).
2. **Variable initializers.** For each node in index order, run `{Role}.BASE_NODE_INIT`. It may read `self` and the role parameter. This replaces the single-role loop in `initialize_state` (`explorer.rs:802-822`).
3. **Init.** For each node in index order, run `{Role}.Init` with no arguments if the role defines it. This replaces `init_topology` (`explorer.rs:826-880`).

Function lookups are resolved once per program into a `RoleTable { init, recover_init, base_init }` indexed by role `NameId`. No string formatting happens per run.

### 4.8 Handlers

- The compiler resolves the role parameter name to `VarSlot::Node(1, name)`. Every function of the role reads it like a role variable.
- Assignment is rejected statically, so no code path writes slot 1 after node creation.
- `node_env` is cloned per record (`exec.rs:649`, `:105`). That clone copies one more `Value` handle per env, a refcount increment.
- State hashing includes slot 1. The slot is constant within a deployment, so it cannot distinguish two states of one run.

### 4.9 Crash and recovery

- A crash wipes the node env exactly as today: `state.nodes[index] = Env::default()`, `scheduler.rs:2156`.
- `reinit_node` (`scheduler.rs:2190-2222`) sets slot 0 to `self`, sets slot 1 to `D.nodes[index].ctx`, then runs the role's `BASE_NODE_INIT`.
- `recover_node` (`scheduler.rs:2238-2300`) runs the role's `RecoverInit` with no arguments. If the role has none, recovery ends after the variable initializers, as today (`scheduler.rs:2251-2253`).
- The role parameter is never persisted and never read from `persist_data`. It is supplied again from the deployment on every recovery.
- The deployment reaches the scheduler through the value that replaces `TopologyInfo` (Section 7.3).

### 4.10 Client nodes

- `ClientPool` (`path.rs:119-150`) takes `D.client_role`.
- A newly created client node gets slot 0 set to its own handle and slot 1 set to `D.root`. Then it runs the client's `BASE_NODE_INIT`, replacing the `"ClientInterface.BASE_NODE_INIT"` lookup at `path.rs:358`.
- Recycled clients keep their env, as today.
- Client indices start at `N`.

### 4.11 Destination selection and payload normalization

When the plan generator emits a client operation `op` (`path/generator.rs:66-85`):

- **Operation with a `dest` parameter of role `R`.** The destination is drawn uniformly from all handles of role `R` in the allocation table, using the workload RNG. Today's draw is `rng.random_range(0..num_servers)`. The new draw is `rng.random_range(0..count(R))` over the role's handles in index order, which is the same draw when there is one role.
- **Operation without `dest`.** No destination is drawn. The client routes the operation using its parameter.

`ClientOpSpec` (`path/plan.rs`) changes from `Write(i32, key)` to `Write(Option<NodeId>, key)`, and likewise for `Read` and `Rmw`.

**Invocation row.** The `executions` payload of an invocation always has the fixed shape `[dest, key, uid]` (Write, RMW) or `[dest, key]` (Read). `dest` is the `VNode` value, or `VUnit` when the operation has no destination. The positional parsers are then unchanged in the Go tools that read `payload[1]` and `payload[2]`: `porcupine/checker/checker.go:191-245` and `traceanalyzer/metrics/dagorder/candidates.go:355-380`. The `executions.action` for client operations is `Client.Write`, `Client.Read` or `Client.RMW`, independent of the client's name (Open question 10.6).

### 4.12 Partitions over groups

A partition shape applies to one group of the deployment instead of to `0..num_servers`. `Halves`, `Bridge` and `MajoritiesRing` constrain a message only when both endpoints are members of that group. Messages involving a non-member, including a client, router or node of another shard, are delivered. This membership fix ships with Phase 3b in a separate commit; Phase 3a retains the existing rules for its strict parity check.

`PartitionType` (`spur/spur-core/src/simulator/core/partition.rs:11-28`) keeps `IsolateOne`, `Halves` and `Bridge` as they are. Their sides are computed from the chosen group instead of from `0..num_servers`. Only `MajoritiesRing` changes shape:

```rust
pub enum PartitionType {
    IsolateOne(NodeId),
    Halves { side_a: OrdSet<NodeId>, side_b: OrdSet<NodeId> },
    MajoritiesRing { ring: Vec<NodeId> },          // group order
    Bridge { bridge: NodeId, side_a: OrdSet<NodeId>, side_b: OrdSet<NodeId> },
}
```

`can_communicate(src, dest)` (`partition.rs:62-112`):

- `IsolateOne(x)`: blocked iff exactly one of `src` and `dest` is `x`. Unchanged.
- `Halves`: membership is the union of `side_a` and `side_b`, where `side_b` is the group minus `side_a`. If either endpoint is outside the union, deliver. Otherwise deliver only when both ends are on the same side.
- `Bridge`: membership is the union of `side_a`, `side_b` and the bridge. `side_a` is the group positions `0..len/2` and `side_b` the positions `len/2..len`, both without the bridge. If either endpoint is outside the group, deliver. For members, deliver messages to or from the bridge; otherwise both ends must be on the same side.
- `MajoritiesRing`: find each endpoint's position in `ring`. If either is absent, deliver without doing ring arithmetic. For two members, use their positions to compute `d = abs_diff(i, j)` and deliver iff `min(d, n - d) <= radius`. With `q = floor(n/2) + 1`, set `radius = ceil((q - 1)/2)`, the smallest symmetric ring radius whose direct neighborhood includes a majority. In integer arithmetic this is `n / 4 + (n % 4) / 2`. Valid ring partitions have at least four distinct members. Section 10.11 defines the adjacency and small-group policy.

Self-messages are always delivered. Membership compares complete `NodeId`s, not just roles or role-local ordinals. Global indices can be non-contiguous within a group. These rules describe a fault within a group; isolating a whole shard from its routers requires a separately expressed fault. Appendix B.5 records the rationale and measurement requirements.

The hash (`partition.rs:30-60`) covers `ring` in place of `num_nodes`.

Generated partitions (replacing `random_partition_spec`, `path/generator.rs:107-130`):

1. Draw the shape as today: `rng.random_range(0..4)`.
2. Choose where it applies:
   - `majorities_ring` draws among groups with at least four distinct members and no repeated handles, preferring quorum groups among those eligible groups. If no eligible quorum group exists, draw among all eligible groups.
   - `bridge` draws among non-empty quorum groups if any exist, otherwise among all non-empty groups.
   - `halves` draws among all non-empty groups.
   - `isolate_one` draws a node among all deployed nodes, as today's `0..num_servers`.

   When exactly one candidate group exists, no group-selection RNG draw is made. Rejecting an ineligible ring shape causes a shape redraw, so small-cluster partition generation intentionally consumes a different workload RNG stream after the ring fix. Phase 3a retains legacy eligibility and draws for parity.
3. Draw the members exactly as today, but over group positions.

A shape with no eligible group is skipped by redrawing the shape. A deployment with no nodes has no eligible shape; its partition pairs are dropped and counted in the session statistics.

---

## 5. Config schema

### 5.1 Explorer config

`num_servers` is removed. New top-level keys:

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `deploy` | string | the only `@deploy` in the program; an error if there are several | Qualified deploy name (Section 5.4) |
| `params` | object | required when the deploy has parameters | One entry per parameter field (Section 5.2) |

All existing workload and scheduling keys keep their meaning. `EXPLORER_CONFIG_KEYS` (`explorer.rs:360-396`) drops `num_servers` and adds the two keys above. The CLI flag `--deploy NAME` on `explore` and `run-plan` overrides `deploy`.

Explorer configs contain no node paths. Crash candidates are all deployed nodes, and partition candidates are all groups (Section 4.12). Restricting them by path is possible later work (Appendix B.7).

### 5.2 `params`

```json
"params": {
  "n": { "min": 3, "max": 7, "step": 2 },
  "mode": ["plain", "pre_vote"],
  "cache_leaders": [false, true]
}
```

- `@scale` fields take a `Range` (`explorer.rs:118-123`). `step` defaults to 1.
- `@choice` fields take a non-empty JSON array whose values are checked against the field type: numbers for `int`, booleans for `bool`, strings for `string`, and variant names as strings for enums.

Load-time checks, all errors:

- a field with no entry
- an entry with no field
- a wrong JSON shape for the tag
- `min > max`
- `step < 1`
- duplicate choice values

### 5.3 Plan config

`num_servers` is replaced by `deploy` and fixed `params`. Every node reference becomes a path.

```json
{
  "deploy": "Single",
  "params": { "n": 5 },
  "num_runs": 50,
  "max_iterations": 5000,
  "events": {
    "w1": { "write": { "dest": "nodes[0]", "key": "key1" } },
    "r1": { "read":  { "dest": "nodes[2]", "key": "key1" } },
    "c1": { "crash": "nodes[1]" },
    "v1": { "recover": "nodes[1]" },
    "t1": { "allow_timer": { "node": "nodes[2]", "label": "election" } },
    "p1": { "partition": { "type": "halves", "group": "nodes", "side_a": [0] } },
    "p2": { "partition": { "type": "majorities_ring", "group": "nodes" } },
    "p3": { "partition": { "type": "bridge", "group": "nodes", "bridge": 1 } },
    "p4": { "partition": { "type": "isolate_one", "node": "nodes[0]" } },
    "h1": "heal",
    "d1": { "deliver": { "function": "Node.AppendEntries",
                         "from": "nodes[0]", "to": "nodes[1]" } }
  },
  "dependencies": [["w1", "c1"], ["c1", "v1"], ["v1", "r1"]]
}
```

- `dest` is omitted for operations that take none, and required for operations that take one.
- `side_a` and `bridge` are positions in `group`, shorthand for `group[i]`.
- `deliver.function` is the qualified handler name as recorded in traces (`Node.AppendEntries` in a single file; `raft.Node.AppendEntries` once modules exist).

The in-memory forms change as follows:

- `EventSpec` (`plan_config.rs:91-109`) and `PartitionSpec` (`plan_config.rs:42-49`) change to the shapes above.
- `EventAction` (`path/plan.rs`) carries resolved `NodeId`s and group member lists instead of `i32`.
- `DeliverSpec.from` and `DeliverSpec.to` become `Option<NodeId>`.
- `AllowTimer` keys become `(NodeId, String)`.

### 5.4 Path syntax

```ebnf
path      ::= '$' | first_seg seg*
first_seg ::= ID | index_seg
seg       ::= '.' ID | '.' INT | index_seg
index_seg ::= '[' INT ']' | '[' STRING ']'
```

- `$` names the root value.
- `.ID` selects a struct field.
- `.INT` selects a tuple element.
- `[INT]` indexes a list, or a map with `int` keys.
- `[STRING]` indexes a map with `string` keys. The string uses JSON-style double quotes, escaped inside the JSON document: `"shards[\"east\"].nodes[0]"`.
- Optional types are traversed implicitly. A segment applied to `T?` applies to `T`.
- Enum payloads are not addressable.
- The deploy name in `deploy` is a `qualified_name` (Section 2.1): `Single` in a single file, `raft.Single` once modules exist.

### 5.5 Static validation at load

Every path in a plan config is checked against the static root type `T` taken from the program's deploy table (Section 7.1):

- Each segment must apply to the current type: a field that exists, a list or int-keyed map, a string-keyed map, or a tuple with the index in range.
- The final type must match the use:

| Use | Required final type |
| --- | --- |
| `crash`, `recover`, `allow_timer.node`, `isolate_one.node`, `deliver.from`, `deliver.to` | `Type::Role(R)` for a role `R` |
| `partition.group` (halves, majorities_ring, bridge) | `list<R>` |
| `dest` for operation `op` | equal to `op`'s `dest` parameter type |

A failed check is a config load error that names the path, the segment, and the type found.

### 5.6 Resolution against the plan's tuple

A statically valid path can still fail for a particular tuple: a list index out of range, a missing map key, or a `nil` optional on the way. A plan's tuple is fixed, so every such failure is a load error before any run:

- a path that does not resolve
- a `partition.group` that resolves to an empty list
- a `majorities_ring` group with fewer than four members or repeated handles
- a `side_a` or `bridge` position out of range for the group

### 5.7 `--set` overrides

`config_override.rs` descends only through objects (`set_path`, `:208-223`). Parameter ranges are objects, so `--set params.n.max=7` works. `check_override_paths` (`:162-185`) re-serializes the config, so `params` must round-trip through `Serialize` under its JSON names. Arrays (`@choice` values) are replaced whole: `--set 'params.mode=["plain"]'`.

### 5.8 Full example: `scheduler_configs/raft_debug.json` rewritten

```json
{
  "deploy": "Single",
  "params": { "n": { "min": 3, "max": 5, "step": 2 } },
  "num_write_ops": { "min": 2, "max": 5, "step": 3 },
  "num_read_ops": { "min": 1, "max": 3, "step": 2 },
  "num_crashes": { "min": 0, "max": 1, "step": 1 },
  "dependency_density": [0.3],
  "num_runs_per_config": 10,
  "max_iterations": 5000
}
```

---

## 6. Explorer integration

### 6.1 Parameter space

At load, the explorer reads the selected deploy's parameter struct from the program's deploy table and builds a `ParamSpace`: one axis per field, in declaration order.

- A `@scale` axis is the ascending list `min, min+step, ..., <= max`.
- A `@choice` axis is the config array, in the given order.

A `ParamTuple` is one value per axis, stored as axis positions plus the materialized Spur values.

### 6.2 Deploy cache

```rust
enum DeployOutcome {
    Rejected,                            // the deploy returned nil
    Built { id: u32, deployment: Arc<Deployment> },
}
struct DeployCache {
    by_tuple: HashMap<ParamTuple, DeployOutcome>,
    by_hash: HashMap<u64, Vec<u32>>,     // exact-compare on collision
    deployments: Vec<Arc<Deployment>>,   // id = position
}
```

- **Memoization.** A tuple is evaluated at most once per session. Rejections are cached.
- **Deduplication.**
  - After a successful evaluation, the cache looks up the deployment hash. If an existing deployment is structurally equal, the tuple maps to that deployment's `id` and is recorded as an alias.
  - Example: a deploy that rounds `n = 4` up to 5 makes tuples `n=4` and `n=5` one deployment.
  - The deployment's `canonical_params` is the first tuple that built it.
- **Scope.** The cache belongs to the explorer session. Campaign arms share one cache.
- **Deploy errors** stop the session (Section 4.5).

### 6.3 Grid mode

`ExplorerConfig::expand_grid` (`explorer.rs:507-560`) changes:

1. Enumerate every tuple of the parameter space and evaluate each.
2. Drop rejected tuples. Collapse aliases to their deployment's first tuple.
3. **Order deployments small first.** The sort key is `(sum over @scale axes of axis position, then choice positions in declaration order, then tuple order)`. This order is the `@scale` consumer for grid mode.
4. The outermost grid loop runs over deployments, replacing `num_servers` at `explorer.rs:513`. The inner loops are unchanged.
5. `SingleRunConfig` (`explorer.rs:628-649`) replaces `num_servers: i32` with:
   - `deployment: Arc<Deployment>`
   - `deployment_id: u32`
   - `params: ParamTuple`, the tuple that selected it

   The config log line (`explorer.rs:1255-1260`) prints `dep{id}{params}` in place of `s{}`.

Under `wall_budget_sec`, the grid is still walked in rounds (`docs/simulator_options.md:29-31`). Within a round, configurations are visited in grid order, so smaller deployments run first when a cut falls mid-round.

With one `@scale` axis, the deployment order is ascending in that axis, the same order as today's `num_servers` loop.

### 6.4 Genetic mode

The numeric constants in this section (the draw weights, 32 redraws, the 4096 enumeration cap, the 0.3 mutation probability) are initial defaults. They are explorer constants to be tuned by measurement, not part of the config schema.

**Drawing a random config** (`SingleRunConfig::random`, `explorer.rs:651-713`):

- `@scale` axis: position `i` of `m` is drawn with weight `1 / (i + 1)`, so small values come first.
- `@choice` axis: uniform.
- If the drawn tuple is rejected, redraw up to 32 times. After that, use the smallest accepted tuple in grid order. Finding it may enumerate the space. The explorer caps enumeration at 4096 tuples and fails the session with a clear message if no accepted tuple is found within the cap.

**Mutation** (`SingleRunConfig::mutate`, `explorer.rs:715-773`):

- `@scale` axis: with probability 0.3, move one position up or down, clamped. This replaces `mutate_int` +-1 at `explorer.rs:728` and moves by `step`, not by 1.
- `@choice` axis: with probability 0.3, resample uniformly among the other values.
- If the mutated tuple is rejected, the child keeps the parent's tuple. The other knobs still mutate.
- A mutated tuple that aliases the parent's deployment is a no-op on the deployment and needs no special case.

AOS `ConfigMutate` (`explorer.rs:2016-2020`) and the continuous explorer's envelope draws (`explorer.rs:2462`) call the same two functions and inherit this behavior.

### 6.5 Curriculum and campaign

- **Curriculum.** `curriculum::lower` (`curriculum.rs:146-151`) lerps every `@scale` axis by `knobs.scale` to an axis position and leaves `@choice` axes at position 0. `prefer_odd` is deleted: rounding is the deploy function's job. A rejected lowered tuple falls back as in Section 6.4. `record_curriculum_lowering` and `CURRICULUM_SERVERS_SUM` (`util_stats.rs:70`, `:4196-4202`, `:7430`) record the deployment's node count `N` instead of `num_servers`.
- **Campaign.** `GridArm::new` (`campaign.rs:636-647`) calls `expand_grid` and needs no other change. Recordings are covered in Section 6.8.

### 6.6 Plan generation

`GeneratorConfig` (`path/generator.rs:25-59`) replaces `num_servers` with `deployment: Arc<Deployment>`. Destination draws follow Section 4.11, and partitions follow Section 4.12.

Crash targets are drawn with `rng.random_range(0..crash_candidates.len())`. Every deployed node is a candidate, so with one role that is the same draw as today's `0..num_servers` (`generator.rs:88`). `last_recovery` (`generator.rs:136`) is keyed by node index; the index is still a global index.

### 6.7 Output tables

The runs table (`history.rs:756-777`, built by `run_row`, `explorer.rs:958-1000`) gains:

| Column | Type | Meaning |
| --- | --- | --- |
| `deployment_id` | Int32 | Index into `deployments`; `-1` for a run that failed before its deployment was chosen |
| `params` | Utf8 | JSON object of the tuple that selected the run (not the canonical alias) |

Two new tables are written once per deployment, when that deployment's first run is queued:

`deployments`

| Column | Type |
| --- | --- |
| `deployment_id` | Int32 |
| `deploy` | Utf8 (qualified name) |
| `client` | Utf8 (qualified name) |
| `model` | Utf8 (`kv` or `kv_rmw`) |
| `params` | Utf8 (canonical tuple JSON) |
| `aliases` | Utf8 (JSON array of alias tuples seen so far; rewritten at session end) |
| `hash` | UInt64 |
| `node_count` | Int32 |
| `roles` | Utf8 (JSON object, role name -> count) |
| `groups` | Utf8 (JSON array of `{path, aliases, role, members, quorum}`) |

`deployment_nodes`

| Column | Type |
| --- | --- |
| `deployment_id` | Int32 |
| `node_index` | Int32 |
| `role` | Utf8 |
| `ordinal` | Int32 |
| `path` | Utf8, nullable |

- The existing `logs.node_id`, `traces.node_id` and payload `VNode.index` keep the global index. They join to `deployment_nodes` through `runs.deployment_id`.
- Client nodes have `node_index >= node_count` and no row.
- `session.json` gains `deploy`, `deployments_built`, `deploy_rejections` (a count), and `tuples_aliased`.
- `run-plan` writes `plan_resolved.json` next to its output. This is the plan with every path replaced by its resolved global index, for tools that match plan events against history (Section 7.7).

### 6.8 Replay and recordings

- `replay_corpus::Seed` (`replay_corpus.rs:55-61`) carries a whole `SingleRunConfig` (`campaign.rs:447-451`), so a seed now carries its deployment `Arc` and id.
- A recording file written to disk stores the deploy name, the tuple, and the deployment hash. On replay the explorer re-evaluates the tuple and refuses to replay if the hash differs, because the spec changed.

---

## 7. Simulator and tooling changes

File and function mapping. Line numbers are at aea8a6f (`spur` submodule 45517fd).

### 7.1 Compiler front end

**Lexer** (`spur/spur-core/src/lexer.rs`)
- Keywords table at `:220-266`: add `client`, `self`, `spawn`; remove `ClientInterface` (`:223`, `:172`).

**Parser** (`spur/spur-core/src/parser.rs`)
- `RoleDef` (`:42-47`) gains `param: FuncParam` and `kind: Role | Client`.
- `role_def` and `client_def` (`:1381-1402`) parse `role_param`.
- `func_def` (`:1299-1320`) replaces the `@trace` prefix with `annotation*` and adds `annotations: Vec<Annotation>` to `FuncDef` (`:50-58`). `is_traced` is derived from it.
- `field_def` accepts `annotation*`.
- The primary expression parser gains `self` and `spawn<T>(e)` next to `retrieve_data` (`:967-974`).
- Recovery tokens (`:1418-1428`): replace `ClientInterface` with `client`.
- Reformatter: `spur/spur-core/src/parser/format.rs`.

**AST** (`spur/spur-ast/src/pure.rs:183-192`, `types.rs:344-349`)
- Role definitions carry the parameter and kind. Struct field definitions carry tags.
- `BuiltinFn` (`spur-ast/src/name.rs:15-36`) adds `Provide`, `ProvideAll`, `IndexOf`.
- New expression kinds `SelfHandle` and `Spawn(TypeDef, Expr)`.

**Resolver** (`spur/spur-core/src/analysis/resolver.rs`)
- `declare_role` (`:432-442`) records the kind.
- `resolve_role_def` (`:584-615`) binds the parameter in the role scope.
- `lookup_type` (`:486-497`) keeps role names as types.
- A client name is a type too, but `spawn` rejects it.
- `client_func_scope` (`:467-472`) becomes a per-client scope keyed like `role_func_scopes`.

**Checker** (`spur/spur-core/src/analysis/checker.rs`)
- `check_role_def` (`:448-472`) types the parameter and checks deployability and the `Init`/`RecoverInit` signatures.
- New `check_deploy` (Section 3.6), `check_client_ops` (Section 3.7), `check_tags` (Section 3.8).
- Node-bound fixed point (Section 3.4) over the call graph built from `role_func_name_ids` (`:178`) and free function signatures.
- Builtin special cases next to `role_to_string` (`:2663-2680`).
- The checker exports a **deploy table** into the compiled `Program`: for each deploy, its name, client, parameter fields with tags and types, and root type. It also exports a **type table**: struct field names, types and tags, and enum variants. Config validation (Section 5.5) and the root walk (Section 4.6) read these at run time without re-running the checker.

**Liquid refinement pass** (`spur/spur-core/src/liquid.rs`, `spur/spur-liquid`)
- This design needs nothing from it.
- `spur-liquid/src/lower/test.rs:582` constructs a role named "Node" and needs the new `RoleDef` fields only if the pass is kept.

### 7.2 Compiler back end

**Lowering** (`spur/spur-core/src/compiler/lowered.rs:44-70`)
- Carry the role parameter and kind.

**CFG** (`spur/spur-core/src/compiler/cfg.rs`)
- `begin_role` (`:139-151`) starts role variables at slot 2 and maps the parameter name to `VarSlot::Node(1, id)`.
- New `CTX_SLOT` next to `SELF_SLOT` (`cfg/ir.rs:34`).
- `self` compiles to `Expr::Var(SELF_SLOT)`; the mechanism already exists at `cfg.rs:191-193`.
- New labels `Spawn`, `Provide`, `ProvideAll`, and a new pure expression `IndexOf`.
- `Program` gains `role_table` (Section 4.7), `deploys` and `types` (Section 7.1).
- `func_qualifier_map` (`cfg.rs:253-262`) keeps `Role.func` naming for roles and uses `Client.func` for clients.

**Compiled ops** (`spur/spur-core/src/compiler/cfg/compiled.rs`)
- Add `Op::Spawn`, `Op::Provide`, `Op::ProvideAll`.
- Remove `CompiledProgram.server_role` (`:194-221`). Its only reader is `exec.rs:1486` (Section 7.3).

**Interpreters** (`simulator/core/eval.rs`, `simulator/core/compiled_eval.rs`)
- `IndexOf`.
- Cold arms for the three allocation ops that raise `AllocationOutsideDeploy` without an allocator.
- `NodeToString` (`eval.rs:500-510`, `compiled_eval.rs:363-373`) keeps `Role[index]` with the global index.

**Tests**
- `compiler/threaded/test.rs:172-733` and `compiler/cfg/test.rs:339` build roles named "Node" and need the new fields.

### 7.3 Simulator core

**New file: `spur/spur-core/src/simulator/deploy.rs`**
- `Allocator`, `evaluate_deploy(program, deploy, tuple) -> Result<DeployOutcome>`, the root walk, groups, the hash, `resolve_path`, `ParamSpace`, `DeployCache`.

**`simulator/core/state.rs`**
- `with_channel_capacity` / `new` (`:901-926`) take the per-index role list and set `CTX_SLOT`.
- `add_node` (`:1067-1079`) takes the ctx value.
- New field `allocator: Option<Box<Allocator>>`.
- `persisted_data`, `allowed_timers` (`:691-694`) and the per-node vectors (`:675-723`) stay indexed by global index. `allowed_timers` keys stay `(usize, String)`, now built from resolved `NodeId.index`.
- `note_post_fault_request_entry(dest, step, servers)` (`:1413-1441`) scans `0..servers` as the peers of `dest`. It changes to scan the members of `dest`'s groups, falling back to `0..N`.
- `request_before_stale` and `net_requests` (`:789-791`, `:1469-1474`) treat "different role" as "client request". This becomes "origin index `>= N`": a router sending to a Raft node is a different role but not a client.
- Tests `:1768-1771` and the `State::new(&[(NameId(0), n)], 1)` calls in `scheduler.rs` tests (`:2326`, `:2333`, `:2359`, `:2403`, `:3579-3605`) update.

**`simulator/path.rs`**
- Delete `Topology` and `TopologyInfo` (`:41-49`). `exec_plan` (`:556`) takes `deployment: &Arc<Deployment>`.
- `ClientPool::new` (`:128-135`) and `PathState::new` (`:162-175`) take the deployment.
- `schedule_client_op` (`:198-289`):
  - uses the client's `RoleTable` entries instead of `"ClientInterface.*"` strings;
  - builds the normalized payload of Section 4.11;
  - takes `Option<NodeId>`.
- `validate_node` (`:291-305`) goes away: targets are resolved `NodeId`s, validated when the plan is built.
- `invoke_client_request` (`:317-400`) sets the client ctx slot and uses the client `BASE_NODE_INIT` from `RoleTable` (`:358`).
- Remove the server role name lookup at `:676-681`.
- Crash, recover, allow_timer and partition handling (`:843-905`) take resolved values.
- Deliver reservations (`:916-926`) compare `NodeId.index` from resolved specs.
- Pass the per-node `fanout_width` to `client_anchor::fanout_window` (`:1121-1125`).
- The test at `:1338-1343` uses a deployment.

**`simulator/core/scheduler.rs`**
- `topology: &TopologyInfo` becomes `deployment: &Deployment` throughout. The `num_servers` reads at `:1061`, `:1387`, `:1584`, `:1718` become `deployment.node_count()`.
- `crash_hold_mask` (`:706-741`), `phase_read_node` (`:1010-1027`), `retarget_crash` (`:1797-1818`) and `absorber_decision` (`:1822-1840`) pass the crash candidate list instead of a count.
- Retarget candidates are restricted to candidates that share a group with the planned victim, falling back to the same role. Retargeting a crash from a Raft node to a router would otherwise change which fault the plan expressed. For a single cluster every candidate shares the group, so the choice is unchanged.
- Several functions build a `NodeId` for index `n` from another node's role, which assumes every node has the same role: `release_one` (`:904`, from `v.role`), `forced_victim` (`:947`), `note_ghost_release_apply` (`:977`), `retarget_crash` (`:1806`) and `absorber_decision` (`:1833`). They use `deployment.nodes[n].id` instead. This is a correctness requirement once roles differ.
- `reinit_node` (`:2190-2222`) uses `RoleTable.base_init[role]` and sets `CTX_SLOT`, replacing `"Node.BASE_NODE_INIT"` at `:2200`.
- `recover_node` (`:2238-2300`) uses `RoleTable.recover_init[role]` with no arguments, replacing `:2251-2269`.
- The u64 masks (`crash_hold_mask`, `crash_defer_mask` `:1063-1078`, `node_bit` `:796-802`, `absorber_peers_heard` `state.rs:854`, `ghost_absorber.rs:32-47`, `ghost_release.rs:251-275`) keep their 64-node width. Nodes past index 63 are never held, withheld or retargeted, as today. Sharded deployments above 64 nodes still run correctly with these heuristics inactive for the excess nodes. `session.json` reports `nodes_beyond_mask_width` when `N > 64`.

**`simulator/core/exec.rs`**
- The timeline capture at `:656-666` does a string scan of `program.roles` on every first entry, and `:1486` compares `compiled.server_role`. Both become `record.node.index < state.deployed_count`, a new `usize` field on `State`. This is cheaper than the string scan.

**`simulator/core/partition.rs`**
- Section 4.12: the `MajoritiesRing` variant and hash carry ordered group members; `Halves`, `Bridge` and `MajoritiesRing` in `can_communicate` check membership before applying the shape. Include the bridge in its group's membership. `IsolateOne` keeps its current rule.
- Section 10.11: apply the majority-neighborhood radius for ring members and replace the inaccurate connectivity comments. Validate size and distinct membership at construction, and filter generated ring candidates before quorum preference.
- Check both scheduler-time filtering and `activate_partition` filtering of already queued records and channel sends. `heal_partition` must release blocked messages through the existing path.

**`simulator/plan_config.rs`**
- The whole file changes to the Section 5.3 schema.
- `PlanConfigError::TargetOutOfBounds` and `InvalidNumServers` (`:24-33`) are replaced by `PathError { event_id, path, reason }` and `DeployRejected`.
- `to_partition_type` (`:53-88`) takes the resolved group members instead of `server_role` and `num_servers`.

**`simulator/path/generator.rs` and `simulator/path/plan.rs`**
- Section 6.6.

**Heuristic modules keyed by global index**

- `client_anchor.rs:118-130` `fanout_window(ledgers, servers, step)`: takes `fanout_width: &[u32]` and iterates `0..N`. The per-node peers threshold replaces `servers - 1`.
- `ghost_absorber.rs:69-100` `choose(victim, ledgers, servers, ..)`: iterates the candidate list.
- `crash_phase.rs:99-120`, `fresh_first.rs:99-133`, `pair_order.rs:76-91`, `ghost_release.rs:243-330`: no change. They are indexed by global index and sized by the node table.
- `feedback.rs:211-226`: no change, already keyed by `NodeId`.
- `util_stats.rs:2173`, `:2202`: no change.

**`simulator/explorer.rs`**
- Delete `initialize_state` and `init_topology` (`:777-880`) and replace them with `start_run(deployment, ..)` (Section 4.7).
- `run_single_simulation` (`:1006-1100`) and `run_single_plan` (`:1375-1445`) drop the role lookups (`:1049-1057`, `:1401-1409`) and take the deployment from the config.
- `run_plan` (`:1497-1590`) evaluates the plan's deploy once.
- `ExplorerConfig` (`:184-354`), `validate` (`:442-444`), `expand_grid` (`:507-560`), `SingleRunConfig` (`:628-773`): Sections 5 and 6.
- `run_row` (`:958-1000`): Section 6.7.

**`simulator/curriculum.rs`, `simulator/campaign.rs`, `simulator/replay_corpus.rs`**
- Sections 6.5 and 6.8.

**`simulator/config_override.rs`**
- Tests at `:289` and `:376` use `params`.

**No change needed**
- `run_variant.rs`, `fault_timing.rs`, `recover_deps.rs`, `stall_cap.rs`, `timer_context.rs`, `coverage.rs`, `arm_selector.rs` have no node-count or single-role dependency.

### 7.4 History output

`spur/spur-core/src/simulator/history.rs`:

- **Backends.** The only writer is Parquet: `ParquetWriter` (`:1113`), `LogBackend::Parquet` (`:1570-1573`), `create_writer` (`:1577-1588`). There is no DuckDB writer. `CLAUDE.md`, `docs/simulator_options.md:22-24` and the porcupine flag `-type duckdb` refer to DuckDB. The Go tools query the Parquet files through DuckDB. This design changes only Parquet schemas.
- **executions** (`:458-469`): no schema change. Client invocation payloads use the fixed shape of Section 4.11. `client_id` keeps its meanings: client index for client operations, `-1` for Crash and Recover (`path.rs:988`, `:1005`), node index for TimerFired (`path.rs:1036`).
- **logs** (`:471-479`) and **traces** (`:674-687`): no schema change. `node_id` remains the global index (`:50`, `:82`).
- **Payload node JSON** (`:150-153`, `:223-252`, `:310-312`): unchanged, `{"role": NameId, "index": i}`. The raw `NameId` number has no meaning outside the process. Tools read the role from `deployment_nodes`.
- **runs** (`:102-133`, `:756-777`): two columns (Section 6.7).
- **New** `deployments` and `deployment_nodes` writers, with the same file layout as `runs`.

### 7.5 CLI and debug

**`spur/spur-cli/src/main.rs`**
- `Explore` args (`:75-99`) and `RunPlan` args (`:101-116`) gain `--deploy NAME`.
- New subcommand `spur deploy SPEC [--deploy NAME] --params JSON`. It evaluates one tuple and prints the result, or the rejection, or the deploy error:
  - roles and counts
  - each node's index, role, ordinal and canonical path
  - groups with paths and quorum flags
  - the hash

  This is the authoring loop for deploy functions and costs nothing at run time.
- Debug formatting:
  - `run_debug_logs` (`:777-819`) and `run_debug_traces` (`:857-901`) print `[Raft[2] shards[0].nodes[2]]` instead of `[Node   2]`, using `deployment_nodes` joined through the run's `deployment_id`.
  - `run_debug_combined` (`:821-855`) prints client rows as `Client 7`.

**`spur/spur-core/src/debug.rs`**
- `get_node_timeline` (`:28-56`), `get_all_logs` (`:59-96`), `get_combined_timeline` (`:123-280`) and `get_traces` (`:283-372`) join the two new tables to add `role` and `path` to `CombinedEvent` and `TraceEvent` (`:375-391`).
- `--node-id` stays an integer index. `--node PATH` is added and resolved through `deployment_nodes.path` for the run's deployment.

### 7.6 Porcupine (Go)

- `porcupine/cmd/porcupine/main.go:25`: `-model` becomes optional. When omitted, the model is read from `deployments.model`, one distinct value per session. When given and different, porcupine prints a warning and uses the flag.
- `cmd/porcupine/main.go:42-51` and `cmd/porcupine_batch/main.go:117-144`: same inference.
- `checker/duckdb_reader.go:92`, `:150-152`, `:224`, `:262`: no column change is needed for linearizability.
- `checker/checker.go:26-45`: action suffixes `ClientInterface.Read|Write|RMW` become `Client.Read|Write|RMW`. `System.Crash|Recover` is unchanged.
- `checker/checker.go:191-245`: the payload positions are unchanged because of normalization. `payload[0]` may now be `VUnit`, and the checker already ignores it.
- `checker/checker.go:307-334` `extractNodeID` and the annotations at `:119-158` (`"Node %d"`): read `index` as today, and label with role and ordinal when `deployment_nodes` is present.
- `porcupine/convert_complex.py:84-99`, `porcupine/examples/*/*.csv`, `checker/kv_rmw_test.go:11`: action strings.

### 7.7 Traceanalyzer (Go)

- **Runs reader.** `reader/runs.go:16-41`, `:111-148` gain `deployment_id` and `params`. `-runs-columns` (`:203-243`) exposes them.
- **Action filters.**
  - `metrics/grade.go:90`, `:94`: `LIKE 'ClientInterface.%'` becomes `LIKE 'Client.%'`.
  - `metrics/grade.go:148-203`: the crash node from `payload[0].value.index` and traces `node_id` stay in one index space.
  - `metrics/fault.go:140`, `:215`: no change.
- **dagorder.**
  - `metrics/dagorder/planconfig.go:67-231` parses the plan schema with integer targets and `num_servers`. It changes to read `plan_resolved.json` (Section 6.7), whose events carry global indices. Matching code at `candidates.go:471`, `:501`, `:536`, `:559-566` and `dagorder.go:113-126` then keeps comparing integers.
  - `candidates.go:355-380` `parseInvocationPayload` must accept `VUnit` at `payload[0]` for operations without a destination.
  - `candidates.go:405-416` `actionFor` changes the action strings.
  - Tests: `planconfig_test.go:16-17`, `:59`, `:82`, `:95`; `timer_test.go:113-146`.
- **No change.** `metrics/interleaving.go:148`, `:191`, `metrics/fingerprint.go:118-123` and `reader/reader.go:184-435` work in the global index space and need no change.

### 7.8 LSP, editor, bench

- **LSP.** `spur/spur-lsp/src/diagnostics.rs:186-187` maps the new errors of Section 3.9. There is no other role-name dependency.
- **Editor.** `spur/editors/code/syntaxes/spur.tmLanguage.json`:
  - `:133` storage keywords: replace `ClientInterface` with `client`, add `spawn`.
  - `:179-180` role declaration pattern: accept the parameter list.
  - `:207` becomes a `client Name(...)` declaration pattern.
  - `self` is highlighted as a language variable.
- **Bench.** `spur/spur-bench/src/lib.rs:97-106` generates `role Node { fn Init(me: int) {} }` and a `ClientInterface` block. Replace them with a unit-parameter role, a client, and a trivial `@deploy`.

### 7.9 Research harness and scripts

These are inputs of the running research loop. They must change in the same commit as the simulator schema, at an iteration boundary (Section 11).

**Shell scripts**
- `scripts/bench.sh:60-65`, `:84` write and count `num_servers`. Replace with `params`.
- `scripts/porcupine.sh:17` and `scripts/capped.sh:6` hard-code `-model kv`. Drop the flag.

**`research/harness/src`**
- `runners.ts`:
  - `:179-190` `materializeConfig` merges overlays at top level. Overlays carrying `params` must merge per parameter, not replace `params` whole.
  - `:559`, `:572`: `-model` becomes optional.
  - `:403`, `:427`: runs columns.
- `schemas.ts:203-250`: add `deployment_id` and `params` to `RunRow` if the schema is strict.
- `evaluate.ts:279-292`: node labels. `evaluate.ts:398` and `regression.ts:17`, `:118`, `:123`: model.

**`research/lite`**
- `grader.ts:68`: the template path `scheduler_configs/loop/general_vr.json` is rewritten.
- `grader.ts:77`, `:1437`, `:1682`: `porcupineModel` can be dropped once inference exists.
- `grader.ts:1667-1673`: overlays.
- `lite/lite.json`: `"porcupineModel"`.
- `tools/ghost_census.py`:
  - `:54-61` hard-codes `Node.*` and `ClientInterface.Write` function names. `Node.*` keeps its spelling as long as VR's role stays `Node` in a single file. `ClientInterface.Write` becomes `Client.Write`.
  - `:73-77` regexes match `Node (\d+) initialized` in log text printed by `bin/spur/VR.spur:81` and others. The migrated VR prints `Node {me}` to keep the text.
  - `:117-120`, `:203`, `:335`, `:387`, `:390` use indices and count `n_servers` from `Node.Init` Enter rows. They keep working for a single VR cluster.

**Manifests, plans and oracle DAGs**
- `research/panel/manifest.json`, `manifest.14.json`, `manifest.30.json`: overlays with `num_servers` become `params.n`.
- `research/oracle/*.json`, `research/oracle/tiers/*.json`, `research/lite/plans/*.json`: plan files with integer targets are rewritten to paths (`nodes[i]`) and `deploy` plus `params`.
- `research/corpus/manifest.json` points at these files.
- `research/policy.json:27-40` points at `scheduler_configs/loop/{general_vr,regression_vr_nofault,bench}.json`, which are rewritten.

**Archived configs**
- About 24 configs under `research/lite/patches/*/` and 21 under `research/logs/violations/*/` are evidence tied to past commits. They are not inputs of the loop. This design leaves them unconverted. They do not load on commits after Phase 3b.

### 7.10 Tests

- `spur/spur-core/tests`: 19 files set `num_servers` (22 occurrences, e.g. `tests/wall_budget.rs:23`). All change to `params`.
- `spur/spur-core/tests/fixtures`: 10 `.spur` files. `spur/spur-core/specs`: 6 `.spur` files. At least 7 of those 16 files use `Init(me, ...)`. All are migrated per Section 9.
- In-source configs: `curriculum.rs:313`, `:365`, `:397`; `campaign.rs:1619`; `config_override.rs:289`, `:376`; `explorer.rs:2860`; `generator.rs:322`.
- New tests:
  - checker error cases for every Section 3.9 variant, and `AllocationOutsideDeploy` from role code
  - deploy evaluation: allocation order, exactly-once, rejection, dedupe, unreachable warning, deploy error
  - path validation and resolution against a plan's tuple
  - partitions over groups: connectivity matrices for member/member, member/non-member and non-member/non-member pairs in both directions; include clients, routers, another group of the same role, non-contiguous indices, the bridge, and self-messages
  - ring connectivity: explicit adjacency matrices for sizes 4, 5, 6, 7 and 8; check symmetry, self-delivery, rotation/reflection invariance, direct majority size, and at least one blocked member pair for every supported size tested
  - ring membership: high client indices and global-index relabeling in debug and release builds; reject explicit groups of sizes 0 through 3 and repeated handles; generated plans skip ineligible groups, including when eligible non-quorum groups coexist with ineligible quorum groups
  - partition activation and healing: cover both RPC records and channel sends; only blocked messages wait for healing, and unrelated shard traffic progresses during the partition
  - release-build parity checks (Section 11, Phases 3a and 3b)

### 7.11 Docs and skills

These documents describe the removed surface and are rewritten:

- `spur/design/language.md`
- `docs/agent/language.md:9-43`
- `docs/simulator_semantics.md` (Init signatures, partitions)
- `docs/simulator_options.md` (config keys, `-model`)
- `CLAUDE.md` (ClientInterface contract, `-model` guidance)
- `AGENTS.md:53-62`, `:79-81`
- `README.md:52`
- `.claude/skills/find-bug/SKILL.md:93`, `:115`, `:164`, `:212`, `:215`, `:263`, `:276`, `:317`
- `.claude/skills/debug-protocol/SKILL.md:68`, `:71`
- `.claude/skills/implement-protocol` (protocol templates)

### 7.12 Existing issues found while mapping the code

Issues 1 and 2 are live simulator bugs. They affect current runs, in explorer configs with `num_partitions > 0` and in plan configs with partition events, whether or not this design lands. Phase 3a retains them for its parity check. The membership fix in Phase 3b resolves both. Phase 3b also fixes the ineffective ring threshold described in Section 10.11, in a separate commit.

1. **`Halves` and `Bridge` cut off clients.** `can_communicate` (`partition.rs:75-112`) delivers a message only when both ends are on the same side, and `to_partition_type` builds the sides from server indices only (`plan_config.rs:53-88`). A client is on neither side. During a `halves` partition no client request reaches any server. During a `bridge` partition clients reach only the bridge node. Client messages to the other servers are held until the heal. Whether that is intended is undocumented.
2. **`MajoritiesRing` reachability for clients depends on index arithmetic.** The arm at `partition.rs:83-97` computes `d = i.abs_diff(j)` and `min(d, n - d)` on raw global indices with `n = num_servers`, and every client index is `>= n`. For `n = 3` (reach 1): client index 3 reaches all three servers; client index 4 reaches nodes 1 and 2 but not node 0; client index 5 reaches only node 2. Whenever `d > n`, `n - d` underflows `usize`. Debug builds panic. Release builds wrap to a large value, which blocks the pair; `spur/Cargo.toml` does not enable `overflow-checks` for release. Which servers a client reaches therefore depends on the client slot that carries the operation.
3. `docs/simulator_semantics.md:161` shows `"write": [0, "x", "1"]` with a third element. The parser takes `Write(i32, String)` (`plan_config.rs:93`).
4. The docs call DuckDB the default log backend. The code has only a Parquet writer (Section 7.4).

---

## 8. Worked examples

### 8.1 Single Raft cluster (`bin/spur/Raft.spur`)

The protocol body is unchanged except that the integer role variable `self` is renamed `me`, which frees `self` for the handle. The changed regions:

```
type Raft {
    @quorum nodes: list<Node>;
};

type RaftParams {
    @scale n: int;
};

role Node(cluster: Raft) {
    // Identity, derived again from the deployment on every start and recovery.
    var me: int = index_of(cluster.nodes, self)!;
    var replicas: list<Node> = cluster.nodes;

    // Persistent state (saved via persist_data)
    var current_term: int = 0;
    var voted_for: int = -1;
    var log: list<LogEntry> = [];
    // ... remaining variables unchanged ...

    fn Init() {
        println("Node {me} initialized");
        monitor_timeouts();
    }

    @trace
    async fn RecoverInit() {
        var saved: PersistentState? = retrieve_data<PersistentState>();
        if (saved != nil) {
            var s: PersistentState = saved!;
            current_term = s.current_term;
            voted_for = s.voted_for;
            log = s.log;
        }
        state = 0;
        commit_index = 0;
        last_applied = 0;
        pending_requests = {};
        next_index = {};
        match_index = {};
        votes_received = 0;
        received_leader_message = false;
        println("Node {me} recovered. term={current_term} log_len={len(log)}");
        monitor_timeouts();
    }

    // Every other use of the integer `self` becomes `me`, e.g.
    // `if (i != me) { send_append_entries(i); }` and `leader: replicas[me]`.
    // ... handlers unchanged ...
}

fn cluster(n: int): Raft {
    var nodes: list<Node> = spawn<Node>(n);
    var r: Raft = Raft { nodes: nodes };
    provide_all(nodes, r);
    r
}

@deploy(client = KVClient)
fn Single(p: RaftParams): Raft? {
    if (p.n < 1) {
        return nil;
    }
    cluster(p.n)
}

client KVClient(sys: Raft) {
    async fn Write(dest: Node, key: string, uid: int) {
        var current_target: Node = dest;
        for ;; {
            var resp: ClientResponse = <- current_target->Write(key, uid);
            if (resp.is_leader == true) {
                return ();
            }
            current_target = resp.leader;
        }
    }

    async fn Read(dest: Node, key: string): list<int> {
        var current_target: Node = dest;
        for ;; {
            var resp: ClientResponse = <- current_target->Read(key);
            if (resp.is_leader == true) {
                return resp.value;
            }
            current_target = resp.leader;
        }
        []
    }
}
```

How the rewrite behaves:

- `me` and `replicas` are role variables whose initializers read the role parameter and `self`. Variable initializers run before `Init` and again on recovery, before `RecoverInit` (Sections 4.7 and 4.9). The loops that built `replicas` from `peers` in both functions (`Raft.spur:57-72`) are not needed.
- The deploy never coerces `n`. Even cluster sizes stay explorable, as they are today with `num_servers` ranges.
- A spec that wants odd sizes only writes `if (p.n % 2 == 0) { return nil; }`, or rounds up so that aliased tuples dedupe.

Explorer config: Section 5.8.

Plan config (`scheduler_configs/example_plan.json` rewritten):

```json
{
  "deploy": "Single",
  "params": { "n": 3 },
  "num_runs": 50,
  "max_iterations": 5000,
  "events": {
    "w1": { "write": { "dest": "nodes[0]", "key": "key1" } },
    "w2": { "write": { "dest": "nodes[1]", "key": "key1" } },
    "r1": { "read": { "dest": "nodes[2]", "key": "key1" } },
    "crash1": { "crash": "nodes[1]" },
    "recover1": { "recover": "nodes[1]" }
  },
  "dependencies": [["w1", "r1"], ["w2", "r1"], ["crash1", "recover1"]]
}
```

Derived semantics for `n = 3`:
- nodes `0..3`, all `Node`, with paths `nodes[0]`, `nodes[1]`, `nodes[2]`
- one group, `nodes`, a quorum group
- `fanout_width` 2 for each node
- crash candidates `0..3`

These equal what `num_servers = 3` produces today.

### 8.2 Sharded KV over several Raft clusters

Written with module syntax (`raft.Node`). Section 9.3 gives the single-file form usable before modules exist. The Raft module is Section 8.1 without its `@deploy` and client.

Keys are routed by a table that the deploy function builds, because no string hash builtin exists in this design (Appendix B.8). The explorer names keys `key1` to `keyK` (`path/generator.rs:68`). The `route_keys` parameter sets how many of those names the table spreads across the shards; a config sets it to at least the largest `num_keys`. A key missing from the table goes to shard 0, so every key still has exactly one shard.

Shared helpers:

```
// module sharded

// Shard that owns `key`. Keys missing from the table belong to shard 0.
fn shard_of(routes: map<string, int>, key: string): int {
    if (exists(routes, key)) {
        return routes[key];
    }
    0
}

// key1..keyK, assigned round-robin over `shards` shards.
fn key_routes(shards: int, keys: int): map<string, int> {
    var routes: map<string, int> = {};
    for var i = 1; i <= keys; i = i + 1 {
        routes = routes["key{i}"] := (i - 1) % shards;
    }
    routes
}

// Replica counts are rounded up to odd.
fn shard_clusters(count: int, replicas: int): list<raft.Raft> {
    var r: int = replicas;
    if (r % 2 == 0) {
        r = r + 1;
    }
    var shards: list<raft.Raft> = [];
    for var i = 0; i < count; i = i + 1 {
        shards = append(shards, raft.cluster(r));
    }
    shards
}
```

**Routed deployment.** Clients send every operation to a router, and the router forwards it to the owning shard:

```
type ShardedKV {
    shards: list<raft.Raft>;
    routers: list<Router>;
    routes: map<string, int>;
    cache_leaders: bool;
};

type ShardParams {
    @scale shards: int;
    @scale replicas: int;
    @scale routers: int;
    @choice cache_leaders: bool;
    @choice route_keys: int;
};

role Router(sys: ShardedKV) {
    var leader_hint: map<int, raft.Node> = {};

    fn first_target(s: int): raft.Node {
        if (sys.cache_leaders and exists(leader_hint, s)) {
            return leader_hint[s];
        }
        sys.shards[s].nodes[0]
    }

    async fn Write(key: string, uid: int) {
        var s: int = shard_of(sys.routes, key);
        var target: raft.Node = first_target(s);
        for ;; {
            var resp: raft.ClientResponse = <- target->Write(key, uid);
            if (resp.is_leader) {
                if (sys.cache_leaders) {
                    leader_hint = leader_hint[s] := target;
                }
                return ();
            }
            target = resp.leader;
        }
    }

    async fn Read(key: string): list<int> {
        var s: int = shard_of(sys.routes, key);
        var target: raft.Node = first_target(s);
        for ;; {
            var resp: raft.ClientResponse = <- target->Read(key);
            if (resp.is_leader) {
                if (sys.cache_leaders) {
                    leader_hint = leader_hint[s] := target;
                }
                return resp.value;
            }
            target = resp.leader;
        }
        []
    }
}

@deploy(client = RouterClient)
fn Sharded(p: ShardParams): ShardedKV? {
    if (p.shards < 1 or p.replicas < 1 or p.routers < 1 or p.route_keys < 0) {
        return nil;
    }
    // Shards are spawned first, so Raft nodes take the lowest indices.
    var shards: list<raft.Raft> = shard_clusters(p.shards, p.replicas);
    var routers: list<Router> = spawn<Router>(p.routers);
    var sys: ShardedKV = ShardedKV {
        shards: shards,
        routers: routers,
        routes: key_routes(p.shards, p.route_keys),
        cache_leaders: p.cache_leaders,
    };
    provide_all(routers, sys);
    sys
}

client RouterClient(sys: ShardedKV) {
    async fn Write(dest: Router, key: string, uid: int) {
        <- dest->Write(key, uid);
    }

    async fn Read(dest: Router, key: string): list<int> {
        <- dest->Read(key)
    }
}
```

**Direct deployment.** The client routes by itself, and no routers exist. It has its own root and parameter types, so it spawns only the shards:

```
type DirectKV {
    shards: list<raft.Raft>;
    routes: map<string, int>;
};

type DirectParams {
    @scale shards: int;
    @scale replicas: int;
    @choice route_keys: int;
};

@deploy(client = DirectClient)
fn ShardedDirect(p: DirectParams): DirectKV? {
    if (p.shards < 1 or p.replicas < 1 or p.route_keys < 0) {
        return nil;
    }
    var sys: DirectKV = DirectKV {
        shards: shard_clusters(p.shards, p.replicas),
        routes: key_routes(p.shards, p.route_keys),
    };
    sys
}

client DirectClient(sys: DirectKV) {
    async fn Write(key: string, uid: int) {
        var s: int = shard_of(sys.routes, key);
        var target: raft.Node = sys.shards[s].nodes[0];
        for ;; {
            var resp: raft.ClientResponse = <- target->Write(key, uid);
            if (resp.is_leader) {
                return ();
            }
            target = resp.leader;
        }
    }

    async fn Read(key: string): list<int> {
        var s: int = shard_of(sys.routes, key);
        var target: raft.Node = sys.shards[s].nodes[0];
        for ;; {
            var resp: raft.ClientResponse = <- target->Read(key);
            if (resp.is_leader) {
                return resp.value;
            }
            target = resp.leader;
        }
        []
    }
}
```

**Layout of `Sharded` for `shards = 2, replicas = 3, routers = 1`**

| index | role | ordinal | path |
| --- | --- | --- | --- |
| 0-2 | raft.Node | 0-2 | `shards[0].nodes[0..2]` |
| 3-5 | raft.Node | 3-5 | `shards[1].nodes[0..2]` |
| 6 | Router | 0 | `routers[0]` |
| 7.. | RouterClient (clients) | | |

**Groups**
- `shards[0].nodes` and `shards[1].nodes`, both quorum groups
- `routers`, not a quorum group, with one member

**Heuristic inputs**
- `fanout_width`: 2 for Raft nodes. For the router it is `N - 1 = 6`, since it is in no group of two or more; its only group, `routers`, has one member.
- Crash candidates: all seven deployed nodes, including the router.
- `Write` destinations are drawn among routers (count 1).

**Aliasing:** `replicas = 4` aliases `replicas = 5` (rounded up), which dedupes.

**Layout of `ShardedDirect` for `shards = 2, replicas = 3`.** Indices 0-5 are the same six Raft nodes with the same paths and groups. Clients (`DirectClient`) start at index 6. Every crash candidate is a Raft node, and client operations draw no destination.

**Explorer config for `Sharded`**

```json
{
  "deploy": "sharded.Sharded",
  "params": {
    "shards": { "min": 1, "max": 2, "step": 1 },
    "replicas": { "min": 3, "max": 5, "step": 1 },
    "routers": { "min": 1, "max": 2, "step": 1 },
    "cache_leaders": [false, true],
    "route_keys": [4]
  },
  "num_write_ops": { "min": 3, "max": 6, "step": 3 },
  "num_read_ops": { "min": 2, "max": 4, "step": 2 },
  "num_keys": { "min": 2, "max": 4, "step": 2 },
  "num_crashes": { "min": 1, "max": 2, "step": 1 },
  "num_partitions": { "min": 0, "max": 1, "step": 1 },
  "max_concurrent_writes": { "min": 2, "max": 2, "step": 1 },
  "dependency_density": [0.3],
  "num_runs_per_config": 20,
  "max_iterations": 8000
}
```

The parameter space has 2 x 3 x 2 x 2 x 1 = 24 tuples. Replicas 3, 4 and 5 build only two distinct cluster sizes (4 rounds up to 5), so the grid has 16 deployments. The first deployment is 1 shard of 3 replicas with 1 router and `cache_leaders = false`; the second is the same shape with `cache_leaders = true`. Larger shapes follow.

A `ShardedDirect` config selects `"deploy": "sharded.ShardedDirect"` and drops the `routers` and `cache_leaders` entries from `params`. The rest is unchanged.

**Plan config for `Sharded`**

```json
{
  "deploy": "sharded.Sharded",
  "params": { "shards": 2, "replicas": 3, "routers": 1, "cache_leaders": true, "route_keys": 4 },
  "num_runs": 50,
  "max_iterations": 8000,
  "strict_timers": true,
  "events": {
    "w1": { "write": { "dest": "routers[0]", "key": "key1" } },
    "c1": { "crash": "shards[1].nodes[0]" },
    "p1": { "partition": { "type": "halves", "group": "shards[0].nodes", "side_a": [0] } },
    "t1": { "allow_timer": { "node": "shards[0].nodes[2]", "label": "election" } },
    "h1": "heal",
    "v1": { "recover": "shards[1].nodes[0]" },
    "d1": { "deliver": { "function": "raft.Node.AppendEntries",
                         "from": "shards[0].nodes[0]", "to": "shards[0].nodes[1]" } },
    "r1": { "read": { "dest": "routers[0]", "key": "key1" } }
  },
  "dependencies": [
    ["w1", "c1"], ["c1", "p1"], ["p1", "t1"], ["t1", "h1"],
    ["h1", "v1"], ["v1", "d1"], ["d1", "r1"]
  ]
}
```

`key1` is routed to shard 0. Under the partition rules of Section 4.12, the `halves` partition on `shards[0].nodes` separates node 0 from nodes 1 and 2. Router, client and shard 1 traffic is not blocked by this partition. Cross-side traffic within shard 0 waits until `h1`. The model is `kv`, because `RouterClient` has no `RMW`.

---

## 9. Migration of existing specs

### 9.1 Mechanical rewrite for single-cluster specs

This applies to every spec in `bin/spur` except `CRAQ.spur`: `Paxos`, `Raft`, `Raft_rtc`, `VR`, `Gryff`, `EPaxosStar`, `SDPaxos`, `test_rmw`, `mencius/*` (5 files) and `panel/*` (13 files). It also applies to `spur/spur-core/specs` (6) and `spur/spur-core/tests/fixtures` (10).

All of these declare `role Node` with `Init(me: int, peers|all: list<Node>)`, an optional `RecoverInit` of the same signature, and a `ClientInterface` whose operations take `dest: Node`. The rewrite:

1. Add `type Cluster { @quorum nodes: list<Node>; };` and `type ClusterParams { @scale n: int; };`.
2. Change `role Node {` to `role Node(cluster: Cluster) {`.
3. Rename the integer role variable `self` to `me` and every use of it. 26 specs declare `var self: int`, for example `Raft.spur:27`, `VR.spur:44`, `EPaxosStar.spur` and `SDPaxos.spur`. The initializer becomes `var me: int = index_of(cluster.nodes, self)!;`.
4. Replace the peer list variables with initializers from `cluster.nodes`, and delete the assignments in `Init` and `RecoverInit`:
   - `replicas`: Raft, VR, Gryff, EPaxosStar
   - `peers`: SDPaxos, Paxos
5. Values derived only from the peer count move into initializers too. For example `EPaxosStar.spur:111-116` (`node_count`, `f`, `e`) and `Gryff.spur:134-136` (`n`, `f_val`, `e_val`) become `var f: int = (len(cluster.nodes) - 1) / 2;`.
6. Initialization with side effects stays in `Init` and `RecoverInit`, for example SDPaxos's per-peer maps (`SDPaxos.spur:238-250`) and timer loops.
7. Drop the parameters from `Init` and `RecoverInit`.
8. Add `fn cluster(n: int): Cluster` and `@deploy(client = KVClient) fn Main(p: ClusterParams): Cluster?`, returning `nil` for `n < 1`.
9. Change `ClientInterface {` to `client KVClient(sys: Cluster) {`. Operation bodies are unchanged. Non-operation helpers such as `VR.spur:669` `GetKVStore` and the `responses` variable at `VR.spur:633` stay.
10. `println("Node {self} ...")` becomes `println("Node {me} ...")`. This keeps the log text that `research/lite/tools/ghost_census.py:73-77` parses.

Specs that also expose `RMW` (`Gryff.spur:777`, `test_rmw.spur:39`) are inferred as `kv_rmw` with no annotation.

### 9.2 Configs

- **Explorer configs.** 44 of 44 files under `scheduler_configs/` carry `num_servers`. Each gets `"deploy": "Main"` and `"params": {"n": <the num_servers range>}`; the other keys are unchanged.
- **Plan configs.** `example_plan.json` and the plan-format loop files get `"params": {"n": <num_servers>}`, and integer targets `i` become `"nodes[i]"`. `deliver.from` and `deliver.to` use the same form. Halves, bridge and majorities_ring events gain `"group": "nodes"`.
- **Research inputs.** Section 7.9.

A one-shot converter script does this mechanically. It is deleted after use.

### 9.3 Single-file composition before modules

`bin/spur/Raft.spur` cannot be imported until modules exist. The sharded example is usable now by putting the Raft role, types and `cluster` function in the same file as the routing tier. Roles and types must have distinct names within the file (`RaftNode`, `Raft`, `RaftClientResponse`). Function names are already qualified per role in the CFG (`cfg.rs:253-262`), so `RaftNode.Write` and `Router.Write` do not collide.

### 9.4 Out of scope

`bin/spur/CRAQ.spur` is outdated. It uses `async fn Init(assigned_role: string, pred: Node?, ...)` at `CRAQ.spur:163`, which the current simulator cannot call. It is left as is; after this change it does not compile. A chain topology is a natural future user of a typed role parameter (`type Chain { nodes: list<Node>; }`, with predecessor and successor derived by `index_of`).

---

## 10. Open questions

Each question ends with a recommendation.

**10.1 `self` as a keyword.** Making `self` a keyword forces renaming the integer `self` variable in 26 specs. The alternative is a builtin call `self_handle()`, which leaves the specs untouched.
*Recommendation:* keyword `self`. The rename is mechanical (Section 9.1), and `self` matches the handle's meaning. The integer is better named `me`.

**10.2 Role parameter in variable initializers.** If initializers cannot read it, every spec moves identity computation into `Init` and `RecoverInit`, duplicating it.
*Recommendation:* allow it (Section 4.7). Initializers already run on the node, with `self` set, both at start and at recovery.

**10.3 Unreachable spawned handles.** Options: an error, a warning, or silently count them.
*Recommendation:* a warning. The node runs and is a crash candidate, but it has no path (Section 4.5). Per-role counts come from the allocation table, not from walking the root; the two agree whenever every handle is reachable.

**10.4 Default crash targets across roles.** Options: all deployed nodes, or only nodes in quorum groups.
*Recommendation:* all deployed nodes. Router crashes are faults worth exploring. Restricting candidates by path is possible later work (Appendix B.7).

**10.5 Deploy errors in lazily evaluated modes.** Options: stop the session, or reject the tuple and continue.
*Recommendation:* stop the session (Section 4.5). A deploy error is a spec bug. Hiding it behind rejection would silently shrink the explored space.

**10.6 Client operation action names.** Options: keep `ClientInterface.Write` as a fixed string, use the client's qualified name (`KVClient.Write`), or use a fixed namespace (`Client.Write`).
*Recommendation:* `Client.Write`, `Client.Read`, `Client.RMW` in `executions.action`. The Go tools match one stable string, the name does not refer to a removed keyword, and the client's real name is recorded in `deployments.client`. Handler function names in `traces.function_name` keep the qualified name. Phase 3b's parity check allows this rename and masks the removed Init and RecoverInit arguments; partitioned runs use separate semantic checks.

**10.7 Porcupine model transport.** Options: `session.json`, the `deployments` table, or a flag the harness computes.
*Recommendation:* the `deployments.model` column (Section 7.6). Every mode writes that table, including `run-plan`, which does not write `session.json` today.

**10.8 Global index versus per-role ordinal in output.** Options: print `Role[global]` or `Role[ordinal]`.
*Recommendation:* keep the global index as identity everywhere, including `role_to_string`. Show ordinals and paths only where `deployment_nodes` is joined (debug output, porcupine HTML). A single numbering avoids two ids for one node in one row.

**10.9 Heuristics that assume one homogeneous server set.** `fanout_window`, `note_post_fault_request_entry` and retargeting read "all other servers". This design maps them to group-based widths and group-restricted candidates (Section 7.3). They reduce exactly to today's behavior for one cluster. Their value on multi-group deployments is unmeasured.
*Recommendation:* land the mapping as specified. Treat multi-group tuning as a later perf or research question, not part of this change.

**10.10 Omitted role parameter.** Some roles need no context. The design requires exactly one parameter, so such a role writes `role Witness(unused: ())`.
*Recommendation:* keep the requirement for now. Revisit sugar for `()` only if migrated specs show the pattern often.

**10.11 `MajoritiesRing` member connectivity (included in Phase 3b).** The current predicate accepts `min(d, n - d) <= floor(n/2)`. Every pair of valid positions on a ring satisfies this inequality, so it blocks no member-to-member messages. Fixing non-member handling and index underflow does not fix this separate simulator defect.

Use symmetric links with the smallest radius that gives every node a direct majority, counting itself. For `q = floor(n/2) + 1`, that radius is `ceil((q - 1)/2)`. Each node's neighborhood has `2 * radius + 1` members for supported sizes. It can exceed `q` by one because symmetric neighbors come in pairs. This is a chosen fault model, not a claim about the undocumented intent of the old code.

| Ring size | Radius | Direct neighborhood of position 0 | Blocked destinations from 0 |
| --- | --- | --- | --- |
| 4 | 1 | 0, 1, 3 | 2 |
| 5 | 1 | 0, 1, 4 | 2, 3 |
| 6 | 2 | 0, 1, 2, 4, 5 | 3 |
| 7 | 2 | 0, 1, 2, 5, 6 | 3, 4 |
| 8 | 2 | 0, 1, 2, 6, 7 | 3, 4, 5 |

For sizes below four this rule yields complete connectivity, so it is not an eligible ring fault. Explicit plans reject such groups; generated plans choose an eligible group or redraw the shape. The same checks reject repeated handles, since a member must have exactly one ring position. Config migration must audit ring events with small groups and choose an explicit suitable size or another fault shape according to the scenario; do not silently reinterpret the event.

The neighborhoods overlap and every supported ring blocks some direct links. This does not mean the graph is disconnected, that no fully connected quorum exists, or that a protocol cannot relay messages. Remove the current code comment claiming that no global quorum exists. Land the adjacency fix after the membership fix, in its own measured commit within Phase 3b.

---

## 11. Phased implementation plan

The autonomous perf research loop edits simulator-core files on `research/lite`: `core/scheduler.rs`, `core/state.rs`, `core/exec.rs`, `path.rs`, `explorer.rs` and `history.rs`, and the interpreters. Its grader also reads the runs table and `scheduler_configs/loop/*.json`. Every merge into `research/lite` that touches those files or inputs lands at an iteration boundary with the loop stopped, rebased onto the loop's latest merged state.

Merge order:

- **Phase 3a** lands first, on its own. It needs no language change, is small, and rebases cheaply against the loop.
- **Phases 1 and 2** are developed on a side branch. They are not merged into `research/lite` until Phase 3b is ready.
- **Phases 1, 2, 3b and 4** merge together, as one merge at one boundary. The front end removes the old syntax and there is no compatibility path, so every spec, config, tool and harness input must be migrated in the same merge. After a buildable migrated version, land the partition membership fix and then the ring adjacency fix as separate commits so each effect can be measured independently. The final merged version uses Section 4.12's membership rules and Section 10.11's ring adjacency.
- **Phase 5** follows at any boundary.

**Phase 1: language front end (side branch)**
- Lexer, parser, AST, resolver and checker for role parameters, `self`, `client`, annotations, tags, `spawn`, `provide`, `provide_all`, `index_of`, the node-bound effect, and the deploy table and type table export (Sections 2 and 3, 7.1).
- LSP diagnostics and editor grammar (7.8).
- Checker tests for every error in Section 3.9. The old syntax does not parse on this branch, so tests use fixtures in the new syntax.

**Phase 2: deployment evaluation (side branch, not wired)**
- `simulator/deploy.rs`: allocator, CFG labels and compiled ops, evaluation on the scratch context, exactly-once check, root walk, groups, hash, path resolution, `ParamSpace`, `DeployCache` (4.1-4.6, 5.4-5.6, 6.1-6.2).
- `spur deploy` CLI subcommand (7.5).
- Unit tests on small specs, including `AllocationOutsideDeploy`.
- The new ops' match arms in the interpreters are the only overlap with the simulator core. They are cold, and they are rebased onto the loop's state when the branch merges.

**Phase 3a: a Rust-side `Deployment` built from `num_servers` (iteration boundary, lands alone)**
- Add `Deployment` (4.1) with the fields runs read: per-index `NodeId`s, one quorum group of all servers, `fanout_width`, `crash_candidates`, `client_role`, and a `RoleTable`. Language-level fields (root value, ctx, paths, hash, parameters) stay empty until Phase 3b.
- Build it once per distinct `num_servers` value and share it by `Arc`. The program's `Node` and `ClientInterface` roles are looked up once per program at load; those are the only role-name lookups left.
- Replace `TopologyInfo` with `&Deployment` in `exec_plan` and the scheduler (7.3).
- Replace every per-run "Node" and "ClientInterface" string lookup listed in Section 1.1 with deployment and `RoleTable` reads: `initialize_state`, `init_topology`, `run_single_simulation`, `run_single_plan`, the `exec_plan` server role lookup, `ClientPool` and `schedule_client_op`, `reinit_node`, `recover_node`, and the timeline capture and `server_role` comparison in `exec.rs` (`deployed_count`).
- Build the `Init` and `RecoverInit` arguments `(me, peers)` from the deployment in one function, used by run start and recovery alike.
- Per-node heuristic inputs from the deployment: `fanout_width`, the crash candidate list, `note_post_fault_request_entry`, the client-origin rule of `request_before_stale`, and retarget candidates (7.3).
- The `NodeId` role fix in `release_one`, `forced_victim`, `note_ghost_release_apply`, `retarget_crash` and `absorber_decision` (7.3).
- Partition construction from the deployment's group, with `MajoritiesRing` over `ring`. For this phase only, preserve the old filtering rules, including global-index fallback for non-members and the ring threshold and eligibility; both partition fixes follow in Phase 3b.
- No language, config schema, output schema or Go tool change.
- **Merge gate: strict release-build parity.**
  - Run the pre-change binary and the post-change binary on unchanged `bin/spur/Raft.spur` and `bin/spur/VR.spur`, with the same configs and `session_seed`, and with crashes and partitions enabled (`num_partitions` above 0).
  - Cover at least one full grid per spec, one genetic session, and one plan config with partition events.
  - Require identical `executions`, `logs` and `traces` tables, with no exceptions.
  - The check uses a release build only. Its scaffolding (the pre-change binary and the comparison script) is removed at the end of the iteration boundary.
- **Merge gate: throughput.** Run the perf grader's round-based throughput measurement on the VR loop config. A regression outside its noise band blocks the merge.

**Phase 3b: wire deploy evaluation (merges with Phases 1, 2 and 4)**
- Deployments come from deploy evaluation and the `DeployCache` instead of `num_servers` (4.2-4.6).
- `CTX_SLOT`, role parameters, `Init` and `RecoverInit` without arguments (4.7-4.9); client ctx, payload normalization and `Client.*` action names (4.10-4.11); partition groups from the root walk (4.12).
- Config schema: `deploy` and `params` in explorer configs, paths in plan configs (5).
- Explorer: parameter space, grid, genetic, AOS, continuous, curriculum and campaign changes, replay (6.1-6.5, 6.8); plan generation (6.6).
- Runs columns and the two new tables (6.7, 7.4); `--deploy` and debug formatting (7.5).
- Include the partition membership fix (4.12) as a separate commit after the migration is buildable with Phase 4. No runtime compatibility switch remains in the merged version.
- Follow it with the ring adjacency fix (10.11), including generated-group eligibility and explicit-plan validation, in another commit in the same merge. Audit and adapt small-ring plan configs in that commit so both measurement revisions remain runnable.
- **Merge gate: release-build parity.**
  - Run the pre-change binary with the current specs and `num_servers`, and the post-change binary with the migrated `bin/spur/Raft.spur` and `bin/spur/VR.spur` and `params.n`, using the same `session_seed`, with crashes enabled and `num_partitions = 0`.
  - Require identical `executions`, `logs` and `traces` tables over at least one full grid per spec. The action rename of Open question 10.6 is the only intended difference. The comparison also masks the `Enter` payloads of `Init` and `RecoverInit` in `traces`, which record the parameters those functions no longer take (VR traces both, Raft traces `RecoverInit`).
  - This holds only because single-role draws consume the same RNG streams (4.11, 4.12, 6.6) and grid order is unchanged for one `@scale` axis (6.3).
  - Genetic, AOS, continuous and curriculum modes draw and mutate parameters by the new rules of 6.4-6.5, so the check does not cover them.
  - Release build only; scaffolding removed at the end of the boundary.
- **Merge gate: partition semantics.**
  - Run the connectivity and activation/healing tests in Section 7.10 in debug and release builds. Validate intended connectivity directly rather than comparing partitioned traces to the old behavior.
  - Exercise a five-node ring plan that delivers adjacent-member messages while buffering nonadjacent-member messages until heal. Verify odd and even adjacency matrices and small-group rejection/shape redraws independently of the predicate implementation.
  - Run explicit plans for single-cluster client traffic and for two groups of the same role plus a router. Partition one group and verify that the other group and router/client links remain available while cross-side member traffic waits for heal. Include RPC requests and channel responses.
  - Re-run migrated plan configs containing partition events and record their outcomes. Classify any new linearizability violation against the protocol pseudocode; a changed outcome alone is not evidence of a simulator regression.
- **Merge gate: throughput and research impact.**
  - Measure structural overhead on the migrated commit before the membership-fix commit, using the Phase 3a throughput gate.
  - Compare the commits immediately before and after each of the membership and ring adjacency fixes with identical migrated explorer inputs and seeds, using the perf grader's round-based measurement and the lite grader's bug-finding measurement. Record throughput and bug-finding results separately: changed reachable schedules can change useful work per second. For explicit ring plans use sizes of at least four on both sides of the ring-fix comparison; report rewritten small-ring scenarios separately.
  - Investigate regressions and require an explicit merge decision based on both measurements. Do not waive unexplained implementation overhead as a semantic change.

**Phase 4: specs, configs, tools (same merge as Phase 3b)**
- Migrate every spec and fixture (9.1, 7.10) and every config (9.2).
- Porcupine and traceanalyzer changes (7.6, 7.7).
- Research harness changes (7.9).
- `spur-bench` boilerplate (7.8).
- Re-run the loop's grader smoke on the new inputs before restarting the loop.

**Phase 5: documentation and skills**
- Rewrite the documents listed in 7.11.
- Document `@deploy`, tags, paths and the new tables in `docs/simulator_options.md` and `docs/simulator_semantics.md`.
- Add the sharded example (8.2) to `bin/spur` in its single-file form (9.3), with its configs.

**Follow-up changes**

Each is its own merge after Phase 5, with its own measurement, and none is a prerequisite of the phases above:

- a crash budget, only if measurement shows a need, and only opt-in (Appendix B.6)
- explorer-config `targets` (Appendix B.7)
- `hash_string` (Appendix B.8)

### 11.1 Implementation starting point

Start with Phase 3a in an isolated checkout based on the latest `research/lite` state. Keep the root repository and `spur` submodule revisions paired when recording baselines. The source line references in this document describe the introductory revision, so resolve symbols in the current tree before editing.

Before changing simulator code:

1. Recheck that the research loop is stopped at an iteration boundary and record both repository revisions and the exact configs and seeds.
2. Build and retain a release baseline. Select the Raft and VR grids, a genetic session and a plan with partition events required by Phase 3a; keep outputs outside their ordinary output directories.
3. Map deployment construction through `explorer.rs`, `path.rs`, `core/state.rs`, `core/scheduler.rs` and `core/exec.rs`. Resolve role and function ids once, preserve allocation order and RNG consumption, and centralize start/recovery arguments.
4. Add group-based partition construction in `plan_config.rs` and `core/partition.rs`, retaining legacy filtering only for the Phase 3a measurement.
5. Run the parity and throughput gates before landing Phase 3a. Then build the language and evaluator work on the migration branch.

The membership-fix commit touches all three group shapes in `core/partition.rs`, plus focused connectivity and queue/heal tests. Membership must use the selected group's full node ids; a role match or a `node.index < deployed_count` check cannot distinguish two shards of the same role. Inspect `activate_partition`, scheduler-time filtering and `heal_partition` together so queued RPC records and channel sends obey the same rule. The following ring-fix commit changes member adjacency, construction validation and generated-group eligibility as specified in Section 10.11.

---

## Appendix A. Rejected alternatives

**A.1 A generic graph injected as `Init(topology)` with `get_reachable<T>()`.**
- A single graph mixes groups of the same role type. A node cannot tell "my Raft peers" from "the other shard's nodes" without names on top of the graph.
- Membership becomes local reachability. Two nodes can then disagree on the member set, which makes them disagree on quorum size and leader order, a disagreement the protocol never had.
- Edges do not constrain handle passing: once a handle arrives in a message, any node can call it, so the graph describes nothing the simulator enforces.
- A typed role parameter covers the same need: `type Mesh { peers: list<Node>; }` is that graph, with membership fixed and identical at every node.

**A.2 Per-role counts, `req.count<R>()`.**
- The count is ambiguous as soon as a role is instantiated several times, as in sharding: the number of Raft nodes is not the size of any cluster.
- The number of shards is itself a knob that per-role counts cannot express.

**A.3 Nested `spawn T { nodes<R>(k) }` blocks with lexical binding rules.**
- This needs a second binding construct with its own scoping, ordering and escape rules.
- `spawn` plus `provide` are two builtins checked by ordinary typing, one static effect rule, and one runtime check. Library builders are ordinary functions.

**A.4 String-named groups.**
- Names like `"shard0"` are unchecked, collide across modules, and carry no type.
- Struct fields name groups statically, and typed paths address them with load-time checks against the root type.

**A.5 Refinement types for parameter validity.**
- A refinement would duplicate what `nil` expresses: an arbitrary Spur predicate over the tuple, evaluated by the deploy function itself, which can also coerce.
- It would tie topology to a subsystem that may be removed.

---

## Appendix B. Deferred features and follow-up changes

**B.1 Crash domains and colocation.** Several roles on one machine should crash together.
- The deployment is a table of nodes, so a future `domain: u32` column (default: the node's own index) groups nodes.
- A builtin such as `colocate(hs)` would set it during deploy evaluation. Crash and recover events would then target domains, and `crash_candidates` would become domain candidates.
- Handles, role parameters, paths and the runs table are unaffected. The only type question is a heterogeneous handle list, which B.2's interface types or a tuple argument can answer.

**B.2 Interface types with idealized oracle implementations.**
- An `interface Log { async fn Append(...) }` implemented by a real role and by an oracle role would be chosen at deploy time by a `@choice` parameter.
- The deploy function spawns the concrete role and returns handles at the interface type. `provide` keeps using the concrete handle type, since it is statically known at the spawn site.
- The design needs subtyping from role handle to interface handle, and RPC dispatch by the handle's runtime role, which `NodeId.role` already carries.
- Config paths would type-check against the interface.

**B.3 Multiple clients per deploy.**
- `@deploy(clients = [A, B])` with a per-client operation mix in config. Client nodes already carry their role in `NodeId`.
- The Porcupine model must then be per client, or the clients must agree. `deployments.client` and `model` would become per-client rows.
- The fixed `Client.*` action namespace would gain the client's name as a suffix column rather than a prefix.

**B.4 Modules.**

What works in a single file:
- everything in Sections 2 through 8, using bare names (`Node`, `cluster`, `Single`)

What the design needs from modules:
- qualified names in type positions (`raft.Node`, `raft.Raft`), calls (`raft.cluster`), deploy selection (`"deploy": "sharded.Sharded"`), and `@deploy(client = sharded.RouterClient)`
- tags that survive import
- function names in the CFG and in `traces.function_name` qualified by module and role (`raft.Node.AppendEntries`), which plan `deliver.function` and research tools such as `ghost_census.py` read
- one program-wide namespace for `NameId`s, which the resolver already provides

The deploy table and type table in `Program` (Section 7.1) are keyed by `NameId` and store qualified display names, so modules add a prefix without changing any structure.

**B.5 Partition membership and ring adjacency (included in Phase 3b).**
- The change: `Halves`, `MajoritiesRing` and `Bridge` constrain only messages whose sender and receiver are both members of the partitioned group. A message with a non-member end, such as a client, a router or a node of another shard, is delivered. For members, `Halves` and `Bridge` behave as in Section 4.12, and `MajoritiesRing` measures distance by ring position only. `IsolateOne` is unchanged.
- It fixes both bugs of Section 7.12: clients are no longer cut off by `halves` or `bridge`, and no client position enters the ring arithmetic, so the underflow cannot occur.
- Why member pairs: with several groups, blocking every non-member partitions other shards and the routing tier too. That is a different fault, better expressed later as its own shape.
- The fix changes behavior on single clusters: clients stay connected to every server during `halves`, `bridge` and `majorities_ring`. It also ensures that partitioning one shard does not disconnect unrelated shards or routers.
- It lands as a separate commit within the coordinated topology migration, with before/after throughput and bug-finding measurements on identical migrated inputs. Phase 3a keeps strict parity; Phase 3b requires parity without partitions and direct semantic checks with partitions (Section 11).
- The ring adjacency fix follows in another commit in the same merge. It uses the smallest symmetric neighborhood containing a majority and excludes ineffective small rings (Section 10.11). Measure it independently from the membership fix.

**B.6 Crash budget (not in this design).**
- A crash budget bounds how many members of a quorum group are down at once in generated plans.
- Under crash-recovery with durable state, safety must hold for any number of simultaneous crashes, including every node at once. A budget cannot make a run more or less correct. It only steers generated plans away from schedules where a majority is down and nothing progresses, so it is an efficiency heuristic, not a statement about the fault model.
- A default of at most `f` members down at once per group would rule out whole-cluster restart, where every node crashes and recovers from persisted state. Whole-cluster restart is a classic source of real bugs, such as state not persisted before a yield point or recovery that trusts stale state.
- If it is added later, it is opt-in, and the default is unbounded. A natural construction reuses the mandatory-edge chain that `max_concurrent_writes` builds (`docs/simulator_options.md:163-173`), once per quorum group. It would also need a rule for groups where `(len - 1) / 2` is 0, and retargeting (Section 7.3) would have to respect it.

**B.7 Explorer-config `targets`.**
- A config block could restrict crash candidates and partition candidates to nodes and groups under given paths, and pin a client operation's destination to a path.
- It would reuse the path syntax and static checks of Sections 5.4-5.5. It also needs a policy for a path that does not resolve for some parameter tuple, for example rejecting that tuple.
- Until then, crash candidates are all deployed nodes and partition candidates are all groups.

**B.8 `hash_string`.**
- A builtin `hash_string(s: string): int`: deterministic, platform-independent and non-negative, for example FNV-1a 64 over the UTF-8 bytes with the top bit cleared. The exact definition would be fixed in `language.md` so recorded runs stay reproducible across platforms.
- Client-side and router-side key routing need it. No string-inspection builtin exists today (`spur-ast/src/name.rs:15-21`).
- With it, `shard_of` in Section 8.2 becomes `hash_string(key) % len(shards)`, and the route table, the `route_keys` parameter and the dependency on the explorer's key names go away.
