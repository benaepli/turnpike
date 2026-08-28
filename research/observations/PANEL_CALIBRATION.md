# Panel calibration

Measured 2026-08-27/28 on the 16-thread host at `rayonThreads: 14`, against
the merged binary and the live evaluation template with each member's workload
overlaid. Every rate here is measured; none is assumed. Rerun on a host with a
different thread count: the explorer shares one feedback map across the
parallel run set, so the count changes what is explored.

## Admitted members

| id | class | role | rate | runs/arm | control | separation | dispersion | budget ratio | runs/s |
|---|---|---|---|---|---|---|---|---|---|
| `paxos-accept-stale-ballot` | F0 | gate | 0.01693 | 5,928 | 2/20,736 | 176x | 0.559 | 0.948 | 1,037 |
| `mencius-opt1-2` | F0 | gate | 0.00773 | 12,960 | 3/25,680 | 66x | 0.348 | 1.125 | 153 |
| `raft-stale-vote` | F2 | report | 0.00015 | 20,016 | 0/20,016 | - | - | - | 294 |
| `paxos-forget-promise` | F2 | report | 0.00015 | 19,992 | 0/19,992 | - | - | - | 1,428 |
| `raft-forget-vote` | F2 | report | <5e-5 | 20,016 | 0/20,016 | - | - | - | 313 |
| `raft-commit-prev-term` | F3 | report | <5e-5 | 20,016 | 0/20,016 | - | - | - | 294 |

Panel wall per validation: **395 s**. Gate members run paired arms; report
members run one arm, because their rate is far below what their run count
resolves and a second arm would buy no comparison.

## Two rules the measurements forced

**C1 is a separation rule, not a cleanliness rule.** The plan required a
control with zero violations. No host satisfies it. `Paxos.spur` violates 2
times in 20,736 runs, `Raft.spur` counts a reply from a superseded term at
both reply handlers, and Mencius has no clean variant at all - only a partial
repair. The rule is now `rate >= 20 x control rate`. At 20x the control
contributes 5% of the member's count, so a true 50% collapse is measured as
47.5%, well inside the gate's resolution. Both gate members clear it: 176x and
66x.

**A host has a detection ceiling, and it is measured with a positive
control.** A blatant injection of the same class bounds every subtler member
on that host. On Raft, granting every vote request unconditionally - guaranteed
split brain - detects at only **0.0021**, so no Raft member can reach the rate
a gate needs, and no workload tuning changes that: tuning alters how often a
bug is reached, the ceiling is whether reaching it is seen. Raft's client
retries and redirects until some leader answers, and most divergence never
becomes an observable history.

The ceiling probe has a failure mode worth recording. The Paxos probe - answer
reads from local state with no consensus - detected **0 times in 5,184 runs**,
below the member it was meant to bound. A probe is only a ceiling if it
actually exceeds the members. Paxos's `hostCeiling` is therefore recorded as
0.0251, the strongest rate any injection reached on it, and is a lower bound
rather than a measurement.

## Recalibration on the 16-core host (rayonThreads 30)

Measured 2026-08-28 against the merged binary with the parquet writer
parallelized, using the run counts of the first calibration. Rates reproduced
the 14-thread values within sampling noise on three independent passes; what
moved is throughput, and with it the arm sizing the wall check permits.

| id | class | role | rate | runs/arm | control | separation | dispersion | runs/s |
|---|---|---|---|---|---|---|---|---|
| `paxos-accept-stale-ballot` | F0 | gate | 0.01664 | 6,024 | 1/20,736 | 345x | 1.308 | 2,406 |
| `mencius-opt1-2` | F0 | gate | 0.00742 | 13,488 | 0/25,680 | inf | 0.052 | 536 |
| `raft-stale-vote` | F2 | report | 0.00030 | 20,016 | 0/20,016 | inf | - | 951 |
| `raft-commit-prev-term` | F3 | report | <5e-5 | 20,016 | 0/20,016 | inf | - | 967 |
| `raft-forget-vote` | F2 | report | <5e-5 | 20,016 | 0/20,016 | inf | - | 964 |
| `paxos-forget-promise` | F2 | report | 0.00020 | 19,992 | 3/19,992 | 1x | - | 3,492 |

Two of the previous entries need reading differently. The host ceilings
were not re-measured: the probe specs were not kept, so `hostCeiling` stays
the strongest injection observed on the 14-thread host. And
`paxos-forget-promise` detected 4 times against 3 on its own control (7
against 3 on the pass before), so its reports are hard to tell from
`Paxos.spur`'s background rate at this count.

The writer was the ceiling before this pass. One thread encoded parquet for
30 simulation threads and sat at 88% of a core on the VR general config
while every simulation thread waited on it half the time; the Raft members,
at about 1 MB of rows per run, queued faster than it drained and were
OOM-killed at 20 GB. Bounding the queue fixed the memory, and one writer per
eight simulation threads lifted the ceiling.

## What calibration rejected

Four fault-path injections were built and all four came in around 1e-4:
`raft_stale_vote` (3/20,016), `paxos_forget_promise` (3/19,992),
`raft_forget_vote` (0/20,016), `raft_commit_prev_term` (0/20,016). The fault
machinery was not the constraint - at `num_crashes 2..4` the same corpus
records 60,048 crashes, 60,048 recovers and 58,835 client operations issued
after the last recover.

`craq-read-uncommitted` was dropped before measurement: `bin/spur/CRAQ.spur`
calls `@rpc_call` at five sites and does not compile. It is the only spec in
the repo that does not.

`mencius-p-liveness` was dropped by its own ablation: outstanding client
operations rose only 1.23x with a crash against a 5x bar, because 10.7% of
client operations go unanswered on that spec with no crashes at all.

## The gap this leaves

**Both gate members are fault-free.** Every fault-path member reports and none
can gate. The panel can therefore detect that a candidate eroded detection on
concurrency-only bugs, and cannot detect that it eroded detection on
crash-path bugs - which is the transfer question the panel was built to answer,
and the direction the VR objective actually cares about.

Closing it needs a host whose ceiling is high **and** whose crash-path defects
are observable through a KV client interface. Paxos has the ceiling and its
crash-path injection still came in at 1e-4; Raft has the crash-path behaviour
and a ceiling ten times too low. The untried hosts are EPaxosStar, Gryff,
SDPaxos, Raft_rtc and the Mencius opt-1-2-3 pair, and the cheapest next step
is a C0 ceiling probe on each - one 20,000-run arm apiece - before any
injection is written for them.

Until then the panel is honest about its reach: it gates on fault-free
transfer, and it records fault-path detections as rare events.
