# Spur

Spur is a domain-specific language for specifying and testing distributed protocols. The toolchain compiles `.spur` specifications, explores execution schedules via a simulator, and checks linearizability.

## Project Goal

Spur is a **protocol falsification tool**. The primary purpose is to find bugs, underspecifications, and ambiguities in published distributed protocols (papers, pseudocode), not just to verify that Spur implementations are correct translations. When a non-linearizable execution is found, always classify the root cause:

- **Paper bug**: The pseudocode itself is incorrect or incomplete (missing edge case, ambiguous ordering, underspecified recovery). These are the most valuable findings.
- **Implementation bug**: The Spur spec diverges from the pseudocode in a way that introduces a bug. These are translation errors.
- **Ambiguous**: The pseudocode is silent or unclear on the point in question, and the implementation had to make a choice. Flag these for the user — they may represent real underspecifications in the paper.

Be skeptical of papers. Do not treat pseudocode as infallible ground truth. When a violation matches the pseudocode faithfully, that's a finding about the protocol, not the implementation.

## Toolchain

1. **Spur compiler + simulator** (Rust) — compiles `.spur` specs and explores execution schedules
2. **Porcupine** (Go) — linearizability checker, verifies the Read/Write operations of the spec's `client` block
3. **Traceanalyzer** (Go) — computes trace metrics (duration, dispatch latency, interleaving, faults)

## Key Commands

All commands run from the project root.

### Explore (run simulator)

```bash
cargo run --release --manifest-path spur/Cargo.toml --bin spur -- explore -e standard --config CONFIG.json -y --output-dir output SPEC.spur
```

- `-y` auto-confirms output directory deletion
- `-e standard` for exhaustive/random exploration, `-e genetic` for genetic algorithm
- Linearizability checking is enabled by default in a separate bounded pool.
  `--set linearizability.enabled=false` opts out; `--set linearizability.stop_on_violation=false`
  keeps checking through the full sample. Throughput benchmarks keep checking enabled
- Virtual time is off unless the spec asks for it: a program that declares no `timing` block and never calls
  `mono_now`, `tt_now`, `set_timer_after` or `set_timer_at` is given no clocks
  and offered no time advances. A `clock` block in the config sets the rate
  bound `rho`, the truetime width `tt_width` and the rate mode;
  `faults.pause_fraction` reserves process pauses at checkpoints. A
  clock-using run writes `run_clocks`, `clock_observations` and
  `timer_events` beside the usual tables, and every `executions` row carries
  `global_time`. Named duration assignments are recorded in
  `runs.clock.durations` and restored by exact replay
- `record_replay` writes one exact-replay artifact per run into
  `<output>/replay/`; `spur replay -a <artifact> -o <dir> SPEC.spur` takes
  that execution again, step for step, and refuses anything it cannot
  reproduce exactly
- `explore` and `run-plan` return 0 for passing histories, 2 for violations, 4 for
  incomplete checking, and 1 for errors. Callers that complete checking offline must
  handle 0, 2, and 4 without treating violations or deferred checks as execution errors
- `--deploy NAME` picks the `@deploy` function when the spec declares more than one
- `--preset NAME` fills in `--config`, `--plan`, `--deploy`, `--set` and
  `--output-dir` from the crate's `spur.json`, on `explore`, `run-plan` and
  `resolve-plan`. It is the weakest override layer, so the environment and a
  flag both win a conflict. The research harness passes explicit paths and never
  uses a preset: the config a measurement ran under must not hide behind a name

### Inspect a deployment

```bash
cargo run --release --manifest-path spur/Cargo.toml --bin spur -- deploy SPEC.spur --params '{"n": 5}'
```

Prints the nodes, their roles, ordinals and paths, and the groups, for one parameter tuple. Use it when writing or changing a deploy function.

### Debug logs

```bash
cargo run --release --manifest-path spur/Cargo.toml --bin spur -- debug logs --db output --run-id N
cargo run --release --manifest-path spur/Cargo.toml --bin spur -- debug traces --db output --run-id N
cargo run --release --manifest-path spur/Cargo.toml --bin spur -- debug combined --db output --run-id N
```

- `debug logs` and `debug traces` take `--node-id N` (global index) or `--node PATH` (a path into the deployment, e.g. `nodes[2]`)
- Nodes are labelled `Role[ordinal] path`, for example `Node[2] nodes[2]`; clients are labelled `Client N`

### Trace analysis

```bash
cd traceanalyzer && go build -o main main.go && cd ..
./traceanalyzer/main -input output
```

### Porcupine (linearizability checker)

```bash
cd porcupine && go build -o main ./cmd/porcupine && cd ..
./porcupine/main -input output -type duckdb -output-dir output
```

- **Exit code 0** = all runs linearizable
- **Exit code 2** = linearizability violations found
- `-type duckdb` names how the tool reads the output directory, through DuckDB; the files themselves are Parquet

`-model` is optional: Porcupine reads the model from the `deployments` table, where it follows from the client the spec declares. Two variants exist:

- `kv` — for a client with only `Read`/`Write`. `Write(key, uid)` appends `uid` to `kv_store[key]`. State: `map<string, list<int>>` (Paxos, Raft, VR, Mencius, …).
- `kv_rmw` — for a client that also declares `RMW`. `Write(key, uid)` is a **blind overwrite** (`kv_store[key] = [uid]`); `RMW(key, uid)` appends `uid` and returns the prior list. State: `map<string, list<int>>` (same shape, different Write semantics). The two models are not interchangeable: Write means append under `kv` and overwrite under `kv_rmw`.

Pass `-model` only to override the recorded model, which prints a warning, or for a CSV history, which carries no `deployments` table.

## Modules and crates

A file is a module and the module tree is the directory tree. A one-file spec is
a one-module program: no `spur.json`, no `pub` and no `use` are needed, and its
output strings are unchanged.

- The module path `s1::s2::...::sn` names `<root>/s1/.../sn.spur`, where
  `<root>` is the directory holding the crate's `spur.json`, or the entry spec's
  own directory when there is none. Only files a `use` reaches are loaded
- `use raft;`, `use raft::Node as Replica;`, `pub use raft::Node;`. A `use` path
  is crate-absolute; an inline path like `raft::Cluster` starts at a module
  bound in that file, so it needs the `use`
- An item is `pub` or private; private means visible in the declaring module and
  its descendants. A role's functions carry the bit, and an RPC call to a
  handler private to another module is a type error
- A compiled function is `raft::Node.AppendEntries`: `::` for the module part,
  `.` between a role and its function. That is the spelling `traces.function_name`
  and a plan's `deliver.function` use
- `std` is compiled into the binary and bound in every module, so
  `std::quorum::f(n)` needs no `use`. `std::lists` and `std::maps` are plural
  because `list` and `map` are keywords. A program that never writes `std` loads
  none of it
- `bin/spur/spur.json` governs the sharded example only. A `.spur` path given to
  the CLI is always its own entry, so `spur check bin/spur/Raft.spur` still
  compiles that one file, as the root module, with short names
- A module keeps its own `@deploy` and `client` when it is imported: the sharded
  program carries `Sharded` and `Raft::Main` both, and a config picks one by
  name. An unqualified `"deploy"` still matches when exactly one deploy has that
  short name

`spur.json`:

```json
{
  "name": "sharded",
  "root": "sharded.spur",
  "deps": { "paxos": { "path": "../paxos" } },
  "presets": {
    "debug": { "config": "../../scheduler_configs/sharded_debug.json",
               "deploy": "Sharded", "set": ["num_runs_per_config=10"] }
  }
}
```

`name` defaults to the directory's name, `root` is required and must be an
existing `.spur` file, `deps` is path-only, and a preset carries `config` or
`plan` but never both. Unknown fields are rejected. The manifest never lists
modules.

## Project Layout

- `bin/spur/` — specification files (`.spur`)
- `bin/spur/sharded.spur` + `bin/spur/spur.json` — the multi-module example: a
  sharded store over several Raft clusters, importing `bin/spur/Raft.spur`
- `scheduler_configs/` — explorer configuration JSONs
- `spur/` — Rust workspace (compiler, simulator, CLI, LSP)
- `spur/design/language.md` — full language grammar and reference
- `docs/` — simulator semantics, options, tracing documentation
- `porcupine/` — Go linearizability checker
- `traceanalyzer/` — Go trace analysis tool
- `scripts/` — helper scripts (`porcupine.sh`, `trace.sh`)

## Important Notes

- Go tools (`porcupine/main`, `traceanalyzer/main`) need `go build` before first run
- The simulator writes Parquet, one directory per table; it has no other log backend. The Go tools query those files through DuckDB, which is what porcupine's `-type duckdb` means
- Porcupine checks linearizability by analyzing the client's `Read`/`Write` call-response pairs, recorded as `Client.Read` and `Client.Write`
- Every spec must have a `client` block with `Read` and `Write`, and a `@deploy` function naming that client, for linearizability verification to work
- `RMW([dest,] key, uid): list<int>` is optional in the client; it returns the prior committed list for `key` and is exercised when the scheduler config sets `num_rmw_ops > 0`. It selects the `kv_rmw` model
- Explorer and plan configs name a `deploy` and its `params`; there is no node-count key

## Code style

All code and comments follow `research/STYLE.md`: comments state constraints only, carry no history or plan references, use plain words, and are ASCII-only.
