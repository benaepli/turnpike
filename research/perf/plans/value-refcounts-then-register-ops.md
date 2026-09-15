# Plan: value-refcounts-then-register-ops

This composite is built as three commits in one spur worktree based on 9340a2e:

- **Commit A:** Value sequences and env slots move to a run-local vector whose reference count is not atomic.
- **Commit B:** strings, maps, payload pointers and parked readers move to non-atomic counts, and program literals become immortal.
- **Commit C:** the tree interpreter is replaced by register code that writes each result where it is consumed.

There is a decision point after A+B. The judge's rewritten declarations, bands, guards, counters and conditions (tmp/loop/perf/it24-judgment.md) are frozen. Where the proposers' text differs, the judge's text wins.

Worktree branch: `perf/value-refcounts-then-register-ops`. Work directory: `tmp/loop/perf/value-refcounts-then-register-ops/`. Each commit gets two exports:
- a patch: `spur-A.patch`, `spur-AB.patch`, `spur-ABC.patch`;
- a release binary: `cand-a-spur`, `cand-ab-spur`, `cand-abc-spur`.

All checks use release builds. Nothing in this plan adds debug-only shadow instrumentation: no `debug_assert!` comparing the two counting disciplines, and no `cfg(debug_assertions)` second model.

---

## 1. Hypothesis and declarations

### 1.1 Parts A+B: run-local-value-refcounts

**What costs time today.** Every Value clone and drop does a lock-prefixed read-modify-write on a heap header. So does every env clone and writeback, every copy-on-write uniqueness test, and every Option/Variant payload and parked-reader pointer. A run's State, frames and values live and die on the one rayon job that runs the run, so no other thread can reach those headers. The exception is program literal headers: all 30 workers write them concurrently.

**The change.** Replace the atomic counts with plain counts on run-local headers. Give program literals an immortal header that clone, drop and uniqueness checks only read.

- **Search declaration: neutral.**
  - Only the atomicity of reference counts changes.
  - Every uniqueness answer is identical, and so is every copy decision, container order, hash and draw.
  - Guarded by one-thread byte identity at each commit on five sessions: VR 3,008, crash-heavy 1,800, Mencius 2,160, SDPaxos 2,160, and the caps-engaged 100,000-run session with crash holds nonzero. Also guarded by the spread check in rounds.
- **Sharing profile: shared.** It is a type-level change on every run, and the literal half is cross-thread cache-line contention.
- **Treatment bit: none.**

### 1.2 Part C: register-ops-written-in-place

**What costs time today.** Every vertex result is a 40-byte Value, or a 48-byte `Result`, returned through memory by an out-of-line producer. The caller copies it into a stack temporary, then copies it again into its slot. Producer and consumer store and load at widths that cannot be forwarded.

**The change.** Flat register code per vertex:
- the vertex root writes its result straight into the destination slot;
- heap temporaries move into their consumer;
- int and bool temporaries use an i64 lane;
- errors are held out of band.

- **Search declaration: neutral.** The judge's conditions:
  - For every node whose later operand is evaluated only after an earlier one is inspected, the flat code emits a kind-guard instruction before the later subtree. The error and every counter tick are then those of today's recursion. The full list of such nodes is in 3.3.2; it is longer than Find alone.
  - The drop order of old slot values may change only relative to temporaries. No output reads an address.
  - Draw points, id allocation, trace text and log text do not change.
- **Sharing profile: shared.**
- **Treatment bit: none.**

### 1.3 Composite

Search-neutral, shared, no treatment bit. The band is cross-binary runs per second **[1.06, 1.15]** against 9340a2e, with a central estimate of about 1.10.

---

## 2. The cost being removed, and where the profile shows it

Profile: research/perf/profiles/9340a2e.md (30 threads, 60 s, VR campaign, 1 percent cutoff). Simulation threads are 89.98 of samples; the parquet writers are a separate 9.82.

### 2.1 A+B (refcounts)

**Self rows in the profile:**

| Symbol | Self |
|---|---|
| `<EcoVec<Value> as Drop>::drop` | 4.42 (5.76 incl) |
| `drop_glue<ValueKind>` | 2.64 |
| `ValueKind::clone` | 2.51 |
| `EcoVec<Value>::make_unique` | 0.81 (1.34 incl) |
| `EcoVec<Value>::grow` | 0.22 (1.08 incl) |
| `GenericHashMap<..., ArcK>::insert` | 1.02 incl |

Lock-prefixed refcount instructions also sit inside the self rows of ceval, exec_ops, run_sync_ops, pop_waiting_reader and Continuation::call.

**Lock census.** Iteration 22, re-summed by the judge; simulation-thread samples just after lock-prefixed instructions:

| Protected object | Points |
|---|---|
| EcoVec | 6.362 |
| EcoString | 0.714 |
| std Arc on Values (0.10 of the Arc rows are not Values) | about 0.70 |
| imbl archery Arc | 0.321 |

- The Value family totals 8.10 points on c302525. Scaled by the EcoVec<Value> drop row (r = 1.073), that is 8.69 points on 9340a2e.
- The largest single row is `lock decq` at EcoVec<Value>::drop+0x22 (ecow vec.rs:808).
- The largest std Arc row is pop_waiting_reader at 0.478.

**Price per operation.** Microbenchmark mb/lock2.c, reproduced by the judge:
- an atomic op costs 3.69 ns against 0.71 ns plain;
- a clone+drop pair costs 7.20 ns atomic, 1.58 ns plain, and 1.72 ns plain with the immortal sentinel compare;
- the removable share per op is 0.81.

**Saving.** 8.69 x 0.81 x (1 - c), with cold-header share c in [0.15, 0.45], is 3.9 to 6.0 points. On 89.98 that is 1.046 to 1.072, times the host rule of about 0.9. Band [1.04, 1.07]; commit A alone [1.03, 1.05].

### 2.2 C (register ops)

**Self rows:**

| Symbol | Self |
|---|---|
| ceval | 9.40 |
| exec_ops (three RNG instances) | 6.38 + 1.67 + 1.57 = 9.62 |
| run_sync_ops (three instances) | 2.78 + 0.81 + 0.74 = 4.33 |
| run_async_op (three instances) | 1.16 + 0.38 + 0.31 = 1.85 |

**Where the heat sits.** Two instruction shapes, verified in annotation:
- exec_ops 0x71679a: a 1-byte tag store followed by a 4-byte load (32.67 percent of the symbol);
- exec_ops 0x715c04: a 16-byte load after `call ValueKind::clone` that spans the callee's separate tag and payload stores (14.17 percent).

**Size.** The judge prices it from the proposer's own blocked-forward count (15.6 M stli_other per second against 5.50e9 cycles per second): forwarding stalls explain only about 1 to 3 points. The derivation:

| Part | Points |
|---|---|
| Stalls (1-3), discounted | about 0.85 of 1-3 |
| Removed 40-48 byte copies | 0.5-1.0 |
| Plumbing | 0.3-0.6 |
| Borrowed paths and concatenation, after A+B | 0.2-0.5 |
| Unexplained handoff heat | 0-2 |

That is 2.0 to 7.0 points on 89.98, discounted. Band over A+B [1.02, 1.08].

### 2.3 Composite

3.9-6.0 plus 2.0-7.0, less 0.2-0.4 of overlap, is 5.5-12.8 points. Under the host rule that gives [1.06, 1.15].

---

## 3. Files and mechanisms to change

Crate versions in use (spur/spur-core/Cargo.toml): ecow 0.2.6 with serde, imbl 6.1.0 (archery 1.2.2 underneath). Sources are in `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/{ecow-0.2.6,imbl-6.1.0,archery-1.2.2}`.

STYLE.md applies to every line:
- ASCII only.
- Comments state constraints only.
- No history, plan or iteration references.
- A forked-file license notice (ecow is MIT OR Apache-2.0) is a constraint statement and is allowed.

### 3.0 Order of work

1. **Before any build, on a quiet host** (no compile, no tree-reading agent, spur-research-loop inactive):
   - a 0.3-cutoff profile of 9340a2e;
   - a lock census of 9340a2e (section 9.1).
2. Create the worktree. Copy the identity tooling into `tmp/loop/perf/value-refcounts-then-register-ops/idw/` (section 7.4). Run the baseline 9340a2e side of all five identity sessions once. The baseline sides are reused for A, B and C.
3. **Commit A.** Release tests, five-session identity against 9340a2e. Export `cand-a-spur` and `spur-A.patch`.
4. **Commit B.** Release tests including the 30-thread literal test. Five-session identity against 9340a2e. `spur compile` program.json unchanged. Baseline-side temporary copy tally (5.3). Export `cand-ab-spur` and `spur-AB.patch`.
5. **Layout control**, quiet host (9.2).
6. **A+B mechanism reads**, quiet host, before any round: 0.3-cutoff profile, census, one-thread cycles per run. Check G1, G2 and the falsifier list (7.1).
7. **A+B grading session**, 3 rounds (9.3). Apply the decision rule (9.4).
8. **Commit C** on top of B, only if 9.4 says build. Differential and proptest suites, exec tests, five-session identity against 9340a2e (register code must still be byte-identical to the original program), tree_evals equality. Export `cand-abc-spur` and `spur-ABC.patch`.
9. **C mechanism reads**, quiet host: 0.3-cutoff profile against A+B, stli per label, cycles per run over A+B and over 9340a2e.
10. **C increment session** (over A+B, 3 rounds), then the **composite session** (over 9340a2e, 3 rounds).

### 3.1 Commit A: sequences on a run-local vector

#### 3.1.1 New file `spur/spur-core/src/simulator/core/local_vec.rs`

A fork of ecow 0.2.6 `src/vec.rs` (1,311 lines), with the license notice kept.

- **Type.** `pub struct LocalVec<T>`, with the same repr(C) layout `{ ptr, len, phantom }` and the same header layout `{ refs, capacity }`. Allocation sizes and alignment are then identical to EcoVec's, so the allocator sees the same requests.
- **Header count.** `refs: Cell<usize>` in place of `AtomicUsize`.
- **Keep the count private.** Put `Header` in a private inner module whose only accessors are:
  - `fn inc_ref(&self)` (with ecow's overflow abort kept);
  - `fn dec_ref(&self) -> bool` (true when the count reached zero);
  - `fn is_unique_count(&self) -> bool`.
  No other code can name `refs`, so every count write goes through these three functions.
- **Paths that must route through them.** Audit this list in review:
  - `Clone::clone` (vec.rs:784-799);
  - `Drop::drop` (vec.rs:801-830), where ecow's `atomic::fence` is removed;
  - `is_unique` (vec.rs:776);
  - `make_mut` (224);
  - `reserve` (446) and `grow` (535; a new header is created with refs = 1);
  - the shared-copy branch of every mutator (push, pop, insert, remove, truncate, retain, clear, extend, extend_from_slice, extend_from_trusted);
  - `into_iter` (1082, which reads `is_unique`) and `IntoIter::drop` (1192);
  - any `take`/`mem::take`-style helper.
- **No Send or Sync.** Delete `unsafe impl Send` and `unsafe impl Sync` (vec.rs:762-763). `NonNull` already makes the type !Send and !Sync. Add `PhantomData<*const ()>` so that stays true if the pointer type ever changes.
- **API surface.** Carry over unchanged everything the simulator uses, so call sites only change the type name:
  - construction and growth: `new`, `with_capacity`, `from_elem`, `push`, `pop`, `reserve`, `truncate`, `clear`, `extend_from_slice`, `extend_from_trusted`, `make_mut`, `is_unique`, `len`, `is_empty`;
  - trait impls: `Deref<Target=[T]>`, `Default`, `FromIterator`, `Extend`, `From<&[T]>`, `From<[T; N]>`, `From<Vec<T>>`, `IntoIterator` (owned and borrowed), `Hash`, `PartialEq`, `Eq`, `PartialOrd`, `Ord`, `Debug`.
  - `Hash` and `Debug` must delegate to the slice exactly as ecow does, so signatures, HAMT placement and Debug text are identical.
  - Serde modules are dropped unless the compiler asks for them; Values have no serde derive in values.rs.
- **Unit tests (release).** Port ecow's vec tests: clone and drop counts, a make_mut copy when shared and none when unique, into_iter moving when unique and cloning when shared, grow and reserve under sharing, from_elem, zero-size types, and a panic during element drop not double-freeing.
- Register the module in `simulator/core.rs`.

#### 3.1.2 Type switch

| File | Lines | Change |
|---|---|---|
| values.rs | 37 | `pub type ValueSeq<H> = LocalVec<Value<H>>` |
| values.rs | 985, 1032 | `type Slots<H> = LocalVec<Value<H>>`; `from_elem` |
| values.rs | 5, doc comments at 31-36 and 981 | import; comments renamed to the new type, constraint text only |
| values.rs | tests | as needed |
| eval.rs | 9, 118, 125 | FrameBuilder slots |
| exec.rs | 16, 274, 1163 | `arg_vals` in the legacy and compiled Async paths |
| state.rs | 17, 354, 1807 | `initial_args`; comment at 1105 |
| scheduler.rs | 16, 2456, 3809, 4206 | `initial_args` |
| path.rs | 32, 249 | `initial_args` |
| compiled_eval/test.rs, exec/test.rs | - | any EcoVec construction |

- **Strings stay ecow EcoString in commit A.** An EcoString is Send and Sync, and a Value holding a LocalVec is !Send, which is correct in A.
- **Compile audit.** `cargo build --release --workspace` from spur/ (spur-cli, spur-lsp and spur-bench must build). Every failure is a place where a Value would cross a thread. The judge verified there should be none outside tests. A failing test that moves a Value across threads is rewritten to build the Value inside the thread. Record each such test in the commit message.

### 3.2 Commit B: strings, maps, payloads, parked readers, immortal literals

#### 3.2.1 Const parameter on the vector

Add a const parameter: `pub struct LocalVec<T, const IMMORTAL_ALLOWED: bool = false>`.
- The three header functions check the reserved count `IMMORTAL = usize::MAX` only when `IMMORTAL_ALLOWED` is true. With the default false, the check compiles out, so Value sequences pay no compare.
- `inc_ref` aborts before a count could reach `IMMORTAL`. Keep ecow's `> isize::MAX` abort.
- On an immortal header:
  - `inc_ref` writes nothing and calls `util_stats::record_literal_clone()`;
  - `dec_ref` writes nothing, returns false and calls `util_stats::record_literal_drop()`;
  - `is_unique_count` returns false (IMMORTAL != 1).
- Both record functions are `#[cold] #[inline(never)]`, so the hot clone and drop carry only the compare.

#### 3.2.2 New file `spur/spur-core/src/simulator/core/local_str.rs`

A fork of ecow `string.rs` (589 lines) plus `dynamic.rs` (362), notice kept. Its type is `pub struct LocalStr`, stored in a `DynamicVec` over `LocalVec<u8, true>`.
- Inline strings of 15 bytes or less have no header, exactly as in ecow.
- `Hash` hashes `as_str()`, as ecow does. `PartialEq`, `Eq`, `PartialOrd`, `Ord` compare by `as_str()`. `Debug` and `Display` are str's. `push_str`, `with_capacity`, `From<&str>`, `From<String>`, `make_mut`, `clear` and `Deref<Target=str>` are carried over.
- Add `PartialEq<SharedLiteral>` and `PartialEq<str>`.
- **Copy counter.** In the copy branch of `make_mut`, `reserve`, `push_str` and `grow` (the branch taken when `is_unique` is false on an allocated header), call `util_stats::record_shared_string_copy()` (`#[cold]`). It counts copy-on-write copies of shared strings, immortal or run-local.

#### 3.2.3 `SharedLiteral`, in local_str.rs

- **Representation.** `pub struct SharedLiteral(ManuallyDrop<LocalStr>)`.
- **Constructor.** `pub fn intern(text: &str) -> SharedLiteral`.
  - A string of 16 bytes or more is built once with refs = IMMORTAL.
  - A process-wide `static LITERALS: Mutex<HashMap<Box<str>, SharedLiteral>>` returns the existing header for known text. This bounds leaked bytes by distinct literal text when spur-lsp compiles repeatedly. The lock is taken only at compile and decode time.
- **Clone.** A bitwise copy of the handle. It is not counted and writes no header.
- **Drop.** A no-op, because literals are never freed.
- **Turning a literal into a string.** `pub fn to_local(&self) -> LocalStr` clones the inner LocalStr, which counts one literal clone for a spilled header.
- **Other impls.** `as_str`, `Deref<Target=str>`, and `Debug`, `PartialEq`, `Eq`, `PartialOrd`, `Ord`, `Hash` by str. `serde::Serialize` as a plain str, so program.json is byte-identical.
- **Send and Sync.** The unsafe impls carry the invariant in their comment. Suggested text:
  ```rust
  // The header of a literal is marked immortal before any program that holds
  // it is shared, and is never written or freed afterwards: clone, drop and
  // uniqueness checks of an immortal header only read it. Nothing may hand
  // out a mutable reference to the inner string.
  unsafe impl Send for SharedLiteral {}
  unsafe impl Sync for SharedLiteral {}
  ```
- **Release test** `literal_headers_stay_immortal_under_concurrent_use`:
  - intern several literals of 16 to 64 bytes;
  - on 30 `std::thread::scope` threads, run at least 10^7 iterations in total (at least 340,000 per thread);
  - each iteration: `to_local()`, clone it, `push_str` onto one copy, `make_mut` on another, compare contents, drop everything;
  - afterwards assert that every literal's header reads IMMORTAL through a test-only accessor, and that its text is unchanged.
  - Run it under `cargo test --release`.

#### 3.2.4 The full literal set becomes `SharedLiteral`

- ir.rs: `use ecow::EcoString` -> `SharedLiteral`; `Expr::String` (50), `Expr::Variant` name (77), `Expr::IsVariant` name (78). Expr keeps its derives (Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize).
- compiled.rs: `Opnd::Str` (20), `CExpr::FieldGet` name (34), `CExpr::Variant` (72), `CExpr::IsVariant` (73), and the `struct_literal` names collect at 433-447 (`Vec<SharedLiteral>`).
- cfg.rs: every constructor at 1161, 1173, 1191, 1202, 1208, 1487, 1569, 1576, 1589, 1597 and 1602 changes from `EcoString::from(..)` to `SharedLiteral::intern(..)`.
- values.rs StructShape:
  - `names: Box<[SharedLiteral]>` (58, 73);
  - `ShapeTables.kept_as_maps: Vec<Vec<SharedLiteral>>` (87);
  - `struct_shape(names: &[SharedLiteral])` (99-150), keeping the sort by str;
  - the `compute_sig` call there builds `ValueKind::String(n.to_local())`.
- Every place a Program- or static-held literal becomes a Value goes through a new `Value::literal(&SharedLiteral)`, equal to `Value::string(lit.to_local())`:
  - values.rs: `StructEntries` Debug (241), `struct_to_map` (around 187-191), and any other names-to-key site;
  - eval.rs: 288 (`Expr::String`), 547 (Variant), 555 (IsVariant comparison by str);
  - compiled_eval.rs: coperand 67, cvalue 109, FieldGet map key at the `Value::<H>::string(name.clone())` lines (282 and 304), Variant (name clone), IsVariant (`variant_name == name` by str);
  - history.rs:177, `json_of_value` for Struct names, and the matching arm of `ValueJson`/`MapJson`;
  - exec.rs `write_trace_payload` / `run_trace_dispatch`, wherever an `Opnd::Str` becomes text or a Value.
- Plan strings stay ecow EcoString. `ClientOpSpec` (path/plan.rs:19-21, plan_config.rs, path/generator.rs) is plan data that may cross threads. path.rs 219, 230, 240 and 1086 convert with `LocalStr::from(key.as_str())`.

#### 3.2.5 Run-local strings

- values.rs: `ValueKind::String(LocalStr)` (245); `ValueKind::Variant(u32, LocalStr, Option<Rc<Value<H>>>)` (248); `Value::string(s: LocalStr)` (457); `Value::variant` (512); `as_variant` (959).
- String builders: compiled_eval.rs 146, 429, 431, 440; eval.rs 299, 524, 526, 537.
- Tests in values.rs, eval.rs and compiled_eval/test.rs.

#### 3.2.6 Maps, payloads, readers

- values.rs 26-27: `ValueMap<H> = imbl::GenericHashMap<Value<H>, Value<H>, BuildHasherDefault<FxHasher>, imbl::shared_ptr::RcK>`. Test reference map at 1514-1519: RcK as well.
- values.rs: `ValueKind::Option(Option<Rc<Value<H>>>)` (238); `Value::option` (482), `option_some` (488) and `as_variant` use `Rc`; `use std::rc::Rc` replaces `std::sync::Arc`. compiled_eval.rs Variant `.map(Arc::new)` becomes `Rc::new`, and eval.rs likewise. Tests: `Arc::new` -> `Rc::new`.
- state.rs 442: `pub type WaitingReader<H> = Rc<(Record<H>, Lhs)>`. At 460, `Rc::new`; at 468, `Rc::try_unwrap(entry).unwrap_or_else(|shared| (*shared).clone())`. The size test at 1753-1758 must still pass (one word).
- state.rs 446-448 ChannelState: `buffer: imbl::GenericVector<Value<H>, RcK>` and `waiting_readers: imbl::GenericVector<WaitingReader<H>, RcK>`, with constructors `GenericVector::new()`. `#[derive(Debug, Clone, Hash)]` stays; the judge verified these impls are generic over the pointer kind.
- **Not changed:** `queued_messages: Vector<(NodeId, Record<H>)>` (state.rs:420), `persisted_data` (691), and the link maps (699-705). They are not on the census, and leaving them ArcK still compiles (archery is Send/Sync only when T is).

#### 3.2.7 Counters (util_stats.rs)

**Thread-local cells.** In the `thread_local!` block at util_stats.rs:2053, add `LITERAL_CLONES_RUN`, `LITERAL_DROPS_RUN` and `SHARED_STRING_COPIES_RUN`, each `Cell<u64>` with a const initializer.

**Record functions.** `record_literal_clone`, `record_literal_drop` and `record_shared_string_copy` increment their cell without an `enabled()` check, the same pattern as the drained cells in `flush_frame_stats`.

**Session statics.** `VALUE_REFS_LITERAL_CLONES`, `VALUE_REFS_LITERAL_DROPS` and `VALUE_REFS_SHARED_STRING_COPIES`, added to the `set_enabled` reset list (around 935-946).

**Fold: `pub fn flush_value_refs()`.** It drains the three cells, then returns if stats are disabled; otherwise it adds each nonzero value to its static. Call it:
- in explorer.rs `run_single_simulation` (PathState built at 1060) and in the second run function (PathState built at 1412), after the RunResult fields are extracted:
  ```rust
  let cut = path_state.state.replay_cut;
  drop(path_state);
  util_stats::flush_value_refs();
  ```
  This follows the judge's rule that the fold happens after the run's State and PathState are dropped. `flush_frame_stats` at path.rs:573 runs before PathState drops, so it cannot be the fold point.
- at the top of `snapshot()`, for the calling thread;
- beside the existing `flush_frame_stats()` call at util_stats.rs:2148 (the begin-run backstop), so an errored run's leftovers fold at the next run on that thread.

Grep the implementer's tree for every other `PathState::new` and add the same drop-then-fold there.

**Dump.** `#[derive(Serialize)] pub struct ValueRefsStats { pub literal_clones: u64, pub literal_drops: u64, pub shared_string_copies: u64 }` with `read()`. Add `pub value_refs: ValueRefsStats` to `UtilizationSnapshot` (near 7814) and its initializer in `snapshot()` (near 8049). Update spur/spur-core/tests/util_stats_export_completeness.rs: the destructure, the key lists, and a `value_refs` leaves helper modeled on `frame`.

#### 3.2.8 Compile audit

As in A, with the whole workspace. After B, Value, Env, State and Record are !Send and !Sync. Program must still be Sync; the compiler checks that through `SharedLiteral`.

### 3.3 Commit C: register ops written in place

Built on B and written directly over the forked types.

#### 3.3.1 Structure

- **New file `spur/spur-core/src/compiler/cfg/register.rs`, built at decode.**
  - One `Vec<Insn>` arena per `CompiledProgram`. Each vertex keeps its own op (same vertex ids, same pc transitions, one `label_execs` per vertex) plus a range of instructions for its expression tree.
  - `Insn` is a small Copy record: opcode, destination register, operand references (local slot, node slot, scratch register, constant index).
  - String literals live in a constant table of `SharedLiteral`.
  - `CompiledProgram` is built from the same labels, so `spur compile` program.json is unchanged.
- **New file `spur/spur-core/src/simulator/core/register_ops.rs`, the evaluator.**
  - Scratch registers are per thread and reused across vertices. There is an i64 lane for results that are statically int or bool, and a Value lane for heap results.
  - The scratch is all Unit between vertices, so a Recv, Pause or SpinAwait after the operands is safe.
  - A scratch Value is moved into its consumer: a struct field vector, a list, a tuple, a store, or `arg_vals`.
  - The vertex root writes its destination slot. Local slots go through `set_local` (eval.rs:93), which keeps `frame.entry_frame_copies`. Node slots go through `Env::set` (values.rs:1060-1081), which increments `writes` exactly once per store.
  - A kept slot operand is cloned directly into the destination. When source and destination are the same local slot this is a no-op.
  - A SyncCall passes its destination to the callee, whose Return writes it.
  - Handlers return a register-sized status. The `RuntimeError` goes into the interpreter context, built from the same operands in the same order as today.
  - Fast paths check operand tags. On a mismatch they call the generic semantic function for that node on the already-evaluated operands. There is no re-evaluation and no doubled tick.
- **exec.rs:** `run_common_op` (928), `run_sync_ops` (1403), `exec_ops` (1461), `run_async_op` (1145) and `run_for_loop_in` (1222), plus the trace ops as needed, execute register instructions.
  - The Async arm keeps its order: target, arguments, channel id allocation and insert, destination store, callee lookup, frame, link sequence, send ordinal, priority draw, purgatory.
  - Send, SetTimer and the purgatory draws are unchanged.
  - The segment-entry env clone (exec_ops 1480) and the Return writeback (1605-1607) are unchanged.
  - `exec_legacy` and eval.rs stay as the label-evaluator reference.
- **compiled_eval.rs:** `coperand`, `cvalue` and `ceval`, and the `CExpr` decode in compiled.rs, move under `#[cfg(test)]` unchanged. They are the reference for the differential test and do not ship in the binary.

#### 3.3.2 Evaluation order: kind-guard instructions

A flat post-order would evaluate every child before its parent, and that breaks today's order. The following nodes, read from compiled_eval.rs 128-547, evaluate a later operand only after inspecting an earlier one. Each gets a guard or skip instruction before the later subtree:

- **Find (259):** collection kind (Map, Struct or List, else NotACollection) before the key subtree.
- **SafeFind (477):** Option(None) returns early, non-option raises TypeError, and only Some continues. The key subtree comes after that check and before the inner kind check.
- **SafeTupleAccess:** no later subtree. The same order of checks applies.
- **And (208), Or (212):** `as_bool` on the first operand, then short-circuit skip.
- **Coalesce (417):** Some returns the payload, non-option raises CoalesceNonOption, and only None evaluates the default.
- **Minus, Times, Div, Mod (157-180), Min:** `as_int` on the first operand before the second is evaluated.
- **ListAppend (324):** `as_list` on the list operand before the item is evaluated.

Nodes that evaluate all operands first and keep today's order without a guard:
- Plus, the comparisons, EqualsEquals and NotEquals;
- ListPrepend: head, tail, then `as_list`;
- ListSubsequence: list, start `as_int`, end `as_int`, then `as_list`;
- KeyExists, MapErase: key then map;
- Store: collection (owned), key, value, then `update_collection`;
- StructLit: in field order, with `record_struct_literal_failed(done)` on error.

Integer arithmetic uses the same operators as today, so release wraps on overflow and division by zero panics the same way.

#### 3.3.3 Counters kept

- `compiled_expr.tree_evals`: one per non-leaf node evaluated, including nodes inside skipped-or-not branches exactly as ceval counts them at entry (ceval line 135).
- `compiled_expr.leaf_operands_inline`: incremented at every point today's code increments it (coperand and cvalue leaves, StructLit per field at 236, and the FieldGet arms at 288, 293 and 303). If exact equality cannot be kept, disclose its retirement as the only changed leaf.
- `eval_borrow` ticks: `borrowed()`'s `record_operand_borrowed` is still called where a slot is read in place. Not retired.

#### 3.3.4 New counters

New fields in `InterpreterTally` (util_stats.rs:6458), folded in `flush_frame_stats` (6587). Statics and reset list as for other groups; `RegisterOpsStats` added to `UtilizationSnapshot`; completeness test updated:

- `register_ops.vertex_ops`
- `register_ops.results_in_place`
- `register_ops.scalar_lane_nodes`
- `register_ops.slow_path_nodes`
- `register_ops.concat_chains`
- `register_ops.concat_pieces`

String concatenation of left-deep Plus chains within one vertex (optional, no falsifier): pieces are evaluated in order, then folded pairwise with Plus's exact semantics and error type name.

---

## 4. Config surface

None. No new config key, and no entry in `EXPLORER_CONFIG_KEYS` or `CONTINUOUS_CONFIG_KEYS` (explorer.rs). All three changes are type- and evaluator-level and unconditional.

---

## 5. Counters and what per-run values mean

Per-run values are normalized by `termination.all.runs`. Candidate-side values are read from each round file under `research/perf/state/<session>/` and from the identity dumps.

### 5.1 A+B: `value_refs`

**`value_refs.literal_clones` and `value_refs.literal_drops`**
- Clones must equal drops exactly in the session dump of every identity session (VR, crash-heavy, Mencius, SDPaxos, caps-engaged) and in every campaign arm.
- Per run, both lie in [200, 20,000] and are nonzero.
- 0 means literals are not on the immortal path: either the literal set is incomplete or the fold is not wired.
- Clones not equal to drops means a count leaked, or a literal-derived value outlived its run's fold.

**`value_refs.shared_string_copies`**
- Must equal the baseline's copy count on the identity sessions.
- The baseline count comes from a temporary tally: a scratch release build of 9340a2e with ecow 0.2.6 vendored through a `[patch.crates-io]` entry. It adds a thread-local counter in the copy branch of EcoString `make_mut`/`reserve`/`push_str`, folded and dumped the same way. It runs on the five identity sessions only and is deleted afterwards. It is never merged, never graded, and not the rounds baseline.
- The candidate's counter stays in the tree.

### 5.2 C: `register_ops` and kept leaves

| Counter | Expected |
|---|---|
| `compiled_ops.label_execs / steer_authority.steps`, candidate over base | [0.97, 1.03], by hand, every round |
| `register_ops.vertex_ops` | equals `compiled_ops.label_execs` exactly, every round and every identity session |
| `compiled_expr.tree_evals` | equals the baseline exactly on every one-thread identity session; under 30 threads, per label near 0.414 (13,536 / 32,709) |
| `register_ops.results_in_place / label_execs` | [0.55, 0.90] |
| `register_ops.scalar_lane_nodes / tree_evals` | [0.20, 0.60] |
| `register_ops.slow_path_nodes` | 0 on VR, every round |

- `compiled_expr.leaf_operands_inline` equals the baseline on identity, or its retirement is disclosed.
- The composite also reads the A+B counters every round.

---

## 6. Treatment bit

None. A reference count's width and atomicity are properties of the type. Switching per run would put a branch on every operation and would link both evaluators into the hot loop, which changes the layout under test. The savings are declared shared, so the grader would refuse a within-binary primary anyway.

---

## 7. Predicted observables, and what must not move

### 7.1 A+B independent observables and guards

All are measured on a quiet host before rounds, and each is a falsifier.

**1. Lock census.**
- Script: tmp/loop/perf/it22-census/census-run.sh, 30 threads, config tmp/loop/perf/it22-proposer/profile.config.json.
- Run it with `CENSUS_BIN` set to each binary's path, demangled. Record the 9340a2e census first.
- An empty or header-only census is a failed run: fix the tooling, do not read it.
- **Pass:** Value-family rows total at most 0.30 points. Those rows are EcoVec<Value> or the fork, EcoString or the fork, the archery Arc on Value maps and channel vectors, and std Arc in values.rs and state.rs.
- **Pass:** the simulation-thread census total falls by at least 6.5 x r.

**2. One-thread cycles per run on the VR 3,008 identity session.**
- Candidate over baseline at most 0.96.
- Method:
  ```
  perf record -e cycles -c 1000003 -o <f> -- <bin> explore -e campaign --config idw/vr.json -y --output-dir <dir> bin/spur/VR.spur
  ```
  with `RAYON_NUM_THREADS=1 RUST_LOG=warn`. Base and candidate run sequentially on an idle host, never concurrently.
- Cycles = samples with comm `spur` x 1,000,003, from `perf report --stdio --sort comm`. That covers the main thread and rayon workers and excludes `parquet-writer-*`. Divide by 3,008.

**3. Profile guards.**
- Profiles: 0.3-cutoff profile of 9340a2e (recorded before building) and of `cand-ab-spur`.
- **r.** On each profile, R = every `schedule_runnable` instance + `walk_recovery_placebo` + `score_with_terms` + the `eligible_counts` fold. R is 9.49 on 9340a2e.md; re-read it on the 0.3 profile. Then r = R_cand / R_base.
- **Reading "falls by at least k x r".** A guard fires when X_cand > (X_base - k) x r.
- **G1:** sequence drop self falls by at least 2.4 x r. X is the sum of `<EcoVec<Value> as Drop>::drop` on the base and the fork's drop in every instance on the candidate.
- **G2, net:** falls by at least 3.5 x r. X is the sum of:
  - the interpreter family: ceval, exec_ops, run_sync_ops, run_async_op, all instances;
  - the value family: sequence drop, `drop_glue<ValueKind>`, `drop_glue<Value>`, `ValueKind::clone`, `make_unique`, and every symbol of the forked types;
  - the allocator: malloc, _int_malloc, cfree, _int_free*;
  - memmove and pop_waiting_reader.
- G2 replaces a per-family relocation guard, because inlining of the now-trivial clone and drop would fire such a guard falsely.

**4. Remaining falsifiers:**
- literal clones differ from literal drops on any identity session;
- literal clones per run outside [200, 20,000];
- `shared_string_copies` differs from the baseline tally;
- the 30-thread literal test fails.

### 7.2 C independent observables and guards

The base for every read is `cand-ab-spur`.

**1. One-thread stli per label.**
- Record `perf record -e ls_bad_status2.stli_other -c 2000` on the VR 3,008 identity session.
- Sum the events in every instance of ceval, exec_ops, run_sync_ops and run_async_op, plus the new register symbols. Divide by that session's `compiled_ops.label_execs`.
- Re-record A+B with the same method. The value was 0.211 on 9340a2e.
- **Pass:** at most 0.10.

**2. One-thread cycles per run on VR 3,008.**
- At most 0.98 over A+B.
- The composite (`cand-abc-spur`) at most 0.94 over 9340a2e.

**3. Profile guards.** 0.3-cutoff profile of C against A+B, with r as in 7.1:
- the interpreter family plus every new register symbol falls by at least 1.5 x r;
- the net family (interpreter + value + memmove + allocator + new symbols) falls by at least 2.0 x r;
- memmove rises by at most 0.4 x r;
- the value family rises by at most 0.4 x r.

### 7.3 What must not move (every commit)

- Steps per run, end reasons and per-arm counts: exact on one-thread identity, inside the baseline's spread in rounds. The standing exemption for throughput-dependent arm and end-reason shares applies only with exact one-thread identity, including the caps-engaged session.
- The executions, logs and traces parquet files are byte-identical. Runs files differ only in `wall_us` and `session_offset_ms`. The table comparer agrees on every table. `stall_cap_runs.csv` sha256 is equal. `runs_completed` and `runs_failed` (0) are equal. Text column digests are equal (logs content, traces payload, function_name and trace_kind, executions payload, action and kind).
- Dump leaves: identical except the new `value_refs.*` and `register_ops.*` leaves, clocks and writer-timing leaves (history_writer text buffer and blocked figures), and in C only the disclosed `leaf_operands_inline` if it is retired.
- `spur compile` program.json is byte-identical (B and C).
- Cost clause:
  - no downward separation of runs per second;
  - peak RSS per thread within 2 percent;
  - `history_writer.blocked_ns` stays 0 in rounds;
  - no new lock-prefixed rows on simulation threads in the census.

### 7.4 Equivalence obligations, concretely

**Identity tooling.** Copy tmp/loop/perf/eligibility-and-crash-scans/tools into `tmp/loop/perf/value-refcounts-then-register-ops/idw/`: run_one.sh, runs.sh, compare.sh, tablecmp-main.go (build as `tablecmp`), leafdiff.py, and the configs vr.json, mencius.json, crash.json, caps.json. Then:
- change the hardcoded `W=` path;
- add an `sdp` case to run_one.sh: `$B explore -e standard --config $W/sdpaxos.json -y --output-dir $W/sdp-$T bin/spur/SDPaxos.spur`. `sdpaxos.json` is a copy of mencius.json (the file used for the earlier 2,160-run SDPaxos smoke is not on disk). Record the exact file in the report; both sides use it.

**Sessions.** All one-thread, `RAYON_NUM_THREADS=1 RUST_LOG=warn`:

| Session | Explorer | Config | Spec |
|---|---|---|---|
| VR 3,008 | `-e campaign` | vr.json: general_vr.json + session_seed 1000, deterministic_slice_runs 600, deterministic_rounds 1 | VR.spur |
| crash-heavy 1,800 | `-e standard` | crash.json: num_crashes 3, num_partitions 1-2, num_runs_per_config 50, session_seed 4242 | VR.spur |
| Mencius 2,160 | `-e standard` | mencius.json, session_seed 11 | mencius/Mencius_opt1_2.spur |
| SDPaxos 2,160 | `-e standard` | sdpaxos.json | SDPaxos.spur |
| caps-engaged 100,000 | `-e campaign` | caps.json: deterministic_slice_runs 20000, deterministic_rounds 1 | VR.spur |

- Caps-engaged is compared with `CHUNK=2000` for logs and traces. It must show crash holds nonzero (`crash_place.holds` > 0) and equal on both sides.
- Compare with `compare.sh <tag> <kind> text` for every session at A, at B and at C, each against 9340a2e.

**Tests (release).** `RUST_MIN_STACK=33554432 cargo test --release --manifest-path spur/Cargo.toml -p spur-core` passes at each commit, plus `cargo build --release --workspace`.
- **A and B:** the existing `decoded_evaluation_matches_eval_*` differential tests (compiled_eval/test.rs, eval against ceval, over 50,000 cases with coverage of all kinds) pass unchanged in meaning. Fork unit tests. B adds the 30-thread literal test.
- **C, differential test over all 44 Expr variants.**
  - Three evaluators: `eval` (label evaluator), today's `ceval` kept verbatim in the test module as the reference, and the register code.
  - Both hash policies (WithHashing, NoHashing); kept and read-only positions.
  - Compare value, sig, Debug text, error variant and text, the struct and borrow counter deltas (`pending_evaluator_events`), `tree_evals` and `leaf_operands_inline`, and that the scratch is empty after success and after an error.
  - Extend `check_all` / `assert_covered`.
- **C, proptest generator.** Ill-typed operands at every depth, so every fast path's tag check and slow path runs; compare the first error. It must include:
  - a non-collection Find base with an erroring key subtree, and one with a tree-valued key subtree;
  - SafeFind on None and on a non-option, with an erroring key;
  - Coalesce, And and Or whose skipped operand would error;
  - Minus, Times, Div, Mod and Min whose first operand is not an int and whose second would error;
  - ListAppend whose list operand is not a list and whose item would error;
  - StructLit failing at each field.
- **C, exec tests.** Existing exec/test.rs passes. New tests:
  - a vertex that parks (Recv, Pause, SpinAwait) after operands with heap temporaries;
  - a SyncCall chain writing its return into a node slot, checking `Env::writes` increments;
  - an erroring SyncCall inside an Async argument.

---

## 8. Risk flags

- **`spur-core/src/simulator/core/exec.rs`: yes, all three commits.**
  - A: mechanical type change of `arg_vals` (274, 1163).
  - B: type-level only (Rc payloads, WaitingReader through state.rs, literal operands in trace dispatch).
  - C: the main rewrite of `run_common_op`, `run_sync_ops`, `exec_ops`, `run_async_op` and `run_for_loop_in`. Everything that could invalidate C is here: error order, draw points, `Env::writes`, the Return writeback before `continuation.call`.
  - Iterations 7-9 showed large interpreter changes tripping the spread check. The caps-engaged identity is owed before any round.
- **`history.rs`: yes, B only.** Struct key names and string payloads become text through `LocalStr` and `SharedLiteral` in `json_of_value`, `ValueJson` and `MapJson`. No logic change. Guarded by executions, logs and traces byte identity and text digests.
- **Linearizability recording path: yes, by type.** `Operation.payload: Vec<Value<H>>` (state.rs:490) is formatted into executions.payload on the simulation thread in `take_run_rows` (path.rs:180-196). The Value representation changes. Guarded by byte identity of the executions table and its payload digest on all five sessions.
- **Event accounting: not changed.**
  - `Env::writes` and `Env::sig` semantics are preserved.
  - In C, node-slot stores still go through `Env::set`, which is what `State::node_state_token`, the acted flag and `receiver_token_at_send` read.
  - `frame.entry_frame_copies` is preserved through `set_local`.
  - Uniqueness answers are identical in A and B (the judge's verified argument).
- **Run tagging the grader reads: not touched.** `variant_bits`, arm attribution, `run_id`, TERMINATION and the campaign sidecars are not on any edited line.
- **Soundness (B).** A data race is possible only if some path writes an immortal header. One-thread identity cannot see that.
  - Mitigations: the count is private behind three functions; review of the path list in 3.1.1; the 30-thread release test. Program stays Sync by compiler check.
  - Risk: a literal-derived value that is cloned from a static and then mutated in place without going through `is_unique`. The private header makes that uncompilable.
- **Maintenance.** About 2,300 forked lines. The API is copied rather than redesigned.
- **Inlining.** The now-trivial clone and drop may inline into the interpreter loops. Guards are written on family sums (G2) for that reason. Do not add per-symbol relocation guards.
- **Leaked literals.** Bounded by distinct literal text through the intern table. spur-lsp compiles repeatedly, but its distinct literals are bounded by the edited source.

---

## 9. Grading plan

### 9.1 Before building (quiet host)

```
cd research/orchestrator
npx tsx ../perf/grader.ts profile --binary ../../spur/target/release/spur --percent-limit 0.3 --name base-9340a2e-low-cutoff
tmp/loop/perf/it22-census/census-run.sh /home/benaepli/Rust/turnpike/spur/target/release/spur base-9340a2e
```

Confirm the census file is non-empty with nonzero Value-family rows. Record R_base from the low-cutoff profile.

### 9.2 Layout control

The judge requires it before rounds. The A+B band's lower edge (1.04) sits below the 0.05 floor, and the last control (layout-control-e3, build config hash b813e711) predates this epoch's code.

- Build 9340a2e a second time in `tmp/loop/perf/layout-control-e4/` with the same cargo config.
- Grade it against spur/target/release/spur for six rounds: `--search neutral --sharing private --primary cross-binary`, as e3 did.
- Nothing else may run beside it: no compile, no grep-heavy agent, no identity run.
- It must print a floor, not a gain. Record the interval half-width h.
- If it separates, or h > 0.05, stop: the floor in perf.json is wrong and no reading of this composite means anything until it is fixed.
- Otherwise the floor for the decisions below is max(0.05, h).
- If the build config hash has changed since b813e711, this control is mandatory regardless.

### 9.3 A+B session (decision point)

Start command, after the 7.1 reads pass:

```
start --name value-refcounts-ab \
  --cand-bin ../../tmp/loop/perf/value-refcounts-then-register-ops/cand-ab-spur \
  --base-bin ../../spur/target/release/spur \
  --search neutral --sharing shared --primary cross-binary \
  --band-min 1.04 --band-max 1.07 \
  --counter value_refs.literal_clones \
  --argument "<A+B argument below>"
```

- The counter is absent on the baseline, so one structural blocker ("missing on one side") is expected and is not evidence against the mechanism. Its evidence is the absolute candidate-side values in 5.1, read every round.
- Rounds: 3. The judge allows 6 only under a departure registered in the log before round 1.

**A+B neutral argument:**

> The change alters only whether a reference count is written with a lock prefix, and gives program literal strings a count that is never written. Every run executes on one thread and no run-local value crosses a thread (the compiler enforces it: the value types are no longer Send or Sync). So the count seen by every uniqueness check, copy-on-write, Rc::try_unwrap and make_mut at each program point equals the atomic count at the same point today. A literal answers "shared" under the immortal count, as it answers "shared" today because the program holds a handle. Copies are therefore taken exactly where they are taken now, and a copy never changes a value. Container order follows value hashes and insertion order, not pointer kind: the imbl node layout is identical under Rc and Arc, and sequence order is index order. No random draw, candidate set, ranking or event is added, removed or reordered. One-thread byte identity on VR, crash-heavy, Mencius, SDPaxos and a 100,000-run caps-engaged session guards this, as does the spread check on steps per run, end reasons and per-arm counts.

### 9.4 Decision rule after A+B

**Pre-round gates.** If any of these fired in 7.1 or 7.3, A+B is refuted, reverted, and **C is not built**, because the judge admits C only on top of A+B:
- identity differs;
- clones differ from drops;
- literal clones per run outside [200, 20,000];
- `shared_string_copies` differs from the baseline tally;
- census Value-family rows above 0.30, or the census total not falling by 6.5 x r;
- one-thread cycles per run above 0.96;
- G1 or G2 fires;
- the 30-thread test fails.

**On the 3-round reading:**

| Reading | Action |
|---|---|
| Interval entirely below 1.04 | `refuted`: close run-local-value-refcounts, stop the composite |
| Spread check outside without the exemption, or runs per second separating downward | refuted: close, stop |
| Reading in [1.03, 1.07], gates passed, interval not entirely below 1.04 | Read against the 9.2 floor. A+B is not merged on its own unless the grader advises `gain`. It is held as the base for C, and the merge decision moves to the composite. Build C. |
| `gain` in or above band | A+B is mergeable on its own. Still build C, and keep `spur-AB.patch` so A+B can merge alone if C closes. |

### 9.5 C increment session (over A+B)

After the 7.2 reads and the C identity pass:

```
start --name register-ops-over-ab \
  --cand-bin .../cand-abc-spur --base-bin .../cand-ab-spur \
  --base-spur <A+B worktree spur dir if the grader needs it> \
  --search neutral --sharing shared --primary cross-binary \
  --band-min 1.02 --band-max 1.08 \
  --counter register_ops.vertex_ops \
  --argument "<C argument below>"
```

- A structural counter blocker is expected. All 5.2 ratio counters are read by hand every round; any out of band in any round is a falsifier.
- Rounds: 3.
- **Refuted if:**
  - the interval is entirely below 1.02;
  - identity differs;
  - `vertex_ops` differs from `label_execs`, or `tree_evals` differs from the baseline on identity;
  - `slow_path_nodes` > 0;
  - any ratio counter is out of band;
  - stli per label > 0.10, or cycles per run > 0.98;
  - any 7.2 guard fires.
- If refuted, C is closed and reverted. A+B stands alone under 9.4.

**C neutral argument:**

> The change replaces how the interpreter passes a vertex's intermediate and final values: results are written into their destination slot or a reused scratch register instead of stack temporaries, and errors are held beside the loop instead of in the return value. The same vertices execute in the same order with the same pc transitions. Every expression node evaluates its operands in today's order. Where today's evaluator inspects an operand before evaluating a later one (Find and SafeFind before the key, And and Or before the second operand, Coalesce before the default, Minus, Times, Div, Mod and Min before the second operand, ListAppend before the item), the register code checks the same condition first, so the same error arises and the same counters tick. Node-slot stores still count one write each, which the scheduler's node state token reads. Channel and unique ids are allocated, and policy and purgatory draws are made, at the same points of the Async, Send and SetTimer operations. Trace and log text is formatted from identical values. Only frees of temporaries may be reordered, and nothing reads an address. A 44-variant differential test against the current evaluator, a generated ill-typed tree test, and one-thread byte identity on five sessions including 100,000 caps-engaged runs guard this, as does the spread check.

### 9.6 Composite session (over 9340a2e)

```
start --name value-refcounts-then-register-ops \
  --cand-bin .../cand-abc-spur --base-bin ../../spur/target/release/spur \
  --search neutral --sharing shared --primary cross-binary \
  --band-min 1.06 --band-max 1.15 \
  --counter value_refs.literal_clones \
  --argument "<A+B argument, then C argument>"
```

- Rounds: 3; 6 only under a pre-registered departure.
- **Refuted if:** the interval is entirely below 1.06, any part's falsifier fired on its own reading, or identity differs anywhere. On a refuted verdict, the part whose observable did not move is closed.
- **Merge:** the composite merges on `gain` with its counters and observables in hand. If C closed, A+B merges alone only on its own `gain` (9.4).

### 9.7 Expected cost of grading

| Item | Time |
|---|---|
| Layout control, 6 rounds | about 25 min |
| A+B, 3 rounds | about 13 min |
| C over A+B, 3 rounds | about 13 min |
| Composite, 3 rounds | about 13 min |

Plus per commit:
- five identity sessions: VR, crash and SDPaxos in minutes; caps-engaged 100,000 about 1 hour one-thread per side, both sides runnable concurrently;
- the base 9340a2e identity sides, run once;
- two censuses of about 3 min each;
- three low-cutoff profiles;
- two stli and four cycles recordings.

---

## 10. What stops the build early

**Before building**
- The 9340a2e census is empty or header-only, or the low-cutoff profile fails. Fix the tooling first; nothing downstream can be read.
- spur-research-loop is active, or another grader is measuring. Wait.

**Commit A**
- Identity differs on any session. This is a bug, not a result: find the path whose behavior changed (usually Hash, Debug or Ord delegation in the fork). If it cannot be made identical, close.
- The workspace build shows a Value crossing a thread in non-test code. The judge's audit is then wrong. Stop and report; do not add `unsafe impl Send`.

**Commit B**
- The 30-thread literal test fails, or any path to the count is found outside the three header functions. Stop: this is a soundness failure.
- `spur compile` program.json differs.
- imbl RcK does not compile for some impl the simulator needs (not expected; the judge verified). Keep that map or vector on ArcK, disclose it, and expect G2 and census margins to tighten.

**A+B mechanism reads**, each a refutation that stops the composite because C is not built:
- census Value-family rows above 0.30;
- the census total does not fall by 6.5 x r;
- one-thread cycles per run above 0.96;
- G1 or G2 fires;
- clones differ from drops;
- `shared_string_copies` differs from the baseline tally.

**Layout control** prints a gain or h > 0.05. Stop all rounds; the operator fixes the floor.

**A+B rounds**
- Interval entirely below 1.04 on the layout-controlled read. Refuted; close and stop.
- Spread check outside without the exemption, or downward separation. Refuted; stop.

**Commit C** (each reverts C before rounds; A+B stands alone)
- The differential or proptest suite cannot be made to agree within the ordering constraints of 3.3.2.
- Identity differs, or `tree_evals` differs from the baseline on identity.
- `slow_path_nodes` > 0 on VR.
- stli per label above 0.10.
- Cycles per run above 0.98 over A+B, or the stack above 0.94 over 9340a2e.
- Any 7.2 guard fires.
- Objdump of the hot arms shows the destination Value still built on the stack and then copied in every arm. Report it; the stli observable decides.

**Any stage**
- `history_writer.blocked_ns` > 0 in rounds, or RSS per thread up more than 2 percent. Cost clause fails.

---

### Critical Files for Implementation
- /home/benaepli/Rust/turnpike/spur/spur-core/src/simulator/core/values.rs
- /home/benaepli/Rust/turnpike/spur/spur-core/src/simulator/core/exec.rs
- /home/benaepli/Rust/turnpike/spur/spur-core/src/simulator/core/compiled_eval.rs (with compiled_eval/test.rs)
- /home/benaepli/Rust/turnpike/spur/spur-core/src/compiler/cfg/compiled.rs (and ir.rs, cfg.rs for the literal set)
- /home/benaepli/Rust/turnpike/spur/spur-core/src/simulator/util_stats.rs (with state.rs, history.rs, explorer.rs fold sites)
