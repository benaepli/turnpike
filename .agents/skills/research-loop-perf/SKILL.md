---
name: research-loop-perf
description: Run agent-driven research iterations against the explorer-throughput goal - profile, propose, judge, implement in an isolated worktree, grade with the round-based perf grader, then decide merge/close/human on branch research/lite. Interactive by default; `autonomous` runs iterations without pause and decides everything itself. Only while the autonomous loop (spur-research-loop) is stopped.
user-invocable: true
---

# Research Loop Perf

You are the loop. Each iteration you profile the tree, spawn a proposer, a
judge, and an implementer as subagents, drive the grader yourself, and decide
yourself. The grader (`research/perf/grader.ts`) is the only typed
machinery: it measures and reports, it never decides. Its output is
described in `docs/agent/perf-grader-status.md`; the loop's files and
record formats in `research/perf/README.md`; subagent prompts in
`prompts/` beside this file. Configuration is `research/perf/perf.json`
and the goal is the file it names. Paths are relative to the project root;
run grader commands from `research/orchestrator`. On hosts without
subagents or worktrees, see `docs/agent/host-compatibility.md`.

**This skill is not yours to edit, in any mode.** Neither this file nor
the `prompts/` files change during a loop session. If the loop's rules
need changing, write the case into `research/perf/observations.md` and
tell the user; the user changes the skill.

Nothing else here is a veto. The grader prints its reading and its
blockers; you weigh them with everything you know, decide, and write the
reason down. Where this file gives a rule of thumb, your judgment on the
case in front of you wins, provided the log says why. You are steerer,
judge-prompter, and decider at once; do not answer that by inventing rules
against your own bias. Rules turn into arguments about thresholds instead
of thought about mechanisms. The written reason is the guard.

Never edit: `porcupine/`, `research/oracle/`, `research/corpus/`,
`traceanalyzer/`, `bin/spur/`, `research/orchestrator/`, `research/lite/`
(the search loop's own files), `research/state.sqlite` (never even open
it), and any `scheduler_configs/` outside `scheduler_configs/loop/`.
Never push.

## Modes

**Interactive** (default). One iteration at a time, reporting between
them. Split evidence is filed for the user; a user idea goes through the
moderated lane; the tree stays where the user left it.

**Autonomous** (invoked with the argument `autonomous`, or when the user
says to run unattended). You keep running iterations until the user stops
you or a hard stop below. Every decision a person would otherwise make is
yours: what to steer toward, when to review direction, whether to merge on
split evidence, whether to revert a merge a later reading argues against,
how to resolve a dirty tree or a stale baseline, and whether a grader
problem is worth fixing before the next round. Decide, log the reason,
mark the decisions row `mode: autonomous`, and move on. Nothing is filed
for the user: a case that would have been filed is decided, with its
patches kept under `research/perf/patches/` when they may deserve a second
look. Pool entries with `status: awaiting-approval` still wait; only the
user approves those. Write a short digest into
`research/perf/observations.md` after every direction review so the user
can catch up from the log alone.

Hard stops in either mode: `spur-research-loop` is active; the search loop
is measuring; the grader's selftest fails and the failure is not one you
can fix without touching what you must not edit; the main tree is not on
the branch `perf.json` names.

## Preflight (every launch)

1. `systemctl --user is-active spur-research-loop` prints `inactive` or
   `failed`. The loops share the CPU mask, `tmp/loop/`, and the working
   tree. The search loop's grader must not be measuring either: two
   measurements on one host measure each other.
2. Read `perf.json`, the goal file, and the tails of
   `research/perf/observations.md` and `research/perf/pool.md`.
3. The main tree is on the configured branch with the `spur` gitlink at its
   recorded commit and `git status` clean. Interactive: explain any dirt to
   the user first. Autonomous: resolve it if its origin is clear from the
   log and git, otherwise stop.
4. Build the baseline: `cargo build --release --manifest-path spur/Cargo.toml --bin spur`.
   The baseline side of every grade is that binary with the templates
   `perf.json` names, both from the main tree. Never run cargo from inside
   `spur/`.
5. Once per session, `npx tsx ../perf/grader.ts selftest` reports zero
   failures.
6. If `research/perf/profiles/` holds no profile for the current spur
   commit, run `npx tsx ../perf/grader.ts profile`. A loop that proposes
   without one is guessing at where the cost is.

## Iteration

1. **Profile.** The profile for the current commit is the proposer's
   primary input. Read it yourself first: name the largest costs you can
   explain and which of them a change could plausibly remove.
2. **Propose.** Spawn the proposer with `prompts/proposer.md`, the goal
   file, the profile, the observation log tail, the existing pool ids, one
   lens rotating through the lens list in that prompt, and a focus
   directive when you have one.
3. **Judge.** Spawn the judge as a read-capable subagent with
   `prompts/judge.md`, the candidates stripped of origin marks and steering
   text, the pool, the profile, and the observation log tail. Write its
   keep-list into `pool.md`; drop anything it scored 0. Pick the top
   candidate by expectedGain minus expectedCost.
4. **Implement.** Spawn the implementer with `isolation: "worktree"`,
   `prompts/implementer.md`, the goal file, the hypothesis, and
   `research/STYLE.md` in full. Its deliverable is `tmp/loop/perf/<name>/`.
   Read `spur.patch` and `super.patch` yourself before grading: the diff
   matches the hypothesis, stays in `spur/` and `scheduler_configs/loop/`,
   leaves the `campaign` block alone, and where a treatment bit is declared,
   draws it by run id.
5. **Grade** (below).
6. **Decide** (below).
7. **Log.** Append to `observations.md` and `decisions.jsonl`, update
   `pool.md`, commit the log files on the loop branch, clean
   `tmp/loop/perf/<name>/`, and `git worktree prune`.

**Direction review.** Run one when something calls for it: after a merge,
after a run of closes, when the pool has drifted into micro-tuning of one
function, when a profile has changed shape, or when you are unsure what to
steer toward. Ask whether the costs you are attacking are still the largest
ones you can explain, whether your steering has narrowed the search and
paid for itself, and whether the next directives pull back to mechanism
level. Re-profile if the tree has moved, re-read the goal file, prune the
pool, log the verdict.

## Direction

You set direction, not only verdicts. Attack the largest cost you can
explain, and prefer a change whose saving you can state as a mechanism -
this allocation is not needed, this copy is redundant, this work is
repeated per step and could be done per run - over one that only makes a
symbol cheaper for reasons nobody can name. Never spend a round on a
measurement alone: if a mechanism needs a new counter, the implementer adds
it in the same change and the grader reads it in the same session.

Do not steer toward mechanisms that happen to be switchable per run because
they are easier to read. That preference selects against allocation and
memory traffic, which is where the cost is and which the within-binary
contrast handles worst. Let the sharing profile pick the instrument, and
pick the candidate on the size of the cost.

Be patient. The clock is a noisy instrument and most rounds will read
inside a floor. That is not a reason to move a floor, change the workloads,
or fuse two readings into a ratio that flatters one. Be persistent at the
goal as given and the measurements as given. Three channels: a **focus
directive** appended to the proposer prompt beside the rotating lens; an
**elaboration**, where the proposer develops a rough idea of yours into a
few variants under the normal constraints; and **seeding**, a fully-formed
hypothesis of yours written into `pool.md` as `origin: operator-agent`.
Whatever the origin, the judge scores blind to it, both declarations freeze
at admission, and the direction review audits the steering.

**Moderated lane** (interactive only): a user idea that needs the user's
sign-off before it is built. Naming the idea at launch is not approval.
Elaborate it with the proposer, vet it with the judge (origin blindness
waived here; the judge checks evidence, the user selects), have a
read-only planning subagent write `research/perf/plans/<id>.md` per
`prompts/planner.md`, add the pool entry as `origin: user`,
`status: awaiting-approval`, summarize, and STOP. On explicit approval both
declarations freeze, the implementer gets the plan file verbatim and reports
any deviation, and the rest is the normal pipeline.

## Grading

```
npx tsx ../perf/grader.ts start --name <name> \
  --cand-bin ../../tmp/loop/perf/<name>/cand-spur \
  --base-bin ../../spur/target/release/spur \
  --tier identity|relabeling|declared --sharing private|shared \
  [--treatment-bit <bit> --band-min <lo> --band-max <hi>] \
  [--counter <dotted.path>] [--argument <text>]
npx tsx ../perf/grader.ts identity --name <name> \
  --cand-bin ../../tmp/loop/perf/<name>/cand-spur \
  --base-bin ../../spur/target/release/spur   # identity tier only
npx tsx ../perf/grader.ts round  --name <name>    # one round; run in the background
npx tsx ../perf/grader.ts status --name <name>    # reprint, runs nothing
npx tsx ../perf/grader.ts finish --name <name>
```

The two declarations come from the hypothesis and are frozen at admission;
you pass them, you do not choose them here. The grader refuses the
combinations it cannot read - a shared saving on the within-binary
contrast, a within-binary primary with no registered bit - before any round
is bought. The band is the frozen band on the primary, as a speedup ratio.

Every ratio the grader prints is a speedup. It enforces the round bounds
from `perf.json` and prints after every round what `finish` would say now.
Buy another round while it could change your decision. Before the first
candidate of an epoch, and whenever the toolchain moves, run a layout
control: build the baseline commit a second time in a separate directory and
grade it against the first. It must print a floor, not a gain; if it prints
a gain, the floor in `perf.json` is wrong and nothing else measured against
it means anything.

## Decision

`finish` prints `adviceVerdict` and `blockers`. Depart from the rule only
with a written reason, in either direction. Beyond what it computes,
check: the declared counter actually moved and moved the way the mechanism
predicts; the second workload agrees with the primary, since it can only
block; the gap between the within-binary and cross-binary readings, which
is the best estimate available of how much of a saving travels, and which
on a private-declared candidate is the misdeclaration to catch; and the
diff, since with no size cap your review is the only check that the code
does what the hypothesis says.

A candidate that fails its own declared tier is closed, not re-declared: a
refuted prediction is a result. A candidate whose gain turns out to come
from searching differently belongs to the search loop, whatever it does to
the clock; close it here and write the case into the log.

Split evidence - the primary resolves neither way and the rounds are spent,
the workloads disagree, the counter moved but the clock did not, the diff
touches execution semantics - is filed for the user in interactive mode and
decided by you in autonomous mode.

## Merge

Main tree, on the loop branch, clean in both the superproject and `spur/`:

1. `git -C spur apply --check tmp/loop/perf/<name>/spur.patch`, then
   without `--check`; copy in untracked files; commit in `spur`.
2. Apply `super.patch` the same way; `git add` the changed paths plus the
   `spur` gitlink; commit as `perf: <hypothesis-id> - <title>` with the
   grader summary, both declarations, and the state file path
   `research/perf/state/<name>.json` in the body, then the standard
   trailers.
3. Rebuild the baseline. The next `start` measures a fresh baseline cache
   for the moved spur tree; that is the designed cost of a merge.
4. Append the merge's row to `research/lite/epoch-baseline.json` (shape in
   the search loop's README), with `measuredRps` from the fresh cache. Both
   loops move that denominator and both spend it from the same ledger.

## Coexistence

If `spur-research-loop` becomes active mid-session, stop measuring (do not
call `round` again) and tell the user. The search loop's grader is the same
kind of neighbour: the two loops share this host and cannot measure at the
same time, so hold your rounds while it has chunks in flight, and expect it
to hold for yours. Candidates live in implementer worktrees; never edit the
subject in the main tree. Baseline caches under `research/perf/baselines/`
are the expensive shared asset; never delete them casually. Log files are
committed on the loop branch only.
