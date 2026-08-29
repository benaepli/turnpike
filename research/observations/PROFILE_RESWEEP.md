# Where the cost sits once allocation size is no longer the dominant term

Three consecutive census-driven edits each removed the largest allocation term,
and wall time on the bench workload fell about 2.5x in total. The question this
answers is whether allocation is still the thing to aim at, and if not, what is.

## Method, and what could not be run

The perf snapshot is the audit-time capture in `PROFILE.md`: `perf record` on
`scheduler_configs/loop/bench.json`, 14 threads, `perf report --no-children
--percent-limit 1`, taken on merged HEAD. `perf` is not on the implementer's
command allowlist, so the snapshot is read rather than re-taken; it is current
with the tree being measured.

The byte-size census could not be run at all, for the same reason recorded in
`ALLOC_CENSUS.md`: an LD_PRELOAD interposer needs a C compiler and there is none
on the allowlist. The residual large-allocation question is therefore answered
structurally - by asking which containers still allocate above glibc's 1032-byte
tcache limit and what the profile says about the symbols that service them -
rather than with a histogram.

## Top self time

| share | symbol | file |
| --- | --- | --- |
| 7.44% | `eval::eval` | core/eval.rs |
| 5.16% | `exec::execute_common_label` | core/exec.rs |
| 4.55% | `_int_malloc` | libc |
| 3.57% | `core::fmt::write` | core |
| 3.29% | `drop_glue::<ValueKind>` | core/values.rs |
| 3.28% | `__memmove_avx512_unaligned_erms` | libc |
| 2.77% | `EcoVec<Value>::make_unique` | core/values.rs |
| 2.72% | `Value::new` | core/values.rs |
| 2.49% | `ValueKind::clone` | core/values.rs |
| 2.31% | `<String as fmt::Write>::write_str` | core |
| 2.15% | `scheduler::schedule_runnable` | core/scheduler.rs |
| 2.06% | `imbl hamt GenericNode<(ChannelId, ChannelState)>::insert` | core/state.rs |
| 2.06% | `exec::exec` | core/exec.rs |
| 2.04% | `cfree` | libc |
| 2.00% | `serde_json Serializer::serialize_str` | writer |
| 1.74% | `EcoVec<Value>::drop` | core/values.rs |
| 1.67% | `malloc` | libc |
| 1.64% | `eval::make_local_env` | core/eval.rs |
| 1.38% | `path::exec_plan` | path.rs |
| 1.35% | `_int_free_chunk` | libc |

## Reading it

No single simulator symbol carries 5%. The top one, `eval::eval`, is a
tree-walking dispatch at 7.44% with no removable term inside it: its self time is
the match on `Expr` plus the recursion, and both are the shape of the
interpreter, not an inefficiency in it.

Cost is clustered rather than concentrated, and three clusters account for most
of it:

- **Allocator, 10.73%** (`_int_malloc` 4.55, `cfree` 2.04, `malloc` 1.67,
  `_int_free_chunk` 1.35, `malloc_consolidate` 1.12). Allocation is still the
  largest cluster even after three rounds of cutting it. `malloc_consolidate`
  and `_int_free_chunk` appearing together is the signature of blocks above the
  tcache limit being returned to the arena, so large allocations have not gone
  away; they moved.
- **Value churn, 13.01%** (`drop_glue::<ValueKind>` 3.29, `make_unique` 2.77,
  `Value::new` 2.72, `ValueKind::clone` 2.49, `EcoVec::drop` 1.74) plus the
  3.28% of `memmove` it drives. Most of this is load-bearing: the copy-on-write
  of a node environment happens because `state.nodes[i]` has to keep showing its
  pre-execution value while a handler runs - `node_state_token` reads
  `Env::writes` off it mid-execution - and `Record::initial_env` has to keep the
  pristine argument values for redelivery. Both copies are already lazy and
  already happen at most once.
- **Formatting, 7.05%** (`core::fmt::write` 3.57, `String::write_str` 2.31,
  `Value::fmt` 1.17), feeding the trace payloads and, through
  `serialize_str` 2.00%, the writer. This is grader instrumentation; the ladder
  and regression gates reject removing it.

## Which large allocations are left

`__memmove_avx512_unaligned_erms` at 3.28% is down from 35.00% before the
`waiting_readers` change, so the wide-element persistent *vector* is gone. The
wide-element persistent *map* is not. `state.channels` is an `imbl` HAMT, and
the profile still names its node type directly:

```
2.06%  imbl::nodes::hamt::GenericNode<(ChannelId, ChannelState), ArcK, 32>::insert
```

A HAMT node is allocated at its full branching factor of 32 entries whatever the
occupancy. `size_of::<(ChannelId, ChannelState<H>)>()` is roughly 150 bytes - a
24-byte `ChannelId` and two `imbl::Vector`s - so a node is several kilobytes,
far above the 1032-byte limit, and channel ids come from a monotonic counter
that is never reused, so the trie only grows over a run.

The map also forced a copy on every use. Each `Send`, `Recv`, timer completion
and remote delivery did `channels.get(&id).cloned()`, mutated the copy, and
`insert`ed it back. That clone is why `ChannelState::pop_waiting_reader` never
took its fast path: the entry it pops is an `Arc` and `Arc::try_unwrap` succeeds
only when the channel state is unshared, which the clone guaranteed it was not,
so every woken reader was deep-copied - a `Record`, which is 256 bytes plus two
environments.

Nothing depended on the map being persistent. `State` is never cloned or
snapshotted, which is why `nodes` and the run queues are already plain `Vec`s,
and `channels` is iterated in exactly one place, `State::signature`, where
entries are combined with XOR and order is not observable. `imbl::HashMap`
defaults to a randomly seeded hasher, so no schedule could have depended on that
order in the first place.

## The lever applied

`channels` becomes an owned `HashMap` with the same seedless `FxHasher` the
value maps use, and the four read-modify-write sites update the channel in place
through `get_mut` instead of copying it out and putting it back. That removes,
per channel operation: the HAMT walk and node allocation, the `ChannelState`
clone and the drop of the old one, and the deep copy of a woken reader.

`channel_entry_is_too_wide_for_a_trie_node` in `core/state.rs` pins the reason:
32 entries of the map's element type exceed the allocator's small-block limit.
It fails if the entry ever becomes narrow enough that a persistent map would
have been affordable after all.
