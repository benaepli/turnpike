# Steer-terms factorial: first look

One 300 s round-robin campaign chunk (session_seed 1000, 14 threads, 8 grid arms over {crash_after_timer_sends, stale_late, request_before_stale} at w = 2.33; arm `000` is today's grid). Per arm about 21k runs, which resolves only large effects: at P(depth>=6) ~ 0.008 an arm holds ~170 events, so the per-arm 95% interval is about +/-15% relative and a main effect under ~10% is inside noise. This is a smoke test of the machinery and a first look at direction, not an estimate.

| arm | runs | runs/s | P(d>=5) | P(d>=6) [95%] | P(d>=7) | viol |
|---|---|---|---|---|---|---|
| 000 | 15808 | 394 | 0.1676 | 0.0403 [0.0373,0.0435] | 0.0085 | 0 |
| 001 | 15360 | 383 | 0.1667 | 0.0392 [0.0362,0.0424] | 0.0085 | 0 |
| 010 | 15360 | 383 | 0.1685 | 0.0421 [0.0391,0.0454] | 0.0086 | 0 |
| 011 | 15296 | 380 | 0.1689 | 0.0443 [0.0412,0.0477] | 0.0118 | 0 |
| 100 | 15744 | 392 | 0.1701 | 0.0426 [0.0395,0.0458] | 0.0084 | 0 |
| 101 | 15488 | 385 | 0.1654 | 0.0390 [0.0361,0.0422] | 0.0083 | 0 |
| 110 | 11552 | 383 | 0.1654 | 0.0407 [0.0372,0.0444] | 0.0081 | 0 |
| 111 | 11552 | 383 | 0.1682 | 0.0456 [0.0420,0.0496] | 0.0110 | 0 |

## Counters per arm (from campaign.json)

| arm | term | present | won | flipped | acted |
|---|---|---|---|---|---|
| 000 | crash_after_timer_sends | 232 | 229 | 0 | 229 |
| 000 | stale_late | 82458 | 14654 | 0 | 950 |
| 000 | request_before_stale | 125332 | 73138 | 0 | 5612 |
| 001 | crash_after_timer_sends | 227 | 220 | 0 | 220 |
| 001 | stale_late | 83306 | 13703 | 0 | 985 |
| 001 | request_before_stale | 90775 | 70028 | 31548 | 8354 |
| 010 | crash_after_timer_sends | 238 | 232 | 0 | 232 |
| 010 | stale_late | 16939 | 12886 | 5764 | 1253 |
| 010 | request_before_stale | 28729 | 9787 | 0 | 1072 |
| 011 | crash_after_timer_sends | 231 | 227 | 0 | 227 |
| 011 | stale_late | 20844 | 12752 | 5539 | 1229 |
| 011 | request_before_stale | 25796 | 19392 | 12296 | 2414 |
| 100 | crash_after_timer_sends | 251 | 248 | 0 | 248 |
| 100 | stale_late | 83202 | 14533 | 0 | 997 |
| 100 | request_before_stale | 126310 | 74582 | 0 | 5433 |
| 101 | crash_after_timer_sends | 252 | 250 | 0 | 250 |
| 101 | stale_late | 84310 | 14091 | 0 | 1073 |
| 101 | request_before_stale | 92381 | 71405 | 32163 | 8630 |
| 110 | crash_after_timer_sends | 211 | 206 | 0 | 206 |
| 110 | stale_late | 12553 | 9593 | 4389 | 883 |
| 110 | request_before_stale | 21759 | 7313 | 0 | 837 |
| 111 | crash_after_timer_sends | 199 | 199 | 0 | 199 |
| 111 | stale_late | 16161 | 9815 | 4167 | 991 |
| 111 | request_before_stale | 20021 | 15102 | 9659 | 1875 |

## Main effects on P(depth>=6) per run

| term | on (mean of 4 arms) | off (mean of 4 arms) | difference | relative |
|---|---|---|---|---|
| crash_after_timer_sends | 0.0420 | 0.0415 | +0.0005 | +1.2% |
| stale_late | 0.0432 | 0.0403 | +0.0029 | +7.3% |
| request_before_stale | 0.0420 | 0.0414 | +0.0006 | +1.5% |

What this shows: whether each predicate fires and wins at w = 2.33 on the general grid (the counters), whether routing to a predicated queue changes throughput, and the sign of each term's effect on the deep rungs at one seed. What it does not show: an effect size the gate could act on (that needs the sequential protocol over several chunks against the baseline), interactions (four arms per cell at this count are noise), or violations (none expected at this count).

Two things to read with the caveat above. Arms `110` and `111` got three
10 s slices where the others got four (30 slices over 8 arms), so their run
counts are lower and their intervals wider; a full-factorial chunk should use
a wall that is a multiple of `8 x min_slice_sec`. And the two arms that
combine `stale_late` with `request_before_stale` (`011`, `111`) are the only
ones above 0.010 at P(depth>=7) (0.0118 and 0.0110 against 0.0081-0.0086
elsewhere), on 130-180 events each - a direction to test with the sequential
protocol, not a result. The counters show the machinery doing what the design
says: at zero weight (`000`) every term is present and wins only by the draw
(`flipped` 0); at w = 2.33 (`111`) `stale_late` flips the pick 4,167 times and
`request_before_stale` 9,659 times, and fewer stale candidates linger because
they are delivered sooner (`present` 82k -> 16k).
