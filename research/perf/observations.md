# Observations

## Iteration 1 - preflight findings, no candidate graded

Branch research/lite, spur gitlink 12b7582, tree clean, selftest zero
failures, profile written to research/perf/profiles/12b7582.md. The pool,
the decision log and the baseline cache were all empty: this is the loop's
first iteration.

No rounds were bought. Three properties of the harness were established
first, and each one blocks a path the goal file designates.

### The identity tier's equality check cannot pass

The layout control's identity check failed on two builds of identical
source, 5 of 200 runs differing. Rather than read that as a layout effect,
the baseline binary was checked against itself: it also differs, 2 of 200
runs. Only the variant column moves. arm, config_index, steps_used,
end_reason, timers_fired, timers_acted and max_inert_streak are
reproducible, so the executions are deterministic and the tag on them is
not.

The bits that flip are the adaptive, cross-thread ones: armSelectorAxis,
armSelectorConcentrated, ghostAbsorberRetarget, pairSendOrder,
freshFirstPair, clientRushPriority, clientFanoutRelease. Run 130 is flaky
in both comparisons. At 30 threads these bits are set from state that
depends on inter-thread timing rather than on the run id and the session
seed.

IDENTITY_COLUMNS at research/perf/grader.ts:1126 includes variant and has
no scoping flag, so identical: true is unreachable for any candidate,
including a null one. An identity-declared candidate fails its own declared
tier for a reason unrelated to it, and the decision rule closes such a
candidate. The identity tier is unusable until the check either drops
variant or the tagging is made reproducible.

Evidence: research/perf/state/layout-control-e1.identity.json.

### A shared saving's counter cannot be read on its first session

The goal file makes a per-run counter the primary instrument for a shared
saving and says the counter usually does not exist yet, so the change adds
it. The grader requires the opposite. counterReading at grader.ts:696-701
reads m.counters[name] on both sides of every round and sets
presentOnBothSides only when every value is finite; the baseline side is
the unpatched main tree, where a counter the candidate introduces does not
exist. The reading is then NaN, the primary produces no ratio, and the
verdict is no-reading rather than a blocker an operator could depart from
with a written reason.

So a shared saving that names a new counter cannot be graded at all on the
session that introduces it. This is the binding one: the profile's largest
explainable aggregate is allocation and memory traffic, whose cost travels
between runs, and the goal file correctly calls that shared.

### A private saving has no treatment bit available

The within-binary contrast needs a bit registered in VARIANT_BITS, which
lives in research/orchestrator/src/decide.ts - a path this loop must never
edit. All 31 registered bits are named for search-loop semantics, and the
ten with no tag in run_variant.rs are names the search loop retired rather
than free slots. A private candidate therefore has no way to admit a bit
without operator help.

### The loop's files moved mid-session

grader.ts, perf.json, PERF_GOAL.md and docs/agent/perf-grader-status.md
were rewritten while this iteration ran. The loop now measures one workload
rather than two: WORKLOADS is ["campaign"], benchTemplate became
identityTemplate, and the bench budgets became identity budgets. The
campaign template carries "stats": true, so counters are readable there;
the earlier concern that the counter workload had no stats gate is void.

Session layout-control-e1 was started under the previous schema and is
stale; its identity record remains as evidence. The control build of
12b7582 stands at tmp/loop/perf/layout-control and the cross-binary layout
floor is still unmeasured, so no cross-binary reading is currently
defensible.
