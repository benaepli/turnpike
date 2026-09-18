# Proposal lenses

Give the proposer one lens per round, rotating through the list.

1. fault-injection literature: crash timing anchored to protocol activity (sends, deliveries, quorum events); recovery timing races
2. message-delay and reordering: purgatory policies, orphaned in-flight messages, delivery of pre-crash messages after recovery
3. feedback/novelty: what coverage signal would make the scheduler chase crash-recovery message races; incarnation-awareness
4. ablation and salvage: mechanisms with zero utilization, dead or miswired knobs, unexercised code paths - remove, fix, or enable them
5. scheduling theory: PCT priority change points, partial-order methods, queue-policy shapes that concentrate schedules near fault windows
6. profile-guided performance (kind: perf): read the explorer profile section below; propose reductions of a named hotspot that raise runs/sec without changing scheduling semantics or instrumentation the grader needs. Without a profile, propose nothing through this lens.
7. arm composition (kind: arm): edit only the campaign block of the evaluation template - add, drop or re-overlay a generic arm (a grid overlay on an existing config field, a curriculum or an aos arm) so that rung events per second rise for the campaign as a whole; each arm keeps its own feedback state, so an arm is a search, not a knob; never name a protocol handler, message or role
8. premise check: is the current config/workload even capable of reaching the goal? The bug lives at a depth the general config may never supply enough events to reach. Propose config or plan-generation experiments (more client operations, more concurrent crashes, longer or richer plans, curriculum changes) and structural diagnostics that test whether the ceiling is a scheduler problem or an event-supply/config limit - not another scheduler knob. A single such experiment that reframes the search is worth more than ten mechanism tweaks against a hard cap.
