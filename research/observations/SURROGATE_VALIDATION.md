# Surrogate validation

Generated 2026-08-29T03:52:52.243Z by research/observations/surrogate_validation.mjs (wall 120 s per member session, 600 s on the evaluation spec, 3 seed(s)).

For each host, every arm of the evaluation template ran under a round-robin campaign; each reward kind's rate per arm second is rank-correlated (Spearman) with the graded outcome's rate per arm second across arms, then averaged over seeds. Violations per second is the outcome on panel members, depth>=6 events per second on the evaluation spec.

## paxos-accept-stale-ballot (gate, 12141 graded events over 3 seed(s))

Per arm second:

| arm | runs/s | termination_completed/s | hazard_crossing/s | absorption_acted/s | timeline_novelty/s | steps_used/s | runs/s | violationsPerSec |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grid | 1359.4 | 1119.10 | 4295.87 | 114054.01 | 0.04 | 2178794.07 | 1359.42 | 24.5011 |
| grid-short | 3408.8 | 2802.32 | 10785.34 | 286125.20 | 0.04 | 1551257.49 | 3408.83 | 59.9510 |
| grid-no-purgatory | 1658.5 | 1428.42 | 6161.83 | 107300.64 | 0.04 | 2068312.30 | 1658.49 | 37.1837 |
| grid-post-fault-2 | 1448.7 | 1216.97 | 4312.23 | 121325.61 | 0.04 | 2132177.94 | 1448.70 | 25.1434 |
| aos | 1343.6 | 1102.56 | 4357.02 | 114887.07 | 0.04 | 2192981.73 | 1343.62 | 21.6312 |

Per run:

| arm | termination_completed/run | hazard_crossing/run | absorption_acted/run | timeline_novelty/run | steps_used/run | runs/run | violationsPerRun |
| --- | --- | --- | --- | --- | --- | --- | --- |
| grid | 0.8232 | 3.1601 | 83.8993 | 0.0000 | 1602.9342 | 1.0000 | 0.01802 |
| grid-short | 0.8221 | 3.1639 | 83.9362 | 0.0000 | 455.0688 | 1.0000 | 0.01759 |
| grid-no-purgatory | 0.8613 | 3.7153 | 64.6987 | 0.0000 | 1247.2034 | 1.0000 | 0.02242 |
| grid-post-fault-2 | 0.8400 | 2.9766 | 83.7483 | 0.0000 | 1471.8954 | 1.0000 | 0.01736 |
| aos | 0.8196 | 3.2382 | 85.5857 | 0.0000 | 1640.1721 | 1.0000 | 0.01617 |

Spearman rho across arms, per second (reference): termination_completed 0.93, hazard_crossing 0.77, absorption_acted 0.33, timeline_novelty 0.53, steps_used -0.93, runs 0.93
Spearman rho across arms, per run (judged): termination_completed 0.30, hazard_crossing 0.27, absorption_acted -0.40, timeline_novelty -0.23, steps_used -0.23, runs 0.35

## mencius-opt1-2 (gate, 1238 graded events over 3 seed(s))

Per arm second:

| arm | runs/s | termination_completed/s | hazard_crossing/s | absorption_acted/s | timeline_novelty/s | steps_used/s | runs/s | violationsPerSec |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grid | 276.6 | 92.92 | 0.00 | 44653.71 | 0.04 | 1159605.18 | 276.61 | 2.0431 |
| grid-short | 846.4 | 280.47 | 0.00 | 135268.77 | 0.04 | 1015265.53 | 846.43 | 7.1644 |
| grid-no-purgatory | 372.1 | 179.82 | 0.00 | 38815.21 | 0.04 | 1200152.18 | 372.07 | 3.7009 |
| grid-post-fault-2 | 277.6 | 93.79 | 0.00 | 44509.91 | 0.04 | 1160731.37 | 277.62 | 2.1481 |
| aos | 257.7 | 76.12 | 0.00 | 43375.33 | 0.04 | 1137073.81 | 257.67 | 2.0461 |

Per run:

| arm | termination_completed/run | hazard_crossing/run | absorption_acted/run | timeline_novelty/run | steps_used/run | runs/run | violationsPerRun |
| --- | --- | --- | --- | --- | --- | --- | --- |
| grid | 0.3359 | 0.0000 | 161.4338 | 0.0001 | 4192.2948 | 1.0000 | 0.00739 |
| grid-short | 0.3314 | 0.0000 | 159.8113 | 0.0000 | 1199.4691 | 1.0000 | 0.00846 |
| grid-no-purgatory | 0.4832 | 0.0000 | 104.3269 | 0.0001 | 3225.9869 | 1.0000 | 0.00995 |
| grid-post-fault-2 | 0.3378 | 0.0000 | 160.3255 | 0.0001 | 4180.9560 | 1.0000 | 0.00774 |
| aos | 0.2950 | 0.0000 | 168.4593 | 0.0002 | 4415.4866 | 1.0000 | 0.00793 |

Spearman rho across arms, per second (reference): termination_completed 0.87, hazard_crossing n/a, absorption_acted 0.20, timeline_novelty 0.60, steps_used -0.13, runs 0.90
Spearman rho across arms, per run (judged): termination_completed 0.25, hazard_crossing n/a, absorption_acted -0.49, timeline_novelty -0.39, steps_used -0.39, runs n/a

## raft-stale-vote (report, 69 graded events over 3 seed(s))

Per arm second:

| arm | runs/s | termination_completed/s | hazard_crossing/s | absorption_acted/s | timeline_novelty/s | steps_used/s | runs/s | violationsPerSec |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grid | 466.4 | 407.92 | 284.59 | 457000.85 | 0.04 | 858365.83 | 466.44 | 0.0966 |
| grid-short | 1903.2 | 1660.60 | 1148.24 | 477957.60 | 0.04 | 1002294.90 | 1903.24 | 0.5969 |
| grid-no-purgatory | 428.4 | 355.24 | 309.21 | 559212.97 | 0.04 | 938593.84 | 428.42 | 0.1104 |
| grid-post-fault-2 | 565.3 | 528.78 | 191.31 | 332831.16 | 0.04 | 641668.89 | 565.31 | 0.1382 |
| aos | 282.6 | 246.21 | 175.93 | 253706.11 | 0.04 | 545404.53 | 282.62 | 0.0138 |

Per run:

| arm | termination_completed/run | hazard_crossing/run | absorption_acted/run | timeline_novelty/run | steps_used/run | runs/run | violationsPerRun |
| --- | --- | --- | --- | --- | --- | --- | --- |
| grid | 0.8745 | 0.6101 | 979.8686 | 0.0001 | 1840.4228 | 1.0000 | 0.00021 |
| grid-short | 0.8725 | 0.6033 | 251.1315 | 0.0000 | 526.6311 | 1.0000 | 0.00031 |
| grid-no-purgatory | 0.8291 | 0.7217 | 1305.6758 | 0.0001 | 2191.5038 | 1.0000 | 0.00026 |
| grid-post-fault-2 | 0.9354 | 0.3384 | 588.8624 | 0.0001 | 1135.2623 | 1.0000 | 0.00025 |
| aos | 0.8266 | 0.6712 | 841.8054 | 0.0003 | 2444.0115 | 1.0000 | 0.00003 |

Spearman rho across arms, per second (reference): termination_completed 0.83, hazard_crossing 0.57, absorption_acted 0.43, timeline_novelty 0.70, steps_used 0.67, runs 0.83
Spearman rho across arms, per run (judged): termination_completed -0.03, hazard_crossing -0.23, absorption_acted -0.43, timeline_novelty -0.67, steps_used -0.57, runs n/a

## paxos-forget-promise (report, 146 graded events over 3 seed(s))

Per arm second:

| arm | runs/s | termination_completed/s | hazard_crossing/s | absorption_acted/s | timeline_novelty/s | steps_used/s | runs/s | violationsPerSec |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grid | 1892.9 | 1777.18 | 5978.97 | 170341.32 | 0.04 | 1392807.91 | 1892.92 | 0.3191 |
| grid-short | 3373.2 | 3166.62 | 10661.16 | 303869.97 | 0.04 | 1142197.10 | 3373.19 | 0.7496 |
| grid-no-purgatory | 2187.0 | 2044.20 | 8117.27 | 119432.35 | 0.04 | 1453864.88 | 2186.91 | 0.5273 |
| grid-post-fault-2 | 2090.3 | 2004.38 | 6216.53 | 186847.81 | 0.04 | 1213733.29 | 2090.26 | 0.2359 |
| aos | 1795.3 | 1696.47 | 5512.88 | 172761.03 | 0.04 | 1325513.61 | 1795.23 | 0.1942 |

Per run:

| arm | termination_completed/run | hazard_crossing/run | absorption_acted/run | timeline_novelty/run | steps_used/run | runs/run | violationsPerRun |
| --- | --- | --- | --- | --- | --- | --- | --- |
| grid | 0.9388 | 3.1587 | 89.9876 | 0.0000 | 735.9377 | 1.0000 | 0.00017 |
| grid-short | 0.9388 | 3.1605 | 90.0829 | 0.0000 | 338.6069 | 1.0000 | 0.00022 |
| grid-no-purgatory | 0.9347 | 3.7116 | 54.6107 | 0.0000 | 664.7479 | 1.0000 | 0.00024 |
| grid-post-fault-2 | 0.9589 | 2.9740 | 89.3893 | 0.0000 | 580.6409 | 1.0000 | 0.00011 |
| aos | 0.9452 | 3.0729 | 96.2684 | 0.0000 | 737.2950 | 1.0000 | 0.00011 |

Spearman rho across arms, per second (reference): termination_completed 0.73, hazard_crossing 0.73, absorption_acted 0.23, timeline_novelty 0.47, steps_used -0.07, runs 0.73
Spearman rho across arms, per run (judged): termination_completed -0.73, hazard_crossing 0.53, absorption_acted -0.30, timeline_novelty -0.67, steps_used -0.30, runs 0.27

## vr-depth6 (target, 40376 graded events over 3 seed(s))

Per arm second:

| arm | runs/s | termination_completed/s | hazard_crossing/s | absorption_acted/s | timeline_novelty/s | steps_used/s | runs/s | depth6PerSec |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grid | 409.9 | 116.34 | 609.93 | 142321.69 | 0.01 | 1854160.58 | 409.90 | 17.1000 |
| grid-short | 1330.8 | 333.25 | 1971.33 | 176926.54 | 0.01 | 1709668.42 | 1330.80 | 53.2149 |
| grid-no-purgatory | 417.0 | 121.49 | 741.17 | 145909.43 | 0.01 | 1809023.54 | 417.03 | 10.5570 |
| grid-post-fault-2 | 419.8 | 124.08 | 522.48 | 130394.69 | 0.01 | 1875220.92 | 419.84 | 15.3813 |
| aos | 388.9 | 96.31 | 557.28 | 141489.97 | 0.01 | 1849622.50 | 388.89 | 15.6242 |

Per run:

| arm | termination_completed/run | hazard_crossing/run | absorption_acted/run | timeline_novelty/run | steps_used/run | runs/run | depth6PerRun |
| --- | --- | --- | --- | --- | --- | --- | --- |
| grid | 0.2838 | 1.4880 | 347.2185 | 0.0000 | 4523.4596 | 1.0000 | 0.04172 |
| grid-short | 0.2504 | 1.4813 | 132.9472 | 0.0000 | 1284.6889 | 1.0000 | 0.03999 |
| grid-no-purgatory | 0.2913 | 1.7773 | 349.8855 | 0.0000 | 4337.9288 | 1.0000 | 0.02531 |
| grid-post-fault-2 | 0.2955 | 1.2445 | 310.5744 | 0.0000 | 4466.4526 | 1.0000 | 0.03664 |
| aos | 0.2469 | 1.4347 | 363.7127 | 0.0000 | 4759.9519 | 1.0000 | 0.04021 |

Spearman rho across arms, per second (reference): termination_completed 0.30, hazard_crossing 0.27, absorption_acted 0.40, timeline_novelty 0.50, steps_used -0.27, runs 0.30
Spearman rho across arms, per run (judged): termination_completed -0.50, hazard_crossing -0.43, absorption_acted 0.23, timeline_novelty 0.30, steps_used 0.43, runs n/a

## Admissibility

A reward kind is admissible when its per-run rho >= 0.7 on every gate member with at least 5 violations, per-run rho >= 0 on every other member with at least 5 violations, and per-run rho >= 0.7 on the evaluation spec's depth>=6. Per-second rho is reported for reference: an arm that runs faster raises every per-second column together.

- termination_completed: not admissible (5 host(s) judged)
- hazard_crossing: not admissible (4 host(s) judged)
- absorption_acted: not admissible (5 host(s) judged)
- timeline_novelty: not admissible (5 host(s) judged)
- steps_used: not admissible (5 host(s) judged)
- runs: not admissible (2 host(s) judged, evaluation spec not judged)

(no reward kind admitted)
