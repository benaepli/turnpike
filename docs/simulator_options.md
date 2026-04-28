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
    "w1": { "write": [1, "x"] },
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

### `within_queue_selector`

Controls how a single runnable is picked from the eligible items *within* the queue chosen by `queue_policy`. Each runnable has a score in `[0, 1]` combining novelty and priority; this selector decides how that score maps to selection probability.

**`Tournament`** (default) — sample `k` indices uniformly with replacement, take the highest score. Near-greedy for typical k, since the top item wins with probability `1 − (1 − 1/N)^k` on a queue of size N.

```json
"within_queue_selector": { "type": "Tournament", "k": 10 }
```

- `k` (default 10): tournament size. Capped at the number of eligible items per pick.

**`Proportional`** — Waldspurger-style lottery. Selection probability is proportional to `score^exponent`, computed in one pass via the Efraimidis–Spirakis weighted reservoir trick. Slides between uniform and greedy with a single knob.

```json
"within_queue_selector": { "type": "Proportional", "exponent": 1.0 }
```

- `exponent` (default 1.0): sharpness of the weighting.
  - `0.0` → all eligible items equally likely (uniform exploration).
  - `1.0` → classic proportional lottery (`P(i) ∝ score_i`).
  - Larger values approach greedy. Items with score 0 are floored to a small ε so they remain reachable.

For scores `0.2 / 0.5 / 0.9` on a 3-item queue, `exponent = 1.0` gives selection probabilities ≈ `0.125 / 0.313 / 0.563`, while the default `Tournament { k: 10 }` is approximately greedy on the top item.

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

### `max_concurrent_writes`

Caps the number of generator-produced write-like operations (Write and RMW) that can be in flight simultaneously. Only applies to `explore` configs (the plan generator). Unset (the default) disables the cap; `0` is invalid.

When set to `K >= 1`, `generate_plan` adds a mandatory edge from `op[i - K]` to `op[i]` in declaration order across the combined Write/RMW sequence, forcing earlier write-like ops to complete before later ones can start. This is the primary knob for controlling Porcupine's cost on the `kv` and `kv_rmw` models: concurrent state-mutating ops multiply per-key state combinatorially, and the cap upper-bounds that explosion.

The chain is global across keys and across the Write/RMW distinction — it is an over-approximation when write keys are diverse, but gives a strict bound regardless.

```json
"max_concurrent_writes": { "min": 2, "max": 3, "step": 1 }
```

### `num_rmw_ops`

Controls how many `ClientInterface.RMW` invocations the plan generator emits per run. Only applies to `explore` configs and is **opt-in** — defaults to `{min: 0, max: 0, step: 1}`, so existing configs and specs are unaffected. Set this to a positive value only when the spec under test declares a void `RMW(dest, key, uid)` in `ClientInterface` and stores `map<string, list<(int?, int)>>` in `kv_store` (the Gryff-style shape).

```json
"num_rmw_ops": { "min": 1, "max": 3, "step": 1 }
```

RMW invocations share the [`max_concurrent_writes`](#max_concurrent_writes) budget with `Write` since both mutate per-key state. The corresponding Porcupine model is `-model kv_rmw`; `prev_uid` correctness is validated only when a `Read` returns the tagged log, so configs with `num_rmw_ops > 0` should keep `num_read_ops > 0` (the explorer logs a warning otherwise).

### `num_keys`

Controls how many distinct keys the plan generator samples from when producing client `Write` and `Read` invocations. Only applies to `explore` configs (the plan generator) — in `run-plan` mode, each event specifies its own key string directly. Defaults to `1` (a single key, `key1`).

Spreading operations over many keys dilutes per-key concurrency and masks most linearizability bugs, which typically manifest per-key (stale reads, lost writes, split-brain on one register). Keeping the default at 1 concentrates contention and tends to surface violations sooner. Raise `num_keys` only when the protocol's correctness depends on cross-key interactions (e.g. sharding, batching across keys).

When set to `K`, each generated Write/Read uniformly picks a key from `key1`..`keyK`.

```json
"num_keys": { "min": 1, "max": 3, "step": 1 }
```

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

The `kv` model treats each key's value as an append-only log of write uids — `Write(dest, key, uid)` appends `uid` to that key's log, and `Read(dest, key)` must return the full committed log as a `list<int>`. Because the state space of ordered logs grows combinatorially with concurrent writes, large configurations should use [`max_concurrent_writes`](#max_concurrent_writes) to keep the check tractable.

The `kv_rmw` model is the read-modify-write variant. Each key's value is a `list<(int?, int)>` of `(prev_uid, uid)` entries: blind `Write` appends `(nil, uid)`, and `RMW` appends `(prior_tail_uid?, uid)` where the model authoritatively records the `prev_uid` implied by the linearization. `Read` returns this tagged log. Validation is **deferred to Read**: the model accepts any RMW invocation but rejects a `Read` whose observed log disagrees with the model's chain (including the `prev_uid` fields). A protocol that records the wrong `prev_uid` for an RMW is therefore caught only when a subsequent `Read` exposes it — pair `num_rmw_ops > 0` with `num_read_ops > 0`. The `kv` and `kv_rmw` models are not interchangeable: the response shapes differ, so a spec picks one and uses the matching `-model` flag.
