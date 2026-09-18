# research/lite

The lite research loop's home. The loop itself is the
`research-loop-lite` skill; the grader is `grader.ts`, run from
`research/harness` (`npx tsx ../lite/grader.ts <command>`), and its
output fields are described in `docs/agent/lite-grader-status.md`.

## Files

- `lite.json` - configuration: goal file, spec, config template, branch,
  and the budgets (chunk wall, chunk bounds, threads, build time, the
  epoch throughput floor).
- `observations.md` - the running log; every iteration and every
  direction review appends here.
- `pool.md` - the scored hypothesis pool. Each entry carries `kind`,
  `category`, `origin` (`proposer`, `operator-agent`, or `user`), and
  `status` (`proposed`, `awaiting-approval`, `graded`, `merged`, `closed`).
- `decisions.jsonl` - one line per decided candidate:
  `{"atIso", "name", "hypothesisId", "origin", "verdict", "reason",
  "primaryDelta", "primaryNullBand", "chunks", "runs", "throughputRatio",
  "regressionPassed", "stateFile", "commit", "ruleVersion", "primaryKind",
  "treatmentBit", "internalRatio", "internalLo", "internalHi",
  "epochCumulativeThroughput", "mode"}`. `commit` is null unless merged;
  `ruleVersion` and `primaryKind` come from `finish`; `mode` is
  `interactive` or `autonomous`.
- `epoch-baseline.json` - the epoch's frozen throughput and the ledger of
  merges since: `name`, `commit`, `ratio` (the session's throughput
  ratio), `cumulative` (the running product), `measuredRps` (from the
  fresh baseline cache after the merge). Frozen by `freeze-epoch`, never
  automatically.
- `plans/` - plans written for the moderated lane, one per hypothesis id.
- `patches/` - patches kept for candidates that were not merged but may be
  worth a second look.
- `state/` - grader session state and panel records.
- `baselines/` - the baseline cache, the expensive shared asset.
