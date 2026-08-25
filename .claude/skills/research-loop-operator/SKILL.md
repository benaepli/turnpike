---
name: research-loop-operator
description: Supervise the autonomous VR-bug research loop (research/orchestrator) - monitor it, diagnose harness failures, stage and land harness fixes at safe boundaries, intercept grader proposals for the operator, and report scientific results. Run this when the loop is (or should be) running unattended and you are its operator.
user-invocable: true
---

# Research Loop Operator

You are the operator of the autonomous research loop described in
`research/GOAL.md`, `research/README.md`, and `research/PARAMETERS.md`. The
loop runs as the systemd user unit `spur-research-loop`; you supervise it.
You may act autonomously within the rules below; the downstream gates,
lints, PR flow, and protected paths are the safety net, not your judgment.

## First five minutes (every launch)

1. State: `systemctl --user is-active spur-research-loop`; `git status --short`
   and `git branch --show-current` in the superproject AND `spur/` (both must
   be on `research/vr-loop`, clean); `tail -3 research/journal.jsonl`;
   `cd research/orchestrator && npx tsx src/cli.ts status` (prints pool
   counts) and `npx tsx src/cli.ts grader-queue`.
2. If the daemon is down and nothing is mid-repair: `rm -f research/STOP`,
   `research/loop-start.sh`.
3. Arm the two monitors from `reference/monitors.md` (event watcher +
   heartbeat). Never run two of the same; stop duplicates with TaskStop.
4. Read the last audit and last three decisions in the journal before
   forming any opinion about progress.

## Operating invariants (each of these was learned by breaking it)

- The running daemon uses the modules it loaded at start; edits to
  `research/orchestrator/src` take effect only after a restart.
- The daemon's preflight hard-resets and cleans both working trees at every
  iteration start. Uncommitted edits in the repo are wiped. Stage harness
  patches as scripts in your scratchpad and apply them only at a boundary.
- Files read per prompt (`research/GOAL.md`, `research/STYLE.md`,
  `research/seed_hypotheses.json` via `cli seed`) may be edited and committed
  immediately with a targeted `git add <paths>`; never `git add -A` in the
  superproject or spur while the loop runs (it sweeps the in-flight
  hypothesis edit into your commit).
- Never `git checkout -f` or `reset --hard` with uncommitted work you want.
- The implementer edits the working tree ON `research/vr-loop`; its work is
  committed to `hyp/*` only at the end of the iteration. Do not commit onto
  `research/vr-loop` between a `select` and its `decision`.
- Use absolute paths in every command; the shell cwd drifts between calls.
  Chain dependent steps with `&&`; never let a failed typecheck fall through
  to a commit.
- Never pipe a long-running command through `tail`; run long jobs
  (baseline, regression) as detached `systemd-run --user` units and monitor
  their log file.
- `porcupine/`, `research/oracle/`, `research/corpus/` are ground truth;
  never edit them. `traceanalyzer/` (the grader) changes only through the
  grader-review workflow below.
- All code you write follows `research/STYLE.md`.
- Parameters are a cost (`research/GOAL.md`); do not add tunables to configs
  or code to make something work.

## Boundary procedure (the only way to land harness changes)

1. `touch research/STOP`. The running agent phase aborts within seconds
   (reflect is the exception: it always completes, so its observation is
   kept); the iteration parks its hypothesis with a `[stop]` note; the
   daemon exits. Wait for the event watcher's ALERT (unit inactive). To
   lose nothing, touch STOP at the `decision` event of the running
   iteration: publish and reflect then finish and the loop exits before
   the next selection (a trigger on `reflect` is too late; the next
   iteration starts within a second of it).
2. Verify both repos on `research/vr-loop`, clean. Delete leftover local
   `hyp/*` branches in both repos, except the branches of `inconclusive`
   hypotheses (`cli status` lists them): those hold work that resumes.
3. Apply staged scripts from `research/orchestrator/`; `npx tsc --noEmit`
   must be clean before anything is committed.
4. If a hypothesis was parked or closed by a harness bug (not by evidence),
   requeue it: see `reference/state-edits.md`.
5. Targeted `git add`, commit with a message that carries the reasoning
   (code comments must not), push `research/vr-loop`.
6. `rm -f research/STOP`; `research/loop-start.sh`; re-arm the event watcher
   (the old one ends on the ALERT).
7. A grader change additionally requires: `research/corpus/manifest.json`
   invariants re-verified (`reference/diagnostics.md`), the baseline re-run
   as a detached unit (`cli baseline`), and the change noted in
   `research/PARAMETERS.md`.

## Grader-review workflow

A `grader_review` journal event means the loop selected a grader-kind
hypothesis and parked it (`cli grader-queue` lists them). Do not implement
it. Evaluate it: does it change what progress means or only how cheaply it
is measured? Check it against the calibration invariants in
`research/corpus/manifest.json` and the derivations in
`research/PARAMETERS.md`; prototype on `research/corpus/findbug_archive`
when that is cheap. Report to the operator with a recommendation and wait
for their decision. Approved changes are operator commits landed via the
boundary procedure (step 7).

## Reporting

- Heartbeat ticks: one line, only what changed.
- Journal events with content (seq_chunk/sequential/inconclusive/decision/
  audit/publish): interpret them. `seq_chunk` carries the running posteriors
  (`depth>=5:pGreater`, `:pMei`, `:ratio`, `:mei`); `sequential` is the
  verdict (advance -> regression suite and merge gate on the pooled chunks;
  reject -> closed; inconclusive -> branch kept, resumable after the
  cooldown, up to 2 resumes). An inconclusive result is neither a negative
  nor a positive; report it as "probable, unresolved". Chunks are long
  sessions (1000 runs/config, ~7 min each) and are only ever compared with
  baseline chunks of the same protocol (`baseline_sequential` after a merge
  records the refreshed baseline, ~30 min). The perf lane still uses
  screen/promote for its non-inferiority check.
  Ladder semantics: depth>=4/5 are the measurable frontier
  rungs; depth>=6..8 and violations are zero at baseline and act as jackpot
  indicators; H1 = crash with an in-flight send, H2 = stale-incarnation
  delivery, H3 = two nodes crash and recover. A mechanism that raises H1 but
  not depth shows crash timing alone is not the bottleneck.
- Distinguish evidence-based outcomes from harness-caused ones every time
  you summarize progress; never count a harness failure as a negative
  result.
- The auditor misreads predictably: mechanisms disabled in the evaluation
  config read as "broken"; the advancing comparison baseline reads as "no
  movement" (use the Reference column); pre-monotonic timings included
  suspends. Weigh its policy suggestions accordingly.

## Diagnostics

See `reference/diagnostics.md` for the playbook: OOM, suspend, stale git
lock, degenerate grading, unpushed submodule pointers, and how to read
implement summaries, regression cases, and reflections from the journal.
