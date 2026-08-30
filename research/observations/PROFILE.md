# Explorer profile

Generated 2026-08-30T00:25:14.150Z at iteration 5340: perf record on the bench workload (scheduler_configs/loop/bench.json, 14 threads, spur cfcb6a2), top symbols by self time, perf report --no-children --percent-limit 1.

A perf hypothesis names one of these symbols as its hotspot. Symbols that belong to the writer or the grader instrumentation are not candidates: the ladder and regression gates reject their removal.

```
# Overhead  Command          Shared Object                    Symbol                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        
     7.59%  spur             spur                             [.] spur_core::simulator::core::eval::eval::<spur_core::simulator::hash_utils::NoHashing>
     5.47%  spur             spur                             [.] spur_core::simulator::core::exec::execute_common_label::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     4.89%  spur             libc.so.6                        [.] _int_malloc
     4.25%  spur             libc.so.6                        [.] __memmove_avx512_unaligned_erms
     3.38%  spur             spur                             [.] core::fmt::write
     3.35%  spur             spur                             [.] spur_core::simulator::core::scheduler::schedule_runnable::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::core::queue_selector::AnySelector, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     2.90%  spur             spur                             [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>::new
     2.40%  spur             spur                             [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing> as core::clone::Clone>::clone
     2.34%  spur             spur                             [.] <&mut serde_json::ser::Serializer<&mut alloc::vec::Vec<u8>> as serde_core::ser::Serializer>::serialize_str
     2.26%  spur             spur                             [.] spur_core::simulator::core::exec::exec::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     2.23%  spur             libc.so.6                        [.] cfree@GLIBC_2.2.5
     1.91%  spur             spur                             [.] <ecow::vec::EcoVec<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>>::make_unique
     1.86%  spur             spur                             [.] spur_core::simulator::core::eval::make_local_env::<spur_core::simulator::hash_utils::NoHashing>
     1.82%  spur             spur                             [.] <alloc::string::String as core::fmt::Write>::write_str
     1.77%  spur             spur                             [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing> as core::fmt::Display>::fmt
     1.68%  spur             libc.so.6                        [.] malloc
     1.65%  spur             spur                             [.] spur_core::simulator::core::eval::store::<spur_core::simulator::hash_utils::NoHashing>
     1.55%  spur             spur                             [.] core::ptr::drop_glue::<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>
     1.37%  spur             spur                             [.] <core::hash::sip::Hasher<core::hash::sip::Sip13Rounds> as core::hash::Hasher>::write
     1.35%  spur             spur                             [.] <ecow::vec::EcoVec<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>> as core::ops::drop::Drop>::drop
     1.34%  spur             spur                             [.] core::ptr::drop_glue::<spur_core::simulator::core::values::ValueKind<spur_core::simulator::hash_utils::NoHashing>>
     1.23%  spur             libc.so.6                        [.] _int_free_chunk
```
