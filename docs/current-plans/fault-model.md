# Spur Fault Model

## Summary

Extend Spur's fault model beyond crash, recovery, partitions and message
delay. Three parts, in order: (1) clocks and leases designed together with
crash and restart semantics, (2) named, independently atomic persistence
keys, (3) disk durability, deferred until implementations are translated.
Message loss is deliberately not modeled.

## Scope and invariants

- High level only. Grammar and full semantics belong in per-part design
  documents.
- No backwards compatibility: every spec under `bin/spur/` and every JSON
  under `scheduler_configs/` may be rewritten.
- No refinement types. Validity is plain code.
- A tag or config knob is added only together with the heuristic or tool that
  consumes it.
- Per-step simulator cost is measured for every change; clock reads as yield
  points are the main expected cost.
- Simulator-core changes land only at research-loop iteration boundaries,
  are verified with release builds only, and their verification scaffolding
  is removed when the boundary closes.
- Documents and code follow `research/STYLE.md`.

## Clocks and leases, with crash and restart semantics (priority)

**Goal.** Find time-dependent bugs, above all lease bugs across restarts.

**Settled decisions.**

- Global monotone real time that the scheduler may advance arbitrarily
  between events. Per-node local clock with bounded skew; offsets chosen
  adversarially, mostly at -max, 0, +max. `now()` and duration timers use
  local time; duration-less timers remain.
- Safety needs bounded clock error, not bounded message delay. Process
  pauses come from real time advancing between yields. Clock reads should
  probably be yield points, because sync code is atomic.
- The clock assumption (skew or drift) is a config choice recorded with each
  counterexample, so a finding states which assumption breaks the protocol.
- Restart: a monotonic clock resets; a wall clock continues and may jump.
  Target class: a node grants a lease or lease-bound vote, restarts without
  the expiry, and grants a conflicting one (papers often omit "wait out the
  maximum lease after restart").
- Explorer heuristics aim expiries and crashes at lease boundaries; that
  decides whether time finds anything.
- Client call and return times are consistent with global real time.
- Independent of the topology and module work.

**Current code.** `set_timer` takes only an optional label (label path
`core/exec.rs:358`, compiled-op path `:1034`); no clock builtin. Porcupine
assigns synthetic call and return times from event order
(`porcupine/checker/checker.go:147, 259`).

**Work items.** Real time and offsets in `State`; `now()` and duration
timers in both interpreter paths; clock reads as yield points with measured
cost; restart rules in recovery; boundary-aimed crash and time-jump
heuristics; clock assumption and offsets in the runs table; one lease-based
spec with a known restart hazard as the acceptance target. Labeled timers
and plan `strict_timers` keep working.

**Risks.** Without boundary-aimed heuristics random time rarely lands in the
vulnerable window, and time looks useless when it is not. Yielding clock
reads add interleavings and cost throughput. Duration timers touch timer
scheduling in perf-loop files.

**Open questions.**

- Unit of time. Recommendation: abstract integer ticks.
- Skew or drift first. Recommendation: fixed per-node skew per run; drift
  when a finding needs it.
- Clock reads as yield points. Recommendation: yes by default, cost measured.
- Checker ordering. Real time only moves forward between events, so
  Porcupine's event-order timestamps already agree with it. Recommendation:
  record real time on calls and returns for reports; keep event order in the
  checker.

## Named persistence keys

**Goal.** Make a crash between two persists expressible, since papers say
"persist X and Y" without saying atomically.

**Settled decision.** Named, independently atomic keys instead of one slot.

**Current code.** One slot per node: `State.persisted_data` keyed by
`NodeId.index` (`core/state.rs:691`), used in both interpreter paths
(`core/exec.rs:407-427, 1072-1096`).

**Work items.** Key argument on `persist_data`, `retrieve_data`,
`discard_data`; storage keyed by node and key; a heuristic placing crashes
between consecutive writes to different keys; convert Raft and VR so each
durable variable the paper names has its own key.

**Risk.** Specs that keep persisting one struct find nothing new.

**Open question.** String keys or declared names? Recommendation: declared
names checked by the compiler, so a typo cannot create a new slot.

## Disk durability (deferred)

Write versus sync, crash keeps the synced prefix, torn final records.
Relevant to implementations, of little value for papers, and a larger
change. Starts once an implementation translation pilot begins and is
scoped by what it needs.

## Not modeled: message loss

- For safety, a lost message is equivalent to one delayed past the
  violation, and the simulator already delays through purgatory, partition
  buffering and buffering to crashed nodes.
- Loss matters only for liveness, and retransmission is a solved problem.
- Duplicates come from application retries that specs already write.
- Redelivery after receiver crash is a superset of TCP behavior. It cannot
  hide bugs, but a finding may depend on a lossy-network reading (a message
  sent before the crash arrives after recovery); such a finding says so.

## Coordination with the running research loops

- The perf loop (`research/PERF_GOAL.md`, branch `research/lite`) edits
  `core/scheduler.rs`, `core/state.rs`, `core/exec.rs`, `path.rs`,
  `explorer.rs` and `history.rs`. Clocks, duration timers and persistence
  keys touch these files.
- Spur has two interpreter paths (label-based and compiled-op); every new
  builtin lands in both.
- `spur/` and `porcupine/` are git submodules; changes land there first and
  the superproject pointer moves separately.

Rules:

- Front-end-only work and new files may merge between any iterations.
- Core wiring lands at an iteration boundary with loops stopped, rebased on
  the latest merged state, gated by release-build parity (new search
  features off) and the perf grader's throughput measurement.
- Features that change the search on purpose (time heuristics, crashes
  aimed between persists) are declared search-affecting and read under the
  loop's non-inferiority protocol, not the parity check.

## Open questions (collected)

| Area | Question | Recommendation |
| --- | --- | --- |
| Time | Unit | Abstract integer ticks |
| Time | Skew or drift | Skew first |
| Time | Clock reads yield | Yes, cost measured |
| Time | Checker ordering | Record real time for reports; checker keeps event order |
| Persistence | Key form | Declared names |
