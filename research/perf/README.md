# research/perf

The perf research loop's home. The loop itself is the
`research-loop-perf` skill; the grader is `grader.ts`, run from
`research/orchestrator` (`npx tsx ../perf/grader.ts <command>`), and its
output fields are described in `docs/agent/perf-grader-status.md`.

## Files

- `perf.json` - configuration: goal file, spec, the campaign template,
  branch, the budgets (the campaign round's wall budget, round bounds,
  threads and the build cap) and the floors (the layout floor a
  cross-binary gain must clear, the minimum effect any reading must
  clear, and the multiple of the baseline's own round-to-round spread a
  candidate's observables may move within).
- `observations.md` - the running log; every iteration and every
  direction review appends here.
- `pool.md` - the scored hypothesis pool. Each entry carries `kind`,
  `category`, `origin` (`proposer`, `operator-agent`, or `user`),
  `status` (`proposed`, `awaiting-approval`, `graded`, `merged`,
  `closed`), and the two frozen declarations, `search` and `sharing`.
- `decisions.jsonl` - one line per decided candidate:
  `{"atIso", "name", "hypothesisId", "origin", "verdict", "reason",
  "search", "sharing", "primaryKind", "primaryRatio", "primaryLo",
  "primaryHi", "bandReading", "rounds", "campaignRpsRatio",
  "counterRatio", "stateFile", "commit", "mode"}`.
  `commit` is null unless merged; `mode` is `interactive` or
  `autonomous`.
- `plans/` - plans written for the moderated lane, one per hypothesis id.
- `patches/` - patches kept for candidates that were not merged but may
  be worth a second look.
- `state/` - grader session state and per-round records.
- `baselines/` - the baseline cache, the expensive shared asset.
- `profiles/` - one profile per spur commit, written by
  `grader.ts profile` and read by the proposer.

## Ledger

A merge here appends its row to `research/lite/epoch-baseline.json`, the
same throughput ledger the search loop keeps. Both loops move that
denominator, and a second ledger would let the two disagree.
