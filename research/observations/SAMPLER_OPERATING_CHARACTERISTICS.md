# What the sequential sampler costs after the gate collapse

Measured 2026-08-30 with `npx tsx src/selftest_sequential.ts 200`, 200 draws
per shape against the live 14-thread baseline (4 chunks, 1,101,792 runs),
policy `maxChunks=4 minChunks=2 inconclusiveP=0.9 throughputFloor=0.8`. It
supersedes the table measured after the mid-run stopper landed; that column is
kept beside the new one so the cost of the collapse is read rather than
assumed.

| shape | advance | reject | escalate | chunks | before |
| --- | --- | --- | --- | --- | --- |
| null (A/A) | 0% | 99% | 0% | 4.0 [4-4] | unchanged |
| +25% d6 | 100% | 0% | 0% | 2.0 | unchanged |
| +25% d6 at 0.7x throughput | 0% | 100% | 0% | 2.0 | unchanged |
| flat depth at 1.4x throughput | 100% | 0% | 0% | 2.0 | unchanged |
| +12% d4, +15% d5 | 100% | 0% | 0% | 2.0 | unchanged |
| harmful (-40% d4 per run) | 0% | 100% | 0% | 2.0 | unchanged |
| d7-only +40% | 0% | 0% | **100%** | **4.0** | 100% advance at 2.0 |
| h2-only +10% | 0% | 99% | 0% | 4.0 [4-4] | unchanged |
| 1.4x throughput, -15% per-run d6 | 100% | 0% | 0% | 2.0 | unchanged |
| 1.4x throughput, -25% per-run d6 | 4% | 3% | 94% | 3.9 [2-4] | unchanged |
| -40% per-run d6 only | 0% | 100% | 0% | 2.0 | unchanged |

## Deleting the branch cost nothing on any shape both tables share

Every row the two tables have in common is unchanged, to the draw. The
sequential non-inferiority branch was a second stopping rule reached only by
`kind`, so removing it could not move a candidate the sampler already judged
on separation. The only row that moved is `d7-only`, and that is the deep-rung
conversion, not the branch.

## What it cost is that two shapes stopped existing

The old table had two more rows, `NI kind, no effect` (100% advance at 2.0
chunks) and `NI kind, -30% d4` (100% reject at 1.0). Neither is a shape any
more: both are data already in the table, read under the other rule. That
is where the wall time went:

- **`NI kind, no effect` is `null (A/A)`.** An ablation or a telemetry change
  whose effect is zero used to advance at 2 chunks and merge. The same chunks
  now reject at 4. Two extra chunks, about 12 minutes at 6.1 min/chunk.
- **`NI kind, -30% d4` is `harmful (-40% d4 per run)`.** A clearly harmful
  ablation used to reject at 1 chunk, below `minChunks`, because the branch's
  regression test ran before the minimum sample. It now costs 2. One extra
  chunk.

Of the 186 recorded selections that name a kind, 92 are `ablate`, `enabling`
or `meta` - 49%. So about half of all sampled candidates pay the first of
those two.

Against that, the 2 chunks are not new spend so much as moved spend. A merge
tops the baseline back up to `sequential.maxChunks` from the candidate's own
chunks, so an advance at 2 chunks bought 2 baseline chunks immediately after,
plus a regression suite the close does not run. A null of one of these kinds
used to cost 2 sampling chunks, a suite, and a 2-chunk baseline top-up; it now
costs 4 sampling chunks and nothing else. The sampler's line item grows and
the iteration's does not, and what stops being spent is a merge and a baseline
move on evidence that resolved nothing.

## The deep rungs now cost the full sample

`d7-only +40%` is the one shape whose verdict changed. depth>=7 and depth>=8
no longer carry an advance, so a gain confined to them runs to the cap and
escalates: four chunks and a human review instead of two chunks and a merge.
Nothing in the recorded history takes this path - neither rung has separated
once in 5,369 iterations - so the measured cost is zero and the simulated cost
is 2 chunks on a shape that has never occurred.

The verdict is the right one either way. A rung the merge statistic is not
named on, separated at a z that was Bonferroni'd over three rungs and applied
to five, is evidence for a person rather than a licence to merge.

## Reading the table

Every shape that resolves cleanly still does so at the two-chunk minimum. The
sampler's cost is concentrated in the shapes it cannot separate - the null,
`h2-only`, the throughput/depth conflict, and now the deep-rung gain - and the
first three are what the mid-run stopper is there to cut short. Whether it
answers at all remains the first thing to watch: the fallback is `continue`,
and a stopper that never answers pays the cap on every null without saying so.
