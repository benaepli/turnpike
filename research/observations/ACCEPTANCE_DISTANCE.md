# Acceptance distance: is a stale delivery taken because of where it lands?

## The question

The delivery-effect counters say a delivery whose sender restarted in the
meantime is acted on about 16% of the time, and a delivery into a receiver that
restarted about 2%, against about 38% for deliveries in general. Four families
of scheduling mechanism - purgatory, orphan holding, stale-delivery expediting,
and delivery reordering - assume the difference is decided by *where* the
message lands relative to the receiver's own progress: inside a window just
after the receiver comes back it is still accepted, and past that window the
receiver has moved on and drops it.

That premise has never been measured. This is the instrument that measures it.

## What is recorded

`delivery_effects.acceptance_distance` in `<output_dir>/utilization.json`. For
every delivery that reaches a handler entry, the receiving node's *distance* is
the number of handler entries (deliveries and timer firings) that node has
taken since it last came back from a crash, not counting the delivery being
measured. A node that never crashed counts from the start of the run, so its
distance says how far into the run the delivery landed rather than how far into
a recovery.

Distances are bucketed `0, 1, 2, 3-4, 5-8, 9-16, 17+` and crossed with the
`acted` flag the delivery-effect probe already computes (the receiver's state
token changed across the handler's first execution segment). Three populations
are kept:

- `all` - every delivery, the control curve.
- `sender_restarted` - the sender crashed and recovered between send and
  delivery. The receiver here has usually *not* restarted, so its distance is
  position in the run.
- `receiver_restarted` - the message was held across the receiver's own crash
  and handed to a later incarnation. This is the population where distance is
  literally distance into a recovery, and it is the one the window hypothesis
  is about.

A message carrying both restarts is counted in both rows, so the two do not sum
to `all`.

## Turning it on

`emit_acceptance_distance` in the explorer config, default `false`. It rides
the existing delivery-effect probe, so it also needs `stats` and
`emit_acted_fraction`. No scheduling behavior changes: the only work added on
the hot path is one subtraction of two per-node counters and two atomic
increments per delivery.

## Reading a session

    research/observations/acceptance_distance.py <output_dir>.utilization.json

prints deliveries, acted, acted fraction and a 95% interval per bucket for each
of the three populations. Several dumps may be passed and are summed.

## How to read the result

The census resolves on a prescreen (roughly a thousand runs), because it counts
deliveries rather than runs and a session produces millions of them. Fill the
table below from a prescreen and the reading follows directly:

**If `receiver_restarted` falls off with distance** - high acted fraction at
distance 0-1, near zero past 4 - then arrival position is the mechanism. The
placement family gets both a target (land the delivery inside the window) and a
bound (the window's width in handler entries is the budget a mechanism has to
work with, and the acted fraction at distance 0 is the ceiling it can reach).

**If `receiver_restarted` is flat across distance** - the acted fraction is the
same at 0 as at 17+ - then arrival position is not what decides acceptance, and
the reading every purgatory, orphan-holding and expedite proposal was built on
is wrong. Those proposals move messages *along* an axis that does not separate
acted from absorbed, which is consistent with all six of them failing. What
decides acceptance would then have to be something the delivery carries rather
than when it arrives, and the next measurement belongs there.

The `all` row is the control that says whether any decay found is specific to
the restart paths or is a property of deliveries generally: an `all` curve that
decays the same way means the census has found "later in the run is quieter",
not "later in a recovery is closed".

## Result

| population | distance | deliveries | acted | acted fraction |
|---|---|---|---|---|

To be filled from a prescreen session under
`scheduler_configs/loop/general_vr.json`, which enables the key.
