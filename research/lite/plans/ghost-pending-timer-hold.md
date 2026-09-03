# ghost-pending-timer-hold

Iteration 24, epoch 13. Steered by research/lite/findings/chain-precision-
census.md.

## What changes

On a salted half of runs (bit 1 << 25; probes exempt), a node's timer
firings are ineligible while a remote record to that node from an origin
that is crashed or has changed incarnation is undelivered. An episode
opens at the first masked offer and closes when the ghost lands or at 32
steps (128 on a nested salted half, bit 1 << 26); after an expiry the node
stays unmasked until no ghost is pending once. When no other runnable
would be eligible the mask is dropped for the step and counted, so a held
timer never makes a blocked step. No record is masked or reordered. A
both-halves census counts timer firings with a ghost pending, ghost
deliveries, ghost acted and ghost sent, gated so quiet stretches pay one
branch. Untreated runs and the run-plan path keep stock timing.

## Why

General runs lose the chain first where the crashed sender's message lands
on a round the receiver has already left, because timers free-run. A
broadcast from a crashed sender puts a ghost in front of every live peer's
timer at once, so holding timers while a ghost is pending leaves no free
clock to advance the round. The hold's natural length is a message's
flight time, a few steps.

## Frozen prediction

- Bits: GHOST_PENDING_TIMER_HOLD = 1 << 25 (ghostPendingTimerHold) and
  nested GHOST_PENDING_TIMER_HOLD_LONG = 1 << 26 (ghostPendingTimerHoldLong)
  in run_variant.rs and VARIANT_BITS; treated share about 0.47.
- Rung and band: depth>=6 per-run ratio treated against untreated,
  probe-free, co-bit matched, in [0.97, 1.12]; a null is allowed and the
  observables carry the claim.
- Firing: ghost_timer_hold.episodes >= 400,000 per chunk; masked_offers,
  released_by_landing, expired, lifted_for_liveness, long_bound_runs and
  census.{treated,control}.{timer_firings, timer_fired_with_ghost_pending,
  ghost_deliveries, ghost_acted, ghost_sent} exported.
- Independent observables: treated ghost-acted share >= 1.20x control;
  treated share of timer firings with a ghost pending <= 0.50x control;
  treated ghost-sent share >= 1.30x control; post-session census on a kept
  explore, treated R2 >= 1.3x control at depth>=8; long bound expires less
  than the short bound and acts at least as often.
- Falsifier: the depth>=6 interval entirely below 0.97; or the acted share
  below 1.10x; or the firings-with-ghost share above 0.70x; or treated
  steps per run above 1.05x control; or treated plan_complete more than 3
  points below control; or crashes or recovers per treated run outside 1%
  of control.
- Cost clause: throughput >= 0.97; regression passes.
- Verdict map: observables met and depth flat, file for the user;
  observables met and depth up, merge; acted or binding clause missed,
  close.

## Grading

`start --treatment-bit 33554432 --band-min -0.03 --band-max 0.12`, two
chunks; then a kept explore of the candidate binary for the census read.
