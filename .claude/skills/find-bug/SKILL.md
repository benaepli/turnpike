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

### Example invocations

```
/find-bug bin/spur/VR.spur bugs/stale-read.txt
/find-bug bin/spur/VR.spur bugs/lost-write.txt --pdf papers/vr-revisited.pdf
```

## Phase 0: Setup

1. **Create a unique output directory**: Generate a unique directory name to avoid conflicts with other concurrent runs:
```bash
OUTPUT_DIR=$(mktemp -d /tmp/spur_findbug_XXXXXX)
```
Use `$OUTPUT_DIR` in place of `output` for all commands in this session. Also use `$OUTPUT_DIR` for temporary config/plan JSON files. Print the directory name so the user knows where results are.

2. **Read the spec file** (`$1`). Verify it exists and has a `ClientInterface` with `Read` and `Write`.

3. **Read the bug description** (`$2`). Extract:
   - **Symptom**: what goes wrong (stale read, lost write, deadlock, split-brain, etc.)
   - **Trigger conditions**: what scenario causes it (leader crash during replication, concurrent writes, recovery after partition, etc.)
   - **Minimum topology**: how many nodes and faults are needed (infer from trigger conditions if not stated)

4. **Classify the bug**:
   - **Specific**: the description gives enough detail to construct a deterministic scenario (e.g., "write to node 0, crash node 0 before replication completes, read from node 1 returns stale value"). Proceed to Phase 1.
   - **Vague**: only symptoms described without a precise trigger (e.g., "stale reads happen under crashes"). Skip Phase 1, go directly to Phase 2.

5. **If PDF provided**: Read the paper for context on the protocol's correctness invariants.

6. **Build Go tools** (once):

```bash
cd traceanalyzer && go build -o main main.go && cd .. && cd porcupine && go build -o main main.go && cd ..
```

7. **Parallel code analysis**: While building tools, grep the spec for code patterns related to the bug. For example:
   - Bug mentions "view change" → search for view change handling, vote counting, state reset
   - Bug mentions "stale read" → search for how Read handles non-primary nodes, commit checks
   - Bug mentions "lost write" → search for write acknowledgment, quorum counting
   - Report findings immediately. If the code clearly does or doesn't have the bug pattern, note this — it may short-circuit later phases.

## Phase 1: Targeted Plan (up to 3 iterations)

Only enter this phase if the bug was classified as **specific**.

### Iteration 1: Craft the initial plan

Create a `run-plan` JSON file at `$OUTPUT_DIR/find_bug_plan.json` encoding the scenario from the bug description. Follow the plan format (see `scheduler_configs/example_plan.json`):

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
    "dependency_density": [D],
    "randomly_delay_msgs": true,
    "num_runs_per_config": 100,
    "max_iterations": 5000
}
```

Tuning guidelines:

- `num_servers`: match the bug's minimum topology (typically 3)
- `num_crashes`: match trigger conditions (typically 1)
- **Read ops should be at least 2x write ops** to ensure broken state is observed
- `dependency_density`: higher (0.3-0.5) if bug needs ordered events, lower (0.0-0.1) if it needs concurrency
- `randomly_delay_msgs: true` if bug involves message reordering or timing

### Config Sizing Math

You must size the exploration configurations to ensure they finish well within the 120s timeout.

1. **Total Configurations (C)**: Calculate the cartesian product of all discrete parameter values. For example, `num_write_ops` from 3 to 5 (step 1) is 3 values. `num_read_ops` from 6 to 10 (step 2) is 3 values. C = 3 \* 3 = 9 configs.
2. **Total Traces (T)**: C _ `num_runs_per_config` (e.g., 9 _ 100 = 900 traces).
3. **Estimated Time (E)**: Assume an initial conservative trace rate of **R = 300 traces/second**. E = T / R seconds (e.g., 900 / 300 = 3 seconds).
4. Scale `num_runs_per_config` or parameter ranges so that E takes up most of the allowed time but remains safe (e.g., ~80% of the 120s timeout).

### Run

```bash
timeout 120 cargo run --release --manifest-path spur/Cargo.toml --bin spur -- explore -e standard --config $OUTPUT_DIR/find_bug_targeted.json -y --output-dir $OUTPUT_DIR $1 2>&1
```

### Analyze

1. Run trace analysis:

```bash
./traceanalyzer/main -input $OUTPUT_DIR
```

Check:

- Are crashes/recoveries actually happening?
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
- Lower dependency density for more concurrency
- Increase ops count (more opportunities for the bug)
- Increase reads relative to writes (more observation points)
- Add `randomly_delay_msgs: true` if not already set

### Adaptive Config Sizing

1. Calculate your actual trace rate from Phase 2: R_actual = (Total Traces from Phase 2) / (Actual Execution Time of Phase 2 in seconds).
2. Use this R_actual instead of 300 traces/s to size your widened config.
3. Choose your parameter ranges and `num_runs_per_config` such that the Estimated Time (E = T / R_actual) safely fits within the 300s timeout (e.g., target ~240s).

```bash
timeout 300 cargo run --release --manifest-path spur/Cargo.toml --bin spur -- explore -e standard --config $OUTPUT_DIR/find_bug_wide.json -y --output-dir $OUTPUT_DIR $1 2>&1
```

Run traceanalyzer and Porcupine as in Phase 2.

If violation found → verify and report. If not → Phase 4.

## Phase 4: Genetic Explorer

Use the genetic algorithm explorer with a broad config:

```bash
timeout 300 cargo run --release --manifest-path spur/Cargo.toml --bin spur -- explore -e genetic --config $OUTPUT_DIR/find_bug_wide.json -y --output-dir $OUTPUT_DIR $1 2>&1
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
