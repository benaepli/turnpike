# Where the large-allocation traffic went after the Value shrink

Measured 2026-08-29 on the bench workload (`scheduler_configs/loop/bench.json`,
2000 runs, `max_iterations` 5000, default rayon threads), against merged HEAD
with `Value` at 40 bytes.

## Method

The planned LD_PRELOAD size census could not be run: the implementer fence has
no C compiler on its command allowlist, so an interposer cannot be built. The
same question - which call site carries the large-allocation traffic - was
answered instead with `perf record --call-graph dwarf,4096 -F 99` on the bench
workload, followed by `perf report -g caller` restricted to the copy and
allocator symbols. That attributes cycles rather than bytes, but for
allocations above glibc's 1032-byte tcache limit the two track each other:
every such allocation costs an `_int_malloc` arena walk plus a copy proportional
to its size.

## Before

`__memmove_avx512_unaligned_erms` is 35.00% of all cycles, and almost all of it
has one owner:

```
    35.00%  spur  libc.so.6  __memmove_avx512_unaligned_erms
             --34.95%--__memmove_avx512_unaligned_erms
                       |--17.86%--Arc<imbl_sized_chunks::Chunk<(state::Record<NoHashing>,
                       |                                        cfg::ir::Lhs), 64>>::clone_from_ref
                       |--11.07%--imbl::vector::GenericVector<(state::Record<NoHashing>,
                                                               cfg::ir::Lhs), ArcK>::push_back
```

28.93% of the process's cycles sit in one container: `ChannelState.waiting_readers`,
the `imbl::Vector<(Record<H>, Lhs)>` holding the readers blocked on a channel.

`size_of::<(Record<WithHashing>, Lhs)>()` is 256 bytes. `imbl` sizes its heap
chunk by the element type, so a chunk is `16 + 64 * 256 = 16,400` bytes, and it
is allocated at full width whatever the occupancy - a channel with one blocked
reader owns a 16 KB chunk. `imbl` also keeps a vector inline only when
`(size_of::<RRB>() - 8) / size_of::<A>() >= 1`, which is `48 / 256 = 0`, so
inline storage was never reachable. Every blocked reader therefore cost a
16 KB allocation above the tcache limit plus a 16 KB copy on each
copy-on-write, and channel state is cloned on every delivery.

The allocator callers below that are diffuse: `_int_malloc` 3.40% (0.68% under
`String::clone`, 0.39% of it under `history::serialize_traces`), `_int_free_chunk`
1.40% (0.35% under `drop_glue::<path::Logs>`), `_int_free_merge_chunk` 1.23%
(0.59% under `Arc<hamt::GenericNode<(ChannelId, ChannelState)>>::drop_slow`).
No second site of comparable weight exists; the distribution after the `Value`
shrink is one dominant contributor and a long tail.

## After

`waiting_readers` now holds `Arc<(Record<H>, Lhs)>`, an 8-byte element, so up
to six blocked readers fit in the vector's inline storage and allocate nothing.
Same workload, same seeds:

| symbol | before | after |
| --- | --- | --- |
| `__memmove_avx512_unaligned_erms` | 35.00% | 3.95% |
| `Chunk<(Record, Lhs), 64>` clone | 17.86% | absent |
| `Vector<(Record, Lhs)>::push_back` | 11.07% | absent |

Explorer wall time for the 2000-run bench under `perf record` went from 2.94 s
to 0.95 s. That figure is inflated by the profiler's cost falling with the
memory traffic; the A/B bench is the number that counts.

`_int_malloc` rises from 3.40% to 6.18% of a much smaller total: the remaining
allocations are now the small ones that were always there, and they are a
larger share of what is left.

## Determinism

The pre-change and post-change binaries were run on the same config and session
seed, and `traceanalyzer -runs` was dumped for both. All 2000
`(workload_seed, schedule_seed, steps_used)` triples are identical and neither
set has a row the other lacks, so the representation change does not move a
single scheduling decision.
