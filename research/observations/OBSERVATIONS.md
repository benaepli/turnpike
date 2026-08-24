# Observations

Dated notes appended by the research loop.

## 2026-08-24T09:16:11.502Z

### Initial perf profile snapshot (bench workload)
```
# Overhead  Command          Shared Object                    Symbol                                                                                                                                                                                                                                                                          
    26.46%  spur             libc.so.6                        [.] __memmove_avx512_unaligned_erms
            |          
             --26.42%--__memmove_avx512_unaligned_erms
                       |          
                       |--6.92%--core::ptr::write (inlined)
                       |          |          
                       |           --6.82%--<T as core::clone::uninit::CopySpec>::clone_one (inlined)
                       |                     <T as core::clone::CloneToUninit>::clone_to_uninit (inlined)
                       |                     |          
                       |                     |--5.31%--alloc::sync::Arc<T,A>::make_mut
                       |                     |          
                       |                      --1.45%--alloc::sync::Arc<T,A>::make_mut
                       |          
                       |--6.53%--alloc::boxed::Box<T>::new (inlined)
                       |          alloc::sync::Arc<T>::new (inlined)
                       |          <archery::shared_pointer::kind::arc::ArcK as archery::shared_pointer::kind::SharedPointerKind>::new (inlined)
                       |          archery::shared_pointer::SharedPointer<T,P>::new (inlined)
                       |          |          
                       |          |--4.05%--imbl::vector::GenericVector<A,P>::promote_front
                       |          |          |          
                       |          |           --4.01%--imbl::vector::GenericVector<A,P>::push_back
                       |          |          
                       |           --1.91%--imbl::vector::GenericVector<A,P>::promote_front
                       |          
                       |--3.91%--<imbl_sized_chunks::sized_chunk::Chunk<A,_> as core::clone::Clone>::clone (inlined)
                       |          <T as core::clone::uninit::CopySpec>::clone_one (inlined)
                       |          <T as core::clone::CloneToUninit>::clone_to_uninit (inlined)
                       |          |          
                       |          |--2.81%--alloc::sync::Arc<T,A>::make_mut
                       |          |          
                       |           --1.10%--alloc::sync::Arc<T,A>::make_mut
                       |          
                       |--2.37%--<imbl_sized_chunks::sized_chunk::Chunk<A,_> as core::convert::From<&mut imbl_sized_chunks::inline_array::InlineArray<A,T>>>::from (inlined)
                       |          <T as core::convert::Into<U>>::into (inlined)
                       |          imbl::vector::GenericVector<A,P>::promote_front (inlined)
                       |          |          
                       |           --2.37%--imbl::vector::GenericVector<A,P>::push_back
                       |          
                        --1.16%--alloc::sync::Arc<T>::new (inlined)
                                  <archery::shared_pointer::kind::arc::ArcK as archery::shared_pointer::kind::SharedPointerKind>::new (inlined)
                                  archery::shared_pointer::SharedPointer<T,P>::new (inlined)
                                  |          
                                   --1.12%--imbl::vector::GenericVector<A,P>::promote_front

```

(publish selftest 2026-08-24T09:16:27.977Z)

## 2026-08-24T10:34:37.041Z

**orphan-message-purgatory** (closed): Screen run is degenerate, not merely negative: 5400 runs at 215/s but gradedRuns=0, depthAtLeast=[], h1/h2/h2b/h3 all exactly 0.0 and h2 delta -0.392 (i.e. baseline h2 ~0.39 -> 0). A mechanism that merely reorders delivery cannot zero out the grader; zero graded runs means histories stopped being produced/paired at all (porcupineWallMs=731 with nothing to check). Corroborating: the recorded diff touches only scheduler_configs/loop/general_vr.json — spurFiles is empty and no core/exec.rs / crash-path change is in superFiles. So either (a) the described implementation never landed and the unknown config key silently poisoned the run, or (b) holding orphaned in-flight messages past crash starves every client request so no operation ever completes -> nothing linearizable to grade. Either way the result is uninformative about the H2 hypothesis itself: we did not test 'stale-incarnation delivery raises depth>=5..7', we tested 'runs die'. Two process lessons: (1) a config-only diff for an add-kind hypothesis is a red flag the harness should catch before spending 25s x N seeds; (2) gradedRuns=0 should be an automatic invalid/re-run verdict rather than a scored comparison, since the objectiveDeltas computed here (all <=0) are artifacts of an empty grading set and should not be read as evidence against orphan holding. The underlying rationale (deliberately manufacturing dead-incarnation deliveries) is untouched and still plausible, but any retry must (i) actually implement the release-at-Recover path, (ii) bound hold duration so client ops can still complete, and (iii) assert gradedRuns>0 before reporting.
