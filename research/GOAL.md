# Research Loop Goal

Surface the VR-Revisited view-change/recovery bug (`research/oracle/bug.md`) through a
**general** scheduler configuration — no bug-specific plan, no deliver reservations, no
labeled-timer gating, no VR-specific heuristics — by improving the Spur simulator's
exploration (`spur/spur-core/src/simulator/`) and the loop's general configs
(`scheduler_configs/loop/`).

Success = porcupine reports a linearizability violation on `bin/spur/VR.spur` under
`scheduler_configs/loop/general_vr.json` (or an evolved general config), reproducibly.

## The metric ladder (how progress is measured)

- L0 throughput/waste: runs/sec, unpaired-invocation fraction.
- L1 hazard rates (generic): H1 crash-with-in-flight-send; H2 stale-incarnation delivery
  (sender crashed after send, recovered before delivery); H2b receiver-side variant;
  H3 two distinct nodes crash+recover in one run.
- L2 prefix depth: root-anchored satisfied-chain depth against the oracle DAG
  (`research/oracle/relax_minimal_general.json`), P(depth >= k) for k = 4..8.
  Measured fact: ALL known violating runs sit at depth 8; clean runs average 3.65.
- L3 violations: porcupine verdicts (ground truth — never gameable).

Raise the ladder from the bottom: each rung k is a conditional probability;
lift P(rung k+1 | rung k) with GENERIC mechanisms.

Where the ladder actually stands (epoch 3, measured over 32,400 general runs):
P(depth>=4) 0.355, P(depth>=5) 0.082, P(depth>=6) 0.014, P(depth>=7) 0.0013,
P(depth>=8) 0.00006. The lower rungs are close to saturated, so the payoff is
in the conditional P(rung k+1 | rung k) for k >= 5 — the attrition from
depth>=5 to depth>=6 is the steepest step on the ladder. Depth is a proxy, not
the target: general-config depth-8 runs have all been linearizable so far,
against 71% violation at depth 8 in the plan corpora, so a mechanism that
reaches depth 8 more often still has to produce a violation to count.

## Rules (enforced mechanically; violating them wastes the iteration)

1. Generality: scheduler code and general configs must never mention VR handler names
   (StartViewChange, DoViewChange, StartView, RecoveryResponse) or the "timeout" timer
   label. The grader may know the bug; the subject may not.
2. Opt-in shape: new mechanisms are config fields defaulting to today's behavior.
   Changing default semantics routes the PR to needs-human instead of auto-merge.
3. Ruler/subject separation: a change touches the grader (traceanalyzer/) OR the subject
   (spur/, scheduler_configs/loop/), never both.
4. Protected: bin/spur/** (protocol specs), porcupine/** (ground truth),
   research/oracle/**, research/corpus/** (calibration), scheduler_configs/** outside loop/.
5. Regression: merged changes must keep finding the Mencius bug, keep fixed specs clean,
   keep VR no-fault clean, and stay within 20% of baseline throughput.
6. Evidence: every claim of improvement needs CI-separated rates on fixed seeds,
   measured with the same protocol as the baseline (long sessions of 1000
   runs/config; frontier rates depend on session length). A candidate is sampled
   one session at a time until it separates, cannot, or is probably real but too
   small to resolve (inconclusive: the branch is kept and can be resumed).

## Promising directions (seed thinking, not limits)

Send-anchored crash points; orphan-message purgatory (hold messages whose sender crashed
until it recovers); incarnation-aware timeline novelty; exclusive/one-node timer firing;
PCT-style priority change points; hazard-predicate fitness for genetic/AOS modes; fixing
miswired knobs (randomly_delay_msgs is silently ignored; randomly_drop_msgs is dead code);
enabling unexercised mechanisms (CFG feedback is never turned on in loop configs);
ablating mechanisms whose utilization counters stay at zero.

## The performance lane

Explorer throughput multiplies every rung (bug-finding rate = runs/sec x
probability-per-run) and shrinks every future evaluation. perf-kind hypotheses
optimize runs/sec, evaluated by an interleaved A/B benchmark against the
preserved baseline binary (strict dominance + >=5% mean improvement), gated by
ladder non-inferiority + the regression suite so "optimizations" that break
scheduling semantics or grader instrumentation are rejected. Profile snapshots
(perf record on the bench workload) are collected at audit time and stored in
observations — aim perf hypotheses at measured hotspots, not guesses. The
easiest false win — removing instrumentation the grader needs — fails the
ladder/regression gates; do not propose it.
