# crash-quiet-phase-arms

Iteration 38, epoch 14. Built on spur 02df730.

## What changes

In spur/spur-core/src/simulator/crash_phase.rs the anchored half of placed runs (bit 512 crashPhase) draws one of {EARLY, MID, STOCK} per placed crash and withholds the crash until the read node's fan-out shows the drawn phase. This adds a salted QUARTER of the anchored runs (bit 1 << 17 crashQuietPhase, own salt QUIET_SALT, nested in crashPhase and crashPlaced, probes exempt by inheritance; about 0.11 of all runs) on which the per-crash draw is taken from {LANDED, ANSWERED, STOCK} instead, with the same one-value draw from Stream::CrashPhase (% 3), the same WINDOW = 96, the same cap reserve and the same landing-node read (phase_read_node), so a treated run consumes the random sequence its twin does. Predicates over the read node's SendLedger: LANDED = segment_sends >= 1 && undelivered == 0 && in_flight == 0 (everything the node's current handler segment sent has landed and nothing of its own is in the network: a sender-side round just closed); ANSWERED = trigger == HandlerTrigger::Delivery && segment_sends == 0 && in_flight == 0 (the node's latest segment was woken by a message, wrote or tallied in silence, and nothing of its own is in flight: a receiver-side round just closed, the quorum-reached or learned-a-decision moment). crash_phase::Fanout gains delivery_woken: bool read from ledger.trigger at the existing crash_hold_mask site in core/scheduler.rs; no other site changes. The STOCK third is unchanged and is the same-side null inside the quarter. New util_stats.rs block crash_phase.quiet.{runs, landed, answered, stock} where landed/answered/stock are CrashPhaseArmStats (armed, released_on_condition, expired, wait_steps_sum, release/apply victim_had_inflight, inflight buckets, moved_read_on_landing/planned), plus crash_phase.quiet.mapped_draws (draws taken from the quiet table). Registration: run_variant.rs CRASH_QUIET_PHASE = 1 << 17 set only when CRASH_PHASE is set; decide.ts VARIANT_BITS gains row 131072 crashQuietPhase (unregistered today; no rename). No config field; the quarter share is a constant beside ANCHOR_SALT (the share becomes a config constant only if arm-share-constants-from-panel is built).

## Why

Verified state of the crash side (spur tree at run_variant.rs / crash_phase.rs / fault_timing.rs / ghost_absorber.rs): four fault arms, all keyed to the same idea. Bit 1 (0.9 of non-probe runs) draws the crash's step uniformly over the learned completed-run span; bit 9 (half of placed) then waits up to 96 steps for a drawn fan-out phase of the victim, EARLY (segment issued >= 1 send, none delivered) or MID (>= 2 issued, some delivered) or STOCK; bit 19 moves the crash to the node that last absorbed a fault-crossing delivery; the landing-node merge reads the phase on that node. Of the three opposite-side candidates the operator named, the uniform-no-anchor crash already exists and is already read per cell: it is the unanchored placed half (bit 1 set, bit 9 clear, about 0.44 of runs) and the panel's crashPhase column is exactly fan-out-anchored against uniform (paxos-accept-stale-ballot 1.01 flat, raft-stale-vote 1.24 wide). What does not exist is a crash placed on a node with nothing in flight. The crash census on the merged tree (chunk-1000 of crash-phase-on-landing-node-b) reads victim_had_inflight_sends 842,610 of 1,193,525 decisions (0.71), inflight_bucket_0 0.29; the EARLY arm applies with in-flight 137,434 / 163,563 (0.84), STOCK 0.73. The quiet pair inverts that number by construction (condition-released LANDED/ANSWERED crashes apply at in_flight 0) and so is the axis's other side, not a variant of the same side. One correction to research/lite/plans/panel-per-cell-read.md section 5: EARLY admits a single undelivered send (segment_sends >= 1, undelivered == segment_sends), so 'crash a node whose single reply has already landed' is not excluded by the fan-out arms today; MID (>= 2 sends) is. The distinct behaviour the quiet arms add is therefore not 'crash after a lone reply' but 'crash with nothing of the node's in the network', including the ANSWERED moment (silent absorption: quorum reached, decision learned, vote tallied) that no current arm can select. VR reading, frozen as a loss: labels 3 and 5 of the epoch-14 chain are crashes with the victim's sends in flight (crash_nl with its SVCs undelivered, crash_2 with three sends undelivered); a LANDED or ANSWERED release forbids both, so on the treated quarter only STOCK-drawn crashes (one third) and the roughly 10 percent of anchored-run crashes that draw no hold can carry the chain. With (E+M+S)/3 = 1.30 S from the g34 per-bit read, the quarter over the three-arm control is about S/(3.9 S) plus leakage: 0.18-0.45 on depth>=8. Tree-level cost while the quarter is in the tree: about 0.11 x 0.7 = 8 percent of depth-8 events per chunk, the stated price of having the axis's other side; the share is the operator's knob. The panel is where the arm earns its place; the decision rule is the operator's.

## Frozen prediction (rewritten by the judge at admission; graded, never rewritten)

```json
{
 "treatmentBit": {
  "name": "crashQuietPhase",
  "value": 131072,
  "shift": 17,
  "nestedIn": [
   "crashPhase (512)",
   "crashPlaced (1)"
  ],
  "reuse": "none: 131072 is not in VARIANT_BITS and no mechanism sets 1 << 17 (grep verified); the row is added at admission",
  "salt": "own (QUIET_SALT), salted_phase(run_id, QUIET_SALT, 4) == 0 within is_anchored(run_id)",
  "treatedShareOfAllRuns": 0.11,
  "controlShareOfAllRuns": "0.33 (crashPhase set, crashQuietPhase clear), matched by probeFreeScope plus invariantCoBits in both decide.ts and grader panelCells",
  "probesExempt": "by inheritance from crashPhase (run-cap probes are never placed)"
 },
 "rung": "depth>=8 (epoch 14 primary), per-run ratio treated / matched untreated (crashPhase = 1), probe-free",
 "band": [
  0.08,
  0.45
 ],
 "bandNote": "Frozen as a LOSS. Labels 3 (crash_nl) and 5 (crash_2) are both crashes with the victim's sends undelivered; each placed crash draws its own arm, so on the quarter both chain crashes must be STOCK-drawn (1/9), un-held (about 0.1) or leak at apply (candidate's own expectation 0.02-0.08). Lower edge 0.085 = (1/3)^2 / 1.3 with zero leakage; upper edge 0.45 is the candidate's single-crash estimate with leakage. A read below 0.08 says the quarter loses more than its STOCK third can explain and is an implementation check (the quiet table touching STOCK draws, or the control's sequence moved) before anything else is read.",
 "advanceRungs": {
  "depth>=9": {
   "expected": [
    0.08,
    0.5
   ],
   "reported": true
  },
  "depth>=10": {
   "expected": [
    0.05,
    0.6
   ],
   "reported": true,
   "note": "few events on 0.11 of runs; reported, never a claim"
  },
  "depth>=4 and depth>=6": {
   "expected": [
    0.15,
    0.6
   ],
   "reported": true,
   "note": "the inversion begins at label 3 (crash_nl with the SVCs undelivered), so the loss shows from depth>=4; depth>=4 near 1.0 with depth>=8 in band says the loss comes from elsewhere and is an implementation check"
  }
 },
 "vrCost": {
  "statement": "Tree-level price of carrying the quarter: the anchored half carries about 1.3x the unanchored depth-8 rate, so the quarter holds about 0.14 of the tree's depth-8 events; at the expected ratio the tree loses 10-13 percent of depth>=8 events per chunk (candidate said 8).",
  "acceptable": "cross-binary depth>=8 events per explore-second over four chunks >= 0.84 of the paired cache (expected 0.86-0.92; the 5 percent layout floor applies, so a read in [0.84, 0.88) is recorded as the stated price, not a separate finding); throughput (runs per explore-second) >= 0.97 of the paired cache; wall per step within 1 percent across the quarter and its control.",
  "unacceptable": "cross-binary depth>=8 per second below 0.84, or throughput below 0.97: close regardless of the panel."
 },
 "panelCells": {
  "readOn": "grader panel --binary <candidate spur binary> --members paxos-fixed-forget-promise,raft-forget-vote,paxos-fixed-recover-forget-accepted,paxos-fixed-host-control,paxos-accept-stale-ballot,mencius-opt1-2,raft-stale-vote,paxos-fixed-recover-stale-scout --seed <s> --scale 3, cell crashQuietPhase (131072); matched control = crashPhase set, crashQuietPhase clear (panelCells invariant co-bits). Pooling across seeds: sum treatedRuns/treatedViolations and controlRuns/controlViolations per member from research/lite/state/panel/<iso>/<member>/{porcupine,runs}.json and apply the cell arithmetic (log-ratio, z 2.7, overdispersion 1.3, >= 5 violations on each half, ratio - 1 >= 0.02).",
  "upDefinition": "a cell reads UP when the pooled ratio's 2.7-sigma lower edge (overdispersion 1.3) is above 1, ratio - 1 >= 0.02, and both halves carry >= 5 violations - the grader's own 'up'.",
  "expectedUp": [
   {
    "member": "paxos-fixed-forget-promise",
    "direction": "up",
    "expected": ">= 2.0 per run",
    "runsPerRead": "runsPerConfig 20000 -> about 480,000 runs per seed (479,513 observed), about 70 s explore at 6.9k rps",
    "eventsPerRead": "rate 9.2e-5: control (0.33 share) about 14.6 events; treated quarter 4.9 at the base rate, >= 9.7 at a 2x lift, >= 19 at 4x",
    "seeds": "1000, 1001, 1002, 1003 pooled (1.92M runs). A >= 4x lift reads up on seed 1000 alone; a 2x lift needs about 33 treated events, which four pooled seeds supply. Read seed 1000 after the grade, pool the rest at the review.",
    "why": "acceptor_ballot dropped at RecoverInit; the acceptor's promise must have been used by its leader and the superseded P2a pending across a crash that strands nothing of the acceptor's; LANDED is that moment (manifest orderingClass and plan section 5 agree)"
   },
   {
    "member": "paxos-fixed-recover-forget-accepted",
    "direction": "up",
    "expected": ">= 2.0 per run once calibrated",
    "precondition": "calibrate first on the merged tree: three seeds x 480,000 runs against paxos-fixed-host-control at the same overlay, join only at >= 20x separation from the control (plan section 5 rule); the rate r_c sets treated events per read = 0.11 x 480,000 x r_c x lift",
    "runsPerRead": "runsPerConfig 20000 -> about 480,000 runs per seed",
    "seeds": "1000-1003 pooled after calibration, same arithmetic as forget-promise",
    "why": "accepted dropped at RecoverInit; the acceptor's P2b must have been used (slot chosen) before it crashes; LANDED, or ANSWERED after a Decision taken in silence (N2 in the plan, 5/5 proven)"
   },
   {
    "member": "raft-forget-vote",
    "direction": "up",
    "expected": ">= 1.5 per run; only a >= 2x lift is confirmable inside the budget",
    "runsPerRead": "runsPerConfig 40000 -> 2,880,000 runs per seed, about 390 s explore at 7.4k rps",
    "eventsPerRead": "rate 2.7e-5: control about 25.7 events; treated quarter 8.6 at the base rate, 17 at 2x",
    "seeds": "1000 and 1001 pooled (5.76M runs, about 13 min) confirm a >= 2x lift at z 2.7; a third seed is allowed; a 1.5x lift cannot be confirmed within three seeds and is REPORTED, never a keep criterion",
    "why": "voted_for dropped at RecoverInit; the vote must have been counted before the crash"
   }
  ],
  "expectedDown": [
   {
    "member": "raft-stale-vote",
    "expected": [
     0.3,
     0.9
    ],
    "note": "quick set, about 114 events in 288,000; treated about 12 at the base rate, so likely wide or count-only; reported",
    "why": "needs the candidate's crash inside its RequestVote fan-out"
   },
   {
    "member": "paxos-fixed-recover-stale-scout",
    "expected": "count-only (about 30 events at scale 3)",
    "why": "needs the crash after the P1a fan-out with the P1b replies in flight"
   }
  ],
  "expectedFlat": [
   {
    "member": "paxos-accept-stale-ballot",
    "expected": [
     0.85,
     1.05
    ],
    "note": "3,353 events per read, treated about 370: resolves in one read",
    "why": "crashPhase read 1.01 for it; two proposers contesting a slot, crash optional"
   },
   {
    "member": "mencius-opt1-2",
    "expected": "flat (null row, no crashes)"
   },
   {
    "member": "paxos-fixed-host-control",
    "expected": "0 violations (clean control)"
   }
  ],
  "notUpDefinition": "a named member is NOT up when, after its specified pooled seeds, the cell reads flat or down, or reads count-only with pooled treated violations >= 15 and ratio < 1.5.",
  "powerNote": "treated events scale with the share (1:3 treated:control runs at the quarter), so the share stays at the quarter through the read; the member's runs per read is the bound. Forget-promise and forget-accepted resolve a 2x lift on four pooled seeds (about 5 min each), raft-forget-vote a 2x lift on two (about 13 min)."
 },
 "firing": {
  "counter": "crash_phase.quiet.landed.armed",
  "floorPerChunk": 25000,
  "also": [
   "crash_phase.quiet.answered.armed >= 25,000 and crash_phase.quiet.stock.armed within 15 percent of each (equal-mass draw)",
   "crash_phase.quiet.mapped_draws >= 75,000 per chunk (about 0.11 x 574k runs x 1.93 armed crashes per anchored run = 122k expected)",
   "released_on_condition / armed >= 0.60 on landed, >= 0.40 on answered; expired / armed reported per arm",
   "wait_steps_sum / (released_on_condition + expired) reported per arm, expected below 27",
   "crash_phase.quiet.landed.released_with_peer_held reported (condition releases while a record of the read node sits in crash_info.queued_messages)",
   "control arms crash_phase.early/mid/stock per-chunk armed fall to about three quarters of 161k/161k/160k with release and apply shares unchanged within 2 percent"
  ]
 },
 "independentObservable": {
  "statement": "apply-time victim_had_inflight / apply_decisions on condition-released LANDED and ANSWERED crashes <= 0.10 (EARLY reads 0.84, STOCK 0.73 on chunk -b); treated-quarter anchored applies inflight_bucket_0 share >= 0.55 against 0.16 (EARLY), 0.14 (MID), 0.27 (STOCK); read from the new quiet block against the existing per-arm blocks on the same chunk",
  "expected": "0.02-0.08 in flight at apply (a step or two may pass between mask-off and the crash being taken); bucket_0 about 0.6"
 },
 "falsifier": "landed.armed < 25,000 per chunk (closed without a rate read); or in-flight share at apply on condition-released quiet crashes > 0.25 (the predicates do not produce quiescent crashes); or depth>=8 treated/control > 0.60 with the floor met (the arm is not inverting the condition; check the read node); or depth>=8 below 0.08 (implementation check before any read is credited); or treated steps per run > 1.03x control; or plan_complete more than 2 points apart; or crashes or recovers per run off by more than 1 percent; or the VR cost clause failed; or, on the panel, none of the three named members reads UP after its specified pooled seeds (remove the arm, keep the quiet census counters, record that the panel has no quiet-side member).",
 "cost": "cross-binary runs per explore-second >= 0.97 of the paired cache (about 1,990-2,040 rps); wall per step within 1 percent across the quarter and its control (one trigger read at an existing site). Tree-level depth>=8 price as stated under vrCost.",
 "decisionMap": "depth>=8 in [0.08, 0.45], VR cost clause met, and at least one named member UP (pooled per its seed schedule) -> merge and KEEP THE ARM AT THE QUARTER (the share the read was taken at; any later share change is an operator decision from the tree ledger and needs its own panel re-read). depth>=8 in band, cost met, named members not up after their pooled seeds -> remove the arm, keep the quiet census, file the finding 'no quiet-side member on the current panel'. depth>=8 above 0.60 or below 0.08, or apply-time in-flight share above 0.25 -> implementation check before any read is credited. VR cost clause failed -> close regardless of the panel.",
 "grading": "grader start --treatment-bit 131072 --band-min -0.92 --band-max -0.55, four chunks; then grader panel on the candidate binary: quick set plus paxos-fixed-forget-promise and raft-forget-vote at seed 1000 right after the grade (about 8 min), seeds 1001-1003 for forget-promise and 1001 for raft-forget-vote pooled at the review; paxos-fixed-recover-forget-accepted calibrated first (three seeds against paxos-fixed-host-control) and read the same way once admitted.",
 "rewritten": true
}
```

## Grading protocol (an opposite-side arm)

Build on the merged tree (spur 02df730 or later). Grade: research/lite grader start --treatment-bit 131072 --band-min -0.92 --band-max -0.55, four chunks, primary depth>=8 per run treated/matched control (crashPhase = 1), all firing and independent-observable clauses read on chunk 1 before the rungs are credited; VR cost clause (cross-binary depth>=8 per second >= 0.84, throughput >= 0.97) read at finish. Panel: grader panel --binary <candidate> --members paxos-accept-stale-ballot,mencius-opt1-2,raft-stale-vote,paxos-fixed-recover-stale-scout,paxos-fixed-forget-promise,raft-forget-vote,paxos-fixed-host-control --seed 1000 --scale 3 after the grade; pool seeds 1001-1003 (forget-promise) and 1001 (raft-forget-vote) at the review by summing halves from the panel state files; calibrate paxos-fixed-recover-forget-accepted (three seeds vs the fixed host) and add it. Verdict by the decisionMap: keep at the quarter only on an UP cell (2.7 sigma, overdispersion 1.3, >= 5 violations per half, ratio - 1 >= 0.02) for at least one named member.

The VR grade (start --treatment-bit 131072, four chunks) reads the
predicted loss and the tree cost; the keep decision is the per-cell panel
read on the candidate binary for the named members, with "up" at the
grader's cell rule (z 2.7, overdispersion 1.3, at least 5 events per half,
effect at least 2 percent). An arm that loses on the VR rung and does not
read up on its named members is closed.

## Judge notes

Ranked first and the only mechanism in the round: a verified inversion of the crash axis, reading the same ledger the merged arms read, with the twin-stream property preserved and every cited number reproducing. Its VR read is a frozen loss by design and the keep decision lives on the panel; the prediction below makes that read operational. Implementer: (1) the treated table is a separate [Landed, Answered, Stock] array drawn with the same % 3 so the control's random sequence is untouched - assert with a CountingRng twin test like crash_phase.rs:352-386; (2) read trigger from the landing node's ledger copy already taken at scheduler.rs:725, never the planned victim's; (3) add crash_phase.quiet.landed.released_with_peer_held (read node has a record in crash_info.queued_messages at a condition release) so 'landed' is reported net of set-aside records; (4) Fanout gains delivery_woken: bool; the test helper fanout() sets it false; (5) decide.ts VARIANT_BITS row {131072, crashQuietPhase} is operator registration in the same commit; (6) crash_phase.quiet.{runs, mapped_draws, landed/answered/stock: CrashPhaseArmStats} in util_stats.rs.
