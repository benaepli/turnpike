---
name: research-loop-lite
description: Run agent-driven research iterations against the VR-bug goal - propose, judge, implement in an isolated worktree, grade with the chunked lite grader, then decide merge/close/human on branch research/lite. Interactive by default; `autonomous` runs iterations without pause and decides everything itself.
user-invocable: true
---

# Research Loop Lite

You are the loop. Each iteration you spawn a proposer, a judge, and an
implementer as subagents, drive the chunked grader yourself, and decide
yourself. The grader (`research/lite/grader.ts`) is the only typed
machinery: it measures and reports, it never decides. Its output is
described in `docs/agent/lite-grader-status.md`; the loop's files and
record formats in `research/lite/README.md`; subagent prompts in
`prompts/` beside this file. Configuration is `research/lite/lite.json`
and the goal is the file it names. Paths are relative to the project root;
run grader commands from `research/harness`. On hosts without
subagents or worktrees, see `docs/agent/host-compatibility.md`.

**This skill is not yours to edit, in any mode.** Neither this file nor
the `prompts/` files change during a loop session. If the loop's rules
need changing, write the case into `research/lite/observations.md` and
tell the user; the user changes the skill.

Nothing else here is a veto. The grader prints its reading and its
blockers; you weigh them with everything you know, decide, and write the
reason down. Where this file gives a rule of thumb, your judgment on the
case in front of you wins, provided the log says why. You are steerer,
judge-prompter, and decider at once; do not answer that by inventing rules
against your own bias. Rules turn into arguments about thresholds instead
of thought about mechanisms. The written reason is the guard.

Never edit: `porcupine/`, `research/oracle/`, `research/corpus/`,
`traceanalyzer/`, `bin/spur/`, `research/harness/`,
`research/state.sqlite` (never even open it), and any `scheduler_configs/`
outside `scheduler_configs/loop/`. Never push.

## Modes

**Interactive** (default). One iteration at a time, reporting between
them. Split evidence is filed for the user; a user idea goes through the
moderated lane; the tree stays where the user left it.

**Autonomous** (invoked with the argument `autonomous`, or when the user
says to run unattended). You keep running iterations until the user stops
you or a hard stop below. Every decision a person would otherwise make is
yours: what to steer toward, when to review direction, whether to merge on
split evidence, whether to revert a merge the panel later argues against,
how to resolve a dirty tree or a stale baseline, and whether a grader
problem is worth fixing before the next round. Decide, log the reason,
mark the decisions row `mode: autonomous`, and move on. Nothing is filed
for the user: a case that would have been filed is decided, with its
patches kept under `research/lite/patches/` when they may deserve a second
look. Pool entries with `status: awaiting-approval` still wait; only the
user approves those. Write a short digest into
`research/lite/observations.md` after every direction review so the user
can catch up from the log alone.

Hard stops in either mode: the grader's selftest fails and the failure is
not one you can fix without touching what you must not edit; the main tree
is not on `research/lite`.

## Preflight (every launch)

1. Nothing else is measuring on this host. Lite and perf share the CPU,
   `tmp/loop/` and the working tree; `tmp/loop/measuring.lock` names the
   holder while a perf round or another lite session measures, and every
   measuring grader command refuses while a live process holds it.
2. Read `lite.json`, the goal file, and the tails of
   `research/observations/OBSERVATIONS.md`, `research/lite/observations.md`,
   and `research/lite/pool.md`.
3. The main tree is on `research/lite` with the `spur` gitlink at its
   recorded commit and `git status` clean. Interactive: explain any dirt to
   the user first. Autonomous: resolve it if its origin is clear from the
   log and git, otherwise stop.
4. Build the baseline: `cargo build --release --manifest-path spur/Cargo.toml --bin spur`.
   The baseline side of every grade is that binary with
   `scheduler_configs/loop/general_vr.json`, both from the main tree.
5. Once per session, `npx tsx ../lite/grader.ts selftest` reports zero
   failures.

## Iteration

1. **Propose.** Spawn the proposer with `prompts/proposer.md`, the goal
   file, as much of both observation logs as this round needs, the current
   `general_vr.json`, the existing pool ids, one lens rotating through
   `prompts/lenses.md`, `prompts/hypothesis-json.md` as output format, and
   a focus directive when you have one.
2. **Judge.** Spawn the judge as a read-capable subagent with
   `prompts/judge.md`, the candidates stripped of origin marks and steering
   text, the pool, and the recent tails of both observation logs. Write
   its keep-list into `pool.md`; drop anything it scored 0. Pick the top
   candidate by expectedGain minus expectedCost.
3. **Implement.** Spawn the implementer with `isolation: "worktree"`,
   `prompts/implementer.md`, the goal file, the hypothesis, and
   `research/STYLE.md` in full. Its deliverable is `tmp/loop/lite/<name>/`.
   Read `spur.patch` and `super.patch` yourself before grading: the diff
   matches the hypothesis, stays in `spur/` and `scheduler_configs/loop/`,
   leaves the `campaign` block alone, and draws the bit by run id.
4. **Grade** (below).
5. **Decide** (below).
6. **Log.** Append to `observations.md` and `decisions.jsonl`, update
   `pool.md`, commit the log files on `research/lite`, clean
   `tmp/loop/lite/<name>/`, and `git worktree prune`.

**Direction review.** Run one when something calls for it: after a merge,
after a run of closes, when the pool has drifted into parameter tuning or
config doses, when a violation has appeared anywhere, or when you are
unsure what to steer toward. Ask whether you are optimizing a proxy the
goal file warns about, whether your steering has narrowed the search and
paid for itself, and whether the next directives pull back to mechanism
level. Re-read the goal file, prune the pool, log the verdict.

## Direction

You set direction, not only verdicts. The default direction is substantial:
mechanism-level changes to how the explorer searches, not parameter
tuning. Left alone, the proposer converges on the cheapest shape that
builds and grades - a priority or hold rule on some class of records - and
it does not break out by itself. Push it, explicitly and every round,
toward structurally different mechanisms: adaptive switching among the
built strategy arms on a protocol-agnostic signal, branching the search
from a checkpoint, new feedback loops. A round exists to test a mechanism;
never spend one on a census, a calibration, or a measurement alone. If a
mechanism needs a new observable, the implementer adds it in the same
change and the grader reads it in the same session.

Be patient. Finding the VR bug takes time, and the violation count will
read zero for most of the loop's life. That is what the depth ladder is
for: it is the measurement of progress toward the bug, and a zero on
violations is not a reason to change what is measured, move the rungs,
rescale the oracle, or reach for something drastic. Be persistent at the
goal as given and the measurements as given. Three channels: a **focus
directive** appended to the proposer prompt beside the rotating lens; an
**elaboration**, where the proposer develops a rough idea of yours into a
few variants under the normal constraints; and **seeding**, a fully-formed
hypothesis of yours written into `pool.md` as `origin: operator-agent`.
Whatever the origin, the judge scores blind to it, the prediction freezes
at admission, and the direction review audits the steering.

**Moderated lane** (interactive only): a user idea that needs the user's
sign-off before it is built. Naming the idea at launch is not approval.
Elaborate it with the proposer, vet it with the judge (origin blindness
waived here; the judge checks evidence, the user selects), have a
read-only planning subagent write `research/lite/plans/<id>.md` per
`prompts/planner.md`, add the pool entry as `origin: user`,
`status: awaiting-approval`, summarize, and STOP. On explicit approval the
prediction freezes, the implementer gets the plan file verbatim and reports
any deviation, and the rest is the normal pipeline.

## Grading

```
npx tsx ../lite/grader.ts start --name <name> \
  --cand-bin ../../tmp/loop/lite/<name>/cand-spur \
  --cand-template ../../tmp/loop/lite/<name>/general_vr.json \
  --base-bin ../../spur/target/release/spur \
  --base-template ../../scheduler_configs/loop/general_vr.json \
  --treatment-bit <bit> --band-min <lo-1> --band-max <hi-1>
npx tsx ../lite/grader.ts chunk --name <name>     # one paired chunk; run in the background
npx tsx ../lite/grader.ts status --name <name>    # reprint, runs nothing
npx tsx ../lite/grader.ts finish --name <name> [--regression]
npx tsx ../lite/grader.ts panel --binary ../../tmp/loop/lite/<name>/cand-spur \
  --template ../../tmp/loop/lite/<name>/general_vr.json
```

`--treatment-bit` is the run tag the mechanism is randomized by and the
band is the frozen band on its per-run ratio, as fractions above 1. Omit
them only when the mechanism cannot be turned off per run, which puts the
session on the cross-binary fallback. A config-only candidate still needs
real chunks.

The grader enforces the chunk bounds from `lite.json` and prints after
every chunk what `finish` would say now. Buy another chunk while it could
change your decision. A violation on either side is a corpus finding
worth logging whatever else happens (evidence under
`research/logs/violations/`); the corpus has a background rate, so one
violation belongs to the candidate only if the rate separates or the
evidence ties it to the mechanism.

**Panel on the candidate.** When the chunks read like a possible merge,
run the panel on the exported binary and template, before or alongside
`finish --regression`. The goal's yardstick is the whole protocol panel,
and the per-bit cells are the candidate's treated versus untreated
contrast on every member. Compare against the previous panel entry in
`observations.md` and log the rates every time. Members' overlays may
override a config-only change; check the printed config before reading
that result as evidence. No post-merge panel is owed; run one on the
merged tree only for a fresh anchor.

## Decision

`finish` prints `adviceVerdict` and `blockers`. Depart from the rule only
with a written reason, in either direction. Beyond what it computes,
check: the firing counter in the chunk records' `utilStats.counters`
(the grader does not); `cost`, which can only block and sees the shared
hot-path cost the internal contrast cannot; `cost.throughput.epoch`
against the floor in `lite.json`; the diff, since with no size cap your
review is the only check that the code does what the hypothesis says; and
the panel.

Split evidence - the primary resolves neither way and no advance rung
carries it, a balance fault or unresolved guard stands, the only
improvement is a violation count, the diff touches
`spur-core/src/simulator/core/exec.rs` or `history.rs`, the panel and
the primary disagree - is filed for the user in interactive mode and
decided by you in autonomous mode.

## Merge

Main tree, branch `research/lite`, clean in both the superproject and
`spur/`:

1. `git -C spur apply --check tmp/loop/lite/<name>/spur.patch`, then
   without `--check`; copy in untracked files; commit in `spur`.
2. Apply `super.patch` the same way; `git add` the changed paths plus the
   `spur` gitlink; commit as `lite: <hypothesis-id> - <title>` with the
   grader summary, the panel rates, and the state file path
   `research/lite/state/<name>.json` in the body, then the standard
   trailers.
3. Rebuild the baseline. The next `start` measures a fresh cache for the
   moved spur tree; that is the designed cost of a merge.
4. Append the merge's row to `research/lite/epoch-baseline.json` (shape in
   the README), with `measuredRps` from the fresh cache. The ledger is what
   keeps small throughput leaks from compounding unseen.

## Coexistence

A grader command that finds the measuring lock held refuses and names the
holder: a perf round or another lite session is measuring. Wait for it or
tell the user; never delete a lock whose process is alive, since two
measurements on one host measure each other. Candidates live in implementer
worktrees; never edit the subject in the main tree. Baseline caches under
`research/lite/baselines/` are the expensive shared asset; never delete
them casually. Log files are committed on `research/lite` only.
