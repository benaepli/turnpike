---
name: find-bug
description: Systematically search for a known bug in a Spur protocol specification using escalating exploration strategies — targeted plans, random exploration, and code analysis.
user-invocable: true
---

# Find Bug in Protocol Specification

You are searching for a known bug in a Spur protocol specification. You have a description of the bug and must systematically try to reproduce it using the simulator, while also analyzing the code for the root cause.

## Arguments

Parse the arguments from the input:

- `$1`: Path to the `.spur` spec file (required)
- `$2`: Path to a plain text bug description file (required)
- `--pdf PATH`: Optional paper PDF for additional context
- `--tag-timers`: Optional flag allowing the skill to add labels to `set_timer()` calls in the spec

### Example invocations

```
/find-bug bin/spur/VR.spur bugs/stale-read.txt
/find-bug bin/spur/VR.spur bugs/lost-write.txt --pdf papers/vr-revisited.pdf
/find-bug bin/spur/VR.spur bugs/election-timing.txt --tag-timers
```

## Phase 0: Setup

1. **Create a unique output directory**: Generate a unique directory name to avoid conflicts with other concurrent runs:

```bash
OUTPUT_DIR=$(mktemp -d /tmp/spur_findbug_XXXXXX)
```

Use `$OUTPUT_DIR` in place of `output` for all commands in this session. Also use `$OUTPUT_DIR` for temporary config/plan JSON files. Print the directory name so the user knows where results are.

2. **Read the spec file** (`$1`). Verify it exists and has a `ClientInterface` with `Read` and `Write`.

3. **Read the bug description** (`$2`). Extract:
   - **Symptom**: what goes wrong (stale read, lost write, deadlock, split-brain, minority partition accepts writes, etc.)
   - **Trigger conditions**: what scenario causes it (leader crash during replication, concurrent writes, recovery after partition, network split during replication, etc.)
   - **Minimum topology**: how many nodes and faults are needed (infer from trigger conditions if not stated)

4. **Classify the bug**:
   - **Specific**: the description gives enough detail to construct a deterministic scenario (e.g., "write to node 0, crash node 0 before replication completes, read from node 1 returns stale value"). Proceed to Phase 1.
   - **Vague**: only symptoms described without a precise trigger (e.g., "stale reads happen under crashes"). Skip Phase 1, go directly to Phase 2.

5. **Check timer sensitivity**: If the trigger conditions involve timer/timeout behavior (election timeout, heartbeat timeout, view change timeout, recovery timeout, etc.), flag the bug as **timer-sensitive**. Timer-sensitive bugs with specific triggers are the best candidates for labeled timer plans — this should almost always be the first approach tried when both conditions hold.

6. **Check partition sensitivity**: If the trigger conditions involve network partitions, split-brain, minority/majority quorum issues, or message loss between node groups, flag the bug as **partition-sensitive**. Partition-sensitive bugs are best tested with `partition`/`heal` events in plans (Phase 1) or the `num_partitions` parameter in explorer configs (Phases 2-3).

7. **If PDF provided**: Read the paper for context on the protocol's correctness invariants.

8. **Build Go tools** (once):

```bash
cd traceanalyzer && go build -o main main.go && cd .. && cd porcupine && go build -o main main.go && cd ..
```

9. **Parallel code analysis**: While building tools, grep the spec for code patterns related to the bug. For example:
   - Bug mentions "view change" → search for view change handling, vote counting, state reset
   - Bug mentions "stale read" → search for how Read handles non-primary nodes, commit checks
   - Bug mentions "lost write" → search for write acknowledgment, quorum counting
   - Bug mentions "split-brain" or "partition" → search for quorum checks, majority logic, leader election guards
   - Report findings immediately. If the code clearly does or doesn't have the bug pattern, note this — it may short-circuit later phases.

## Phase 0.5: Tag Timers (conditional)

Only enter this phase if `--tag-timers` was passed AND the bug is **timer-sensitive**.

1. **Find all `set_timer()` calls** in the spec:

   ```bash
   grep -n 'set_timer()' $1
   ```

2. **Infer labels** from surrounding context for each call:
   - Function name containing the call (e.g., `start_election` → `"election"`, `heartbeat_monitor` → `"heartbeat"`, `start_view_change` → `"view_change"`)
   - If multiple `set_timer()` calls exist in the same function, disambiguate with suffixes (e.g., `"election_retry"`)
   - Comments near the call may also hint at the purpose

3. **Modify the spec**: Replace each `set_timer()` with `set_timer("label")` using the inferred labels. Report every change made so the user can verify.

4. **Verify compilation**: Run a quick compile check to ensure the labeled timers don't break anything:
   ```bash
   cargo run --release --manifest-path spur/Cargo.toml --bin spur -- explore -e standard --config scheduler_configs/quick_check.json -y --output-dir $OUTPUT_DIR $1 2>&1 | head -5
   ```
   If compilation fails, revert and report.

## Phase 1: Targeted Plan (up to 3 iterations)

Only enter this phase if the bug was classified as **specific**.

### Iteration 1: Craft the initial plan

**If the bug is timer-sensitive AND the spec has labeled timers** (either pre-existing or added in Phase 0.5), start with a labeled timer plan. This is almost always the best first approach for timer-sensitive bugs with specific triggers, because it lets you control exactly when each timer fires relative to other events.

Create a `run-plan` JSON file at `$OUTPUT_DIR/find_bug_plan.json`. For timer-sensitive bugs, use `strict_timers: true` and `allow_timer` events:

```json
{
  "num_servers": 3,
  "num_runs": 1000,
  "max_iterations": 5000,
  "strict_timers": true,
  "events": {
    "w1": { "write": [0, "x", "1"] },
    "allow_election": { "allow_timer": [1, "election"] },
    "r1": { "read": [1, "x"] },
    "r2": { "read": [2, "x"] }
  },
  "dependencies": [
    ["w1", "allow_election"],
    ["allow_election", "r1"],
    ["allow_election", "r2"]
  ]
}
```

For non-timer bugs, use the standard plan format (see `scheduler_configs/example_plan.json`):

```json
{
    "num_servers": N,
    "num_runs": 1000,
    "max_iterations": 5000,
    "events": { ... },
    "dependencies": [ ... ]
}
```

Key principles for plan construction:

- **Causal dependencies are critical**: encode the ordering the bug requires (e.g., `["w1", "crash1"]`, `["crash1", "recover1"]`, `["recover1", "r1"]`)
- **Sufficient trailing reads**: a linearizability violation only manifests when a Read _observes_ broken state. Add enough Read events on the affected keys _after_ the scenario plays out. At least 2-3 reads on each key that was written.
- **Target the right nodes**: reads should go to nodes that would expose the bug (e.g., a recovered node with stale state, a non-primary that didn't get the latest commit)
- **Choose a good number of runs**: refer to the calculations later in this document.

**Labeled timer plan principles:**

- Use `strict_timers: true` when the bug requires a specific timer to fire at a specific point in the sequence (e.g., "election timeout fires after write but before replication completes")
- `allow_timer` events take `[node_index, "label"]` — the timer only fires on the specified node
- Don't use `strict_timers` when the bug is about general timer racing or unpredictable timing — random exploration handles that better
- You can combine `allow_timer` with `crash`/`recover` events (e.g., allow an election timeout, then crash the new leader)
- If `strict_timers` is true, unlabeled timers still fire freely — only labeled timers are gated

**If the bug is partition-sensitive**, use `partition` and `heal` events. Partition events specify a type:

```json
{
  "num_servers": 5,
  "num_runs": 1000,
  "max_iterations": 5000,
  "events": {
    "w1": { "write": [0, "x", "1"] },
    "p1": { "partition": { "type": "isolate_one", "node": 0 } },
    "r1": { "read": [1, "x"] },
    "r2": { "read": [2, "x"] },
    "h1": "heal",
    "r3": { "read": [0, "x"] }
  },
  "dependencies": [
    ["w1", "p1"],
    ["p1", "r1"], ["p1", "r2"],
    ["r1", "h1"], ["r2", "h1"],
    ["h1", "r3"]
  ]
}
```

Available partition types:
- `{ "type": "isolate_one", "node": N }` — isolate one node from all others
- `{ "type": "halves", "side_a": [0, 1] }` — split into two groups (nodes not in `side_a` form `side_b`)
- `{ "type": "majorities_ring" }` — overlapping majorities in a ring, no global quorum
- `{ "type": "bridge", "bridge": N }` — two halves connected only through one bridge node

**Partition plan principles:**

- Use partitions when the bug involves split-brain, minority writes, or message loss during network splits
- `partition` and `heal` are paired — always heal before the next partition (only one partition active at a time)
- Combine with `crash`/`recover` for complex scenarios — crashes and partitions are orthogonal
- Read from nodes on _both sides_ of the partition after heal to observe inconsistent state
- `majorities_ring` is especially useful for exposing bugs in majority-quorum protocols

### Run the plan

```bash
timeout 60 cargo run --release --manifest-path spur/Cargo.toml --bin spur -- run-plan -p $OUTPUT_DIR/find_bug_plan.json -y --output-dir $OUTPUT_DIR $1 2>&1
```

Handle exit codes:

- **Non-zero (not timeout)**: Likely compilation error or plan error. Read output, fix, re-run (doesn't count as iteration).
- **Exit 0 or timeout**: Proceed to analysis.

### Run Porcupine

```bash
./porcupine/main -input $OUTPUT_DIR -type duckdb -model kv -output-dir $OUTPUT_DIR 2>&1 | tee $OUTPUT_DIR/porcupine_output.txt
```

### Analyze results

**If Porcupine exit 2 (violation found)**:

- Extract failing run IDs: `grep 'Linearizable? false' $OUTPUT_DIR/porcupine_output.txt`
- Use `debug combined` on failing runs to verify the violation matches the _described_ bug
- If it matches → **Bug confirmed.** Report success with run IDs, trace excerpt, and root cause. Stop.
- If it's a _different_ bug → note it as a bonus finding, but continue searching for the target bug

**If Porcupine exit 0 (no violation)**:

- Use `debug combined` to inspect what happened:
  ```bash
  cargo run --release --manifest-path spur/Cargo.toml --bin spur -- debug combined --db $OUTPUT_DIR --run-id 0
  ```
- Diagnose why the plan didn't trigger the bug:
  - **Crash timing wrong**: the crash happened before/after the critical window → adjust dependencies
  - **Not enough reads**: no read observed the broken state → add more trailing reads on the affected keys
  - **Wrong node targeted**: reads went to a node that wasn't affected → change read targets
  - **Scenario played out correctly but no violation**: the bug may not exist via this exact path → proceed to Phase 2

### Revise and retry (up to 3 total plan attempts)

If the plan didn't trigger the bug and the diagnosis suggests a fixable issue:

1. Revise `$OUTPUT_DIR/find_bug_plan.json` based on the diagnosis
2. Re-run with `timeout 60`
3. Re-analyze

After 3 plan attempts without triggering the bug, proceed to Phase 2.

## Phase 2: Targeted Explore

Craft a narrow exploration config at `$OUTPUT_DIR/find_bug_targeted.json`:

```json
{
    "num_servers": { "min": N, "max": N, "step": 1 },
    "num_write_ops": { "min": 3, "max": 5, "step": 1 },
    "num_read_ops": { "min": 6, "max": 10, "step": 2 },
    "num_crashes": { "min": C, "max": C, "step": 1 },
    "num_partitions": { "min": P, "max": P, "step": 1 },
    "dependency_density": [D],
    "num_runs_per_config": 100,
    "max_iterations": 5000
}
```

Tuning guidelines:

- `num_servers`: match the bug's minimum topology (typically 3)
- `num_crashes`: match trigger conditions (typically 1)
- `num_partitions`: set to 1 if the bug involves network partitions (defaults to 0 if omitted). The partition type is randomly chosen from `isolate_one`, `halves`, `majorities_ring`, `bridge` for each generated plan.
- **Read ops should be at least 2x write ops** to ensure broken state is observed
- `dependency_density`: higher (0.3-0.5) if bug needs ordered events, lower (0.0-0.1) if it needs concurrency

### Config Sizing Math

You must size the exploration configurations to ensure they finish well within the 120s timeout.

1. **Total Configurations (C)**: Calculate the cartesian product of all discrete parameter values (including `num_partitions` if set). For example, `num_write_ops` from 3 to 5 (step 1) is 3 values. `num_read_ops` from 6 to 10 (step 2) is 3 values. C = 3 \* 3 = 9 configs.
2. **Total Traces (T)**: C _ `num_runs_per_config` (e.g., 9 _ 100 = 900 traces).
3. **Estimated Time (E)**: Assume an initial conservative trace rate of **R = 300 traces/second**. E = T / R seconds (e.g., 900 / 300 = 3 seconds).
4. Scale `num_runs_per_config` or parameter ranges so that E takes up most of the allowed time but remains safe (e.g., ~80% of the 120s timeout).

### Run

```bash
RUST_LOG=info timeout 120 cargo run --release --manifest-path spur/Cargo.toml --bin spur -- explore -e standard --config $OUTPUT_DIR/find_bug_targeted.json -y --output-dir $OUTPUT_DIR $1 2>&1
```

The `RUST_LOG=info` prefix shows per-run progress. If many runs hit `max_iterations`, this often indicates a **deadlock** rather than the target bug — investigate with `debug combined` on those runs.

### Analyze

1. Run trace analysis:

```bash
./traceanalyzer/main -input $OUTPUT_DIR
```

Check:

- Are crashes/recoveries actually happening?
- Are partitions/heals occurring (if configured)?
- Are operations completing or deadlocking?
- Is the right causal ordering occurring?

2. Run Porcupine:

```bash
./porcupine/main -input $OUTPUT_DIR -type duckdb -model kv -output-dir $OUTPUT_DIR 2>&1 | tee $OUTPUT_DIR/porcupine_output.txt
```

3. **If Porcupine exit 2**: verify trace matches the described bug (same as Phase 1). If match → report success. If different bug → note it and continue.

4. **If Porcupine exit 0**: analyze _why_ the bug wasn't triggered. Note findings for Phase 3 config adjustments.

## Phase 3: Widened Explore

Mutate the config based on Phase 2 trace analysis. Create `$OUTPUT_DIR/find_bug_wide.json` with systematic widening:

- Widen crash range (e.g., `"min": 0, "max": 2`)
- Add or widen partitions (e.g., `"num_partitions": { "min": 0, "max": 1 }`) for partition-sensitive bugs
- Lower dependency density for more concurrency
- Increase ops count (more opportunities for the bug)
- Increase reads relative to writes (more observation points)
- Add `randomly_delay_msgs: true` if not already set

### Adaptive Config Sizing

1. Calculate your actual trace rate from Phase 2: R_actual = (Total Traces from Phase 2) / (Actual Execution Time of Phase 2 in seconds).
2. Use this R_actual instead of 300 traces/s to size your widened config.
3. Choose your parameter ranges and `num_runs_per_config` such that the Estimated Time (E = T / R_actual) safely fits within the 300s timeout (e.g., target ~240s).

```bash
RUST_LOG=info timeout 300 cargo run --release --manifest-path spur/Cargo.toml --bin spur -- explore -e standard --config $OUTPUT_DIR/find_bug_wide.json -y --output-dir $OUTPUT_DIR $1 2>&1
```

Run traceanalyzer and Porcupine as in Phase 2.

If violation found → verify and report. If not → Phase 4.

## Phase 4: Genetic Explorer

Use the genetic algorithm explorer with a broad config:

```bash
RUST_LOG=info timeout 300 cargo run --release --manifest-path spur/Cargo.toml --bin spur -- explore -e genetic --config $OUTPUT_DIR/find_bug_wide.json -y --output-dir $OUTPUT_DIR $1 2>&1
```

Run Porcupine. If violation found → verify and report. If not → Phase 5.

## Phase 5: Verdict

Combine all evidence — simulator results from all phases and code analysis from Phase 0. Report one of:

### Bug Confirmed

- The bug was reproduced
- Include: failing run IDs, trace excerpt from `debug combined`, root cause explanation
- Cross-reference with the bug description to confirm it matches

### Bug Likely Absent

- Code analysis shows the pattern described in the bug is not present in the spec
- N total runs across M configs didn't trigger it
- Explain _why_ the code appears to handle this case correctly

### Bug Possible But Not Triggered

- Code shows suspicious patterns that _could_ cause the described bug
- But simulation didn't reproduce it — possibly needs a very specific interleaving
- Point to the specific code locations that look suspicious
- Suggest what else to try (more runs, different topology, manual code review at specific locations)

### Inconclusive

- Couldn't determine either way
- Summarize what was tried and what was observed
- Suggest next steps

## Important Reminders

- The Spur language reference is in `spur/design/language.md`
- Simulator semantics are in `docs/simulator_semantics.md`
- Debugging heuristics are in `.claude/rules/debugging.md`
- Always use `-y` flag with explore/run-plan to auto-confirm output dir deletion
- Always use `timeout` to cap runtime
- Linearizability violations only manifest when a **Read observes broken state** — configs must have enough reads following writes on the same keys
- When crafting plans, **causal dependencies** (write → crash → recover → read) are critical for reproducing ordering-sensitive bugs
- A violation found by Porcupine may be a _different_ bug than the one being searched for — always verify against the description
- `ClientInterface` must have `Read` and `Write` — these are what Porcupine checks
- **Re-run Porcupine after each explorer invocation.** Run IDs are not stable across explorer runs — changing the config or explorer mode (`standard` vs `genetic`) can produce different run numbering. Do not rely on Porcupine results from a previous explorer run.
