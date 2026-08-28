# Surrogate validation

Generated 2026-08-28T18:45:47.744Z by research/observations/surrogate_validation.mjs (wall 120 s per member session, 600 s on the evaluation spec, 3 seed(s)).

For each host, every arm of the evaluation template ran under a round-robin campaign; each reward kind's rate per arm second is rank-correlated (Spearman) with the graded outcome's rate per arm second across arms, then averaged over seeds. Violations per second is the outcome on panel members, depth>=6 events per second on the evaluation spec.

## paxos-accept-stale-ballot (gate, 15330 graded events over 3 seed(s))

| arm | termination_completed/s | hazard_crossing/s | absorption_acted/s | timeline_novelty/s | steps_used/s | runs/s | violationsPerSec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| grid | 1339.28 | 5150.21 | 136852.68 | 0.04 | 2629392.15 | 1629.68 | 27.7713 |
| grid-short | 3916.35 | 15065.41 | 399634.44 | 0.04 | 2164816.28 | 4762.51 | 82.8185 |
| grid-no-purgatory | 1697.14 | 7314.13 | 127030.86 | 0.04 | 2425108.38 | 1966.45 | 43.1386 |
| grid-post-fault-2 | 1449.43 | 5150.90 | 144484.04 | 0.04 | 2544570.47 | 1726.10 | 31.4320 |
| aos | 1470.60 | 5621.88 | 147903.38 | 0.04 | 2628446.35 | 1755.06 | 27.5456 |

Spearman rho across arms: termination_completed 0.90, hazard_crossing 0.73, absorption_acted 0.30, timeline_novelty 0.83, steps_used -1.00, runs 0.90

## mencius-opt1-2 (gate, 1825 graded events over 3 seed(s))

| arm | termination_completed/s | hazard_crossing/s | absorption_acted/s | timeline_novelty/s | steps_used/s | runs/s | violationsPerSec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| grid | 141.49 | 0.00 | 67284.06 | 0.04 | 1743178.69 | 417.42 | 3.3472 |
| grid-short | 447.92 | 0.00 | 214022.83 | 0.04 | 1605812.31 | 1341.36 | 10.6862 |
| grid-no-purgatory | 268.26 | 0.00 | 58207.60 | 0.04 | 1807625.34 | 558.00 | 5.5005 |
| grid-post-fault-2 | 144.20 | 0.00 | 67754.21 | 0.04 | 1761706.68 | 423.10 | 3.1740 |
| aos | 132.96 | 0.00 | 68195.99 | 0.04 | 1748113.93 | 410.27 | 2.5315 |

Spearman rho across arms: termination_completed 0.97, hazard_crossing n/a, absorption_acted 0.17, timeline_novelty 0.67, steps_used -0.07, runs 0.97

## raft-stale-vote (report, 79 graded events over 3 seed(s))

| arm | termination_completed/s | hazard_crossing/s | absorption_acted/s | timeline_novelty/s | steps_used/s | runs/s | violationsPerSec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| grid | 440.51 | 309.32 | 503617.57 | 0.04 | 945994.12 | 505.25 | 0.1108 |
| grid-short | 2119.37 | 1467.80 | 609598.18 | 0.04 | 1278085.50 | 2427.33 | 0.6384 |
| grid-no-purgatory | 406.12 | 349.28 | 629446.88 | 0.04 | 1058117.64 | 488.54 | 0.2211 |
| grid-post-fault-2 | 539.80 | 197.90 | 328739.48 | 0.04 | 635468.55 | 575.54 | 0.0966 |
| aos | 206.04 | 151.47 | 240098.46 | 0.04 | 584076.50 | 246.90 | 0.0276 |

Spearman rho across arms: termination_completed 0.63, hazard_crossing 0.93, absorption_acted 0.83, timeline_novelty 0.77, steps_used 0.93, runs 0.63

## paxos-forget-promise (report, 120 graded events over 3 seed(s))

| arm | termination_completed/s | hazard_crossing/s | absorption_acted/s | timeline_novelty/s | steps_used/s | runs/s | violationsPerSec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| grid | 1353.12 | 4565.78 | 129983.25 | 0.04 | 1079329.81 | 1443.63 | 0.2773 |
| grid-short | 3317.96 | 11187.01 | 318801.69 | 0.04 | 1201066.53 | 3537.08 | 0.6523 |
| grid-no-purgatory | 1604.27 | 6381.51 | 93820.92 | 0.04 | 1146752.19 | 1716.99 | 0.4021 |
| grid-post-fault-2 | 1558.03 | 4830.61 | 145201.99 | 0.04 | 939912.05 | 1624.37 | 0.1940 |
| aos | 1364.18 | 4787.55 | 136620.82 | 0.04 | 1038220.10 | 1441.83 | 0.1385 |

Spearman rho across arms: termination_completed 0.80, hazard_crossing 0.83, absorption_acted 0.27, timeline_novelty 0.62, steps_used 0.63, runs 0.87

## vr-depth6 (target, 40848 graded events over 3 seed(s))

| arm | termination_completed/s | hazard_crossing/s | absorption_acted/s | timeline_novelty/s | steps_used/s | runs/s | depth6PerSec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| grid | 119.37 | 625.48 | 146082.36 | 0.01 | 1900173.82 | 420.05 | 17.3805 |
| grid-short | 351.21 | 2088.26 | 186189.04 | 0.01 | 1804435.91 | 1404.00 | 56.2258 |
| grid-no-purgatory | 126.51 | 769.54 | 152196.91 | 0.01 | 1875075.77 | 432.82 | 10.6295 |
| grid-post-fault-2 | 126.67 | 533.45 | 132653.29 | 0.01 | 1909421.61 | 427.85 | 15.0730 |
| aos | 100.62 | 700.78 | 122791.79 | 0.01 | 1939847.67 | 408.15 | 13.8951 |

Spearman rho across arms: termination_completed 0.30, hazard_crossing 0.17, absorption_acted 0.40, timeline_novelty 0.33, steps_used -0.33, runs 0.30

## Admissibility

A reward kind is admissible when rho >= 0.7 on every gate member with at least 5 violations, rho >= 0 on every other member with at least 5 violations, and rho >= 0.7 on the evaluation spec's depth>=6 rate. A member with fewer events is not counted either way.

- termination_completed: not admissible (5 host(s) judged)
- hazard_crossing: not admissible (4 host(s) judged)
- absorption_acted: not admissible (5 host(s) judged)
- timeline_novelty: not admissible (5 host(s) judged)
- steps_used: not admissible (5 host(s) judged)
- runs: not admissible (5 host(s) judged)

(no reward kind admitted)
