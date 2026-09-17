# Spur Fault Model

## Summary

Extend Spur's fault model with named, independently atomic persistence
keys, then disk durability once implementations are translated. Message
loss is deliberately not modeled.

Time handling is specified in [Time Handling](time-handling.md) and
sequenced in [Time Handling Implementation](time-handling-implementation.md).

## Scope and invariants

- High level only. Grammar and full semantics belong in per-part design
  documents.
- No backwards compatibility: every spec under `bin/spur/` and every JSON
  under `scheduler_configs/` may be rewritten.
- No refinement types. Validity is plain code.
- A tag or config knob is added only together with the heuristic or tool that
  consumes it.
- Per-step simulator cost is measured for every change.
- Simulator-core changes land only at research-loop iteration boundaries,
  are verified with release builds only, and their verification scaffolding
  is removed when the boundary closes.
- Documents and code follow `research/STYLE.md`.

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
  `explorer.rs` and `history.rs`. Persistence keys touch these files.
- Spur has two interpreter paths (label-based and compiled-op); every new
  builtin lands in both.
- `spur/` and `porcupine/` are git submodules; changes land there first and
  the superproject pointer moves separately.

Rules:

- Front-end-only work and new files may merge between any iterations.
- Core wiring lands at an iteration boundary with loops stopped, rebased on
  the latest merged state, gated by release-build parity (new search
  features off) and the perf grader's throughput measurement.
- Features that change the search on purpose (crashes aimed between
  persists) are declared search-affecting and read under the
  loop's non-inferiority protocol, not the parity check.

## Open questions (collected)

| Area | Question | Recommendation |
| --- | --- | --- |
| Persistence | Key form | Declared names |
