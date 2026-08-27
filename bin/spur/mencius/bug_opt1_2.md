# Mencius Paper Bug: Rule 2 vs. Rule 3 interaction

## Summary

The Mencius paper (Mao, Junqueira, Marzullo, *Mencius: Building Efficient
Replicated State Machines for WANs*, OSDI 2008) gives the full *Mencius*
algorithm in Appendix C — Protocol P (Appendix B) augmented with Optimizations
1–3 and Accelerator 1. Its Rule 2 is the optimized `QSkipSet` gap-fill (Opt 1/2),
combining four rules:

- **Rule 1** — servers take turns proposing in their assigned instances.
- **Rule 2** — on receiving a SUGGEST at instance `i` from `q`, fill every
  unlearned `q`-owned instance `j < i` with `no-op` (optimistic gap-fill
  based on FIFO ordering).
- **Rule 3** — a server `p` that suspects `q` failed may **revoke** `q`'s
  pending instances via a higher-ballot Coordinated Paxos round.
- **Rule 4** — a proposer whose value is learned as `no-op` re-submits it.

The paper claims Mencius (Protocol P + Optimizations 1–2 + Accelerator 1) is
correct (Lemmas 5–6). **It is not.** Rule 2
and Rule 3 interact unsoundly: the Rule-2 gap-fill can unilaterally mark
a slot as `no-op` on one replica while a majority of the cluster has
already committed a real client command at that slot. Replicated state
machines then diverge.

## Classification

**Paper bug.** The pseudocode in Appendix C (Mencius), translated faithfully,
exhibits the violation. (Bare Protocol P in Appendix B does *not* have this bug
— see "Why Protocol P is safe" below.) The paper's correctness argument for
Rule 2 silently assumes the ballot dimension stays at 0, which Rule 3 actively
breaks. The issue does not require crashes, message loss, or network
partitions — only a concurrent revoke.

## The buggy rule in the paper

Appendix C (Mencius), procedure `OnSuggestion(i)` (the same `QSkipSet` also
appears in `OnAcceptSuggestion`, Optimization 1):

```
q ← owner(i)
QSkipSet ← {j : est_index[q] ≤ j < i ∧ owner(j) = q}
forall j ∈ QSkipSet do
    learned(j) ← no-op
    Call CheckCommit
end
```

The corresponding code in this spec lives at
`bin/spur/mencius/Mencius_opt1_2.spur` lines **420–431**:

```spur
fn fill_q_skips(q: int, i: int) {
    var j = est_index[q];
    for ; j < i; {
        if j % n == q {
            learn_slot(j, nil);   // ← unconditional no-op learn
        }
        j = j + 1;
    }
    if i >= est_index[q] {
        est_index = est_index[q] := next_owned(i, q);
    }
}
```

`fill_q_skips` is invoked from:

- `on_accept_suggestion` (line 435–438) — proposer-side, when `q` sends
  an ACCEPT at ballot 0.
- `on_suggestion` (line 443–471) — receiver-side, when a ballot-0
  SUGGEST arrives with a real value.

## Reproducing scenario

Three servers p₀, p₁, p₂, no crashes. All RPCs go over FIFO links
(`FifoLink<Node>`), matching the paper's channel assumption.

### Step-by-step

1. **p₁ starts a Revoke for slot 2.**
   `start_revoke(2)` picks ballot `(1, p₁)` and broadcasts
   `PREPARE(slot=2, ballot=(1,p₁))`. This is the normal Rule-3 action on
   suspicion.

2. **p₂ submits a client write `v`** and calls `on_client_request(v)`
   (line 533). That sets `my_index = 5` (next `p₂`-owned slot) and
   broadcasts `PROPOSE(slot=2, ballot=(0,p₂), value=v)` — the SUGGEST.

3. **Messages race.** On p₁, the PREPARE (to self) is processed first:
   `prepared_ballot[2] = (1,p₁)`. When the SUGGEST arrives (via
   `HandlePropose`, line 604), the guard
   `ballot_gte(ballot, prep) and ballot_gt(ballot, acc)` at line 622
   fails — `(0,p₂) < (1,p₁)` — so p₁ **rejects** the SUGGEST.

4. **Meanwhile, p₀ and p₂ accept `v` at ballot 0.** The cluster reaches
   a ballot-0 quorum of 2 of 3 for value `v`. In classic Paxos
   terminology, `v` is now **chosen**.

5. **p₂ issues its next client op** and calls `on_client_request` again,
   broadcasting `PROPOSE(slot=5, ballot=(0,p₂), …)`.

6. **FIFO delivery at p₁**: on the p₂→p₁ link, the SUGGEST for slot 5
   arrives **after** the SUGGEST for slot 2 (which p₁ rejected) and the
   LEARN for slot 2 (which hasn't yet been broadcast, because the final
   ACCEPT triggering quorum may still be in flight).

7. **p₁ processes SUGGEST(5).** It passes the ballot check, so
   `on_suggestion(5)` is invoked (line 628). Inside,
   `fill_q_skips(2, 5)` walks `j ∈ {2}` (the only `p₂`-owned slot below
   5) and calls `learn_slot(2, nil)` at line 424. **p₁ now believes
   slot 2 = `no-op`.**

8. **p₀ and p₂'s LEARN(slot=2, `v`) arrives later** but `learn_slot` at
   line 337 short-circuits via `if is_learned(i) { return; }`. p₁ keeps
   its `no-op`.

9. **Divergence.** When p₁ applies committed slots to its state
   machine, slot 2 applies as `no-op` (write `v` never happens on p₁).
   Every future client read from p₁ misses `v`. If any such read was
   already committed on p₀ or p₂ showing `v`, linearizability is
   violated.

### Why this survives the revoke

Rule 3's revoke at p₁ eventually completes Phase 1. p₂'s ACK for
ballot `(1,p₁)` carries its `accepted_value = v` at ballot `(0,p₂)`.
p₁ picks `hv = v` by classic Paxos pick-highest-ballot rule and
broadcasts `PROPOSE(slot=2, ballot=(1,p₁), v)` in Phase 2. Quorum of
ACCEPTs follows and p₁ broadcasts `LEARN(slot=2, v)`. But by then
`learned_flags[2] = true` on p₁ with value `no-op`, so the revoke's
LEARN is discarded.

So the revoke, which should have repaired the divergence, is silently
masked by the stale Rule-2 no-op.

## Why Protocol P (Appendix B) does not have this bug

Protocol P's Rule 2 (`OnSuggestion`, Appendix B) only skips the *receiver's
own* unused instances:

```
SkipSet ← {k : k ≥ index ∧ k < i ∧ owner(k) = p};   // owner(k) = p (SELF)
forall k ∈ SkipSet do DownCall Skip(k);
```

It has no `est_index`, no `QSkipSet`, and never unilaterally marks *q's*
instances as no-op. In the scenario above, Protocol-P p₁ would reject
SUGGEST(2) (ballot too low) and leave slot 2 untouched; its own Revoke would
then complete Phase 1, discover `hv = v` from p₀/p₂'s ACKs, and learn slot 2
= **v** — no divergence. The bug is introduced specifically by the `QSkipSet`
no-op inference that Mencius adds (Optimization 1 via `OnAcceptSuggestion`,
Optimization 2 via `OnSuggestion`), which is why it falsifies Lemmas 5–6
rather than Protocol P's own agreement lemma.

## Why the paper's proof doesn't catch this

The paper argues Rule 2 is safe because, under FIFO:

> "Receiving SUGGEST(i) from q implies q has already handled every
> instance it owns with index < i — either it suggested a value
> (which I've seen by FIFO) or it skipped it."

This reasoning conflates **q having sent an earlier SUGGEST/SKIP** with
**the receiver having accepted it**. Under Coordinated Paxos, the
receiver may have:

- **rejected the SUGGEST** (ballot too low because a revoker raised
  `prepared_ballot`), and
- never received a SKIP (because `q` did not skip that slot),

yet a majority elsewhere may have accepted it. FIFO between `q` and
this receiver guarantees ordering, but it does not recover the
ballot information that was lost to rejection.

## The fix (partial)

Two changes, applied in `bin/spur/mencius/Mencius_opt1_2_partial_fix.spur`:

These do not fully repair the protocol. The spec still produces linearizability violations at a low rate, measured at roughly one run in two thousand, so it is a partially-fixed spec rather than a clean one and the harness treats its violation count as a reading rather than an assertion.

### 1. Safety: ballot guard in `fill_q_skips`

Only apply the Rule-2 `no-op` learn when the local `prepared_ballot[j]`
is still the owner's implicit `(0, q)`. If any higher ballot has been
seen, a revoker is active; the gap-fill must defer to consensus.

```spur
fn fill_q_skips(q: int, i: int) {
    var j = est_index[q];
    for ; j < i; {
        if j % n == q and !is_learned(j) {
            var prep = get_prepared(j);
            var owner_ballot = Ballot{ round: 0, leader: q };
            if ballot_eq(prep, owner_ballot) {
                learn_slot(j, nil);
            }
        }
        j = j + 1;
    }
    if i >= est_index[q] {
        est_index = est_index[q] := next_owned(i, q);
    }
}
```

The guard alone converts the safety violation into a liveness hazard:
`est_index[q]` advances past the contested slot, orphaning it from
future gap-fills. If the revoker stalls, the slot is never resolved.

### 2. Liveness: NACK on rejected SUGGEST → owner self-revoke

When `HandlePropose` rejects a ballot-0 SUGGEST from the owner (because
a revoker raised `prepared_ballot`), it sends a **NACK** back carrying
the higher ballot. The owner, on receiving the NACK, starts a
self-revoke (full Paxos Phase 1 + Phase 2 at a ballot above the NACK'd
one). Phase 1 discovers the value accepted by the majority at ballot 0
and re-proposes it, ensuring the slot converges correctly.

```spur
// In HandlePropose, else branch:
if ballot.round == 0 and owner_of(slot) == sender_id {
    links[sender_id]->HandleNack(self, slot, prep);
}

// New handler on the owner:
async fn HandleNack(sender_id: int, slot: int, nack_ballot: Ballot) {
    if is_learned(slot) { return (); }
    if owner_of(slot) != self { return (); }
    if exists(revoke_ballot, slot) { return (); }
    var prep = get_prepared(slot);
    if ballot_gt(nack_ballot, prep) {
        prepared_ballot = prepared_ballot[slot] := nack_ballot;
        has_prepared = has_prepared[slot] := true;
    }
    start_revoke(slot);
}
```

With both the guard and the NACK, the fix preserves Rule 2's throughput
benefit in the common (no-revoke) case and falls back to proper Paxos
consensus when a revoke is active.

## Reproducing

Run the bugged spec against a small, revoke-heavy config:

```bash
cargo run --release --manifest-path spur/Cargo.toml --bin spur -- \
    explore -e standard \
    --config scheduler_configs/mencius_nocrash.json \
    -y --output-dir output_mencius_bug \
    bin/spur/mencius/Mencius_opt1_2.spur

./porcupine/main -input output_mencius_bug -type duckdb -model kv \
    -output-dir output_mencius_bug
```

Expected: `Some runs are NOT linearizable.` Use `debug combined` on a
failing run to see the diverging `LEARN slot X = no-op` vs.
`LEARN slot X uid=…` events across nodes.

## See also

`bug_opt1_2_3.md` documents the **same root cause** (unguarded `fill_q_skips`)
under the faithful **Optimization 3** β-window revocation. There the block
revoke rejects the owner's SUGGESTs to *all* its slots, so the bug is forced
through the proposer's **own** slot via `on_accept_suggestion` (Optimization 1)
rather than a peer's slot via `on_suggestion`. The fix is identical.
