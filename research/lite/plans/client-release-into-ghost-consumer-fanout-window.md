# client-release-into-ghost-consumer-fanout-window

Iteration 31, epoch 14.

## What changes

On the treated half (bit 1 << 18; probes exempt), a planned client
request that becomes ready after the run's first executed crash is held
instead of invoked, and released one per firing of a live ledger
predicate: a node that just consumed an acted fault-crossing entry and
answered with a full fan-out none of which has landed. The request is
invoked the following step. Expiry at ready plus 32 steps; the deadlock
test runs against the admitted set; a dry queue releases. Requests ready
at step 0 are untouched. A held request has no record, so nothing in
flight is delayed.

## Why

Depth 10 needs the write issued after the ghost DoViewChange lands, and
depth 11 needs it committed in the old view before the new view reaches
the old primary. Today every request is invoked the step it becomes ready,
so its timing against the chain is chance, and about one depth-9 run in
twenty-five reaches depth 10.

## Frozen prediction

- Bit: 262144 (1 << 18, clientFanoutRelease); treated share about 0.485.
- Firing per chunk: client_anchor.held >= 400,000; fanout_windows >=
  100,000 on both halves; released.anchor >= 40,000;
  released.anchor.second_or_later >= 10,000; released split by firing
  ordinal and request kind; histogram of held count at first firing.
- Primary: depth>=10 per-run treated/control in [1.3, 3.5], read at four
  chunks; pass if the lower edge clears 1.0 with the point >= 1.3; extend
  to eight chunks if the interval straddles 1.3 with the point in
  [1.0, 1.3). Depth>=8 in [0.95, 1.05]; depth>=9 in [0.95, 1.10].
- Independent observable: treated share of post-fault invocations inside
  a ghost-consumer fan-out window >= 0.30 against control <= 0.05; census
  P3_issued_after > 0 among treated depth>=9 runs on a kept explore.
- Falsifier: floors met and in-window share >= 4x control with the
  depth>=10 upper edge below 1.3; inert if expiry/held > 0.8 or the
  in-window share < 4x; depth>=8 below 0.95 or depth>=9 below 0.90;
  plan_complete more than 3 points below control, outstanding planned
  events per run treated minus control > 0.15, or held_at_exit > 1%.
- Cost: throughput >= 0.97 of 2139.37; steps <= 1.05x.

## Grading

`start --treatment-bit 262144 --band-min -0.05 --band-max 0.05` (depth 8
null), four chunks; depth 10 read from finish's rungs and the cells with
the standard error inflated 1.3x; then a kept explore for the census.
