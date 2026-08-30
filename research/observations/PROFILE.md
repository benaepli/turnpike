# Explorer profile

Generated 2026-08-30T19:45:30.715Z at operator: perf record on the bench workload (scheduler_configs/loop/bench.json, 14 threads, spur 531de76), top symbols by self time, perf report --no-children --percent-limit 1.

A perf hypothesis names one of these symbols as its hotspot. Symbols that belong to the writer or the grader instrumentation are not candidates: the ladder and regression gates reject their removal.

```
# Overhead  Command          Shared Object                    Symbol                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        
     8.35%  spur             spur                             [.] spur_core::simulator::core::eval::eval::<spur_core::simulator::hash_utils::NoHashing>
     6.38%  spur             spur                             [.] spur_core::simulator::core::exec::execute_common_label::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     4.38%  spur             libc.so.6                        [.] _int_malloc
     3.41%  spur             libc.so.6                        [.] __memmove_avx512_unaligned_erms
     3.16%  spur             spur                             [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>::new
     3.07%  spur             spur                             [.] core::fmt::write
     2.88%  spur             spur                             [.] <alloc::string::String as core::fmt::Write>::write_str
     2.53%  spur             spur                             [.] spur_core::simulator::core::scheduler::schedule_runnable::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::core::queue_selector::AnySelector, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     2.42%  spur             spur                             [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing> as core::clone::Clone>::clone
     2.33%  spur             libc.so.6                        [.] cfree@GLIBC_2.2.5
     2.29%  spur             spur                             [.] serde_json::ser::format_escaped_str::<&mut alloc::vec::Vec<u8>, serde_json::ser::CompactFormatter>
     2.23%  spur             spur                             [.] spur_core::simulator::core::eval::make_local_env::<spur_core::simulator::hash_utils::NoHashing>
     2.14%  spur             spur                             [.] <ecow::vec::EcoVec<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>>::make_unique
     1.93%  spur             spur                             [.] spur_core::simulator::core::exec::exec::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     1.64%  spur             libc.so.6                        [.] malloc
     1.62%  spur             spur                             [.] spur_core::simulator::path::exec_plan::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     1.56%  spur             spur                             [.] spur_core::simulator::core::eval::store::<spur_core::simulator::hash_utils::NoHashing>
     1.47%  spur             spur                             [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing> as core::fmt::Display>::fmt
     1.40%  spur             spur                             [.] core::ptr::drop_glue::<spur_core::simulator::core::values::ValueKind<spur_core::simulator::hash_utils::NoHashing>>
     1.40%  spur             spur                             [.] <core::hash::sip::Hasher<core::hash::sip::Sip13Rounds> as core::hash::Hasher>::write
     1.34%  spur             spur                             [.] <ecow::vec::EcoVec<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>> as core::ops::drop::Drop>::drop
     1.28%  spur             libc.so.6                        [.] _int_free_chunk
     1.18%  spur             spur                             [.] core::ptr::drop_glue::<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>
     1.15%  spur             libc.so.6                        [.] malloc_consolidate
     1.14%  spur             spur                             [.] <alloc::vec::Vec<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>> as alloc::vec::spec_from_iter::SpecFromIter<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>, core::iter::adapters::GenericShunt<core::iter::adapters::map::Map<core::slice::iter::Iter<spur_core::compiler::cfg::ir::Expr>, spur_core::simulator::core::exec::execute_common_label<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::TimelineFeedback<false>, rand::rngs::small::SmallRng>::{closure#3}>, core::result::Result<core::convert::Infallible, spur_core::simulator::core::error::RuntimeError>>>>::from_iter
     1.01%  spur             spur                             [.] <spur_core::simulator::core::values::ValueKind<spur_core::simulator::hash_utils::NoHashing> as core::clone::Clone>::clone
```
