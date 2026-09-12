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

### Decision: build both, at the user's direction

The moderated lane stopped for sign-off with two options: grade
exec-node-env-in-place alone, or combine it with plan-engine-dense-status
in one commit. The loop recommended alone, on the grounds that with no
counter ratio available a combined wall reading cannot attribute which
mechanism paid, and that the skill warns against fusing readings to beat a
floor. The judge recommended combining, on the arithmetic: neither honest
band clears the 0.05 cross-binary floor alone while their sum plausibly
does.

The user chose to combine. The concern stands on the record and the
combined entry carries it as a known limitation.

Frozen before any round was bought, as the combined-commit rule in the
plans requires: band [1.07, 1.21] on cross-binary runs per second, composed
from the component bands rather than reused from either. A true effect near
9 percent reads inside the band and can separate; a true effect near zero
reads below it and refutes, which is the band doing its job.

One band question was settled against the planning pass. It proposed
relaxing exec-node-env-in-place to [1.00, 1.10] because the instrument
cannot resolve a tighter band. The reasoning about the instrument is right
and the conclusion is not: a band containing 1.0 predicts nothing, and the
loop grades a prediction rather than rewriting it to be easier to pass. The
component band stayed at [1.05, 1.14] and the combined band was composed
from it.

The user also edited prompts/proposer.md and prompts/implementer.md during
this session, adding that a dependency is part of the subject and that a
dependency able to change any container's iteration or ordering declares
search-affecting. Those arrived after the proposer had run. No candidate in
this pool changes a dependency, so nothing here is affected, but the
proposal pass for this iteration ran without that rule.

### The combined candidate, graded and refuted

Session env-detach-plan-dense, six rounds, search-neutral, shared, primary
cross-binary, counter env_traffic.node_slot_copies, band [1.07, 1.21].

Primary 0.9733 over six rounds, per-round 0.9510, 0.9013, 1.0257, 1.0841,
0.9313, 0.9580, interval [0.9064, 1.0452], not dominant, not separated,
band reading below, verdict refuted. One blocker stood, the structural one:
the declared counter is absent from the unpatched baseline's dump, exactly
as predicted at admission.

Read the verdict precisely. This is not a demonstrated regression: the
interval includes 1 and the reading does not separate from the 0.05 floor.
It is a refuted prediction. The candidate said at least seven percent and
the reading is incompatible with that.

**What held, and it is worth as much as the refutation.** The
search-neutral declaration survived every spread check from round 3 to
round 6 - steps per run, all five end reasons, all five arm shares, none
outside the baseline's own spread. env_traffic.recv_node_slot_stores read 0
across the whole session, so the one disclosed behavior change never fired
and the two programs are observationally identical on this workload. The
neutrality of both mechanisms is now measured rather than argued, which is
what the third counter was added to do. Both mechanisms also demonstrably
fired: node_slot_copies at 200 per run, and status entries examined per
release at 0.004 against 13.0 plan nodes.

So the mechanisms work, are neutral, and do not pay.

**Why they do not pay.** A post-mortem profile of the candidate binary, at
research/perf/profiles/12b7582-cand-env-detach-plan-dense.md. Two profiles
of 60 seconds each are a ranking rather than a measurement and their totals
differ, so this is evidence and not proof.

- The plan engine's collect symbol, 1.75 percent, is gone. But exec_plan
  went from 1.85 to 3.23 percent and take_ready_events appears nowhere, so
  the work was inlined into the caller rather than removed. The net is a
  few tenths. A symbol disappearing is not the same as work disappearing,
  and the hypothesis was written against the symbol.
- EcoVec::make_unique moved only from 1.45 to 1.33 percent while its
  counter proves the detach fired 200 times per run. Local envs are
  EcoVec-backed too. The most likely reading is that the node env clone was
  never the dominant contributor to that line at all.

An earlier reading of this session, at three rounds, proposed that the new
counters' atomics were taxing the treatment - microseconds per run was then
dominant at 0.93 across all three rounds. The candidate profile shows no
atomic, lock or util_stats symbol above the reporter's cutoff, and by six
rounds microseconds per run was no longer dominant. That hypothesis is
withdrawn.

**The lesson this iteration actually bought.** A profile line names a
symbol, not a site. Both hypotheses were argued from percentages attached
to symbols, both were verified at judging against the source, and both were
still wrong about how much of that symbol belonged to the site they named.
The judge checked that the cited code exists and is on the hot path, which
it did correctly; nothing in the pipeline checks what fraction of a
symbol's cost comes from the caller the hypothesis blames. The counter
answered it after the fact - 200 detaches per run against a line that
barely moved - and that is an argument for a counter that attributes a
symbol to its callers being worth more than another candidate.

**Departure from the prescribed follow-up, with the reason.** Both plans
said a refuted combined verdict refutes neither component and the follow-up
is to split and re-grade. Both components are closed instead. The split
exists to protect a component whose individual effect a combined reading
might have masked; that protection is moot when the two together read
0.9733, since neither alone can then clear a 0.05 cross-binary floor.
Re-grading them individually would spend twelve rounds to confirm
arithmetic, and the post-mortem profile already attributes the shortfall to
each component separately, which is what the split would have bought.

**The combined-commit cost, as it actually landed.** The loop recommended
grading one candidate and the user chose to combine. The attribution
problem the loop flagged did materialize - a single wall reading cannot say
which mechanism paid - but the disjoint counter groups recovered the part
that mattered, and the post-mortem profile recovered the rest. The combined
form cost less than feared. What it did not do was rescue the effect size,
because the effect was not there to rescue in either component.

### Harness findings for the operator

Three, none of which this loop may fix itself.

1. **The implementer prompt's step 0 does not work.** `git submodule update
   --init spur` fails in a fresh worktree: the public remote refuses
   12b7582 with `upload-pack: not our ref`, leaving the clone on 10c2a0a.
   The loop branch's gitlink is not reachable from the remote. The
   implementer recovered by fetching the object from the main tree's local
   clone, which every future implementer will now have to rediscover. The
   prompt should name that fetch.

2. **`cargo test -p spur-core` does not pass out of the box on this host.**
   simulator::path::tests::a_held_request_is_recorded_at_the_step_it_is_issued
   aborts with a stack overflow in the debug profile, on unmodified
   sources; exec_plan's debug frame exceeds the 2 MB test thread default.
   It passes under RUST_MIN_STACK=67108864. Pre-existing and unrelated to
   any candidate, but it means an implementer cannot tell a real test
   failure from this one without knowing.

3. **`profile --binary <other>` mislabels and overwrites.** cmdProfile
   derives its label from the main tree's spur commit rather than from the
   binary it profiles, so profiling a candidate writes over the baseline
   profile for that commit. This session backed the baseline up first and
   restored it, and kept the candidate profile under an explicit name. An
   operator who did not think of that would silently lose the baseline
   profile the proposer reads.

## Iteration 3 - direction review, then the data layout lens

Preflight: spur-research-loop inactive, branch research/lite, gitlink
12b7582 unmoved, tree clean apart from the user's own edits to the skill
prompts, baseline binary built, profile for the current commit present. No
merge happened, so the tree has not moved and the profile was not retaken.

### Direction review

Triggered by a run of closes: four candidates raised, one closed at
judging, two closed after grading, one left in the pool judged down. Zero
merges, zero throughput gained.

**Are the costs still the largest ones I can explain?** Only partly, and
that is the review's main finding. The profile's largest single symbol,
schedule_runnable at 10.63 percent plus a second specialization at 1.12 and
two inlined collection closures at 2.01 and 1.21, has not been touched by
any candidate. Both graded candidates went instead for mid-sized lines - 1.45
and 1.75 percent - that were easy to name precisely. That is the wrong
end of the distribution to be working, and the steering allowed it: the
iteration 2 directive named the allocator-and-value-lifecycle aggregate and
the proposer reasonably picked the two cleanest sites inside it.

**Has the steering paid for itself?** The lens rotation and the
instrument-reality directive did their job: nothing ungradeable was
proposed, and two honest sub-floor bands were declared rather than
inflated. The attribution directive did not exist, and that is exactly
where both candidates failed. Added this round.

**Do the next directives pull back to mechanism level?** Yes, deliberately.
The iteration 3 directive adds a requirement that no previous round
carried: every hypothesis must state what fraction of its cited symbol it
claims and how that fraction is established rather than assumed, must say
how many other callers of that symbol exist, and must design its counter so
that a null wall reading still teaches where the cost actually is. It also
names the inlining trap explicitly, since removing a symbol is not removing
work and iteration 2 proved that on this tree.

**Pool pruning.** Nothing pruned that was not already closed by grading.
per-step-scratch-buffers stays at status proposed with the judge's
deflation recorded against it; it is not promoted, because the half of it
the judge did not dispute - the per-interpreted-call argument vector - is
better proposed fresh with an attribution argument than revived as-is.

**Verdict:** direction moves up the profile. The lens rotates to data
layout and representation on schedule. The standing instruction is to
attack the largest cost that can be explained AND attributed, with
attribution now a first-class requirement rather than an assumption.

### A lead established before proposing

Traced the profile's JSON formatting - serde_json::ser::format_escaped_str
1.26 percent and Value::write_to 1.16 percent - to the trace path.
Label::TraceEnter, TraceExit and TraceDispatch in core/exec.rs each call
trace_payload, which formats every evaluated parameter through
Value::write_to and builds a fresh String, stored eagerly in
TraceEntry.payload. The struct's own doc comment says the payload is
serialized when the entry is made. Entries accumulate in Logs.traces and
are drained by serialize_traces in explorer.rs.

TraceEntry.function_name is already an Arc<str> carrying a comment that a
row costs no copy, so this struct has been optimized once before. The
proposer was told to check what is already done before proposing it again.

A scope ruling was issued with the lead: removing trace output is out of
scope, because traces are a product the debug command and traceanalyzer
consume, and a candidate that disables tracing to win throughput changes
the workload rather than removing cost. Making the path cheaper while the
output stays byte-for-byte identical is in scope - doing per run what is
now done per event, for instance.

### The graded candidate: queue-eligibility-from-counters, no-gain

Six rounds, search-neutral, shared, primary cross-binary, counter
queue_scan.elements_skipped, band [1.04, 1.10].

Primary 0.9748, per-round 0.9726, 1.0429, 0.8514, 0.9718, 0.9544, 1.0710,
interval [0.8960, 1.0604], not dominant, not separated, band read inside,
verdict no-gain. One blocker stood, the structural counter-absent one.

The search-neutral declaration held on every observable at the round cap,
steps per run 1999.1 against 1992.6. The fast path fired on 100 percent of
steps. Exactness was verified rather than argued: the implementer ran a
debug build over 10,041,431 steps of the real workload with an assertion
comparing all three computed counts against an actual walk on every step,
and it never fired. That is the strongest correctness evidence any
candidate in this loop has carried.

**The durable result is the counter, not the clock.** elements_skipped over
fast_steps reads 8.57 elements per step on the graded workload, against
8.27 and 8.15 on release smokes and 7.43 on an 8-thread debug run. The
average total queue length a scheduling step holds is about 8.5 runnables.

The proposer froze the interpretation of that number before it was
measured: near 5 closes the queue-walk family, near 40 says the traffic is
real. At 8.5 the family closes. pending-deliveries-dense,
runnable-thin-queue and the scheduler half of per-step-scratch-buffers are
all closed on this arithmetic rather than on six rounds of clock each. That
is the design goal of the iteration met: a null wall reading that still
decided three other hypotheses.

**A claim of mine that did not survive.** Rounds 4 to 6 were bought on the
stated argument that a tighter interval would convert the arithmetic into a
measured upper bound on the effect. It did not: the interval only came in
from [0.7372, 1.2301] to [0.8960, 1.0604], which bounds the effect at about
plus six percent and is useless for the purpose. The instrument cannot
supply that bound at this wall budget. The arithmetic is the stronger
evidence and the extra rounds did not add to it.

### Two harness findings about the instrument itself

**1. The neutrality spread check is meaningless at low round counts, and
looks alarming rather than silent.** Round 1 of this session flagged eight
observables outside the baseline's spread - steps per run, four end
reasons, three arm shares. Round 2 flagged two. Round 3 onward flagged
none. Nothing about the candidate changed. The check compares against the
baseline's own round-to-round spread, which is near zero when few rounds
are in hand, so the allowance is tiny and almost everything reads outside
it. The same pattern appeared in iteration 2. An operator reading a one- or
two-round status would conclude the search had moved when it had not. The
check should not be reported, or should be reported as unavailable, below
some round count.

**2. `dominant` gets harder to satisfy as rounds are bought, so buying
evidence can destroy a separation.** separates() requires
`xs.every(x => x > 1) || xs.every(x => x < 1)`. With per-round noise this
probability falls as the round count rises. At the measured baseline spread
of 0.0476 and a true effect of plus six percent, the chance that all rounds
land above 1 is about 0.71 at three rounds and about 0.51 at six. The
estimate improves while the criterion gets stricter, and a real effect can
separate at three rounds and then fail at six.

This also means the skill's rule of thumb - buy another round while it
could change your decision - is actively harmful under this criterion once
a session has gone mixed, because a mixed session can never recover
dominance: once two rounds straddle 1, no further round can make every
round fall on one side. This session went mixed at round 2, at which point
a gain verdict was already unreachable and the remaining four rounds could
only choose between no-gain and refuted. The loop bought them anyway, for a
bound that did not materialise.

Both of these are grader design questions and therefore operator work
rather than hypotheses. Filed, not acted on.

### Direction after three iterations

Three iterations, five candidates graded or closed at judging, zero merges,
zero throughput gained. What has been learned is real but it is all
negative space: novelty is off on this workload, the node env clone is not
where make_unique's cost is, the plan engine's table scan inlines rather
than disappears, and the scheduler's queues hold 8.5 elements so walking
them is not the cost either.

The honest summary is that the profile's large symbols are large because
the work is spread thin across many small contributors, not because any one
site dominates. Four of the five largest lines have now been probed and
none of them yielded a nameable five percent. That is itself a finding
about this codebase: it has been optimised before - Value is 40 bytes,
function_name is an Arc, WaitingReader is an Arc, the trace scratch is
thread-local - and the remaining cost may not have a five percent lever in
it at all.

If that is right, the goal as stated is reachable only by a change larger
than any single hypothesis so far, or not at all at this floor. The
instrument compounds it: with a baseline spread of 0.0476 and a dominance
criterion, nothing under about ten percent is reliably readable. The next
direction review should put that question to the user directly rather than
spend further iterations discovering it one candidate at a time.

## Iteration 4 - structural scope, authorized by the user

The direction question raised at the end of iteration 3 was put to the user:
three iterations, five candidates, zero merges, four of the five largest
profile lines probed without a nameable five percent, and an instrument
that cannot reliably resolve under about ten percent. The options offered
were a longer campaign wall to cut per-round variance, a revisit of the
dominance criterion, or accepting that the remaining wins are structural
rather than local.

The user chose the third and authorized structural changes.

That resolves the instrument tension rather than dodging it. A structural
change worth ten percent or more is exactly what this instrument CAN read,
so no harness change is needed if the hypotheses are large enough. The
practical consequence for steering is a raised floor on ambition: a
mechanism plausibly worth under ten percent is not worth a round this
epoch, and the proposer is told so directly.

### The reframe iteration 3's counter makes available

The queues hold about 8.5 runnables per step. schedule_runnable carries
10.63 percent self time plus 1.12 for its replay specialization, over
roughly 2000 steps per run. With queues that short, the per-element work
cannot account for it: most of that 11.75 percent is per-step FIXED cost,
paid once per scheduling decision regardless of how many candidates there
are.

Put in absolute terms, at the measured 2285 runs per second and 2000 steps
per run the session executes about 4.6 million steps per second across 30
threads, so 11.75 percent of thirty cores is on the order of 700 nanoseconds
of scheduler overhead per decision. That is a large number for choosing one
runnable out of eight, and it is the first time this loop has had the two
measurements needed to state it.

What is paid per step, from the config and the banked counters: the timer
context path on 90 percent of steps, the crash anchor probe, the multiplier
authority audit on the 43 percent of steps that are contested, the recovery
placebo walk, the steer preference consulted three times per step, the
feedback bias scoring per candidate, the QueueInfo build and the selection
itself. Several of those are emit_ flags in the campaign template -
observation for the search loop rather than scheduling.

That yields the structural question for this iteration: how much of the
scheduler's per-step cost is observation rather than decision, and can the
observation be made cheap without changing what is observed? Making it
cheaper is in scope; removing what it reports is not, for the same reason
the trace-output ruling stood in iteration 3.

### A diagnostic the loop has never run

Both graded candidates failed on attribution, and the flat profile is why:
it ranks symbols by self time and says nothing about callers. recordProfile
in the grader states this deliberately - "No call graph is recorded: the
report is ranked by self time, so collected stacks would be written and
discarded."

So this iteration records a call-graph profile as an operator diagnostic,
outside the grader and without editing it, to answer the questions the flat
profile structurally cannot: which callers produce EcoVec::make_unique,
what the inclusive cost of the scheduler's per-step observation machinery
is, and where the interpreter's time actually goes. Run at 8 threads rather
than 30 so the DWARF unwinding stays affordable; caller shares are the
quantity wanted and they are stable across thread count, while contention
effects are not and will not be read from it.

### The instrumented baseline: sizing a mechanism before grading it

A second binary was built this iteration alongside the candidate: the same
counters, with no mechanism change. It is run outside the grader as an
operator diagnostic. This answers the structural blocker every previous
iteration hit - a counter a candidate introduces reads NaN on the unpatched
baseline, so no candidate has ever been able to state the size of what it
was about to remove.

Baseline, 8 threads, 40s campaign, 36,416 runs:

| counter | per run |
|---|---|
| frame.calls | 2,856 |
| frame.slots_built | 47,856 |
| frame.entry_frame_copies | 1,197 |
| slots per call | 16.76 |

**What part (b) is actually worth, in bytes.** 1,197 entry-frame copy-on-write
faults per run, each copying about 16.76 slots at 40 bytes, is roughly 800 KB
per run of memmove, plus 1,197 malloc and free pairs, plus of the order of
20,000 Value clone refcount operations and the matching drop decrements. At
the graded 2,100 runs per second that is about 1.7 GB/s of cold copy traffic
and 2.5 million malloc/free pairs per second.

Set against iteration 2's exec-node-env-in-place, which the judge identified
as the same kind of mechanism aimed at the wrong buffer: that one fired about
200 times per run over a 21-slot array, roughly 168 KB per run. Part (b) is
about five times larger in bytes and six times more frequent. The judge's
read that this is the corrected re-aim of that candidate is confirmed by
measurement rather than by argument.

**What part (a) is worth.** 47,856 slots built per run at 40 bytes is about
1.9 MB per run of frame slot writes, of which the redundant second write to
every non-parameter slot is what part (a) removes. That is a larger number of
bytes than part (b), but it lands on lines that Env::with_slots dirtied
microseconds earlier and are still in L1, which is exactly why the judge
weighted it as instruction removal rather than byte removal.

**A prediction that landed outside its range.** The proposer predicted slots
per call between 20 and 120. The measurement is 16.76, just below the range.
Not a falsifier - the falsifiers are the wall reading and entry_frame_copies -
but recorded as a miss.

**H2 is now closable by arithmetic, before it is ever built.** cfg-temp-slot-reuse
froze a falsifier that frame.slots_built must fall by at least 2.5x. At an
average of 16.76 slots per call, reducing a frame to its maximum live depth
plausibly reaches 8 to 10 slots, a factor near 1.7. The mechanism cannot
reach its own declared falsifier on this workload. This is the counter doing
the job it was designed for, and it is the second time in three iterations
that a candidate's own counter has closed a different candidate without a
round being bought. The judge predicted exactly this outcome when it argued
against fusing H1 and H2.

The candidate binary was not finished before the session ended; the
implementer has been resumed with its worktree intact.

### The candidate, graded and merged on operator judgment

Session call-frame-one-pass, six rounds, search-neutral, shared, primary
cross-binary, counter frame.entry_frame_copies, band [1.08, 1.20].

Per-round 1.0490, 1.0320, 1.0980, 1.1373, 0.9454, 1.1317. Mean 1.0634,
microseconds per run 1.0525, interval [0.9884, 1.1442], dominant false,
separated false, band read inside, verdict no-gain. Five of six rounds above
one. The search-neutral declaration held on every observable at the cap, and
frame.entry_frame_copies read 1281 per run on the instrumented baseline
against 0 on the candidate.

**At round 4 this session read separated true, lo 1.0051, verdict gain.**
Round 5 at 0.9454 destroyed dominance and the verdict with it. This is the
criterion flaw recorded after iteration 3 - that dominance grows harder to
satisfy as rounds are bought - demonstrated on a live candidate rather than
argued from a probability. Buying evidence revoked a verdict that the
evidence had already earned, and the revocation is permanent: once a session
has gone mixed no further round can restore dominance, so no number of
additional rounds could have recovered the gain.

**Decision: merged, departing from the no-gain advice, at the user's
direction after the split evidence was filed.** The written reason, which
the rule requires in either direction:

- The effect is real by every instrument the loop has. Five of six rounds
  positive, mean plus 6.3 percent, microseconds per run plus 5.25 percent.
- The mechanism is verified by measurement rather than by inference. An
  instrumented baseline built alongside the candidate puts the removed cost
  at 1281 entry-frame copies per run, roughly 800 KB of memmove, 1200
  malloc and free pairs and 20,000 refcount operations per run. The
  candidate reads 0.
- Neutrality is verified three ways: the grader's spread check clean on
  every observable at the cap, a deterministic single-configuration run of
  both binaries producing byte-identical session output apart from wall
  clock fields, and the compiler confirming that record and runnable
  equality are unused.
- The criterion that blocked it was identified as defective before it fired
  here, and its failure mode is exactly what happened.
- The reading is also the first confirmation of the bandwidth model this
  iteration produced: every earlier candidate removed instructions and read
  at or below one; this one removes bytes and reads above it.

What argues against, recorded honestly: the interval includes one, by a
hair, so the grader cannot certify the effect at its own confidence. The
merge is a judgment that the mechanism evidence and the round-4 separation
outweigh a criterion known to be broken, not a claim that the primary
separated.
