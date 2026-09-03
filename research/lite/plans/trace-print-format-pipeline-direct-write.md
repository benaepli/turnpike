# trace-print-format-pipeline-direct-write

Iteration 22, epoch 13. Kind perf. Touches exec.rs and history.rs, so the
decision is the user's whatever the grade.

## What changes

Nothing about scheduling, and no byte of any trace or log row. The trace
and print pipeline formats values through Display into fresh strings,
builds a Vec of strings per trace row, re-walks each row into JSON values
inside a nested parallel iterator, and clones payloads and function names
into the writer's rows. The change formats each value once into a reused
scratch string with a write_to that appends exactly the Display bytes,
writes the JSON payload once per item, carries the pre-serialized payload
and a shared name in the trace entry, moves rows into the writer without
JSON values or clones, and makes string concatenation and int_to_string
allocate once.

## Why

Formatting and string serialization are about a tenth of self time on the
fresh profile and run on every delivery of every run, since every VR
handler is traced and most begin with a println. Runs per second multiply
every gain on the rung.

## Frozen prediction

- Rung: throughput, cross-binary runs per explore-second on
  general_vr.json, in [+8%, +12%], point +9%.
- Independent observable: per-run allocation count under a counting
  allocator on bench.json with VR.spur falls by at least 20%, with traces
  rows per run unchanged; paired wall per step per shared run id falls by
  the rung's ratio.
- Cost clause: depth>=6 per run on the crashPhase (512) internal contrast
  unchanged; identical per shared run id; steps per run per arm identical.
- Falsifier: the throughput interval entirely below +8%; any shared run id
  differing in executions rows, steps_used, or utilStats counters; any
  byte of the traces or logs parquet differing on the golden set; the
  allocation count not falling.

## Acceptance test

Fixed-seed standard runs of VR, Paxos, Raft and the six fixtures on the
baseline and candidate binaries: equal digests of executions, runs and
every utilStats counter including tape_words_sum; equal hashes of all
traces and logs rows ordered by (run_id, seq_num); property tests that
write_to equals Display and that inline payload bytes equal the JSON of
the same items.

## Grading

`start` without a treatment bit (a shared hot path has no per-run half);
two chunks; read throughput cross-binary against the 0.05 layout floor,
and the within-session cost per step beside it.
