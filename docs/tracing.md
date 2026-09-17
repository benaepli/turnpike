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

## Clock Tables

A run whose program reads a clock or arms a timed timer writes two more tables:

- **`run_clocks`**: one row per node, with the rate numerator and denominator, the origin and the clock epoch it was given. Client nodes are included.
- **`clock_observations`**: one row per clock read, in order, with the node, its incarnation and epoch, the read's site and occurrence, the global time, the kind (`mono` or `truetime`), the value or the interval's two endpoints, and whether the read was an `after` timer's internal sample rather than one the specification wrote.

Every `executions` row also carries `global_time`, the time at which it happened; it is zero throughout a run whose program reads no clock. Rows are ordered by `seq_num`, not by that column: several rows share a tick, and equal ticks never reorder a response before its invocation.

## Trace Payloads

Trace events capture rich contextual metadata beyond just function names:

- **Trace IDs**: Every invocation of a traced function receives a unique identifier.
- **Causal Operation IDs**: Traces are causally linked back to the original client invocation that triggered them, creating traceable request paths across the system.
- **Schedulable Counts**: Traces capture the exact `schedulable_count` of the simulator's runnable queue at the time of the event. This metric is incredibly useful for quantifying the "greediness" of the scheduler and identifying bottlenecks.
