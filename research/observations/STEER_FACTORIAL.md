# Steer-term factorial, full size

Generated 2026-08-29 by the operator from the campaign arms of iteration 5308
(`steer-term-factorial-campaign`), which the sequential gate closed on the
throughput floor before reading its within-campaign contrast.

Reporting only. Changes no gate.

## What the run was

Eight `grid` arms in one campaign, a 2^3 factorial over the three steer
weights at 0 and 2.33, round-robin at equal exposure: 3 seeds x 8 arms,
~14,400 runs and ~37.6 s per arm-seed cell, 346,432 runs total. The arm id
reads crash_after_timer_sends, stale_late, request_before_stale.

The gate closed the hypothesis because the campaign ran at 0.668 of the
baseline campaign's throughput, under the 0.8 floor. That ratio is arm-mix
accounting, not a property of the steer terms: the candidate's eight arms are
all full-length `grid`, while the baseline campaign carries `grid-short`
(`max_iterations` 1500) at 1603 runs/s, and dropping it alone takes the mix
from 711 to about 480 runs/s. Within the campaign every arm runs at the same
speed (380-389 runs/s, spread 2%), and arm 000 holds all three weights at
zero, so the terms themselves cost no measurable throughput.

## Per arm, rate per run

| arm | runs | runs/s | P(d>=4) | P(d>=5) | P(d>=6) | P(d>=7) | P(d>=8) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 000 | 43904 | 389 | 0.4759 | 0.1667 | 0.0417 | 0.0096 | 0.0010 |
| 001 | 42944 | 380 | 0.4756 | 0.1654 | 0.0413 | 0.0091 | 0.0014 |
| 010 | 43264 | 383 | 0.4788 | 0.1675 | 0.0427 | 0.0096 | 0.0016 |
| 011 | 43040 | 381 | 0.4767 | 0.1705 | 0.0422 | 0.0094 | 0.0014 |
| 100 | 43744 | 387 | 0.4773 | 0.1667 | 0.0428 | 0.0102 | 0.0019 |
| 101 | 42944 | 381 | 0.4711 | 0.1661 | 0.0409 | 0.0089 | 0.0016 |
| 110 | 43456 | 385 | 0.4774 | 0.1653 | 0.0416 | 0.0098 | 0.0019 |
| 111 | 43136 | 382 | 0.4801 | 0.1698 | 0.0421 | 0.0099 | 0.0017 |

## Main effects, weight 2.33 against 0, pooled over the other two factors

| term | d>=4 | d>=5 | d>=6 | d>=7 | d>=8 |
| --- | --- | --- | --- | --- | --- |
| crash_after_timer_sends | -0.0% (z -0.1) | -0.3% (z -0.4) | -0.3% (z -0.2) | +2.9% (z 0.8) | +30.7% (z 3.1) |
| stale_late | +0.7% (z 1.9) | +1.2% (z 1.6) | +1.1% (z 0.7) | +2.0% (z 0.6) | +10.5% (z 1.2) |
| request_before_stale | -0.3% (z -0.9) | +0.9% (z 1.1) | -1.4% (z -0.9) | -4.5% (z -1.3) | -3.8% (z -0.4) |

111 against 000: d>=4 +0.9% (z 1.2), d>=5 +1.9% (z 1.2), d>=6 +0.9% (z 0.3),
d>=7 +3.2% (z 0.5), d>=8 +67.4% (z 2.8; 74 events against 45).

Violations are zero in every arm.

## What it says

The terms do nothing at the bulk rungs. Every main effect at d>=4, d>=5 and
d>=6 falls within 1.4% with |z| at most 1.9, and at 173,000 runs a side the
detectable difference at d>=6 is about 4.7% relative, so these are tight
nulls rather than absent power.

`STEER_FACTORIAL_FIRST_LOOK.md` reported stale_late at +7% on P(d>=6) from a
screening-size run. It does not replicate: the same contrast here is +1.1%
(z 0.7), and +7% at this size would carry z near 5. Read the first look as
noise and do not seed further work on it.

The one thing alive is crash_after_timer_sends at d>=8: 308 events in 173,280
runs against 233 in 173,152, +30.7% at z 3.1. Three factors across five rungs
is fifteen comparisons, so a Bonferroni-adjusted p is about 0.03 - it
survives, narrowly, and only read as one pre-specified family. Weigh it
against the standing warning that d>=8 is the rung with the least power, and
against epoch 7, under which d>=8 is recorded and never decides.

It points the right way even so. The oracle chain reaches 9 on the general
grid, and 71% of plan-corpus violations sit at depth 8, so d>=8 is the rung
nearest the bug and the one a single chunk cannot see. A term that raises it
by a third is exactly the effect the per-second ladder is built to miss.
The way to settle it is a two-arm campaign - crash_after_timer_sends at 0 and
at 2.33, nothing else - which buys four times the exposure per arm and tests
one pre-registered contrast at one rung.
