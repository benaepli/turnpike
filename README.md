# Turnpike

A distributed system execution explorer and linearizability checker built with Rust and Go.

## Architecture

The bulk of this project is contained in the Rust-based compiler and simulator `spur`.

The repository is organized as follows:

```text
spur/                   # Spur specification compiler and simulator
  src/simulator/        # Parallelized event-loop simulator
porcupine/              # Linearizability checker (Go submodule)
traceanalyzer/          # Go-based tool for run metrics
docs/                   # Documentation
```

## Quick Start

### Step 1: Run the Simulator

Spur is a domain-specific language for specifying distributed protocols. The `explore` subcommand compiles the `.spur` script internally and executes it according to a provided scheduler configuration.

**Basic usage:**

```bash
RUST_LOG=info cargo run --release --manifest-path spur/Cargo.toml --bin spur -- explore \
  -e standard \
  --config scheduler_configs/vr_comprehensive.json \
  --output-dir output \
  bin/spur/SDPaxos.spur
```

_(For a full list of simulator options, including configurable scheduling, log backends, and bounded execution, refer to [Simulator Options](docs/simulator_options.md).)_

Finished runs are checked by default in a bounded Rust worker pool, and a
violation stops exploration. Histories that cannot enter the pool are saved
for offline checking. Use `--set linearizability.enabled=false` to opt out. See
[Integrated Linearizability Checking](docs/linearizability.md) for capacity,
backpressure, timeouts, and exit statuses.

### Step 2: Check Linearizability with Porcupine

Porcupine can ingest the execution traces produced by the simulator to verify if the generated history is linearizable.

**Build Porcupine:**

```bash
cd porcupine
go build -o main ./cmd/porcupine
cd ..
```

**Check a trace:**

```bash
./porcupine/main -input output -output-dir output -type duckdb > output.log
```

The model follows from the spec's client and is read from the simulator's `deployments` table, so `-model` is only needed to override it.

**Output:**

- Generates HTML visualizations (`output/run_N.html`) showing the execution history and linearizability result, with nodes labelled by role and ordinal. Compatible passes from integrated checking are reused without generating HTML; `-recheck-all` checks and visualizes every run.
- Verification status is printed to the log

## Advanced Documentation

For detailed information about the simulator's inner workings, refer to the following guides:

- [Language Design](spur/design/language.md)
- [Simulator Semantics](docs/simulator_semantics.md)
- [Simulator Options](docs/simulator_options.md)
- [Integrated Linearizability Checking](docs/linearizability.md)
- [Tracing and Telemetry](docs/tracing.md)
