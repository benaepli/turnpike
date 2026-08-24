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
```

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
- The explorer is nondeterministic even with fixed session_seed (pre-existing);
  all gates therefore use rate statistics, never exact replay.
