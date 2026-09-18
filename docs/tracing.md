# Tracing and Telemetry

The Spur simulator includes tracing capabilities to inspect the internal state and execution flow of your protocol without relying purely on standard logs.

## The `@trace` Annotation

In Spur, you can tag any function with the `@trace` annotation to automatically capture execution telemetry.

```text
@trace
async func handle_request(req: Request) -> Response {
  // ...
}
```

## Trace Events

When a function is traced, the simulator engine automatically captures a sequence of structured events:

1. **`Dispatch`**: Recorded at the exact moment the simulator schedules the traced function to run.
2. **`Enter`**: Recorded when the execution of the traced function officially begins. This event records the function's incoming parameters.
3. **`Exit`**: Recorded when the traced function completes execution. This event captures the function's return value.

Timer firings are not trace events; they are `executions` rows of kind `TimerFired` (payload: the node and the timer's label), so they can be ordered against crashes, recoveries and client operations at the same step. Time advances and process pauses are recorded the same way, as rows of kind `ClockAdvance` (payload: the time before and after) and `Pause`/`Resume` (payload: the node, the pause id and the checkpoint ordinal).

## Replay Artifacts

With `record_replay` on, each run also writes `replay/run_N.json`: everything
a second process needs to take that execution again. See
[Simulator Options](simulator_options.md#record_replay) for what it holds and
[`spur replay`](simulator_options.md#replay) for how to use it. The artifact
is evidence in its own right: it names the program it was taken from, the
semantics version it was taken under, and the clock assumptions and workload
the run ran with, so a finding can say what it depended on. Artifact format 2
records idle scheduler attempts along with dispatches and time advances,
preserving subsequent step numbers. It also records the run's request-holding
and fault-selection settings, the actual node each crash targets, and the step
and pending operations of each early plan-dependency settlement. Replay uses
these recorded decisions without consulting live learned termination limits.

Named duration assignments are recorded in the `clock` JSON column of `runs`,
under `durations`: for example `{"durations":{"durations":{"election":8192,"heartbeat":2048}}}`.
These integers are an execution witness in internal units; divide one by another
to report the sampled ratios. The replay artifact's `clock.durations` carries
the same assignment. Replay installs it directly and validates it against the
recorded program's timing requirements, including the configured clock-rate
bounds.

## Clock Tables

A run whose program declares a `timing` block, reads a clock, or arms a timed
timer writes two more tables:

- **`run_clocks`**: one row per node, with the rate numerator and denominator, the origin and the clock epoch it was given. Client nodes are included.
- **`clock_observations`**: one row per clock read, in order, with the node, its incarnation and epoch, the read's site and occurrence, the global time, the kind (`mono` or `truetime`), the value or the interval's two endpoints, and whether the read was an `after` timer's internal sample rather than one the specification wrote.

A run whose program uses a clock also writes:

- **`timer_events`**: one row per timer registration, delivery and cancellation, with the timer's per-run id, its owner and incarnation, the kind (`registered`, `fired` or `cancelled`), the specification's label if it has one, the deadline in the owner's ticks, and the global time and step. An unlabeled timed timer is named by `timer_id` alone, so its evidence stands without one. A clockless program's timers are covered by the `TimerFired` execution rows and write no rows here.

Every `executions` row also carries `global_time`, the time at which it happened; it is zero throughout a run whose program reads no clock. Rows are ordered by `seq_num`, not by that column: several rows share a tick, and equal ticks never reorder a response before its invocation.

## Trace Payloads

Trace events capture rich contextual metadata beyond just function names:

- **Trace IDs**: Every invocation of a traced function receives a unique identifier.
- **Causal Operation IDs**: Traces are causally linked back to the original client invocation that triggered them, creating traceable request paths across the system.
- **Schedulable Counts**: Traces capture the exact `schedulable_count` of the simulator's runnable queue at the time of the event. This metric is incredibly useful for quantifying the "greediness" of the scheduler and identifying bottlenecks.
