# What the sequential sampler costs after Phase B

Measured 2026-08-30 with `npx tsx src/selftest_sequential.ts 200`, 200 draws
per shape against the live 14-thread baseline (4 chunks, 1,101,792 runs),
policy `maxChunks=4 minChunks=2 inconclusiveP=0.9 throughputFloor=0.8`.

| shape | advance | reject | escalate | chunks |
| --- | --- | --- | --- | --- |
| null (A/A) | 0% | 99% | 0% | **4.0 [4-4]** |
| +25% d6 | 100% | 0% | 0% | 2.0 |
| +25% d6 at 0.7x throughput | 0% | 100% | 0% | 2.0 |
| flat depth at 1.4x throughput | 100% | 0% | 0% | 2.0 |
| +12% d4, +15% d5 | 100% | 0% | 0% | 2.0 |
| harmful (-40% d4 per run) | 0% | 100% | 0% | 2.0 |
| d7-only +40% | 100% | 0% | 0% | 2.0 |
| h2-only +10% | 0% | 99% | 0% | **4.0 [4-4]** |
| 1.4x throughput, -15% per-run d6 | 100% | 0% | 0% | 2.0 |
| 1.4x throughput, -25% per-run d6 | 4% | 3% | 94% | 3.9 [2-4] |
| -40% per-run d6 only | 0% | 100% | 0% | 2.0 |
| NI kind, no effect | 100% | 0% | 0% | 2.0 [2-4] |
| NI kind, -30% d4 | 0% | 100% | 0% | 1.0 |

## The null now runs to the cap

Deleting the futility branch moved the A/A null and the `h2-only` shape from
about 2.4 chunks to **4.0, the cap, on every draw**. The verdict is unchanged -
both still reject at 99% - so this is a pure cost, not a correctness change.

At roughly 6.1 minutes per chunk (301 s explore plus 66 s grade) that is about
ten minutes added to every null candidate. Most candidates are null: the record
holds 88 closures against 122 decisions. Against an iteration economy of 34
minutes with evaluate at 15.9, a loop whose stopper never answers should settle
near 44 minutes per iteration, about 30% slower.

**That is the bet Phase B makes.** The mid-run stopper is what earns it back,
and it can do better than the old branch rather than merely matching it: a null
is visible at chunk 2, where the futility rule needed 2.4 on average and the
cap now needs 4. If the stopper answers, nulls should cost 2 chunks and the
loop gets faster than it was. If the model is systematically unavailable the
fallback is `continue`, and the loop pays the full 30% indefinitely without
any signal that it is doing so.

So the first thing to watch after this lands is not whether the stopper's
judgments are good. It is whether it answers at all. The `seq_chunk` journal
entry carries the stopper's action, reason, error and cost beside the
posteriors it was given; a run of `error` non-null is the failure that costs
the most and shows the least.

## What the two-tier cap was costing

The shape it existed for - `1.4x throughput, -25% per-run d6`, where run count
and per-run depth pull opposite ways - ran to 6.5 chunks with a tail of 8 under
the old two-tier cap. It now escalates at 3.9 with a tail of 4, and escalation
is the right verdict: 94% of draws reach a human rather than being resolved by
more sampling that was never going to separate them. That saving is
unconditional and does not depend on the stopper.

## Reading the table

Every shape that resolves cleanly does so at the two-chunk minimum, which is
the floor `minChunks` sets. Nothing in the set needs three. The sampler's cost
is therefore concentrated entirely in the shapes it cannot separate - the null,
`h2-only`, and the throughput/depth conflict - and those are exactly the three
the stopper is meant to cut short. The design and the measurement agree about
where the money goes.
