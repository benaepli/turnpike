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
