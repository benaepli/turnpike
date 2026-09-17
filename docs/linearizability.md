# Integrated linearizability checking

Spur checks finished runs by default in a separate pool of Rust workers. These
defaults apply when an explorer or plan configuration omits `linearizability`:

```json
"linearizability": {
  "enabled": true,
  "workers": 2,
  "queue_capacity": 256,
  "queue_bytes": 16777216,
  "timeout_ms": 10,
  "overflow": "defer",
  "stop_on_violation": true
}
```

For an existing explorer config:

```bash
cargo run --release --manifest-path spur/Cargo.toml --bin spur -- explore \
  --config scheduler_configs/loop/general_vr.json -e campaign \
  -y --output-dir output bin/spur/VR.spur
```

The same block works with standard, genetic, AOS, continuous, and campaign
exploration, and with `run-plan`. Campaign settings apply to the whole session;
arm overlays cannot change them. Checker verdicts do not enter scheduling,
feedback, reward, or mutation selection. Enabling the pool still consumes CPU
and can change exposure and completion order in a parallel or timed session.

Set `linearizability.enabled=false` in a config to opt out, or pass
`--set linearizability.enabled=false` to `explore`.

## Capacity and stopping

`overflow: "defer"` keeps exploration moving when admission capacity is full.
The history is written normally and left for the offline checker. `"block"`
waits for capacity. Histories larger than `queue_bytes` are deferred in either
mode. Capacity is reserved before compact checker inputs are allocated;
waiting producers retain their event histories, not simulator state or traces.

`queue_capacity` limits queued jobs and reservations. `queue_bytes` bounds the
conservatively estimated compact input storage, including inputs being checked.
Partition buffers and search caches are additional memory. Worker count and
cooperative deadlines limit concurrent searches and time spent on them; they are not a hard process
memory limit. A deadline can be exceeded while partitioning, a model step,
allocation, or cleanup finishes. No checker call creates additional search
threads.

`workers` controls checker workers independently of `RAYON_NUM_THREADS`, which
controls simulator workers. There is also one checker result writer and Spur's
existing Parquet writers. Set simulator and checker counts together when
allocating CPU resources. The implementation does not pin cores.

A violation requests termination by default. Already-running simulations finish
and save their histories. Pending checks are cancelled; active checks cooperate
with cancellation and return unknown unless they have a definitive verdict.
Set `stop_on_violation: false` to continue collecting results.

Normal run-limit or time-budget completion drains admitted checks. Ctrl+C
cancels remaining checks. Graceful shutdown joins workers and finalizes output.
Unexpected termination can leave unfinished Parquet files; a session whose
checking manifest was not finalized is rechecked offline.

## Results and exit status

`checks_summary.json` records passing, violating, unknown, and unchecked history
counts; deferral reasons; queue high-water marks; checking and admission wait
time; errors; and the first detected violation and detection time. Simulation
timing excludes checker conversion and admission. First detection follows
worker completion order and is not necessarily the lowest violating run ID.

When checking is enabled:

| Exit | Meaning |
| --- | --- |
| 0 | All recorded histories passed |
| 1 | Configuration, execution, or persistence error |
| 2 | At least one violation |
| 4 | Some histories remain unknown or unchecked, or none were recorded |

Errors take precedence over a violation in the exit status. A timeout or
malformed client history is unknown, never a passing or violating check.

Callers that run offline checking after exploration should continue after
exit 0, 2, or 4, retaining the exit code as the checking outcome. Exit 1 and
unexpected process failures must fail the invocation even if some surviving
histories pass offline checking.

## Benchmarks and research measurements

Throughput benchmarks and research measurements keep checking enabled. Their
generated configs set `enabled=true` and `stop_on_violation=false` so each
sample runs to its configured limit. They preserve the chosen queue policy
and timeout, including the possibility of deferral or unknown results.

The throughput harnesses require finalized checking metadata from both
binaries. A binary that ignores the checking config cannot produce a valid
comparison. Performance baseline caches identify this checking policy so
measurements made without it cannot be mixed into new comparisons.

`scripts/bench.sh` reports the actual completed run count and includes final
checker draining in its wall time. It reports results for exit 2 or 4, retains
the corpus for offline checking, and returns that status to its caller.

## Offline completion and diagnostics

Both Go commands reuse compatible Rust passes by default. Missing and unknown
results are checked. Violations are retained in the final verdict and rechecked
for diagnostics. The batch command adds `reused_runs` and `newly_checked_runs`
without changing the meaning of its existing corpus totals or run IDs.

```bash
cd porcupine
go build -o main ./cmd/porcupine
go build -o batch ./cmd/porcupine_batch
./batch -input ../output
./batch -input ../output -recheck-all
./main -input ../output -type duckdb -output-dir ../output
./main -input ../output -run 7 -output ../output/run_7.html
```

Cached passes skip history decoding and HTML generation. Newly checked runs and
violations receive HTML when using `main`. `-recheck-all` bypasses reuse and
generates all requested diagnostics; selecting a single run always checks it.
A contradictory definitive Go result is a checker-disagreement error. A
diagnostic timeout cannot erase a cached violation.

`checking.json` identifies the session, effective options, and checking contract.
Finalized `checks/*.parquet` batches carry verdicts, run/deployment identity,
model, digest, checker/contract versions, and elapsed time. Matching identity
and digest columns in `runs` allow reuse before reading execution rows.
Only finalized sessions and the supported checking contract are reusable.
Old corpora without this metadata are checked in full. The Go tools consume
these records but do not append their own cache.

Persistence failures make the session fail and prevent reuse. A finalized
manifest records these failures, and the Go tools reject such a corpus.

Reuse assumes an immutable Spur-produced corpus. If histories are edited,
use `-recheck-all`; metadata digests are not independently recomputed during
reuse. Run offline tools after simulation shutdown, not concurrently with
writers. Per-run digests cover ordered client actions, IDs, and payloads, not
simulator steps or system annotations.

The deployment selects `kv` (Write appends) or `kv_rmw` (Write overwrites; RMW
appends and returns the previous list). Pending writes and RMWs remain eligible
to explain completed reads, while pending reads add no observation.

See [local performance measurements](linearizability-performance.md) for
throughput, memory, backpressure, and offline reuse measurements.
