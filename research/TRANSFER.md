# Moving the research loop to another host

Everything the loop *is* lives in git. What does not is the loop's own
operational state, which is one file, and the built artifacts, which are
regenerated. The one thing that cannot be carried across is a measurement:
the explorer shares a feedback map across the parallel run set, so a different
thread count explores differently and every calibrated number has to be taken
again.

## 1. Clone

```bash
git clone --recurse-submodules <super> jennLang && cd jennLang
git checkout research/auto-vr
git -C spur checkout research/auto-vr
```

Both repos live on `research/auto-vr`. The superproject's recorded submodule
commit is reachable on the spur remote's same branch; if a clone ever reports a
detached or missing submodule commit, the pointer was pushed without its
commits and that is the thing to fix first.

## 2. Build

```bash
cargo build --release --manifest-path spur/Cargo.toml --bin spur
(cd porcupine    && go build -o main ./cmd/porcupine && go build -o batch ./cmd/porcupine_batch)
(cd traceanalyzer && go build -o main main.go)
(cd research/orchestrator && npm install)
```

All four outputs are gitignored by design. The cargo line is the exact command
the daemon and the implementer run; it builds only the workspace's default
members. `spur-bench` is excluded from them because its default features pull
in the Formulog build script, which needs java, z3, cmake, boost, oneTBB and
Souffle; build it with `-p spur-bench` on a host that has those.

Run cargo from the superproject directory, as the daemon does. `spur/.cargo/config.toml`
links with mold, and cargo applies it only when the working directory is
inside `spur/`; a host without mold fails to link from there and builds fine
from the superproject.

The loop opens and merges its pull requests through `gh`, so the new host
needs it installed and authenticated (`gh auth status`) before the loop
starts. Nothing in step 4 needs it.

## 3. Copy from the old host

| file | size | needed |
|---|---|---|
| `research/state.sqlite` | ~2 MB | **yes** |
| `research/journal.jsonl` | ~2 MB | for continuity of analysis only |

`state.sqlite` holds the hypothesis pool with its lineage and statuses, the
comparability `epoch`, the bandit's recent selections, the stored baseline, and
every per-hypothesis sequential result. Without it the loop re-seeds from
`research/seed_hypotheses.json` and the pool restarts empty.

Do **not** copy `tmp/loop/spur-baseline`. It is a 270 MB snapshot of the binary
at the last merge, and step 4 regenerates it correctly.

## 4. Re-measure on the new host

Both steps are mandatory, and the first is enforced.

```bash
cd research/orchestrator
npx tsx src/cli.ts baseline          # ~30 min; refreshes tmp/loop/spur-baseline
```

`runLoop` compares the host's resolved thread count against the count recorded
on the baseline and refuses to evaluate on a mismatch. A baseline recorded
before that field existed reads as unknown and warns instead of blocking. The
command ends by committing its evidence in the superproject, so both trees
must be clean when it starts, and anything you want in its own commit is
committed first.

Then re-calibrate the panel. `research/panel/manifest.json` carries detection
rates measured at 14 threads; those rates set every member's `runsPerArm` and
its separation from its control, and `research/observations/PANEL_CALIBRATION.md`
records the procedure (C0 host ceiling first, then C1 control, C2 rate, C3
dispersion, C6 budget, C8 wall). Rates that move materially need the manifest
updated, and `validateManifest` will reject a manifest whose sizing no longer
matches its rates.

Confirm the panel is sound before trusting it, with both arms on HEAD:

```bash
npx tsx src/cli.ts regression 20001    # A/A: every z near zero, |combinedZ| < 2
```

On the old host, four A/A seeds gave individual z with mean +0.075 and sd
0.726, and no run approached the -2.0 downgrade bar.

## 5. Start

Push both branches first. After every merge the loop resets both trees to
`origin/research/auto-vr`, and a local commit that was never pushed - the
baseline's own commit included - is discarded there.

```bash
SPUR_LOOP_MEM_HIGH=20G SPUR_LOOP_MEM_MAX=28G research/loop-start.sh
```

The defaults are 10G/14G, sized for a 16 GB working set; raise them in
proportion to the new host. `rayonThreads` is derived as
`availableParallelism() - 2` and should not be set in `research/policy.json`.
Explorer wall budgets (`fidelities.*.exploreWallSec`, `sequential.wallSecPerChunk`,
`regression.wallSecPerCase`) are deliberately left alone: more cores means
fewer runs lost to a wall, which is a gain and not a bias.

Arm the three monitors from
`.claude/skills/research-loop-operator/reference/monitors.md`.

## 6. Check

- `npx tsx src/cli.ts selftest` - stats, posteriors, panel arithmetic, manifest
  rejection cases, and the panel gate's one-directional authority.
- `npx tsx src/cli.ts status` - the pool should match the old host's counts.
- `npx tsx src/cli.ts epoch` - should read 4 or higher.
- `git status --short` in both repos - clean, both on `research/auto-vr`.

## What is not carried

Agent credentials for the SDK are host-local. `research/logs/` and
`research/corpus/*/` are gitignored working data. Absolute paths in
`research/evaluations/*.json` are records of runs that happened on the old host
and are left as they are.

## Running on a subset of the machine

Start the loop with `SPUR_LOOP_CPUS=<cpu list>` and every detached unit with
`--property=AllowedCPUs=<cpu list>`; pin foreground work with
`taskset -c <cpu list>`. The thread count derives from the mask, so no policy
edit is needed, and each mask needs its own baseline and panel calibration
once (`cli baseline`, `cli panel-calibrate`, `cli regression` under the mask);
after that a switch is a restart. On this host, a Ryzen 9 9950X, CPUs 0-15
are the sixteen cores and 16-31 their SMT siblings, with cores 0-7 on one CCD
and 8-15 on the other; `0-7,16-23` is one whole CCD and resolves to 14
threads.

