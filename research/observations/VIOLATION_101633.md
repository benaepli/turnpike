# First general-config violation: an acknowledged write is lost

Run 101633, arm `aos`, evaluation
`purgatory-delay-probability-sweep-arms-sequential-1000-1787995852102`,
signature 36d7addbccf3264b, session seed 1000, 218,700 runs in the chunk.
Evidence under `research/logs/violations/`; the run ends `plan_complete` at
608 steps with 3 crashes against a configured maximum of 3.

This is the first violation in the record that survives scrutiny. The three
from 2026-08-28 were an id collision between arms, diagnosed in that
directory's NOTE.md and fixed the same day; this run carries a single row in
`violating_runs.json`, one uid per client operation, and a crash count at
the configured limit, so that class is ruled out.

## The history

All operations are on `key1`. Steps are invocation -> response.

| op | client | steps | operation | result |
| --- | --- | --- | --- | --- |
| 1 | 3 | 0 -> 9 | Write(uid 1) at node 0 | ok |
| 2 | 3 | 10 -> 29 | Read at node 2 | [1] |
| 3 | 3 | 33 -> 115 | Write(uid 3) at node 2 | ok |
| 4 | 3 | 116 -> 134 | Write(uid 4) at node 0 | ok |
| 6 | 4 | 140 -> 299 | Read at node 0 | [1, 3, 4] |
| 7 | 4 | 300 -> 426 | Read at node 0 | [1, 3] |
| 5 | 3 | 137 -> 607 | Read at node 0 | [1, 3] |

Operation 6 returns at step 299 having observed uid 4. Operation 7 is
invoked at step 300, after it, and does not. Committed state only grows
under the append-log model, so no linearization exists. Both reads were
served by node 0, so this is not divergence between replicas.

## How uid 4 was committed

Node 1 crashed at step 30, 32 and 136, recovering at 31, 116 and 139.

At step 116 node 1 begins recovery and broadcasts Recovery with nonce 1.
At 119 node 0, primary in view 0, sends Prepare(uid 4) as op 4. Node 2's
copy is delayed and arrives at step 284, by which time the cluster is at
view 6, so node 2 correctly ignores it: node 2 never holds uid 4.

At 123 node 0 answers the recovery with its log
`[uid1, read, uid3, uid4]`, op 4, commit 3. At 127 node 1, still inside
`RecoveryResponse`, sends PrepareOK for op 4. At 130 node 0 counts it,
reaches a quorum of two, and commits. At 134 the write returns ok.

The quorum was node 0 and node 1. Node 1 held uid 4 only by state transfer,
and crashed at 136.

## How uid 4 was lost

Node 1 recovers again at 139 and broadcasts Recovery with nonce 1 - the
same nonce, because `recovery_nonce` is volatile and a crash resets it to 0
before `RecoverInit` increments it to 1. Every recovery of a node therefore
carries nonce 1.

At step 160 node 1 accepts a RecoveryResponse carrying node 0's log as it
stood before uid 3 and uid 4 existed: `[uid1, read]`, op 2, commit 2. It is
a response to the first recovery round, delayed and delivered into the
second, and the nonce check cannot tell the rounds apart. Node 1 completes
recovery having moved backwards, from an op number it had already
acknowledged to one two entries behind.

At 172 node 1 is primary of view 1. Among the DoViewChange logs it holds -
its own `[uid1, read]` at op 2 and node 2's `[uid1, read, uid3]` at op 3 -
it takes the longer and broadcasts StartView with op 3. uid 4 is now absent
from every replica's log, and slot 4 is reused by a view-1 read. The
view-6 StartView at step 288 carries
`[uid1, read, uid3, read(view 1)]`, op 4, commit 4.

Node 0 kept answering reads from `kv_store`, which still held uid 4 from
when it applied the commit, which is why operation 6 saw [1, 3, 4]. Once
node 0 rebuilt its state from the adopted log, operation 7 saw [1, 3].

## Defects

Both of the first two are load-bearing: remove either and the violation
does not occur.

1. `RecoveryResponse` ends by sending PrepareOK for every op in
   `(commit_number, op_number]`. VR Revisited 4.3 ends recovery at "updates
   its state using the information from the primary, changes its status to
   normal, and the recovery protocol is complete"; there is no
   acknowledgement step. The effect is that a replica holding an operation
   only by state transfer supplies the vote that commits it. Without this
   the write never returns, because node 2 never received the Prepare.

2. `recovery_nonce` is volatile, so it is 1 for every recovery a node ever
   performs. The nonce exists to reject responses from earlier rounds and
   cannot do so. Without this node 1 recovers to op 4 and carries uid 4
   into the view change.

3. `kv_store` is not rebuilt when a view change truncates the log, so a
   replica serves reads from state whose operations are no longer in its
   log. This does not cause the loss; it makes it observable as a read that
   shrinks rather than a write that quietly vanishes.

Classification: implementation. All three are code without a counterpart in
the pseudocode, not properties of the protocol.

One question for the paper stands apart from them. VR's claim to need no
stable storage rests on a recovery nonce that is unique across crashes, and
a replica that loses all state on crash has no deterministic way to produce
one; the paper offers a clock or a random number, and a deterministic
storage-free replica has neither. Defect 2 is the natural thing to write
under that gap.

## Note on the discovery

The scheduler was `aos`, present in the baseline campaign, so the
hypothesis under test did not cause the violation and should not be
credited with it. The purgatory delay is what produced both delayed
messages the run depends on: the Prepare that never reached node 2, and the
stale RecoveryResponse that rolled node 1 backwards.

The run ends `plan_complete`. 96.6% of runs never complete, and
`TERMINATION_DEPTH.md` records that completed runs carry every plan-corpus
violation. This is one more instance of that pattern.
