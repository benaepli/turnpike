# Explorer profile

Generated 2026-08-30T15:58:41.051Z at iteration 5365: perf record on the bench workload (scheduler_configs/loop/bench.json, 14 threads, spur ecea520), top symbols by self time, perf report --no-children --percent-limit 1.

A perf hypothesis names one of these symbols as its hotspot. Symbols that belong to the writer or the grader instrumentation are not candidates: the ladder and regression gates reject their removal.

```
# Overhead  Command          Shared Object                    Symbol                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        
     7.69%  spur             spur                             [.] spur_core::simulator::core::eval::eval::<spur_core::simulator::hash_utils::NoHashing>
     6.13%  spur             spur                             [.] spur_core::simulator::core::exec::execute_common_label::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     4.24%  spur             libc.so.6                        [.] _int_malloc
     3.21%  spur             libc.so.6                        [.] __memmove_avx512_unaligned_erms
     3.20%  spur             spur                             [.] spur_core::simulator::core::scheduler::schedule_runnable::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::core::queue_selector::AnySelector, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     3.16%  spur             spur                             [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>::new
     3.13%  spur             spur                             [.] core::fmt::write
     2.65%  spur             spur                             [.] <ecow::vec::EcoVec<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>>::make_unique
     2.55%  spur             spur                             [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing> as core::clone::Clone>::clone
     2.50%  spur             libc.so.6                        [.] cfree@GLIBC_2.2.5
     2.35%  spur             spur                             [.] serde_json::ser::format_escaped_str::<&mut alloc::vec::Vec<u8>, serde_json::ser::CompactFormatter>
     2.26%  spur             spur                             [.] spur_core::simulator::core::eval::make_local_env::<spur_core::simulator::hash_utils::NoHashing>
     2.13%  spur             libc.so.6                        [.] malloc
     2.09%  spur             spur                             [.] spur_core::simulator::core::exec::exec::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     1.96%  spur             spur                             [.] <alloc::string::String as core::fmt::Write>::write_str
     1.89%  spur             spur                             [.] spur_core::simulator::core::eval::store::<spur_core::simulator::hash_utils::NoHashing>
     1.87%  spur             libc.so.6                        [.] _int_free_chunk
     1.80%  spur             spur                             [.] core::ptr::drop_glue::<spur_core::simulator::core::values::ValueKind<spur_core::simulator::hash_utils::NoHashing>>
     1.49%  spur             spur                             [.] core::ptr::drop_glue::<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>
     1.37%  spur             libc.so.6                        [.] malloc_consolidate
     1.30%  spur             spur                             [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing> as core::fmt::Display>::fmt
     1.27%  spur             spur                             [.] <ecow::vec::EcoVec<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>> as core::ops::drop::Drop>::drop
     1.24%  spur             spur                             [.] spur_core::simulator::path::exec_plan::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     1.23%  spur             spur                             [.] <core::hash::sip::Hasher<core::hash::sip::Sip13Rounds> as core::hash::Hasher>::write
     1.07%  spur             spur                             [.] <alloc::raw_vec::RawVecInner>::finish_grow
```
