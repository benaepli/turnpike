# Research

Two agent-driven loops improve the Spur explorer. Each is a skill: the agent
running it proposes, judges, implements in an isolated worktree, drives a
grader, and decides.

| Loop | Skill | Goal | Grader | Records |
|---|---|---|---|---|
| Search | `research-loop-lite` | `GOAL.md` - surface the VR-Revisited bug under a general config | `lite/grader.ts` | `lite/` |
| Throughput | `research-loop-perf` | `PERF_GOAL.md` - explorer runs per second | `perf/grader.ts` | `perf/` |

Both work on branch `research/lite` and never push.

## Shared pieces

- `harness/` - the measurement library both graders import: the explore and
  porcupine runners, the sequential rule, the merge figures and the
  `VARIANT_BITS` roster (`harness/src/decide.ts`). Graders run from here so
  its `node_modules` resolve:

  ```bash
  cd research/harness && npx tsx ../lite/grader.ts <command>
  cd research/harness && npx tsx ../perf/grader.ts <command>
  ```

- `harness/src/measuring.ts` - one measurement at a time per host. Every
  grader command that measures holds `tmp/loop/measuring.lock` for the life
  of its process and refuses while another live process holds it.
- `policy.json` - the measurement knobs both graders load.
- `STYLE.md` - the code style every implementer is held to.
- `lite/epoch-baseline.json` - the throughput ledger both loops append merges to.

## Ground truth and records

Never edited by an iteration: `oracle/` (the bug and its oracle DAGs),
`corpus/` (grader calibration), `panel/` (protocol panel manifests).

`observations/`, `evaluations/`, `PARAMETERS.md`, `POLICY.md`,
`GRADER_REVIEWS.md`, `PR_REVIEWS.md`, `TRANSFER.md` and
`seed_hypotheses.json` were written by an earlier autonomous loop, retired
and kept at tag `archive/auto-vr-loop` (its branch) and `archive/pre-ablation`
(the tree before its removal). The lite grader still reads
`evaluations/000-baseline-<threads>.json` as a recorded baseline, and the
lite skill reads the tail of `observations/OBSERVATIONS.md`.
