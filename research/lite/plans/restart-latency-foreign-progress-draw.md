# restart-latency-foreign-progress-draw

status: closed, refuted by primary falsifier (see decisions.jsonl) | origin: proposer | judge gain 6, cost 0

## Frozen prediction (frozen at admission, with the judge's rewrite)

- firingCounter `restart_latency.draws`, floor 50,000 per chunk
- rung depth>=6, sizePct 0.10 .. 0.70
- design: a three-arm draw at equal mass per crash - {g = 0 forced-immediate
  restart, g drawn from the ladder {1,2,4,8,16,32,64} truncated at the
  scope's learned span, stock} - so the arm consistent with the original
  story carries a third of the mass rather than an eighth
- independent observable, direction unfrozen: `sender_restarted`
  acted fraction reported PER ARM from new per-arm counters (the existing
  `deliveryEffects` block is session-global and cannot be split by posture);
  `restart_latency.zero_progress_restarts` above 5% of treated recoveries;
  crashes and recovers per run within 5% of untreated; stale deliveries per
  run reported per arm; treated steps/run within 15% of untreated
- falsifier: draws >= 50,000 and treated per-run P(depth>=6) not at least
  1.10x untreated; or the three arms' acted fractions all within 1.2x of
  each other, which says the crash-to-restart interval does not move
  acted-ness in either direction; or treated steps/run more than 15% above
  untreated

## Design constraints from judging

- The posture salt is load-bearing: `run_phase::salted_phase` with a
  distinct constant, never a new period on the shared mix.
- `SendLedger::entries` is the foreign-progress measure: monotone by
  construction, never reset.
- No probe exemption; nothing here feeds a learner.
- Every hold and the g=0 forced window release when they would leave the
  eligible set empty, and carry a step bound.
