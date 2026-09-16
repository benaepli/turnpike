# Paxos.spur: command identity minted from volatile replica state

Classification: **implementation bug** (translation error, not a paper bug).

Spec: `bin/spur/Paxos.spur` (Multi-Paxos after "Paxos Made Moderately
Complex", PMMC). Workload: 3 servers, 3-5 writes, 1-2 reads, 1 key, 2-3
concurrent writes, 1-2 crashes with recovery. Corpus:
`tmp/loop/lite/paxos-classify/out` (seed 1000, 15 s wall): 303 violating
runs in 77,087. Porcupine per-run histories for all 303 are in
`tmp/loop/lite/paxos-classify/html_all/`.

The spec is repaired; the last section carries the change and its
measurement. Every line reference below is to the spec before it, which is
kept as `bin/spur/panel/paxos_host.spur`.

## Root cause

PMMC identifies a command as `<kappa, cid, op>`, where `cid` is a
client-chosen identifier that is unique per client and stays the same when
the client retransmits. `perform` and `propose` deduplicate on that
identity. The spec has no separate client, so the replica mints the
identifier itself:

- `ClientWrite` / `ClientRead` take `req_id = next_req_id` from a volatile
  counter (`Paxos.spur:431-433`, `:442-444`).
- `commands_eq` compares only `(client_node, req_id)`; it ignores `kind`
  and `uid` (`Paxos.spur:167-169`). `command_decided` (`:175`),
  `already_performed` (`:201`) and the client resolve in `perform`
  (`:233-237`, keyed by `cmd.req_id` alone) all rely on it.
- `RecoverInit` resets the counter to `next_req_id = slot_num`
  (`Paxos.spur:126`) and clears `pending_requests` (`:120`). `slot_num` is
  the number of performed slots, which has nothing to do with how many
  identifiers this node has already issued; it is usually smaller.

So after a crash the node's identifiers are neither unique nor stable:

1. Reuse. Requests issued before the crash are still in flight in other
   leaders' `leader_proposals` and in acceptors' `accepted` lists (persisted
   there, `:280-284`). A request issued after recovery gets one of the same
   `(client_node, req_id)` pairs. The two commands are then "equal" for
   dedup and for resolving the client channel, although they are different
   operations.
2. Non-reuse of the same request. The simulator re-delivers a client
   invocation that was executing when its node crashed
   (`docs/simulator_semantics.md`, buffered messages are re-injected on
   recovery). The re-executed `ClientWrite` mints a fresh `req_id`, so the
   same client write becomes a second, distinct command. PMMC relies on the
   retransmission carrying the same `cid` so that `perform` skips it.

Nothing else in the trace is wrong: ballots, promises, `pmax`, and the
persisted acceptor state behave as the paper says.

## Run 2831, step by step

Clients: c3 `Write uid=1`, c4 `Write uid=2` then `Write uid=5`, c5 `Read`.
History as porcupine sees it: PUT 2 acknowledged (op 2-11), later GET
returns `[1, 5]`.

1. Step 4: node 0 handles `ClientWrite uid=1`, `req_id 0`, command
   `(0,0,WRITE,1)`, proposed for slot 1 to all three leaders.
2. Step 5: node 0 handles `ClientRead`, `req_id 1`, command `(0,1,READ)`,
   proposed for slot 2. Node 2 records both in `leader_proposals`.
3. Step 8-9: node 0 crashes and recovers. Persisted state has `slot_num 1`,
   so `next_req_id = 1` (`:126`); `pending_requests` and `proposals` are
   empty.
4. Step 25: node 0 handles `ClientWrite uid=2`; it gets `req_id 1`, command
   `(0,1,WRITE,2)`, the same identity as the pre-crash READ. Its channel is
   stored as `pending_requests[1]`. It is proposed for slot 1.
5. Step 73: node 0 adopts ballot (3,0). `pmax` carries slot 1 = the
   pre-crash write uid 1 and slot 2 = the pre-crash READ `(0,1)`.
6. Step 81-84: both slots are decided. `perform` on slot 2 (the READ) finds
   `pending_requests[1]`, which now belongs to `Write uid=2`, and resolves
   it with `success: true` (`:233-237`). Step 88: c4's `Write uid=2` returns
   to the client. Nothing with uid 2 was ever decided.
7. In the same `HandleDecision`, slot 1 was decided as uid 1 while
   `proposals[1]` is uid 2, so `propose(W2)` runs (`:251-255`). It returns
   at once because `command_decided` matches the READ in slot 2 on
   `(0,1)` (`:193`). Write uid 2 is never proposed again.
8. c4 then writes uid 5 (slot 3). Reads return `[1, 5]`: an acknowledged
   write is missing.

Runs 6838 and 8538 have the same shape (node 2 / node 1 crash with two
pending requests, the reissued id lands on a pre-crash WRITE, whose
`perform` acknowledges a different write).

## Run 7791, the other surface

Node 2 handles `ClientWrite uid=1` (step 37, `req_id 0`); it is decided in
slot 2 and performed (step 97). Node 2 crashes at step 100 and recovers
with `slot_num 3`. The same invocation is re-delivered (step 111, the log
shows `ClientWrite uid=1` a second time) and gets `req_id 3`, a new
identity. It is decided again in slot 3. The final read is `[1, 1, 4, 5]`:
one write applied twice. Runs 8183, 8360, 8519 show the same repeated
`ClientWrite uid=X` line on a node with a recovery between the two.

## Shapes across the 303 runs

Classified from the porcupine histories (`html_all/`):

- 242 runs: a read contains a repeated uid (double execution of a
  re-delivered write; 15 of these also lose a write).
- 55 runs: an acknowledged write is absent from every later read (the
  false-acknowledge path above).
- 6 runs: a read returns `[]` after writes were acknowledged (the reissued
  id belongs to a decided WRITE or an earlier READ, so the new read is
  resolved with that command's result, or dropped by `command_decided` and
  answered by the earlier command).

Three symptoms, one mechanism: identifier reuse and identifier drift across
a crash of the node that minted it.

## Why implementation and not paper

PMMC's dedup is correct under its stated assumption that `cid` is unique
per client and unchanged on retransmission. The paper has no replica-minted
identifier and no `next_req_id = slot_num` step; both are inventions of the
translation. The paper is silent on client crash, but here the "client" is
the replica's own counter, and the spec already persists replica state
across the crash; it simply leaves the counter out and then seeds it from an
unrelated value. The stale-vote, promise, and ballot logic that the panel
members mutate is not involved.

## Fix, applied to `bin/spur/Paxos.spur`

Commands now carry an identity that survives the crash and the re-delivery:

- `next_req_id` is part of the persisted state struct and is restored from
  it in `RecoverInit`, instead of being seeded from `slot_num`.
- `commands_eq` compares `kind`, then `uid` for a write and `req_id` for a
  read, so two different operations are never equal.
- `resolve_pending` matches a decided command to a waiting client by
  `req_id` or, for a write, by the `uid` recorded in `pending_writes`, and a
  write that is already decided is acknowledged rather than proposed again.

For a re-delivered write the `uid` is the stable key; a read needs the
persisted counter. Either half alone removes only one of the two shapes.

Measured on the same workload as above, seed 1000, one 480,000-run grid per
arm on the same binary:

| spec | runs | violating runs |
| --- | --- | --- |
| before the fix | 480,000 | 1,608 |
| after the fix | 480,000 | 0 |

The panel is unaffected: the two paxos members seeded from the unrepaired
host keep it as their control, pinned at `bin/spur/panel/paxos_host.spur`,
so each stays exactly one seeded defect away from what it is compared
against. `bin/spur/panel/paxos_host_fixed.spur`, the repaired host the
`paxos-fixed-*` members are built on, is the same protocol as the repaired
`Paxos.spur`.
