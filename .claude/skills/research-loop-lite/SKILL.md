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
   `research/orchestrator/src/agents.ts` across iterations, plus an optional
   focus directive of your own (see Direction authority).
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
   anywhere? Are you optimizing a proxy the goal file warns about? Which
   decided candidates were steered or seeded (`origin: operator-agent`), did
   the steering narrow the search, and has it paid for itself? Re-read the
   goal file and prune the pool. Write the verdict into
   `research/lite/observations.md`.

## Direction authority

You set the project's direction, not only its verdicts. Three channels, all
optional:

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

- 2-4 hypotheses through the lens, each implementable in under 300 lines of
  Rust or config change, opt-in (config-gated, default off), protocol-agnostic.
- Change only the subject: `spur/` or `scheduler_configs/loop/`. Never the
  harness, the orchestrator, the grader, the evaluation protocol, or the
  campaign arm set of `general_vr.json` (an arm change moves the unit of
  comparison and the grader refuses it).
- Every hypothesis carries a frozen prediction: rung, sizePct band,
  firingCounter (a counter the explorer already emits), falsifier. The
  prediction is graded, never rewritten.

## Judge subagent

Give it: the candidates, the pool, the last ~200 lines of both observation
logs, and the `JUDGE_RUBRIC` constant from
`research/orchestrator/src/agents.ts` (it is the scoring rubric: cost
anchors, gain anchors, already-set/already-answered/out-of-bounds rejections,
red-team-then-score process). It returns the deduplicated keep-list with its
own expectedGain/expectedCost. Reject anything the rubric scores 0 rather
than carrying it into the pool. Strip origin marks and any steering text
from what you hand it: the judge scores every candidate blind to whether
you steered or seeded it.

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
- Implement exactly this hypothesis, minimally. Opt-in: new behavior behind a
  config field defaulting to today's semantics. Rust work lives in
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
  changed, the gating config field, the predicted effect.
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
  passed.

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
