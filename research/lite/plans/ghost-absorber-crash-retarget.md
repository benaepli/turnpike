# ghost-absorber-crash-retarget

Iteration 19, epoch 13. Family: fault placement (with the merged fan-out
anchor).

## What changes

A detector on every run marks each delivery whose origin is currently
crashed or has restarted since sending, and records on the destination's
ledger the step of its most recent such consumption and whether the
handler acted; a node's marks clear when it crashes. On the treated half
(bit 1 << 19, ghostAbsorberRetarget, salted half of all runs, run-cap
probes exempt), when a placed crash on plan victim v is applied, it lands
instead on the live node d that most recently consumed such a delivery,
acted preferred, and the plan's paired recover is remapped from v to d.
Placement timing and the fan-out anchor's hold are evaluated on v exactly
as today; only the identity of the node that dies changes.

Constraints: retarget candidates exclude any node with an outstanding
crash-recover pair; a planned crash whose victim is already crashed at
release is held in the crash mask until that node recovers; crash_pending
is not decremented a second time; the retarget applies only on campaign
runs, never on the run-plan path that regenerates the corpus; the actual
victim reaches the history through the existing schedule result, without
edits to exec.rs or history.rs.

## Why

The ladder loses 91% of runs between depth 4 and depth 5. Under a uniform
victim draw the second crash names the node that absorbed the ghost one
time in three; the most recent absorber is that node about half the time
or more, so the channel ratio is 1.5 to 2.25. Which node dies has never
been measured: the crash census compares the plan's victim to itself.
Message holds cost depth; this acts on the fault target instead.

## Frozen prediction

- Bit: GHOST_ABSORBER_RETARGET = 1 << 19 (ghostAbsorberRetarget) in
  run_variant.rs and VARIANT_BITS. Salted half of all runs; probes exempt.
- Rung and band: depth>=6 per-run ratio treated against untreated,
  probe-free, co-bit matched, in [1.25, 3.00].
- Firing: victim_swap.applied >= 60,000 per chunk; victim_swap.{no_absorber,
  same_victim, acted_absorber, skipped_pending_pair, victim_crashed_holds},
  victim_swap.census.{treated,control}.{crashes, victim_had_absorbed},
  ghost_signal.fired_runs and crash_census victim_had_inflight per half
  exported.
- Independent observable: treated absorbed-victim share >= 1.5x control
  (treated HIGHER); crashes applied per treated run within 1% of untreated.
- Falsifier: the depth>=6 interval entirely below 1.25; or absorbed-victim
  share below 1.5x control; or crashes per run off by more than 1%; or
  treated steps per run above 1.10x untreated; or treated plan_complete
  more than 3 points below untreated.
- Cost clause: cross-binary throughput at or above 0.97 of the paired
  baseline.

## Grading

`start --treatment-bit 524288 --band-min 0.25 --band-max 2.00`, two chunks
minimum; the untreated half is byte-identical to the merged behaviour.
