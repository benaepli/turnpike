# crash-phase-on-landing-node

Iteration 35, epoch 14. Built on spur 327bf72.

## What changes

In spur/spur-core/src/simulator/core/scheduler.rs crash_hold_mask() builds crash_phase::Fanout from the PLANNED victim n's ledger and asks state.crash_phase.hold(n, fanout, ...), while retarget_crash() at apply moves the crash to the ghost absorber d chosen by ghost_absorber::choose(). On runs with both crashPhase (512) and ghostAbsorberRetarget (1 << 19) set, a salted half (nested bit, own salt, about 0.115 of all runs; probes exempt by inheritance) computes d = choose(n, ledgers, servers, is_live, has_pending_pair) at each hold step once the step hold has expired and evaluates the drawn arm's phase on d's ledger (segment_sends = issued - floor, undelivered = recent, in_flight), on n itself when the choice is SameVictim or NoAbsorber. The arm draw, WINDOW, reserve and the apply-time retarget are unchanged; a treated run reads the same random sequence as its twin. New counters in util_stats.rs: crash_phase.landing.{evaluated_on_other_node, condition_on_other_node, expired_on_other_node, mismatch_at_apply (landing differs from the node the phase was last read on)}, and the existing per-arm apply inflight buckets split by landing != planned on both quarters. No config field. Registration: run_variant.rs CRASH_PHASE_ON_LANDING = 1 << 23 set only when CRASH_PHASE and GHOST_ABSORBER_RETARGET are set; decide.ts row 8388608 renamed from ghostAbsorberRedraw to crashPhaseOnLanding (the redraw was closed at iteration 20 and is not in the tree: grep 'redraw' over spur-core/src/simulator returns nothing).

## Why

A miswire between two merged mechanisms. The retarget's pool entry says it outright: 'placement timing and the fan-out anchor's hold are evaluated on v as today; only the identity of the node that dies changes'. On the iteration-23 dump victim_swap.applied is 132,470 of 645,194 treated crashes (20.5% move) and on those the fan-out condition was met on a node that did not crash while the node that did crash was at an arbitrary point of its own fan-out. The retarget picks the node that most recently absorbed a fault-crossing delivery, acted preferred - on the chain that is node 2 right after it acted on the ghost StartViewChange, and its current segment then holds the reaction SVCs and the DoViewChange, the depth-8 and depth-9 records. The g34 side reads show both mechanisms manufacture depth-8 shape that fails 9: anchored runs convert 8->9 at 0.168 against 0.199, retarget runs at 0.178 against 0.189, and both are flat by depth 10 (0.97-1.00; 0.97-1.22). Reading the phase on the landing node puts the crash inside the absorber's reaction fan-out, which is bug.md's step 5 (the corpus plan's crash_2 right after deliver_svc_1_to_2) and is what the closed REACTION arm (iteration 17) looked for on the planned victim and found in 8% of releases: on the planned victim a fault-caused fan-out is rare inside the window, on the retarget's destination it is what the destination was chosen for. Sizing: moved-crash runs carry about 40% of the cell's depth-8 events (20% of crashes at about 2.7x the rate, from the 1.35 retarget contrast); the anchor is worth 1.30 where it reads the right node and about nothing where it reads the wrong one, so the cell gains about +12% on depth 8, and the depth-9 conversion on those runs moves toward or past the unanchored 0.199, giving depth 9 +15-30% in the cell.

## Frozen prediction (as admitted; graded, never rewritten)

```json
{
 "treatmentBit": {
  "name": "crashPhaseOnLanding",
  "value": 8388608,
  "shift": 23,
  "nestedIn": [
   "crashPhase (512)",
   "ghostAbsorberRetarget (524288)"
  ],
  "reuse": "bit 23 was ghostAbsorberRedraw (closed iteration 20); no mechanism in spur-core sets it (verified by grep); the decide.ts row is renamed by the operator at admission",
  "salt": "own",
  "treatedShareOfAllRuns": 0.115,
  "probesExempt": "by inheritance"
 },
 "rung": "depth>=8 (epoch 14 primary), per-run ratio treated quarter / merged quarter, probe-free, co-bit matched within crashPhase = 1 and ghostAbsorberRetarget = 1",
 "band": [
  1.04,
  1.2
 ],
 "advanceRungs": {
  "depth>=9": {
   "expected": [
    1.1,
    1.45
   ],
   "mergeClaim": true,
   "note": "carries a merge when depth 8 is flat and its band is not refuted"
  },
  "depth>=10": {
   "expected": "at least the depth-9 ratio",
   "reported": true
  }
 },
 "decisiveContrast": "treated quarter (phase read on the landing node) versus merged quarter (phase read on the planned victim) at depth>=9, with depth>=8 not below 0.97",
 "firing": {
  "counter": "crash_phase.landing.condition_on_other_node",
  "floorPerChunk": 8000,
  "unit": "counted once per armed crash: evaluated_on_other_node = armed crashes whose hold-time choice was Retarget at least once; condition_on_other_node = those released by the phase predicate on d's ledger; expired_on_other_node = those released by the window or reserve while last read on d; mismatch_at_apply = condition releases whose apply-time victim differs from the node the phase was last read on",
  "also": [
   "crash_phase.landing.evaluated_on_other_node >= 12,000 per chunk",
   "crash_phase.landing.expired_on_other_node / evaluated_on_other_node reported against the merged arms' 0.18",
   "crash_phase.landing.mismatch_at_apply <= 5% of condition releases"
  ]
 },
 "independentObservable": {
  "statement": "on crashes where landing != planned, victim_had_inflight_sends / crashes on the treated quarter >= 1.10x the merged quarter's (both quarters split the census by landing != planned); on a kept explore the census's 'ghost DVC 2->1 exists' among treated depth-8 runs >= 1.3x the merged quarter's",
  "expected": "moved crashes on the merged quarter land at the census control's 0.70; treated toward the anchored 0.83-0.85"
 },
 "falsifier": "depth>=9 interval entirely below 1.05 with the floor met; or depth>=8 interval entirely below 0.97; or condition_on_other_node / evaluated_on_other_node below 0.50 (the absorber's segment is seldom in phase inside 96 steps, REACTION's reading recurring); or plan_complete more than 2 points below the merged quarter; steps per run > 1.03x; crashes or recovers per run off by more than 1%",
 "cost": "cross-binary throughput >= 0.97 of the paired cache (2,042 rps); choose() scans at most num_servers ledgers per waiting crash per step on the quarter only; wall per step equal within 1% across quarters",
 "decisionMap": "depth 9 up with depth 8 >= 0.97 -> merge as the rule for retarget runs; depth 9 flat with condition share >= 0.5 -> file with the DVC-exists census; condition share < 0.5 -> close and record that the absorber's reaction is not in phase inside 96 steps",
 "rewritten": true,
 "rewriteNote": "only the firing unit was made explicit (per armed crash, not per step); bands, floors and the decision map are the proposer's"
}
```

## Implementer watch (from the judge)

Ranked first: a verified inconsistency between two merged mechanisms, a mechanism-to-observable path that names the DAG's depth-9/10 records, and checkable side reads that all reproduce. Shares the crash_phase actuator with crash-phase-arm-ablation-early-only; build this one first (or in a separate session) so the 'merged quarter' control is the merged three-arm rule and not a mixture. The decide.ts row rename is operator registration at admission, not candidate scope. Implementer must watch: (1) choose() must be called with the same is_live/has_pending_pair closures retarget_crash uses (scheduler.rs:1443-1455), else the hold-time d and the apply-time d differ systematically and mismatch_at_apply is not noise; (2) count evaluated/condition/expired once per armed crash, not per step; (3) SameVictim and NoAbsorber must fall back to n's ledger byte for byte; (4) no random draw is added, so the twin quarter reads the same stream - assert this in a test like crash_phase.rs's CountingRng tests; (5) the per-arm apply buckets must be split by landing != planned on both quarters or the independent observable cannot be read.

## Grading

`start --treatment-bit 8388608 --band-min 0.04 --band-max 0.2`, four
chunks; the decisive contrast and the extension rule are in the prediction.
