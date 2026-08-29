# Explorer profile

Generated 2026-08-29T21:15:13.858Z at iteration 5335: perf record on the bench workload (scheduler_configs/loop/bench.json, 14 threads, spur 02f5166), top symbols by self time, perf report --no-children --percent-limit 1.

A perf hypothesis names one of these symbols as its hotspot. Symbols that belong to the writer or the grader instrumentation are not candidates: the ladder and regression gates reject their removal.

```
# Overhead  Command          Shared Object            Symbol                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     
     7.44%  spur             spur                     [.] spur_core::simulator::core::eval::eval::<spur_core::simulator::hash_utils::NoHashing>
     5.16%  spur             spur                     [.] spur_core::simulator::core::exec::execute_common_label::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     4.55%  spur             libc.so.6                [.] _int_malloc
     3.57%  spur             spur                     [.] core::fmt::write
     3.29%  spur             spur                     [.] core::ptr::drop_glue::<spur_core::simulator::core::values::ValueKind<spur_core::simulator::hash_utils::NoHashing>>
     3.28%  spur             libc.so.6                [.] __memmove_avx512_unaligned_erms
     2.77%  spur             spur                     [.] <ecow::vec::EcoVec<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>>::make_unique
     2.72%  spur             spur                     [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>::new
     2.49%  spur             spur                     [.] <spur_core::simulator::core::values::ValueKind<spur_core::simulator::hash_utils::NoHashing> as core::clone::Clone>::clone
     2.31%  spur             spur                     [.] <alloc::string::String as core::fmt::Write>::write_str
     2.15%  spur             spur                     [.] spur_core::simulator::core::scheduler::schedule_runnable::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::core::queue_selector::AnySelector, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     2.06%  spur             spur                     [.] <imbl::nodes::hamt::GenericNode<(spur_core::simulator::core::values::ChannelId, spur_core::simulator::core::state::ChannelState<spur_core::simulator::hash_utils::NoHashing>), archery::shared_pointer::kind::arc::ArcK, 32>>::insert
     2.06%  spur             spur                     [.] spur_core::simulator::core::exec::exec::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     2.04%  spur             libc.so.6                [.] cfree@GLIBC_2.2.5
     2.00%  spur             spur                     [.] <&mut serde_json::ser::Serializer<&mut alloc::vec::Vec<u8>> as serde_core::ser::Serializer>::serialize_str
     1.74%  spur             spur                     [.] <ecow::vec::EcoVec<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>> as core::ops::drop::Drop>::drop
     1.67%  spur             libc.so.6                [.] malloc
     1.64%  spur             spur                     [.] spur_core::simulator::core::eval::make_local_env::<spur_core::simulator::hash_utils::NoHashing>
     1.38%  spur             spur                     [.] spur_core::simulator::path::exec_plan::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
     1.35%  spur             libc.so.6                [.] _int_free_chunk
     1.25%  spur             spur                     [.] spur_core::simulator::core::eval::store::<spur_core::simulator::hash_utils::NoHashing>
     1.17%  spur             spur                     [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing> as core::fmt::Display>::fmt
     1.12%  spur             libc.so.6                [.] malloc_consolidate
     1.07%  spur             spur                     [.] <alloc::vec::Vec<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>> as alloc::vec::spec_from_iter::SpecFromIter<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>, core::iter::adapters::GenericShunt<core::iter::adapters::map::Map<core::slice::iter::Iter<spur_core::compiler::cfg::ir::Expr>, spur_core::simulator::core::exec::execute_common_label<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::TimelineFeedback<false>, rand::rngs::small::SmallRng>::{closure#3}>, core::result::Result<core::convert::Infallible, spur_core::simulator::core::error::RuntimeError>>>>::from_iter
```
