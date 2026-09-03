# restart-release-after-peer-settles

Iteration 32, epoch 14.

## What changes

Per node a RestartState: open at restart; opening peers are the distinct
remote destinations of the RecoverInit segment's sends; replied peers are
opening peers from which a delivery-triggered handler entry acted since the
restart; settled when a majority have replied, or when there were no
opening sends; cleared at crash. On the treated half (bit 1 << 30; probes
exempt) a plan-released Recover(v) is withheld through a recover mask
while some live peer q has an open, unsettled RestartState and v's dead
incarnation still has an undelivered remote record addressed to q, counted
in a side map keyed (origin, destination, incarnation) that the in-flight
hooks maintain. The hold ends when q settles, when that count reaches
zero, or after 96 steps. No record is masked or reordered.

## Why

The restarted node's new request now always beats its dead incarnation's
reply to the peer that needs it, so the peer completes recovery on the
wrong order and drops what follows. Letting v's reply reach q before v
restarts gives q the reply it is waiting for and lets v's request be
answered in the old round.

## Frozen prediction

- Bit: 1073741824 (1 << 30, restartAfterPeerSettle); treated share about
  0.485.
- Firing per chunk: restart_settle.held >= 30,000; eligible within 5% on
  both halves; peer_settled/held >= 0.30; expired/held <= 0.50;
  held_at_exit/held <= 0.01; held steps per held in [4, 60].
- Primary: depth>=8 per run in [0.92, 1.06]; the race counter
  released.ghost_dispatched_before_recover reported (expected <= 0.35).
- Advance read: depth>=11 events on the treated half >= 2.0x control over
  four chunks with at least 24 treated events; depth>=9 in [0.97, 1.15]
  and depth>=10 reported; depth>=6 in [0.98, 1.03].
- Observables: settled receivers' fresh-request acted share >= 1.20x
  control; ghost entries into a settled receiver >= 1.15x control; census
  P4_2 among treated depth>=8 runs >= 3x control on a kept explore.
- Completion and cost: plan_complete within 3 points; crashes and
  recovers per run within 1%; steps <= 1.05x; throughput >= 0.97 of
  2132.3; wall per step equal within 1%.
- Verdict map: observables met and depth 11 up with depth 8 >= 0.95,
  merge on the advance rung or file (small counts); depth 8 in [0.92,
  0.95), file with the race counter; depth 11 flat, file; observables
  missed, close.

## Grading

`start --treatment-bit 1073741824 --band-min -0.08 --band-max 0.06`,
four chunks; then a kept explore for the census split by bit.
