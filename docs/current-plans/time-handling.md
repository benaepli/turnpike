# Spur Time Handling

## Named duration parameters

Implemented duration declarations remove numeric timeout choices from protocol
specifications:

```spur
timing durations {
    election;
    heartbeat;
    lease;
    margin;
    require heartbeat < election;
    require lease == election;
    require margin < lease;
    require (lease - margin) * rate_max < election * rate_min;
}
```

`durations().election` and the other record fields read one fixed per-run
assignment, shared across nodes and preserved through recovery. They can be
used in role initializers, synchronous helpers and async handlers, but not in
deploy evaluation. The accessor is not a process checkpoint. Module identity
and `pub` visibility follow ordinary record/function rules. These explicit
requirements define the domain to explore; none is inferred as a safety rule.
The lease panel uses them as control assumptions, not as a claim that a paper
states those exact conditions.

Requirements are homogeneous linear constraints with dimensionless integer
coefficients and the configured rational `rate_min`/`rate_max`. Nonzero
standalone duration constants and products of unknown durations are rejected.
Spur solves this parameter domain with exact rational elimination, samples a
feasible witness, and scales it into positive integer values without changing
ratios. Strict-boundary slack determines the minimum internal precision.
Contradictions, solver resource limits and unrepresentable sampled witnesses
are reported distinctly as run errors.

This is not symbolic execution of protocol time: clock reads, arithmetic and
schedules remain concrete, and neither ratios nor schedules are exhaustively
covered. Clock rounding and legacy numeric `tt_width`/`origin_spread` settings
still use internal units. A future symbolic backend can reuse the declarations;
a future uncertainty binding can express TrueTime width as a named duration.

Plans can advance `{"duration":"durations.election","numerator":1,"denominator":2}`
under `advance_time`, with fractions rounded up internally. Runs record their
assignment in `runs.clock.durations`, and exact replay artifacts reinstall it
without resampling. Replay identity covers timing requirements and validates
the supplied assignment. Artifact format 2 also records idle scheduler attempts
so subsequent execution step numbers remain exact.

The language reference and simulator semantics are the maintained API details:
[named durations](../../spur/design/language.md#named-durations),
[virtual time](../simulator_semantics.md#virtual-time).


## Goal and scope

Find time-dependent protocol bugs and underspecifications, especially lease
errors involving clock rates, delayed observations, and process recovery.
Executions must have a consistent timeline and enough recorded evidence to
explain which clock and execution assumptions a finding depends on.

This is a proposed implementation contract. The first version provides:

- Hidden global virtual time, advanced by the scheduler independently of
  execution steps.
- Per-node monotonic clocks with bounded rate error.
- A TrueTime-like service returning an interval of absolute time.
- Duration and deadline timers alongside durationless timers.
- Process checkpoints at clock reads and timed-timer registration in async
  function bodies, where a placed pause may interrupt the process.
- Exploration guided by deadline comparisons, with concrete replay.

The implementation is sequenced in
[Time Handling Implementation](time-handling-implementation.md).

Lease validity, commit waits, and recovery waits remain protocol code. The
simulator never supplies a missing safety check or automatically revokes
authority when a lease expires.

No refinement types are required. Values and comparisons use ordinary Spur
code. New configuration fields and compiler metadata land with their
consumers. Specs and scheduler configurations may be rewritten as needed.
Documents and code follow [the code style](../../research/STYLE.md).

## Current implementation

- `set_timer` takes an optional string label and returns `chan<()>`. It
  has no duration or clock deadline.
- `Label::SetTimer` and `Op::SetTimer` in
  `spur/spur-core/src/simulator/core/exec.rs` register timers. The same file
  contains the label-based and compiled-op interpreters.
- Synchronous helpers run to completion without saving resumable call
  frames. Channel waits and explicit task yields are separate operations.
- The scheduler selects local, network, and timer work. Some existing
  exploration delays are measured in execution steps.
- Porcupine assigns synthetic call and response times from event order in
  `porcupine/checker/checker.go`.

The language reference and simulator semantics must be updated with the
implementation. This document does not describe already available APIs.

## API

Square brackets below indicate an optional argument, not Spur syntax.
Labels remain optional string literals, as with `set_timer`.

| Operation | Result | Meaning |
| --- | --- | --- |
| `mono_now()` | `MonoInstant` | Sample this node's monotonic clock |
| `tt_now()` | `std::time::Interval` | Sample bounds on absolute time |
| `set_timer_after(duration [, label])` | `chan<()>` | Register a timer for a local duration |
| `set_timer_at(deadline [, label])` | `chan<()>` | Register a timer for a local monotonic deadline |
| `set_timer([label])` | `chan<()>` | Register a timer without a time constraint |

`std::time::Interval` is an ordinary record:

```spur
pub type Interval {
    earliest: Timestamp;
    latest: Timestamp;
};
```

`Duration`, `MonoInstant`, and `Timestamp` are distinct nominal built-in types.
The complete [time algebra](../../spur/design/language.md#time-values) defines
allowed operations, contextual zero, exact rational division, and collection
semantics. `set_timer_after` takes `Duration`; `set_timer_at` takes
`MonoInstant`; TrueTime predicates take `Timestamp`. There are no integer
conversions or cross-domain conversions. Use optional instants for unset state.

Arithmetic and stored values retain exact rational magnitudes. Monotonic
instants also retain the owner and clock epoch; direct cross-clock comparisons,
subtraction, and timer registration fail at runtime. Clock readings, sampled
TrueTime endpoints, global time, and scheduler deadlines still use an integral
signed 64-bit lattice internally. Fractional deadlines become eligible at their
ceiling. A negative duration is rejected before rounding; unrepresentable
timer bounds, clock results, and advances are errors.

Clock reads and timed-timer constructors require an executing node or
client. They are allowed in handlers, clients, `Init`, `RecoverInit`, and
helpers called from those contexts. They are forbidden in deployment
evaluation, declaration initializers, and contexts requiring pure
expressions. These restrictions also apply through helper calls.

## Global time and monotonic clocks

The simulator maintains a hidden, nondecreasing global time `T`, initially
zero. Protocol code cannot read it. The scheduler can execute an action or
advance `T` at a scheduling boundary. Multiple actions may share the same
`T`; advancing time does not execute intermediate ticks.

Time may advance while protocol work is runnable and while every process
is blocked or crashed. Runnable work does not prevent deadlines from
passing. An execution cannot be declared deadlocked merely because all
pending timed timers are not yet eligible.

Time advance is a separate scheduler action. It increases `T` by a
positive integer number of ticks and executes no protocol code. Timers
whose deadlines it passes become eligible; each fires only when selected
in a later scheduler action. An unmet timed timer stays queued but cannot
be selected for delivery.

Ordinary exploration offers time advance independently of timer queues
whenever the program uses clock reads or timed timers. This includes
reads inside synchronous helpers. A standalone advance can be selected
while work is runnable, or when all nodes are blocked, paused, or crashed.
The initial search samples positive increments, including one tick and
broader jumps, and offers the smallest advance reaching a pending timer
deadline. Comparison guidance adds target times to the same action.
Clock-only protocols and durationless polling waits therefore do not
depend on another node registering a timed timer to make time pass.

In `run-plan`, time advances only through explicit
`advance_time { ticks }` events; a timer permission never advances time.
Exact replay consumes the advances recorded for that execution. Programs
without clock operations need no automatic time advances, since they
cannot observe them. Exhausting the search budget or the representable
time range must not be reported as a protocol deadlock. An unfinished
plan blocked on an unmet deadline with no remaining advance is incomplete;
background timers do not prevent a completed workload from finishing.

The initial monotonic clock model is:

```text
M_i(T) = origin_i + rate_i * T
1 - rho <= rate_i <= 1 + rho
0 <= rho < 1
```

The rate and origin are selected per node and recorded. Rates are fixed
within an execution in the first version. Slow, normal, and fast rates
are useful search choices; they are samples, not complete coverage of the
allowed rates. `rho = 0` gives an exact-rate control configuration.

Clock arithmetic preserves fractional progress, using a deterministic
representation such as rational or fixed-point values. `mono_now()`
rounds down to integer ticks. Rate bounds apply before rounding; repeatedly
rounding each time advance must not discard accumulated progress. Internal
time and deadline arithmetic must not silently wrap on overflow.

Within one clock epoch:

- Readings never decrease, but consecutive readings may be equal.
- The clock advances during process pauses and process failures.
- Different nodes need not share an origin.
- A sent or persisted reading retains its value and clock identity. It does
  not become a timestamp in another node's clock domain.

Fixed offsets alone are insufficient for duration-based lease testing:
they cancel when subtracting two readings from the same clock. Bounded
rate error permits a slow holder to consider a lease valid after a fast
grantor considers it expired. The protocol must account for that
difference. Bounded rate error and bounded absolute error are distinct
assumptions; neither name substitutes for the other.

Existing step-based search delays remain search controls. They do not
silently acquire a duration in ticks or a physical network-delay bound.

## TrueTime-like service

For a `tt_now()` invocation at global time `T_read`, the returned record
satisfies:

```text
earliest <= T_read <= latest
```

The initial provider samples intervals directly under this contract. A
configured maximum uncertainty `U` means maximum full interval width:

```text
0 <= latest - earliest <= U
```

`U` is nonnegative and is measured in ticks. The width constraint applies
to the returned integer endpoints. If an implementation computes
fractional bounds, it rounds the lower endpoint down and the upper
endpoint up. A zero-width interval is an exact observation.

Actual time may lie anywhere inside the interval. The explorer should
sample both endpoints and interior positions, and different widths and
placements across nodes and observations. Always centering the interval
on global time would give a protocol an exact clock through its midpoint
and hide incorrect uses of that midpoint.

The initial contract promises neither endpoint monotonicity nor a
relationship between the midpoint and `mono_now()`. All intervals must
contain their own observation times on the same global timeline. The
provider is an abstraction of a time service; it does not derive its
observations from the monotonic-clock provider in this version.

An interval is an immutable observation. It does not advance while stored
in a variable, sent in a message, or persisted. It need not contain the
time when the caller resumes after a pause or uses the value.

The initial service always returns a valid, finite interval. Unavailability
and intervals that exclude actual time are not generated under this
contract. A later clock-service fault model must identify those events
explicitly, so a failure outside the time-service contract is not reported
as a protocol bug under valid clock assumptions.

## Process checkpoints and atomicity

A clock read or timed-timer registration written directly in the body of
an async function is a process checkpoint. A clock read proceeds as
follows:

1. Capture the reading at the current global time.
2. Save the result and the execution position after the read.
3. Consult the run's pause reservation. With no reservation for this
   checkpoint, execution continues within the same scheduling step; the
   checkpoint is not a scheduling boundary and costs no step.
4. With a reservation, the process pauses. When it resumes, it continues
   with the saved result.

A pause is an injected fault, placed by the explorer or named by a plan,
in the same sense as a crash. It freezes all protocol execution on the
node. Other nodes may run, global time and clocks may advance, and
incoming messages may queue. Timers may become eligible and deliver their
notifications, but no timer consumer or other handler on the paused node
executes. A crash can still occur and discard the paused frame. Resuming a
live process directly executes its interrupted task until its next
ordinary scheduling boundary, reserved checkpoint, or return, before any
other handler on that node executes. Queue priority cannot override this
order.

An explorer-placed pause offers an automatic resume action. A planned
pause waits for its matching explicit `resume` event and never offers an
automatic resume. Plan dependencies on `pause` are satisfied when the
checkpoint is actually interrupted. A plan can target a specified
checkpoint occurrence; omitting the occurrence selects the next one on
that node. Crashing the node cancels its pause and any pending resume, so
neither can apply to a recovered process incarnation. Canceled plan
events settle their dependencies with an explicit cancellation outcome.

An ordinary channel wait or task yield is different: it can allow another
task on the same node to execute. A process checkpoint does not release
the initialization barrier in `RecoverInit`.

Clock reads are allowed in synchronous helpers and remain effectful
there, but a read inside a synchronous helper is not a checkpoint: it is
atomic with its caller and offers no pause opportunity. The helper runs
to completion as it does today. A continuation belonging to a failed
process incarnation cannot resume after recovery.

Clock reads are effectful operations. Compiler passes must preserve their
evaluation order and number, including through helper calls. They must
not combine repeated reads, move a read across effects, or resample its
result when evaluating a later comparison. A single `tt_now()` captures
both endpoints together.

Code between process checkpoints and ordinary scheduling boundaries is
instantaneous. The first version does not model interruption between every
pair of statements. Findings and coverage claims must retain this
atomicity assumption.

For example, a successful lease check may become stale before its caller
acts. The simulator preserves the successful result across the pause and
lets the protocol take its subsequent action. It does not revalidate the
lease on the protocol's behalf.

## Timer semantics

`set_timer_after(d)` atomically samples the node's monotonic clock and
registers `deadline = mono_now_at_registration + d`. Its internal sample
does not introduce a pause between sampling and registration.

`set_timer_at(e)` registers `e` directly as a deadline in that same node's
monotonic clock domain. Both constructors save the returned channel and,
when written directly in an async body, are a process checkpoint after
registration.

A timed timer becomes eligible when the node's monotonic reading is at
least its deadline. This is a local-clock condition; a fast clock may
reach a duration sooner in global time than a slow one.

| Condition | Behavior |
| --- | --- |
| Negative duration | Runtime error |
| Zero duration | Immediately eligible |
| Deadline at or before the current monotonic reading | Immediately eligible |
| Deadline not yet reached | Ineligible for delivery regardless of scheduler priority; a separate time advance can make it eligible |
| Eligible timer | May be delivered later, with no maximum lateness guarantee |
| Timer delivery | Sends one `()` into its channel |
| Several receivers | Ordinary channel semantics; one notification, not broadcast |

Eligibility, delivery, and resumption of a waiting task are separate
events. A timer never forces a protocol operation to happen at an exact
time. A paused node cannot run a timer consumer. Process failure cancels
its timers as specified below.

`set_timer_at` preserves a previously computed deadline:

```spur
var deadline = mono_now() + durations().lease;
var timer = set_timer_at(deadline);
```

A pause after the read consumes some of the interval before registration.
In contrast, `set_timer_after(durations().lease)` starts its duration at registration.
Computing a remaining duration from an earlier clock read must not receive
an implicit correction for time spent paused before registration.

The existing `set_timer` remains durationless. It provides no elapsed-time
lower bound and retains its scheduling behavior. Labels identify timer
scheduling constraints; they do not change clock domains or validity.
Under a plan's `strict_timers`, a labeled timed timer needs both permission
and a reached deadline. `allow_timer` cannot make a timed timer fire early
and does not guarantee prompt delivery. Unlabeled timers retain their
existing treatment under `strict_timers`.

## Time predicates and waits

The standard library exports `std::time::tt_after(timestamp)` and
`std::time::tt_before(timestamp)`. Each performs exactly one fresh
`tt_now()` and evaluates:

```text
tt_after(t)  = interval.earliest > t
tt_before(t) = interval.latest < t
```

Both comparisons are strict. An endpoint equal to the timestamp does not
prove the corresponding predicate. A false result means the observation
does not establish the predicate; it does not establish its opposite.

Both helpers are synchronous functions, so a call to one is atomic with
its caller and is not a checkpoint. A spec that wants the pause
opportunity writes `tt_now()` in its own async body and compares the
endpoint itself. After a true `tt_after(t)`, any later global time is
still after `t`. After a true `tt_before(t)`, a pause at a later
checkpoint can carry execution past `t` before the caller acts.

A wait is ordinary async code in the spec. The standard library cannot
hold it, because a free function cannot be async:

```spur
async fn wait_after(timestamp: Timestamp) {
    for ;; {
        var interval = tt_now();
        if (interval.earliest > timestamp) {
            return;
        }
        <- set_timer("time_wait");
    }
}
```

The caller receives from the returned channel to await completion. The
timer schedules a recheck; it does not certify that a timestamp has
passed. Standalone scheduler advances let global time pass between these
durationless rechecks. An absolute TrueTime timestamp is not a monotonic
deadline for `set_timer_at`. A duration timer can schedule a recheck, but
a fresh observation must establish the absolute-time predicate.

Waiting for `tt_after(commit_timestamp)` is the timing part of a commit
wait. Replication, concurrency control, timestamp selection, and the point
at which data becomes visible remain the protocol's responsibility.

## Failure and recovery

The first version interprets existing `crash` and `recover` as process
failure and restart, not machine reboot.

- Volatile state and suspended execution frames are lost.
- Timers owned by the failed process are canceled, including eligible but
  undelivered timers. Buffered timer notifications and waiting tasks are
  volatile and are not resurrected by recovery.
- Recovery runs the existing variable initialization and `RecoverInit`
  sequence. New timers must be registered by recovered code.
- The monotonic clock continues in the same epoch, with its rate and
  origin unchanged.
- TrueTime observations continue to refer to the same absolute timeline
  and must satisfy the configured interval contract.
- Persisted time values retain their exact magnitudes, types, and clock
  identities. No recovery wait, deadline conversion, or lease grace period is
  inserted automatically.

This is sufficient to test a grantor that forgets an outstanding lease and
grants a conflicting one after process recovery.

Machine reboot is a separate, deferred fault. It starts a new monotonic
epoch while absolute time continues. A raw monotonic deadline from a
previous epoch is not automatically valid in the new one. Suspension that
stops a clock also needs a separate assumption: an ordinary process pause
does not stop the monotonic clock in this model.

## Exploration and replay

Semantics determine allowed executions. Heuristics determine which allowed
executions to try first. A heuristic must not make an ineligible timer
fire, change a captured clock reading, or violate an interval contract.

Prioritize time advances and observations around:

- Timed-timer deadlines.
- Monotonic comparisons with deadlines stored by the protocol.
- TrueTime endpoint comparisons with absolute timestamps.
- Clock reads followed by lease-dependent actions.
- Crash and recovery near lease grants and expirations.
- Opposing clock rates at a holder and grantor.

Explore representable values before, at, and after a relevant comparison
boundary, along with broader time advances. Explicit timers are only one
source of deadlines. Ordinary calculations such as
`expiry = mono_now() + duration`, including values stored or sent to another
handler, must be considered when designing comparison guidance.

Start by recognizing common calculations and comparisons. Unrecognized
arithmetic remains valid code and uses general time sampling; limited
recognition reduces coverage rather than changing semantics. If a useful
comparison is discovered after its observation has already been sampled,
guide a subsequent execution or an earlier scheduling choice. Do not
retroactively change that observation.

Integer resolution and the explored parameter values are part of a
finding's assumptions. Boundary sampling and extreme rates do not prove
exhaustive coverage. Finite exploration makes no liveness or fairness
claim, and a long commit wait is not itself a safety violation.

Plans expose concrete time-advance and process-pause controls. Exact
counterexample replay also needs the recorded dispatch choices, per-node
rates and origins, and interval observations. A dependency DAG alone
allows multiple schedules and is insufficient for exact replay. Final
artifact field names belong with their parser and executor implementation.
Existing timer permissions retain their meaning and cannot bypass time
constraints.

Record enough information to reconstruct each execution:

- Clock model, rate bounds, uncertainty-width bound, time resolution,
  failure interpretation, and checkpoint semantics.
- Selected per-node rates, origins, and clock epochs.
- Global times and event order for client calls, responses, and faults.
- Clock observations, including both endpoints of every `tt_now()`.
- Timer identity, owner, label, registration, deadline, and delivery.
- Process pause and resume events, and selected time advances.

Use run-level metadata for assumptions and per-event records for choices
that vary during an execution. Counterexample replay must reproduce the
observations and scheduling choices, not draw a new valid interval.
Structured evidence is retained independently of optional text logs. Each
clock observation identifies its node, process incarnation, clock epoch,
operation site, occurrence, global time, and returned value. Replay checks
those identities and the clock contract before returning the stored value.
Missing, extra, reordered, or invalid choices are replay errors; replay
must not fall back to random choices. A replay artifact identifies the
compiled program, deployment, resolved workload, and semantics version.

Where state hashing is used, global time, clock assumptions and assignments,
timer deadlines, and pause state including suspended frames belong to the
semantic state. Hashing must account for them. Observation-only counters
and text logs remain outside it. A hash is an index, not a proof of state
equality.

Porcupine keeps event-order timestamps. Record global time for reports but
do not use equal tick values to erase a response-before-invocation order.
Global time and event order must agree on the direction of time passage.

## Implementation sequence

The sequence, the files each step touches, and the reading each boundary
owes are in [Time Handling Implementation](time-handling-implementation.md).
In outline: the front end and the unwired operations land between
iterations; clocks, timed timers and time advance land at one boundary
with a throughput reading; the placed pause lands at a later boundary; the
search heuristics go through the research loop one at a time. Clock-only
acceptance specs and panel entries can follow the clocks boundary; those
requiring a pause follow the pause boundary.

## Acceptance and validation

The "Needs" column says which mechanism the scenario depends on: clocks
and time advances alone, or also the placed pause. The pause acceptance
case must demonstrate a stale observation affecting a later request. A
read that already captured its result and merely returns it late can be
explained by a delayed response; that case alone does not justify the
pause mechanism.

| Scenario | Needs | Required evidence |
| --- | --- | --- |
| Slow holder, fast grantor | clocks | Expose a missing lease margin under valid rate bounds; exercise a corrected control under the same choices |
| Grant forgotten after recovery | clocks | Expose a conflicting grant without resetting the process's monotonic clock |
| Delayed acknowledgment | clocks | Exercise a holder that incorrectly starts a fresh lease duration on receipt |
| Stale clock observation | pause | Pause after a valid check, advance other nodes past expiry, and resume with the saved value; the saved value must reach local state a later request reads |
| TrueTime bound misuse | clocks | Exercise use of the wrong endpoint or midpoint with valid asymmetric intervals |
| Commit wait | clocks | Exercise strict equality and both sides of `earliest > timestamp`, with protocol visibility checked separately |
| Clock-only wait | clocks | Advance time during durationless rechecks with no timed timer anywhere in the deployment |
| Late timer handling | clocks | Allow eligibility before delivery and delivery before consumer execution |
| Signed deadlines | clocks | Accept negative origins and past deadlines; reject constructor overflow without wrapping |
| Registration after a pause | pause | Distinguish a retained monotonic deadline from a duration started at registration |
| Synchronous helper | clocks | A clock read in a helper is atomic with its caller: no other local handler interleaves and no pause occurs inside it |
| Recovery initialization | pause | A process checkpoint alone must not admit buffered handlers |
| Failure of a paused process | pause | Discard its saved frames, timers, and notifications; prevent an old continuation from resuming |
| Pause delivery and ordering | pause | Deliver a timer notification during the pause; resume the interrupted frame before competing handlers under every queue policy |
| Consistent histories | clocks | Preserve client event order when several events share a global tick; replay the same observations |
| Replay mismatch | clocks | Reject missing, extra, or invalid observations and dispatch choices, including with text logging disabled |
| Semantic state identity | clocks and pause | Include time, rates, origins, deadlines, and suspended frames in state identity wherever hashing is used |

For protocol cases, include a faulty variant and a corrected control.
Exercise the chosen schedule on both; a passing control is not a proof of
correctness. Overlapping authority or a delayed response is not by itself
a linearizability violation. Drive relevant client operations and inspect
the history, or identify a separate protocol invariant being checked.

Classify findings as paper bugs, translation bugs, or ambiguities, using
the paper's stated clock, recovery, and atomicity assumptions. A failure
that faithfully follows incomplete pseudocode is not automatically a Spur
implementation bug. A failure requiring an excluded clock fault must be
reported with that dependency.

Behavioral validation uses release builds, covers both interpreter paths,
and includes deadline and interval boundaries. Measure simulator cost and
exploration effectiveness separately. Retain linearizability checking in
throughput measurements.

## Coordination with research loops

Clock state, timers, checkpoints, and exploration touch
`core/state.rs`, `core/exec.rs`, `core/scheduler.rs`, `path.rs`,
`explorer.rs`, and `history.rs`, which overlap the research loops.

- Front-end work and new files may land between iterations if they do not
  alter simulator execution.
- Simulator-core wiring lands only at an iteration boundary with loops
  stopped and the changes rebased on the latest merged state.
- Require release-build parity with the new search features off and the
  perf grader's throughput measurement.
- Time and pause heuristics intentionally change search. Evaluate them
  under the loop's non-inferiority protocol rather than a parity check.
- Remove temporary boundary-verification scaffolding when the boundary
  closes; retain the behavioral acceptance coverage.
- Changes in the `spur/` and `porcupine/` submodules land there before the
  superproject pointers move.

## Deferred extensions

- **Time-varying clock rates.** Preserve the rate bound across every
  interval rather than assigning one fixed rate per execution.
- **A synchronization-based interval provider.** If a synchronization
  establishes absolute time in `[a, b]` and the local clock subsequently
  advances by `d`, conservative bounds are
  `[a + d / (1 + rho), b + d / (1 - rho)]`. Round outward. Uncertainty grows
  between synchronizations and may shrink when new evidence arrives.
  Lost synchronization must not be modeled by silently narrowing bounds
  to satisfy a configured maximum width.
- **Machine reboot and stopped clocks.** Specify clock epochs and
  time-service recovery separately from process restart.
- **Time-service faults.** Distinguish unavailable observations from
  observations that falsely claim to bound actual time.
- **Other absolute-clock contracts.** Fixed offsets, changing bounded
  error, and wall-clock jumps require explicit assumptions.
- **Symbolic time.** Use the typed operations as the backend boundary. Keep
  constraints linear. Collection keys require semantic equality and alias
  handling, never hashes of symbolic expression syntax or silent concretization.
  Stored booleans must retain the predicates over their original observations.
  First pilot symbolic TrueTime endpoints against a concrete
  selected timeline, then measure symbolic event times and bounded variable
  drift. This is independent of the refinement checker. Solve constraints
  across observations and branches rather than selecting concrete values
  immediately. This is an alternative exploration strategy, not a prerequisite
  for the API.
- **Finer process interruption.** Add checkpoint locations only with a
  stated atomicity model and measured search and execution cost. This
  includes checkpoints inside synchronous helpers, which need both
  interpreters to save and resume nested call frames.
- **Bounded message delay as a stated assumption.** Many lease papers
  assume a delivery bound. A configured bound in ticks constrains time
  advance, not delivery: `T` may not pass a message's send tick plus the
  bound while that message is undelivered. Without it, every protocol that
  anchors a lease at the receiver falsifies immediately, and a finding
  cannot say whether it needed unbounded delay.

## References

- [Spanner: Google's Globally-Distributed Database, sections 3 and 4](https://storage.googleapis.com/gweb-research2023-media/pubtools/pdf/44915.pdf)
  specifies the interval contract and its use in commit waits.
- [Nerio: Leader Election and Edict Ordering, sections 3 through 5](https://arxiv.org/html/1109.5111)
  distinguishes bounded clock drift from bounded skew in lease protocols.
- [MODIST, section 3.4](https://www.usenix.org/legacy/events/nsdi09/tech/full_papers/yang/yang_html/)
  describes discovering implicit timers from comparisons and maintaining
  consistent clock observations during exploration.
