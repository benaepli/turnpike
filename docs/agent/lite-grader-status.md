# Reading the lite grader's output

`research/lite/grader.ts` prints one JSON object per command. This page
names the fields the loop operator reads; the numbers behind them (rungs,
z-values, floors, chunk bounds) are printed by the grader itself and are
not restated here.

## Session commands

- `start` records the candidate, the baseline, the declared treatment bit
  and its frozen band. It refuses a bit that is not registered in
  `VARIANT_BITS` or that names an instrument, before any chunk is bought.
  Without a bit the session is on the cross-binary fallback path.
- `chunk` buys one paired chunk. `baseline.measuredThisCall` says whether
  the baseline seed came from the cache or had to be measured, which is
  roughly twice the wall.
- `status` reprints the reading on the chunks in hand and runs nothing.
- `finish [--regression]` prints the typed rule's reading and, with the
  flag, runs the regression case first.

## Fields

- `primary` - the merge criterion: the randomized per-run contrast of
  treated to untreated runs on the epoch's primary rung, matched on
  co-bits. Carries the ratio, its interval, `meiAtCap` (the smallest
  effect still separable at the chunk cap), `bandReading` against the
  frozen band, `balance.faults`, and `advance` (the same contrast on the
  deeper rungs that can carry a merge when the primary resolves neither
  way). The rung and rule version are printed beside it.
- `cost` - the cross-binary per-second reading of the primary rung and the
  throughput ratio. Cost can only block. A ratio inside the printed
  build-layout floor is a cost reading, not evidence of a gain.
  `cost.throughput.epoch` carries the frozen epoch baseline, the ledger's
  cumulative product, what merging would leave it at, and the floor from
  `lite.json`.
- `stopper.rungs[*]` - every reported rung: events on both sides, the
  events-per-explore-second ratio, its `nullBand`, `pGreater`, `pRegress`,
  and `mei`. `stopper.violations` counts candidate and baseline
  violations.
- `verdict` - the sampler's reading of whether another chunk is worth
  buying; `resolvedIfStopped.rule` is what `finish` would print now.
- `canStillAdvance` - whether any remaining chunk could still separate an
  advance.
- `unresolvedGuards`, `stratumFault`, `regressed` - blockers the typed
  rule raises; `finish` collects them under `blockers` beside
  `adviceVerdict`.
- `variantContrasts` - the survey over every tag bit, with every untreated
  run as control. It is how a new bit is sanity-checked. It differs from
  `primary` where a bit is nested, because `primary` matches on co-bits.

## Two standing caveats on the internal contrast

- It is blind to a cost paid by both halves of a session: a shared hot-path
  slowdown reads 1.0 there, which is why `cost` stays a blocker.
- It measures the effect of treating one more run given the session's
  shared state. Where the mechanism feeds a session-global learner, that
  is a marginal effect, not the whole one.

## Panel

`panel [--binary <path>] [--template <path>] [--members all|hard|<ids>]
[--scale <n>]` runs one explore plus porcupine per member of the retired
bug panel and prints each member's violation rate beside the manifest's
calibration, plus a per-variant-bit cell contrast on that member's runs.
`--binary` and `--template` default to the main tree's baseline; pass a
candidate's exported binary and template to read a candidate before it is
merged. A member reads `count-only` when either the expected or observed
events are too few for a rate. The panel's clean controls are known dirty
(`research/observations/PANEL_RETIRED.md`), so it compares rates on the bug
specs only and never attributes a single violation to a specific defect.
