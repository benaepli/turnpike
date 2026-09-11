# research/perf

The perf research loop's home. The loop itself is the
`research-loop-perf` skill; the grader is `grader.ts`, run from
`research/orchestrator` (`npx tsx ../perf/grader.ts <command>`), and its
output fields are described in `docs/agent/perf-grader-status.md`.

## Files

- `perf.json` - configuration: goal file, spec, the two workload
  templates, branch, the budgets (round wall per workload, round bounds,
  threads, the fixed bench run count and seed, the identity workload's
  run count, seed and thread count) and the floors (the layout floor a
  cross-binary gain must clear, the minimum effect any reading must
  clear, the multiple of the baseline's own spread a relabeling check
  allows).
- `observations.md` - the running log; every iteration and every
  direction review appends here.
- `pool.md` - the scored hypothesis pool. Each entry carries `kind`,
  `category`, `origin` (`proposer`, `operator-agent`, or `user`),
  `status` (`proposed`, `awaiting-approval`, `graded`, `merged`,
  `closed`), and the two frozen declarations, `tier` and `sharing`.
- `decisions.jsonl` - one line per decided candidate:
  `{"atIso", "name", "hypothesisId", "origin", "verdict", "reason",
  "tier", "sharing", "primaryKind", "primaryRatio", "primaryLo",
  "primaryHi", "bandReading", "rounds", "campaignRpsRatio",
  "benchRpsRatio", "counterRatio", "identityChecked", "stateFile",
  "commit", "mode"}`. `commit` is null unless merged; `mode` is
  `interactive` or `autonomous`.
- `plans/` - plans written for the moderated lane, one per hypothesis id.
- `patches/` - patches kept for candidates that were not merged but may
  be worth a second look.
- `state/` - grader session state, per-round records, and the identity
  check's result per session.
- `baselines/` - the baseline cache, the expensive shared asset.
- `profiles/` - one profile per spur commit, written by
  `grader.ts profile` and read by the proposer.

## Ledger

A merge here appends its row to `research/lite/epoch-baseline.json`, the
same throughput ledger the search loop keeps. Both loops move that
denominator, and a second ledger would let the two disagree.
