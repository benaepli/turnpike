# Integrated checking: local measurements

The off cases below explicitly disable checking to measure its cost. Normal
throughput benchmarks and research measurements keep checking enabled and
continue after violations through the configured sample.

These are short local measurements, not a throughput guarantee. Checking off
stayed within 1.1% of the pre-change binary on the sampled workloads. With the
same simulator worker count, enabling two checker workers reduced VR throughput
by 3.1% and the small RMW workload by 34.1%. The small workload makes per-history
conversion, hashing, queueing, and checking a larger part of total work.

## Method

Three trials per case, with case order rotated, on an AMD Ryzen 9 9950X running
Linux x86_64. All processes used CPU affinity `0-7` and wrote to `/tmp` on tmpfs.
Release builds used Rust 1.98.0. The pre-change Spur commit was
`09eb905aea88cffad07b69633b7d41ac071763b4`. Compilation was outside the timings.
Other services were not stopped, and these samples have no confidence interval.

The standard explorer used a two-second active budget, one million maximum
runs, `max_iterations=1500`, `feedback.mode=none`, `stats=true`, one key, zero
dependency density, and session seeds 17, 18, and 19. Timed exploration does
not produce identical corpora across cases. The workloads were:

| Workload | Spec and configuration |
| --- | --- |
| VR | `bin/spur/VR.spur`, `Main`, three nodes, three writes, six reads, two crashes, maximum two concurrent writes |
| RMW | `bin/spur/test_rmw.spur`, `Main`, one node, four writes, four reads, four RMWs, no faults, maximum two concurrent writes |
| Adversarial | `spur/spur-core/tests/fixtures/linearizability.spur`, client Read changed to return `[999999]`, one node, twelve writes, two reads, no faults or write concurrency cap |

Enabled checking used two workers, 256 queue slots, 16 MiB input admission
capacity, a 10 ms deadline, and `stop_on_violation=false`. The first comparison
used seven simulator workers for baseline/off and five simulator workers plus
two checker workers for defer/block. The existing history writers and the
checker result writer shared the same CPU affinity.

Runs/s uses `session.runs_completed / session.wall_ms`. Peak RSS comes from
`/usr/bin/time -f %M`. Checks/s includes only definitive checks and divides by
whole-process wall time, including finalization. All table entries are medians;
[machine-readable results](linearizability-performance.json) also include
writer blocking and queue high-water marks.

## Throughput and memory

| Workload | Pre-change runs/s | Off runs/s | Defer runs/s | Block runs/s | Peak RSS MiB: pre-change / off / defer / block |
| --- | ---: | ---: | ---: | ---: | --- |
| VR | 9,037 | 8,942 | 6,466 | 6,475 | 175.7 / 185.5 / 137.0 / 141.7 |
| RMW | 216,839 | 217,120 | 139,389 | 138,847 | 28.0 / 30.9 / 38.1 / 37.8 |
| Adversarial | 194,595 | 193,365 | 132,534 | 271 | 27.9 / 32.2 / 72.5 / 57.6 |

The first comparison reserves two simulator worker slots for checkers, even
when those checkers have little work. A second comparison kept seven simulator
workers in both cases, still within the same eight-CPU affinity:

| Workload | Off runs/s | Defer runs/s | Change | Peak RSS MiB: off / defer |
| --- | ---: | ---: | ---: | --- |
| VR | 8,830 | 8,558 | -3.1% | 189.9 / 180.1 |
| RMW | 215,033 | 141,744 | -34.1% | 31.5 / 40.7 |

All VR histories were checked. With seven simulator workers, the RMW defer
case left a median 21,994 histories for offline checking. These are process
measurements; hardware cache misses and memory bandwidth were not measured.

## Backpressure and completion

With five simulator workers, definitive checking throughput was about 5,500/s
for VR and 137,000/s for RMW, including process startup and finalization. RMW
defer left a median 264 histories unchecked; block checked every history.

The adversarial histories exhausted the deadline without a definitive result.
Defer completed about 265,000 simulations per session, checked 541 to unknown,
and left about 264,500 unchecked. Block admitted every history, completed 553
simulations, and returned unknown for all of them. Neither mode reported a
false violation or pass. The deliberately incorrect fixture is a checker
stress test, not a finding about a published protocol.

The adversarial queue reached 256 slots and about 1.9 MiB of reserved input
storage. Blocking accumulated about 10.1 seconds of producer wait across five
simulator workers during the two-second budget. Both policies took about 3.8
seconds including the final queue drain. A wall budget ends simulation
admission; it does not cut short normal checker draining.

History-writer blocking in the RMW cases was about 716 ms with checking off,
305 ms with defer, and 291 ms with block, summed across simulator workers.
The lower writer pressure accompanies lower simulation throughput.

For early termination, five runs of the incorrect fixture with two writes,
two reads, and `stop_on_violation=true` detected a violation in less than 1 ms
after checker-session initialization. Each stopped after saving 9-10 histories
out of a one-million-run limit and exited with status 2. Startup and compilation
are outside that detection clock.

## Offline agreement and reuse

The Go batch checker, built with Go 1.24.2, checked two retained corpora both
with normal reuse and with `-recheck-all -timeout 1000`:

| Corpus | Histories | Normal reuse | Forced Go checking | Disagreements |
| --- | ---: | ---: | ---: | ---: |
| VR | 12,856 | 64 ms | 904 ms | 0 |
| RMW | 277,694 | 481 ms | 40,017 ms | 0 |

All histories in these two corpora passed. The totals, skipped operations,
violating IDs, and unknown IDs agreed. These are single offline timings and
may include contention from other checks.

Additional fixture comparisons covered 90 histories, including 42 deliberate
violations, across explorer modes and the plan runner. The human Go command
generated no HTML for eight cached passes, generated all eight reports with
`-recheck-all`, and generated reports for explicitly selected passing and
violating runs.
