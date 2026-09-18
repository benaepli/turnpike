# Simulator Options

The Spur simulator is highly configurable via CLI flags and JSON configuration files. This document details the parameters available for tweaking simulation runs.

## CLI Subcommands & Flags

The primary entry point operates via subcommands on the main `spur` cargo project:

```bash
cargo run --release --manifest-path spur/Cargo.toml --bin spur -- [SUBCOMMAND] [OPTIONS...]
```

### `explore`

Runs the main execution explorer over a configuration space, compiling the spec internally.

- `-c, --config [FILE]`: The JSON configuration file defining exploration parameters, including the scheduler policy, diversity rates, the deploy and its parameter ranges, and bounded executions (crashes, partitions, client operations).
- `-o, --output-dir [DIR]`: Directory to emit traces and graph visualizations.
- `-e, --explorer [TYPE]`: The exploration strategy. Options:
  - `standard` (Default): Exhaustive or randomly sampled bounded execution.
  - `genetic`: Genetic algorithm-based exploration for finding edge cases.
- `--deploy [NAME]`: The `@deploy` function to run, overriding the config's `deploy` key.
- `--log-backend [BACKEND]`: The format for execution history persistence. `parquet` is the only backend: Apache Parquet files, one directory per table.
- `--set PATH=VALUE` (repeatable): Overrides one dotted config field before parsing (see `scheduler_configs/loop/README.md`). Parameter ranges are objects, so `--set params.n.max=7` works; a `@choice` array is replaced whole, as in `--set 'params.mode=["plain"]'`.

The standard explorer writes `session.json` inside and beside the output directory: `wall_ms` (active time on a monotonic clock from the first queued run to the last finished one), `runs_completed`, `runs_failed`, `runs_skipped`, `wall_budget_sec`, `budget_hit`, `writer_flush_ms`, and the deployment summary: `deploy` (the selected deploy's name), `deployments_built`, `deploy_rejections` (parameter tuples the deploy returned `nil` for), `tuples_aliased` (tuples that built a deployment equal to an earlier one) and `nodes_beyond_mask_width` (nodes past index 63 in the largest deployment, which the 64-bit crash-hold and retarget masks never select).

Linearizability checking is enabled by default in a separate bounded pool for
all explorer modes and `run-plan`; `linearizability.enabled=false` opts out.
Its configuration controls workers, queue count
and bytes, per-history timeout, deferral or blocking on overflow, and stopping
on violations. See [Integrated Linearizability Checking](linearizability.md)
for defaults, persistence, offline reuse, and exit statuses.

#### `wall_budget_sec`

Active-time budget for the whole session, in seconds, measured on a monotonic clock that a machine suspend does not advance; `0` (the default) lets the grid alone end the session. Under a budget the grid is walked in rounds, one run of every configuration per round, so a cut leaves every configuration within one run of every other and the corpus keeps the grid's composition whatever the throughput. Runs already started finish. A budgeted session is not reproducible run for run; `num_runs_per_config` stays as an upper bound.

### `run-plan`

Executes a fixed, deterministic DAG schedule of events instead of exploring random schedules.

- `-p, --plan [FILE]`: The plan configuration JSON file.
- `-o, --output-dir [DIR]`: Output directory for results.
- `--deploy [NAME]`: The `@deploy` function to run, overriding the plan's `deploy` key.
- `--log-backend [BACKEND]`: Same log backend options as `explore`.

A plan fixes one parameter tuple with `params` and names its nodes and groups by path into the deployment value. Plan configs support `partition` and `heal` events alongside `crash`, `recover`, `allow_timer` and `deliver`:

```json
{
  "deploy": "Main",
  "params": { "n": 5 },
  "num_runs": 50,
  "max_iterations": 5000,
  "events": {
    "w1": { "write": { "dest": "nodes[1]", "key": "x" } },
    "r1": { "read": { "dest": "nodes[0]", "key": "x" } },
    "c1": { "crash": "nodes[1]" },
    "v1": { "recover": "nodes[1]" },
    "p1": { "partition": { "type": "isolate_one", "node": "nodes[0]" } },
    "p2": { "partition": { "type": "halves", "group": "nodes", "side_a": [0, 1] } },
    "p3": { "partition": { "type": "bridge", "group": "nodes", "bridge": 2 } },
    "p4": { "partition": { "type": "majorities_ring", "group": "nodes" } },
    "h1": "heal",
    "t1": { "advance_time": { "ticks": 120 } },
    "z1": { "pause": { "node": "nodes[0]" } },
    "z2": { "resume": "nodes[0]" },
    "d1": { "deliver": { "function": "Node.AppendEntries", "from": "nodes[0]", "to": "nodes[1]" } }
  },
  "dependencies": [
    ["w1", "p1"],
    ["p1", "r1"],
    ["r1", "h1"]
  ]
}
```

- `dest` is omitted for a client operation that takes no destination, and required for one that takes one. Its role must match the operation's `dest` parameter.
- `side_a` and `bridge` are positions in `group`, shorthand for `group[i]`.
- `deliver.function` is the qualified handler name as recorded in traces, for example `Node.AppendEntries`.
- `pause.node` arms a process pause on that node, at `checkpoint` (a positive occurrence within the node's current incarnation) or the next one it reaches. A planned pause offers no automatic resume: it completes when the checkpoint is actually interrupted, and ends only when its `resume` event executes, so `pause -> advance_time -> resume` orders an interval of time the process spent held. At most one armed or active pause per node; a crash cancels the pause and settles the matching resume.
- `resume.node` names the node to resume, and must depend on its pause.
- `advance_time.ticks` must be positive. It is the only way a plan moves global time: the scheduler samples no advances in `run-plan`. The event completes when the advance executes, so a later event can depend on time having passed. A timer permission never advances time, and an advance never grants a permission.

Available partition types: `isolate_one`, `halves`, `majorities_ring`, `bridge`. See [Simulator Semantics](simulator_semantics.md#network-partitions) for details.

Every path is checked when the plan loads, first against the deploy's root type and then against the deployment the plan's tuple builds. A path that does not resolve, an empty partition group, a `majorities_ring` group with fewer than four distinct members, and a `side_a` or `bridge` position outside the group are all load errors, reported before any run.

`run-plan` writes `plan_resolved.json` beside its output: the plan with every path replaced by the global node index it resolved to. `traceanalyzer -dag-config` reads that file.

### `replay`

Takes one recorded execution again, step for step.

```bash
spur replay -a output/replay/run_12.json -o replayed -y SPEC.spur
```

- `-a, --artifact [FILE]`: the artifact an earlier `record_replay` session wrote.
- `-o, --output-dir [DIR]`: where the replayed run's tables go.

The artifact carries its own deploy, parameters and workload, so no config or
plan file is needed. Replay refuses an artifact whose program digest,
semantics version or artifact version does not match, installs the recorded
clocks, and executes the recorded actions in order rather than redrawing
them. It hands back each recorded observation after checking the node,
incarnation, epoch, site, occurrence and global time it was taken at, that a
monotonic reading agrees with the installed clock, and that an interval
contains its own observation time within the configured width.

Nothing that matters falls back to sampling. A missing, extra, reordered or
invalid choice, an action that is not eligible where the record says it ran,
and an action or observation left unused at the end are all errors. A replay
stops where the recorded run stopped, so a capped or stalled execution
reproduces as the one it was.

### `deploy`

Evaluates one parameter tuple and prints the resulting deployment as JSON: the deploy name, hash, parameters, per-role counts, every node's index, role, ordinal and canonical path, and every group with its paths, members and quorum flag. This is the authoring loop for deploy functions.

```bash
cargo run --release --manifest-path spur/Cargo.toml --bin spur -- deploy SPEC.spur --deploy Main --params '{"n": 5}'
```

A tuple the deploy rejects prints `{"rejected": true}`.

### `debug`

`debug logs` and `debug traces` select a node either by global index with `--node-id N` or by path with `--node PATH`, resolved through the run's deployment. The two flags are mutually exclusive, and omitting both shows every node. `debug logs`, `debug traces` and `debug combined` label each node as `Role[ordinal] path`, for example `Node[2] nodes[2]`; client nodes are labelled `Client N`.

## Deployment Configuration

### `deploy`

String, naming the `@deploy` function to run. It may be omitted when the program declares exactly one. `--deploy NAME` overrides it.

### `params`

One entry per field of the deploy's parameter struct, and no others.

In an `explore` config, a `@scale` field takes a range object and a `@choice` field a non-empty array of values:

```json
"params": {
  "n": { "min": 3, "max": 7, "step": 2 },
  "mode": ["plain", "pre_vote"],
  "cache_leaders": [false, true]
}
```

`step` defaults to 1. Choice values are checked against the field type: numbers for `int`, booleans for `bool`, strings for `string`, and variant names as strings for enums. A field with no entry, an entry with no field, a wrong shape, `min > max`, `step < 1` and duplicate choice values are all load errors.

In a `run-plan` config, `params` gives one fixed value per field instead:

```json
"params": { "n": 5 }
```

The explorer varies only these fields. Every tuple of the space is evaluated when the config loads, and the space may hold at most 4096 tuples. Each tuple's deployment is built once and shared by every run of that tuple; tuples that build structurally equal deployments are merged into one deployment, and tuples the deploy rejects are skipped. A deploy that rejects every tuple is a load error. Grid mode visits deployments small first, ordered by the positions of the `@scale` axes.

The genetic, curriculum and continuous modes draw and mutate tuples instead: a `@scale` axis is drawn with weight `1 / (i + 1)` on position `i` so small values come first, a `@choice` axis uniformly, and a mutation moves a `@scale` axis one position or resamples a `@choice` axis. A draw that lands on a rejected tuple is retried, and a rejected mutation keeps the parent's tuple.

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

Controls how a single runnable is picked from the eligible items _within_ the queue chosen by `queue_policy`. Each runnable has a score in `[0, 1]` combining novelty and priority; this selector decides how that score maps to selection probability.

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

### `clock`

Configures virtual time: the clock assumptions each run is drawn under and the
settings of the explorer's time-advance sampler. Both `explore` and `run-plan`
accept it. A program that reads no clock and registers no timed timer is given
no clocks at all and is offered no advances, so the block changes nothing for
it.

```json
"clock": { "rho": 0.05, "tt_width": 40, "rates": "extremes" }
```

- `rho` (default `0.0`): the rate bound. Each node's monotonic clock advances
  at a rate in `[1 - rho, 1 + rho]` times global time. `0.0` gives every node
  an exact rate and a zero origin, which is the control configuration.
- `tt_width` (default `0`): the largest full width, in ticks, of an interval
  `tt_now()` may return. `0` makes every observation exact.
- `rates` (default `"extremes"`): `"extremes"` draws each node's rate from the
  two ends of the band and one; `"sampled"` draws anywhere in it. Opposing
  rates at a grantor and a holder are what a lease margin has to survive, so
  the ends are worth more than the interior.
- `advance_weight` (default `0.25`): the chance a scheduling step takes a time
  advance rather than ordinary work, while both are possible. A heuristic, not
  a clock assumption; it is recorded with the run's search settings.
- `advance_max_log2` (default `12`): the largest sampled advance is
  `2^advance_max_log2` ticks.
- `origin_spread` (default `64`): the largest magnitude of a drawn clock
  origin. Origins differ between nodes, so no two clocks share a zero.

Time advances are a scheduler action of their own: one costs a step whatever
its size, runs no protocol code and fires no timer. A timed timer becomes
eligible when its owner's clock reaches its deadline, and still has to be
selected in a later action to fire. See
[Simulator Semantics](simulator_semantics.md#virtual-time) for the contract.

In `run-plan` the scheduler samples no advances: time moves only through
`advance_time` events.

### `record_replay`

Writes one **exact-replay artifact** per run into `<output>/replay/run_N.json`.
Off by default: it records every scheduling choice of every run.

Each artifact carries the digest of the compiled program, the semantics
version, the deploy and its parameters, the workload's events and
dependencies outright, the settings the run's execution depends on, the
clocks each node was given, every clock observation, every scheduler action
in execution order, the message delays, the pause reservation, and the
endpoint the run stopped at.

It does **not** carry a random-draw tape. The crash-placement span and the
step cap are learned across a session, so a tape replayed in a fresh process
takes a different number of draws and every later value comes from the wrong
place. The artifact carries the decisions instead, and replay executes them.
What is left over - a queued item's priority, which only orders a selection
the record already fixes - is drawn freshly and ignored.

```json
"record_replay": true
```

### Time metrics

`traceanalyzer` reports a **Virtual Time** block for a corpus whose runs moved
time or held a process: the runs that did, the time advances (total, per run
and the largest single run), and the pauses (total, per run, the largest
single run, how many resumed and how many a crash cancelled). A corpus whose
specs read no clock reports nothing rather than a row of zeros.

### `faults.pause_fraction`

Share of runs that reserve one **process pause**, addressed as the k-th
checkpoint the run reaches with k drawn log-uniformly. `0.0` by default: a
pause changes what the explorer searches, and the complementary runs draw
nothing at all, so the two populations form an internal placed-versus-stock
contrast. Run-cap probes are exempt at every value.

A checkpoint is a clock read or a timed-timer registration written directly in
an async body, so a program that reads no clock reaches none and no
reservation can fire. See
[Simulator Semantics](simulator_semantics.md#process-checkpoints-and-the-placed-pause).

```json
"faults": { "pause_fraction": 0.5 }
```

### `max_concurrent_writes`

Caps the number of generator-produced write-like operations (Write and RMW) that can be in flight simultaneously. Only applies to `explore` configs (the plan generator). Unset (the default) disables the cap; `0` is invalid.

When set to `K >= 1`, `generate_plan` adds a mandatory edge from `op[i - K]` to `op[i]` in declaration order across the combined Write/RMW sequence, forcing earlier write-like ops to complete before later ones can start. This is the primary knob for controlling Porcupine's cost on the `kv` and `kv_rmw` models: concurrent state-mutating ops multiply per-key state combinatorially, and the cap upper-bounds that explosion.

The chain is global across keys and across the Write/RMW distinction — it is an over-approximation when write keys are diverse, but gives a strict bound regardless.

```json
"max_concurrent_writes": { "min": 2, "max": 3, "step": 1 }
```

### `num_rmw_ops`

Controls how many `Client.RMW` invocations the plan generator emits per run. Only applies to `explore` configs and is **opt-in** — defaults to `{min: 0, max: 0, step: 1}`. Set this to a positive value only when the spec under test declares `RMW([dest,] key, uid): list<int>` in its `client` block and stores `map<string, list<int>>` in `kv_store` under the `kv_rmw` Write/RMW semantics (Write overwrites, RMW appends). A config with `num_rmw_ops > 0` against a client without `RMW` is rejected when the config loads.

```json
"num_rmw_ops": { "min": 1, "max": 3, "step": 1 }
```

RMW invocations share the [`max_concurrent_writes`](#max_concurrent_writes) budget with `Write` since both mutate per-key state. The corresponding Porcupine model is `kv_rmw`. Each RMW's return value is checked directly against the model's state, so RMW errors surface without needing a follow-up `Read` — though reads still add useful coverage.

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

1. `executions`: Logs client operations and system events (`Invocation`, `Response`, `Crash`, `Recover`, `Partition`, `Heal`, `TimerFired`). Client operations use the actions `Client.Write`, `Client.Read` and `Client.RMW`, whatever the client is named. An invocation payload is `[dest, key, uid]` for Write and RMW and `[dest, key]` for Read, where `dest` is the destination node or unit when the operation takes none. Used heavily for linearizability checking; the checker skips `TimerFired`, whose payload is the node and the timer's label.
2. `logs`: Captures standard print statements and application-level debug output.
3. `traces`: Structured trace events from the `@trace` annotations (see the tracing documentation).
4. `runs`: One row per run: `deployment_id` (into the `deployments` table, `-1` for a run that failed before its deployment was chosen), `params` (JSON of the tuple that selected the run, which may be an alias of the deployment's canonical tuple), `arm` (the strategy that issued it; the explorer mode for a single-strategy session), `arm_index`, `config_index` (into the expanded grid, `-1` when not a grid point), `workload_seed`, `schedule_seed`, `steps_used`, `wall_us` (active time), `end_reason` (`plan_complete`, `iterations_exhausted`, `deadlock`, `learned_cap_reached`), `session_offset_ms` (active time from the session's start to the run's end), the timer columns (`timers_fired`, `timers_acted`, and their `inflight`/`idle` splits, plus `max_inert_streak`), and `variant` (a bitfield naming the session-global mechanisms that selected the run: `1` placed crashes, `2` run-cap probe, `4` timer-context probe, `8` a crash hold was actually drawn). A run that failed before producing a history has no row. `traceanalyzer -input DIR -runs` prints the table as JSON.
5. `deployments`: One row per distinct deployment the session built: `deployment_id`, `deploy`, `client`, `model` (`kv` or `kv_rmw`), `params` (the canonical tuple), `aliases` (a JSON array of the other tuples that selected it), `hash`, `node_count`, `roles` (role name to count) and `groups` (a JSON array of `{path, aliases, role, members, quorum}`).
6. `deployment_nodes`: One row per deployed node: `deployment_id`, `node_index` (the global index that `logs.node_id`, `traces.node_id` and every payload node use), `role`, `ordinal` within the role, and `path`, which is null for a node the deployment root does not reach. Client nodes have indices at or above `node_count` and no row.

## Porcupine Integration

Porcupine is the linearizability checker that integrates natively with the `executions` output of the Spur simulator.

By running `porcupine/main` on the resulting Parquet files, developers can ascertain if a generated schedule violated the guarantees of the protocol (e.g. key-value constraints). Porcupine also yields a useful HTML visualization that diagrams the execution interleavings of node invocations, facilitating debugging when a simulation trace violates linearizability.

`-model` is optional on a simulator output directory: Porcupine reads the model from the `deployments` table, which follows from the client the deploy names. Passing a different `-model` prints a warning and uses the flag. A CSV history carries no `deployments` table, so `-model` is required there.

The `kv` model treats each key's value as an append-only log of write uids — `Write(dest, key, uid)` appends `uid` to that key's log, and `Read(dest, key)` must return the full committed log as a `list<int>`. Because the state space of ordered logs grows combinatorially with concurrent writes, large configurations should use [`max_concurrent_writes`](#max_concurrent_writes) to keep the check tractable.

The `kv_rmw` model is the read-modify-write variant and exposes three operations on a `map<string, list<int>>` state. `Write(dest, key, uid)` is a **blind overwrite**: `state[key] = [uid]`, with no output check. `RMW(dest, key, uid)` appends `uid` to `state[key]` and must return the prior list — the model rejects an RMW whose return value disagrees with what the linearization implies (a pending RMW with no response skips this check). `Read(dest, key)` must return the current `state[key]`, exactly as in the `kv` model. Because RMW errors are caught from the RMW response itself, `num_rmw_ops > 0` no longer requires `num_read_ops > 0`, though reads still add coverage. The `kv` and `kv_rmw` models are not interchangeable: `Write` appends under `kv` and overwrites under `kv_rmw`, so a spec picks one set of semantics by whether its client declares `RMW`.
