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
- `--deploy NAME` picks the `@deploy` function when the spec declares more than one

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

## Project Layout

- `bin/spur/` — specification files (`.spur`); `bin/spur/CRAQ.spur` is not maintained and does not compile
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
