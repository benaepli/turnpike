# Topology as Code: gate results

Measurements taken on the side branch before the merge, in the order the
design's Section 11 asks for them. Binaries were built from the superproject
root so both sides of every comparison carry the same build configuration.

## Phase 3a (landed on research/lite as 15036a6)

| Gate | Result |
| --- | --- |
| Fixed-seed release parity | Raft and VR grids, a VR genetic session and a VR plan with crash, majorities_ring and heal events: 0 differing rows in executions, logs and traces |
| Tests | 545 passed |
| Throughput, cross-binary | 1.023 over four rounds (0.98 to 1.07), no regression |

## Phase 3b and 4

| Gate | Result |
| --- | --- |
| Fixed-seed release parity | Raft and VR grids against the Phase 3a binary: 0 differing rows, masking only the Client.* action rename, the Init and RecoverInit Enter payloads, and in-process role ids |
| Tests | 587 passed |
| Partition semantics | Three explicit plans (halves on one cluster, halves on one shard of two behind a router, a five-node ring): every blocked member message waited for the heal (94, 37 and 30 delivered after it, 0 before), while client, router, same-side and other-shard traffic proceeded during the partition |

## Structural overhead and the role parameter

Campaign workload, VR, 30 threads, 120 s rounds.

| Binary and inputs | Mean runs per second | Spread |
| --- | --- | --- |
| Phase 3a, pre-migration specs and configs | 10930.2 | 0.0144 |
| Migrated, role parameter in every node env | 10377.4 | 0.0266 |
| Migrated, role parameter off the per-record path | 10832.8 | 0.0110 |

The middle row cost about 5 per cent. Profiles attributed it to value clone
and drop, not to new work: VR's node holds 20 role variables, so the
parameter's slot made every per-record env copy about 5 per cent wider. A
role whose parameter no function beyond Init, RecoverInit and the variable
initializers reads now keeps it out of the env. The remaining 0.9 per cent
against Phase 3a is inside either measurement's own spread.

## Partition fixes, measured separately

Each fix compared against the commit immediately before it, on identical
migrated inputs, three chunks each.

| Comparison | Deep-run events per explore-second | Throughput ratio |
| --- | --- | --- |
| Membership fix over the structural commit | 1.0107 | 0.976 |
| Ring adjacency fix over the membership fix | 0.9942 | 1.001 |

Both readings sit inside the 5 per cent build-layout floor, so neither fix
separates from noise in bug finding, and neither regresses throughput. The
grader reports "human" for both because its merge rule expects a declared
treatment bit and a regression-suite pass, which a semantic change does not
carry.

## Defects the gates found

- Deployment tables written only at session end left a session stopped at its
  wall budget without them, and the linearizability checker reads the model
  from those tables. They are now written before the first run.
- Oracle plans address nodes by path, so grading a migrated corpus matched
  nothing and graded zero runs. `spur resolve-plan` writes the resolved plan
  and evaluations resolve each oracle plan before grading.
