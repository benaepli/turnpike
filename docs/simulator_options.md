# Simulator Options

The Spur simulator is highly configurable via CLI flags and JSON configuration files. This document details the parameters available for tweaking simulation runs.

## CLI Subcommands & Flags

The primary entry point operates via subcommands on the main `spur` cargo project:

```bash
cargo run --release --manifest-path spur/Cargo.toml --bin spur -- [SUBCOMMAND] [OPTIONS...]
```

### `explore`

Runs the main execution explorer over a configuration space, compiling the spec internally.

- `-c, --config [FILE]`: The JSON configuration file defining exploration parameters, including the scheduler policy, diversity rates, and bounded executions (e.g. number of nodes, crashes, etc.).
- `-o, --output-dir [DIR]`: Directory to emit traces and graph visualizations.
- `-e, --explorer [TYPE]`: The exploration strategy. Options:
  - `standard` (Default): Exhaustive or randomly sampled bounded execution.
  - `genetic`: Genetic algorithm-based exploration for finding edge cases.
- `--log-backend [BACKEND]`: Determines the format for execution history persistence.
  - `parquet` (Default): High-performance structured logging utilizing Apache Parquet.
  - `duckdb`: SQLite-like backend using DuckDB.

### `run-plan`

Executes a fixed, deterministic DAG schedule of events instead of exploring random schedules.

- `-p, --plan [FILE]`: The plan configuration JSON file.
- `-o, --output-dir [DIR]`: Output directory for results.
- `--log-backend [BACKEND]`: Same log backend options as `explore`.

Plan configs support `partition` and `heal` events alongside `crash`, `recover`, and `allow_timer`. Partition events specify a partition type:

```json
{
  "events": {
    "p1": { "partition": { "type": "isolate_one", "node": 0 } },
    "h1": "heal",
    "w1": { "write": [1, "x", "1"] },
    "r1": { "read": [0, "x"] }
  },
  "dependencies": [
    ["w1", "p1"],
    ["p1", "r1"],
    ["r1", "h1"]
  ]
}
```

Available partition types: `isolate_one`, `halves`, `majorities_ring`, `bridge`. See [Simulator Semantics](simulator_semantics.md#network-partitions) for details.

## Scheduler Configuration

The following fields are available in both `explore` configs (`ExplorerConfig`) and `run-plan` configs (`PlanFileConfig`). All are optional with sensible defaults.

### `queue_policy`

Controls which queue group the scheduler draws from on each step. Specified as a tagged JSON object with a `"type"` field.

**`Probabilistic`** (default) — rolls a weighted die each step to pick local, network, or timer. Falls through to non-empty queues if the chosen group is empty.

```json
"queue_policy": { "type": "Probabilistic", "p_local": 0.80, "p_timer": 0.03 }
```

- `p_local` (default 0.80): probability of selecting a local queue
- `p_timer` (default 0.03): probability of selecting the timer queue
- Network probability is `1 - p_local - p_timer`

**`Preemptive`** — drains the active node's local queue before moving on, forcing a network pull every `preempt_interval` steps to prevent starvation.

```json
"queue_policy": { "type": "Preemptive", "p_timer": 0.15, "preempt_interval": 50 }
```

- `p_timer`: probability of selecting the timer queue (checked first each step)
- `preempt_interval`: maximum steps between forced network queue pulls

### `schedule_policy`

Controls how base priorities are sampled when new runnables are created. Tagged JSON with a `"type"` field.

**`Fixed`** — legacy behavior with hardcoded priorities per category. No extra fields.

```json
"schedule_policy": { "type": "Fixed" }
```

**`Shaped`** (default) — samples from a Beta distribution mapped into per-category priority bands. Each band has a `center` and `width`; the sampled priority is `center + width × (2 × Beta(α,β) - 1)`, clamped to [0, 1].

```json
"schedule_policy": {
    "type": "Shaped",
    "alpha": 0.5,
    "beta": 0.5,
    "record": { "center": 0.5, "width": 0.15 },
    "timer": { "center": 0.25, "width": 0.10 },
    "channel_send": { "center": 0.5, "width": 0.15 },
    "crash": { "center": 1.0, "width": 0.05 },
    "recover": { "center": 1.0, "width": 0.05 },
    "partition": { "center": 1.0, "width": 0.05 },
    "heal": { "center": 1.0, "width": 0.05 }
}
```

All band fields are optional and default to the values shown above. The default `alpha: 0.5, beta: 0.5` produces an arcsine distribution that favors extreme priorities.

### `quick_fire_multiplier`

Float, default `5.0`. Boosts the beam selection score of `Recover` events when their target node is currently crashed. Higher values make recovery happen sooner after a crash. See [Simulator Semantics](simulator_semantics.md#quick-fire-priority-boosting) for the scoring formula.

```json
"quick_fire_multiplier": 5.0
```

### `purgatory`

Configures probabilistic message delays for remote `ChannelSend` runnables. Disabled by default.

```json
"purgatory": { "delay_probability": 0.15, "delay_duration_range": [5, 100] }
```

- `delay_probability` (default 0.0): probability that each remote `ChannelSend` is delayed. `0.0` disables purgatory entirely.
- `delay_duration_range` (default `[5, 50]`): `[min_steps, max_steps]` for log-uniform delay sampling.

See [Simulator Semantics](simulator_semantics.md#purgatory-message-delays) for details on crash and partition interactions.

## Logging & Output Formats

By utilizing the `HistoryWriter` trait, Spur can decouple execution logic from persistence.

### Structured Logging

Depending on the chosen backend, the simulator emits files encompassing several distinct data schemas generated per run:

1. `executions`: Logs client operations (`Invocation`, `Response`, `Crash`, `Recover`, `Partition`, `Heal`). Used heavily for linearizability checking.
2. `logs`: Captures standard print statements and application-level debug output.
3. `traces`: Structured trace events from the `@trace` annotations (see the tracing documentation).

## Porcupine Integration

Porcupine is the linearizability checker that integrates natively with the `executions` output of the Spur simulator.

By running `porcupine/main` on the resulting SQLite/Parquet files, developers can ascertain if a generated schedule violated the guarantees of the protocol (e.g. key-value constraints). Porcupine also yields a useful HTML visualization that diagrams the execution interleavings of node invocations, facilitating debugging when a simulation trace violates linearizability.
