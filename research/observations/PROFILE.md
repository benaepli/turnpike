# Explorer profile

Generated 2026-08-29T13:40:42.021Z at iteration 5320: perf record on the bench workload (scheduler_configs/loop/bench.json, 30 threads, spur 9152760), top symbols by self time, perf report --no-children --percent-limit 1.

A perf hypothesis names one of these symbols as its hotspot. Symbols that belong to the writer or the grader instrumentation are not candidates: the ladder and regression gates reject their removal.

```
# Overhead  Command          Shared Object                    Symbol                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        
    35.23%  spur             libc.so.6                        [.] __memmove_avx512_unaligned_erms
     3.58%  spur             libc.so.6                        [.] _int_malloc
     3.16%  spur             spur                             [.] spur_core::simulator::core::eval::eval::<spur_core::simulator::hash_utils::NoHashing>
     3.10%  spur             spur                             [.] spur_core::simulator::core::exec::execute_common_label::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     2.35%  spur             libc.so.6                        [.] cfree@GLIBC_2.2.5
     1.85%  spur             [unknown]                        [k] 0xffffffffb18aefee
     1.58%  parquet-writer-  libc.so.6                        [.] __memmove_avx512_unaligned_erms
     1.56%  spur             spur                             [.] spur_core::simulator::core::exec::exec::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     1.55%  spur             spur                             [.] <imbl::nodes::hamt::GenericNode<(spur_core::simulator::core::values::ChannelId, spur_core::simulator::core::state::ChannelState<spur_core::simulator::hash_utils::NoHashing>), archery::shared_pointer::kind::arc::ArcK, 32>>::insert
     1.52%  spur             spur                             [.] spur_core::simulator::core::scheduler::schedule_runnable::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::core::queue_selector::AnySelector, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     1.42%  spur             libc.so.6                        [.] _int_free_chunk
     1.39%  spur             spur                             [.] <ecow::vec::EcoVec<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>>::make_unique
     1.36%  spur             libc.so.6                        [.] _int_free_merge_chunk
     1.31%  spur             spur                             [.] core::fmt::write
     1.19%  spur             spur                             [.] <&mut serde_json::ser::Serializer<&mut alloc::vec::Vec<u8>> as serde_core::ser::Serializer>::serialize_str
     1.14%  spur             spur                             [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>::new
     1.07%  spur             spur                             [.] <spur_core::simulator::core::values::ValueKind<spur_core::simulator::hash_utils::NoHashing> as core::clone::Clone>::clone
     1.07%  spur             spur                             [.] core::ptr::drop_glue::<spur_core::simulator::core::values::ValueKind<spur_core::simulator::hash_utils::NoHashing>>
     1.01%  spur             libc.so.6                        [.] malloc
```
