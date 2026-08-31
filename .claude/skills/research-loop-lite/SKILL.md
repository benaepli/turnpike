---
name: research-loop-lite
description: Run agent-driven research iterations against the VR-bug goal - propose, judge, implement in an isolated worktree, grade with the chunked lite grader, then decide merge/close/human on branch research/lite. Only while the autonomous loop (spur-research-loop) is stopped.
user-invocable: true
---

# Research Loop Lite

You are the loop. Each iteration you spawn a proposer, a judge, and an
implementer as subagents, then drive the chunked grader yourself and make the
merge decision yourself. The grader (`research/lite/grader.ts`) is the only
typed machinery: it measures and reports statistical validity; it never
decides. Configuration lives in `research/lite/lite.json`; the goal is the
file it names (`research/GOAL.md` by default). All paths below are relative
to the project root; run every grader command from `research/orchestrator`.

Ground truth is never yours to edit: `porcupine/`, `research/oracle/`,
`research/corpus/`, `traceanalyzer/`, `bin/spur/`. Also off limits:
`research/orchestrator/`, `research/state.sqlite` (never even open it), and
any `scheduler_configs/` outside `scheduler_configs/loop/`.

## Preflight (every launch)

1. `systemctl --user is-active spur-research-loop` must print `inactive` or
   `failed`. If it is active, stop here and tell the user: lite and the big
   loop share the CPU mask, `tmp/loop/`, and the working tree.
2. Read `research/lite/lite.json`, the goal file it names, and the tails of
   `research/observations/OBSERVATIONS.md`, `research/lite/observations.md`,
   and `research/lite/pool.md`.
3. Ensure the lite branch and its base worktree exist:
   `git worktree list` should show `tmp/lite/base` on `research/lite`. If not:
   `git branch research/lite research/auto-vr`,
   `git worktree add tmp/lite/base research/lite`,
   `git -C tmp/lite/base submodule update --init spur`.
4. Ensure the baseline binary:
   `cargo build --release --manifest-path tmp/lite/base/spur/Cargo.toml --bin spur`.
   The baseline side of every grade is
   `tmp/lite/base/spur/target/release/spur` with
   `tmp/lite/base/scheduler_configs/loop/general_vr.json`.
5. Once per session:
   `cd research/orchestrator && npx tsx ../lite/grader.ts selftest`
   must report zero failures.

## Iteration protocol

1. **Propose** - spawn a proposer subagent (prompt template below). Feed it
   one lens, rotating through the `PROPOSAL_LENSES` array in
   `research/orchestrator/src/agents.ts` across iterations, plus a focus
   directive of your own (see Direction authority - steering toward
   mechanism-level work is the default, not the exception).
2. **Judge** - spawn a judge subagent on the proposals plus the current pool.
   Update `research/lite/pool.md` with its scored keep-list. Pick the top
   candidate by expectedGain minus expectedCost.
3. **Implement** - spawn an implementer subagent with worktree isolation
   (Agent tool `isolation: "worktree"`). Template below. Its deliverable is
   an export directory `tmp/loop/lite/<name>/`, because the worktree may not
   outlive it.
4. **Grade** - drive the grader chunk by chunk (below). You decide when to
   stop buying chunks.
5. **Decide** - merge, close, or file for the user (checklist below).
6. **Log** - append to `research/lite/observations.md` and
   `research/lite/decisions.jsonl`, update `pool.md`, clean
   `tmp/loop/lite/<name>/` and any leftover implementer worktrees
   (`git worktree prune`).
7. Every 5 iterations, run a direction review: has a violation appeared
   anywhere? Are you optimizing a proxy the goal file warns about? Run the
   panel check (section below) and log its rates. Which
   decided candidates were steered or seeded (`origin: operator-agent`), did
   the steering narrow the search, and has it paid for itself? Have recent
   iterations drifted into parameter tuning or config doses - and if so, do
   the next directives pull back to mechanism level? Re-read the
   goal file and prune the pool. Write the verdict into
   `research/lite/observations.md`.

## Direction authority

You set the project's direction, not only its verdicts, and you are
expected to steer. The default direction is substantial: mechanism-level
changes to how the explorer searches, not parameter tuning. Use the focus
directive most rounds to hold the proposer there; an unsteered round is a
deliberate choice to sample the lens cold, not the default. Three channels:

- **Focus directive** - append one short steering paragraph to the proposer
  prompt ("this round, focus on X because Y"). The lens still rotates and
  the directive accompanies it, never replaces it, so steering cannot
  permanently narrow the search.
- **Elaboration** - hand the proposer a rough idea of your own to develop
  into 2-4 concrete hypothesis variants, under the same constraints, output
  format, and frozen-prediction requirement as any other proposal.
- **Seeding** - write your own fully-formed hypothesis straight into
  `pool.md`, marked `origin: operator-agent`.

Guardrails, none waivable:

- The judge is blind to origin: candidates reach it without origin marks or
  the steering text that produced them, and every candidate - seeded ones
  included - must pass the rubric before selection. No channel bypasses
  judging or grading.
- Predictions are frozen at admission whatever the origin.
- The direction review (step 7) audits your steering, not only the search.

## Proposer subagent

Give it: the goal file; the last ~200 lines of
`research/observations/OBSERVATIONS.md`; all of
`research/lite/observations.md`; the current
`scheduler_configs/loop/general_vr.json`; the existing pool ids; one lens
from `PROPOSAL_LENSES`; and the `HYPOTHESIS_JSON_GUIDE` constant from
`research/orchestrator/src/agents.ts` as the output format. Constraints to
state verbatim:

- 2-4 hypotheses through the lens. Size is not a constraint - a substantial
  mechanism is welcome - and config gating is not required: a change may
  replace default behavior outright. The bar is that the idea plausibly
  improves violation discovery per explore-second and generalizes to the
  full protocol panel (nothing VR-specific; the generalityArgument field
  carries this).
- Prefer mechanism-level hypotheses: new scheduling behavior, new feedback
  signals, new fault-timing structure - changes to HOW the explorer
  searches. A parameter dose on an existing knob is worth proposing only as
  a follow-up to a merged mechanism or to a recorded observation that names
  that knob.
- Two overrides to the JSON guide: the description names the mechanism, and
  mentions a gating config field only if the change has one; firingCounter
  may name a counter the change itself adds, not only one the explorer
  already emits.
- Change only the subject: `spur/` or `scheduler_configs/loop/`. Never the
  harness, the orchestrator, the grader, the evaluation protocol, or the
  campaign arm set of `general_vr.json` (an arm change moves the unit of
  comparison and the grader refuses it).
- Every hypothesis carries a frozen prediction: rung, sizePct band,
  firingCounter, falsifier. The prediction is graded, never rewritten.

## Judge subagent

Spawn it as a read-capable subagent, not a text-only prompt: it verifies
claims in the repo before scoring. Give it: the candidates, the pool, the
last ~200 lines of both observation logs, and where each kind of claim is
checkable - `scheduler_configs/loop/general_vr.json` (current values),
the observation logs (already-answered), `spur/spur-core` source (cited
mechanisms and counters exist), the baseline cache under
`research/lite/baselines/` (utilStats counter names). It returns the
deduplicated keep-list with its own expectedGain/expectedCost. Strip origin
marks and any steering text from what you hand it: the judge scores every
candidate blind to whether you steered or seeded it. Reject anything the
rubric scores 0 rather than carrying it into the pool. The rubric, to state
verbatim:

- expectedCost is 0 for every candidate, except a fixed 2 when the change
  could invalidate correctness or measurement validity: it touches
  `spur-core/src/simulator/core/exec.rs`, `history.rs`, event accounting,
  or the linearizability recording path. Size, gating, and implementation
  time are not costs. Candidates rank on expectedGain minus expectedCost.
- expectedGain is an argument grade, not an effect forecast. Score how well
  the causal story is argued and evidenced: a clear mechanism-to-observable
  path whose checkable claims you verified is 7-9; a plausible story
  resting on thin or unchecked evidence is 3-5; "more coverage or novelty in general"
  is 1-2; no falsifiable content is 0. No named rung or percentage band is
  required.
- Verify what is checkable: a cited counter exists, a cited config value
  is current, a cited mechanism or code path exists, the question is not
  already answered in the observation logs. Verification covers the
  supporting evidence, not the outcome - what a new mechanism will do is a
  prediction, and grading predictions is the harness's job, not yours. A
  checkable claim found false sinks the score and is named in the notes; a
  claim that cannot be checked yet merely earns no evidence credit.
- Red-team first: for each candidate, write the strongest case that it will
  NOT improve violation discovery, then score.
- Reject (score 0): already-set (the proposed config value equals the
  current one); already-answered (the observation logs record the result);
  out-of-bounds (harness, orchestrator, grader, evaluation protocol, or
  the campaign arm block); protocol-specific (ask: what value would another
  protocol need here, and how would anyone know?).
- Dedupe against the pool; two proposals riding the same mechanism cannot
  both score high.
- Every candidate keeps a checkable frozen prediction: rewrite a sloppy one
  before admission, never after.

## Implementer subagent (worktree isolation)

Spawn with `isolation: "worktree"`. Prompt must include the goal file, the
hypothesis (title, description, rationale, prediction), `research/STYLE.md`
in full, and these instructions:

- The isolated worktree is usually cut from `main`, which predates the loop
  branches: `scheduler_configs/loop/` may be absent and the `spur` gitlink
  stale. First seed the subject from the lite branch and stage that base so
  later diffs show only the hypothesis edit:
  `git restore --source research/lite --staged --worktree -- scheduler_configs/loop spur`
  then, if Rust work is needed, `git submodule update --init spur` (verify
  `spur/Cargo.toml` exists afterwards).
- Implement exactly this hypothesis, at whatever size it needs and no
  bigger. Config gating is optional: changing default behavior is fine; add
  a config field only when the hypothesis calls for one. Rust work lives in
  `spur/spur-core`; config work in `scheduler_configs/loop/`. If the
  mechanism must be enabled for evaluation, enable it in
  `scheduler_configs/loop/general_vr.json` - but never touch its `campaign`
  block.
- Build: `cargo build --release --manifest-path spur/Cargo.toml --bin spur`;
  run `cargo test -p spur-core` if spur-core logic changed.
- At most ONE smoke run, under two minutes, writing to `tmp/loop/<name>`;
  its numbers are discarded. No A/B studies, no seeds sweeps - measurement
  is the grader's job.
- No git commits, no gh, no network.
- MANDATORY export before finishing (the worktree may be cleaned): create
  `<project root>/tmp/loop/lite/<name>/` and copy into it the built binary as
  `cand-spur`, `git -C spur diff > spur.patch` (plus any untracked spur files
  under an `untracked/` mirror), `git diff > super.patch` for superproject
  changes, and the edited `general_vr.json`. End with a summary: files
  changed, the config field if any, the predicted effect.
- Config-only hypothesis (no spur edit): skip the build and the smoke run;
  export the baseline binary `tmp/lite/base/spur/target/release/spur` as
  `cand-spur` and an empty `spur.patch`.

After it finishes, read the patches yourself before grading: confirm the diff
matches the hypothesis and stays inside the allowed lanes.

## Grading (chunked; you are the stopping rule)

All from `research/orchestrator`; each command prints one JSON object on
stdout. `<base>` is `tmp/lite/base`.

```
npx tsx ../lite/grader.ts start --name <name> \
  --cand-bin ../../tmp/loop/lite/<name>/cand-spur \
  --cand-template ../../tmp/loop/lite/<name>/general_vr.json \
  --base-bin ../../tmp/lite/base/spur/target/release/spur \
  --base-template ../../tmp/lite/base/scheduler_configs/loop/general_vr.json

npx tsx ../lite/grader.ts chunk --name <name>    # one paired chunk
npx tsx ../lite/grader.ts status --name <name>   # reprint, runs nothing
npx tsx ../lite/grader.ts finish --name <name> [--regression]
```

A `chunk` call costs ~6 minutes when the baseline seed is cached and ~12 when
the baseline must be measured (`baseline.measuredThisCall` says which
happened; run it in the background and read the JSON when it exits). A
config-only candidate still needs real chunks - the binary is the same but
the config is not.

How to read the status: `stopper.rungs[*]` carries each rung's
events-per-explore-second ratio, its `nullBand` (the A/A spread its own event
counts imply - a ratio inside the band is NO information, however large),
`pGreater`, `pRegress`, and `mei` (the smallest effect still separable at the
chunk cap). `verdict` is the typed rule's advisory reading. `resolvedIfStopped`
is what the sample resolves to if you stop now.

Stop calling `chunk` when any of:
- `verdict` is not `continue` (the rule itself stopped: separation, floor,
  deep-rung regression, violations, or cap);
- a violation appeared (`stopper.violations.candidate > 0`) - go straight to
  evidence under `research/logs/violations/`. Calibrate before crediting the
  candidate: the general corpus produces a background violation roughly once
  per few million runs, so a single one in a ~350k-run chunk is what the
  corpus does anyway (an A/A session has hit one). It is a finding about the
  corpus worth logging either way; it belongs to the candidate only if the
  rate separates or the evidence ties it to the candidate's mechanism;
- `canStillAdvance` is false at or past `minChunks` - no remaining chunk can
  separate an advance; the mechanism is dead for this sample;
- the predicted rung has sat inside its null band for two consecutive chunks
  with `pGreater` near 0.5 and the prediction band already excluded.

Never stop before `minChunks` (2) on rate evidence alone. Run
`finish --regression` only when the outcome could be a merge (the regression
case costs ~10 minutes); plain `finish` when closing.

## Decision checklist

`finish` prints `adviceVerdict` (the typed rule's reading) and `blockers`.
You decide, but depart from the rule only with a written reason:

- **Close** when: `primaryRungRegressed`; throughput below floor; anything in
  `regressed`; the regression suite failed; or the mechanism never fired
  (check the hypothesis's firingCounter in the chunk records'
  `utilStats.counters` - the grader does not automate this, you do).
- **File for the user** (log it, keep the patches, do not merge) when:
  `unresolvedGuards` is non-empty; the only improvement is `violations`;
  `stratumFault` is non-null; the diff touches
  `spur-core/src/simulator/core/exec.rs` or `spur-core/src/simulator/history.rs`;
  or nothing separated and no prediction was met.
- **Merge** only when: something in `improved` separated, no blocker above
  stands, the firing counter shows occasions, and `finish --regression`
  passed. Read `spur.patch` and `super.patch` before merging - with no size
  cap on changes, your review of the diff is the only check that the code
  does what the hypothesis says.

## Panel check (occasional, never a gate)

The goal file's yardstick is the whole protocol panel. Measure it on the
MERGED lite tree - at every direction review (step 7) and after a merge
lands - never on a candidate and never as a merge gate:

```
cd research/orchestrator && npx tsx ../lite/grader.ts panel
```

One explore + porcupine per member (default: the two members whose
calibrated event rates resolve in a short wall, `paxos-accept-stale-ballot`
and `mencius-opt1-2`; `--members all` runs the rest, `--scale N` lengthens
the walls). Takes a few minutes. The output is per-member rates beside the
manifest's calibration; reading them is your job:

- The FIRST run establishes lite's own anchor - the manifest calibration
  predates recent merges - so log it and compare later runs against the
  previous panel entry in `research/lite/observations.md`.
- Rates well below the anchor: suspect recent merges harmed cross-protocol
  bug-finding; consider reverting or filing for the user.
- Rates above the anchor: portfolio evidence - a general heuristic got
  better at a different bug type. Log it with the mechanism that plausibly
  caused it.
- Single-digit violation counts resolve nothing in either direction.

Log the rates to `observations.md` every time. Caveat: the panel's "clean
controls" are known dirty (`research/observations/PANEL_RETIRED.md`); this
check compares violation rates on the bug specs only and never attributes
an individual violation to a specific defect.

## Merge procedure

Work in `tmp/lite/base` (the `research/lite` worktree); verify it is clean
first (`git -C tmp/lite/base status --short`, and the same in its `spur/`).

1. `git -C tmp/lite/base/spur apply --check ../../loop/lite/<name>/spur.patch`
   then without `--check`; copy in any untracked files; commit in
   `tmp/lite/base/spur`.
2. Apply `super.patch` in `tmp/lite/base` the same way; `git add` the changed
   paths plus the `spur` gitlink; commit.
3. Commit message: `lite: <hypothesis-id> - <title>`, body carrying the
   grader summary (verdict, primary delta vs null band, chunks/runs/exposure,
   throughput ratio, regression result) and the state file path
   `research/lite/state/<name>.json`, then the standard Claude trailers.
   Never push.
4. Rebuild the baseline binary in the worktree. The next `start` computes a
   new baseline identity (the spur tree moved) and measures a fresh cache -
   that is the designed cost of a merge, paid one seed at a time.

Log files (`observations.md`, `decisions.jsonl`, `pool.md`) are committed to
`research/lite` too - never to `research/auto-vr`, never to a `hyp/*` branch.
decisions.jsonl line shape:
`{"atIso", "name", "hypothesisId", "origin", "verdict", "reason",
"primaryDelta", "primaryNullBand", "chunks", "runs", "throughputRatio",
"regressionPassed", "stateFile", "commit"}` (commit null unless merged;
origin is "proposer" or "operator-agent").

## Coexistence and cleanup

- If `spur-research-loop` becomes active mid-session, finish nothing: stop
  grading immediately (just do not call `chunk` again) and tell the user.
- The grader's corpora live under `tmp/loop/eval-lite-*` (auto-cleaned) and
  lite artifacts under `tmp/loop/lite/<name>/` (you clean after the decision
  is logged). Baseline caches under `research/lite/baselines/` are the
  expensive shared asset - never delete them casually.
- Superproject working tree: you never need to touch it. Candidates live in
  implementer worktrees, merges in `tmp/lite/base`. If you find yourself
  editing the main working tree, stop.
