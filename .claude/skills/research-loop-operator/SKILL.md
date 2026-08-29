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
   be on `research/auto-vr`, clean); `tail -3 research/journal.jsonl`;
   `cd research/orchestrator && npx tsx src/cli.ts status` (prints pool
   counts) and `npx tsx src/cli.ts grader-queue`.
2. If the daemon is down and nothing is mid-repair: `rm -f research/STOP`,
   then start in the mode you intend. `SPUR_LOOP_CPUS=0-7,16-23
   research/loop-start.sh` pins the loop and everything it spawns to CCD 0
   and leaves the rest of the machine to the user; plain
   `research/loop-start.sh` uses all 30 threads. The thread count derives
   from the mask and selects the baseline and panel manifest; `cli status`
   lists every calibrated count with its spur commit and whether it is
   current, and the loop refuses to start on a missing or stale one. If
   `research/observations/PROFILE.md` is missing or older than the spur
   commit, run `npx tsx src/cli.ts profile` (needs
   `kernel.perf_event_paranoid <= 2`; on refusal ask the user for the
   sysctl) and commit it, or the perf lens has nothing to aim at.
3. Reap orphaned monitor processes from earlier sessions, then arm the three
   monitors from `reference/monitors.md` (event watcher + heartbeat + churn
   detector). Never run two of the same; stop duplicates with TaskStop.
4. Read the last audit and last three decisions in the journal before
   forming any opinion about progress.

## Operating invariants (each of these was learned by breaking it)

- The running daemon uses the modules it loaded at start; edits to
  `research/orchestrator/src` take effect only after a restart.
- The daemon's preflight resets spur whole and the superproject only inside
  its lanes (`spur`, `scheduler_configs/loop`, `research/evaluations`,
  `research/observations`, `research/policy.json`, `research/POLICY.md`).
  Anything dirty outside those lanes is stashed by path around every reset
  and restored after, so orchestrator source, the grader and the runbooks
  survive an iteration and can be edited and typechecked while the loop
  runs. A stash that no longer applies is left in the stash and reported on
  stderr rather than dropped - check `git stash list` if a reset was noisy.
  Uncommitted edits inside a lane are still wiped every iteration.
- Files read per prompt (`research/GOAL.md`, `research/STYLE.md`,
  `research/seed_hypotheses.json` via `cli seed`) may be edited and committed
  immediately with a targeted `git add <paths>`; never `git add -A` in the
  superproject or spur while the loop runs (it sweeps the in-flight
  hypothesis edit into your commit).
- Check `git branch --show-current` immediately before every operator commit.
  The daemon moves the working tree onto `hyp/*` for the length of an
  iteration, implement through evaluation, so a commit made without looking
  lands on the hypothesis branch and is destroyed when cleanup deletes it.
  The commit object survives unreferenced; recover it with `git cherry-pick`
  after confirming `git branch --contains <sha>` is empty.
- Confirm a push landed by comparing `git rev-parse HEAD` against
  `git rev-parse origin/<branch>`. `git push -q` piped into a filter hides
  rejections, and echoing the local HEAD afterwards reports success for a
  push that never happened.
- Refresh `tmp/loop/spur-baseline` from `spur/target/release/spur` after any
  merge, and never run `cli baseline` without the `cp` that the detached
  command in `reference/monitors.md` includes. The perf lane runs that file
  copy against the candidate's config, and the explorer rejects unknown
  top-level keys under `strict_config_keys`. One merge that adds a config
  key therefore makes every later hypothesis fail its throughput case, which
  the gate reports as "regression suite failed" on hypotheses that did
  nothing wrong. It is a total block on the lane, not a degraded comparison.
- Never `git checkout -f` or `reset --hard` with uncommitted work you want.
- The implementer edits the working tree ON `research/auto-vr`; its work is
  committed to `hyp/*` only at the end of the iteration. Do not commit onto
  `research/auto-vr` between a `select` and its `decision`.
- Use absolute paths in every command; the shell cwd drifts between calls.
  Chain dependent steps with `&&`; never let a failed typecheck fall through
  to a commit.
- Never pipe a long-running command through `tail`; run long jobs
  (baseline, regression) as detached `systemd-run --user` units and monitor
  their log file.
- `porcupine/`, `research/oracle/`, `research/corpus/` are ground truth;
  never edit them. `traceanalyzer/` (the grader) changes only through the
  grader-review workflow below.
- The grader stays protocol-agnostic. It is often said that the grader "may
  reference the known bug", and that is true of the oracle configs under
  `research/oracle/`, not of the Go code. Today no VR identifier appears
  anywhere in `traceanalyzer/` outside one test, and it should stay that way:
  handler names reach the grader as config, the way `deliver` already passes
  `function` through `EventSpec.Function`. A rule may be general ("a dispatch
  with no preceding enter of the same handler on that node is self-initiated
  rather than relayed"); the name it is applied to may not be baked in.
- Each CPU mask has its own calibration, and after a merge the loop
  refreshes only the mode it is running in. Switching modes therefore costs
  one `cli baseline` under the new mask (about 40 minutes) before the start;
  the loop's stale-baseline check is what enforces it. Never run a
  measurement of your own inside the loop's mask while it runs.
- All code you write follows `research/STYLE.md`.
- Parameters are a cost (`research/GOAL.md`); do not add tunables to configs
  or code to make something work.

## Direction review (every ~20 iterations, and after any grader or epoch change)

The loop audits its own mechanisms. Nothing audits whether the loop is
pointed at the bug, and supervising events all night will not surface it:
reacting to what breaks feels like work and can run indefinitely while the
objective does not move. Run this on a schedule, not on request, and write
the verdict to `research/observations/`.

1. Has the ground truth moved? Count `violations` across the reference,
   every baseline and every sequential evaluation. If it is still zero
   everywhere, say so plainly and treat every other number as a proxy whose
   link to the goal is unverified.
2. Separate ruler changes from search changes. Re-grade an early corpus with
   the current oracle and compare that against the current baseline. Gains
   that survive are search; gains that vanish were instrument fixes. Depth
   rose about tenfold over this project and essentially all of it was a
   one-string oracle fix, which no per-iteration number revealed.
3. Compare recent effect sizes against the gate's own bar. Pull
   `objectiveDeltas` and `mei` from the last ten decisions. If candidates
   cluster well under the MEI, the loop is not failing to measure, it is out
   of levers of the size the gate accepts, and proposing more of the same
   cannot change that.
4. Classify the merges. Telemetry and enabling changes that cannot move a
   rung by construction still raise the merge count. Report merges that
   changed search behavior separately from merges that did not.
5. Ask whether the proxy still tracks the goal, with evidence. General-config
   runs at full prefix depth have all been linearizable while plan corpora
   violate on most of theirs, so depth and violations are known to decouple
   at the top of the ladder.
6. State a verdict: continue, recalibrate, or change direction. "Continue"
   needs a reason beyond the absence of a reason to stop.
7. Re-measure the relaxation gap:
   `node research/observations/relaxation_gap.mjs --plan research/oracle/tiers/relax_minimal.json`
   (about 15 minutes; do not run beside a chunk). It ablates each plan edge
   and reports the violation lift each ordering supplies. The gap is a
   property of the current explorer, so as mechanisms merge, edges should
   move from "necessary" toward "slack"; that movement is progress the depth
   ladder cannot show. Before writing any takeaway: a plan edge is a partial
   order, so a zero means the free interleaving is rare, never that two events
   are adjacent. Read at least three of the dumped failing runs, check the
   unrelaxed tier (`find_bug_plan.json`, which names events the minimal plan
   omits) and `research/oracle/bug.md`, and phrase every shape as "raises the
   probability of ...". Re-ablate the unrelaxed tier occasionally: an edge that
   is slack given the others can be load-bearing in a different tier.
8. Read the iteration economy line of `cli status` (mean wall per phase over
   the last 20 iterations, a chunk's explore and grade seconds, decisions
   and merges). Iteration time is operator work, not a hypothesis currency:
   the judge scores explorer throughput because it is the objective, and
   nothing else about the loop's own speed. Act on thresholds, not drift:
   grade above 25% of chunk wall, seed a grader-kind speedup (byte-identical,
   through the grader review); implement above a 15 min mean, read the
   audit's implement activity digest for over-building; rejudge above 5%,
   raise `policy.rejudge.everyK`; fewer than one decision per two
   iterations, read the iteration notes for harness failures first. Never
   overlap grading with the next chunk's explore under a CPU mask: it looks
   like free time and is a throughput confound.

Escalate to the operator rather than deciding alone when the answer implicates
something the loop may not touch: the evaluation grid, the oracle, the spec
under test, or the merge bar itself.

## Boundary procedure (the only way to land harness changes)

1. `touch research/DRAIN`. The iteration in flight runs to its natural end -
   decision, merge, baseline top-up, reflection - and the loop then parks
   between iterations and writes `research/PARKED` with the iteration number
   and how long it has held. Wait for `PARKED` to exist (or the `parked`
   journal event), not for the unit to go inactive: the daemon is alive and
   idle, holding nothing. `rm research/DRAIN` resumes within five seconds
   and re-reads `research/policy.json`, journaling `resumed` with the keys
   that changed; a policy edit under `sequential` or `evaluation` while a
   hypothesis is still sampling is refused rather than applied mid-sample.
   A hold nobody releases self-releases after six hours (`park_expired`);
   `{"owner":..,"reason":..,"maxHoldSec":..}` in the DRAIN file sets that
   and names the holder in the journal.

   Park first for anything that is not orchestrator source. Editing
   `research/orchestrator/src` still needs a restart, because the daemon
   uses the modules it loaded at start: park, then `touch research/STOP`
   while parked, which exits cleanly from a state with nothing in flight.

   `touch research/STOP` on its own keeps its old meaning - abort the
   running phase within seconds, park the hypothesis with a `[stop]` note,
   exit - and is the only thing that works on a wedged phase. Reflect is the
   exception and always completes. Taking STOP mid-iteration costs the
   iteration; take DRAIN unless something is stuck.
2. Verify both repos on `research/auto-vr`, clean. Delete leftover local
   `hyp/*` branches in both repos, except the branches of `inconclusive`
   hypotheses (`cli status` lists them): those hold work that resumes.
3. Apply staged scripts from `research/orchestrator/`; `npx tsc --noEmit`
   must be clean before anything is committed.
4. If a hypothesis was parked or closed by a harness bug (not by evidence),
   requeue it: see `reference/state-edits.md`.
5. Targeted `git add`, commit with a message that carries the reasoning
   (code comments must not), push `research/auto-vr`.
6. If the change alters what results mean or how they are measured (a gate
   statistic, the sequential protocol, chunk size or seeds, a
   behavior-changing baseline), bump the comparability epoch so prior
   results stop steering forward decisions: `cli epoch bump "<reason>"`.
   Results stay in the record; they no longer feed calibration, lineage
   scoring, or the re-judge. A pure harness fix that does not change
   measurement (a git-op fix, a timeout) does not need a bump.
7. `rm -f research/STOP research/DRAIN research/PARKED`; start in the same mode as before
   (`SPUR_LOOP_CPUS=... research/loop-start.sh`, or plain for the whole
   machine); re-arm the event watcher (the old one ends on the ALERT).
8. A grader change additionally requires: `research/corpus/manifest.json`
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
boundary procedure (step 8).

## Reporting

- Heartbeat ticks: one line, only what changed.
- Journal events with content (seq_chunk/sequential/inconclusive/decision/
  audit/publish): interpret them. `seq_chunk` carries the running posteriors
  per rung (`depth>=4..7:pGreater`, `:pMei`, `:ratio`, `:mei`, all on events
  per explore-second, plus `depth>=4:pRegress` and `h2:pRegress` per run).
  Those per-second rungs are the four grid arms' events over the four grid
  arms' wall, about 240 s of the 300 s chunk: `stratum:chunks` and
  `stratum:exposureSec` report the stratum, `depth>=5/6/7:cv` the dispersion
  each rung's interval is charged, and `depth>=k:pooled` on a decision is the
  all-arm rate, recorded and never decided on. The aos arm stays in the
  ladder, the violations and the jackpot path but not the rate, because its
  depth>=6 chunk cv runs 7-22% against 0.4-1.4% for the grid arms. An
  `escalate` whose reason names the stratum means the arm set moved, which is
  a changed unit of comparison and not a result. A violation advances only by
  separating against the archive rate over every campaign-epoch chunk; one
  that does not separate extends the cap and escalates with its evidence;
  `sequential` is the verdict (advance -> regression suite and merge gate on
  the pooled chunks; reject -> closed; escalate -> a rung the baseline never
  reaches appeared, sampling was extended to the hard cap, then a
  needs-human PR carries the pooled evidence; inconclusive -> branch kept,
  resumable after the
  cooldown, up to 2 resumes). An inconclusive result is neither a negative
  nor a positive; report it as "probable, unresolved". A chunk is one
  campaign session: a fixed active-time budget (`sequential.exploreBudgetSec`,
  300 s) split across the arms named in the template's `campaign` block,
  about 12-13 min with grading, and it is only ever compared with baseline
  chunks of the same protocol (`baseline_sequential` after a merge records
  the refreshed baseline, ~50 min). Rungs are events per explore-second
  (`PARAMETERS.md`, epochs 5-7); `seq_chunk` carries `exposureSec`, `rps`
  and `anomalies`, and `seq_chunk_anomaly` marks a chunk excluded for its
  timing. Per-arm rung rates ride in `metrics.campaign`. The perf lane
  still uses screen/promote (standard explorer) for its non-inferiority
  check. A chunk that violates keeps its evidence under
  `research/logs/violations/<evaluation id>/` (index in `INDEX.jsonl`);
  read the combined timelines there before anything else.
  Ladder semantics (epoch 7): the general grid grades against
  `research/oracle/relax_minimal_general.json` with the oracle's timer vertex
  matchable, so the chain reaches 9 and the ladder is read on that scale.
  depth>=4/5 are the bulk rungs; depth>=6 is the primary rung (about 8,700
  events per 300 s chunk); depth>=7 is a hint that extends sampling and
  never decides; depth>=8/9 are recorded. Only violations are zero at
  baseline, so violations alone are the jackpot indicator. Depth is a
  proxy, not the bug: general-config full-depth runs have been linearizable
  so far, against 71% violation at depth 8 in the plan corpora. H1 = crash
  with an in-flight send, H2 = stale-incarnation delivery, H3 = two nodes
  crash and recover, H4 = a timer fired on a node with a message to it in
  flight (near 1 in general mode, so it measures the timer regime). A
  mechanism that raises H1 but not depth shows crash timing alone is not
  the bottleneck. Per-arm rung rates ride in `metrics.campaign` and in the
  STATUS.md arms table; the ladder is the union over arms.
- Distinguish evidence-based outcomes from harness-caused ones every time
  you summarize progress; never count a harness failure as a negative
  result. A unit that reads `active` is not evidence the loop is working:
  check that iterations are spending money and reaching decisions, since an
  agent whose calls all fail costs nothing and closes nothing
  (`reference/diagnostics.md`).
- The auditor misreads predictably: mechanisms disabled in the evaluation
  config read as "broken"; the advancing comparison baseline reads as "no
  movement" (use the Reference column); pre-monotonic timings included
  suspends. Weigh its policy suggestions accordingly.

## Diagnostics

See `reference/diagnostics.md` for the playbook: OOM, suspend, stale git
lock, degenerate grading, unpushed submodule pointers, and how to read
implement summaries, regression cases, and reflections from the journal.
