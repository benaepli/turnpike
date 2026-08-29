# Explorer profile

Generated 2026-08-29T06:30:19.769Z at operator: perf record on the bench workload (scheduler_configs/loop/bench.json, 14 threads, spur ed04f9a), top symbols by self time, perf report --no-children --percent-limit 1.

A perf hypothesis names one of these symbols as its hotspot. Symbols that belong to the writer or the grader instrumentation are not candidates: the ladder and regression gates reject their removal.

```
# Overhead  Command          Shared Object            Symbol                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        
    25.61%  spur             libc.so.6                [.] __memmove_avx512_unaligned_erms
            |          
             --25.60%--__memmove_avx512_unaligned_erms
                       |          
                       |--11.36%--<alloc::sync::Arc<imbl_sized_chunks::sized_chunk::Chunk<(spur_core::simulator::core::state::Record<spur_core::simulator::hash_utils::NoHashing>, spur_core::compiler::cfg::ir::Lhs), 64>>>::clone_from_ref_in
                       |          |          
                       |           --4.36%--<imbl::nodes::hamt::GenericNode<(spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>, spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>), archery::shared_pointer::kind::arc::ArcK, 32>>::insert
                       |          
                        --7.48%--<imbl::vector::GenericVector<(spur_core::simulator::core::state::Record<spur_core::simulator::hash_utils::NoHashing>, spur_core::compiler::cfg::ir::Lhs), archery::shared_pointer::kind::arc::ArcK>>::push_back

     4.75%  spur             libc.so.6                [.] _int_malloc
            |
            ---_int_malloc
               |          
                --1.20%--malloc

     3.83%  spur             spur                     [.] spur_core::simulator::core::eval::eval::<spur_core::simulator::hash_utils::NoHashing>
            |
            ---spur_core::simulator::core::eval::eval::<spur_core::simulator::hash_utils::NoHashing>

     2.74%  spur             spur                     [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing> as core::clone::Clone>::clone
            |
            ---<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing> as core::clone::Clone>::clone

     2.73%  spur             spur                     [.] spur_core::simulator::core::exec::execute_common_label::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
            |
            ---spur_core::simulator::core::exec::execute_common_label::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>

     2.67%  spur             spur                     [.] <spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>::new
            |
            ---<spur_core::simulator::core::values::Value<spur_core::simulator::hash_utils::NoHashing>>::new

     2.59%  spur             libc.so.6                [.] cfree@GLIBC_2.2.5
            |
            ---cfree@GLIBC_2.2.5
               |          
                --1.47%--cfree@GLIBC_2.2.5

     1.97%  spur             spur                     [.] <imbl::nodes::hamt::GenericNode<(spur_core::simulator::core::values::ChannelId, spur_core::simulator::core::state::ChannelState<spur_core::simulator::hash_utils::NoHashing>), archery::shared_pointer::kind::arc::ArcK, 32>>::insert
            |          
             --1.96%--<imbl::nodes::hamt::GenericNode<(spur_core::simulator::core::values::ChannelId, spur_core::simulator::core::state::ChannelState<spur_core::simulator::hash_utils::NoHashing>), archery::shared_pointer::kind::arc::ArcK, 32>>::insert

     1.88%  spur             spur                     [.] spur_core::simulator::core::exec::exec::<spur_core::simulator::hash_utils::NoHashing, spur_core::simulator::path::Logs, spur_core::simulator::feedback::NoFeedback, spur_core::simulator::rng::RecRng<spur_core::simulator::rng::LiveRng>>
            |
```
