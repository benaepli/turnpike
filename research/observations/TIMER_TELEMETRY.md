# Timer telemetry: where it is emitted, and why `steerAuthority` reads zero

Reporting only. Changes no gate.

## What the two readers of the counters actually see

There are two readers, and they see different things.

An evaluation record's `utilStats` is a fixed subset chosen by the harness:
`termination`, `deliveryEffects` and `steerAuthority`, each with an explicit
key list. No counter added to the simulator can appear there; the subset is
operator-owned.

The per-candidate utilization capture is the other reader, and it is the one
that answers "did the mechanism fire". Before every sequential evaluation the
loop runs a short capture over the same config with `stats` forced on and
journals the whole of `utilization.json` verbatim, also storing it under a
`util:<id>` key. Every field of the serialized snapshot reaches that reader.
A mechanism therefore has to put its counter in the snapshot, not chase the
evaluation record.

Two constraints on the shape of a counter that wants to survive both the
per-arm campaign attribution and the diff between two captures: the
differencing keeps integer leaves and drops floats, arrays and strings, so a
histogram has to be an object with named buckets rather than a list, and any
ratio has to be recomputed by the reader from its two integer leaves.

## `steer_authority` is correctly wired and reads zero for a reason

It is not stale. `schedule_runnable` builds the audit only when
`util_stats::steer_audit_enabled() && terms.any_predicate()`, and
`any_predicate()` is false whenever every weight in `steer_terms` is zero,
which is the current general config. `feedback.steer_audit` being true is
necessary but not sufficient.

The skip is already counted: on a 162-run capture over
`scheduler_configs/loop/general_vr.json`, `steer_empty_slice.queue_audit_skipped`
is 739,025 against `steer_authority.steps` 0. A zero `steerAuthority` block
alongside a large `queue_audit_skipped` means "no predicate carried weight",
never "the block is unwired". Reading it as evidence about the steer requires
a config with a non-zero `steer_terms` weight.

## Timer admission is now observable

`timer_steer` counts the scheduling steps at which admitting a timer was an
actual choice - a timer and a message delivery were both schedulable - and
which of the two the step ran. On the same capture:

| counter | value |
| --- | --- |
| `evaluated` | 327,765 |
| `raised` (a timer ran) | 9,682 |
| `lowered` (a delivery ran) | 318,083 |

So timers win 3.0% of contested steps. That is the denominator any
timer-admission mechanism needs, and it was not measured anywhere before: the
depth ladder does not observe timer-versus-delivery ordering at all.

## The inert-streak split is steeply monotone

`timer_effects.inert_streak` splits firings by how many firings at the same
resume point on the same node had changed nothing before this one. Same
capture:

| bucket | fired | acted | acted fraction |
| --- | --- | --- | --- |
| none | 17,348 | 10,254 | 0.591 |
| 1-2 | 11,669 | 3,719 | 0.319 |
| 3-7 | 10,977 | 2,001 | 0.182 |
| 8+ | 142,587 | 1,038 | 0.0073 |

A timer that has already fired inertly is strongly likely to fire inertly
again, and the drop across the four buckets is a factor of 81. The overall
9.3% acted fraction hides this: 78% of all firings sit in the 8-or-more
bucket, where a firing changes something once in 137 times. Timer firings are
not interchangeable, and scheduling steps spent on the long-streak bucket are
spent on firings that almost never change anything.
