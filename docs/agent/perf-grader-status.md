# Reading the perf grader's output

`research/perf/grader.ts` prints one JSON object per command. This page names
the fields the loop operator reads; the budgets, floors and round bounds
behind them live in `research/perf/perf.json` and are printed by the grader
itself.

**Every ratio is a speedup.** Above one means the candidate, or the treated
side, is faster or does less work per run. That holds for runs per second,
for microseconds per run, and for a declared counter, so the three readings
of one session point the same way when they agree.

## Commands

- `start` records the candidate, the baseline, and the two frozen
  declarations: the semantic `tier` and the `sharing` profile. The pair picks
  the primary instrument, and the grader refuses the combination it cannot
  read before a single round is bought. It also refuses a treatment bit that
  is not registered in `VARIANT_BITS` or that names an instrument.
- `round` buys one round: both workloads, both sides, the order alternating
  between rounds. It appends the baseline side to the cache and then reprints
  exactly what `finish` would say now, so the operator stops when another
  round cannot change the decision.
- `status` reprints the reading on the rounds in hand and runs nothing.
- `finish` marks the session done and prints the same reading with the file
  paths beside it.
- `baseline --rounds <n>` measures the baseline alone until the cache for
  this identity holds `n` rounds, and prints each workload's mean rate and
  its round-to-round spread. A second call with the target already met adopts
  the cache and measures nothing (`adopted` says which happened).
- `identity --cand-bin --base-bin [--name <session>]` runs the fixed
  workload against both binaries and diffs the runs tables. With `--name` the
  result is filed for that session, which is what clears the identity tier's
  blocker.
- `profile [--binary]` writes `research/perf/profiles/<spur commit>.md`, or
  fails naming the kernel setting it needs.
- `selftest` reports zero failures or names them.

## Fields

- `declaration` - the frozen `tier`, `sharing`, `primary`, treatment bit,
  band and counter. Nothing here changes after `start`.
- `primary` - the merge criterion: its `kind`, the workload it is read on,
  the `ratio` with its interval, the `floor` it had to clear, `separated`,
  and `bandReading` against the frozen band.
- `workloads[*]` - one entry per workload: per-round runs per second on both
  sides, and the `rps`, `usPerRun` and `stepsPerRun` ratios. `usPerStep` is
  present only at the identity tier, where the step count is fixed by
  construction; at every other tier the two readings stay separate, because
  steps are a denominator the change can move.
- `workloads[*].within` and `withinDetail` - the treated-against-untreated
  contrast inside the candidate binary, matched on co-bits with probes out of
  scope, with the treated share and the matched mask.
- `counter` - the declared per-run counter on both sides, its ratio, and
  whether both sides carried it.
- `identity` - the filed equality check: runs compared, how many differ, and
  the first differing rows.
- `relabel` - one row per high-count observable at the relabeling tier:
  the candidate's level, the baseline's, the baseline's own round-to-round
  spread, and whether the move stayed inside the allowance.
- `baselineSpread` - what the cache says this baseline's own rate does
  between rounds. A cross-binary reading inside that spread is a floor
  reading, not a gain.
- `blockers` - what stands against a merge, beside `adviceVerdict` and
  `adviceReason`. Departing from the advice is the operator's call, in either
  direction, with the reason written down.

`adviceVerdict` is one of `gain`, `no-gain`, `regressed`, `refuted`
(the reading fell below the frozen band, which closes the candidate),
`inconclusive` (fewer rounds than the floor, or an effect another round could
still separate), and `no-reading` (the declared primary produced none).

## Standing caveats

- The within-binary contrast is blind to a saving that travels between runs
  in one process: both cells share the allocator, the caches, the memory bus
  and the thread pool, so a working shared mechanism reads flat there. That
  is why the sharing profile, not a preference, picks the instrument.
- A cross-binary reading carries build-layout noise that interleaving does
  not remove. The floor for it is the layout control's spread, kept in
  `perf.json`; re-measure it by grading the baseline commit's second build
  against the first and reading the printed floor.
- A counter is a per-run rate over the runs table's rows, not over the
  session's completed runs, so it is unaffected by runs the writer dropped.
- The two workloads are read together on purpose. The primary may not claim a
  gain the second workload separates against; search quality and the second
  workload can only block.
