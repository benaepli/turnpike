# Plan: `exec-node-env-in-place`

## 0. Operator note on the frozen band

The planning pass proposed relaxing the band to `[1.00, 1.10]` on the
grounds that the instrument cannot resolve a tighter one and that the sharp
predictions belong to the counters. The reasoning about the instrument is
right; the conclusion is not. A band that contains 1.0 predicts nothing,
which the proposer prompt rules out, and the loop's own discipline says a
prediction is graded rather than rewritten to be easier to pass.

**The band stays as the proposer froze it: `[1.05, 1.14]`.** A reading whose
interval falls entirely below 1.05 is then `refuted`, and that is the
correct record: the candidate predicted at least a five percent saving and
did not deliver one. A refuted prediction is a result. The counters remain
the sharp mechanism evidence, as the planning pass argued; they do not
replace the band.

## 1. Hypothesis and declarations

**Hypothesis.** The simulator copies a node's whole role-slot array once per
executed segment. `exec` (`spur/spur-core/src/simulator/core/exec.rs:564`)
and `exec_sync_on_node` (`exec.rs:87`) each take `state.nodes[i].clone()`.
Because `state.nodes[i]` keeps its own handle, the `EcoVec` refcount is 2,
so the segment's first `Env::set` (`core/values.rs:707`,
`self.slots.make_mut()[idx] = value`) calls `EcoVec::make_unique`: one
allocation, one memmove, one `Value::clone` per slot (VR's `Node` role
declares 21 slots, 12 of them list or map, so each of those clones is an
`Arc`/refcount touch), and then the exit-path writeback drops the old buffer
with a full `drop_glue::<ValueKind>` walk.

Take the env out of the slot instead of cloning it. The refcount stays 1,
`make_mut` is a no-op, and the writeback that already exists on every exit
path puts it back.

**Search declaration: `neutral`.** Nothing the search reads is derived from
slot-array identity. The two observation handles that cross from `Env` into
scheduling - `Env::sig` and `Env::writes` - are preserved verbatim by the
new operation, which is the whole reason it is a bespoke method rather than
`std::mem::take`.

The declaration is measured, not argued: it is guarded by a third counter,
`env_traffic.recv_node_slot_stores`, whose frozen prediction is exactly 0
per run. If it reads above 0 on any round, the one behavior change this
candidate carries (section 8) actually fired on this workload, the `neutral`
declaration is refuted, and the candidate closes rather than being
re-declared `affecting` mid-flight.

**Sharing declaration: `shared`.** The cost removed is allocator traffic,
memory bandwidth and cache footprint. All three travel between runs through
the shared allocator and the shared cache hierarchy, so the untreated half
of a within-binary contrast gets faster too and that contrast reads flat
exactly when the mechanism works. The grader refuses `--primary
within-binary` under a `shared` declaration for this reason, and it is right
to.

## 2. The cost being removed, and where the profile shows it

`research/perf/profiles/12b7582.md`, flat self time, 30 threads, 30s on
`scheduler_configs/loop/general_vr.json` over `bin/spur/VR.spur`. The
copy-on-write fault and its fallout account for these lines:

| Symbol | Self | Why this change touches it |
|---|---|---|
| `EcoVec::<Value>::make_unique` | 1.45% | The fault itself. Fires once per segment that writes any role slot. |
| `<EcoVec<Value> as Drop>::drop` | 1.04% | The old buffer released when the writeback replaces it. |
| `Value::clone` | 2.08% | 21 per fault on VR's `Node`. |
| `drop_glue::<ValueKind>` (two lines) | 1.26% + 1.11% | Releasing the 21 cloned `Value`s. |
| `__memmove_avx512_unaligned_erms` | 2.62% | The slot-array copy. |
| `_int_malloc` / `malloc` / `cfree` | 2.38% / 1.54% / 1.16% | One malloc-free pair per fault, plus whatever the cloned `Value`s allocate. |

None of these lines is exclusively this site - `Value::clone` and the
allocator trio serve the whole interpreter - so the profile bounds the prize
from above, not from below. The honest statement is: the mechanism is a
fraction of roughly 11% of self time, and the plan does not predict what
fraction.

## 3. Files and mechanisms to change

### 3a. `spur/spur-core/src/simulator/core/values.rs` - add `Env::detach`

`Env` is at `values.rs:626`: `pub slots: Slots<H>`, `pub sig: u64`,
`pub writes: u64`, and a private `_marker: PhantomData<H>`. The private
field is why this method must live in `values.rs`.

Add to the existing `impl<H: HashPolicy> Env<H>` block (the one starting at
`values.rs:653`), directly after `with_slots`:

```rust
/// Move the slots out, leaving behind an env that still answers `sig` and
/// `writes` but owns no slots. The returned env holds the only reference to
/// the slot buffer, so writing a slot does not copy it. Nothing may read
/// slots from the emptied env before the caller puts an env back.
pub fn detach(&mut self) -> Env<H> {
    Env {
        slots: std::mem::take(&mut self.slots),
        sig: self.sig,
        writes: self.writes,
        _marker: PhantomData,
    }
}
```

What it leaves behind, precisely: `slots` an empty `EcoVec`
(`EcoVec::default()` is `EcoVec::new()`, which allocates nothing), `sig`
unchanged, `writes` unchanged. Do not use `std::mem::take(self)` or
`std::mem::replace(self, Env::default())` - `Default` zeroes `sig` and
`writes`, which breaks the search (section 9).

### 3b. `spur/spur-core/src/simulator/core/exec.rs` - five edits

Imports (line 1) already bring in `VarSlot`; add `Lhs`:
```rust
use crate::compiler::cfg::{Instr, Label, Lhs, Program, VarSlot};
```
`util_stats` is already imported at `exec.rs:13`.

**Edit 1 - `exec_sync_on_node`, `exec.rs:87`.**
```rust
let mut node_env = state.nodes[node_id.index].detach();
let writes_at_entry = node_env.writes;
```
and at `exec.rs:103`, before the existing
`state.nodes[node_id.index] = node_env;`, record the traffic (section 5).
This function writes back unconditionally, on `Ok` and on `Err` alike, so it
needs no other care.

**Edit 2 - `exec`, `exec.rs:564`.**
```rust
let mut node_env = state.nodes[record.node.index].detach();
let writes_at_entry = node_env.writes;
```

**Edit 3 - the four writeback exits of `exec`: lines 615, 686, 695, 705.**
Each is `state.nodes[node_id.index] = node_env;`. Leave the assignment where
it is and put the counter call immediately before it. To avoid four copies
of the same two lines, add a private helper next to `exec`:

```rust
#[inline]
fn restore_node_env<H: HashPolicy>(
    state: &mut State<H>,
    node: NodeId,
    env: Env<H>,
    writes_at_entry: u64,
) {
    util_stats::record_env_traffic(env.writes.wrapping_sub(writes_at_entry));
    state.nodes[node.index] = env;
}
```
and call `restore_node_env(state, node_id, node_env, writes_at_entry);` at
each of the four sites. At `exec.rs:615` this must stay before
`record.continuation.call(state, val)` on line 616, which it already is -
that continuation reaches `state.rs:1567`, which clones
`state.nodes[node_index]`, and would read the emptied env otherwise.

**Edit 4 - the aliasing site, `exec.rs:654-658`. This edit is mandatory, not
an optimization.** Today:
```rust
Some((mut reader, lhs)) => {
    let node_index = reader.node.index;
    let mut r_node_env = state.nodes[node_index].clone();
    store(&lhs, val, &mut reader.env, &mut r_node_env)?;
    state.nodes[node_index] = r_node_env;
    state.push_to_local(node_index, Runnable::Record(reader));
}
```
After edit 2, `state.nodes[node_index]` is the emptied env whenever
`node_index == record.node.index`, so this clone would hand `store` an env
with zero slots and a `VarSlot::Node` target would panic on the index, while
the subsequent assignment would clobber the live env's `sig`/`writes`
bookkeeping. Replace it with:
```rust
Some((mut reader, lhs)) => {
    let node_index = reader.node.index;
    if matches!(lhs, Lhs::Var(VarSlot::Node(_, _))) {
        util_stats::record_recv_node_slot_store();
    }
    store(&lhs, val, &mut reader.env, &mut node_env)?;
    state.push_to_local(node_index, Runnable::Record(reader));
}
```
`Lhs` has exactly one variant, `Lhs::Var(VarSlot)` (`core/eval.rs:41`), so
the `matches!` is total.

**Why using the live `node_env` here is sound.** `push_waiting_reader` has
exactly one call site, `exec.rs:685`, inside the `Label::Recv` branch under
the guard `cid.node == record.node`; every waiting reader therefore
satisfies `reader.node == cid.node`. This local-`Send` branch is the `else`
of `cid.node != record.node` at `exec.rs:621`, so here
`cid.node == record.node`. Composing: `reader.node == record.node`. The node
re-read at `:656` is provably the same node whose env `exec` already holds.
Keep `node_index` bound - `push_to_local` still needs it.

**Edit 5 - nothing else.** The three sibling clone/writeback pairs are
deliberately untouched and remain sound: `core/scheduler.rs:1454` (timer
completion) and `core/scheduler.rs:1766` (remote channel delivery) run
outside `exec`, and `core/state.rs:1567` (`Continuation::Async`) is reached
only from `exec.rs:616`, which is after the writeback.

### 3c. `spur/spur-core/src/simulator/util_stats.rs` - the `env_traffic` group

See section 5 for the exact insertion points.

### 3d. `spur/spur-core/tests/util_stats_export_completeness.rs`

`block_names` at line 1885 destructures `UtilizationSnapshot` with no rest
pattern, so adding a block is a compile error until the test names it. Two
edits, both mechanical:
- add `env_traffic: _,` to the destructuring pattern (line 1886-1925), in
  the same position the field takes in the struct;
- add `"env_traffic",` to the returned `vec![...]` in the same position.

Do not add an `env_traffic` builder to `marked_snapshot` or to the
marked-block list in `every_counter_field_reaches_the_written_json` - that
list is opt-in, and blocks not on it are checked only for presence.

### Style

`research/STYLE.md` applies to every line written. The doc comment on
`detach` above states its constraint (the caller holds the only reference;
nothing may read slots from the emptied env) and says nothing about what the
code used to do. No comment anywhere may mention a clone that was removed, a
bug that was fixed, this plan, or an iteration number. ASCII only.

## 4. Config surface

**None.** Confirmed by inspection: the mechanism has no arm to switch.
`detach` is unconditionally cheaper than `clone` at every call site - it does
strictly less work and the writeback that restores the slot already exists
on every path. There is no workload on which keeping the redundant handle is
preferable, so there is nothing a configuration key would select between. No
entry is added to `EXPLORER_CONFIG_KEYS`
(`spur/spur-core/src/simulator/explorer.rs:362`), and no entry is added to
`CONTINUOUS_CONFIG_KEYS`. The key-set tests at `explorer.rs:2868-2899` are
unaffected.

## 5. Counters

One new group, `env_traffic`, with three fields. The graded dotted paths are
`env_traffic.node_slot_copies`, `env_traffic.node_slot_writes`,
`env_traffic.recv_node_slot_stores` - `flatCounters` in
`research/perf/grader.ts` walks the dump into dotted paths, so the group
name plus the field name is the path.

**The counters must not be incremented per slot write.**
`util_stats::enabled()` is true on the graded workload - `campaign.rs:959`
rejects a campaign config with `stats: false`, and
`scheduler_configs/loop/general_vr.json` is a campaign template - so every
`fetch_add` on this path is a live contended atomic across 30 rayon threads.
An instrument that taxes the treatment it is measuring corrupts the primary.
Therefore both hot counters are derived from the `Env::writes` delta at the
segment's exit: at most two relaxed atomics per executed segment, and none
at all for a segment that wrote no role slot. That is the same order as the
per-step atomic the session already pays in `record_steer_reach`
(`path.rs:871`).

### Definitions

- **`node_slot_copies`** - executed segments that assigned at least one
  role-scope slot. On the baseline, each of these is exactly one
  `EcoVec::make_unique` call: the clone made the buffer shared, and the
  segment's first `set` faulted it. On the candidate, each is exactly one
  such call avoided. This is the count of the thing removed.
- **`node_slot_writes`** - total `Env::set` calls against node envs, summed
  over all segments. The size of the work whose first member used to fault:
  the ratio `node_slot_writes / node_slot_copies` says how many slot
  assignments a copying segment makes.
- **`recv_node_slot_stores`** - local-channel sends that handed a value to a
  waiting reader whose `lhs` resolves to `VarSlot::Node`. This is the guard
  on the neutral declaration (section 8), and its predicted value is 0.

### Insertion points in `util_stats.rs` (7108 lines)

Follow the file's existing group convention, read off `DEDUP_*`:

1. **Statics** - after the `TIMER_CONTEXT_*` statics (they end at line 676,
   immediately before `static TIMELINE_KEYS` on line 677):
```rust
static ENV_NODE_SLOT_COPIES: AtomicU64 = AtomicU64::new(0);
static ENV_NODE_SLOT_WRITES: AtomicU64 = AtomicU64::new(0);
static ENV_RECV_NODE_SLOT_STORES: AtomicU64 = AtomicU64::new(0);
```
2. **Reset list** - `set_enabled` (line 688) resets every counter through one
   array literal, `for c in [ ... ]`, which runs from line 691 to roughly
   line 780. Append
   `&ENV_NODE_SLOT_COPIES, &ENV_NODE_SLOT_WRITES, &ENV_RECV_NODE_SLOT_STORES,`
   to it. Skipping this leaks counts between sessions in one process and
   breaks the campaign's per-slice delta.
3. **Record functions** - next to `record_dedup_check` (line 1697), which is
   the pattern to copy (`#[inline]`, early return on `!enabled()`,
   `Ordering::Relaxed`):
```rust
/// One executed segment finished on a node; `writes` is how many role-scope
/// slots it assigned. A segment that assigned at least one is a segment
/// whose slot array a second handle would have forced a copy of.
#[inline]
pub fn record_env_traffic(writes: u64) {
    if writes == 0 || !enabled() {
        return;
    }
    ENV_NODE_SLOT_COPIES.fetch_add(1, Ordering::Relaxed);
    ENV_NODE_SLOT_WRITES.fetch_add(writes, Ordering::Relaxed);
}

/// A local channel send handed its value to a waiting reader whose target is
/// a role-scope slot rather than a local slot.
#[inline]
pub fn record_recv_node_slot_store() {
    if !enabled() {
        return;
    }
    ENV_RECV_NODE_SLOT_STORES.fetch_add(1, Ordering::Relaxed);
}
```
Note the `writes == 0` test comes first, so a non-writing segment costs a
compare and a branch, not an atomic load.
4. **Struct** - immediately after `DedupStats` (line 4089-4094):
```rust
#[derive(Serialize)]
pub struct EnvTrafficStats {
    pub node_slot_copies: u64,
    pub node_slot_writes: u64,
    pub recv_node_slot_stores: u64,
}
```
5. **`UtilizationSnapshot`** (line 6004) - add
   `pub env_traffic: EnvTrafficStats,` immediately after
   `pub dedup: DedupStats,`.
6. **`snapshot()`** (line 6112) - add the matching initializer immediately
   after the `dedup:` block (line 6163-6167):
```rust
env_traffic: EnvTrafficStats {
    node_slot_copies: ENV_NODE_SLOT_COPIES.load(Ordering::Relaxed),
    node_slot_writes: ENV_NODE_SLOT_WRITES.load(Ordering::Relaxed),
    recv_node_slot_stores: ENV_RECV_NODE_SLOT_STORES.load(Ordering::Relaxed),
},
```
`render_snapshot`, `delta` and `add` are all structure-generic, so the group
reaches both `utilization.json` and the campaign's per-arm counter objects
with no further wiring. `tests/stats_export_parity.rs` should pass
unchanged.

### Frozen per-run predictions

Read candidate-side from `.utilization.json` divided by the round's run
count. Hard predictions are falsifiers; soft ones are shape checks that, if
they fail, mean the wiring is wrong and the reading should be discarded
rather than believed.

| Counter | Predicted per run | Kind | Meaning of a failure |
|---|---|---|---|
| `env_traffic.node_slot_copies` | > 0, and of the order of the segments a VR run executes (tens to hundreds) | hard | 0 means the mechanism never fired: either the detach is not on the executed path or the group is not wired. Close the candidate; nothing has been measured. |
| `env_traffic.node_slot_writes` | >= `node_slot_copies`, with a ratio of roughly 1.5 to 6 | hard on the inequality, soft on the ratio | Below the inequality is arithmetically impossible and means the delta is computed against the wrong baseline `writes`. A ratio near 1.0 means VR handlers write one slot each, which would shrink the per-fault prize; report it, do not close on it. |
| `env_traffic.recv_node_slot_stores` | exactly 0 | hard | Above 0 on any round means the behavior change in section 8 fired on this workload. The `neutral` declaration is refuted and the candidate closes. |

The zero on the third counter is a meaningful zero, not a vacuous one:
`bin/spur/VR.spur:116` contains `send(ch, resp)` inside `Node.send_async`,
whose channel was made by the same node, so the local-`Send` branch at
`exec.rs:650` is reached on this workload and the reader-wakeup arm does
execute. All seven `<-` sites in `VR.spur` (lines 227, 591, 599, 606, 640,
655, 668) bind either a local `var resp`, a compiler temp, or nothing; none
names a role-scope variable. The site fires and the predicate is false.

## 6. Treatment bit

**None is available, and none would be valid.**

Unavailable: `VARIANT_BITS` in `research/orchestrator/src/decide.ts` already
names all 31 slots `2^0` through `2^30`, and that file belongs to the
measurement harness, which this loop does not edit.

Invalid regardless: the within-binary contrast splits runs inside one
binary, but the saving is declared `shared`. Both cells of one session draw
from the same allocator arenas, the same last-level cache and the same rayon
pool, so allocator pressure the treated runs stop creating makes the
untreated runs faster too. The contrast reads flat exactly when the
mechanism works best. The grader enforces this at declaration time
(`selectInstrument`, `grader.ts:279`).

## 7. Predicted observables, and what must not move

**Should move (confirmation, not primary):**
- Cross-binary campaign runs per second: up. Magnitude not predicted beyond
  the frozen band. The mechanism's own atomics push the other way by a
  small, unpredicted amount.
- Microseconds per run: down, by the same ratio, since steps per run is held
  fixed.

**Must not move** - these are the grader's `searchNeutralityChecks`, each
compared against the baseline's own round-to-round spread
(`spreadMultiple: 2`, floor `minEffect: 0.01`):
- **steps per run** - identical distribution. The change removes no step and
  adds none.
- **end-reason shares** (`plan_complete`, cap exits, stall exits) -
  unchanged.
- **per-arm run shares** - unchanged. The campaign allocator reads the
  reward counter, which is untouched.
- The **RNG draw order** - no draw is added, removed or reordered.
  `policy.sample`, `purgatory_hold_steps` and the arm draws are not on any
  edited line. This is the trap the goal file names explicitly, and this
  candidate does not step in it.

## 8. The disclosed behavior change

There is exactly one, and it must be measured rather than argued away.

Today, at `exec.rs:654-658`, a local `Send` that wakes a waiting reader
whose `lhs` is a `VarSlot::Node` writes `state.nodes[node_index] =
r_node_env` mid-loop. That assignment is then unconditionally clobbered by
the exit-path writeback of the env cloned at `:564` - the same node's env,
taken before the store. So today such a store is silently lost. After edit 4
the store goes into the live `node_env` and survives.

This is a bug fix. It is nonetheless a behavior change and it is the reason
the `neutral` declaration needs a measurement rather than an assertion.
`env_traffic.recv_node_slot_stores` counts precisely the events on which the
old and new code differ. A reading of 0 says the two programs are
observationally identical on this workload. A reading above 0 says they are
not, and the candidate closes.

## 9. Risk flags

**Touches `spur-core/src/simulator/core/exec.rs`: YES.** Five edit sites,
all in the node-env lifecycle: the two entries and the four exits plus the
reader-wakeup arm. This is the hottest file in the profile and the one every
run traverses.

**Touches `history.rs`: no.** Not edited, not read by any edited line.

**Event accounting: examined in detail, and this is the load-bearing part of
`detach`.** There is a chain from `Env::writes` into search-visible
scheduling:

`Env::writes` (declared `values.rs:634`, incremented `values.rs:683`) ->
`State::node_state_token` (`state.rs:992-994`, which is literally
`self.nodes[node.index].writes`) -> three consumers:
- `State::stale_late` (`state.rs:1347-1352`), a weighted steering `Term` -
  search-visible;
- the `acted` flag at `scheduler.rs:1708` and `scheduler.rs:1476`, which
  feeds ghost-delivery marks and rewards;
- `receiver_token_at_send` (`exec.rs:273`), read mid-execution when an async
  call is spawned, possibly against the executing node itself.

And separately, `Env::sig` -> `State::signature` (`state.rs:1429`) ->
`state.rs:1496`'s `Hash`, which is the dedup key; and `Env::writes` again in
`note_ghost_delivery` (`state.rs:1195`).

**`detach` preserving `sig` and `writes` is therefore not cosmetic.** Using
`std::mem::take` or leaving `Env::default()` behind would zero both, change
`stale_late`, change `acted`, change every state signature, and make the
neutral declaration false. The implementer must write `detach` exactly as
given in 3a, and a reviewer should check that line specifically.

With `sig` and `writes` preserved, an exhaustive check of every read of
`state.nodes` outside `exec.rs` shows no exposure: `state.rs:993` and
`state.rs:1195` read `writes` only; `state.rs:1429` reads `sig` only;
`state.rs:1567` is reached only after the writeback; `scheduler.rs:1454`,
`:1766`, `:2203`, `:2206`, `:2277`, `path.rs:178`, `:230` and
`explorer.rs:806`, `:873` all execute outside `exec`'s dynamic extent.
Inside `exec.rs` the only slot reads of the executing node's env go through
the local `node_env` binding.

**Linearizability recording path: no exposure.** A client operation's result
leaves through `StepOutcome::Return` at `exec.rs:613-618`, and the writeback
on line 615 precedes `record.continuation.call` on line 616.
`ClientOpResult` and the `Operation` rows pushed at `path.rs:900-910` are
untouched.

**Run tagging the grader reads: no exposure.** `variant_bits`, arm
attribution, `run_id` and the session/campaign sidecars are not on any
edited line. The grader's `runsTable` reads the same columns it reads today.

**The one open exposure: the error path in `exec`.** `exec` propagates
`RuntimeError` with `?`, skipping the writeback. Today that leaves
`state.nodes[i]` holding the pre-segment env; after the change it leaves an
env with zero slots. This is a real divergence, and it is safe only because
such an error terminates the run: `exec`'s two call sites
(`scheduler.rs:1697`, `:2305`) both `?`, `schedule_runnable`'s single call
site (`path.rs:873`) `?`s, `exec_plan` returns
`Result<RunOutcome, RuntimeError>`, and its callers (`explorer.rs:1123`,
`:1463`) `?` it, dropping `path_state` without scheduling another step. The
implementer must not "fix" this by restructuring `exec` to write back on
error - that would add a code path and change nothing observable. But if a
later change ever makes a `RuntimeError` recoverable mid-run, this becomes a
live bug, and that is worth a line in the commit message.

**`cargo test -p spur-core`.** No existing test exercises a `Recv` into a
role-scope slot, so no test should change its result. All ten fixtures under
`spur/spur-core/tests/fixtures/` were checked: every `<-` binds a local
(`ok` in `stall.spur:22` and `stall_release.spur:43` are `var ok: bool`
locals inside `ClientInterface.Write`) or is a bare tail expression, and
none contains a `>-` or `send(` at all, so the local-`Send` reader-wakeup
arm is not even reached in the fixture suite. The one test that will fail to
compile until edited is `tests/util_stats_export_completeness.rs`
(section 3d) - by design; that file exists to make an unexported counter a
build failure. Expect `cargo test -p spur-core` to be red on exactly that
file before the two-line edit and green after.

## 10. Grading plan

### Instrument

The `shared` declaration removes the within-binary contrast. The counters
are new, so the grader reads `NaN` for them on the baseline binary and
`counterReading.presentOnBothSides` is false - a counter the candidate
introduces cannot be the primary. The primary is therefore cross-binary
campaign runs per second, read against the layout control.

Declaration:
```
--search neutral
--sharing shared
--primary cross-binary
--counter env_traffic.node_slot_copies
--band-min 1.05 --band-max 1.14
--argument "<section 10 argument text>"
```

`--counter` is passed even though it cannot separate. Omitting it trips the
blocker at `grader.ts:794` (names no per-run counter), which is
substantively false - the change does name counters. Passing it trips the
blocker at `grader.ts:797` (missing from the utilization dump on at least
one side), which is substantively true and structurally unavoidable for any
candidate that introduces its own counter against an unpatched baseline.
Expect that one blocker to stand on the final reading, and read it as
structural. It does not prevent an `adviceVerdict` of `gain`; it appends
"1 blocker(s) stand" to the reason. The decider must be told in advance that
this blocker is the known cost of a first-of-its-kind counter and is not
evidence against the mechanism. The counter's own evidence is its absolute
candidate-side per-run values against the frozen predictions in section 5,
read out of `.utilization.json` directly.

### Frozen band

`[1.05, 1.14]`, as the proposer froze it. See section 0 for why the
relaxation proposed during planning was not taken.

`bandReadingOf` returns "below" - a hard `refuted` verdict - when the whole
t-interval falls under 1.05. With the layout control's per-round sd of about
4.5% and six rounds the interval half-width is roughly 4.7%, so a candidate
whose true effect is near zero will read `refuted` rather than `no-gain`.
That is the band doing its job: the candidate predicted at least five
percent and would not have delivered it.

### What separation requires

`separates()` (`grader.ts:504`) requires all three of: `|mean - 1| >= 0.05`
(the cross-binary floor is `max(layoutFloor 0.05, minEffect 0.01)`), the
t-interval excluding 1, and `dominant` - every single round's ratio on the
same side of 1. Dominance is the binding constraint. The layout control on
this host reads mean about 0.99 with a per-round sd of about 4.5% over six
rounds. A true 5% effect has roughly a 40% chance of being dominant over six
rounds; a true 10% effect roughly 90%. A `no-gain` verdict from this
instrument is much weaker evidence against the mechanism than a `gain`
verdict is for it, and the log should say so rather than recording that the
mechanism does not work.

### Expected rounds

Buy the minimum 3, then continue to the cap of 6 unless the primary has
already separated. Three rounds cannot produce dominance evidence worth
trusting at this effect size; plan on 5 or 6, at 120s per side per round and
30 rayon threads, so about 20-24 minutes of campaign wall time for a full
6-round reading plus build time for both binaries.

### The written argument the `neutral` declaration owes

Pass this verbatim as `--argument`:

> The change removes a copy of a node's role-slot array, not a step, a draw,
> or a decision. Every random draw the explorer makes - the schedule
> policy's priority samples, the purgatory hold roll and its duration, the
> arm selector's choice - is made on lines this change does not touch, in
> the same order, from the same streams. Steps per run, end reasons and
> per-arm shares are therefore expected to hold their distributions, and the
> grader's own spread check against the baseline's round-to-round variation
> is the guard on that.
>
> The two properties of a node env that the search can actually observe are
> its signature and its write count. The signature feeds the state hash used
> for deduplication; the write count feeds the node state token, which feeds
> the weighted stale-late term, the acted flag on delivery and timer
> outcomes, and the receiver token stamped on a spawned record. The
> operation that replaces the clone carries both across verbatim, changing
> only which of the two handles owns the slot buffer, and the search reads
> neither the buffer's address nor its reference count.
>
> There is one place where the old and the new program can differ. A local
> channel send that wakes a waiting reader whose assignment target is a
> role-scope slot writes that slot today into a copy that the executing
> segment's own writeback then overwrites, so the store is lost; after the
> change the store lands. This candidate does not assert that this cannot
> happen - it counts it. The counter env_traffic.recv_node_slot_stores is
> incremented at exactly that site, and its frozen prediction is zero per
> run. That zero is not vacuous: the workload does reach the site, because
> the specification under test performs a local channel send whose reader
> waits on the same node, and every receive in that specification binds a
> local slot rather than a role-scope one. If the counter reads above zero
> on any round, the two programs are not observationally identical on this
> workload, this declaration is refuted, and the candidate closes.
