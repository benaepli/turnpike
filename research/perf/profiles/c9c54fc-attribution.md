# Caller attribution: spur c9c54fc

Binary spur/target/release/spur (c9c54fc, frame pointers, debuginfo). Graded
workload: scheduler_configs/loop/general_vr.json under `-e campaign` on
bin/spur/VR.spur, RAYON_NUM_THREADS=30, RUST_LOG=warn, 60 s. Every recording
uses plain `-e cycles`, the event the grader's recordProfile now uses.

## Method (exact commands)

All from /home/benaepli/Rust/turnpike. D=tmp/loop/perf/attribution-c9c54fc.
Scripts are kept in $D/scripts/.

Config: the same as the grader's workloadConfig(template, PROFILE_SEED=1000,
wall 60), which is the template plus `session_seed: 1000` and
`campaign.wall_budget_sec: 60`. It was written to $D/profile.config.json and
is key-for-key identical to the 45517fd attribution's config.

Recordings ($D/scripts/record.sh, one `setsid nohup` job, run one after the
other with nothing else running):

    export RAYON_NUM_THREADS=30 RUST_LOG=warn
    # FP: grader shape. 315,681 samples, 455,460 runs in 60.1 s
    timeout -s KILL 180 perf record -e cycles -F 199 --call-graph fp -o $D/fp.perf.data -- \
      spur/target/release/spur explore -e campaign --config $D/profile.config.json \
      -y --output-dir $D/profile-fp bin/spur/VR.spur
    # DWARF: 79,500 samples, 1.26 GB, 448,680 runs in 60.1 s
    timeout -s KILL 240 perf record -e cycles -F 49 --call-graph dwarf,16384 -o $D/dwarf.perf.data -- (same explore, --output-dir $D/profile-dwarf)

Flat self (the grader's report command):

    perf report --stdio --percent-limit 1 --no-children --no-inline -g none -i $D/fp.perf.data | rustfilt

Stacks. They were aggregated from perf script rather than `perf report -S`,
as in the previous attribution, because the walk to a spur_core frame and the
line lookup need raw stacks:

    DEBUGINFOD_URLS= perf script --no-inline -i X -F comm,tid,period,ip,sym,symoff,dso | python3 scripts/collect.py X.pkl
    nm -S --defined-only spur/target/release/spur | rustfilt > symtab
    python3 scripts/analyze2.py X.pkl symtab LABEL ValueKind_clone,drop_ValueKind,EcoVec_drop,make_mut_arc_hamt,make_unique,malloc,_int_malloc,cfree,_int_free_chunk,realloc
    python3 scripts/analyze2.py dwarf.pkl symtab dwarf memmove:spur,memmove
    python3 scripts/analyze2.py fp.pkl symtab fp ValueKind_clone:leaf,ValueKind_clone:sites,drop_ValueKind:leaf,drop_ValueKind:sites,EcoVec_drop:sites
    python3 scripts/crosstab.py scripts/analyze2.py fp.pkl symtab ValueKind_clone   # kind at sample IP x call site
    # plus an llvm-objdump of each hot function with a histogram of sample offsets per instruction

analyze2.py extends the 45517fd analyze.py. The anchor rule is unchanged: walk
up from the leaf to the first frame under `spur_core::simulator::` that is
not a value helper (drop_glue, Clone, Drop, Hash, cmp, `values::`). Take that
anchor's return address minus 1 through `llvm-addr2line -i`, and print the
spur-core inline chain innermost first: `values.rs:746 < eval.rs:97 <
exec.rs:949` is Env::set inlined into set_local inlined into Op::AssignLocal.
Shares are weighted by period. Rows are "percent of all samples, percent of
the symbol".

The self-frame check has two parts:
- (a) whether the sampled function appears again above the leaf, meaning recursion;
- (b) for callchain[1], reading the call instruction that ends at the return
  address from the ELF and resolving its target.

"Direct call to the sampled function" means the immediate caller is correctly
on the stack. "Direct call to another function" means a frame was skipped:
either a sample taken before the callee's `push rbp`, or a tail call. With
plain cycles the sample IP is always callchain[0], so the IBS skid problem of
45517fd-attribution.md does not arise here.

## Sanity: the FP recording is the c9c54fc.md workload

Flat self, percent. The c9c54fc.md column is from its self table, or from its
inclusive table's self column for the rows under 1%.

| symbol | c9c54fc.md | FP (this) | diff | DWARF |
|---|---|---|---|---|
| ceval | 8.35 | 8.44 | +0.09 | 8.11 |
| memmove (spur threads) | 6.37 | 6.32 | -0.05 | 6.27 |
| exec_ops (largest instance) | 5.46 | 5.38 | -0.08 | 5.54 |
| schedule_runnable (largest) | 3.44 | 3.44 | 0.00 | 3.32 |
| drop_glue<ValueKind> (largest) | 3.05 | 3.10 | +0.05 | 3.12 |
| run_sync_ops (largest) | 2.80 | 2.76 | -0.04 | 2.83 |
| EcoVec<Value> drop | 2.49 | 2.56 | +0.07 | 2.54 |
| malloc | 2.19 | 2.13 | -0.06 | 2.27 |
| ValueKind::clone (largest) | 1.99 | 1.95 | -0.04 | 1.94 |
| exec_plan (largest) | 1.81 | 1.88 | +0.07 | 1.83 |
| walk_recovery_placebo | 1.80 | 1.81 | +0.01 | 1.80 |
| format_escaped_str | 1.42 | 1.44 | +0.02 | 1.51 |
| Arc<GenericNode>::make_mut | 1.34 | 1.35 | +0.01 | 1.36 |
| parquet Int64 interner | 1.35 | 1.33 | -0.02 | 1.39 |
| memmove (parquet writer) | 1.16 | 1.21 | +0.05 | 1.22 |
| _int_malloc | 0.88 | 0.85 | -0.03 | 0.88 |
| make_unique | 0.78 | 0.76 | -0.02 | 0.73 |
| cfree | 0.39 | 0.37 | -0.02 | 0.39 |

The largest difference is 0.09, so this is the same workload on the same
binary.

The flat report lists generic instances separately, so its lines understate
three of the target families. Merged across instances, from the FP stacks:

| family | largest instance | all instances |
|---|---|---|
| ValueKind::clone | 1.95 | 3.07 (1.95 + 0.61 + 0.50) |
| drop_glue<ValueKind> | 3.10 | 3.79 (DWARF 3.92) |
| _int_free_chunk | - | 0.96 |

Every table below uses the merged figure.

Self-frame check (FP, percent of the symbol's self samples):

| symbol | direct call to it | frame skipped (target) | indirect call | recursion |
|---|---|---|---|---|
| ValueKind::clone | 95.5 | 3.6 (exec_ops 1.2, ceval 0.9, run_sync_ops 0.7, build_frame 0.3) | 0.9 | 0 |
| drop_glue<ValueKind> | 92.7 | 7.2 (nested drop_glue 4.3, exec_ops 1.1, ceval 1.0, run_sync_ops 0.7) | 0 | 0 |
| EcoVec<Value> drop | 83.4 | 16.4 (tail call from drop_glue 15.9) | 0 | 8.1 |
| Arc<GenericNode>::make_mut | 98.4 | 1.6 (GenericHashMap::insert) | 0 | 0 |
| make_unique | 89.9 | 9.3 (exec_ops 4.9, run_sync_ops 2.9, store 1.5) | 0.8 | 0 |
| malloc | - | 0.8 | 92.1 (call through the GOT) | 0 |
| cfree | - | 11.6 (tail calls from drop_glue 5.8, EcoVec drop 1.6) | 87.9 | 0 |

What the check shows:
- **glibc malloc and free:** on this host they keep frame pointers, so the FP
  chains through them are sound.
- **_int_malloc and _int_free_chunk:** callchain[1] is malloc or cfree in 98-100%
  of samples, so their chains simply continue through that frame.
- **memmove:** it builds no frame, so its callers come from DWARF only.
- **Tail calls:** a skipped frame caused by a tail call still anchors at the
  right Spur operation.
- **Samples before `push rbp`:** these anchor one level too high. They show up
  as the rows "exec @ exec.rs:851" (a call into exec_ops) and "exec_ops @
  exec.rs:981/1114" (calls into run_sync_ops or run_trace_exit). Those rows
  are about 1-5% per symbol and are marked below.

FP and DWARF agree on the anchors within about 2 points for every symbol
except EcoVec<Value> drop. DWARF could not unwind that one: 92.5% of its
samples end at [unknown] with no spur frame. Its table is from FP only.

## ValueKind<NoHashing>::clone

Self 3.07 (all instances). DWARF: 3.07.

### Which kinds are cloned

These are the sample offsets inside the hot instance, 0x9af6c0, which holds
80.1% of the samples. Percent of all clone samples:

| part of the function (instruction) | % |
|---|---|
| Map arm: imbl root `Option<SharedPointer>` clone; 34.9 on the instruction right after `lock incq (%rcx)` on the root node's refcount | 37.4 |
| entry and jump-table dispatch (10.4 after the table load, 4.5 after the discriminant byte load) | 20.6 |
| Channel / Node / FifoLink plain 24-byte copy | 8.3 |
| List / Tuple: EcoVec header refcount `lock incq` | 7.7 |
| Int | 3.5 |
| empty EcoVec or EcoString sentinel path, String arm, Option arm, Bool, epilogue | 2.6 |
| other instances (addr2line over all instances: Map 44.9, EcoVec 13.4, String 0.9, Channel 1.5, dispatch and scalars 38.8) | 19.9 |

So about 45% of clone time is an atomic increment on an imbl map root.
Structs are maps in Spur: `StructLit` lowers to `Expr::Map` with string field
keys, at compiler/cfg.rs:1186-1194. That increment sits on a stalled
instruction, consistent with a cold node header. About 13% is the EcoVec
refcount of lists and tuples. Strings are under 1%. The rest, about 40%, is
dispatch plus scalar copies. A Value is 40 bytes and ValueKind 32.

### Call sites and classification

FP, percent of clone self. The Map column is the part of that row's samples
whose IP is in the Map arm.

| class | site | line | % | Map |
|---|---|---|---|---|
| store | Op::AssignLocal, rhs a local slot (slot to slot), exec_ops | compiled_eval.rs:76 < exec.rs:948 < :1584 | 15.5 | 10.2 |
| store | same, run_sync_ops | compiled_eval.rs:76 < exec.rs:948 < :1428 | 7.1 | 5.2 |
| store | Op::AssignLocal, rhs a node slot (exec_ops 3.4, run_sync_ops 1.8) | compiled_eval.rs:80 < exec.rs:948 | 5.2 | 0.3 |
| store | Op::AssignNode, rhs a local slot | compiled_eval.rs:76 < exec.rs:953 | 1.0 | 0 |
| store | copy-on-write of the node env: EcoVec::make_unique under Env::set on AssignNode (exec_ops 4.7, run_sync_ops 4.1) | values.rs:746 < exec.rs:954 | 8.8 | 3.8 |
| store | CExpr::Store: the collection operand is cloned out of its slot, so the map is shared when it is updated | compiled_eval.rs:80 < :375 | 2.0 | 1.8 |
| store | map or struct literal keys and values | compiled_eval.rs:76 < :207 | 1.8 | 0.3 |
| store | for-in iterator slot | exec.rs:1233, 1236 | 0.7 | 0.1 |
| frame | build_frame: async callee parameters copied from arg_vals (called at exec.rs:1176) | eval.rs:194 < :197 | 10.7 | 3.9 |
| message | run_async_op: arguments evaluated into arg_vals, which becomes Record.initial_args | compiled_eval.rs:76 < exec.rs:1164 | 9.1 | 4.5 |
| frame | Op::Return value (exec_ops 7.7, run_sync_ops 5.7) | compiled_eval.rs:76 < exec.rs:970 | 13.4 | 5.6 |
| frame | Op::SyncCall arguments (exec_ops 4.9, run_sync_ops 0.2) | compiled_eval.rs:76 < exec.rs:978 | 5.1 | 4.3 |
| message | Op::Send value | compiled_eval.rs:76 < exec.rs:1504 | 2.8 | 2.7 |
| read | CExpr::Find on a list, element `.cloned()` | compiled_eval.rs:220 | 5.4 | 1.2 |
| read | CExpr::FieldGet on a map | compiled_eval.rs:236 | 1.5 | 0.3 |
| read | CExpr::Find on a map | compiled_eval.rs:216 | 0.4 | - |
| read | trace dispatch payload: cloned, formatted to text, dropped | exec.rs:47 < :1379 | 3.1 | 0.3 |
| read | trace exit payload | exec.rs:1343, 1344 | 0.7 | - |
| (skipped frame) | exec @ exec.rs:851, exec_ops @ exec.rs:1114 / 981 | | 2.4 | |
| (smaller rows, under 0.3 each) | | | 3.3 | |

Totals by class:

| class | % of clone self | points |
|---|---|---|
| store | 42.1 | 1.29 |
| frame / message / return | 41.1 | 1.26 |
| read | 11.1 | 0.34 |

What a candidate would price against:
- **Op::Return (13.4, 0.41 points).** The value is cloned out of a frame slot,
  and that frame is dropped right after, at exec.rs:1614 or :999. A move
  would remove this increment and the matching decrement in the frame drop.
- **Async RPC arguments are cloned twice.** The first copy goes into arg_vals
  at exec.rs:1164 and is kept as Record.initial_args. The second goes into the
  callee frame in build_frame at exec.rs:1176. Together that is 19.8% (0.61
  points), plus two mallocs: FrameBuilder at eval.rs:125 < :185 (0.12) and
  arg_vals at exec.rs:1162 (0.10). initial_args' own doc comment says it exists
  to avoid carrying a second copy of the frame, yet the frame is still built
  at send.
- **Op::AssignLocal slot-to-slot copies (27.8, 0.85 points).** The profile
  cannot tell whether the source slot is dead afterwards, which is what a move
  would need. The same slot write drops the old value; see drop_glue below.
- **Stall caveat.** The Map share sits on a stalled `lock incq`. If the stall
  is a cache miss on the node header, removing the increment moves the miss to
  the next reader of that node. Price it against a measured change, not
  against this share.

## core::ptr::drop_glue::<ValueKind<NoHashing>>

Self 3.79 (FP, all instances), 3.92 (DWARF).

What is dropped, by sample IP:

| kind | % |
|---|---|
| heap EcoString, the refcount decrement at ecow vec.rs:806 reached through DynamicVec::drop | 41.8 |
| imbl map root Arc decrement | 24.5 |
| dispatch and other | 32.9 |
| Option / Variant payload Arc | 0.7 |

| site | line | FP | DWARF | String | Map |
|---|---|---|---|---|---|
| AssignLocal: old local slot value dropped by `make_mut()[idx] = value`, exec_ops | values.rs:746 < eval.rs:97 < exec.rs:949 < :1584 | 48.6 | 44.7 | 28.8 | 10.1 |
| same, run_sync_ops | ... < exec.rs:949 < :1428 | 19.6 | 17.7 | 8.4 | 3.4 |
| ceval temporaries (no line; compiled_eval.rs:180, 135, 160, 219 add 2.0) | | 5.5 | 6.1 | 4.3 | 0 |
| store_dest Local after SyncCall (exec_ops 4.8, run_sync_ops 1.0) | exec.rs:883 < :997 | 5.8 | 5.4 | 0.1 | 3.2 |
| run_async_op store_dest of the channel value | exec.rs:883 < :1173 | 2.9 | 3.2 | 0 | 2.5 |
| run_sync_ops channel store_dest | exec.rs:883 < :1022 | 2.9 | 2.5 | 0 | 2.8 |
| AssignNode (run_sync_ops 2.3, exec_ops 1.0) | values.rs:746 < exec.rs:954 | 3.3 | 3.1 | 0 | 1.8 |
| end-of-run teardown | explorer.rs:1189 | 1.5 | 2.0 | | |
| trace dispatch | exec.rs:47 < :1379 | 1.4 | 1.4 | | |
| (skipped frame) exec @ exec.rs:851 | | 1.1 | 1.5 | | |

Two thirds is the value overwritten in a local slot by AssignLocal, and more
than half of that is heap strings. Maps overwritten by store_dest after calls
and channel stores make up most of the rest.

## <EcoVec<Value<NoHashing>> as Drop>::drop

Self 2.56 (FP). DWARF did not unwind this symbol.

94% of the self samples are the refcount test and the atomic decrement
(ecow vec.rs:806-808). Only 2.6% are the inline element loop and 2.5% the
deallocation. The element drops themselves are drop_glue and cfree, counted
under those symbols.

| site | line | % | refcount | loop + dealloc |
|---|---|---|---|---|
| exec_ops return: record (env, initial_args) dropped | exec.rs:1614 | 28.1 | 26.0 | 1.9 |
| Return writeback `state.nodes[i] = node_env` | exec.rs:1605 | 17.3 | 16.6 | 0.6 |
| recv-wait writeback `state.nodes[i] = node_env` | exec.rs:1561 | 16.2 | 15.5 | 0.2 |
| SyncCall arm end, callee frame (exec_ops 8.0, run_sync_ops 7.6) | exec.rs:999 | 15.6 | 14.2 | 1.4 |
| Env::set make_mut releasing the shared buffer (954: 2.9 + 1.8, 949: 2.6 + 0.4) | values.rs:746 | 7.7 | 7.5 | 0.1 |
| end-of-run teardown | explorer.rs:1189 | 2.9 | 2.3 | 0.5 |
| send-to-waiting-reader writeback | exec.rs:1535 | 2.6 | 2.6 | 0 |
| Continuation::call writeback | state.rs:1690 | 2.3 | 2.3 | 0 |
| trace dispatch | exec.rs:47 < :1379 | 2.0 | 2.0 | 0 |
| timer completion writeback | scheduler.rs:1528 | 1.9 | 1.9 | 0 |

Node-env writebacks (1605, 1561, 1535, state.rs:1690, scheduler.rs:1528) are
40.3%. Frame and record drops (1614, 999) are 43.7%.

exec_ops takes `node_env = state.nodes[i].clone()` at exec.rs:1478 (also
exec.rs:649 and :105). A segment that writes the node env copies it through
make_unique, the 8.8% of clone above. A segment that does not write it still
pays the increment at entry and the decrement at writeback, which is what
these rows sample.

## Arc<imbl GenericNode<(Value, Value)>>::make_mut

Self 1.35 (FP), 1.36 (DWARF).

| caller | FP | DWARF |
|---|---|---|
| map or struct literal: `m.insert(k, v)` on a fresh ValueMap | 86.7 (compiled_eval.rs:207) | 87.5 |
| CExpr::Store `update_collection` (`m.update`) | 12.1 (eval.rs:240) | 11.2 |
| MapErase `without` | 0.9 (compiled_eval.rs:289) | 1.0 |
| for-in | 0.3 (exec.rs:1266) | 0.3 |

Inside the function:
- 88.1% of the self samples land on the instruction right after `lock cmpxchgq`
  on the Arc strong count, which is make_mut's uniqueness check;
- 4.9% land after `lock decq` on the old Arc;
- about 5% land in the prologue.

The self time is the per-node atomic uniqueness check, not node copying. The
node itself is large. imbl's insert copies a 2,848-byte (0xb20) node from the
stack into a new heap block right after malloc: `movl $0xb20,%edx` before the
memmove call, 5.2% of spur memmove. That is above glibc's default tcache limit
of 1,032 bytes, which fits the literal also being the top _int_malloc site.

## EcoVec<Value<NoHashing>>::make_unique

Self 0.76 (FP), 0.73 (DWARF). Every call comes from Env::set's `make_mut()`
(values.rs:746).

| site | FP | DWARF |
|---|---|---|
| Op::AssignNode exec.rs:954, run_sync_ops | 30.5 | 30.9 |
| Op::AssignNode exec.rs:954, exec_ops | 24.4 | 25.6 |
| Op::AssignLocal set_local exec.rs:949, exec_ops | 18.5 | 17.3 |
| Op::AssignLocal exec.rs:949, run_sync_ops | 10.7 | 10.9 |
| exec @ exec.rs:851 (exec_ops frame not on the stack) | 4.9 | 4.9 |
| exec_ops @ exec.rs:981 (skipped frame) | 2.5 | 0.9 |
| eval::store into a waiting reader (eval.rs:85 < :108), Continuation::call state.rs:1687, store_dest after trace enter (exec.rs:1297) or channel (exec.rs:1173) | about 4.5 | about 4.1 |

## malloc

Self: 2.13 spur threads + 0.12 writer (FP), 2.27 + 0.09 (DWARF). Percent of
malloc self:

| anchor and line | FP | DWARF |
|---|---|---|
| map or struct literal insert, compiled_eval.rs:207 | 25.5 | 25.7 |
| string `+`: EcoString::with_capacity, compiled_eval.rs:125 | 13.4 | 15.4 |
| Store update eval.rs:240, including the Arc clone_from_ref_in path copy (3.8 / 3.5) | 9.1 | 8.0 |
| SyncCall FrameBuilder::new, exec.rs:976 (exec_ops 4.7 / 5.5, run_sync_ops 2.7 / 1.5) | 7.4 | 7.0 |
| run_trace_dispatch `Box::from(payload)`, exec.rs:1385 | 6.3 | 7.0 |
| build_frame FrameBuilder::new, eval.rs:125 < :185 (async callee frame) | 5.5 | 6.2 |
| exec_plan TimerFired `payload: vec![..]`, path.rs:1043 | 5.0 | 5.3 |
| run_async_op `arg_vals` EcoVec::with_capacity, exec.rs:1162 | 4.7 | 4.2 |
| exec_plan `format!("System.TimerFired/{label}")`, path.rs:1038 | 3.8 | 5.2 |
| push_waiting_reader `Arc::new`, state.rs:460 | 3.3 | 3.4 |
| parquet writer write_batch, history.rs:577 | 3.0 | 1.7 |
| Env::set grow on the make_unique copy, exec.rs:954 | 1.4 | 1.4 |
| scheduler, all lines (1537, 502 < 1338, 1151) | 2.0 | 1.0 |

## _int_malloc and realloc

_int_malloc self: 0.85 + 0.14 writer (FP), 0.88 + 0.14 (DWARF). Percent of
the symbol, writer included:

| anchor and line | FP | DWARF |
|---|---|---|
| map or struct literal, compiled_eval.rs:207 | 20.3 | 20.5 |
| string `+`, compiled_eval.rs:125 | 9.9 | 9.1 |
| Store, eval.rs:240 | 8.4 | 8.9 |
| write_batch, history.rs:577 | 7.0 | 7.5 |
| generate_plan `actions.push` realloc growth, generator.rs:77 < :140 | 7.0 | 6.7 |
| trace Box, exec.rs:1385 | 5.9 | 6.9 |
| path.rs:1038 | 5.5 | 6.6 |
| build_frame | 3.5 | 5.0 |
| path.rs:1043 | 3.3 | 3.5 |
| arg_vals, exec.rs:1162 | 2.1 | 2.4 |

realloc self is 0.11 (DWARF) with no dominant site: env extend values.rs:728
< exec.rs:954 10.6, write_batch 8.1, push_runnable 7.1, path.rs:1039 6.9,
generate_plan lines about 17.

## cfree and _int_free_chunk

cfree self: 0.37 + 0.02 writer (FP), 0.39 + 0.02 (DWARF). Immediate callers:
EcoVec drop 48%, drop_glue 13%.

| anchor and line | FP | DWARF |
|---|---|---|
| exec_ops return, exec.rs:1614 | 21.1 | 18.3 |
| SyncCall arm end, exec.rs:999 (exec_ops 11.8 / 12.9, run_sync_ops 5.8 / 5.6) | 17.6 | 18.5 |
| AssignLocal old value, exec.rs:949 (exec_ops + run_sync_ops) | 8.3 | 11.3 |
| run_trace_enter (no line) | 6.7 | 4.7 |
| end-of-run teardown, explorer.rs:1189 | 6.6 | 7.9 |
| schedule_runnable (1852 function end, 1537, 1360) | 7.3 | 12.3 |
| Return writeback, exec.rs:1605 | 4.2 | 5.0 |
| exec_plan path.rs:1054 | 3.1 | 3.2 |
| write_batch, history.rs:577 | 2.9 | 3.2 |
| pop_waiting_reader, state.rs:468 | 2.7 | 1.9 |

_int_free_chunk self: 0.96 + 0.09 writer (FP), 0.94 + 0.11 (DWARF). Its
immediate caller is cfree in 98%.

| anchor and line | FP | DWARF |
|---|---|---|
| end-of-run teardown, explorer.rs:1189 | 27.4 | 28.0 |
| AssignLocal old value, values.rs:746 < eval.rs:97 < exec.rs:949 | 17.7 | 16.3 |
| store_dest Local after SyncCall, exec.rs:883 < :997 (exec_ops + run_sync_ops) | 15.1 | 14.5 |
| Return writeback, exec.rs:1605 | 7.6 | 7.7 |
| write_batch, history.rs:577 / 579 | 5.7 | 5.0 |
| AssignNode, exec.rs:954 (exec_ops + run_sync_ops) | 3.7 | 5.7 |
| run_trace_enter | 3.8 | 2.9 |
| exec_ops return 1614, SyncCall end 999 | 8.0 | 2.8 |

The slow free path (_int_free_chunk) is concentrated where large blocks die:
- whole-run teardown;
- values overwritten in slots, which are mostly maps and structs, going by the
  drop_glue kinds;
- node-env buffers replaced at writeback.

That fits HAMT nodes of 2.8 KB being beyond tcache.

## memmove (__memmove_avx512_unaligned_erms)

Self 6.27 on spur threads + 1.22 in the parquet writer (DWARF). Byte counts
are the `movl $N,%edx` before each call.

Spur threads, percent of spur-thread memmove. These rows cover 85.5%:

| # | anchor and line | what is moved | % | cum |
|---|---|---|---|---|
| 1 | run_async_op exec.rs:1215 `state.push_runnable(Runnable::Record(new_record))` | Runnable, 248 B | 9.0 | 9.0 |
| 2 | schedule_runnable scheduler.rs:1356 -> State::take_local state.rs:1176 `local_queues[node].remove(idx)` | Runnable out, 240 B, plus queue shift | 7.6 | 16.6 |
| 3 | ChannelState::push_waiting_reader state.rs:460 `Arc::new((record, lhs))` | Record 248 B, then Arc payload 280 B | 7.3 | 23.9 |
| 4 | json_string_array text_buffer.rs:46 < :39 < exec.rs:75 (serde_json format_escaped_str) | trace payload text | 6.5 | 30.4 |
| 5 | schedule_runnable scheduler.rs:1547 `other =>` arm | Runnable, 248 B | 6.4 | 36.8 |
| 6 | exec exec.rs:855, the `record` argument to exec_ops | Record, 248 B | 6.0 | 42.8 |
| 7 | schedule_runnable scheduler.rs:1334 `let (runnable, slot, mask) = match selection` | Runnable, 248 B | 5.0 | 47.8 |
| 8 | ceval compiled_eval.rs:207, map or struct literal insert | new HAMT node, 2,848 B | 4.5 | 52.3 |
| 9 | run_trace_dispatch exec.rs:47 < :1379 (Value::write_to) | trace text | 4.2 | 56.5 |
| 10 | update_collection eval.rs:240 (Arc::make_mut node clone) | HAMT node | 3.6 | 60.1 |
| 11 | ChannelState::pop_waiting_reader state.rs:468 | Record out of Arc, 248 + 264 B | 2.7 | 62.8 |
| 12 | schedule_runnable scheduler.rs:1766, `r` passed to exec | Record | 2.4 | 65.2 |
| 13 | run_async_op insert_channel state.rs:98 < :1112 < exec.rs:1172 | ChannelState Vec growth | 2.2 | 67.4 |
| 14 | State::push_runnable | Runnable into Vec | 2.1 | 69.5 |
| 15 | ceval compiled_eval.rs:126, 127 (string `+` push_str) | string bytes | 3.9 | 73.4 |
| 16 | State::take_network state.rs:1167 `network_queue.remove(idx)` | queue shift of 248 B elements | 2.0 | 75.4 |
| 17 | Continuation::call state.rs:1684 | Record | 1.5 | 76.9 |
| 18 | ceval compiled_eval.rs:358 (IntToString) | string bytes | 1.4 | 78.3 |
| 19 | no spur anchor | other | 1.4 | 79.7 |
| 20 | schedule_runnable scheduler.rs:1598 (Record arm) 1.3; scheduler.rs:1430 `timer_queue.remove` 1.2 | Record / Runnable | 2.5 | 82.2 |
| 21 | RecordRng::into_recording rng.rs:244 | rng tape Vec to Box | 1.2 | 83.4 |
| 22 | exec_ops exec.rs:1531, waiting-reader match | Record | 1.1 | 84.5 |
| 23 | run_trace_enter text_buffer.rs:34 < exec.rs:1305 | trace text | 1.0 | 85.5 |

Grouped, percent of spur-thread memmove (points of all samples):

| group | rows | % | points |
|---|---|---|---|
| Record / Runnable by value | 1, 2, 3, 5, 6, 7, 11, 12, 14, 16, 17, 20, 22 | 55.6 | 3.49 |
| trace and history text | 4, 9, 23 (about 15 with the smaller trace rows below the cut) | 11.7 | 0.73 |
| map nodes | 8, 10 | 8.1 | 0.51 |
| string building | 15, 18 | 5.3 | 0.33 |
| other: channel table growth, rng tape, no anchor | 13, 19, 21 | 4.8 | 0.30 |
| frames | none above the cut | - | - |

Parquet writer: 1.22 points, 16.3% of all memmove. write_batch history.rs:577
alone is 14.4% of all memmove.

## Summary

### Value clone traffic

Self 3.07, merged across instances. The grader's flat line shows only the
1.95 instance.

About 45% is an atomic increment on an imbl map root, and maps here are
mostly Spur structs. About 13% is list and tuple refcounts, under 1% strings,
and the rest dispatch and scalar copies.

By purpose:
- **Stores, 42%:** slot-to-slot AssignLocal 28%, the node-env copy-on-write
  9%, the Store collection operand, and literal fields.
- **Frames, messages and return values, 41%:** Return 13%, async args cloned
  twice (into initial_args at exec.rs:1164, then into the frame at eval.rs:194)
  20%, SyncCall args 5%, Send 3%.
- **Reads, 11%:** list and field projection 7%, trace payload formatting 4%.

### Value drop traffic

drop_glue<ValueKind> is 3.79:
- two thirds is the old value overwritten by AssignLocal (exec.rs:949);
- that is mostly heap strings (42% of the symbol) and maps (25%).

EcoVec<Value> drop is 2.56:
- almost entirely the refcount test and decrement, not element work;
- node-env writebacks 40%, record and frame drops at exec_ops return and
  SyncCall end 44%.

### imbl

make_mut (1.35) is the per-node atomic uniqueness check, 87% of it under map
and struct literals (compiled_eval.rs:207). Each new root node is also
allocated at 2.8 KB and copied from the stack.

### memmove

- **Record and Runnable by value, 56% of spur memmove (3.5 points):**
  - Runnables are 248 B and Records 240-248 B, and a parked reader Arc carries
    280 B;
  - sites: the RPC push at exec.rs:1215, the reader park and unpark at
    state.rs:460/468, the take_local and take_network Vec::remove, and three
    moves in schedule_runnable (1334, 1547, 1766) and one into exec (855).
- **Trace text:** 12-15%.
- **HAMT nodes:** 8%.
- **Strings:** 5%.
- **The parquet writer:** a further 1.22 points.

### Allocator

malloc: map and struct literals 26%, string `+` 13-15%, call frames and
argument vectors about 17% (SyncCall 7, async frame 6, arg_vals 5), Store 8-9%,
trace Box 6-7%, TimerFired payload and format! 9-10%.

_int_malloc and _int_free_chunk follow the large blocks: literal HAMT nodes,
Store, write_batch, teardown (27% of _int_free_chunk), and slot overwrites.

### What changed against 45517fd-attribution.md

- **Scheduler per-step Vecs are gone.** In 45517fd the `eligible` lists at
  scheduler.rs:1276/1301/1350 and local_queue_sizes at 1195 were about a
  quarter of malloc, three quarters of realloc and about 47% of cfree self.
  They are now 1-2% of malloc and about 7-12% of cfree. realloc fell from 0.56
  to 0.11.
- **Map literals and strings grew as shares of malloc** (19.4 to 25.5, 11.3 to
  13-15). That is a relative gain now that the scheduler share is gone, not a
  new cost.
- **make_mut moved further onto literals.** Store's share fell from about 32%
  to 12%, while literals went from 64% to 87%. Store's share of imbl work is
  down, consistent with the in-place update work.
- **make_unique:** AssignNode 70% to 55%, AssignLocal 21% to 29%. Self 0.62 to
  0.76 in cycles.
- **drop_glue<ValueKind> is unchanged in shape:** AssignLocal about 66-68%.
  This attribution adds the kind split (strings 42%, maps 25%).
- **EcoVec drop is unchanged in shape** (node-env writebacks 40-41%, frame
  drops 43-44%). This attribution adds that 94% of it is the refcount decrement.
- **ValueKind::clone was never attributed before.** Its merged share is 3.07,
  not the 1.99 grader line.
- **memmove on spur threads went from 5.89 to 6.27** with the same structure.
  Record and Runnable moves are 56% (57% before). The same sites appear with
  shifted line numbers: take_local 1292 to 1356, `other =>` 1483 to 1547,
  match selection 1271 to 1334, exec call 1702 to 1766.
- **Method.** Unlike 45517fd, no IBS recording was needed: the grader now
  records plain cycles. The FP chains check out by call-instruction target for
  the Rust symbols and for glibc malloc and free; DWARF was needed only for
  memmove.

## Files kept

$D/fp.perf.data (55 MB) and the flat reports fp-flat.txt, fp-flat-0.3.txt and
dwarf-flat.txt. The analysis outputs are fp-analysis.txt, dwarf-analysis.txt,
dwarf-memmove.txt and fp-clone-sites.txt. Also kept: profile.config.json and
scripts/ (record.sh, collect.sh, collect.py, analyze.py copied from 45517fd,
analyze2.py, crosstab.py).

Deleted: dwarf.perf.data (1.26 GB), both explorer output directories and
their sidecar JSONs, the warning logs (record-*.err, about 18 MB each), and the
regenerable intermediates (.pkl, symtab, done and pid files).
