# Gryff: Unifying Consensus and Shared Registers

Source: Burke, Cheng, Lloyd. *Gryff: Unifying Consensus and Shared Registers.*
NSDI 2020. Full paper at `gryff.pdf`.

Gryff is a linearizable shared object protocol that supports READ, WRITE, and
RMW operations. It combines a multi-writer ABD variant (for reads/writes)
with an EPaxos variant (for rmws), using **carstamps** to unify their orders.

## Model

- A set P of processes, a subset R ⊆ P are *replicas* that hold the object.
- Crash-failure model, asynchronous message delivery, reliable channels.
- Tolerates f out of n = 2f+1 replica failures.
- Quorums: Gryff uses the majority quorum system Q_maj (any |Q| = f+1).
- A *coordinator* is the replica that executes an invoked operation.

## Carstamps

A carstamp is a triple `cs = (ts, id, rmwc)`:

- `ts` — logical timestamp
- `id` — process identifier
- `rmwc` — rmw counter

Lexicographic comparison: `cs1 < cs2` iff
- `cs1.ts < cs2.ts`, or
- `cs1.ts == cs2.ts and cs1.id < cs2.id`, or
- `cs1.ts == cs2.ts and cs1.id == cs2.id and cs1.rmwc < cs2.rmwc`

A rmw with base update `u` and base carstamp `cs_u` is assigned
`cs_rmw = (cs_u.ts, cs_u.id, cs_u.rmwc + 1)`. This guarantees writes and their
rmws occupy consecutive positions in the total order; other writes cannot
be inserted between them.

## Replica State (Figure 4)

- `v` — value of shared object
- `cs` — carstamp of shared object
- `prev` — (value, carstamp) produced by the previously executed rmw
- `i` — next unused instance number
- `cmds[][]` — 2D array of instances indexed by replica id and instance number.
  Each entry contains:
  - `cmd` — command to execute
  - `deps` — instances whose commands must execute before this one
  - `seq` — approximate sequence number (breaks dep cycles)
  - `base` — possible base update for rmw (value + carstamp pair)
  - `status` — {pre-accepted, accepted, committed, executed}

---

## Algorithm 1: Read/Write Coordinator (at p ∈ P)

```
procedure Coordinator::READ() at p ∈ P
  // Read Phase 1
  send Read1 to all r ∈ R
  wait to receive Read1Reply(v_r, cs_r) from all r ∈ Q ∈ Q_maj
  cs_max ← max_{r ∈ Q} cs_r
  v ← v_r where cs_r = cs_max
  if ∀r ∈ Q: cs_r == cs_max then
      return v                                  // 1 RTT fast path
  // Read Phase 2 — propagate to a quorum
  send Read2(v, cs_max) to all r ∈ R
  wait to receive Read2Reply from all r ∈ Q' ∈ Q_maj
  return v

procedure Coordinator::WRITE(v) at p ∈ P
  // Write Phase 1 — pick a fresh carstamp strictly greater than any seen.
  send Write1 to all r ∈ R
  wait to receive Write1Reply(cs_r) from all r ∈ Q ∈ Q_maj
  cs_max ← max_{r ∈ Q} cs_r
  cs ← (cs_max.ts + 1, id, 0)                    // id = coordinator's id
  // Write Phase 2 — propagate
  send Write2(v, cs) to all r ∈ R
  wait to receive Write2Reply from all r ∈ Q' ∈ Q_maj
  return
```

## Algorithm 2: Read/Write Replica (at r ∈ R)

```
when replica r receives message m from p do
  case m = Read1:
    send Read1Reply(v, cs) to p

  case m = Read2(v', cs'):
    APPLY(v', cs')
    send Read2Reply to p

  case m = Write1:
    send Write1Reply(cs) to p

  case m = Write2(v', cs'):
    APPLY(v', cs')
    send Write2Reply to p

procedure Replica::APPLY(v', cs')
  if cs' > cs then
      cs ← cs'
      v  ← v'
```

## Algorithm 3: RMW Coordinator (EPaxos-based, at c ∈ R)

```
procedure Coordinator::RMW(f(·)) at c ∈ R
  // PreAccept Phase
  i    ← i + 1
  cmd  ← f(·)                                   // the modify function
  seq  ← 1 + max({cmds[j][k].seq | (j,k) ∈ I_cmd} ∪ {0})
  deps ← I_cmd                                  // commands known to interfere
  base ← (v, cs)                                // current local value/carstamp
  cmds[id][i] ← (cmd, seq, deps, base, pre-accepted)
  send PreAccept(cmd, seq, deps, base, id, i) to all r ∈ F \ {c} where F ∈ F
  wait to receive PreAcceptOK(seq'_r, deps'_r, base'_r) from all r ∈ F \ {c}
  if ∀r1,r2 ∈ F \ {c}: seq'_r1 = seq'_r2 ∧ deps'_r1 = deps'_r2 ∧ base'_r1 = base'_r2 then
      deps, seq, base ← deps'_r, seq'_r, base'_r   for any r ∈ F \ {c}
      goto Commit Phase

  // Accept Phase (slow path)
  deps ← union of deps'_r over r ∈ F
  seq  ← max_{r ∈ F} seq'_r
  base ← base_r : ∀r' ∈ F. base_r.cs ≥ base_r'.cs       // choose the max-cs base
  cmds[id][i] ← (cmd, seq, deps, base, accepted)
  send Accept(cmd, seq, deps, base, id, i) to all r ∈ Q \ {c} where Q ∈ Q_maj
  wait to receive AcceptOK from all r ∈ Q \ {c}

  // Commit Phase
  cmds[id][i] ← (cmd, seq, deps, base, committed)
  send Commit(cmd, seq, deps, base, id, i) to all r ∈ R \ {c}
  wait to receive Executed(v) from all r ∈ Q' ∈ Q_maj
  return v
```

## Algorithm 4: RMW Replica (at r ∈ R)

```
when replica r receives message m from c ∈ R do
  case m = PreAccept(cmd, seq, deps, base, id_c, i):
    seq'  ← max({seq} ∪ {1 + cmds[j][k].seq | (j,k) ∈ I_cmd})
    deps' ← deps ∪ I_cmd
    base' ← if cs > base.cs then (v, cs) else base
    cmds[id_c][i] ← (cmd, seq', deps', base', pre-accepted)
    send PreAcceptOK(seq', deps', base') to c

  case m = Accept(cmd, seq, deps, base, id_c, i):
    cmds[id_c][i] ← (cmd, seq, deps, base, accepted)
    send AcceptOK to c

  case m = Commit(cmd, seq, deps, base, id_c, i):
    cmds[id_c][i] ← (cmd, seq, deps, base, committed)

procedure Replica::EXECUTE(j, k)
  base ← cmds[j][k].base
  if cmds[j][k].base.cs < prev.cs then
      base ← prev
  v'  ← cmds[j][k].cmd(base.v)                  // apply f to the base value
  cs' ← (base.cs.ts, base.cs.id, base.cs.rmwc + 1)
  prev ← (v', cs')
  APPLY(v', cs')
  send Executed(base.v) to replica j            // j = coordinator id
```

Execution order (unchanged from EPaxos): topologically sort committed
dependency graph, break cycles within an SCC by `seq`.

## Algorithm 5: RMW Recovery Coordinator (at r ∈ R, replaces c for instance j)

```
when replica r ∈ R suspects replica c ∈ R failed while committing instance j:
  ballot ← (epoch, b+1, id_r)
  send Prepare(ballot, id_c, j) to all r ∈ R
  wait to receive PrepareOK(cmd, seq, deps, base_r, status, ballot_r) from all r ∈ Q
  R ← { (cmd, seq, deps, base_r, status) | ∀r' ∈ Q: ballot_r ≥ ballot_r' }
  if (cmd, seq, deps, base, committed) ∈ R:
      run Commit Phase for (cmd, seq, deps, base) at (id_c, j)
  else if (cmd, seq, deps, base, accepted) ∈ R:
      run Accept Phase for (cmd, seq, deps, base) at (id_c, j)
  else if ∃S ⊆ R: (cmd, seq, deps, base, status) ∉ S ∧ |S| ≥ ⌊n/2⌋
       ∧ (∀reply1, reply2 ∈ S: reply1 = reply2 ∧ reply1.status = pre-accepted):
      run Accept Phase for (cmd, seq, deps, base_r) at (id_c, j)
  else if (cmd, seq, deps, base, pre-accepted) ∈ R:
      run PreAccept Phase for cmd at (id_c, j), avoid fast path
  else:
      run PreAccept Phase for no-op at (id_c, j), avoid fast path
```

## Algorithm 6: RMW Recovery Replica (at r ∈ R)

```
when replica r ∈ R receives Prepare(ballot, j, k) from x ∈ R:
  if ballot > cmds[j][k].ballot:
      cmds[j][k].ballot ← ballot
      send PrepareOK(cmds[j][k]) to x
  else:
      send NACK to x
```

## Ordering Properties

- **Writes**: unstably ordered by carstamp. A replica's APPLY(v', cs') is a
  no-op unless cs' > cs. Old writes that arrive late are silently dropped.
- **RMWs**: stably ordered by EPaxos dependency graph. When executed, a rmw
  bumps its base carstamp's `rmwc` by one, so it is ordered immediately after
  its base update and cannot be interleaved with other writes.
- **Reads**: unstably ordered; return the value whose carstamp they chose in
  Phase 1 (optionally after propagating in Phase 2).

## Linearizability contract against Porcupine's kv_rmw model

Porcupine's `kv_rmw` model expects each committed entry in the log to be
tagged `(prev_uid, uid)` where:

- For a `Write(key, uid)`: `prev_uid = nil`, `uid = uid` (a blind update).
- For an `RMW(key, uid)`: `uid = uid`, and `prev_uid` is the uid of the
  **latest applied entry that the RMW observed** (or `nil` if none).
- `Read` returns the full ordered log of `(prev_uid, uid)` entries.

In Gryff terms: the value of the shared object is the list of write/rmw uids
that have been applied, in carstamp order. When a rmw executes, `prev_uid`
should be the uid of the current top-of-log at its chosen base.
