# Caller attribution: spur 45517fd

Binary spur/target/release/spur (45517fd, frame pointers, debuginfo), graded
workload: scheduler_configs/loop/general_vr.json under `-e campaign` on
bin/spur/VR.spur, RAYON_NUM_THREADS=30, RUST_LOG=warn, 60 s.

## Read this first: the grader's recording cannot attribute callers

The grader records `perf record -F 199 --call-graph fp` with no `-e`, which
perf turns into `cycles:P` (precise_ip 2). On this Ryzen 9 9950X that event is
served by IBS. The sample IP is the precise instruction, but the callchain is
built from the interrupt registers, after skid. In the grader-shaped
recording, the interrupt callchain does not contain the self symbol's own
function in 47.2% of all samples. By symbol: make_unique 89.1%,
drop_glue<ValueKind> 93.2%, cfree 80.7%, malloc 79.6%, EcoVec drop 51.6%,
memmove 51.5%, _int_malloc 50.5%. So `perf report --no-children -S <sym> -g
caller` on a grader profile prints, under each symbol, mostly the stack of
whatever ran after that symbol.

Attribution below therefore uses two sources that are consistent:
- inclusive "who has this function's frame on the stack" reports, valid in
  any recording; the tables give them for the precise recording and for a
  non-precise one;
- self-sample caller chains from non-precise `-e cycles` recordings (frame
  pointer and DWARF), where the sample IP and callchain[0] agree.

The two events also weight time differently (next section), so the flat self
shares differ between them.

## Method (exact commands)

All from /home/benaepli/Rust/turnpike. D=tmp/loop/perf/attribution-45517fd.
Scripts are kept in $D/scripts/.

Config, the same as the grader's workloadConfig(template, PROFILE_SEED=1000,
wall 60): the template plus `session_seed: 1000` and
`campaign.wall_budget_sec: 60`, written to $D/profile.config.json. Each run is
bounded by the campaign wall budget (60.1 s wall), with an outer
`timeout -s KILL 180` in place of the grader's 60 s + 120 s SIGKILL cap.

Recordings, each launched with `setsid nohup` and a done-file, with nothing
else running:

    export RAYON_NUM_THREADS=30 RUST_LOG=warn
    # A: grader shape (cycles:P -> IBS). 309,959 samples, 412,080 runs
    perf record -F 199 --call-graph fp -o $D/fp.perf.data -- \
      spur/target/release/spur explore -e campaign --config $D/profile.config.json \
      -y --output-dir $D/profile-fp bin/spur/VR.spur
    # B: non-precise, frame pointer. 316,163 samples, 429,300 runs
    perf record -e cycles -F 199 --call-graph fp -o $D/fpnp.perf.data -- (same explore)
    # C: non-precise, DWARF, full 60 s run. 79,454 samples, 1.26 GB, 424,980 runs
    perf record -e cycles -F 49 --call-graph dwarf,16384 -o $D/dwarfnp.perf.data -- (same explore)

A precise DWARF recording was made first and dropped when the IBS skid
problem showed up. `perf script` on DWARF data stalls unless it runs with
`--no-inline` and `DEBUGINFOD_URLS=` (it spawns addr2line per inline frame).
LBR was not tried, because DWARF worked.

Flat self (the grader's report command):

    perf report --stdio --percent-limit 1 --no-children --no-inline -g none -i X | rustfilt

Caller chains. Stacks were aggregated from perf script instead of
`perf report -S`, because -S needs the mangled v0 names and the walk to a
spur_core frame plus line lookup needs raw stacks:

    DEBUGINFOD_URLS= perf script --no-inline -i X -F comm,tid,period,ip,sym,symoff,dso \
      | python3 scripts/collect.py X.pkl
    nm --defined-only spur/target/release/spur | rustfilt > symtab    # symbol addresses
    python3 scripts/analyze.py X.pkl symtab LABEL make_unique,make_unique_incl,...
    # precise sample IPs of recording A, for the skid check and in-function split:
    perf script --no-inline -i $D/fp.perf.data -G -F ip,sym,symoff,dso > fp-sampleip.txt
    python3 scripts/reconcile.py fp.pkl fp-sampleip.txt fp-precise.pkl

analyze.py weights by period. For each sample it walks up from the leaf to the
first frame under `spur_core::simulator::` that is not a value helper
(drop_glue, Clone, Drop, Hash, cmp, `values::`); that frame is the anchor.
The anchor's return address minus 1 goes through
`llvm-addr2line -i --output-style=JSON`. Source locations are printed as the
inline chain of spur-core lines, innermost first. For example,
`values.rs:746 < exec.rs:954 < exec.rs:1584` means `Env::set` inlined into
`Op::AssignNode` inlined into exec_ops' run_common_op call. Shares are percent
of all samples (every thread), then percent of that symbol.

## Sanity: recording A is the 45517fd workload

Flat self, percent, from the same report command:

| symbol | 45517fd.md | A (cycles:P, fp) | B (cycles, fp) | C (cycles, dwarf)* |
|---|---|---|---|---|
| ceval | 7.39 | 7.25 | 7.68 | 7.70 |
| exec_ops (RecordRng) | 5.34 | 5.28 | 5.15 | - |
| schedule_runnable (RecordRng) | 4.85 | 4.93 | 6.56 | - |
| memmove (spur threads) | 3.41 | 3.38 | 5.92 | 5.89 |
| memmove (parquet writer) | 1.08 | 1.06 | 1.04 | 1.07 |
| run_sync_ops (RecordRng) | 2.73 | 2.65 | 2.62 | - |
| EcoVec<Value>::make_unique | 2.03 | 1.99 | <1 (0.62) | 0.66 |
| format_escaped_str | 1.73 | 1.74 | 1.24 | - |
| _int_malloc | 1.68 | 1.58 | <1 | 1.12 |
| exec_plan (RecordRng) | 1.67 | 1.67 | 1.75 | - |
| cfree | 1.59 | 1.59 | <1 | 0.73 |
| walk_recovery_placebo | 1.59 | 1.66 | 1.79 | 1.82 |
| drop_glue<ValueKind> (largest instance) | 1.52 | 1.52 | 2.75 | - |
| EcoVec<Value> drop | 1.42 | 1.41 | 2.27 | 2.20 |
| parquet Int64 interner | 1.33 | 1.28 | 1.25 | - |
| Value::write_to | 1.28 | 1.20 | <1 | - |
| malloc | 1.17 | 1.16 | 2.48 | 2.54 |

\* C is from the script aggregation, merged across generic instances; "-"
means that merge is not comparable.

A reproduces 45517fd.md to within about 0.1 on every line: same workload,
same binary.

B and C are the same workload under the non-precise event. The large moves
(memmove 3.4 to 5.9, malloc 1.2 to 2.5, make_unique 2.0 to 0.6, the
Arc<GenericNode>::make_mut line appearing at 1.27) are consistent with IBS
sampling by executed operations rather than by cycles. A rep-movsb copy or a
cache-missing allocator is few operations but many cycles, while a short
out-of-line function with a 6-register prologue is many operations. NMI skid
in B and C also moves some samples one or two instructions later. This is my
reading of the evidence, not checked against the kernel source. It matters
for pricing: the grader's profiles, and the guards frozen from them,
under-count memmove and allocator time and over-count call-heavy small
functions, relative to wall-clock cycles.

## EcoVec<Value<NoHashing>>::make_unique

Self: 1.99 in A (IBS) and 0.62 in B (cycles). Inclusive: 0.95 in A, 0.97 in B,
1.05 in C.

Callers of the make_unique frame (percent of make_unique inclusive):

| chain (all through values.rs:746 `self.slots.make_mut()[idx] = value` in Env::set) | A incl | B incl | C incl |
|---|---|---|---|
| Op::AssignNode `node_env.set` exec.rs:954, in run_sync_ops (exec.rs:1428) | 40.4 | 37.6 | 36.8 |
| Op::AssignNode exec.rs:954, in exec_ops (exec.rs:1584) | 29.9 | 32.4 | 33.0 |
| Op::AssignLocal `set_local` exec.rs:949 -> eval.rs:97, in exec_ops | 11.5 | 13.0 | 10.7 |
| Op::AssignLocal exec.rs:949 -> eval.rs:97, in run_sync_ops | 9.7 | 8.0 | 8.9 |
| exec @ exec.rs:851 (exec_ops frame not yet on the stack) | 3.0 | 3.2 | 3.8 |
| store_dest Local exec.rs:883 after SyncCall (997), channel (1022), async send (1173), trace enter (1297) | 1.9 | 2.2 | 2.1 |
| eval::store into a waiting reader (eval.rs:85/108, exec.rs:1534, state.rs:1687) | 0.6 | 1.6 | 1.8 |

Node-slot writes are about 70% and local-slot writes about 21%. Every call
comes from one line, `Env::set`'s `make_mut()`, which runs on every slot
write whether or not the buffer is shared.

Where inside make_unique the self samples fall:

| part | A (IBS precise IP, 6,097 samples) | B (cycles leaf, 1,930 samples) |
|---|---|---|
| entry + `is_unique` refcount load and test (vec.rs:726-727, 778, atomic load, ptr::eq) | 67.2% | 25.6% |
| return on the already-unique fast path (vec.rs:730 epilogue) | 21.4% | 18.4% |
| copy: `Self::from(as_slice)` (ptr::write mod.rs:1939, Value clone values.rs:59-62, push_unchecked) | 10.2% | 50.2% |

In B the inclusive children under make_unique are also copy work:
ValueKind::clone 25%, EcoVec drop 5%, malloc 3%.

Disassembly agrees: the function pushes six registers, loads the header
refcount at -0x10(ptr), and returns immediately when it is 1. Value is 40
bytes (lea r*5*8).

## imbl GenericHashMap<Value,Value>::insert

Inclusive: 3.32 in A (45517fd.md read 3.72), 3.17 in B, 3.38 in C. Self 0.16
in A.

| caller | A incl | B incl | C incl |
|---|---|---|---|
| map literal `CExpr::Map` compiled_eval.rs:207 `m.insert(k, v)` on a fresh ValueMap::new | 78.4 | 76.7 | 75.8 |
| Store `update_collection` eval.rs:240 `m.update(key, val)` (CExpr::Store, compiled_eval.rs:378) | 21.1 | 22.6 | 23.8 |

Self time carried under insert (percent of insert inclusive):

| callee | A | B | C |
|---|---|---|---|
| Arc<GenericNode>::make_mut | 42.3 | 38.7 | 32.7 |
| malloc | 28.0 | 21.9 | 20.3 |
| malloc_consolidate | 6.4 | 13.9 | 13.1 |
| _int_malloc | 6.8 | 7.6 | 8.0 |
| memmove | 4.4 | 4.6 | 14.2 |
| Value::compute_sig | 3.2 | 4.4 | 4.0 |
| insert self | 4.7 | 3.4 | 3.6 |

A's callee split carries skid; B and C agree with each other. Callers of
Arc<GenericNode>::make_mut (B, 1.73 inclusive): insert from the map literal
64.2, insert from Store 31.7, `without` in MapErase compiled_eval.rs:289 3.1,
run_for_loop_in exec.rs:1266 1.0.

## memmove (__memmove_avx512_unaligned_erms)

Self: 3.38 + 1.06 (writer) in A, 5.89 + 1.07 in C. From C, DWARF, where every
spur-thread memmove sample unwound to a spur_core frame. The top 30 anchors
cover 91.2%; percent of all memmove including the writer thread:

| anchor and line | what is copied | % |
|---|---|---|
| history::write_batch history.rs:577 (parquet writer thread: byte-array gather, realloc growth, snappy, add_data_page) | column buffers | 13.7 |
| run_async_op exec.rs:1215 `state.push_runnable(Runnable::Record(new_record))` | new RPC Record moved into a queue | 9.4 |
| ChannelState::push_waiting_reader state.rs:460 `Arc::new((record, lhs))` | parked Record | 7.5 |
| exec exec.rs:855 (the `record` argument to exec_ops) | Record by value | 7.3 |
| json_string_array text_buffer.rs:46 < :39 < exec.rs:75 | trace payload JSON text | 6.0 |
| schedule_runnable scheduler.rs:1292 -> State::take_local state.rs:1176 `local_queues[node].remove(idx)` | queue shift + Runnable out | 6.0 |
| schedule_runnable scheduler.rs:1483 (`other =>` arm) | Runnable move | 4.9 |
| ceval compiled_eval.rs:207 (map literal insert) | HAMT node | 4.4 |
| run_trace_dispatch exec.rs:1379 -> write_trace_payload exec.rs:47 | trace text | 3.7 |
| schedule_runnable scheduler.rs:1271 (`let (runnable, slot, mask) = match selection`) | Runnable move | 3.5 |
| update_collection eval.rs:240 | HAMT node | 2.5 |
| ChannelState::pop_waiting_reader state.rs:468 | Record out of Arc | 2.3 |
| State::push_runnable | Runnable into Vec | 1.9 |
| schedule_runnable scheduler.rs:1702 (`r` passed to exec) | Record by value | 1.8 |
| State::take_network state.rs:1167 `network_queue.remove(idx)` | queue shift | 1.7 |
| ceval compiled_eval.rs:126-127 (string `+` push_str) | string bytes | 2.9 |
| RecordRng::into_recording rng.rs:244; Continuation::call state.rs:1684; exec_ops send-to-reader exec.rs:1531; insert_channel state.rs:98<1112<exec.rs:1172; trace enter push_str exec.rs:1305 | misc | 1.1 each |
| IntToString compiled_eval.rs:358; scheduler.rs:1366; rng random_range; scheduler.rs:1534, 1453; writer_loop history.rs:716/721 | misc | 0.6-0.9 each |

Grouped: moving Record/Runnable by value through queues, Arcs and call
arguments is about 48% of all memmove (about 3.4 cycle-points; 57% of the
spur threads' memmove). The parquet writer is 14-15%, trace payload text
about 11%, imbl map inserts about 7%, and string building about 4%.

Frame-pointer fallback, for reference: the FP chains skip memmove's
immediate caller, because glibc memmove sets up no frame. They name
exec_plan (19.8%) and exec_ops (17.0%) as "callers", which are the
grandparents of the DWARF sites above.

## malloc / _int_malloc / realloc

malloc self: 1.16 in A, 2.54 in C. From C (percent of malloc self), with B
inclusive (4.02) and A inclusive (4.75) alongside:

| anchor and line | C self | B incl | A incl |
|---|---|---|---|
| map literal insert compiled_eval.rs:207 | 19.4 | 27.2 | 23.4 |
| schedule_runnable local `eligible` Vec collect scheduler.rs:1276 | 12.4 | 10.2 | 20.6 |
| string `+` EcoString::with_capacity compiled_eval.rs:125 | 11.3 | 8.6 | 8.1 |
| Store map update eval.rs:240 (incl. Arc clone_from_ref_in) | 7.5 | 8.5 | 6.4 |
| QueueInfo `local_queue_sizes` collect scheduler.rs:1195 | 6.1 | 4.9 | 4.8 |
| run_async_op `arg_vals` EcoVec::with_capacity exec.rs:1162 | 5.3 | 3.8 | 4.0 |
| build_frame FrameBuilder::new eval.rs:125 < :185 (async callee frame, Record::reset) | 5.0 | 3.8 | 3.0 |
| network `eligible` Vec collect scheduler.rs:1301 | 4.4 | 4.7 | 7.2 |
| SyncCall FrameBuilder::new exec.rs:976 (exec_ops 4.0 + run_sync_ops 2.2) | 6.2 | 5.0 | 3.2 |
| exec_plan TimerFired `payload: vec![..]` path.rs:1039 | 3.9 | 3.6 | 2.8 |
| run_trace_dispatch `Box::from(payload)` exec.rs:1385 | 3.9 | 4.1 | 3.2 |
| parquet writer write_batch history.rs:577 | 2.0 | 3.0 | 2.1 |
| push_waiting_reader `Arc::new` state.rs:460 | 1.7 | 1.4 | 1.2 |
| timer `eligible` collect scheduler.rs:1350 | 1.0 | - | 1.8 |

_int_malloc (C self 1.12), percent: network eligible collect scheduler.rs:1301
17.7 (through _int_realloc: the filtered collect grows by realloc), map literal
207 15.3, Store 240 8.6, local eligible 1276 7.4, generate_plan
generator.rs:77 < :140 6.9 (`actions.push` growth), write_batch 6.7, string
`+` 125 4.4, trace Box 1385 3.5, path.rs:1039 3.2, build_frame 3.2.

realloc (C self 0.56): 76.8% is the network `eligible` collect,
scheduler.rs:1301.

Grouped: the scheduler's per-step index Vecs (eligible lists at 1276, 1301
and 1350, plus local_queue_sizes at 1195) take about a quarter of malloc
and three quarters of realloc. Map literals take about a fifth. Frames and
argument vectors for calls are about 15%, string concatenation about 10%,
Store about 8%, and trace and history payload boxes about 8%.

## cfree

Self: 1.59 in A, 0.73 in C. Inclusive: 2.09 in B, 2.20 in A; _int_free_chunk
carries 58% of the inclusive time.

| anchor and line | C self | B incl | A incl |
|---|---|---|---|
| schedule_runnable function exit scheduler.rs:1788 (per-step temporaries, e.g. QueueInfo sizes) | 25.9 | 11.5 | 15.0 |
| schedule_runnable network arm end scheduler.rs:1329 (`eligible` dropped) | 12.4 | 11.1 | 11.3 |
| exec_ops exit exec.rs:1614 (segment's frame/record dropped) | 9.6 | 6.3 | 6.4 |
| AssignLocal old slot value dropped, values.rs:746 < eval.rs:97 < exec.rs:949 (exec_ops 9.4, run_sync_ops 2.1) | 11.5 | 8.5 | 7.7 |
| schedule_runnable local arm end scheduler.rs:1296 (`eligible` dropped) | 8.8 | 3.6 | 5.2 |
| SyncCall arm end exec.rs:999 (callee frame dropped; exec_ops 5.7, run_sync_ops 3.8) | 9.5 | 4.5 | 4.3 |
| Return writeback exec.rs:1605 `state.nodes[i] = node_env` | 3.2 | 4.9 | 4.7 |
| end-of-run teardown explorer.rs:1189 | 3.0 | 16.9 | 15.5 |
| store_dest Local after SyncCall exec.rs:883 < :997 | - | 6.7 | 6.4 |

## core::ptr::drop_glue::<ValueKind<NoHashing>>

Self: 1.52 (largest instance) in A; 3.34 in B and 3.36 in C across all
instances. Percent of self in C, with B and A inclusive alongside:

| anchor and line | C self | B incl | A incl |
|---|---|---|---|
| AssignLocal: previous local slot value dropped by `make_mut()[idx] = value`, values.rs:746 < eval.rs:97 < exec.rs:949, in exec_ops | 48.5 | 49.0 | 43.0 |
| same, in run_sync_ops | 17.7 | 18.4 | 17.9 |
| store_dest Local after SyncCall exec.rs:883 < :997 | 6.1 | 5.1 | 6.4 |
| ceval temporaries (no line; compiled_eval.rs:135, 180 about 1.5) | 5.4 | 5.7 | 7.2 |
| run_async_op channel store_dest exec.rs:883 < :1173 | 3.4 | 3.1 | 4.9 |
| AssignNode exec.rs:954 (run_sync_ops 2.9, exec_ops 1.4) | 4.3 | 3.9 | 4.4 |
| channel store_dest in run_sync_ops exec.rs:883 < :1022 | 2.6 | 3.3 | 3.1 |
| run_trace_dispatch exec.rs:47 < :1379 | 1.4 | 1.3 | 1.7 |

## <EcoVec<Value<NoHashing>> as Drop>::drop

Self: 1.41 in A, 2.20 in C, 2.27 in B. Inclusive: 3.64 in B, 3.81 in A.

| anchor and line | C self | B incl | A incl |
|---|---|---|---|
| exec_ops exit exec.rs:1614 (frame/record dropped at return) | 25.9 | 28.2 | 27.8 |
| Return writeback exec.rs:1605 `state.nodes[i] = node_env` (old node env dropped) | 16.7 | 20.8 | 22.6 |
| recv-wait writeback exec.rs:1561 `state.nodes[i] = node_env` | 15.7 | 12.7 | 10.4 |
| SyncCall arm end exec.rs:999 (callee frame; exec_ops 10.5, run_sync_ops 6.3) | 16.8 | 16.2 | 15.5 |
| Continuation::call writeback state.rs:1690 | 3.2 | 1.9 | 4.0 |
| send-to-waiting-reader writeback exec.rs:1535 | 3.2 | 1.9 | 3.2 |
| AssignLocal / AssignNode make_mut (values.rs:746) | 6.8 | 5.4 | 3.7 |
| run_trace_dispatch exec.rs:47 < :1379 | 2.3 | 1.3 | 1.2 |
| timer completion writeback scheduler.rs:1464 | 2.0 | 1.2 | 1.9 |
| end-of-run teardown explorer.rs:1189 | 1.9 | 6.6 | 4.6 |

Node-env writebacks (1605, 1561, 1535, state.rs:1690, scheduler.rs:1464) are
about 41% of the self time.

## Summary

make_unique is not mostly copying. Its callers are one line: `Env::set`'s
`self.slots.make_mut()[idx] = value` (values.rs:746), hit on every slot
write. That is about 70% AssignNode (exec.rs:954) and about 21% AssignLocal
(exec.rs:949).

In the grader's IBS profile, about 88% of make_unique's self samples are the
out-of-line call itself: the prologue, the refcount load and test, and the
return on a buffer that is already unique. Only about 10% are the copy. A
cycles-weighted profile shows the copy as half of a smaller self share,
plus ValueKind::clone under it.

This fits the closed candidate. Detaching the node env removed the copies
(make_unique 2.03 to 1.69, and reserve left) but not the per-write make_mut
call, which carries most of the IBS line. Anything priced against that line
has to remove the call or the check on unique writes, not only the sharing.

imbl insert is mostly map literals: `CExpr::Map` building a fresh map by
repeated insert (compiled_eval.rs:207), 76-78% of its inclusive time. Store
(eval.rs:240) is 21-24%. Its cost is HAMT node allocation and init
(Arc::make_mut, malloc, malloc_consolidate). The in-place update candidate
only reached the Store share, which fits insert staying near 3.1.

memmove comes from four places:
- about half: moving Record and Runnable values by value, at
  `push_runnable(Runnable::Record(..))` for every RPC (exec.rs:1215),
  `Arc::new((record, lhs))` when parking a reader (state.rs:460), the
  `record` argument into exec_ops (exec.rs:855), `Vec::remove` in
  take_local/take_network, and the scheduler's match moves (scheduler.rs:1271,
  1483, 1702);
- 14-15%: the parquet writer;
- about 11%: trace payload JSON text;
- the rest: imbl nodes (about 7%) and strings.

Allocator traffic:
- malloc/realloc: the scheduler's per-step index Vecs (`eligible` at
  scheduler.rs:1276/1301/1350 and `local_queue_sizes` at 1195: about a
  quarter of malloc, three quarters of realloc via the growing network
  collect), map literals (about a fifth), call frames and argument vectors
  (about 15%), string `+` (about 10%), Store (about 8%), trace and history
  payload boxes (about 8%).
- cfree mirrors this: the scheduler temporaries dropped at 1788/1329/1296
  (about 47% of self), frames dropped at exec_ops exit and SyncCall end, old
  local values overwritten, and end-of-run teardown (17% of inclusive).
- drop_glue<ValueKind> is two thirds the old value dropped by AssignLocal.
- EcoVec drop is 41% node-env writebacks and 43% frame drops.

Method caveat for the loop: the profile guards read grader profiles, which
are IBS-weighted and whose `-g` call stacks skid. Price call-heavy lines
(make_unique) against the IBS numbers. Price memmove and allocator lines
against a cycles recording, where they are roughly twice as large. Take
callers only from inclusive frames or from a `-e cycles` recording.

## Files kept

$D/fp.perf.data (A, 57 MB), $D/fpnp.perf.data (B, 58 MB), the flat reports
fp-flat.txt and fpnp-flat.txt, the analysis outputs fp-analysis.txt (A leaf
chains, skid-affected, kept for comparison), fp-incl-analysis.txt,
fpnp-analysis.txt and dwarfnp-analysis.txt, and scripts/. Deleted:
dwarfnp.perf.data (1.26 GB), both explorer output directories and their
sidecar JSONs, the warning logs, and the regenerable intermediates
(.pkl, sample IP list, symtab).
