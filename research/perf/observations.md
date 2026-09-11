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

## Iteration 2 - layout floor measured, four candidates scored, one refuted at judging

Branch research/lite, spur gitlink 12b7582, tree clean apart from the
untracked profile iteration 1 wrote. Baseline rebuilt, selftest zero
failures, profile present for the current commit. Moderated lane at the
user's direction: the loop proposes, the user signs off before anything is
built.

### Two of iteration 1's three blockers still stand; one is void

The grader was rewritten between the iterations, so all three were
rechecked rather than inherited.

The identity tier is **void**: that tier and IDENTITY_COLUMNS are gone from
the current grader, so the unreachable equality check no longer exists.

The counter blocker **stands**. counterReading (grader.ts:668-684) reads
m.counters[name] on both sides and sets presentOnBothSides only when every
value is finite. The baseline side is the unpatched main-tree binary, which
does not emit a counter the candidate introduces, so the reading is NaN and
the primary produces no ratio. A counter a change adds is mechanism-fired
evidence on the candidate side, never this session's primary.

The treatment-bit blocker **stands**, now verified rather than asserted.
VARIANT_BITS (research/orchestrator/src/decide.ts:42-74) names all 31 slots
2^0 through 2^30. There is no free slot, the ten entries with no tag in
run_variant.rs are search-loop names rather than spare capacity, and that
file is off-limits to this loop. No private candidate can be switched per
run.

Net: cross-binary runs per second is the only live instrument this epoch,
whatever the sharing declaration says.

### The layout floor, measured

Session layout-control-e2, six rounds, the second build of 12b7582 at
tmp/loop/perf/layout-control against the main-tree build, declared
search-neutral, sharing private, primary cross-binary.

Per-round ratios 1.0463, 0.9855, 0.9577, 0.9661, 0.9948, 1.0008. Mean
0.9915, log sd 0.0313, interval [0.9594, 1.0246], dominant false,
separated false, verdict no-gain, zero blockers. It printed a floor and not
a gain, which is the outcome the skill requires before any cross-binary
reading is defensible. The configured layoutFloor of 0.05 is consistent
with it: the observed departure from 1 is 0.0085 against a half-width of
about 0.033.

The baseline cache for this identity now holds six rounds at 2342.6 runs
per second with a round-to-round spread of 0.0245. The cache was empty
before this session; it is the shared asset every later candidate reads
against, so the six rounds are not spent, they are banked.

**What the floor implies for admission.** separates() (grader.ts:504-506)
requires all three of |mean - 1| >= 0.05, the t-interval excluding 1, and
dominant - every single round's ratio on the same side of 1. Dominance is
the binding constraint at these round bounds, not the interval: with a
per-round spread near 3 to 4.5 percent, a true 5 percent effect is
dominant over six rounds perhaps two times in five, a 10 percent effect
about nine times in ten. A candidate worth less than 5 percent is not
gradeable alone this epoch, and one worth 5 to 7 percent is gradeable only
with luck.

### Four candidates, one refuted before a round was bought

Lens: allocation and memory traffic. The proposer verified the ground
first and reported that Value is already 40 bytes with Map/List/Tuple
behind imbl/EcoVec handles (values.rs:1043-1047), so the boxing and
shrinking ideas are already done and were not proposed.

- **exec-node-env-in-place**, gain 7 cost 2. Stop cloning the whole node
  slot array per executed segment at exec.rs:564. The judge verified the
  load-bearing aliasing argument as true: push_waiting_reader has exactly
  one call site, so the node re-read at exec.rs:656 is provably
  record.node. It also verified that the writes field must be preserved by
  detach() because it feeds node_state_token, stale_late and the acted
  flag, all search-visible.
- **plan-engine-dense-status**, gain 5 cost 2. A dense Vec for the plan
  engine's status table. Release order verified unchanged by construction.
  Declared band [1.02, 1.06], below the floor, and said so.
- **per-step-scratch-buffers**, gain 4 cost 2. Judged down: two of the four
  claimed per-step allocations do not fire on this config, and the pool's
  closed global-allocator-swap entry already records that allocator
  servicing is not the lever here - the bytes moved are.
- **step-novelty-memo**, gain 1 cost 0, **closed before implementation**.
  The proposer ranked it first and built it on 20 to 35 novelty
  evaluations per step, each a fan of SipHash probes. The judge found that
  general_vr.json sets feedback.novelty_enabled false, that
  FeedbackConfig::key_granularity (feedback.rs:184-190) folds that to
  Constant, and that timeline_steer_bias (feedback.rs:345-349) returns 1.0
  before any probe. Verified independently against the config and the
  source. The named cost does not exist on the graded workload, and the
  most likely effect of implementing the memo is a small slowdown. A
  refuted premise caught at judging, before a round was bought, is the
  cheapest possible place to catch it.

The judge's verification of a checkable premise against the config, rather
than against the profile alone, is what closed the top-ranked candidate.
Worth keeping: a profile ranks symbols, but it cannot say which branch
inside them the graded config takes.

### Operator error, recorded

The loop reported the hypothesis pool as empty at preflight and told the
proposer so. It was not: pool.md carries the closed global-allocator-swap
entry. The judge read the file itself and used that entry against
per-step-scratch-buffers, so the scoring was unaffected, and the proposer
independently avoided the closed idea. No result turns on it.
