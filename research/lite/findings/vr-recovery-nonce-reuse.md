# VR.spur: lost write from recovery-nonce reuse under crash-during-recovery

Classification: **implementation bug in the translation** (not a paper bug).
Found while classifying the 19 archived VR violations in
`research/logs/violations/` during the iteration-10 direction review. None
of them is the target bug in `research/oracle/bug.md`.

## Signature

All 16 archived violating runs with logs share it: exactly three recoveries,
every one logging "starting recovery with nonce 1".

## Mechanism, from run 66227 (`lite-learned-run-cap-probe-p99-sequential-1001-1788149544689`)

1. Step 1-2: node 2 crashes and begins recovery with nonce 1, sending
   Recovery to peers.
2. Step 3: node 2 crashes again, mid-recovery. Step 5: it restarts and begins
   a second recovery - again with nonce 1, because `recovery_nonce` is a
   volatile counter (`bin/spur/VR.spur:71`, `var recovery_nonce: int = 0`)
   that the crash resets to 0 and `RecoverInit` increments to 1
   (`VR.spur:93`).
3. Step 8-10: the second attempt receives RecoveryResponses that were
   addressed to the FIRST attempt (trace 6 was dispatched at step 4 in reply
   to trace 4 from attempt one). The nonce check at `VR.spur:433`
   (`if other_nonce != recovery_nonce`) passes, because both are 1.
4. Step 17: write uid 1 is committed and acknowledged. Step 18-21: node 2
   crashes and recovers a third time, nonce 1 again. Step 25-34: it accepts
   stale responses carrying the EMPTY pre-commit log and completes recovery
   at op_number 0, commit_number 0 - after op 1 was committed.
5. Step 63: view 1 starts with log `[]`. Reads at steps 451 and 566 return
   `[5, 2, 7]`: the acknowledged write uid 1 is gone. A lost write.

## Why it is an implementation bug

VR-Revisited section 4.3 requires the recovery nonce to be unique and names
this exact hazard: a recovering replica has lost its state, so the nonce
must come from a clock or from a counter kept on disk. The spec keeps it in
memory. With a unique nonce, the stale responses in step 3 and step 5 would
be rejected at `VR.spur:433` and the recovery would wait for fresh ones.

## Fix (not applied - `bin/spur/**` is protected)

Persist the counter with `persist_data` across `RecoverInit`, or draw a
random nonce. Either restores the paper's uniqueness requirement.

## Consequences for the research loop

- The target bug has never been observed, in this loop or the big loop.
- The `violations` rung is contaminated by this unrelated source at roughly
  one per few million runs, concentrated in short-cap arms (11 of 19 from
  grid-short). A candidate that raised crash-during-recovery frequency would
  raise violations without approaching the target. The grader's caution
  about crediting a single violation is correct.
- Fixing the spec would clean the ground truth and remove a confound from
  every future violation reading.
