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

Measured: at depth 8 the ladder is saturated and blind. Among archived depth-8
runs, the violating and non-violating ones are identical on every graded
feature (edge satisfaction, matched labels, chain score, critical path), yet
76% violate under plan-constrained timers against under 1.8% under the general
grid. The difference is timer admission - the plans decide when timers may
fire, the general grid lets the simulator fire them at will, and no graded
feature observes this. Mechanisms that make timer firing a schedulable,
steerable decision relative to message delivery therefore have headroom the
depth ladder cannot currently show; a proxy that observes timer-versus-delivery
ordering would make that headroom measurable.

Measured (epoch 3, delivery_effects over 1.08M deliveries, write-counter
token): the protocol absorbs most of what the loop injects. An ordinary
delivery has an effect 40.9% of the time, a scheduler-biased one 13.7%, a
purgatory-delayed one 13.8%. "Mechanism fired" and "mechanism had an effect"
are different questions, and only the second predicts ladder movement.
Absorption is also a far cheaper prescreen than depth: it resolves on 1,080
runs rather than 54,000.

The sharpest number is the asymmetry between the two stale-incarnation
paths. A delivery whose sender restarted in the meantime is acted on 15.9%
of the time (167/1052); a delivery into a receiver that restarted is acted
on 1.8% (37/2061). The receiver-side path, the h2b variant, is roughly nine
times more absorbed than the sender-side path, and it is the path all six
failed purgatory and orphan hypotheses aimed at: holding, releasing and
reordering messages destined for a node that went away. They were pushing on
the most absorbed surface in the system.

The lever this points at is timing on the sender side, not volume on the
receiver side: what decides whether a stale delivery is accepted or dropped
is where it lands relative to the receiver's state transition. Mechanisms
that place a delivery inside the window where it is still accepted have
headroom; mechanisms that delay or reorder more messages into a restarted
receiver do not, and have now been falsified six times.

Price a probe by what it has to add, not by how small the counter looks. A
counter that reads a field already carried on the record is cheap; one that
needs a new field in `exec.rs`, `state.rs` or `path.rs`, per-run bookkeeping,
or a new config key is not, and should be priced at 4 or more. State in the
proposal which existing field the counter reads from. The channel-order probe
was priced at 2 and needed a send ordinal stamped on every message, a
thread-local high-water map, and a config key.

A mechanism must count its own firing. Per-candidate utilization capture can
only answer "did this fire" when the mechanism increments something, and a
null result from a mechanism with no counter cannot be told apart from a
mechanism that never ran. The six purgatory attempts were all diagnosable
because `purgatory.delayed_sends` exists; `stale-delivery-expedite` spent a
full sequential sample and returned a result nobody can interpret, because
it did not add one. Add a counter in `spur-core/src/simulator/util_stats.rs`
alongside the existing ones, and state in the hypothesis what value of it
would mean the mechanism fired as intended.

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
