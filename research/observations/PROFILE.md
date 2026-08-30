# Explorer profile

Generated 2026-08-30T10:24:18.706Z at iteration 5355: perf record on the bench workload (scheduler_configs/loop/bench.json, 14 threads, spur 3086028), top symbols by self time, perf report --no-children --percent-limit 1.

A perf hypothesis names one of these symbols as its hotspot. Symbols that belong to the writer or the grader instrumentation are not candidates: the ladder and regression gates reject their removal.

```
# Overhead  Command          Shared Object            Symbol                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        
     7.55%  spur             spur                     [.] spur_core::simulator::core::eval::eval::<spur_core::simulator::hash_utils::NoHashing>
     5.24%  spur             spur                     [.] spur_core::simulator::core::exec::execute_common_label::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     4.34%  spur             libc.so.6                [.] _int_malloc
     3.66%  spur             spur                     [.] core::fmt::write
     3.32%  spur             libc.so.6                [.] __memmove_avx512_unaligned_erms
     3.03%  spur             spur                     [.] spur_core::simulator::core::scheduler::schedule_runnable::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::core::queue_selector::AnySelector, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     2.96%  spur             spur                     [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>::new
     2.47%  spur             libc.so.6                [.] cfree@GLIBC_2.2.5
     2.47%  spur             spur                     [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing> as core::clone::Clone>::clone
     2.37%  spur             spur                     [.] spur_core::simulator::core::eval::make_local_env::<spur_core::simulator::hash_utils::NoHashing>
     2.17%  spur             spur                     [.] <ecow::vec::EcoVec<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>>::make_unique
     2.07%  spur             spur                     [.] <alloc::string::String as core::fmt::Write>::write_str
     1.99%  spur             spur                     [.] <&mut serde_json::ser::Serializer<&mut alloc::vec::Vec<u8>> as serde_core::ser::Serializer>::serialize_str
     1.79%  spur             libc.so.6                [.] malloc
     1.77%  spur             spur                     [.] spur_core::simulator::core::exec::exec::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     1.66%  spur             libc.so.6                [.] _int_free_chunk
     1.50%  spur             spur                     [.] <ecow::vec::EcoVec<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>> as core::ops::drop::Drop>::drop
     1.49%  spur             spur                     [.] spur_core::simulator::core::eval::store::<spur_core::simulator::hash_utils::NoHashing>
     1.45%  spur             spur                     [.] core::ptr::drop_glue::<spur_core::simulator::core::values::ValueKind<spur_core::simulator::hash_utils::NoHashing>>
     1.44%  spur             spur                     [.] <core::hash::sip::Hasher<core::hash::sip::Sip13Rounds> as core::hash::Hasher>::write
     1.30%  spur             spur                     [.] core::ptr::drop_glue::<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>
     1.26%  spur             spur                     [.] spur_core::simulator::path::exec_plan::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     1.22%  spur             libc.so.6                [.] malloc_consolidate
     1.19%  spur             spur                     [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing> as core::fmt::Display>::fmt
     1.05%  spur             spur                     [.] <spur_core::simulator::core::values::ValueKind<spur_core::simulator::hash_utils::NoHashing> as core::clone::Clone>::clone
```
