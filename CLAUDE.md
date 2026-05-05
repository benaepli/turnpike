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
2. **Porcupine** (Go) — linearizability checker, verifies Read/Write operations from `ClientInterface`
3. **Traceanalyzer** (Go) — computes trace metrics (duration, dispatch latency, interleaving, faults)

## Key Commands

All commands run from the project root.

### Explore (run simulator)

```bash
cargo run --release --manifest-path spur/Cargo.toml --bin spur -- explore -e standard --config CONFIG.json -y --output-dir output SPEC.spur
```

- `-y` auto-confirms output directory deletion
- `-e standard` for exhaustive/random exploration, `-e genetic` for genetic algorithm

### Debug logs

```bash
cargo run --release --manifest-path spur/Cargo.toml --bin spur -- debug logs --db output --run-id N
cargo run --release --manifest-path spur/Cargo.toml --bin spur -- debug traces --db output --run-id N
cargo run --release --manifest-path spur/Cargo.toml --bin spur -- debug combined --db output --run-id N
```

### Trace analysis

```bash
cd traceanalyzer && go build -o main main.go && cd ..
./traceanalyzer/main -input output
```

### Porcupine (linearizability checker)

```bash
cd porcupine && go build -o main main.go && cd ..
./porcupine/main -input output -type duckdb -model kv -output-dir output
```

- **Exit code 0** = all runs linearizable
- **Exit code 2** = linearizability violations found

Two model variants exist; pick one based on what operations the spec exposes:

- `-model kv` — for protocols with only `Read`/`Write`. `Write(key, uid)` appends `uid` to `kv_store[key]`. State: `map<string, list<int>>` (Paxos, Raft, VR, Mencius, CRAQ, …).
- `-model kv_rmw` — for protocols that also expose `ClientInterface.RMW`. `Write(key, uid)` is a **blind overwrite** (`kv_store[key] = [uid]`); `RMW(key, uid)` appends `uid` and returns the prior list. State: `map<string, list<int>>` (same shape, different Write semantics). The two models are not interchangeable: Write means append under `kv` and overwrite under `kv_rmw`.

## Project Layout

- `bin/spur/` — specification files (`.spur`)
- `scheduler_configs/` — explorer configuration JSONs
- `spur/` — Rust workspace (compiler, simulator, CLI, LSP)
- `spur/design/language.md` — full language grammar and reference
- `docs/` — simulator semantics, options, tracing documentation
- `porcupine/` — Go linearizability checker
- `traceanalyzer/` — Go trace analysis tool
- `scripts/` — helper scripts (`porcupine.sh`, `trace.sh`)

## Important Notes

- Go tools (`porcupine/main`, `traceanalyzer/main`) need `go build` before first run
- The simulator uses DuckDB as its default log backend
- Porcupine checks linearizability by analyzing `ClientInterface` `Read`/`Write` call-response pairs
- Every spec must have a `ClientInterface` with `Read` and `Write` functions for linearizability verification to work
- `ClientInterface.RMW(dest, key, uid): list<int>` is optional; it returns the prior committed list for `key` and is exercised when the scheduler config sets `num_rmw_ops > 0`. Checked under `-model kv_rmw`.
