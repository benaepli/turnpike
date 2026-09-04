# crash-arm-table-by-fault-index

Iteration 41, epoch 14. Built on spur 02df730. Successor of the closed
crash-quiet-phase-arms (iteration 38).

## What changes

The crash-phase arm table is chosen per fault index within the run instead
of per run: the first crash of a run draws from the fan-out table (EARLY,
MID, STOCK), the second and later crashes draw from the quiet table
(LANDED, ANSWERED, STOCK), on a salted half of the anchored placed runs.
Everything else is as merged: the draw count, the window, the reserve, and
the landing-node read.

## Why

Iteration 38 put the quiet table on every crash and read depth>=8 0.82
with depth>=9 1.27. The judge recomputed the stored chunks and separated
the two effects: the conditional P(depth>=9 | depth>=8) is 0.246 on the
quiet quarter against 0.1586 on the fan-out control, a ratio of 1.551, and
1.271 = 0.820 x 1.551 exactly. So the quiet timing costs the initiating
crash its in-flight sends and pays on the second crash, which in the chain
follows node 2's StartViewChange and DoViewChange sends. Splitting the
table by fault index keeps both.

## Frozen prediction (rewritten by the judge at admission; graded, never rewritten)

```json
{
 "treatmentBit": {
  "name": "crashQuietBySecond",
  "value": 131072,
  "shift": 17,
  "nestedIn": [
   "crashPhase (512)",
   "crashPlaced (1)"
  ],
  "reuse": "VARIANT_BITS row 131072 renamed from crashQuietPhase (closed iteration 38; run_variant.rs sets no bit 17)",
  "salt": "own (QUIETIDX)",
  "share": "0.5 of anchored placed runs, about 0.235 of all runs",
  "controlShareOfAllRuns": "0.235 (crashPhase and crashPlaced set, this bit clear)",
  "probesExempt": "by inheritance from crashPhase and crashPlaced",
  "registration": "run_variant.rs CRASH_QUIET_BY_SECOND plus the decide.ts VARIANT_BITS rename, same commit"
 },
 "mechanism": "The fan-out table {EARLY, MID, STOCK} keeps the initiating crash, whose depth-6/7/8 contribution is the victim's sends being in flight; the quiet table {LANDED, ANSWERED, STOCK} takes the second and later crashes, whose chain role (crash_2, after node 2's SVC and DVC sends) is a landed-or-answered moment. Iteration 38's measured decomposition - a 0.82 factor on reaching depth 8 and an independent 1.551 factor on converting depth 8 to depth 9 - is predicted to separate along the fault index, restoring the first and keeping the second.",
 "rung": "depth>=8 (epoch 14 primary), per-run ratio treated/untreated, probe-free, co-bit matched",
 "band": [
  0.97,
  1.05
 ],
 "bandNote": "Frozen as a NULL on the primary. The first crash is unchanged by construction, so a depth>=8 read still near 0.85 means the quiet table is still reaching the initiating crash and is an implementation check, not a result.",
 "decisiveRung": {
  "rung": "depth>=9",
  "expected": [
   1.2,
   1.7
  ],
  "requirement": "lower edge above 1.05 over four chunks",
  "why": "if the 1.551 conditional conversion belongs to the second crash and depth 8 is restored, the unconditional depth>=9 ratio approaches 1.55; a read below 1.20 says most of iteration 38's conversion came from the first crash's quiet timing or from conditioning on a filtered depth-8 population"
 },
 "advanceRungs": {
  "depth>=10": "expected [1.10, 1.80], reported",
  "depth>=11": "reported",
  "depth>=6 and depth>=7": "expected [0.97, 1.03]; iteration 38 read 0.81 on both, so a read below 0.95 here is an implementation check saying the first crash still draws the quiet table"
 },
 "conditionalReported": "P(depth>=9 | depth>=8) treated over control, reported per chunk beside the unconditional ratio, since the whole arm is a claim about which of the two factors moves.",
 "firing": {
  "counter": "crash_phase.quiet.landed.armed + crash_phase.quiet.answered.armed, split by fault index",
  "floorPerChunk": 20000,
  "also": [
   "crash_phase.quiet.armed_by_index{1} exactly 0 (exact; any non-zero first-crash quiet arm is an implementation check before any rung is credited)",
   "crash_phase.{early,mid,stock}.armed_by_index{1,2,3plus} reported for both tables so the index split is auditable on both sides",
   "armed_by_index{2plus} as a share of all arms on the treated half, expected 0.15-0.35; below 0.10 the arm is inapplicable and the round closes as a shape read",
   "released_on_condition / armed for the quiet arms on second-or-later crashes, expected 0.55-0.75 as at iteration 38 (24,189/44,300 and 26,605/43,204)",
   "crashes and recovers per run within 1% of the control half"
  ]
 },
 "independentObservable": "In-flight share at apply on condition-released SECOND-or-later crashes is at most 0.20 (iteration 38's quiet arms read condition_apply_victim_had_inflight/condition_apply_decisions of 4,916/26,195 = 0.19 and 4,435/28,037 = 0.16), while the same share on FIRST crashes stays at the fan-out arms' level, at least 0.80 (iteration 38's early arm reads 113,430/124,225 = 0.913). Both are reported per chunk. Neither is the rung.",
 "falsifier": "depth>=9 interval entirely below 1.05 over four chunks (the conversion gain did not follow the fault index: close and record that iteration 38's depth-9 lift was the first crash's quiet timing or a depth-8 selection effect - a real finding about the quiet family); or depth>=8 outside [0.95, 1.07]; or depth>=6 below 0.95 (implementation check, the first crash is still quiet); or first-crash quiet arms non-zero; or quiet arms on second-or-later crashes below 20,000 per chunk; or armed_by_index{2plus} below 0.10 of arms (inapplicable); or steps per run above 1.03x; or plan_complete more than 4 points below the control (iteration 38 read plan completion 4 points HIGHER, so a drop is the signal that the split lost what the quiet table bought).",
 "panelCells": {
  "keepRuleRequired": false,
  "why": "the arm predicts no VR loss, so the panel is reported, not decisive",
  "readOn": "grader panel --binary <candidate> --members paxos-fixed-forget-promise,raft-forget-vote,paxos-fixed-recover-forget-accepted,paxos-accept-stale-ballot,mencius-opt1-2,paxos-fixed-host-control --seed 1000 --scale 3, cell crashQuietBySecond (131072), matched control = crashPhase and crashPlaced set with this bit clear",
  "expectedFlat": [
   {
    "member": "mencius-opt1-2",
    "expected": "flat, null row (no crashes)"
   },
   {
    "member": "paxos-fixed-host-control",
    "expected": "0 violations"
   }
  ],
  "reported": [
   {
    "member": "paxos-fixed-forget-promise",
    "expected": "reported; iteration 38's whole-run quiet arm read it 4 against 44 events, so the split is expected to recover toward 1.0"
   },
   {
    "member": "raft-forget-vote",
    "expected": "reported; 0.59 on the whole-run quiet arm"
   },
   {
    "member": "paxos-fixed-recover-forget-accepted",
    "expected": "reported; 0.73 on the whole-run quiet arm"
   },
   {
    "member": "paxos-accept-stale-ballot",
    "expected": "[0.90, 1.10]"
   }
  ]
 },
 "cost": "cross-binary throughput >= 0.97 of the paired cache; wall per step within 1 percent between halves. The change is which of two tables the existing per-crash draw indexes plus one integer read of the run's crash ordinal at the arming site, so a read below 0.97 is layout, and below 0.94 refutes.",
 "decisionMap": "depth>=8 in [0.97, 1.05] and depth>=9 lower edge above 1.05 -> merge the fault-index table. depth>=8 restored and depth>=9 back at 1.00 -> close, and record the finding that iteration 38's depth-9 lift did not belong to the second crash. depth>=8 still near 0.85 or depth>=6 below 0.95 -> implementation check, no rung credited. Firing or applicability floors missed -> file as a shape read.",
 "rewritten": true
}
```

## Grading protocol

Build on the merged tree (spur 02df730 or later) in crash_phase.rs plus the existing crash_hold_mask site; derive the crash ordinal at the arming site, not at apply, so a retargeted crash keeps its index. Grade four chunks with grader start --treatment-bit 131072 --band-min -0.03 --band-max 0.05. Read the firing exactness clause (first-crash quiet arms exactly 0) and armed_by_index on chunk 1 before any rung is credited; report depth>=6, 7, 8, 9, 10 and the conditional P(9|8) every chunk. Panel quick set plus the three forget members at seed 1000 on the candidate binary after the grade, reported only. Verdict by the decisionMap.

## Implementer watch (from the judge)

Bit assignment changed from 'a new bit' to the reuse of 131072 (crashQuietPhase), which is the closed ancestor's own row and is set by nothing in spur-core - it keeps the ledger's lineage readable and costs no fixture edit. Share raised from the candidate's implied quarter to a salted HALF of the anchored runs, because the quiet table now applies only to second-or-later crashes and the thinner population needs the runs back. The candidate predicts no VR loss, so no panel keep rule is required; panel cells are reported only.

Verified at admission: ["crash_phase.rs exposes arm_node(node, reserve) / arm_of(node) and the single draw site at rng.use_stream(Stream::CrashPhase); WINDOW = 96; is_anchored is the parent split. The table is drawn per placed crash, so keying the table by fault index is a change of which table the existing draw indexes, not a new draw - the treated run keeps consuming its twin's random sequence.", "The DAG confirms the shape the candidate claims: crash_nl (node 1) must precede deliver_svc_1_to_2, so the initiating crash needs node 1's fan-out in flight; crash_2 (node 2) is gated on deliver_svc_1_to_2 and precedes recover_2 and deliver_rec_2_to_1, i.e. it follows node 2's own SVC/DVC sends - a landed-or-answered moment. The fan-out table is right for the first crash and the quiet table for the second, exactly as claimed.", "I recomputed iteration 38's read myself from research/lite/state/crash-quiet-phase-arms/chunk-100{0,1,2,3}.cand.json, probe-free (variant & 6 == 0), restricted to the parent (variant & 513 == 513) and co-bit matched over 387 cell pairs, 248,664 treated against 745,732 control runs: depth>=6 0.809, depth>=7 0.816, depth>=8 0.820, depth>=9 1.271, depth>=10 1.413, depth>=11 3.21 on 31/29 events. These reproduce the reported 0.83 and 1.29.", "The decisive new number, not previously computed: P(depth>=9 | depth>=8) is 0.246 treated against 0.1586 control, a conditional ratio of 1.551, and 1.271 = 0.820 x 1.551 exactly. The 8-to-9 conversion gain is real and arithmetically separate fr

False claims named at admission: []

## Verdict (2026-09-05)

Closed, refuted on its own band. Four chunks, 441,229 treated against
439,340 matched control runs (crash placement and the phase arm on both,
crash-hold share 0.906 against 0.905):

| rung (matched) | treated / control | interval |
| --- | --- | --- |
| depth>=8 | 0.828 | [0.760, 0.903] |
| depth>=9 | 1.066 | [0.906, 1.255] |
| depth>=10 | 1.189 | [0.788, 1.794] |

The implementation gate passed exactly: quiet arms armed on fault index 1
exactly 0 (185,209 ANSWERED, 184,559 LANDED, 185,472 quiet STOCK, all on
index 2 or later), the fan-out arms still armed 341,958 / 338,611 /
337,177 on index 1, and the independent observable held - in-flight at
apply on condition-released quiet crashes 0.158 (ANSWERED) and 0.191
(LANDED) against the fan-out arms' 0.986 on the first crash. Throughput
1.031.

So the first crash was untouched and depth 8 still fell 17 percent: the
loss belongs to the second crash. That is the chain's own structure. The
ghost StartViewChange and DoViewChange of labels 8 and 9 are records node
2 sent and left in flight when it crashed; a crash placed when node 2's
network is quiet is a crash with no ghosts to leave. The conversion gain
replicated (P(depth>=9 | depth>=8) ratio 1.29 here, 1.55 at iteration 38
against a wider control) but cannot pay for a loss at the rung the
conversion starts from.

The two sessions together give the successor its predicate: the chain wants
a crash whose in-flight sends are exactly those addressed to the recovering
peer. Seeded as crash-quiet-except-toward-restarted-peer.
