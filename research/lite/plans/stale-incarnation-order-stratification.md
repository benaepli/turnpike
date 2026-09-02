# stale-incarnation-order-stratification

status: closed, refuted by primary falsifier (see decisions.jsonl) | origin: proposer | judge gain 7, cost 0, net 7

## Frozen prediction (frozen at admission, with the judge's rewrite)

- firingCounter `stale_order.masked_offers`, floor 50,000 per chunk
- rung depth>=6, sizePct 0.04 .. 0.30
- mechanism: forcing each stale delivery to a chosen side of its sender's
  post-restart traffic samples an ordering free scheduling reaches only by
  coincidence; one side meets a receiver guard that has not moved
- independent observable, primary and premise-free: the two arms separate -
  `ahead_acted/ahead_deliveries` and `behind_acted/behind_deliveries` differ
  by at least 1.5x, direction unfrozen. Secondary, reported not frozen:
  pooled treated `delivery_effects.sender_restarted.acted_fraction` against
  untreated.
- safety: stale deliveries per run on treated within 10% of untreated;
  `expired` under 20% of `armed`; treated steps/run within 15% of untreated;
  treated plan_complete share within 5 points of untreated; the
  per-(origin, destination) constraint carries a step bound no larger than
  the configured delay maximum.
- falsifier: masked_offers >= 50,000 and treated per-run P(depth>=6) not at
  least 1.04x untreated, probes dropped from both sides; or the two arms'
  acted rates within 1.2x of each other, which falsifies that arrival order
  relative to the new incarnation decides acting; or stale deliveries per
  run on treated more than 10% below untreated; or plan_complete more than
  5 points below.

## Design constraints carried from judging

- Posture from a salted mixer, independent of the three existing postures;
  no probe exemption, since no learner is fed by this mechanism.
- One bounded constraint per (origin, destination) pair; released the
  instant its record leaves flight; expiries counted beside armings so a
  leak shows as expired approaching armed.
- The AHEAD arm can block a node-pair stream for the full purgatory horizon
  and the empty-eligible-set valve will rarely fire in a 3-node system, so
  the step bound is the real bound.

## Grading plan

- Chunk 1 is firing and safety: `armed > 0`, `masked_offers >= 50,000`,
  both arms recording deliveries, `expired / armed < 0.2`.
- Primary read is the arm contrast, then the treated-versus-untreated
  contrast on depth>=6 with probes dropped from both sides.
- Expect 2 chunks, up to 4. Stop early if the arms sit within 1.2x at
  chunk 1 with `armed` healthy - the premise clause has then fired.
