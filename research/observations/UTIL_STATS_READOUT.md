# Where simulator counters can and cannot be read

## What the explorer writes

`spur explore` serializes the whole `UtilizationSnapshot` twice per session:

- `<outputDir>/utilization.json`, deleted with the output directory once the
  corpus has been graded;
- `<outputDir>.utilization.json`, a sibling **outside** the directory, which
  `cleanupDir` does not touch (it removes only the directory itself).

Every counter in the snapshot reaches both files. Nothing is filtered on the
simulator side.

## What the evaluation record keeps

`utilSubset` in `research/orchestrator/src/evaluate.ts` reads the sibling and
hand-copies a fixed list of leaves:

- `termination.all`: seven named fields;
- `delivery_effects`: five named buckets, each reduced to `{deliveries, acted}`;
- `steer_authority`: five named fields.

Everything else in the snapshot is dropped. `UtilStats` in
`research/orchestrator/src/schemas.ts` then parses that object with a closed
`z.object`, so a key `utilSubset` did not name would be stripped a second time
even if it survived the first filter.

**The projection is an allow-list at field granularity, not block granularity.**
Adding a field to an existing serialized block does not make it appear in an
evaluation record. Verified by adding five flat `u64` fields to
`DeliveryEffectStats`: they appear in `utilization.json` (values in the tens of
thousands over a 30 s session) and cannot appear in `utilStats.deliveryEffects`,
because neither `utilSubset` nor the schema names them.

Both filters live under `research/orchestrator/`, which is protected. No
subject-side change can widen them. Two hypotheses that assumed otherwise -
piggybacking counters onto a serialized block, and asking the subset to pass
new keys through - are therefore closed as subject-side work.

## The channel that does work today

`tmp/loop/eval-<hypothesisId>-<fidelity>-<seed>.utilization.json` is the full
snapshot for one evaluation and survives that evaluation. An analysis script
under `research/observations/` can read those files directly and get every
counter the simulator emits, including ones the record does not carry. This
needs no harness change and no simulator change.

What it does not give is a counter the *gate* can see: the sequential screen
compares evaluation records, so a mechanism whose fire-criterion lives only in
the sibling file still returns a null the gate cannot attribute. Making a new
counter gate-visible requires an operator edit to `utilSubset` and `UtilStats`.

## Base rates measured while verifying this

From one 30 s campaign session on `bin/spur/VR.spur` under
`scheduler_configs/loop/general_vr.json` (smoke fidelity, numbers indicative
only):

| quantity | count | rate |
| --- | --- | --- |
| crashes | 54,628 | - |
| crashes with the crashing node's own send still undelivered | 18,861 | 0.345 |
| recoveries | 47,058 | - |
| recoveries with the node's own prior send still undelivered | 15,368 | 0.327 |
| deliveries from an incarnation that no longer exists | 29,662 | - |
| the subset of those the receiver acted on | 4,456 | 0.150 |

Both fault predicates are selective: roughly a third of crashes and a third of
recoveries satisfy them, so a mechanism gated on either is not collapsing into
its ungated form.
