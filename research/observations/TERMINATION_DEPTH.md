# Prefix depth by end reason

Measured 2026-08-28 on the 16-core host with the epoch-7 binary. Two corpora:
one 300 s general-config campaign chunk of `bin/spur/VR.spur` (229,980 runs,
five arms) and the plan corpus regenerated from
`research/oracle/tiers/find_bug_plan.json` (3,000 runs, 11 violations). Each
run's end reason and step count come from the `runs` table, its prefix depth
from the grader, its verdict from the checker; the tables below are the
join.

## What the join says

**Depth concentrates in the runs that complete.** On the general chunk a run
that completed its plan reaches depth>=6 at 0.094 against 0.016 for a run
that exhausted its step budget (ratio 5.8, z 87), depth>=7 at 0.022 against
0.0028 (7.8x), depth>=8 at 0.0036 against 0.0004 (8.5x), and every one of the
five arms shows the same shape. The deep runs are also the short ones:
median steps_used is about 1,100 for depth>=6 against 6,000, the whole
budget, for an exhausted run.

**The violating runs all complete.** In the plan corpus 103 of 3,000 runs
complete, all 103 reach depth 9, and all 11 violations are among them
(11/11 against a 3.4% completion base rate, z 16.7). A completed run there
finishes in about 100 steps; the other 2,897 burn the full 10,000. About 97%
of that corpus's step budget went to runs that never progressed.

**Decision rule.** Termination-steering hypotheses were to be seeded only
if P(depth>=7 | plan_complete) separates from P(depth>=7 |
iterations_exhausted) at z 2.7 on the general chunk and the violating plan
runs complete at a rate above their corpus's. Both hold, by a wide margin.
Termination is a lever, and the campaign's `termination_completed` reward
has depth support it did not have before this measurement.

**One caveat on the general chunk.** The oracle chain needs the plan's later
client operations to have been invoked, and a run that exhausts its budget
may simply never have issued them, so part of the completion enrichment is
mechanical: operations never issued cannot match. The plan corpus is not
subject to that reading, because plan mode issues a fixed schedule, and its
result is the sharper one.

**The cheaper reading is budget, not steering.** Deep and violating runs
finish early; exhausted runs are five to a hundred times longer and yield
almost nothing. A run that has stopped changing state is spending steps
that a fresh run would turn into events. Reallocating budget away from
stalled runs is a mechanism that needs no knowledge of what a timer is for,
and it is the first of the two hypotheses seeded from this report.

**What is not yet known** is why the exhausted runs stall. The timer
effectiveness instrumentation (per-run firings split by whether the node
had a delivery in flight, keyed by resume vertex, incarnation and inert
streak) is what will say whether they are dominated by inert timer firings
on idle nodes, which is the storm signature, or by something else. Until
that join exists, a steer that lowers timer admission is a hypothesis with a
mechanism argument and no measurement, and it is seeded as such.

## Seeded hypotheses

- `stall-abort-progress-termination`: end a run whose nodes have not changed
  state for longer than any completed run in the session went without a
  change, and spend the budget on a new run. Counts `termination.stall_aborts`
  and `termination.steps_reclaimed`.
- `timer-effect-steer`: lower the priority of admitting another timer at a
  node whose recent firings on an idle node changed nothing, against the
  session's own distribution per resume vertex; never lower a firing with a
  delivery in flight. Counts `timer_steer.{evaluated, lowered, raised}`.
  Gated on the timer effectiveness join above.

<!-- generated below -->

Generated 2026-08-28T18:38:58.645Z by `research/observations/termination_depth.mjs`.

## vr: `tmp/loop/term-vr` graded against `research/oracle/relax_minimal_general.json`

229980 runs, 229980 graded, 0 violations (checker saw 229980 runs).

### pooled: 229980 runs (iterations_exhausted 167087, plan_complete 62780, deadlock 113)

| end_reason | n | P(depth>=4) | P(depth>=5) | P(depth>=6) | P(depth>=7) | P(depth>=8) | P(depth>=9) | violations |
|---|---|---|---|---|---|---|---|---|
| iterations_exhausted | 167087 | 0.3857 [0.3833, 0.3880] (64438) | 0.1018 [0.1003, 0.1032] (17005) | 0.0163 [0.0157, 0.0169] (2726) | 0.0028 [0.0025, 0.0030] (465) | 0.0004 [0.0003, 0.0005] (71) | 0.0000 [0.0000, 0.0000] (1) | 0 |
| plan_complete | 62780 | 0.6727 [0.6690, 0.6764] (42234) | 0.3112 [0.3076, 0.3148] (19536) | 0.0942 [0.0919, 0.0965] (5911) | 0.0217 [0.0206, 0.0229] (1364) | 0.0036 [0.0032, 0.0041] (226) | 0.0001 [0.0000, 0.0002] (4) | 0 |
| deadlock | 113 | 0.0177 [0.0049, 0.0622] (2) | 0.0000 [0.0000, 0.0329] (0) | 0.0000 [0.0000, 0.0329] (0) | 0.0000 [0.0000, 0.0329] (0) | 0.0000 [0.0000, 0.0329] (0) | 0.0000 [0.0000, 0.0329] (0) | 0 |

Completed against budget-exhausted: depth>=5: z 122.3, ratio 3.06; depth>=6: z 87.4, ratio 5.77; depth>=7: z 45.5, ratio 7.81; depth>=8: z 18.9, ratio 8.47; depth>=9: z 2.6, ratio 10.65.

steps_used quartiles (25/50/75): all 1315/1500/6000; depth>=6 635/1122/1500; depth>=7 718/1126/1500; depth>=8 719/1126/1500; depth>=9 430/901/1233.

### arm aos: 30900 runs (iterations_exhausted 21916, plan_complete 8972, deadlock 12)

| end_reason | n | P(depth>=4) | P(depth>=5) | P(depth>=6) | P(depth>=7) | P(depth>=8) | P(depth>=9) | violations |
|---|---|---|---|---|---|---|---|---|
| iterations_exhausted | 21916 | 0.3623 [0.3560, 0.3687] (7941) | 0.0925 [0.0888, 0.0964] (2028) | 0.0155 [0.0140, 0.0172] (340) | 0.0022 [0.0017, 0.0030] (49) | 0.0002 [0.0001, 0.0005] (5) | 0.0000 [0.0000, 0.0002] (0) | 0 |
| plan_complete | 8972 | 0.6761 [0.6663, 0.6857] (6066) | 0.3048 [0.2954, 0.3144] (2735) | 0.0927 [0.0869, 0.0989] (832) | 0.0189 [0.0163, 0.0220] (170) | 0.0040 [0.0029, 0.0055] (36) | 0.0000 [-0.0000, 0.0004] (0) | 0 |
| deadlock | 12 | 0.1667 [0.0470, 0.4480] (2) | 0.0000 [0.0000, 0.2425] (0) | 0.0000 [0.0000, 0.2425] (0) | 0.0000 [0.0000, 0.2425] (0) | 0.0000 [0.0000, 0.2425] (0) | 0.0000 [0.0000, 0.2425] (0) | 0 |

Completed against budget-exhausted: depth>=5: z 46.9, ratio 3.29; depth>=6: z 32.2, ratio 5.98; depth>=7: z 15.9, ratio 8.47; depth>=8: z 8.3, ratio 17.59; depth>=9: z 0.0, ratio -.

steps_used quartiles (25/50/75): all 1314/6000/6000; depth>=6 690/1308/6000; depth>=7 737/1323/3360; depth>=8 713/1544/2303.

### arm grid: 31020 runs (iterations_exhausted 22238, plan_complete 8770, deadlock 12)

| end_reason | n | P(depth>=4) | P(depth>=5) | P(depth>=6) | P(depth>=7) | P(depth>=8) | P(depth>=9) | violations |
|---|---|---|---|---|---|---|---|---|
| iterations_exhausted | 22238 | 0.3923 [0.3859, 0.3987] (8723) | 0.1013 [0.0974, 0.1053] (2252) | 0.0148 [0.0133, 0.0165] (330) | 0.0022 [0.0017, 0.0029] (49) | 0.0002 [0.0001, 0.0005] (4) | 0.0000 [-0.0000, 0.0002] (0) | 0 |
| plan_complete | 8770 | 0.6929 [0.6832, 0.7025] (6077) | 0.3345 [0.3247, 0.3445] (2934) | 0.1032 [0.0970, 0.1097] (905) | 0.0238 [0.0208, 0.0272] (209) | 0.0041 [0.0030, 0.0057] (36) | 0.0001 [0.0000, 0.0006] (1) | 0 |
| deadlock | 12 | 0.0000 [0.0000, 0.2425] (0) | 0.0000 [0.0000, 0.2425] (0) | 0.0000 [0.0000, 0.2425] (0) | 0.0000 [0.0000, 0.2425] (0) | 0.0000 [0.0000, 0.2425] (0) | 0.0000 [0.0000, 0.2425] (0) | 0 |

Completed against budget-exhausted: depth>=5: z 49.6, ratio 3.30; depth>=6: z 35.8, ratio 6.95; depth>=7: z 18.9, ratio 10.82; depth>=8: z 8.7, ratio 22.82; depth>=9: z 1.6, ratio -.

steps_used quartiles (25/50/75): all 1484/6000/6000; depth>=6 720/1221/6000; depth>=7 778/1162/2329; depth>=8 901/1256/1870.

### arm grid-no-purgatory: 31560 runs (iterations_exhausted 22369, plan_complete 9172, deadlock 19)

| end_reason | n | P(depth>=4) | P(depth>=5) | P(depth>=6) | P(depth>=7) | P(depth>=8) | P(depth>=9) | violations |
|---|---|---|---|---|---|---|---|---|
| iterations_exhausted | 22369 | 0.3659 [0.3596, 0.3722] (8184) | 0.0832 [0.0796, 0.0868] (1860) | 0.0076 [0.0065, 0.0088] (170) | 0.0007 [0.0004, 0.0012] (16) | 0.0000 [0.0000, 0.0003] (1) | 0.0000 [0.0000, 0.0002] (0) | 0 |
| plan_complete | 9172 | 0.5949 [0.5848, 0.6049] (5456) | 0.2480 [0.2393, 0.2570] (2275) | 0.0661 [0.0612, 0.0713] (606) | 0.0120 [0.0100, 0.0144] (110) | 0.0022 [0.0014, 0.0034] (20) | 0.0002 [0.0001, 0.0008] (2) | 0 |
| deadlock | 19 | 0.0000 [0.0000, 0.1682] (0) | 0.0000 [0.0000, 0.1682] (0) | 0.0000 [0.0000, 0.1682] (0) | 0.0000 [0.0000, 0.1682] (0) | 0.0000 [0.0000, 0.1682] (0) | 0.0000 [0.0000, 0.1682] (0) | 0 |

Completed against budget-exhausted: depth>=5: z 39.4, ratio 2.98; depth>=6: z 30.4, ratio 8.69; depth>=7: z 14.4, ratio 16.77; depth>=8: z 6.7, ratio 48.78; depth>=9: z 2.2, ratio -.

steps_used quartiles (25/50/75): all 465/6000/6000; depth>=6 248/343/680; depth>=7 270/357/495; depth>=8 289/357/430.

### arm grid-post-fault-2: 31860 runs (iterations_exhausted 22251, plan_complete 9601, deadlock 8)

| end_reason | n | P(depth>=4) | P(depth>=5) | P(depth>=6) | P(depth>=7) | P(depth>=8) | P(depth>=9) | violations |
|---|---|---|---|---|---|---|---|---|
| iterations_exhausted | 22251 | 0.3477 [0.3414, 0.3540] (7736) | 0.0837 [0.0802, 0.0874] (1863) | 0.0107 [0.0094, 0.0121] (237) | 0.0011 [0.0007, 0.0016] (24) | 0.0002 [0.0001, 0.0005] (4) | 0.0000 [0.0000, 0.0002] (0) | 0 |
| plan_complete | 9601 | 0.6716 [0.6621, 0.6809] (6448) | 0.3232 [0.3139, 0.3326] (3103) | 0.0980 [0.0922, 0.1041] (941) | 0.0250 [0.0221, 0.0283] (240) | 0.0042 [0.0031, 0.0057] (40) | 0.0000 [0.0000, 0.0004] (0) | 0 |
| deadlock | 8 | 0.0000 [0.0000, 0.3244] (0) | 0.0000 [0.0000, 0.3244] (0) | 0.0000 [0.0000, 0.3244] (0) | 0.0000 [0.0000, 0.3244] (0) | 0.0000 [0.0000, 0.3244] (0) | 0.0000 [0.0000, 0.3244] (0) | 0 |

Completed against budget-exhausted: depth>=5: z 54.1, ratio 3.86; depth>=6: z 37.9, ratio 9.20; depth>=7: z 21.6, ratio 23.18; depth>=8: z 8.8, ratio 23.18; depth>=9: z 0.0, ratio -.

steps_used quartiles (25/50/75): all 1279/6000/6000; depth>=6 728/1140/2481; depth>=7 779/1133/1935; depth>=8 780/1057/1509.

### arm grid-short: 104640 runs (iterations_exhausted 78313, plan_complete 26265, deadlock 62)

| end_reason | n | P(depth>=4) | P(depth>=5) | P(depth>=6) | P(depth>=7) | P(depth>=8) | P(depth>=9) | violations |
|---|---|---|---|---|---|---|---|---|
| iterations_exhausted | 78313 | 0.4068 [0.4033, 0.4102] (31854) | 0.1149 [0.1127, 0.1172] (9002) | 0.0211 [0.0201, 0.0221] (1649) | 0.0042 [0.0037, 0.0047] (327) | 0.0007 [0.0006, 0.0009] (57) | 0.0000 [0.0000, 0.0001] (1) | 0 |
| plan_complete | 26265 | 0.6924 [0.6868, 0.6980] (18187) | 0.3232 [0.3176, 0.3289] (8489) | 0.1000 [0.0964, 0.1037] (2627) | 0.0242 [0.0224, 0.0261] (635) | 0.0036 [0.0029, 0.0044] (94) | 0.0000 [0.0000, 0.0002] (1) | 0 |
| deadlock | 62 | 0.0000 [-0.0000, 0.0583] (0) | 0.0000 [-0.0000, 0.0583] (0) | 0.0000 [-0.0000, 0.0583] (0) | 0.0000 [-0.0000, 0.0583] (0) | 0.0000 [-0.0000, 0.0583] (0) | 0.0000 [-0.0000, 0.0583] (0) | 0 |

Completed against budget-exhausted: depth>=5: z 78.3, ratio 2.81; depth>=6: z 55.9, ratio 4.75; depth>=7: z 29.4, ratio 5.79; depth>=8: z 10.5, ratio 4.92; depth>=9: z 0.8, ratio 2.98.

steps_used quartiles (25/50/75): all 1466/1500/1500; depth>=6 707/1170/1500; depth>=7 766/1147/1500; depth>=8 768/1176/1500.

## plan: `tmp/loop/term-plan` graded against `research/oracle/relax_minimal.json`

3000 runs, 3000 graded, 11 violations (checker saw 3000 runs).

### pooled: 3000 runs (iterations_exhausted 2897, plan_complete 103)

| end_reason | n | P(depth>=4) | P(depth>=5) | P(depth>=6) | P(depth>=7) | P(depth>=8) | P(depth>=9) | violations |
|---|---|---|---|---|---|---|---|---|
| iterations_exhausted | 2897 | 1.0000 [0.9987, 1.0000] (2897) | 0.2237 [0.2089, 0.2392] (648) | 0.2237 [0.2089, 0.2392] (648) | 0.2237 [0.2089, 0.2392] (648) | 0.0145 [0.0107, 0.0195] (42) | 0.0000 [-0.0000, 0.0013] (0) | 0 |
| plan_complete | 103 | 1.0000 [0.9640, 1.0000] (103) | 1.0000 [0.9640, 1.0000] (103) | 1.0000 [0.9640, 1.0000] (103) | 1.0000 [0.9640, 1.0000] (103) | 1.0000 [0.9640, 1.0000] (103) | 1.0000 [0.9640, 1.0000] (103) | 11 |

Completed against budget-exhausted: depth>=5: z 17.9, ratio 4.47; depth>=6: z 17.9, ratio 4.47; depth>=7: z 17.9, ratio 4.47; depth>=8: z 45.8, ratio 68.98; depth>=9: z 54.8, ratio -.

steps_used quartiles (25/50/75): all 10000/10000/10000; depth>=6 10000/10000/10000; depth>=7 10000/10000/10000; depth>=8 97/101/10000; depth>=9 95/99/102.

Violating runs: 11; completed 11/11 against 0.034 of all runs (z 16.7); depths 9:11; steps_used quartiles 92/99/100.

