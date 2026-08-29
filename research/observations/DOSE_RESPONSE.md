# Two dose sweeps, and both constants are already right

Recovered from the campaign arms of iterations 5311 and 5312. Both
hypotheses were closed - one on arm-mix accounting, one on a per-run
regression - and in both cases the question they asked is answered by the
per-arm data the gate discards.

Reporting only. Changes no gate.

## purgatory.delay_probability (iteration 5311, 218,700 runs)

| rate | P(d>=5) | P(d>=6) | d>=5/s | d>=6/s | runs/s |
| --- | --- | --- | --- | --- | --- |
| 0 | 0.1327 | 0.0246 | 78.6 | 14.6 | 592 |
| 0.05 | 0.1437 | 0.0302 | 84.2 | 17.7 | 586 |
| 0.15 (current) | 0.1641 | 0.0410 | 93.6 | 23.4 | 570 |
| 0.30 | 0.1781 | 0.0463 | 93.8 | 24.4 | 527 |
| 0.50 | 0.1588 | 0.0318 | 70.2 | 14.0 | 442 |

An interior optimum. Zero costs 38% of the objective and 0.50 costs 40%, so
the knob is load-bearing. The current 0.15 sits within 4.3% of the best
point tested, a gap near the minimum separable effect, and 0.30 buys it at
7.5% of throughput. Per run 0.30 beats 0.15 at z about 2.6; per explore
second one chunk cannot separate them.

## post_fault_client_ops (iteration 5312, 173,460 runs)

| ops | P(d>=5) | P(d>=6) | d>=5/s | d>=6/s | runs/s |
| --- | --- | --- | --- | --- | --- |
| 0 | 0.1482 | 0.0423 | 83.0 | 23.7 | 560 |
| 1 (current) | 0.1691 | 0.0438 | 96.6 | 25.0 | 571 |
| 2 | 0.1539 | 0.0369 | 89.7 | 21.5 | 583 |
| 3 | 0.1379 | 0.0301 | 82.4 | 18.0 | 597 |

The current value is the best of the four on both the per-run probability
and the per-second rate. More client work after a fault costs depth
monotonically from 1 upward, and throughput rises as depth falls, so the
two do not trade against each other here: 1 is simply the peak.

## What the pair says

Both constants are already at or within noise of their optimum, found
independently and on the first sweep of each. The parameter surface around
the current configuration is a local maximum, so the dose families are
answered and extending them cannot pay. Read this with the direction
review: the mechanism lane merges 1 of 26, and now the tuning lane has no
headroom either.

The measurement lesson is separate and cheap. Both sweeps were expressed as
campaign arms, and the campaign is the unit a candidate is compared on, so
in both cases the arm set changed and the comparison collapsed into arm-mix
accounting before the contrast could be read. 5308 failed the same way. A
sweep belongs inside one arm as an overlay, or in an offline study; as a
set of new arms it is unmeasurable by construction, and it costs a full
iteration to learn that each time.
