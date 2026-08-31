# Research Goal

Surface the VR-Revisited view-change/recovery bug (`research/oracle/bug.md`)
through a **general** scheduler configuration - no bug-specific plan, no
VR-specific heuristics - by improving the Spur simulator's exploration
(`spur/spur-core/src/simulator/`) and the general configs
(`scheduler_configs/loop/`).

Success = porcupine reports a linearizability violation on `bin/spur/VR.spur`
under a general config, reproducibly.

## Core ideas

**Violations are ground truth; everything else is a proxy.** Progress proxies
form a ladder - throughput, generic hazard rates (crash with sends in flight,
stale-incarnation delivery), prefix depth against the oracle DAG, violations.
Proxies steer sampling; they never declare victory. Depth has already
decoupled once: general-config runs at the deepest rung were all linearizable.
Operationally, graders separate candidates on depth>=6 events per
explore-second - per-run probability times runs per second - so throughput
multiplies every rung.

**It is a probability problem, not a reachability problem.** Plans only gate
which events may be released; they create no states free exploration cannot
reach. The job is raising the probability of rare interleavings with better
heuristics. A long run of zero violations is not evidence the target is out of
reach; never propose work that only makes sense if it were.

**The generality test.** Deriving heuristics by studying violating runs is
encouraged; hard-coding the protocol is not. State the rule without naming any
handler, message, or role from the protocol under test - if it cannot be
stated that way, it is overfitting. Scheduler code and general configs never
mention VR handler names or the "timeout" timer label.

**The panel is the yardstick, not one bug.** A change must not harm
exploration of the other protocols: known bugs stay findable, clean specs stay
clean, throughput does not regress (the regression suite carries the exact
tolerances). Different bug types need different search shapes, so the aim is a
portfolio of general heuristics the explorer can interchange between -
improving individual heuristics and improving the ability to switch among them
are both progress.

**Prefer mechanisms that need no configuration.** A mechanism that works
through the steer, scoring what the explorer is already choosing between,
carries its heuristic without adding a knob whose right value nobody can
derive. A new config field is the fallback, not the design.

**A mechanism must count its own firing.** Add a counter in
`spur-core/src/simulator/util_stats.rs` and state what value of it means the
mechanism fired as intended; a null result from an uncounted mechanism cannot
be told apart from one that never ran.

## Boundaries

Protected, never edited by research iterations: `bin/spur/**` (protocol
specs), `porcupine/**` (ground truth), `research/oracle/**`,
`research/corpus/**` (calibration), `scheduler_configs/**` outside `loop/`.
The measurement harness is not the subject: changing the graders or the loop
machinery is operator work, not a hypothesis.
