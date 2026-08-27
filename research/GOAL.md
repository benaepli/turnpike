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

Where the ladder actually stands (epoch 3, measured over 216,000 general runs
at the current merged config): P(depth>=4) 0.367, P(depth>=5) 0.112,
P(depth>=6) 0.0165. The deeper rungs are quoted only as counts, because a rate
over a handful of events is not a measurement: depth>=7 runs about 45 per
54,000 and depth>=8 about 2. The payoff is in the conditional
P(rung k+1 | rung k) for k >= 5; the attrition from depth>=5 to depth>=6 is the
steepest step on the ladder.

P(depth>=5) moved from 0.086 to 0.112 when client work was guaranteed to
outlast a fault (`client-work-after-every-fault`), which is the largest single
move in the record and replicated across two independent 216,000-run baselines.
The measurement that produced it is worth more than the mechanism: in four
two-crash runs out of five, every write was invoked before the first crash, so
the chain's second write had nothing left to match. Four falsified families had
been optimising the segment downstream of a step that was starved. Depth is a proxy, not
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

Measured noise floor (null diff, identical explorer, 108,000 runs against the
216,000-run baseline): depth>=4 +0.07%, depth>=5 -1.44%, depth>=6 -7.50%,
h2 -0.36%, all relative. Nothing in the binary changed. depth>=6 is the rung
usually called the frontier and it moves 7.5% on its own, more than Poisson
counting noise on ~1,400 events would give, so session-level variance is real.
A pre-registered falsifier below these numbers cannot fire on evidence, only
on luck. Write thresholds above the floor for the rung being claimed, and
prefer depth>=4 when a small effect is expected, since it is the only rung
stable to a tenth of a percent.

Biased deliveries act on their receiver 13.8% of the time against 40.9% for
deliveries generally. The perturbations the scheduler injects land
disproportionately on messages that change nothing. Two readings fit that
number and they imply opposite work: the scheduler may be selecting
deliveries that were already inert, in which case targeting is a live lever;
or the act of delaying a message may be what makes it inert, in which case
the delay family is self-defeating and no targeting rescues it. Six
falsifications in that family are consistent with either.

The counters cannot separate them, because both compare biased deliveries
against a population that was never biased. The measurement that does is the
acted fraction of deliveries that were eligible for bias and not selected:
same population, same selection pressure, no perturbation applied. Any
hypothesis proposing better targeting of perturbations should establish that
number first, or it is arguing from a comparison that cannot support it.

The timeline coverage key saturates, and de-saturating it does not help.
Both halves are measured, and the second is the useful one.

Saturation, over 1,080-run sessions: the key reaches 1,783 distinct values
with a saturation index of 200-300, so nearly everything the key can
distinguish has been seen within a few hundred runs. Over the same session
the steer evaluated 2.2M candidate picks and changed its choice 0.098% of the
time. A saturated key makes novelty flat across candidates, so
feedback-driven selection degenerates to random.

The obvious remedy was tried immediately and failed.
timer-vs-delivery-coverage-axis added a timer-versus-delivery ordering bit to
the key and did exactly what it set out to do: distinct keys rose to 4,599,
2.6x, and the saturation index moved from 200-300 out to 700. Depth did not
respond. The sequential rejected it after 108,000 runs with no frontier rung
separable, depth>=4 ratio 0.999, and steer divergence fell rather than rose.
Making the scheduler able to tell more states apart did not make it reach
deeper ones.

So coverage-key resolution is not the bottleneck, and neither is
perturbation volume, delivery ordering, or receiver-side holding. Four
distinct families have now been falsified against depth. A hypothesis in any
of them needs an argument for why it differs from the one already tried, not
just a new axis or a new knob.

The bug is reachable without a plan. A plan only gates which events may be
released at each point; it does not create states that free exploration
cannot reach. The plan-driven corpora find the bug, so an unconstrained run
would find it too given enough luck. This is a probability problem, not a
reachability problem, and the whole job is raising the probability of the
rare interleaving with better heuristics. Do not conclude from a long run of
zero violations that the target is out of reach, and do not propose work that
only makes sense if it were.

Deriving a heuristic by studying runs that did hit the bug is legitimate and
encouraged. What matters is the shape of the justification. "Crashes should
land close to their recoveries" is a general statement about schedules that
any protocol could be tested against, and it is fair game. "This particular
handler should be scheduled sooner" is not: it hard-codes one protocol's
event into the search and teaches the explorer the answer instead of how to
look. The test to apply to your own proposal: state the rule without naming
any handler, message or role from the protocol under test. If it cannot be
stated that way, it is overfitting.

Prefer heuristics that need no configuration. A mechanism that works through
the steer, by scoring what the explorer is already choosing between, carries
its heuristic without adding surface that every later hypothesis must reason
around, and without a knob whose right value nobody can derive. A new config
field is the fallback, not the design, and the evidence for adding one has to
include why the same effect cannot be scored instead. This is also why the
steer's own weakness matters: it diverges from the default pick in about 0.1%
of evaluations, so the vehicle intended to carry heuristics is barely
steering. Making it actually steer is worth more than any single mechanism
riding on it.

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
