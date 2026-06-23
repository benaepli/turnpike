# Mencius Protocol P Liveness Bug: a revoker that crashes mid-revocation

## Summary

The Mencius paper (Mao, Junqueira, Marzullo, *Mencius: Building Efficient
Replicated State Machines for WANs*, OSDI 2008) gives the base algorithm as
*Protocol P* (Appendix B) layered over *Coordinated Paxos* (Appendix A). In
Coordinated Paxos each slot has a fixed owner that proposes on a reserved
ballot 0 with no Phase 1; any other server must **revoke** the slot — run a
full Paxos Phase 1 + Phase 2 at a strictly higher ballot — and it does so only
when its failure detector **suspects** the owner (Rule 3, `OnSuspect`).

This design has a liveness hole. A server that suspects an owner can raise a
slot's ballot (Phase 1 `PREPARE`) and then **crash before deciding**. That
leaves the slot promised above ballot 0 at a quorum, so the (correct, alive)
owner can no longer get its value chosen on the fast path — yet **no correct
server has any reason to suspect the correct owner**, so no one ever runs the
higher-ballot round that would resolve the slot. The slot is permanently
orphaned, and because commit is strictly in log order, every later slot wedges
behind it.

## Classification

**Paper bug — liveness underspecification in the Coordinated Paxos revoke
design.** Protocol P's only escalation path is suspicion-driven `Revoke`; the
owner itself never raises its own ballot. The paper's liveness reasoning
implicitly assumes that a slot is either driven by its owner (at ballot 0) or
revoked because the owner is suspected, and misses the third state: the owner
is *correct* (so will not be suspected under an eventually-accurate failure
detector) yet *locked out* of ballot 0 by a higher ballot a now-dead revoker
left behind.

Fault assumptions are mild: **exactly one crash** (the revoker), no message
loss or network partitions beyond ordinary asynchronous reordering, and **no
FIFO requirement**. The only "adversarial" ingredient is the relative arrival
order of two messages at one server, which is a legal asynchronous
interleaving.

This is distinct from the QSkipSet safety bug (`bug_opt1_2.md`): it is present
in **bare Protocol P** and does not involve any of the Section 4 optimizations.

## The load-bearing pseudocode (Appendix A + B)

Four pieces from Protocol P / Coordinated Paxos combine to produce the stall.

Rule 3 — a suspecting server revokes by starting Phase 1 at a higher ballot
(`OnSuspect`, then `Revoke` in Appendix A):

```
DownCall Revoke()
    ballot ← Choose b : owner(b) = p ∧ b > prepared_ballot ∧ b > accepted_ballot;
    Broadcast PREPARE(ballot);          /* Phase 1 only; Phase 2 happens on ACK */
```

Rule 1 — the owner suggests on the reserved ballot 0 (`OnClientRequest`, then
`Suggest`):

```
DownCall Suggest(v)
    Broadcast PROPOSE(0, v);            /* the owner never uses a ballot > 0 */
```

The acceptor's accept test (`OnMessage PROPOSE`), which a raised
`prepared_ballot` defeats:

```
OnMessage PROPOSE(b, v) From q OnCondition learned = ⊥
    ...
    else if prepared_ballot ≤ b ∧ accepted_ballot < b then
        ... accept (b, v); Send ACCEPT(b, v) To q;
    /* otherwise: silently reject — Coordinated Paxos has no NACK */
```

And the handler that raises `prepared_ballot` when a `PREPARE` arrives
(`OnMessage PREPARE`):

```
OnMessage PREPARE(b) From q OnCondition learned = ⊥
    if b > prepared_ballot then
        prepared_ballot ← b;
        Send ACK(b, accepted_ballot, accepted_value) To q;
```

The crucial structural facts: the owner only ever issues `Suggest`/`Skip` at
ballot 0, and the **only** way any slot reaches a ballot `> 0` is a `Revoke`
initiated from `OnSuspect`. There is no owner-side escalation anywhere in
Protocol P or in the full Mencius algorithm (Appendix C).

## Setup

- Three servers **p0, p1, p2**; `n = 3`, quorum `⌈(n+1)/2⌉ = 2`.
- Ownership `owner(i) = i mod 3`: slot 0 → p0, slot 1 → p1, **slot 2 → p2**,
  slot 3 → p0, slot 4 → p1, slot 5 → p2, …
- Slots 0 and 1 are already learned and committed everywhere, so every server
  sits at `expected = 2` (slot 2 is next to commit).
- **p0 and p2 are correct and stay alive; p1 is the faulty one and crashes.**
- Ballot 0 is the slot owner's reserved/default ballot (every acceptor starts
  `prepared_ballot = 0`). A revoke uses any strictly higher ballot the revoker
  owns.

Per-slot state below is `{prepared_ballot, accepted_ballot, accepted_value,
learned}`, abbreviated `{pb, ab, av, learned}`; it starts at
`{0, −1, ⊥, ⊥}` for slot 2 on all three servers.

## The trace

### Stage 1 — p1 falsely suspects p2, revokes slot 2, then crashes

p1's failure detector wrongly flags p2. p1 runs `OnSuspect(p2)` (Rule 3); its
`RevokeSet` contains slot 2, so it calls `Revoke(2)`. `Revoke` is Coordinated
Paxos Phase 1: p1 chooses a ballot it owns above everything it has seen —
ballot **1** — and broadcasts `PREPARE(1)` for slot 2 (and its other p2-owned
targets, slot 5, …).

**p1 then crashes** — after the `PREPARE(1)` messages are on the wire, but
before it receives a single `ACK`. So p1 never reaches `OnMessage ACK` and
never runs Phase 2. The in-flight `PREPARE(1)` messages will still be
delivered.

### Stage 2 — p2 (the correct owner) suggests a real value to slot 2

A client request `v` arrives at p2. It runs `OnClientRequest(v)` (Rule 1):
since it owns slot 2 it calls `Suggest(2, v)` → broadcasts `PROPOSE(0, v)`,
sets `proposed[2] = v`, advances `index` to 5.

p2 handles its own `PROPOSE(0, v)` (`OnMessage PROPOSE`): the accept test
`prepared_ballot (0) ≤ 0 ∧ accepted_ballot (−1) < 0` holds, so p2 accepts —
`accepted_ballot = 0`, `accepted_value = v` — and emits `ACCEPT(0, v)` to
itself (it is the proposer). Then p1's in-flight `PREPARE(1)` reaches p2:
`1 > prepared_ballot (0)`, so p2 sets `prepared_ballot = 1` and sends
`ACK(1, 0, v)` toward the dead p1 (lost).

```
slot 2 @ p2:  {pb: 1, ab: 0, av: v, learned: ⊥}   ← accepted v at ballot 0; pb later bumped to 1
```

(Ordering note: this assumes p2 accepts its own SUGGEST *before* `PREPARE(1)`
arrives at p2. In the other order p2 would reject its own SUGGEST and `av`
stays `⊥` — the slot is still orphaned, just with no server holding `v`.)

### Stage 3 — p0 rejects the SUGGEST (the decisive ordering)

The one ordering the scenario needs: **p1's `PREPARE(1)` reaches p0 before
p2's `PROPOSE(0, v)` does** — a perfectly legal asynchronous interleaving.

1. p0 handles `PREPARE(1)` (`OnMessage PREPARE`): `1 > prepared_ballot (0)`,
   so p0 sets `prepared_ballot = 1` and sends `ACK(1, −1, ⊥)` toward the dead
   p1 (lost).
2. p0 then handles `PROPOSE(0, v)` (`OnMessage PROPOSE`): the accept test is
   `prepared_ballot (1) ≤ 0` → **false**. p0 **rejects** and records nothing.
   Coordinated Paxos has no NACK, so p0 stays silent and p2 never learns it
   was rejected.

```
slot 2 @ p0:  {pb: 1, ab: −1, av: ⊥, learned: ⊥}   ← rejected the SUGGEST
slot 2 @ p1:  crashed
slot 2 @ p2:  {pb: 1, ab:  0, av: v, learned: ⊥}   ← the only acceptor of v
```

`v` has been accepted by exactly **one** server (p2), below the quorum of 2.
So the quorum branch of `OnMessage ACCEPT` never fires, **no `LEARN(v)` is ever
broadcast, and `v` is not chosen.**

> Counterfactual: had `PROPOSE(0, v)` reached p0 *before* `PREPARE(1)`, p0
> would have accepted `v` at ballot 0, `{p0, p2}` would form a quorum, `v`
> would be chosen, and `LEARN(v)` would resolve the slot everywhere. The stall
> requires the `PREPARE`-before-`SUGGEST` order at p0 — nothing more.

### Stage 4 — slot 2 can never be resolved

For slot 2 to leave `learned = ⊥`, one of two things must happen:

- **(a) some value is chosen** — a quorum accepts the same value at some
  ballot; or
- **(b) a Revoke completes** — some live server runs Phase 1 + Phase 2 at a
  ballot `> 1` and drives the slot to a decision.

Neither can occur:

- **(a) is dead at ballot 0.** p0's `prepared_ballot` for slot 2 is now 1, so
  it rejects any further `PROPOSE(0, …)`; p2 alone cannot reach quorum. And
  **the owner p2 never escalates above ballot 0** — Protocol P's owner only
  ever issues `Suggest`/`Skip` at ballot 0.
- **(b) requires `OnSuspect(p2) → Revoke(2)` from a live server.** The only
  live servers are p0 and p2:
  - p2 never suspects itself, and `OnSuspect` only revokes *other* servers'
    slots.
  - p2 is **correct**, so under the standard eventually-accurate failure
    detector (◊P, which after some point stops suspecting correct servers) p0
    eventually stops suspecting p2 and never calls `OnSuspect(p2)` again.
  - The one server that *did* revoke slot 2 — p1 — is dead and never ran
    Phase 2.
  - Everyone *does* correctly suspect the dead p1, but `OnSuspect(p1)` revokes
    **p1's** slots (1, 4, 7, …) — never slot 2.
  - The paper's Section 4.6 leader-based revocation does not help: an elected
    leader revokes the slots of *suspected* servers. Nobody suspects p2, and
    nothing records that "p1 left an orphaned ballot on slot 2," so no leader
    targets slot 2.

So the ballot-1 revocation of slot 2 is **permanently orphaned.** Slot 2 stays
`learned = ⊥` forever. Because `CheckCommit` advances `expected` only while
`learned(expected) ≠ ⊥`, the hole at slot 2 blocks the commit of slot 2 *and
every later slot on every server*, and p2's client request for `v` never
returns. The cluster wedges.

## Root cause

Ordinary Multi-Paxos survives "a leader dies right after `PREPARE`" because
*any* proposer may pick a still-higher ballot and finish the round — leaders
keep climbing until one wins. Mencius trades that away for its fast path: a
slot's owner is pinned to ballot 0 and **never raises its own ballot**, and the
only route to a higher ballot is for *someone else* to **suspect the owner**
and revoke. That leaves a blind spot — a slot can be stuck above ballot 0 with:

- its correct owner forbidden from escalating, and
- a correct owner being exactly the server nobody will suspect.

The value that would rescue Paxos liveness here would have to come from
*continuing to falsely suspect a correct leader*, which is the opposite of what
a sane failure detector does. Conceptually, the missing ingredient is
**owner-side escalation**: a way for a locked-out-but-correct owner to climb to
a higher ballot itself (the standard Multi-Paxos behavior) instead of waiting
to be revoked.

## Why the paper's liveness argument misses it

The argument implicitly partitions a pending slot into two cases — "the owner
is up and drives it at ballot 0" or "the owner is down/slow and is revoked" —
and shows progress in each. The trace exhibits a third case that the partition
omits: the owner is up *and correct* but cannot drive ballot 0 because a
crashed revoker raised the promise, while no correct server suspects the
correct owner. No clause of the protocol assigns responsibility for such a
slot.

## Reproducibility note (why the current simulator does not exhibit this)

Unlike the QSkipSet safety bug, this stall is **not** surfaced by the Spur
simulator as the spec is written, for two reasons:

1. **The spec's failure detector is too aggressive.** In `Mencius_P.spur`,
   `monitor_suspicions` fires a timer and calls `on_suspect(q)` for *every*
   peer on every tick — it suspects everyone, perpetually. So after p1 dies,
   p0's next suspicion tick runs `on_suspect(p2)`, revokes slot 2 at a ballot
   `> 1`, Phase 1 reads `v` back from p2's ACK (`hv = v`), re-proposes `v`, and
   the slot self-heals as `v`. The bug is masked precisely because the
   simulator keeps falsely suspecting the correct owner — which is the
   degenerate behavior the real bug depends on *not* happening.
2. **Porcupine checks safety, not liveness.** The linearizability checker
   verifies `Read`/`Write` call-response pairs; a permanent stall produces no
   non-linearizable history, just an absence of progress.

To exhibit the real stall one would need (out of scope for this document):

- a failure-detector / scheduler model that is **eventually accurate** —
  i.e., after some point it stops suspecting correct servers (◊P), rather than
  the current "suspect everyone every tick" model; and
- a **no-progress / liveness check** (e.g., a committed value or a client
  request that never completes within a fairness bound) rather than a
  safety-only check.

## See also

- `Mencius_P.spur` — the bare Protocol P specification.
- `bin/papers/mencius/mencius_p.md` — Protocol P (Appendix B) + Coordinated
  Paxos (Appendix A) pseudocode this analysis is grounded in.
- `bin/papers/mencius/mencius.md` — full Mencius (Appendix C); confirms no
  owner-side escalation exists there either.
- `liveness_P.typ` — slide deck visualizing this trace.
