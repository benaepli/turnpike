# replay-tier-answered-overtake-cut (with replay-prefix-inherit-parent-bits)

Iteration 27, epoch 14. One session, two bits: the tiered corpus on
bit 1 << 13 is the declared primary; the inheritance on bit 1 << 11 is a
fidelity read from counters and cells.

## What changes

Tiered admission. Beside the merged corpus (tier 1: a ghost delivery into
a node with a crash pending), tier 2 admits a parent at the first ghost
entry into a node that had already heard and replied to the origin's
current incarnation, cut at that step; tier 3 at the second ghost from the
same dead incarnation into that peer. A per-pair answered flag is written
at network entry; the heard table's update leaves the util_stats gate.
Treated slots serve the deepest non-empty tier; control slots serve tier 1.

Inheritance. On a salted half of PREFIX children, every run-id-keyed
mechanism draw is taken under the parent's run id so the replayed tape
pins the prefix; the child keeps its own DB id, slot bits and suffix seed;
children of probe parents are not inherited from. The runs-table variant
carries the mechanism bits of the id the draws used, the child's grid-arm
bits, and the inherit bit.

## Why

The corpus doubled depth 6 by re-sampling the plans of depth-4 runs, and
is oversupplied there. Epoch 14 prices deeper conditions the fresh-first
merge now makes common; parents cut at those conditions let children
explore the suffix that decides depth 9 and beyond. Fidelity of 0.44 caps
what prefix replay can add; inheriting the parent's bits tests whether the
bits were the binding constraint.

## Frozen predictions

Tiers: depth>=8 per run treated slots against control slots in [1.12,
2.20] on the SE-inflated interval (seEff times sqrt(1 + (m - 1) * 0.5), m
children per parent on the thinner side); depth 6 in [0.95, 1.25]; depth
9 ratio at least depth 8's; firing tier-2 plus tier-3 children >= 40,000
per chunk, tier-2 parents >= 5,000, tier-2 signal runs >= 60,000;
observables: deep children fire the deep signal at >= 1.5x tier-1
children's own-signal share (0.733), mean cut step tier 2 above tier 1,
post-session census P4_2 and R4 by half; falsifier: deep-signal ratio
below 1.2x, tier-2 parents below 5,000, or the inflated depth>=8 interval
entirely below 1.03; cost: throughput >= 0.97 of 2139.37, steps <= 1.05x,
plan_complete within 3 points of control slots.

Inheritance: fidelity of inherited children >= 0.65 against about 0.437,
bits_differed share >= 0.6, no inherited child tagged as a probe;
stratified depth>=8 read reported in [1.00, 1.35], decided only if the
inflated interval clears 1.00; falsifier: fidelity below 0.65, a probe
tag, or the stratified read entirely below 1.00.

## Grading

`start --treatment-bit 8192 --band-min 0.12 --band-max 1.20`, two chunks;
the inheritance read from replay.inherit.* counters and the variant cells;
then a kept explore for the census by half.
