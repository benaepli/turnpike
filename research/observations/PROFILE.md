# Explorer profile

Generated 2026-09-03T02:45:37.401Z at operator: perf record on the bench workload (scheduler_configs/loop/bench.json, 30 threads, spur c5e49c2), top symbols by self time, perf report --no-children --percent-limit 1.

A perf hypothesis names one of these symbols as its hotspot. Symbols that belong to the writer or the grader instrumentation are not candidates: the ladder and regression gates reject their removal.

```
# Overhead  Command          Shared Object                    Symbol                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        
     7.47%  spur             spur                             [.] spur_core::simulator::core::eval::eval::<spur_core::simulator::hash_utils::NoHashing>
     4.90%  spur             spur                             [.] spur_core::simulator::core::exec::execute_common_label::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     4.45%  spur             libc.so.6                        [.] __memmove_avx512_unaligned_erms
     3.71%  spur             libc.so.6                        [.] _int_malloc
     3.69%  spur             spur                             [.] core::fmt::write
     2.67%  spur             spur                             [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing> as core::clone::Clone>::clone
     2.55%  spur             spur                             [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>::new
     2.54%  spur             libc.so.6                        [.] cfree@GLIBC_2.2.5
     2.53%  spur             spur                             [.] spur_core::simulator::core::scheduler::schedule_runnable::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::core::queue_selector::AnySelector, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     2.43%  spur             spur                             [.] <alloc::string::String as core::fmt::Write>::write_str
     2.27%  spur             spur                             [.] <&mut serde_json::ser::Serializer<&mut alloc::vec::Vec<u8>> as serde_core::ser::Serializer>::serialize_str
     2.15%  spur             spur                             [.] <core::hash::sip::Hasher<core::hash::sip::Sip13Rounds> as core::hash::Hasher>::write
     2.09%  spur             spur                             [.] spur_core::simulator::core::exec::exec::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     1.92%  spur             spur                             [.] <ecow::vec::EcoVec<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>>::make_unique
     1.82%  spur             libc.so.6                        [.] malloc
     1.60%  spur             spur                             [.] spur_core::simulator::core::eval::make_local_env::<spur_core::simulator::hash_utils::NoHashing>
     1.53%  spur             libc.so.6                        [.] malloc_consolidate
     1.47%  spur             spur                             [.] core::ptr::drop_glue::<spur_core::simulator::core::values::ValueKind<spur_core::simulator::hash_utils::NoHashing>>
     1.38%  spur             spur                             [.] spur_core::simulator::core::eval::store::<spur_core::simulator::hash_utils::NoHashing>
     1.35%  spur             spur                             [.] spur_core::simulator::core::scheduler::schedule_runnable::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::core::queue_selector::AnySelector, spur_core::simulator::feedback::TimelineFeedback<false>, rand::rngs::small::SmallRng>::{closure#0}
     1.34%  spur             libc.so.6                        [.] _int_free_chunk
     1.33%  spur             spur                             [.] <ecow::vec::EcoVec<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>> as core::ops::drop::Drop>::drop
     1.18%  parquet-writer-  spur                             [.] <parquet::util::interner::Interner<parquet::encodings::encoding::dict_encoder::KeyStorage<parquet::data_type::Int64Type>>>::intern
     1.11%  parquet-writer-  libc.so.6                        [.] __memmove_avx512_unaligned_erms
     1.06%  spur             spur                             [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing> as core::fmt::Display>::fmt
     1.03%  spur             spur                             [.] <core::iter::adapters::map::Map<core::slice::iter::Iter<alloc::vec::Vec<spur_core::simulator::core::state::Runnable<spur_core::simulator::hash_utils::NoHashing>>>, spur_core::simulator::core::scheduler::schedule_runnable<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::core::queue_selector::AnySelector, spur_core::simulator::feedback::TimelineFeedback<false>, rand::rngs::small::SmallRng>::{closure#5}> as core::iter::traits::iterator::Iterator>::fold::<(), core::iter::traits::iterator::Iterator::for_each::call<usize, <alloc::vec::Vec<usize>>::extend_trusted<core::iter::adapters::map::Map<core::slice::iter::Iter<alloc::vec::Vec<spur_core::simulator::core::state::Runnable<spur_core::simulator::hash_utils::NoHashing>>>, spur_core::simulator::core::scheduler::schedule_runnable<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::core::queue_selector::AnySelector, spur_core::simulator::feedback::TimelineFeedback<false>, rand::rngs::small::SmallRng>::{closure#5}>>::{closure#0}>::{closure#0}>
     1.03%  spur             spur                             [.] spur_core::simulator::path::exec_plan::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
```
