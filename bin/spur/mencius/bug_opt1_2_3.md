# Mencius Paper Bug: Optimization 1 × Optimization 3 interaction

## Summary

This is the faithful **Optimization 3** variant of the `bug_opt1_2.md` finding.
The full Mencius algorithm (Appendix C) is Protocol P + Optimizations 1–3 +
Accelerator 1. Optimization 3 is the **β-window bulk revocation** in
`OnSuspect(q)`:

> On suspecting `q`, revoke every unlearned `q`-owned slot in
> `[C_q, index + 2β]` (gated on `C_q < index + β`), not just one or two.

Once Optimization 3 is in place, the **Optimization 1** skip-inference
(`on_accept_suggestion → fill_q_skips`) can fabricate a `no-op` over a slot a
quorum has already committed. The root cause is identical to `bug_opt1_2.md`
— the unguarded `QSkipSet` gap-fill — but the **trigger path is different and
is only reachable once opt 3 revokes a block of the coordinator's slots**:

- In `bug_opt1_2.md` (ad-hoc `limit=3` revoke) only slot 2 gets revoked, so the
  owner's later `SUGGEST` to slot 5 is still *accepted*, and the bug routes
  through the receiver-side `on_suggestion` (a **peer's** slot).
- Here, the β-window revokes **all** of `q`'s slots (2, 5, 8…), so the owner's
  SUGGESTs to those slots are *rejected* on the ballot test. The bug is forced
  through the proposer's **own** slot via the proposer-side
  `on_accept_suggestion` (Optimization 1 proper).

The fix is identical (ballot guard in `fill_q_skips` + NACK/self-revoke); see
`Mencius_opt1_2_3_fixed.spur`.

## Classification

**Paper bug.** The pseudocode in Appendix C (full Mencius, including opt 3),
translated faithfully, exhibits the violation. Bare Protocol P
(`Mencius_P.spur`, Appendix B) does *not*: its Rule 2 only skips `p`'s own
instances via explicit `Skip()`, and its `OnSuspect` revokes only slots below
`index`. No crashes, message loss, or partitions are required — only a
concurrent (here, block) revoke and a false suspicion, which the paper permits
(its failure detector is only *eventually* accurate).

## The machinery (ground up)

Three servers **p0, p1, p2** agree on an infinite list of **slots**
(instances). Slots are pre-assigned round-robin to a **coordinator**
(`owner(i) = i % n`): p0 owns 0,3,6,…; p1 owns 1,4,7,…; p2 owns 2,5,8,….
To fill a slot the servers run one Coordinated Paxos round:

- **Ballots.** A slot is decided over numbered *ballots*. Ballot 0 belongs to
  the slot's coordinator and every server is pre-prepared for it, so the
  coordinator fills its own slot in one shot.
- **The two normal moves a coordinator makes** (both `PROPOSE(0, …)`):
  - **SUGGEST** = `PROPOSE(0, v)` — put real value `v` here.
  - **SKIP** = `PROPOSE(0, no-op)` — leave this slot empty.
- **Per slot, each server keeps** `prepared_ballot`, `accepted_ballot`,
  `accepted_value`, `learned`.
- **Accepting.** On `PROPOSE(b, v)`, accept iff `prepared_ballot ≤ b ∧
  accepted_ballot < b`. On accept, record the value and send `ACCEPT`.
- **Chosen.** A value is chosen once a quorum (2 of 3) accepts it — locked
  forever (Paxos safety). Whoever sees the quorum broadcasts `LEARN(v)`;
  each server sets `learned ← v`.
- **Revoking.** A server that suspects the coordinator grabs a *higher* ballot
  and runs Phase 1: `PREPARE(b)` makes recipients bump `prepared_ballot` to
  `b`. After that only ballot-`b`+ proposals are accepted — older ballot-0
  proposals are rejected by the accept test above. **This is what bites.**

## The one optimization that causes the bug (Optimization 1)

To make slot-filling nearly free when a server has nothing to say, Mencius
makes other servers **infer** skips instead of broadcasting an explicit SKIP
for every empty slot. Each server keeps `est_index[q]` = "the lowest
`q`-owned slot I haven't accounted for yet" (e.g. for p1 at the start,
`est_index[p2] = 2`). The inference rule (Appendix C `OnAcceptSuggestion` /
`OnSuggestion`):

> When I process a message from `q` about `q`'s slot `i`, then every
> `q`-owned slot below `i` that I haven't already learned, I conclude `q`
> skipped — so I write `no-op` into those slots myself.

Justification (Lemmas 5/6): the channel is FIFO, so by the time `q`'s message
about slot `i` reaches me, I've already received everything `q` sent earlier.
If `q` had *suggested* a real value to some earlier slot `j`, I'd know. I
don't, therefore `q` skipped `j`.

The hidden assumption — the whole bug:

> "I haven't *processed* a real suggestion from `q` for slot `j`" is treated
> as equivalent to "q never *sent* one."

That holds in the base protocol. It stops holding once **revocation** exists:
revocation lets me **receive** `q`'s real suggestion and then **throw it away**
on the ballot test, without recording anything. The suggestion was sent and
received; it left no trace. The inference then fabricates a `no-op` over a slot
the coordinator genuinely used.

The buggy rule in `Mencius_opt1_2_3.spur`, `fill_q_skips` (lines **417–428**):

```spur
fn fill_q_skips(q: int, i: int) {
    var j = est_index[q];
    for ; j < i; {
        if j % n == q {
            learn_slot(j, nil);   // ← unconditional no-op learn (BUG)
        }
        j = j + 1;
    }
    if i >= est_index[q] {
        est_index = est_index[q] := next_owned(i, q);
    }
}
```

It is invoked from:

- `on_accept_suggestion` (line **432**) — proposer-side, when `q` sends an
  ACCEPT at ballot 0. **This is the path the opt-3 trace uses.**
- `on_suggestion` (line **440**) — receiver-side, when a ballot-0 SUGGEST with
  a real value arrives (the path used in `bug_opt1_2.md`).

## The opt-3 revoker (Optimization 3)

`on_suspect` (lines **784–797**) implements the Appendix C β-window:

```spur
fn beta_window(): int { 2 }

fn on_suspect(q: int) {
    var c_q = first_owned_from(est_index[q], q);
    if c_q < my_index + beta_window() {
        var upper = my_index + 2 * beta_window();
        var i = c_q;
        for ; i <= upper; {
            if i % n == q and !is_learned(i) and !exists(revoke_ballot, i) {
                start_revoke(i);
            }
            i = i + 1;
        }
    }
}
```

`β` is the paper's `β` (the paper uses 100000; we use 2 so the simulator stays
bounded). With `my_index = 1`, the window is `[2, 5]`, so suspecting p2 revokes
slots **2 and 5** — the key difference from `bug_opt1_2.md`, which revokes only
slot 2. `start_revoke` (line **759**) broadcasts `PREPARE` to all peers
*including self* (`broadcast_prepare`), and `HandlePrepare` raises the
receiver's own `prepared_ballot` — so p1's `prepared_ballot[2]` and `[5]`
become `(1, p1)`.

## Reproducing scenario

Three servers p0, p1, p2, no crashes, FIFO links. Goal: divergence on slot 2.

### Preconditions

- Slot 2 is unlearned everywhere; `est_index[p2] = 2` on p1; p1's `my_index = 1`.

### Phase A — p1 falsely suspects p2 and β-revokes a block of p2's slots

p1's `monitor_suspicions` fires `on_suspect(p2)` (line **786**). The β-window
is `[2, 5]`, so p1 `start_revoke`s slots **2 and 5** at ballot `(1, p1)` and
broadcasts `PREPARE(1)` for each. p1 processes its own PREPAREs locally:

```
slot 2 @ p1: prepared_ballot = (1,p1)   ← was (0,p2)
slot 5 @ p1: prepared_ballot = (1,p1)
```

p1's `PREPARE(1)` messages to p0 and p2 are **delayed in flight** (async).

> This block-revoke is why you cannot trigger the bug through slot 5: p1 has
> promised ballot 1 on slot 5 too, so a later SUGGEST for slot 5 is rejected
> and never reaches the inference. The trace must route through a slot p1 does
> **not** revoke — and p1 only ever revokes *p2's* slots, never its own.
> **p1's own slot 4 is the door.**

### Phase B — p2 (alive) suggests a real value to slot 2

p2 gets a client request `v`, runs `on_client_request(v)` (line **530**), and
SUGGESTs to its own next slot, slot 2: `PROPOSE(0, v)`. `proposed[2] = v`.

### Phase C — the quorum {p0, p2} chooses v at slot 2

p0 and p2 still have ballot-0 promises on slot 2 (p1's PREPARE is delayed), so
both accept: `slot 2 @ p2 {pb=0, ab=0, av=v}`, `slot 2 @ p0 {pb=0, ab=0, av=v}`.
Two accepts = quorum. **`v` is chosen for slot 2 — locked forever.** p2
broadcasts `LEARN(v)`; p0 and p2 set `learned[2] = v` and commit.

Meanwhile p1 *also* received p2's `PROPOSE(0, v)` for slot 2, but p1's slot 2
has `prepared_ballot = (1,p1)`. In `HandlePropose` (line **601**) the accept
guard `ballot_gte(ballot, prep)` is `(0,p2) ≥ (1,p1)` → **false**. p1 rejects
and does nothing: no accept, no `learned`, and — crucially — **no update to
`est_index[p2]`, which stays 2.** The real suggestion vanished without a trace.

```
slot 2 @ p0:  learned = v   (committed)
slot 2 @ p2:  learned = v   (committed)
slot 2 @ p1:  learned = ⊥   est_index[p2] still = 2   ← stale
```

For the bug we need p2's `LEARN(v)` for slot 2 to reach p1 **late** — after
Phase D. This is consistent with FIFO (see Phase D).

### Phase D — p1 suggests to its own slot 4, and fabricates a no-op for slot 2

p1 first suggests slot 1 (so its `my_index` advances to 4), then gets a client
request `v'` and SUGGESTs to its own slot 4 (p1 never revokes its own slots, so
`prepared_ballot[4] = (0,p1)`):

```
p1 broadcasts PROPOSE(0, v') for slot 4
```

p2 (alive) receives it, accepts, and sends `ACCEPT(0, v')` for slot 4 back to
p1. p1 receives that ACCEPT in `HandleAccept` (line **640**). Because it is a
ballot-0 ACCEPT acknowledging p1's own SUGGEST, `on_accept_suggestion(4, p2)`
fires (line **432**):

```
fill_q_skips(p2, 4):
  j from est_index[p2]=2 to 4:
    j=2: 2%3==2==p2 → learn_slot(2, nil)   ← p1 fabricates no-op for slot 2
  est_index[p2] ← next_owned(4, p2) = 5
```

p1 sets `learned[2] = no-op` and advances past slot 2, **committing slot 2 as
empty.** No error is raised; this is silent.

> **Why the LEARN(v) is legitimately late.** On the p2→p1 link, p2 sends
> `ACCEPT(slot 4)` the moment it gets p1's SUGGEST(4), but it only sends
> `LEARN(v) for slot 2` after collecting p0's ACCEPT for slot 2. Arrange for
> p1's SUGGEST(4) to reach p2 *before* p0's ACCEPT for slot 2 does. Then on the
> p2→p1 link the order is `ACCEPT(slot 4)` then `LEARN(slot 2)`. FIFO preserves
> that order, so p1 fabricates the no-op first. No FIFO rule is broken.

### Phase E — the real outcome arrives too late

p2's `LEARN(v)` for slot 2 finally reaches p1. `HandleLearn` (line **683**) and
`learn_slot` (line **333**) short-circuit on `if is_learned(i) { return; }` —
but `learned[2]` is now `no-op`, not `⊥`. **The LEARN is silently dropped.**
p1 keeps slot 2 = no-op forever.

### Final state

```
slot 2 @ p0:  v       (committed)
slot 2 @ p2:  v       (committed)
slot 2 @ p1:  no-op   (committed)
```

Two correct servers committed `v` for slot 2; a third correct server committed
`no-op`. That breaks **Agreement / RSM-Agreement** (if a correct server
commits `r`, all correct servers must) and **Total Order**. It is permanent.

## Why none of the safety nets catch it

- **Rule 4 (re-suggest on no-op)** (`on_learned`, line **341**) only fires at
  the *proposer* whose value got overwritten by no-op. The proposer is p2, and
  p2 learned `v` (not no-op). So Rule 4 never triggers and nobody re-suggests
  `v`.
- **Revocation's own Phase 1** would normally save the day: a revoker collects
  ACKs, discovers `v` was already accepted, and re-proposes `v` — healing the
  split. But p1 wrote `learned[2] = no-op` through the `est_index` shortcut.
  Every slot-2 handler, including the ACK-collection that would complete the
  revocation (`HandleAck`), is gated on `learned = ⊥` and is now dead. The
  fabricated no-op freezes the slot before the safe path can run.

## Root cause (one line)

The skip inference equates "I never *processed* a real suggestion from `q` for
this slot" with "q never *sent* one." Revocation makes those different — p1
received p2's real suggestion and discarded it on the ballot test — so the
inference manufactures a `no-op` over a slot the coordinator actually filled.
Lemma 6's claim that the optimization only "combines messages P would have
sent" is false precisely here: P would have sent a real `SUGGEST` for slot 2,
never a `SKIP`. The optimization synthesizes a `SKIP` out of an *absence*, and
an absence is no longer trustworthy once a proposal can be received and
rejected.

## The fix

Identical to `bug_opt1_2.md`, applied in `Mencius_opt1_2_3_fixed.spur`:

### 1. Safety: ballot guard in `fill_q_skips`

Only apply the no-op learn when the local `prepared_ballot[j]` is still the
owner's implicit `(0, q)`. If any higher ballot has been seen, a revoker is
active; the gap-fill defers to consensus.

```spur
if j % n == q and !is_learned(j) {
    var prep = get_prepared(j);
    var owner_ballot = Ballot{ round: 0, leader: q };
    if ballot_eq(prep, owner_ballot) {
        learn_slot(j, nil);
    }
}
```

In the Phase D step above, `prepared_ballot[2] = (1,p1) ≠ (0,p2)`, so slot 2 is
*not* learned as no-op — the bug is averted.

### 2. Liveness: NACK on rejected SUGGEST → owner self-revoke

When `HandlePropose` rejects a ballot-0 SUGGEST from the owner (because a
revoker raised `prepared_ballot`), it sends a **NACK** carrying the higher
ballot. The owner, on `HandleNack`, starts a self-revoke (Phase 1 + 2 above the
NACK'd ballot). Phase 1 discovers the value the majority accepted at ballot 0
and re-proposes it, so the slot converges correctly.

With both the guard and the NACK, opt 1+2+3 preserves Rule 2's throughput in
the common (no-revoke) case and falls back to proper Paxos consensus when a
revoke is active.

## Reproducing

```bash
cargo run --release --manifest-path spur/Cargo.toml --bin spur -- \
    explore -e standard \
    --config scheduler_configs/mencius_nocrash.json \
    -y --output-dir output_mencius_opt123_bug \
    bin/spur/mencius/Mencius_opt1_2_3.spur

cd porcupine && go build -o main main.go && cd ..
./porcupine/main -input output_mencius_opt123_bug -type duckdb -model kv \
    -output-dir output_mencius_opt123_bug
```

Expected: `Some runs are NOT linearizable.` Under `mencius_nocrash.json` this
reproduces readily on a standard run — observed 8 non-linearizable runs out of
~708 (more than the opt1_2 variant's ~5, because the β-window revoke always
nails slot 5 too, making the own-slot-4 path reliably reachable). If a given
seed does not surface it, escalate via `find-bug` with the Phase A–E plan. Use
`debug combined --run-id N` on a failing run to confirm the mechanism: look for
`Revoke start: slot=2 ballot=(1,<revoker>)` (the β-window revoke) and the slot-2
divergence (`no-op` on the revoking node vs the committed `uid=…` elsewhere).
`Mencius_opt1_2_3_fixed.spur` under the same config is fully linearizable.

## Honest caveat

This is a hand-built interleaving against pseudocode — exactly where subtle
ordering bugs hide and where hand reasoning is least reliable. No invariant in
the given code rules it out, but a model checker (e.g. TLA+) is what would
actually settle whether it is reachable in the intended implementation versus
an artifact of the pseudocode's abstraction. The Spur simulator serves that
role here.
