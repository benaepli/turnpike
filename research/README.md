# Research Loop — Operator Guide

Autonomous loop that improves the Spur explorer until the VR-Revisited bug
(`oracle/bug.md`) surfaces under a general config. Design rules: `GOAL.md`.
Plan/audit trail: `evaluations/`, `observations/`, `journal.jsonl`, `STATUS.md`.

## Commands (from `research/orchestrator/`)

```bash
npx tsx src/cli.ts selftest    # wiring check (fast)
npx tsx src/cli.ts seed        # load research/seed_hypotheses.json into the pool
npx tsx src/cli.ts baseline    # measure + record the baseline ladder (~1h)
npx tsx src/cli.ts once        # one attended iteration
npx tsx src/cli.ts regression  # run the regression suite
../loop-start.sh               # start unattended (systemd-run --user)
npx tsx src/selftest_sequential.ts 60 --assert     # operating characteristics of the stopping rule
node ../observations/surrogate_validation.mjs      # which in-process rewards may steer an allocation
```

The evaluation is a campaign: `-e campaign` on the one template, whose
`campaign` block names the arms; every chunk is a fixed active-time budget
and rungs are counted per explore-second (`PARAMETERS.md`).

## Operator

Relaunch the supervising session with `/research-loop-operator` (project
skill in `.claude/skills/`). It re-establishes monitors, diagnoses failures,
lands harness fixes at safe boundaries, and routes grader proposals to you.

## Watching it

- `research/STATUS.md` — ladder, pool, timings (re-rendered every iteration)
- `research/observations/OBSERVATIONS.md` — lab notebook (agent-written)
- `gh pr list --label auto-research` in this repo and in benaepli/spur
- `systemctl --user status spur-research-loop`, logs in `research/logs/`

## Stopping

- Graceful: `touch research/STOP` (finishes the current iteration)
- Hard: `systemctl --user stop spur-research-loop`

## Safety model (short form)

Typed code owns budgets/gates/git; agents only propose, implement inside a
permission fence (no git, allowlisted bash, path fences), and interpret.
Auto-merge requires: CI-cleared ladder improvement + regression suite +
protected-path/ruler-subject/VR-name lints + opt-in change shape. Everything
else opens a `needs-human` PR. Porcupine and `research/oracle|corpus` are
ground truth and never agent-editable; `traceanalyzer` only via grader-kind
hypotheses validated against `corpus/manifest.json`.

## Known v1 limitations

- Auto-revert of merged changes is manual (`git revert` + PR) — the loop does
  not yet re-evaluate merged work post-hoc.
- meta (policy) and grader hypotheses always route to needs-human.
- Sessions are reproducible per seed (a spec map's iteration order used to
  depend on a per-process hasher; it no longer does), but the gates still use
  rate statistics: a seed change still changes what is explored.
