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

## Iteration 5 - new epoch, direction review, contention lens, paused before implementation

Preflight: spur-research-loop inactive, no grader measuring, branch
research/lite, spur gitlink 292c15b, tree clean, baseline binary current,
selftest zero failures, call-graph profile present for 292c15b. The user
asked for this session to run as moderated: stop for sign-off before
anything is implemented.

### What changed since iteration 4

Two things move the ground under every earlier reading. The call-frame-one-pass
merge moved the tree. Commit 66d0979 moved the toolchain: frame pointers are
forced for every build run from the project root, the baseline cache
identity now hashes the applicable cargo config, separation reads the
interval alone without dominance, and the grader's profile records
frame-pointer call graphs with an inclusive section. The earlier layout
floor was measured under different build flags, so a new layout control is
due before the first candidate of this epoch. Its second build of 292c15b
is at tmp/loop/perf/layout-control-e3 and its session layout-control-e3 is
registered with no rounds bought; the rounds are held while subagents read
the tree, since a grep-heavy neighbour reads several percent on the clock.

### Direction review

Triggered by the merge, the profile changing shape, and the new epoch.

**Are the costs being attacked still the largest ones explainable?** The
inclusive profile answers what iteration 3 could only argue. schedule_runnable
is about 75 percent inclusive across its three RNG specializations and exec,
the interpreter, about 43. Roughly 30 percent of wall is therefore the
scheduler's decision and observation work outside interpretation, the
largest block on the profile and the one iteration 4 named as the structural
question. Next, serialization and the writer path near 10 percent, then a
per-run Program clone at 1.65 and SipHash near 3.3.

**Has the steering paid for itself?** The attribution requirement added in
iteration 3 produced the loop's only merge, and it was sharpened again here:
every hypothesis must use the inclusive section, state its fraction of a
symbol and the symbol's other callers. The ambition floor from iteration 4
held: the proposer declared sub-floor bands honestly and named what they
compose with.

**Do the next directives pull back to mechanism level?** Lens on rotation,
contention and parallelism, with a focus directive at the scheduler's
per-step cost and the serialization path, and the scope ruling that trace,
history and emit_ output stay identical in content.

### Proposals and judging

Four hypotheses; the proposer also recorded what it checked and set aside:
allowed_timers lookups are off the graded path (strict_timers false), the
timer_context learner atomics are read mid-run and must stay global, and
moving serialization onto the writer threads frees no core on 32 hardware
threads running 30 workers and 4 writers.

- thread-local-stats-blocks, gain 7 cost 0. At least 14 unconditional
  lock-prefixed fetch_add writes per step to the same global counters from
  all 30 threads; true sharing rather than false sharing. Verified at
  judging: the writes, the flags, no release-build mid-run reader. One
  debug_assert reads SA_STEPS_TOTAL mid-run and fixes the fold point. The
  judge's red-team used audit_multiplier_authority as a control - same call
  rate, about 1.4 writes, 1.13 inclusive - and put one contended write near
  0.3 to 0.8 points, which cuts the proposed walk_recovery_placebo
  attribution from 2.9 to 0.6-1.6 points and the band from [1.08, 1.25] to
  [1.05, 1.20]. The total still follows from 16 to 20 writes per step.
- exec-plan-borrows-program, gain 6 cost 0, band [1.015, 1.04].
- fx-hashed-call-and-timeline-lookups, gain 6 cost 0 after rewrite (the
  exec.rs parts removed), band [1.03, 1.07].
- serialize-history-inline, gain 4 cost 2: payload_json is the column
  porcupine parses, and the steal-traffic half of the claim is unsupported.

Top by net: thread-local-stats-blocks, admitted as awaiting-approval with a
plan. The other three are kept as a possible composite, band [1.06, 1.17],
cost 2 with serialize-history-inline in it; without it the two survivors
compose to 1.045 at the low edge, under the floor.

### Approval

The user approved thread-local-stats-blocks as planned, fold pattern, over
the shard variant, the composite and holding. Both declarations froze at
approval: search-neutral, shared, band [1.05, 1.20] on cross-binary runs
per second, counter stats_local.folded_increments. The implementer is held
until layout-control-e3 finishes, since a compile or a tree-reading
subagent beside it would inflate the floor it exists to measure.

### The layout floor, re-measured under frame pointers

Session layout-control-e3, six rounds, a second build of 292c15b at
tmp/loop/perf/layout-control-e3 against the main-tree build, both under
the frame-pointer toolchain, declared search-neutral, private, primary
cross-binary.

Per-round 1.0588, 0.9259, 0.9684, 0.9960, 0.9871, 0.9814. Mean 0.9855,
sd 0.0435, interval [0.9415, 1.0316], not separated, verdict no-gain, zero
blockers, every neutrality row inside the baseline's spread. It printed a
floor and not a gain. The interval's half-width of about 0.045 sits just
under the configured layoutFloor of 0.05, so the floor stands and nothing
in perf.json changes; it has no spare margin, and a gain read against it
this epoch owes a lower edge clearly above it.

The baseline cache for the new identity (43b3adf4fd88, cargo config hash
b813e711) now holds six rounds at 2569.6 runs per second with a
round-to-round spread of 0.0341. Against the 2491.6 recorded after the
call-frame-one-pass merge under the old flags, this is not a reading of
what frame pointers cost: the two caches were measured under different
identities on different days, and the difference sits inside the spread.

### The implementation, and a session that ended under it

The implementer's first session ended before its test run and export
finished. It was resumed with its worktree and transcript intact; nothing
was lost, and the binary it exported was built after its last source edit.

The diff was read against the plan before any round was bought, and matches
it: a `bump` helper that writes the running thread's block while a run is
active and the session counter otherwise; 35 scalar pairs plus the delivery,
acceptance-distance, flip and streak arrays enumerated in one
`for_each_slot`; the fold as the first statement of `record_run_termination`
after its enabled check and before the debug_assert; `begin_run` and
`snapshot` folding as backstops; a generation counter advanced by
`set_enabled` so a block left from an earlier session is dropped rather
than folded; the timer effect table kept per thread with the same cap rule
and merged under one lock per run. TERMINATION, the timer_context learner
atomics and every once-per-run record stay global. Two files in spur-core,
no superproject change: super.patch carries only the gitlink.

Checks, all before grading:

- `cargo test -p spur-core` under RUST_MIN_STACK: 26 test binaries, all
  passing, including 451 library tests and the export completeness test
  extended for the new section.
- A 20-second release smoke on the graded config with the wall budget
  lowered in a copy: stats_local.folds 38,160 over 38,160 runs, exactly one
  per run; folded_increments 2,000,105,320, about 52,400 per run, inside the
  predicted 25,000 to 55,000 and near its top.
- The same smoke with the baseline binary: flattened utilization key sets
  equal apart from the two stats_local keys; timer_effects.by_key 24 keys on
  both, far from the 4096 cap, so the disclosed admission-order edge cannot
  fire on this workload.

52,400 writes per run is the size of the traffic this change takes off the
shared counters, measured before the clock is read. At the baseline's 2,570
runs per second that is about 135 million lock-prefixed increments per
second to a few dozen shared cache lines, across 30 threads.

Session thread-local-stats-blocks started with the frozen declarations and
the plan's neutral argument, against the six-round baseline cache for this
identity.

Deviations the implementer reported, none touching the frozen prediction:
writes to the per-thread timer effect map are not counted in
folded_increments, so the counter slightly undercounts the traffic moved; a
stale block dropped at a session reset adds to neither new counter; the
recovery placebo's flag loop became four conditionals. The debug-build
smoke was skipped on a stated reason that holds: tests/steer_authority_wiring.rs
runs a real explorer session in the debug test build with steer_audit on,
which reaches the moved debug_assert, and it passed.

### Three rounds: a large gain, and the neutral declaration flagged

After round 3 the primary reads 1.3217, per-round 1.3884, 1.2826, 1.2965,
interval [1.1878, 1.4706], separated, above the frozen band's lower edge
and its interval overlapping the band's top. Microseconds per run 1.5243.
Candidate 3,239, 3,151 and 3,180 runs per second against the baseline's
2,333, 2,456 and 2,453 in the same rounds. stats_local.folded_increments
reads 32,322 per run on the graded workload.

Two blockers stand. The structural one: the counter is absent from the
baseline's dump, as predicted at admission. The one that matters: five
observables read outside the baseline's own spread at round 3, which by the
skill's rule refutes the neutral declaration and closes the candidate.

- steps per run 1,842.7 against 1,992.3, allowance 92.7
- end reason iterations_exhausted 0.2240 against 0.2426, allowance 0.0184
- end reason stall_cap_reached 0.3185 against 0.3090, allowance 0.0078
- arm share grid 0.1457 against 0.1371, allowance 0.0042
- arm share grid-short 0.3098 against 0.3248, allowance 0.0032

The rule is applied only after the cause is known, because two causes fit
and they predict different things. A mid-run reader of a converted counter
would mean the mechanism changes the search, and the declaration is refuted
by the change itself. The other cause is the workload: the campaign
allocates round-robin by wall slice (min_slice_sec 20), so an arm's share
of runs is its relative throughput, and its stall and run caps are learned
across runs. A per-step saving speeds long runs more than short ones - grid
and grid-no-purgatory gained share, grid-short, capped at 1,500
iterations, lost it - and learners fed a third more runs in the same wall
end runs sooner, which is iterations_exhausted falling and
stall_cap_reached rising. On that reading the spread check measures the
speedup, and no change this large could pass it.

The two are separated by an experiment, not an argument: the campaign's
deterministic_slice_runs mode sizes slices in runs, independent of the
clock. Both binaries run the graded config with only that mode switched on,
the baseline twice as a control on reproducibility at 30 threads. No
further round is bought until it answers.

**Operator error, recorded.** The first deterministic comparison omitted
`session_seed`, which the grader sets on every round, so each session drew
its own workload and schedule seeds and the baseline control differed from
itself on all 15,000 runs. That comparison says nothing about the candidate
and is discarded. It was re-run with session_seed 1000, once at 30 threads
(slices of 1,500 runs, two rounds per arm) and once at one thread (slices of
300 runs), the baseline twice in each, so a control that still differs
from itself separates thread nondeterminism from the candidate.

### What the determinism runs show, and what they cannot

With session_seed fixed, the 30-thread campaign is still not reproducible run
for run: the baseline differs from itself on 8,750 of 15,000 rows, mostly in
max_inert_streak, with identical workload and schedule seeds. The candidate
differs from the baseline on 8,971, the same order. Row identity is not
available as evidence at the graded thread count; the one-thread trio is
running for that.

At equal run counts the 30-thread distributions agree. Overall
iterations_exhausted 0.7285 and 0.7231 on the two baselines against 0.7245
on the candidate; plan_complete 0.2714 and 0.2768 against 0.2755; steps per
run 3,849 and 3,833 against 3,833. Every overall statistic sits inside the
baseline's own gap.

That comparison does not test what the grader flagged. It shows no
stall_cap_reached and no learned_cap_reached at all, and the graded
workload ends 31 and 18 percent of its runs on them. Reading stall_cap.rs
and run_cap.rs explains why, and supplies the mechanism the throughput
reading needed:

- Both caps are learners that take effect only after a scope has 200
  completed probes. run_cap makes one run in 32 a probe, and only probes
  whose plan completes feed it. 15,000 runs over five arms give a scope
  about 25 completed probes, so neither cap ever switched on in the short
  deterministic runs.
- Both recompute only at doubling checkpoints (200, 400, 800, ...) and are,
  in their own words, "a deterministic function of the sample sequence".
  They are a function of how many runs have completed, not of wall time.
- In a wall-budgeted round, a binary that completes a third more runs
  therefore turns its caps on sooner and reaches later checkpoints within
  the same 120 seconds, so a larger share of its runs is cut by them. That
  is stall_cap_reached rising, iterations_exhausted falling and steps per
  run falling. With round-robin allocation by wall slice, arm shares follow
  each arm's relative throughput. All five flags follow.
- Neither learner reads a counter this change converts: both write through
  record_* and set_*_learned and consult only enabled().

This is still an argument. The experiment that decides it is an equal-run-count
comparison long enough for the caps to engage: slices of 25,000 runs, two
rounds per arm, 250,000 runs per session at 30 threads, the baseline twice
and the candidate once. If the candidate's end reasons, cap end reasons
included, sit inside the baseline's own gap at equal runs, the neutral
declaration holds for the mechanism, and the grader's spread check on this
wall-budgeted workload is measuring the speedup.

**One thread: byte-identical.** With session_seed 1000 at RAYON_NUM_THREADS=1,
slices of 300 runs, 3,040 runs per session, the baseline reproduced itself
exactly - 0 of 3,040 run rows differing on every non-clock column, 0 of
4,556 utilization leaves, 0 of 3,119 campaign report leaves, and an
identical stall_cap_runs.csv. The candidate matches the baseline on all of
it: 0 rows, 0 utilization leaves apart from the two added stats_local keys,
0 campaign leaves, the same stall_cap_runs.csv hash. Where the explorer is
reproducible, the change alters nothing it searches or records. The caps do
not engage at 3,040 runs either, so this clears the mechanism and leaves the
cap path to the 250,000-run comparison.

**30 threads, equal runs, caps engaged: steps shorter, cap end reasons at
the edge.** Slices of 25,000 runs, two rounds per arm, 250,040 runs per
session, session_seed 1000; baseline twice (111 s, 111 s), candidate once
(87 s). Both caps engaged on all three: run_cap 6 recomputes over 2 scopes,
stall_cap about 81,000 to 83,000 stops.

Overall end reasons against the two baselines: learned_cap_reached 0.2049
against 0.1989 and 0.2083, inside; plan_complete 0.2664 against 0.2768 and
0.2651, inside; stall_cap_reached 0.3334 against 0.3251 and 0.3295, outside
by 0.0039 on a baseline gap of 0.0044; iterations_exhausted 0.1951 against
0.1989 and 0.1968, outside by 0.0018 on a gap of 0.0021. Steps per run 2,010
against 2,088 and 2,126: outside by 78 on a gap of 38. By arm the shortfall
sits in grid (2,948 against 3,157 and 3,111), grid-no-purgatory (1,836
against 1,979 and 2,035) and grid-post-fault-2 (1,914 against 1,989 and
2,037); aos and grid-short sit inside their gaps.

Equal run counts did not remove the effect at 30 threads, and its direction
is the graded one: more stall stops, fewer exhausted runs, shorter runs. A
two-sample baseline gap is a weak spread estimate, but three grid arms moving
the same way is not nothing. Two readings survive. The learned caps are read
mid-run by concurrent workers, and when a checkpoint is crossed relative to
other runs' starts depends on relative run speed; a per-step saving speeds
long probes more than short runs, which would engage caps earlier in run
order at equal totals. Or the change moves the search on the cap path, which
the byte-identical one-thread result did not exercise because its caps never
engaged.

The one-thread run separates them: sequential runs cross every checkpoint at
the same point in run order whatever their speed. Slices of 20,000 runs,
one round, 100,000 runs, of which 80,000 fall in the default-budget scope -
enough for its caps to engage and recompute. One thread is reproducible
(shown above), so baseline and candidate run once each.

**One thread, caps engaged: byte-identical. The mechanism is neutral.**
100,000 runs each, session_seed 1000, slices of 20,000 runs, both caps
engaged on both sides (stall_cap 22,514 stops over 70,260 treated runs,
run_cap 2 recomputes, cap_max_scope 899 on both). The candidate against the
baseline: 0 of 100,000 run rows differing on every non-clock column;
identical end-reason counts, including stall_cap_reached 22,514 and
learned_cap_reached 18,308; 0 of 6,963 utilization leaves apart from the
two stats_local keys; 0 of 3,089 campaign leaves; the same
stall_cap_runs.csv hash.

So the change does not alter what the explorer searches, on the cap path
included. The shift the grader's spread check read at 30 threads, and the
smaller one that survived at equal run counts, come from concurrency: the
learned caps are read mid-run by every worker, so when a run sees a
recomputed cap depends on how fast the other workers' probes finish, and
this change makes them finish sooner.

One more reading from the same pair, informal because the two sessions ran
side by side on a busy host: at one thread the candidate took 383 s against
the baseline's 380 s. A saving that is cache-line contention between
threads must vanish when there is one thread, and it does. At 30 threads
the same binary reads 1.32. That is the sharing declaration confirmed by
the shape of the effect, not only argued.

### The independent observable: the candidate profile

research/perf/profiles/292c15b-cand-thread-local-stats-blocks.md, 60 s at 30
threads, frame-pointer call graph, largest inclusive share 91.47 percent
(93.95 on the baseline), against 292c15b.md.

Self time, baseline to candidate:

- walk_recovery_placebo 3.84 to 0.82, down 3.02 points. The frozen
  observable asked for at least 1.0. The judge's red-team cut the proposer's
  2.9-point attribution to 0.6-1.6 points on the audit_multiplier_authority
  control; the proposer's figure was the better one.
- schedule_runnable, all specializations, 12.80 to 5.65; select_within_queue
  2.88 to 0.55; audit_multiplier_authority 0.43 to below the cutoff.
- The four summed, 19.95 to 7.02, down 12.93 points. The frozen observable
  asked for at least 4.
- fold_run_counters does not appear above the cutoff, as the plan predicted.
- The interpreter's shares rise - eval 4.93 to 6.60, exec inclusive 42.7 to
  54.5 - which is what removing a third of the scheduler's cost does to the
  remaining shares; they are shares of a profile, not times.

This is the clearest attribution the loop has recorded. Iteration 2 withdrew
"atomics taxing the treatment" because no atomic symbol showed above the
cutoff; inlined lock-prefixed increments on bounced cache lines were
charged to their callers all along, and removing them took 13 points of
self time out of four scheduler functions.

### Every frozen falsifier, read

- Primary interval entirely below 1.05: no. 1.3217, interval [1.1878,
  1.4706], separated at three rounds; every round above 1.28.
- stats_local.folds 1.00 per run within 1 percent: 389,220 over 389,220,
  378,360 over 378,360, 382,020 over 382,020 runs in the three rounds.
  folded_increments 31,177, 33,038 and 32,751 per run, inside the predicted
  25,000 to 55,000.
- walk_recovery_placebo self down at least 1.0 point: down 3.02. The four
  scheduler symbols down at least 4 points: down 12.93.
- Dump integer leaves and timer_effects.by_key length: identical to the
  baseline on the one-thread runs, byte for byte.
- The spread check on steps per run, end reasons and arm shares: outside
  the baseline's spread on five observables. This is the one that stands.

### Filed for the user: split evidence

The rule says a neutral declaration that reads outside the baseline's spread
closes the candidate. Applied literally it closes this one. The evidence
says the rule is reading something other than what it was written to guard:

- The mechanism does not change the search. At one thread, with the learned
  caps engaged over 100,000 runs, candidate and baseline produce identical
  run rows, end reasons, utilization dump, campaign report and stall cap
  table.
- The flagged shift is a property of this workload under concurrency. Both
  caps are learned from completed runs and read mid-run by all 30 workers,
  and the campaign allocates by wall slice. A binary that finishes runs a
  third faster engages its caps earlier and has its arm shares follow its
  throughput. Every one of the five flags moves in the direction that
  predicts, and a smaller version of the shift survives at equal run counts
  at 30 threads, where only concurrency timing differs.
- The gain is contention removed, by every instrument available: the
  counter confirms the traffic moved (about 32,000 writes per run), the
  profile shows 13 points of scheduler self time gone, and at one thread,
  where there is no contention to remove, the two binaries take the same
  time.

What argues against, recorded honestly:

- On the graded workload the explorer does run differently with this
  binary: runs are 7.5 percent shorter (1,843 against 1,992 steps) because
  caps engage sooner. Part of the 1.32 is therefore bought by shorter runs.
  Discounting it, 1.3217 x 0.9249 is about 1.22 runs per second at equal
  steps - still above the band's upper edge.
- That shift is not free for the search loop: any faster binary would push
  the learned caps harder on this workload, and whether that helps or hurts
  bug-finding is the search loop's non-inferiority question, not this
  loop's. It is also not specific to this candidate.
- Three rounds, not six. More rounds cannot change the decision: the
  interval's lower edge is already 1.19, and the neutrality flag is
  systematic, so it will not clear with rounds.

**Harness finding for the user.** The neutrality spread check compares a
wall-budgeted campaign whose caps and allocation are functions of completed
runs. On that workload it cannot certify any candidate large enough to
matter: a real speedup moves the observables it guards through the learners,
whatever the change does to the search. call-frame-one-pass, at about 6
percent, stayed inside the spread; this one, at 32 percent, cannot. The skill
and the grader are not this loop's to change. An equal-run-count reading, or
the one-thread identity check run here, is what would separate "the change
moves the search" from "the change is fast".

Recommendation: merge, departing from the grader's blocker, on the written
reason above. Grader session state: research/perf/state/thread-local-stats-blocks.json.

### Merged

The user chose to merge on the split evidence. Superproject a0572ff, spur
a702eef. spur.patch applied cleanly; super.patch carried only the gitlink.
The baseline was rebuilt and a fresh cache measured for the moved tree:
3,064.8 runs per second over three rounds, spread 0.0378, against 2,569.6
on the pre-merge cache of the same frame-pointer identity family - plus
19.3 percent, an independent reading in the graded direction, smaller than
the interleaved 1.32 and close to the 1.22 estimate at equal steps.

The ledger row in research/lite/epoch-baseline.json carries ratio 1.3217
and the warning that measuredRps is comparable with neither the search
loop's rows nor call-frame-one-pass's, which predates forced frame pointers.

The implementer's worktree, its branch, the candidate export and the
determinism outputs (about 20 GB) were removed; the round records and the
candidate profile are committed.

### Direction review after the merge

**Are the costs being attacked still the largest ones explainable?** No
longer the same ones. In the candidate profile the four scheduler symbols
fell from 19.95 to 7.02 points of self time and the interpreter now leads:
eval 6.60 self, exec about 54 inclusive, execute_common_label 4.40,
Value::new 2.92, allocation (_int_malloc 3.48, malloc 1.38, cfree 1.29) and
SipHash 3.16 next. The serialization path - format_escaped_str 1.92,
Value::write_to 1.88 - is unchanged. The tree has moved, so the next
iteration re-profiles a702eef before proposing.

**Has the steering paid for itself?** Yes, and the lesson is specific. The
contention lens came up on rotation, and the attribution requirement made
the proposer price inlined atomics that no flat profile could show; the
call-graph profile added in 66d0979 is what made that attribution
checkable. The judge's red-team cut the attribution by half on a control
that was reasonable and wrong: one contended write per step costs little,
fourteen on the same few lines from thirty threads cost a third of the
scheduler.

**What the next directives should pull toward.** Three leads, all at
mechanism level:

- Remaining shared writes on the hot path. This change converted only
  counters with no mid-run reader. TERMINATION and the timer_context and
  learner atomics stay global, and every learner read mid-run by all workers
  is a shared line. Whether any of those is written per step is the next
  contention question, and the one-thread identity check is the instrument
  that keeps such a change honest.
- The pool's surviving composite: exec-plan-borrows-program,
  fx-hashed-call-and-timeline-lookups and serialize-history-inline. Their
  shares grew relative to the smaller total and should be re-priced on the
  new profile before admission, not carried over.
- The interpreter, now the largest block, which no candidate has attacked
  directly since call-frame-one-pass.

**Harness finding, repeated for the user because it will recur.** Every
future candidate large enough to matter will trip the neutrality spread
check on this workload, because the learned caps and the wall-slice
allocator respond to throughput. This iteration cleared it with an
equal-run-count comparison and a one-thread identity run with the caps
engaged. Neither exists in the grader, and the grader is not this loop's to
change.

## Operator measurement - history writer headroom, no candidate

The question put to this loop from outside it: at about 2,400 Mencius runs
per second, how close is the explorer to an I/O bottleneck, and can the
parquet writer do more with the same writer threads. Measured 2026-09-12 on
spur a702eef, 30 rayon threads, so four writer threads
(`writer_thread_count` is threads / 8 rounded up). Output lands on btrfs
over a two-drive NVMe mirror, snappy-compressed.

### The writers, read on real sessions

Writer thread CPU was sampled from /proc per thread while ordinary explorer
sessions ran, one session at a time on an idle host.

| workload | runs/s | writer CPU per run | busy share per writer | other threads busy | bytes per run |
|---|---|---|---|---|---|
| Mencius_opt1_2, mencius_nocrash.json, 48,000 runs | 2,580 | 453 us | 27.6% | about 93% | 6.9 KB |
| VR general_vr campaign, 40 s, 122,820 runs | 3,058 | 508 us | 37.8% | about 60% | 18.1 KB |

Disk is nowhere near a limit: 16.6 MB/s for Mencius and 50 MB/s for VR.
The writers are the nearest ceiling, and it is CPU, with roughly 3.6x
(Mencius) and 2.6x (VR) headroom before four writers saturate. The older
profile at 292c15b put writer threads at about half busy; the tree has
moved since. Free space is the limit a long session reaches first: about
200 GB an hour at the VR rate.

### Three writer-side changes, measured before proposing any

A replay bench re-encodes one writer's real output files through the
current writer and through each change: 4,000 runs, four producer threads
standing in for simulation threads (they allocate each run's rows as owned
strings, as `serialize_history` and friends hand them over), one writer
thread timed on its own thread clock, output to a byte counter, three
interleaved repetitions, medians. Spread across repetitions is under 2
percent except one repetition of the payload row. Rows per run: Mencius
1,803 executions, 36 logs, 710 traces; VR 307, 775, 807.

| variant | Mencius writer us/run | Mencius producer us/run | Mencius MB | VR writer us/run | VR producer us/run | VR MB |
|---|---|---|---|---|---|---|
| current (one batch per run and table) | 347 | 104 | 43.7 | 251 | 77 | 73.9 |
| accumulate 32 runs per write, Arrow builders | 377 | 113 | 43.9 | 275 | 84 | 74.1 |
| accumulate 256 runs per write | 402 | 105 | 43.7 | 281 | 81 | 74.1 |
| dictionary and statistics off on payload and content | 338 | 104 | 90.4 | 243 | 72 | 82.5 |
| dictionary off on every column | 288 | 97 | 160.9 | 215 | 74 | 122.9 |
| arrays built on the producer thread | 257 | 229 | 43.7 | 210 | 173 | 74.0 |
| producer-built, payload dictionary off | 248 | 231 | 90.6 | 197 | 176 | 82.6 |
| producer-built, concatenated 256 runs per write | 265 | 243 | 90.7 | 193 | 196 | 82.6 |

The replay reads low against real sessions - real writer CPU is 1.3x the
replay on Mencius and 2.0x on VR, which is the kernel copy into the page
cache and contention with thirty busy simulation threads that the replay
does not have. The ranking between variants is what the replay is for.

**Accumulating runs is slower, not faster.** Appending value by value
through Arrow builders costs more than the per-call overhead of
`ArrowWriter::write` it removes.

**The dictionary is earning its keep.** Payload strings repeat heavily;
turning the dictionary off saves 3 to 17 percent of writer CPU and grows the
output 1.1x to 3.7x, against a free-space limit that is already the nearer
one.

**Producer-built arrays is the one mechanism that works, and it moves cost
onto the bottleneck.** Writer CPU falls 17 to 26 percent; simulation threads
pay 96 to 124 us more per run, about 1 to 1.6 percent of a run's thread time
(11.4 ms per Mencius run, 6.1 ms per VR run). With writers at a quarter to
a third busy that is a net loss today. It is the change to reach for only
once writers read above about 80 percent busy.

None of the three is filed as a candidate.

### What this points at

- The logging cost that reaches throughput is on the simulation threads,
  not the writers: Mencius carries 1,803 history rows per run, each
  serialized to a JSON string there. That is serialize-history-inline,
  already in the pool, and it should be re-priced on a fresh profile.
- The VR campaign's non-writer threads used about 745 of about 1,236
  available thread-seconds while the writers sat at 38 percent, so the idle
  time is not writer backpressure. Not investigated; a lead, not a finding.
- The writers' busy share is now worth watching as a number, not a one-off
  /proc read: a writer ceiling would otherwise show only as throughput that
  stops rising, with nothing in the dump to say why.

### The counter, and what the CPU reading missed

A `history_writer` block is added to the utilization dump, on a detached
spur worktree off a702eef, not merged. `busy_ns` is the writer threads' wall
time from taking a command off the queue to finishing it, recorded only
while stats are on. `queue_full_sends` and `blocked_ns` count and time sends
from simulation threads that found the queue full; only such a send reads
the clock, so the common path pays nothing. The perf grader can name
`history_writer.busy_ns` as a counter, and the campaign's per-slice delta
carries it with no further wiring. The spur-core suite passes, including the
export completeness test.

Read on the VR campaign, 40 s, twice with the counter binary:

| instrument beside the counter | runs/s | counter busy per writer | writer CPU | writer run-queue wait | queue_full_sends |
|---|---|---|---|---|---|
| /proc thread CPU | 2,798 | 53.5% | 64.8 s | - | 0 |
| /proc schedstat | 3,012 | 54.3% | 66.2 s | 21.3 s | 0 |

The counter reads 1.3x the CPU time, and schedstat accounts for all of the
gap: 87.1 s busy is 66.2 s on a core plus 21.3 s runnable and waiting for
one, within 0.5 s. The writers spend no measurable time blocked in the
kernel on file writes, so the disk adds nothing to their cost. The quarter
of their busy time spent waiting is oversubscription: thirty simulation
threads, four writers and the main thread on 32 logical CPUs. Busy wall time
is the reading that decides backpressure, so the headroom before four
writers saturate on VR is about 1.8x, not the 2.6x the CPU reading gave.
Across the four VR sessions of this entry, two on each binary, throughput
read 3,058, 2,746, 2,798 and 3,012 runs/s; the counter shows no cost at
that resolution.

Two more things the same sessions settle:

- The simulation threads used 736 CPU-seconds with only 28.8 s of run-queue
  wait and no full-queue sends, so their idle third on the campaign is
  neither preemption nor writer backpressure. The lead above stands, now
  with two causes ruled out.
- Stats are not free on every workload. Mencius_opt1_2 with `stats=true`
  ran 703 runs/s against 2,580 without, and writer CPU per run rose 2.6x
  (1,181 us against 453), so stats change what a Mencius run is. The counter
  therefore cannot read the stats-off Mencius session this entry opened
  with; only its CPU reading stands there. Not investigated.

## Iteration 6 - autonomous, algorithmic lens, profile 69c488c

Mode: autonomous. Preflight: spur-research-loop inactive, no grader
measuring, branch research/lite, spur gitlink 69c488c, tree clean, baseline
rebuilt, selftest zero failures (one warning: ten VARIANT_BITS names with no
tag in run_variant.rs, unchanged from before). No profile existed for
69c488c, so one was taken: research/perf/profiles/69c488c.md.

### No new layout control this epoch, decided

The skill asks for a layout control before the first candidate of an epoch.
The last one, layout-control-e3, measured the floor on 2026-09-13 under the
frame-pointer toolchain with build config hash b813e711, and that hash has
not moved. The tree has moved by thread-local-stats-blocks and the
history_writer counter, which change code size but not build flags. Its
interval half-width was 0.045 against a configured 0.05. A second control
costs about 30 minutes of rounds plus a build, and the user's standing
direction is minimal post-merge overhead with no standalone measurement.
The floor stays at 0.05 and any gain read this epoch still owes a lower
edge clearly above it. What would reverse this: a candidate whose reading
lands between 1.03 and 1.07, where the floor's own accuracy decides the
verdict; then the control is bought before deciding.

### The profile, read before proposing

Shares of the 60 s profile at 30 threads (rayon root 91.4 inclusive):

- Interpreter value traffic is the largest block: eval 6.78 self and 22.35
  inclusive, execute_common_label 34.11 inclusive, malloc 7.78 inclusive,
  EcoVec reserve, grow, drop and make_unique about 5 together.
- Trace payload formatting on simulation threads: trace_payload 5.33
  inclusive, Value::write_to 4.07, json_string_array 2.78,
  format_escaped_str 2.61.
- serialize_history's nested par_iter 7.58 on its helper line (3.88 on the
  collect frame), wake_any_threads 1.34.
- Program::clone 2.37 plus its drop 1.00, once per run, up from 1.65.
- SipHash: TimelineTuple insert 3.22 under note_delivery 3.96, NameId and
  String map probes about 3.7.

### Proposals

Lens algorithmic, focus directive at the five blocks above. The proposer
returned two composites and absorbed the pool's three proposed entries:

- run-invariant-lookups-once: exec_plan borrows the Program; call targets
  resolved to an index once at compile time; the Constant timeline key
  inserted once. About 9.4 points, band [1.05, 1.11].
- format-once-on-simulation-threads: TraceEnter reuses the TraceDispatch
  payload; f-strings concatenate in one allocation; history serialized
  inline and streamed. About 9.7 points, band [1.05, 1.13].

It declined to price anything from the inclusive shares of Value::new and
ValueKind::clone, arguing frame-pointer stacks attribute callees to a match
with no calls there. It also raised a lead outside the on-CPU profile: the
simulation threads' idle third fits grid batch stragglers (batch size 60 at
30 threads, a batch waits for its slowest run), which predicts 40 to 60
percent utilization against the measured 736 of 1,236 thread-seconds. Any
fix changes when the corpus and learners see outcomes, so it is
search-affecting; recorded as a lead for the direction review.

### Judging

The judge admitted neither composite as proposed and cut one part of each:

- run-invariant-lookups-once, reduced to the Program borrow and the
  constant timeline key: gain 7, cost 0. Both verified - the two Program
  clones are the only ones in the workspace, and the dump confirms every
  graded run takes the Constant key (novelty_ablated_runs equals runs, 0.9996
  keys per run), with tuples monotone within a run so every reader sees the
  same set. Band [1.04, 1.08].
- Cut from it, returned to the pool as call-targets-indexed: resolving call
  targets to an index. It needs exec.rs, its 2,300 to 2,900 resolutions per
  run predates call-frame-one-pass (frame.calls caps it near 2,045 to
  2,126), and it missed the NodeToString probe that shares hash_one<NameId>.
- format-once-on-simulation-threads, reduced to the entry payload reuse and
  inline streamed history: gain 5, cost 2 (exec.rs, history.rs). No
  counterexample to Dispatch and Enter payload identity on any path,
  crash re-delivery and records without a dispatch included. One identity
  trap the proposer missed: NodeId's derived Serialize writes role before
  index, while the json! tree sorts index first, so the streaming writer
  must write NodeId by hand. The history part was overpriced at 4 points;
  realistic 1.2 to 2.0. Band [1.018, 1.051].
- Scored 0: n-ary f-string concatenation. Its structural claim is false -
  try_to_expr already folds pure sub-chains into one label with no temps -
  and CFG labels have readers outside exec. The cost it pointed at, per-Add
  EcoString allocation and contended refcounts on shared literals and on
  the trace function_name Arc cloned on every trace row, is unpriced and
  kept as a lead.

The proposer's caveat about Value::new holds: its body cannot call
make_unique, yet the 12b7582 call graph shows that edge, so inclusive
shares under Value::new and ValueKind::clone are not used to price anything.

### Decision: build both reduced candidates as one

lookups-and-format-once, search-neutral, shared, band [1.059, 1.135]
composed from the two judged bands. Departure from "pick the top candidate",
reason: neither part can be read against the 0.05 floor alone (lower edges
1.04 and 1.018), the user's standing direction is fewer and larger rounds
with compatible candidates combined, and the two touch disjoint code with
disjoint counters. The known cost is recorded before any round: the wall
cannot say which part paid. Attribution comes from the counters and a
candidate profile against 69c488c.md, where each part has its own frozen
observable; on a refuted verdict the part whose observable did not move is
the one closed. Grader counter: timeline.constant_short_circuits; the other
five are read off the dump.

### Review of the diff, and an operator error at start

The diff matches the admitted hypothesis, stays in spur-core, leaves the
campaign block alone and declares no treatment bit. The trace payload
moves out of the record once and is used only together with a pending id,
so a stale payload cannot be reused; a re-delivered record formats its entry
row again with the same bytes. The short-circuit tests `!tuples.is_empty()`
under Constant, equivalent to the key lookup because the constant key is
the only thing ever inserted. All six counters go through the per-thread
block. The implementer's checks: 497 spur-core tests pass, including a new
byte-identity test of the streamed JSON against the old tree path over every
Value kind; a one-thread identity smoke at session_seed 1000 over 3,008
runs showed 0 differing rows in executions (1,167,064), logs (3,377,240),
traces (3,701,447) and runs, with every counter equality exact. On a
30-thread smoke: constant_short_circuits about 1,048 per run, above the
judge's 250 to 700 (a count miss in the direction of more work skipped);
constant_inserts 0.9994 per run equal to keys_in_run_sum; reused plus
formatted equal to Enter rows; ops_streamed equal to executions rows.

Operator error: the first `start` omitted `--primary cross-binary`, so the
grader chose the counter primary, which a counter new to the candidate
cannot read and which the frozen runs-per-second band does not describe.
Caught before the first round finished; the round was killed with nothing
written to the session or the baseline cache, and the session was
re-registered with `--force` and the primary the frozen prediction names.
Declarations, band and counter unchanged. Earlier sessions passed the flag;
this one did not.

### Rounds 1 to 4

Per-round runs per second, candidate over baseline: 1.1042, 1.2952,
1.1329, 1.1847. At four rounds the mean is 1.1771, interval [1.0529,
1.3159], separated, band [1.059, 1.135] read inside, advice gain. Baseline
side 3,290.8, 2,957.8, 3,302.9 and 3,070.9 runs per second; the round-2
baseline dip is why that round reads high. Steps per run, candidate over
baseline: 1.0485, 0.8856, 1.0091, 0.9579, so no systematic length shift in
either direction.

Every counter, read by hand off the candidate's utilization dump in each of
the four rounds:

- timeline.constant_inserts equals timeline_keys.keys_in_run_sum exactly in
  every round (436,423; 459,884; 449,330; 436,780), 0.9997 per run.
- run_setup.program_clones_avoided and stats_local.folds are 1.0000 per run.
- trace_format.enter_payload_reused 247 to 268 per run, inside the predicted
  230 to 300; enter_payload_formatted 5.06 to 5.09, inside 3 to 8.
- history_format.ops_streamed 176 to 193 per run; its exact equality with
  executions rows was checked on the smokes, where the rows were in hand.
- timeline.constant_short_circuits 823 to 897 per run, above the judged 250
  to 700. A count miss in the direction of more skipped work; the judge's
  figure undercounted deliveries per run.

The one neutrality row outside the baseline's spread is the grid arm's share,
lower on the candidate in all four rounds: 13.80, 13.53, 13.83, 14.03 percent
against 14.16, 14.29, 14.19, 14.51. About half a point, consistent in sign.
The other ten rows, steps per run and all end reasons included, sit inside
the spread. Thread-local-stats-blocks flagged the grid arms the same way. The
campaign allocates arms by wall slice and learns from completed runs, so a
binary whose runs finish sooner shifts the allocation; the one-thread smoke
at a fixed run count, where allocation does not depend on speed, showed
identical run rows, arms and variants included.

### Six rounds, finished

Rounds 5 and 6 read 1.1443 and 1.1840. Final: mean 1.1727, sd 0.0556,
interval [1.1062, 1.2432], separated at round 4 and stayed separated
through rounds 5 and 6 with a rising lower edge (1.0529, 1.0837, 1.1062).
Band [1.059, 1.135]: inside. Microseconds per run 1.2148, interval [1.1487,
1.2846]. Steps per run 0.9829, interval [0.9225, 1.0473], so the runs did
not get shorter. Baseline cache for 69c488c: six rounds at 3,174.0 runs
per second, spread 0.0427.

Advice gain with one blocker, the structural one: the declared counter is
new to the candidate. At six rounds every one of the eleven neutrality rows
sits inside the baseline's spread, the grid arm share included (13.89 against
14.35 percent, allowance 0.54 points). The flag that stood at rounds 3 to 5
cleared as the baseline's own spread was measured; the sign stayed
consistent, and it is read here as the allocator's response to throughput,
not as a change to the search.

### The independent observable: the candidate profile

research/perf/profiles/69c488c-cand-lookups-and-format-once.md, 60 s at 30
threads, against 69c488c.md. Inclusive shares, baseline to candidate:

- Program::clone 2.37, Vec<Label>::clone 1.01, drop_glue<Program> 1.00: all
  absent. Frozen: absent.
- LocalTimeline::note_delivery 3.96 and HashMap<TimelineTuple>::insert
  3.22: both below the reporting cutoff of about 1.0. Frozen: at most 0.8
  and 0.5, which the cutoff cannot tell apart from 1.0; recorded as down at
  least 3 and 2.2 points rather than as the frozen thresholds met.
- Sip13 Hasher::write 4.32 to 2.01, down 2.31. Frozen: down at least 1.8.
- LocalKey<TraceScratch>::with<trace_payload> 5.33 to 3.61, down 1.72.
  Frozen: down at least 1.2.
- json_of_value 1.15, the Vec<serde_json::Value> collect 1.15,
  serialize_history 3.88 and its nested par_iter helper 7.58: all absent.
  Frozen: absent, serialize_history at most 2.0.
- wake_any_threads 1.34, crossbeam_epoch with_handle 3.74, Stealer::steal
  3.76: all below the cutoff. Not claimed by the hypothesis - the proposer
  declined to attribute the steal and epoch lines because batch-boundary
  spinning produces them too. Their disappearance says the nested par_iter
  was the larger source of that traffic.
- malloc 7.78 to 6.34, _int_malloc 4.38 to 3.82. Falsifier "malloc
  inclusive rises": did not fire.
- eval 22.35 to 27.00 inclusive, a share of a smaller total.

Every frozen falsifier held: the rps interval clears 1.059; the identity
smoke is exact; constant_inserts equals keys_in_run_sum in every round;
constant_short_circuits, enter_payload_reused and ops_streamed are non-zero;
program_clones_avoided is 1.00; trace_payload fell by more than 1.2 points.

### Decision: merged

Advice gain; one blocker, the structural one (the declared counter is new to
the candidate, so no ratio). Departed from on the same reason as the last
merge: every counter was read by hand in every round and agrees with the
mechanism. The component bands composed to [1.059, 1.135] and the reading
is 1.1727, inside and near the upper edge. Microseconds per run read 1.21
against 1.17 runs per second at steps per run 0.98, so the saving is cost
removed per run and not shorter runs.

Where the reading exceeded the parts' pricing: the proposer priced the
history part without the rayon steal and epoch traffic, and that traffic
left the profile. The judge's history estimate of 1.2 to 2.0 points was
conservative for the same reason.

Merged: spur 84b7ab5, superproject 2ba5f59. spur.patch applied cleanly;
super.patch carried only the gitlink. The implementer worktree (20 GB) and
its branch were removed.

### Direction review after the merge

Digest for the user: iteration 6 merged a composite of four small
mechanisms at 1.17 over six rounds. Cumulative on this loop's graded
workload since call-frame-one-pass, 1.0634 x 1.3217 x 1.1727, about 1.65.

**Are the costs attacked still the largest explainable ones?** The per-run
Program copy, the collapsed timeline set, duplicate trace formatting and
history's JSON trees are gone. The candidate profile's largest blocks are
now the interpreter (eval 27.0 inclusive, 8.2 self), allocation (malloc 6.3
inclusive), the remaining trace formatting (3.6) and the scheduler. The
next profile, of 84b7ab5, decides the next directive; it is not assumed.

**Has the steering paid for itself?** Yes. The focus directive named five
blocks, the proposer attacked four and declined one for a stated reason
(frame-pointer attribution under Value::new), and the judge cut two parts
on checkable false claims before any build. Combining the two admitted
reductions was the decision that let a floor-sized instrument read them.

**What the next directives should pull toward.**

- The interpreter's value traffic, still unattacked and now the largest
  block. The attribution caveat stands: price from counts or self time, not
  from inclusive shares under Value::new or ValueKind::clone.
- Contended refcount writes on buffers all threads share, raised twice this
  iteration and priced nowhere: the trace function_name Arc cloned on every
  trace row and literal EcoString clones in eval.
- call-targets-indexed, returned to the pool at net 3, about 1.3 to 1.5
  points.
- The simulation threads' idle third. The proposer's grid-batch straggler
  argument fits the measured utilization. Any fix is search-affecting,
  since the corpus and learners would see outcomes at different times. It
  owes per-batch off-CPU evidence before a proposal, and a search-affecting
  declaration with the search loop's reading.

**Harness note, repeated.** The neutrality spread check flagged the grid arm
share through round 5 and cleared at round 6 only because six baseline
rounds widened the allowance. The throughput response to the wall-slice
allocator is still what it reads, as iteration 5 recorded.

### Post-merge baseline and ledger

The baseline was rebuilt at spur 84b7ab5 and a fresh cache measured:
3,782.0 runs per second over three rounds, spread 0.0263, against 3,174.0
over six rounds on the pre-merge 69c488c cache of the same identity family -
plus 19.2 percent, an independent reading in the graded direction, somewhat
above the interleaved 1.17 as the non-interleaved check was last time too.
Ledger row appended to research/lite/epoch-baseline.json with ratio 1.1727.
The candidate export was removed; round records, both profiles and the
judgment's content (copied into this log and the pool) are what is kept.

## Iteration 7 - autonomous, allocation lens, profile 84b7ab5

Preflight carried from iteration 6 in the same session: spur-research-loop
inactive, no search-loop grader running, branch research/lite, spur gitlink
84b7ab5, tree clean after d97a821, baseline binary rebuilt at 84b7ab5 with a
fresh cache (3,782.0 runs per second). Selftest was run this session. No
layout control: same build config hash as layout-control-e3, reason as in
iteration 6. Profile: research/perf/profiles/84b7ab5.md.

### The profile, read before proposing

The interpreter's value machinery is now the largest block and has no
candidate against it. Self time: eval 8.28, execute_common_label 5.33,
Value::new 3.78, store 2.72, FrameBuilder::finish 2.36, drop glue on Value
and ValueKind 3.61, EcoVec reserve, drop, make_unique and grow 4.92,
ValueKind::clone 1.38, with _int_malloc 3.11, memmove 2.99, malloc 1.18 and
cfree 1.05 underneath - about 30 points of self time before the scheduler.
Next: trace text formatting (Value::write_to 3.79 inclusive,
trace_payload 3.49, format_escaped_str 1.91), the ChannelId hash map (insert
1.97, RawTable 1.15), and the call-target name lookups call-targets-indexed
covers (String to NameId get 1.58, hash_one<NameId> 1.34). Parquet writer
threads read 9.36 inclusive, unchanged in kind.

Lens: allocation and memory traffic. Focus directive: the value machinery
above, priced from self time and per-run counts, not from inclusive shares
under Value::new or ValueKind::clone, whose frame-pointer attribution the
iteration 6 judge showed unreliable; plus the unpriced contended refcount
writes on shared literal and trace-name buffers.

### Proposals

Four hypotheses, priced from self lines and per-run counts off the
lookups-and-format-once round-5 dump (the 84b7ab5 tree): frame.calls 2,023
and frame.slots_built 35,385 per run, 1,839 steps, 1,123 log rows, 1,230
trace rows.

- value-construction-without-work: under NoHashing, Value::new still
  computes a leaf signature for every value, FxHashing every byte of every
  string, and its only NoHashing reader is Hash for Value; move it to hash
  time. Fill frames with one trusted extend instead of a Value::new and an
  outlined EcoVec::reserve per slot. 5.1 to 6.2 points, band [1.04, 1.08].
- eval-borrows-operands: read-only operands borrow the slot value instead of
  cloning and dropping it. 0.9 to 2.5 points, band [1.01, 1.035].
- per-run-buffers-sized-once: presize the channel table (about 9 to 10
  rehashes per run today), the log and trace vectors, and each Print
  string. 2.3 to 3.3 points, band [1.02, 1.05].
- value-traffic-composite: the three as one commit, band [1.071, 1.174].

Two corrections to the record. Every VR println interpolates an int and
try_to_expr rejects IntToString, so VR's prints are 8 to 10 labels with
temps each; iteration 6's judge was right about pure chains and wrong to
imply VR's prints are among them. And the literal EcoString refcount lead is
mostly empty: every VR field name is 13 bytes or shorter and stored inline.
The trace function_name Arc was priced at 0.4 to 0.7 points at most and set
aside.

### Judging

No candidate scored 0 and none was cut; two were rewritten.

- value-construction-without-work: gain 7, cost 0. Verified that Hash for
  Value is the only NoHashing reader of sig on the explore path, that imbl
  keeps hash bits per entry so trie layout and iteration order cannot move,
  and that extend_from_trusted exists. Red team: an inlined struct literal
  makes Value::new vanish whatever it saves, so "Value::new self at most
  1.0" could not fail; the observable was rewritten as the three frame
  symbols' summed self falling from 7.91 to at most 3.5, with the
  interpreter's own self rising by at most 1.5 as a relocation guard.
  Slots built include parameter slots, so the count was overstated; band
  [1.035, 1.07].
- eval-borrows-operands: gain 5, cost 2 (exec.rs). Positions verified as
  read-only; the counts are not checkable before building. Band [1.01,
  1.035]. Admitted only inside the composite.
- per-run-buffers-sized-once: gain 5, cost 2. The proposed high-water-mark
  hint was rewritten to the previous run's length with caps (4,096 channel
  entries, 8,192 log and trace entries): a thread that once saw a long run
  would otherwise keep a table of several MB whose gets miss L2 in every
  later run, a cost that travels. Band [1.015, 1.035].
- value-traffic-composite: gain 6, cost 2, band [1.061, 1.146] recomposed.

A further correction: "every VR println interpolates an int" is false as
stated - VR.spur:159 and 163 interpolate nothing and 596 only a string. No
priced mechanism rested on it.

### Decision: build the composite

value-traffic-composite, search-neutral, shared, band [1.061, 1.146].
Departure from "pick the top candidate", same reason as iteration 6: the
top part alone has a lower edge of 1.035 against the 0.05 floor, the other
two cannot be read alone, the user prefers fewer and larger rounds, and the
parts touch disjoint code with their own counters and profile observables.
The composite's lower edge clears the floor only narrowly; a reading that
lands between 1.03 and 1.07 buys a layout control before the decision.
Grader counter: frame.default_slots_filled.

### Review of the diff

The diff matches the admitted composite and stays in spur-core; super.patch
carries only the gitlink; no config field, no template edit, no treatment
bit. Checked by reading:

- Frame fill keeps the old slot order - Unit for parameters the caller did
  not push, then the declared defaults, then Unit - and builds each value in
  place with with_sig, as the judge's rewrite required, not by cloning a
  prebuilt value. Under EAGER the frame signature is folded per slot as
  before.
- Hash for Value under NoHashing hashes compute_sig_leaf_only(kind), the
  value construction used to store; the implementer's tests compare it with
  the eager signature over every kind and compare imbl iteration order
  against a map keyed by the stored signature, through inserts and
  removals.
- Operand borrows are only at read-only positions; each arm keeps its eval,
  check, eval order; MapErase drops two clone/drop pairs; Unwrap and
  Coalesce use (**v).clone(); SafeFind and SafeTupleAccess read the inner
  value in place.
- Hints are the previous run's final lengths on the thread, capped at 4,096
  and 8,192; `channels_created` reads channels.len() at run end, exact
  because ids are never reused and nothing is removed.
- default_slots_filled is computed at fold time as slots_built minus
  params_filled, so the sum identity is exact by construction rather than
  by measurement - it confirms wiring, not the mechanism.
- Cost the change adds: the operand and leaf-hash counters tick a
  thread-local cell per call with no stats switch check, and the fold drains
  eight cells per run. Small against what they count, and not free.

Implementer's checks: 499 tests pass, eval tests unmodified,
value_stays_narrow 40; one-thread identity smoke at session_seed 1000 over
3,008 runs with 0 differing rows in executions (1,108,862), logs
(3,383,871), traces (3,702,656) and runs, the same stall_cap_runs.csv hash,
and only a clock leaf differing among 4,567 pre-existing dump leaves.
30-thread smoke per run: default_slots_filled 37,122 (predicted 29,000 to
34,000, a miss upward, slots_built itself 40,815 on this smoke),
params_filled 3,692, leaf_hashes_deferred 4,568 (inside 1,000 to 5,000),
handles_not_cloned 8,835 (predicted 2,000 to 6,000, a miss upward),
scalars_not_cloned 14,047, channel_table_grows 0.53, channels_created 1,614
(predicted 800 to 1,200, a miss upward), log_vec_grows 0.90,
trace_vec_grows 1.20 (above the judged at most 1.0; not a falsifier, which
is above 2.0 for the channel table only), print_content.presized equal to
log rows exactly.

### Rounds 1 to 3

Per-round runs per second, candidate over baseline: 1.0313, 1.1129,
1.1821; mean 1.1071, interval [0.9341, 1.3120], not separated, band
[1.061, 1.146] inside, advice inconclusive. Microseconds per run 1.0414,
1.0853, 1.1479; steps per run 1.0416, 1.0264, 0.9642. The mean is outside
the 1.03 to 1.07 zone that was to buy a layout control first, so rounds 4
to 6 were bought.

Counters read by hand off the candidate's dump, per run, rounds 1 to 3:

- frame.default_slots_filled 34,942, 31,606, 30,365 (predicted 29,000 to
  34,000); params_filled 3,432, 3,110, 2,990 (1,400 to 6,000); the sum
  equals slots_built in every round, by construction.
- value_sig.leaf_hashes_deferred 4,180, 3,830, 3,697 (1,000 to 5,000).
- eval_borrow.handles_not_cloned 8,610, 7,790, 7,505, above the predicted
  2,000 to 6,000 - more borrows than priced; the falsifier was below 1,000.
  scalars_not_cloned 13,505, 12,226, 11,761 (5,000 to 15,000).
- run_buffers.channel_table_grows 0.52, 0.46, 0.46 (at most 1.0);
  channels_created 1,447, 1,321, 1,273, above the predicted 800 to 1,200;
  log_vec_grows 0.80, 0.75, 0.74; trace_vec_grows 1.03, 0.99, 0.98, on the
  judged at-most-1.0 line.
- print_content.presized 728, 660, 636 per run; equality with log rows was
  checked exactly on the smokes.
- stats_local.folds 1.00.

Neutrality at three rounds flags the aos and grid arm shares. Per round the
aos share reads 14.53, 16.70, 16.77 percent on the candidate against 16.29,
16.85, 16.72 on the baseline - one outlying first round, then level. The
grid share reads 13.22, 14.89, 14.33 against 13.71, 13.91, 13.83, mixed in
sign. That is a different pattern from iteration 6's consistent half-point
shift, and again read against a spread of only three session rounds.

### Six rounds, finished

Rounds 4 to 6 read 1.0384, 1.0914, 1.1555. Final: mean 1.1005, sd 0.0553,
interval [1.0385, 1.1663], separated from round 5 with the lower edge
rising (1.0170, then 1.0385), band [1.061, 1.146] inside, advice gain.
Microseconds per run 1.0805, interval [1.0293, 1.1343]. Steps per run
1.0199, interval [0.9741, 1.0679]: candidate runs were if anything slightly
longer, so the runs-per-second ratio does not owe its size to shorter runs.
Baseline for 84b7ab5: nine rounds cached (three post-merge, six in session),
3,706.4 runs per second, spread 0.0348.

Two blockers. The structural one: the declared counter is new to the
candidate. And the aos arm share, 15.82 percent on the candidate against
16.51, a gap of 0.69 points against an allowance of 0.66. Per round,
candidate minus baseline in points: -1.76, -0.16, +0.05, -1.07, -1.65,
+0.40. Three rounds with a large gap and three near zero. That is not the
steady shift a change to the search would make; it is when the wall-slice
allocator's boundaries happen to fall, the same allocator effect iterations
5 and 6 recorded. The one-thread identity smoke, where allocation does not
depend on speed, showed identical run rows, arms and variants included.

Counters in rounds 4 to 6, per run: default_slots_filled 36,327, 35,015,
32,838; params_filled 3,587, 3,444, 3,261; leaf_hashes_deferred 4,420,
4,207, 4,083; handles_not_cloned 8,846, 8,579, 7,977; scalars_not_cloned
13,935, 13,466, 12,574; channel_table_grows 0.50, 0.51, 0.45;
channels_created 1,532, 1,455, 1,414; log_vec_grows 0.79, 0.79, 0.75;
trace_vec_grows 1.02, 1.02, 1.00; print_content.presized 754, 727, 686.
The sum identity held in every round. Against the frozen predictions:
default_slots_filled read above 34,000 in two of six rounds,
handles_not_cloned and channels_created above their ranges in all six, and
trace_vec_grows on or just above the judged 1.0 line. None of these is a
falsifier. The channel table's falsifier, above 2.0, did not fire.

### The independent observables: the candidate profile

research/perf/profiles/84b7ab5-cand-value-traffic-composite.md against
84b7ab5.md, 60 s at 30 threads. Self and inclusive shares.

value-construction-without-work:
- Value::new self 3.78 and EcoVec<Value>::reserve self 1.77: both below the
  cutoff; FrameBuilder::finish self 2.36 to 1.93. The three summed fell
  from 7.91 to at most about 3.9 at this cutoff. Frozen: at most 3.5 -
  neither confirmed nor refuted by the cutoff.
- Relocation guard: eval + execute_common_label + build_frame self 13.96 to
  15.70, up 1.74. Frozen: up at most 1.5. **Fired as written.**
- ValueKind::clone self does not rise: 1.38 to 0.75. Held.

eval-borrows-operands:
- ValueKind::clone self down at least 0.25: down 0.63. Held.
- drop_glue<Value> + drop_glue<ValueKind> + EcoVec<Value>::drop self down at
  least 0.5: 5.23 to 5.07, down 0.16. Missed (an expected observable, not
  in the falsifier list).

per-run-buffers-sized-once:
- (ChannelId, ChannelState) reserve_rehash line absent (from 1.15
  inclusive). Held.
- RawVecInner::finish_grow inclusive down at least 1.0: 3.84 to 1.57. Held.
- But malloc inclusive rose 6.60 to 8.52 while realloc fell 3.48 to 1.65:
  realloc plus malloc inclusive is 10.08 against 10.17. The growth cost the
  observable guarded left finish_grow and reappeared as up-front
  allocation of the presized buffers - iteration 2's lesson, met by the
  letter of the observable and not by its intent.

**Calibrating the guard.** Shares are of samples, so removing work inflates
every untouched symbol. Untouched simulation-thread self: the scheduler,
plan engine and RNG lines (schedule_runnable, select_within_queue,
walk_recovery_placebo, score_with_terms, random_range, get_ready_events,
exec_plan) 8.41 to 8.83, x1.05; adding the SipHash, name-lookup and
NodeIndex collect lines, 11.39 to 12.73, x1.12. Parquet writer lines
x1.05 to x1.07. At x1.05 to x1.12 the guarded 13.96 would read 14.66 to
15.63 with nothing relocated; 15.70 sits 0.07 to 1.04 points above that. The
guard did not show a relocation clearly and did not clear one. The judge
wrote it as a raw share difference with no correction for this inflation.
Part of any excess is expected from the diff itself: about 22,000
thread-local counter ticks per run inlined into eval_operand and Hash,
noted in the review before the rounds.

### Decision: merged, with a revert criterion registered before its check

Departure, in writing, from three readings: the relocation guard fired as
written; the lower edge of the primary, 1.0385, lies inside the 0.05
layout floor; and the aos arm share sits 0.03 points outside its allowance.

For merging: runs per second 1.1005 [1.0385, 1.1663] and microseconds
per run 1.0805 [1.0293, 1.1343] both separate over six rounds; steps per
run 1.02, so it is not shorter runs; the one-thread identity run is exact
on all four tables; the value-construction targets fell by at least 4
points; the operand-borrow part moved its clone line; the guard's excess
over measured inflation is 0.07 to 1.04 points; and the aos gap reads
-1.76, -0.16, +0.05, -1.07, -1.65, +0.40 points by round, which is the
allocator's slice timing, not a steady change to the search.

Against, recorded: the attribution is muddier than iteration 6. The buffer
presizing part's allocator saving moved into malloc and may be close to
zero; the drop glue did not move; which part paid is not recoverable from
this session. No layout control was bought: the configured floor would
have to be above 0.10 for the mean to fall inside it, and layout-control-e3
measured a half-width of 0.045.

**Revert criterion, fixed before the post-merge baseline is measured.** The
merge is reverted if the fresh baseline at the merged spur commit reads
below 3,817 runs per second over three rounds, which is +3 percent over the
3,706.4 cached for 84b7ab5 across nine rounds. That reading is not
interleaved and carries the floor's noise, which is why the line sits at
+3 percent and not at the graded 1.10.

### Post-merge baseline: the merge stands

Merged: spur b1fb646, superproject 9602ac9. The fresh baseline at b1fb646
reads 4,304.3 runs per second over three rounds (4,411.9, 4,460.1,
4,041.0), spread 0.0533, against 3,706.4 for 84b7ab5 - plus 16.1 percent,
above the registered revert line of 3,817. Ledger row appended with ratio
1.1005. The implementer worktree and the candidate export were removed.

### Direction review after the merge

Digest for the user: iteration 7 merged a composite of three allocation
mechanisms at 1.10 over six rounds (post-merge check plus 16 percent). The
merge departed from a fired profile guard and a lower edge inside the
floor, with a revert criterion registered first. Cumulative on this loop's
graded workload since call-frame-one-pass, 1.0634 x 1.3217 x 1.1727 x
1.1005, about 1.81.

**Are the costs attacked still the largest ones explainable?** The frame
symbols and the per-value signature work are gone, and ValueKind::clone is
halved. What remains in the interpreter is eval and execute_common_label
self (about 16 points together), store, drop glue that did not move, and
malloc (8.5 inclusive), which now carries the presized buffers. The next
profile, of b1fb646, decides the directive.

**Has the steering paid for itself?** Partly. The self-time pricing rule
worked: every part's target symbols fell. Its weakness showed in the
judge's guard, written as a raw share difference, which a large enough
saving trips on its own. A guard on shares needs a stated inflation
reference, and the loop's rules do not require one; recorded here for the
user, since the skill and prompts are not the loop's to change.

**What the next directives should pull toward.**

- Allocation that moved rather than vanished: malloc inclusive rose 1.9
  points with the presized buffers. Whether up-front capacity pays at all
  on this workload is an open question; an ablation of that part alone is
  the instrument if it is ever worth a round.
- The drop glue on Value and ValueKind (about 3.4 self) and EcoVec drop:
  frames die whole at return, and this iteration left that untouched.
- call-targets-indexed, still proposed at net 3.
- The simulation threads' idle third (grid batch stragglers), search-
  affecting, still owing per-batch off-CPU evidence.

## Iteration 8 - autonomous, data layout lens, profile b1fb646

Preflight carried in session: spur-research-loop inactive, no search-loop
grader, branch research/lite, spur gitlink b1fb646, tree clean at eb58de4,
baseline rebuilt at b1fb646 with a fresh cache (4,304.3 runs per second). No
layout control, same build config hash. Profile: research/perf/profiles/b1fb646.md.

### The profile, read before proposing

The interpreter's dispatch is the largest block and no longer carries an
allocation story: eval 9.77 self, execute_common_label 5.72, 1.20 and 1.09
across specializations, exec 2.70, store 2.60 - about 23 points. Next,
memmove at 2.77 and 1.29 self, 6.45 inclusive: something large is copied on
the hot path. Allocation and frees remain (malloc 8.40 inclusive, EcoVec
drop 6.64 inclusive, drop glue about 3.4 self, imbl map insert 3.68
inclusive). Call-target and name lookups sum to about 4.5 inclusive
(String to NameId get 1.61, hash_one<NameId> 1.62, NameId to FunctionInfo
get 1.30). Trace formatting about 4; scheduler self about 7.

Lens: data layout and representation. Focus directive: what memmove is
moving and at what size; the Expr and Label representation behind eval's
self time; re-pricing call-targets-indexed; per-step scheduler collects
only on a representation argument. Any share-based guard must name its
inflation reference, the lesson of iteration 7.

### Proposals

The proposer first answered the memmove question from hand-derived type
sizes (moderate confidence in the inline-copy threshold): Value 40 bytes,
the eval Result 48, StepOutcome 40 to 48, LogEntry 48, TraceEntry 96, Timer
80 - all copied inline, never through memmove. What reaches memmove: Record
and Runnable at about 256 to 272 bytes, moved 2 to 4 times per record step
and twice per Async; the 152-byte channel table bucket, 1,414 per run; and
runtime-length copies in trace and print formatting. The 2.77 self points
split roughly formatting 9,000 to 18,000 calls, the Record family 5,000 to
9,000, channel inserts 1,400, queue shifts 1,000 to 2,000 per run.
RuntimeError is about 40 bytes; boxing it would remove nothing. The other
3.68 inclusive points are read as page faults on fresh buffers - inference,
since no kernel line prints.

Four hypotheses, all neutral and shared. A share-based guard now names its
inflation reference: R, the summed self of six scheduler and plan lines no
part touches, 4.12 on b1fb646.

- call-targets-indexed, re-priced: a dense per-vertex callee table built in
  compile_program, only the SyncCall and Async arms of exec.rs changed.
  2.3 to 2.9 points, band [1.022, 1.030]. The NodeToString probe
  subtraction is zero on VR, which never calls role_to_string.
- value-without-dead-signature: under NoHashing Value.sig is written 0 and
  never read after iteration 7, so a zero-sized sig gives 32-byte Values.
  1.0 to 2.2 points, band [1.010, 1.025], the least certain pricing.
- channel-table-dense: channel ids are dense per run, so a Vec indexed by
  id replaces the hash table. 1.0 to 1.8 points, band [1.010, 1.018].
- layout-composite: the three together, 4.3 to 6.9 points, band [1.042,
  1.075], lower edge below the floor, stated in advance.

Set aside with reasons: boxing Record (net 0.3 to 0.7 after its allocation),
smaller Result or error types (no memmove call to remove), flattening Expr
(no profile line prices the pointer hops), scheduler collects as inline
arrays (0.4 to 1.0), narrowing NodeId, interning timer labels, bundling
execute_common_label's arguments, imbl ArcK to RcK (feedback must stay
Send).

**Operator note on direction, before judging.** This round's best composite
is smaller than the last two merges' and its lower edge sits under the
floor. The interpreter's remaining self time is dispatch over a tree of
Expr nodes that no single-structure change prices. What the profile does not
show is still larger: the simulation threads' idle third. If the judged
composite cannot be read against the floor, the next direction review
should weigh a structural interpreter change against the search-affecting
batch-straggler lead, rather than a fourth round of per-structure trims.

### Judging

- call-targets-indexed: gain 7, cost 2, net 5. Verified sound: both maps are
  immutable after compile, labels reaching execute_common_label are
  references into cfg.graph, client ops, Init, recovery and re-delivery
  never reach the two arms, VR never produces NodeToString, frame.calls
  2,086.1 per run. path.rs:616-622 keeps 40 to 60 lookups per run.
- channel-table-dense: gain 5, cost 0, rewritten. Emulating hashbrown's
  capacity sequence to keep channel_table_grows equal would make that leaf
  identical by construction and prove nothing; the rewrite uses natural Vec
  growth, predicts the leaf's new value and exempts it from the identity
  comparison in advance.
- value-without-dead-signature: gain 3, cost 0, held. The dead-field claim
  holds; the pricing rested on 280 KB of fresh frame memory per run, false
  since frames are reused from warm allocator chunks, which iteration 4
  already recorded. Band cut to [1.004, 1.012].
- The composite: [1.032, 1.049] for the two admitted parts, [1.036, 1.061]
  with all three. Both lower edges sit under the floor, and a six-round
  interval here runs about plus or minus 0.06. Judged not worth a session
  alone; recommended as a rider on a larger interpreter change.

### Decision: no session this iteration; direction review now

The two admitted parts go into the pool as lookups-dense, a rider, and no
rounds are bought. Reason: the goal's instrument cannot read a band that
lies entirely under its floor, a six-round session would most likely end
no-gain, and "never spend a round on a measurement alone" applies to a
session whose only possible verdict is a floor reading. This is a close in
effect for this iteration, not a refutation: nothing was built or measured.

### Direction review

Triggered by a round whose best candidate cannot be read.

**Are the costs attacked still the largest explainable?** No. Three
iterations of per-structure trims (6, 7, 8) have taken the interpreter's
allocation and copy stories apart; what remains is about 23 points of
dispatch self in eval and execute_common_label, spent walking Expr trees
and matching Labels, and a trim of any one structure prices under the
floor. The largest cost visible anywhere is still off the profile: the
simulation threads' idle third.

**Has the steering paid for itself?** Iterations 6 and 7 merged at 1.17 and
1.10. Iteration 8 steered at memmove and dispatch and found that the moves
are small and the dispatch is not priced by any single structure - a real
answer, cheaply got, but not a candidate.

**Next directives**, at mechanism level:

- A structural change to how expressions execute: compile each Label's Expr
  tree once per program into a form that runs without re-walking the tree
  and re-matching nodes per evaluation (closures, a flat register form, or
  fused operations for the node shapes VR uses most), keeping vertex ids,
  pcs and every observable value identical. lookups-dense can ride along.
- The batch stragglers, with the neutrality question answered in writing
  first: whether grid runs' inputs depend on anything a completed batch
  changes. If assignment is a pure function of run id and config, filling
  idle workers with the next runs changes only admission timing; if not,
  it is search-affecting and owes the search loop's reading. A mechanism
  that needs a utilization counter adds it in the same change.

**Digest for the user (iteration 8).** No candidate was graded. The data
layout round answered its question - memmove is mostly formatting and the
256-byte Record family, not the eval Result - and produced three small,
verified trims whose best composite band, [1.032, 1.049], sits under the
floor; they wait in the pool as the rider lookups-dense. The loop now
steers at two structural leads instead of a fourth round of trims: compiling
expressions once per program in place of re-walking Expr trees per
evaluation, and the simulation threads' idle third from grid batch
stragglers, where the first question is whether a neutral form exists at
all. Tree unchanged at spur b1fb646; cumulative since call-frame-one-pass
about 1.81.

## Iteration 9 - autonomous, redundant-work lens, structural directives

Tree unchanged at spur b1fb646; profile b1fb646.md; preflight carried in
session.

### Proposals

Priced at 1 point about 52 us per run. The dispatch block is 25.52 points:
15.75 on the label side (execute_common_label, exec, exec_sync_inner,
store) and 10.26 on the expression side (eval, eval_operand). No counter
measures labels per run; the proposer estimated 25,000 to 40,000 with a
floor near 9,000.

- compiled-expr-operands: after compile_program each Expr gets a compiled
  form whose children are pre-classified (local slot, node slot, literal,
  subtree), with leaves read inline and fused forms for the common compares,
  int arithmetic, field reads, len and exists; each arm mirrors eval's
  order, errors and counter events; an enum, not closures; Expr and Label
  untouched. 1.5 to 3.5 points, band [1.015, 1.035].
- predecoded-label-ops: a per-vertex Vec of decoded ops run in exec's own
  loop, removing the 15-argument call, the 48-byte return, the Label and
  Instr matches and the out-of-line store; vertices, pcs, effect order and
  Env::writes unchanged. 3.5 to 6.5 points, band [1.035, 1.065].
  lookups-dense rides here.
- grid-ordered-release-pool, declared search-affecting. The proposer's
  answer to the dependency question: grid inputs are not fixed before
  their batch. A slot's parent depends on earlier batches' admissions, a
  fresh run's config index depends on earlier empty-corpus fallbacks, the
  process-global learners are read at run start and merged at run end, and
  wall slices hand a faster arm more runs. The mechanism starts a batch's
  fresh runs early when the corpus's remaining child count covers all of
  its slots, and releases slot runs only after earlier fresh runs are
  admitted in batch order, at most four batches ahead. Priced from grid
  busy share 0.596 (2.82 ms idle per grid run), a straggler model and an
  SMT contention discount: band [1.07, 1.21], with frozen arm-share moves.
- compiled-interpreter: the two A parts plus lookups-dense, band [1.084,
  1.156], lower edge clear of the floor; guard on the dispatch block against
  the untouched-scheduler reference R.

Set aside: closures per node, stack bytecode (it would bring back the clones
and drops iteration 7 removed), fusing multi-label f-string prints (it would
skip temp writes and CFG edges; about 686 prints per run with 3 to 4
allocations each stays a lead), precomputed field-key hashes, an AOS pool,
changing batch_size (a config change), oversubscription.

### Judging

- compiled-interpreter (the two A parts plus lookups-dense): gain 6, cost 2,
  net 4, first session. The evaluator's structure, the absence of Program
  mutation after compile, every label execution site and the order
  constraints to mirror were verified. False as written: "exec unit tests
  pass unmodified" (their Program builder lists every field). Weakest
  evidence: most of store's 2.60 is Env::set's body, which stays; H1's 5 to 8
  ns per leaf is unmeasured. The judge added an all-variant dual-evaluator
  equivalence test, a second-spec identity smoke and release-build legacy
  counters, since a legacy count of 0 proves coverage and not equality.
  Band trimmed to [1.08, 1.15] for double counting between the parts. One
  correction to the shared arithmetic: a point is 42 to 47 us per run on
  round 5, not 52.
- grid-ordered-release-pool: gain 6, cost 2, net 4, second. The dependency
  answer and the utilization arithmetic reproduced exactly; gated batches
  are common (8.3 percent of slot draws found the corpus empty) and SMT
  contention was underestimated, so a falsifier on grid microseconds per
  run was removed and the band moved to [1.06, 1.22]. It stays in this
  loop, declared affecting, and owes the lite grader's non-inferiority
  reading before a merge; the protocol panel never runs GridArm.
- Neither part alone of the compiled interpreter was admitted.

### Decision: build compiled-interpreter

Top by net with the grid pool, and ahead of it because it needs nothing
outside this loop to merge. Band [1.08, 1.15], lower edge clear of the floor.
grid-ordered-release-pool is the next candidate after this one's session,
with its owed reading written into the pool.

### Review of the diff

compiled-interpreter, 2,018 patch lines plus three new files (compiled.rs
481 lines, compiled_eval.rs 470, its test 406). Stays in spur-core;
super.patch carries only the gitlink; no config field, no template edit, no
treatment bit. Checked against the legacy arms by reading:

- Assign, Cond and Return: kept positions clone the slot value as eval's
  Var arm does; read-only positions record the same borrowed-operand event
  as eval_operand; CondLocal and CondNode record it too.
- Fused forms: NotEquals evaluates as Not(EqualsEquals); FieldGet as Find
  with a string-literal key, including the type error on a list.
- SyncCall: callee, is_sync check, then arguments, as the legacy arm. Async:
  target, arguments, channel id allocation and insert, store, callee lookup,
  frame, link sequence, send ordinal, priority draw, purgatory - the legacy
  order, so no draw or id allocation moves. An unresolved callee falls back
  to the name maps with the same error.
- Record-only operations reached from a sync function return the same
  UnsupportedSyncInstruction text, built from the label's Debug form.
- The first-delivery timeline note compares against a role id resolved at
  decode instead of scanning roles by name.
- ChannelTable indexes by id and checks the stored id on lookup; insert_new
  panics in release builds if an id arrives out of order, a guard on the
  density the iteration 8 judge verified.
- Interpreter counts go into a stack-local tally flushed once per exec or
  exec_sync_on_node call; the per-operand borrowed tick already existed.

Implementer's checks: all spur-core tests pass; the all-variant differential
test covers the 44 Expr variants under both hash policies in kept and
read-only positions, comparing value, signature, error text and Debug form,
borrowed versus owned, and counter deltas; three new exec tests compare
the two loops across calls, loops, channels and the error cases. One-thread
identity smokes against b1fb646 are exact on VR (3,008 runs), Mencius_opt1_2
(2,160) and SDPaxos (2,160) - SDPaxos chosen for IsVariant, Variant,
VariantPayload and NodeToString - with the same stall_cap_runs.csv hashes
and no pre-existing dump leaf differing except a clock and the disclosed
run_buffers.channel_table_grows. 30-thread smoke per run: label_execs
38,347, legacy counters 0, leaf_operands_inline 55,249, tree_evals 15,746,
call_targets.indexed 2,323 (0.973 of frame.calls), fallback 0,
lookup_misses 0, dense_inserts equal to channels_created exactly.

Two readings carried into grading. channel_table_grows reads 0.83 on the
smoke against the disclosed 0.40 to 0.70: a prediction miss, not in the
falsifier list, because exact-capacity growth from the previous run's
length grows at least once whenever a run is longer than the last. And the
frozen spread-check falsifier on steps, end reasons and per-arm counts,
which every candidate large enough to matter has tripped through the
allocator's response to throughput; it is read as frozen.

Operator slip at start, no effect on the session: the first `start` for
compiled-interpreter was guarded by `pgrep -f "lite/grader.ts"`, which
matched its own shell, so the chain stopped before the grader ran and
nothing was written. Rerun with a bracketed pattern; search loop inactive,
no search-loop grader running; session registered with the frozen
declarations, band [1.08, 1.15] and counter compiled_ops.label_execs.

### Rounds 1 to 3

Per-round runs per second, candidate over baseline: 1.1517, 1.0982,
1.1908; mean 1.1463, interval [1.0362, 1.2681], separated, band [1.08,
1.15] inside, advice gain. Microseconds per run 1.1413, 1.1011, 1.1720;
mean 1.1378, interval [1.0527, 1.2297]. Steps per run 0.9981, 1.0354,
0.9550; mean 0.9956. Baseline for b1fb646: six rounds cached, 4,269.0 runs
per second, spread 0.0390. Rounds 4 to 6 bought: the lower edge sits inside
the floor and the neutrality rows below could clear or persist.

Counters read by hand off the candidate's dump, per run, rounds 1 to 3:

- compiled_ops.label_execs 33,195, 35,214, 31,421 (20,000 to 50,000);
  legacy_labels 0 in every round.
- compiled_expr.leaf_operands_inline 47,878, 50,773, 45,258, above the
  eval_borrow sum in every round (20,234, 21,456, 19,356); tree_evals
  13,728, 14,546, 13,104 (8,000 to 25,000); legacy_evals 0.
- call_targets.indexed 1,980, 2,104, 1,837, that is 0.976, 0.976, 0.974 of
  frame.calls (0.95 to 1.00); fallback 0.
- channel_table.lookup_misses 0; dense_inserts equal to
  run_buffers.channels_created exactly (1,363, 1,451, 1,255); lookups
  2,119, 2,255, 1,939.
- run_buffers.channel_table_grows 0.75, 0.77, 0.75, above the disclosed
  0.40 to 0.70 - a prediction miss, not in the falsifier list.

Every counter falsifier held. Two neutrality rows flagged at three rounds.
Grid arm share, candidate over baseline in points: +0.84, +0.32, +1.21
(15.17, 14.68, 15.30 percent against 14.33, 14.36, 14.09) - consistent in
sign, like iteration 6's shift and opposite in direction. iterations_exhausted
share: -1.81, +0.86, -2.10 points - mixed in sign. These rows come under the
frozen spread-check falsifier, which every candidate large enough to matter
has tripped through the wall-slice allocator's response to throughput; a
consistent grid shift that survives six rounds owes a written decision.

### Six rounds, finished

Rounds 4 to 6 read 1.3216, 1.2491, 1.1846. Final: mean 1.1972, sd 0.0643,
interval [1.1191, 1.2808], separated since round 3 with the lower edge
rising (1.0362, 1.0483, 1.0977, 1.1191), band [1.08, 1.15] read inside, advice
gain. Microseconds per run 1.1718, interval [1.1095, 1.2375]. Steps per run
0.9587, interval [0.8972, 1.0244]: the candidate's runs were 13.9 and 6.4
percent shorter in rounds 4 and 5, so runs per second overstates the
per-run saving in those rounds and microseconds per run is the cleaner read
of the session. Baseline for b1fb646: nine rounds cached, 4,167.8 runs per
second, spread 0.0492.

Blockers. The structural one: compiled_ops.label_execs is new to the
candidate. And the spread check, which is also a frozen falsifier of this
candidate: iterations_exhausted 20.14 against 21.88 percent (allowance
1.26 points), stall_cap_reached 34.23 against 31.95 (allowance 2.22), grid
arm share 15.05 against 13.89 (allowance 0.98). Steps per run, the other
end reasons and the other four arm shares sit inside.

That pattern - more stall-cap stops, fewer exhausted runs, shorter runs,
one grid arm's share moving - is the one iteration 5 read on
thread-local-stats-blocks and resolved with a one-thread identity run at
100,000 runs with both learned caps engaged. The fixed-count identity smokes
this candidate passed ran 2,160 to 3,008 runs, too few for the caps to
engage, so they do not reach the cap path. The same caps-engaged run is
bought now, after the candidate profile, before any decision: config
general_vr.json with session_seed 1000, slices of 20,000 runs, one round,
one thread.

### The independent observable: the candidate profile

research/perf/profiles/b1fb646-cand-compiled-interpreter.md against
b1fb646.md, read with one parser over the inclusive section's self column.
The parser reproduces the judged baseline figures exactly: dispatch block
26.01, R 4.12, Sip13 write self 2.06.

- The dispatch block - execute_common_label, exec and exec_sync_inner in
  every specialization, eval, eval_operand, store, plus every new compiled
  symbol (ceval, exec_ops, run_sync_ops, run_async_op, the trace ops, and
  the legacy names still present) - reads 19.00 self. R on the candidate is
  4.83, so r = 1.172 and the frozen limit 21.01 x r is 24.63. **Held**,
  and it holds uncorrected too: 26.01 to 19.00. The top of it is now ceval
  6.37, exec_ops 4.79 + 1.06 + 0.95 and run_sync_ops 2.67 + 0.58 + 0.54.
- r = 1.172 equals the graded microseconds per run, 1.1718: two independent
  instruments agreeing on how much work left the profile.
- The four lookup lines - HashMap<String, NameId>::get 1.61,
  hash_one<&String> 1.08, hash_one<&NameId> 1.62 and HashMap<NameId,
  FunctionInfo>::get 1.30 inclusive - are all below the reporting cutoff of
  about 1.0. The frozen threshold is below 0.2 each, which this cutoff
  cannot confirm or refute; recorded as down by at least 0.08 to 0.62
  points each (baseline minus the cutoff), not as the threshold met.
- Sip13 write self 2.06 is below the cutoff; frozen at most 1.1 x r = 1.29.
  Held by the cutoff.

### One thread, caps engaged: identical

Bought after the six rounds, before any decision, exactly as iteration 5 did:
general_vr.json with session_seed 1000, slices of 20,000 runs, one round,
RAYON_NUM_THREADS=1, 100,000 runs per side, baseline b1fb646 against the
candidate binary. Result file: tmp/loop/perf/identity-caps/result.md.

- Both caps engaged on both sides with identical figures: stall_cap 22,514
  stops over 70,260 treated runs, cap_max_scope 899, run_cap 2 recomputes,
  3,143 probes and 987 completions.
- runs 100,000 rows, executions 24,094,053 (payload included), logs
  76,197,352, traces 86,370,102: 0 rows in either direction of EXCEPT ALL on
  every column except the runs table's two clock columns. logs and traces
  exhausted a 13 GB duckdb limit whole and were compared the same way in ten
  run-id ranges of 10,000.
- End reasons identical: deadlock 19, iterations_exhausted 30,030,
  learned_cap_reached 18,308, plan_complete 29,129, stall_cap_reached 22,514.
  Sum of steps_used 219,951,576 on both.
- Utilization dump: 6,983 baseline leaves all present; the candidate adds
  only the 10 new counter leaves; two differ, history_writer.busy_ns (clock)
  and run_buffers.channel_table_grows (disclosed). Campaign report: 25
  differing leaves, all clocks, busy_ns or the disclosed grow counter, plus
  the new counters under each arm.
- stall_cap_runs.csv: the same sha256 on both sides.

The change does not alter what the explorer searches, on the cap path
included. The three rows the 30-thread spread check flagged - more stall-cap
stops, fewer exhausted runs, a higher grid arm share - are the learned caps
responding to runs finishing sooner, which is the concurrency effect
iteration 5 isolated the same way.

### Decision: merged, with a revert criterion registered before its check

Departure, in writing, from one frozen falsifier: the spread check on end
reasons and per-arm counts fired as written (iterations_exhausted,
stall_cap_reached, grid arm share). The reason is the caps-engaged
one-thread identity run above, which is the instrument that separates a
change to the search from a response to throughput on this workload, and
which reads identical. Every other frozen falsifier held: primary 1.1972
[1.1191, 1.2808] clears 1.08; microseconds per run 1.1718 [1.1095, 1.2375];
legacy_labels and legacy_evals 0 in every round; label_execs 31,421 to
35,214; leaf_operands_inline above the eval_borrow sum; call_targets.fallback
and lookup_misses 0; dense_inserts equal to channels_created; the dispatch
block guard 19.00 against 24.63. The four lookup lines sit below the
profile's cutoff, which cannot confirm their frozen below-0.2 thresholds;
that is recorded, not waived.

Revert criterion, fixed before the post-merge baseline is measured: the
merge is reverted if the fresh baseline at the merged spur commit reads
below 4,293 runs per second over three rounds, +3 percent over the 4,167.8
cached for b1fb646 across nine rounds.

### Post-merge baseline: the merge stands

Merged: spur 7f607e6, superproject 7209003. The fresh baseline at 7f607e6
reads 5,012.3 runs per second over three rounds (5,151.5, 4,715.9, 5,169.5),
spread 0.0512, against 4,167.8 for b1fb646 - plus 20.3 percent, above the
registered revert line of 4,293. Ledger row appended with ratio 1.1972.
The implementer worktree and the candidate export were removed; the
identity run's result, dumps, campaign reports and stall-cap tables are kept
under tmp/loop/perf/identity-caps/ and summarized above.

### Direction review after the merge

Digest for the user: iteration 9 merged the compiled interpreter at 1.20
over six rounds (post-merge check plus 20 percent), carrying the dense
call-target and channel tables with it. It departed from a frozen spread-check
falsifier on a one-thread, caps-engaged identity run over 100,000 runs that
read identical. Cumulative on this loop's graded workload since
call-frame-one-pass: 1.0634 x 1.3217 x 1.1727 x 1.1005 x 1.1972, about 2.17.

**Are the costs attacked still the largest explainable?** The dispatch block
fell from 26.01 to 19.00 self and its shape changed: ceval 6.37, exec_ops
about 6.8, run_sync_ops about 3.8. Allocation (_int_malloc 3.95 self,
memmove 3.22 and 1.47), drop glue and EcoVec drop, trace formatting and the
scheduler are next. The profile of 7f607e6 decides the next directive.

**Has the steering paid for itself?** Yes. Iteration 8's decision not to
spend a session on trims under the floor, and to steer at a structural
change instead, produced the largest merge since thread-local-stats-blocks.
The judge's equivalence obligations (an all-variant differential test,
identity on a second spec) cost little and made the later neutrality
question a matter of one run rather than argument.

**What the next directives should pull toward.**

- grid-ordered-release-pool, queued at net 4: the simulation threads' idle
  third, declared search-affecting, with its shadow-assignment smoke, perf
  grade and the lite grader's non-inferiority chunks written into the pool.
  It is the largest cost visible anywhere and the next candidate.
- The compiled evaluator's own cost: ceval now carries 6.37 self; value
  construction and drop in its arms, and the per-evaluation Result plumbing,
  are the candidates to price on the new profile.
- The spread check has now flagged every candidate above about 10 percent on
  this workload through the learned caps; the caps-engaged one-thread
  identity run is the instrument that has resolved it twice. Recorded for the
  user: the grader could carry that check, but the grader is not this loop's
  to change.

## Iteration 10 - autonomous, grid-ordered-release-pool

Preflight carried in session: spur-research-loop inactive, branch
research/lite, spur gitlink 7f607e6, tree clean at 188ecdf, baseline rebuilt
at 7f607e6 with a fresh cache (5,012.3 runs per second). No layout control,
same build config hash. Profile: research/perf/profiles/7f607e6.md.

### The profile, and why this iteration does not propose

On 7f607e6 the interpreter's decoded dispatch still leads - ceval 6.55 self,
exec_ops 4.74 and 1.09, run_sync_ops 2.70 - followed by schedule_runnable
across four specializations (about 8.3), allocation (_int_malloc 3.90,
malloc 1.44, cfree 1.25), memmove 3.12 and 1.50, drop glue on Value and
EcoVec drop (about 4.2), FrameBuilder::finish 2.04 and trace formatting
(format_escaped_str 1.81, write_to 1.50). None of this prices the largest
cost the loop can explain, which an on-CPU profile cannot see: the
simulation threads' idle third behind grid batch stragglers.

The pool's queued candidate, grid-ordered-release-pool, was judged at net
4 in iteration 9 with its frozen prediction written then, so this iteration
builds it rather than spending a proposal round. Declarations frozen at
admission: search-affecting, shared saving, band [1.06, 1.22], primary
counter grid_pool.worker_idle_ns (0.2 to 1.3 ms per grid run), exactness
counters shadow_mismatches and unfilled_in_ungated_batches at 0, a one-thread
identity run, and before any merge the lite grader's non-inferiority chunks
recorded here, with the protocol panel noted as blind to GridArm. The
utilization it was priced on (grid busy share 0.596) was measured on b1fb646;
the compiled interpreter shortened runs since, which changes the straggler
distribution but not the frozen prediction.

### The lite reading this candidate owes, restated against the live rule

The iteration 9 judge wrote the owed non-inferiority reading as "depth>=4
and h2 at the 25 percent relative margin, per run". Those rungs belong to
the lite grader's retired v1 rule. The live rule is internal-primary-v3
(research/orchestrator/src/decide.ts): primary depth>=8 events per
explore-second, advance rungs depth>=8, 9 and 10, and deep guards depth>=6
and depth>=8 read per run against DEEP_RUNG_MARGIN = 0.25 with a posterior
reading of held, unresolved or regressed. That per-run deep guard is the
reading the judge's clause was written to require - runs getting shallower
while the per-second rate is bought with throughput - so it is the reading
recorded here before any merge, taken from the lite grader's own `finish`
on a cross-binary session (no treatment bit exists for this mechanism).
h2 per run is recorded beside it as description. The protocol panel runs
without the campaign block, so GridArm never executes there; if run, it is
recorded as blind to this mechanism, not as clearance. The prediction's
band, counters and falsifiers are otherwise unchanged; only the rung names
are brought to the rule that will actually be computed.

Lite grader preflight, for the owed reading: `selftest` zero failures, rule
internal-primary-v3, primary rung depth>=8, grader version
ta:a32cc37+porc:ebf06c5+oracle:390ec49e, overdispersion charged 1.3. No lite
baseline cache exists for spur 7f607e6 (7f56e2e0eeb5-...-s3d907a50.json), so
the first chunk of a lite session measures one at about twice the wall. The
selftest's own warning bounds what cross-binary lite chunks can show: the
recorded baseline's stratified depth>=8 chunk cv charges the cross-binary
rung with no separable effect below 4.0 percent at the 4-chunk cap, so the
lite session is read for regression and the per-run deep guards, not for a
gain.

### Review of the diff

grid-ordered-release-pool, 1,538 patch lines, no untracked files, all in
spur-core (campaign.rs, explorer.rs AOS timing, replay_corpus.rs,
util_stats.rs, the export completeness test); super.patch carries only the
gitlink. Checked by reading:

- Assignment exactness. The grid cursor and corpus move into an Assigner.
  A batch is issued covered when the corpus's remaining children, less the
  slots reserved by unreleased batches, cover its own slots; only then are
  its fresh runs assigned at issue. An uncovered batch is issued only once
  every earlier batch is admitted and is released whole on the spot, so
  every unreleased batch is covered and fresh runs take cursor values in
  batch then position order, exactly as sequential batches would, while a
  covered batch's slots cannot find the corpus empty and so never advance
  the cursor.
- Admission exactness. Slots are drawn only after every earlier batch's
  admissions are applied; a batch's admissions are applied in position order
  once its fresh runs have finished. Corpus::remaining_children never falls
  on admit - at capacity the dropped parent's remainder is at most
  CHILDREN_PER_PARENT, which the new parent replaces - and its test drives
  2,000 mixed draws and admissions.
- Slice semantics. SliceLimit::next_batch reproduces the old loop's order of
  checks (spent, cancelled, remaining), so a runs-budget slice still issues
  exactly its runs and StrategyArm (AOS) keeps its batched step. The pool
  drains before run_slice returns, so no slice has runs of two arms in
  flight.
- Tests: the pool against a sequential reference on a synthetic arm with
  out-of-order completions, on a full corpus and on one that runs empty,
  with cursor, admission sequence, remaining children and run ids compared
  after every slice; one worker starts runs in id order; slice-end drain;
  a disagreeing shadow is counted.
- Counters: grid_pool.* per slice (not on the hot path), the debug-only
  shadow check on every batch, and batched_* leaves timing today's
  whole-batch idle on the AOS path.

Two notes. The AOS path adds one shared-atomic fetch_add per AOS job to sum
job wall - per run, not per step, but a contended write all the same. And
the coordinator blocks on a channel while jobs run, which is safe only
because the campaign slice loop runs on the main thread rather than on a
pool worker; a caller that ran run_slice from inside the pool would idle a
worker.

Implementer's checks so far: spur-core tests pass; the one-thread identity
run against 7f607e6 is exact on runs, executions, logs and traces, the
stall_cap_runs.csv hash and every pre-existing leaf, with only grid_pool
leaves added. The 30-thread debug shadow smoke (3,000 s wall budget) and the
release smoke are still to come.

### The debug shadow smoke

A debug build at 30 threads on the campaign workload, stopped with Ctrl+C
after two slices per arm (ten slices, each 140 s), which also exercised
cancellation: the in-flight runs drained and every report was written.

- grid_pool.shadow_mismatches 0 over 10,006 grid batches, each checked run by
  run against a sequential one-batch-at-a-time assignment. Frozen: 0,
  over at least 1,000 batches per grid arm. Held.
- grid_pool.unfilled_in_ungated_batches 0. Frozen: 0. Held.
- grid_pool.capacity_gated_batches 6.9 percent overall: grid 18.2 percent,
  grid-short 10.8, grid-no-purgatory and grid-post-fault-2 one batch each.
  Frozen: 5 to 45 percent, concentrated in the arms carrying unfilled slots.
  Held, and concentrated exactly there.
- grid_pool.fresh_ahead_launched 43.7 percent of grid runs. Frozen: 25 to
  50 percent. Held.

### The release smoke, and a falsifier that fires on counts

The implementer's 30-thread release smoke (60 s wall on general_vr.json)
read the mechanism inside every utilization prediction: grid_pool idle
0.583 ms per grid run (per arm: grid 1.65, grid-short 0.31,
grid-no-purgatory 0.77, grid-post-fault-2 0.07; predicted 0.2 to 1.3 in
total), busy share 0.894 (predicted 0.78 to 0.96), 15.2 percent of grid
batches gated, 38.5 percent of grid runs launched ahead,
unfilled_in_ungated_batches 0. The AOS batched path in the same binary read
2.99 ms idle per run at busy share 0.568, the whole-batch barrier the grid
arms no longer have.

It also read history_writer.queue_full_sends 275,050 and blocked_ns 252 s.
The frozen falsifier says queue_full_sends stays 0. Read against the grading
rounds already on disk:

- compiled-interpreter's baseline side (b1fb646, about 4,200 runs per
  second): 0 full-queue sends in all six rounds, writers about 300 s busy per
  120 s round.
- compiled-interpreter's candidate side, which is today's tree (about 5,000
  runs per second): full-queue sends in 5 of 6 rounds (358, 543, 19, 180,
  2,367), blocked up to 0.9 s, writers about 345 s busy per round - about 72
  percent of four writers' 480 s.
- Earlier sessions (lookups-and-format-once, value-traffic-composite): 0.

So the parquet writers became the ceiling at the last merge, and the grid
pool drives past it: 252 s blocked over 30 threads in 60 s is about 14
percent of simulation-thread time spent waiting for queue room. The
falsifier's premise, that the baseline sends none, is stale, but the
reading it exists to catch is exactly this one: freed worker time that
cannot become runs because the writers cannot take them.

### Decision: closed without rounds

The frozen falsifier fires by counts in a way no grading round can reverse:
a round cannot bring 275,050 full-queue sends to 0, so no round could change
the decision, and none were bought. Not a refutation of the mechanism, which
held every exactness prediction (identity exact; 0 shadow mismatches over
10,006 batches; 0 unfilled draws in ungated batches) and every utilization
prediction; a refutation of the band as reachable on today's writer
capacity. The lite reading it owed is moot. Patch kept at
research/perf/patches/grid-ordered-release-pool.spur.patch; the smoke dumps
are under tmp/loop/perf/grid-ordered-release-pool/keep/.

### Direction review

Digest for the user: iteration 10 built the grid batch-straggler pool, the
largest cost the loop could explain. It works - exact assignment, idle time
cut from about 2.8 ms to 0.6 ms per grid run - but its own falsifier caught
that the parquet writers are now the ceiling: today's tree already fills the
writer queue at about 5,000 runs per second, and the pool made simulation
threads wait 252 s in a 60 s run for queue room. Closed, patch kept. Tree
unchanged at spur 7f607e6; cumulative since call-frame-one-pass about 2.17.

**Are the costs attacked still the largest explainable?** No. Throughput on
this workload is now bounded by the four parquet writer threads, not by
simulation-thread work: at the next merge's throughput the writers saturate,
so any further simulation-side saving will read partly as blocked time.

**Has the steering paid for itself?** Yes. The frozen falsifier on writer
backpressure, added by the iteration 9 judge from the writer headroom
measurement, stopped a session that would have read a diluted gain and hid
its cause.

**Next directives.** A writer-side mechanism that raises writer capacity per
run without moving the cost onto simulation threads. The earlier replay
bench found producer-built arrays cut writer CPU 17 to 26 percent for about
100 us per run on simulation threads - a net loss then, with writers at a
quarter to a third busy, and the change the note said to reach for above 80
percent busy. The writers are near that now, and the grid pool is waiting on
it. Writer thread count is a code constant tied to rayon threads (threads / 8
rounded up); more writers oversubscribe 32 logical CPUs, so a count change is
a contention question, not a free lever.

## Iteration 11 - autonomous, contention lens, the writer path

Tree unchanged at spur 7f607e6; profile 7f607e6.md; preflight carried in
session.

### Proposals

Priced from the writer-thread lines of the profile and the
history_writer counters on disk. Today's tree (compiled-interpreter
candidate rounds): 4,910 runs per second, 582 us of writer busy per run,
0.23 s blocked per 120 s round. The grid pool's release smoke: 5,206 runs
per second, 657 us writer busy per run (3.42 of 4 writers busy), 805 us per
run blocked on simulation threads. Writer samples are 11.32 percent of the
profile: frees about 20 percent of that, memmove 17, Int64 dictionary
interning 11.7, byte-array encoding 29.

- text-rows-born-contiguous: each run's text columns (trace payload, log
  content, executions payload and action) are written into one byte buffer
  with end offsets instead of about 2,200 separate Strings, the writer
  builds StringArrays without copying, and the buffers come back through a
  bounded free list so nothing large is freed across threads. Riders: the
  run row travels in the Write command, schemas built once. Unlike the
  measured producer-built arrays it copies no text on the producer, so
  simulation threads get cheaper too (about 1,900 fewer allocations per
  run). Writer busy per run 582 to 415-505 us, counter band [1.15, 1.40];
  runs per second alone [1.01, 1.05].
- integer-columns-delta-encoded: dictionary off and DELTA_BINARY_PACKED on
  the counter-like integer columns (run_id, seq_num, step, unique_id,
  trace_id, schedulable_count, causal_operation_id). Writer busy 25-55 us
  less per run, output 0.85 to 0.97 of today; combined with the first,
  counter band [1.19, 1.50].
- caller-runs-overflow-encode: a simulation thread that finds the queue full
  encodes the oldest queued run itself if a helper slot is free. Only
  meaningful beside the grid pool; build only if the first two plus the pool
  still block 30 s or more per 60 s.
- Recommended: the first two together, graded on writer busy per run; then
  the grid pool as a composite on top, runs per second [1.09, 1.25].

Set aside: partial producer-built arrays or per-thread builder reuse,
accumulating runs per write (measured slower), a larger queue (absorbs
bursts, not a saturated rate), more writer threads (oversubscription),
dictionary off on strings (output 1.1x to 3.7x), statistics off, compression
changes, the function_name Arc, moving JSON formatting onto writers, a parquet
path without Arrow.

The proposer also suggested relaxing the grid pool's frozen falsifier from
queue_full_sends 0 to blocked time at most 80 s per 60 s. That is a rewrite
of a frozen prediction after the fact; the judge is asked whether it is
admissible or whether the pool must be re-admitted as a new candidate.

### Judging

- text-rows-born-contiguous: gain 6, cost 2 (history.rs, exec.rs), net 4.
  Zero-copy array construction verified against the arrow and parquet 58 APIs
  in Cargo.lock; every reader sorts explicitly, so read-back is identical;
  writer profile lines as claimed. False as priced: executions allocations
  (354 per run, not 614), so about 1,600 allocations saved, not 1,900; and
  spur-cli has no parquet dependency (the arrow-rs reader is
  spur-core/src/debug.rs). The earlier replay bench already measured a
  comparable writer-side saving, 1.195. Rewritten: a 64-set free list with a
  1 MB oversize drop, offsets kept on the writer, the busy timer ending after
  recycling. Two instrument notes: queue_full_sends halves per run by
  construction (one send instead of two), so only blocked_ns compares across
  the change; blocked_ns cannot be a ratio primary because baseline rounds
  read 0.
- integer-columns-delta-encoded: gain 4, cost 2, net 2. Supported and read
  back by every reader; saving capped by the old dictionary-off replay; band
  cut to [1.03, 1.08]; a second commit graded alone after the first merges.
- caller-runs-overflow-encode: gain 3, cost 2, net 1, parked. Missing a
  shutdown clause for helper-slot files and a memory clause; its
  near-zero-sends premise is false on today's tree.
- The grid pool: relaxing its frozen falsifier from queue_full_sends 0 to a
  blocked-time threshold chosen after the reading is not admissible. It
  returns, if at all, as a new candidate with its own declarations, frozen
  after this iteration's grade has measured writer busy per run.

### Decision: build text-rows-born-contiguous

Top by net and first in the judge's order. Search-neutral, shared, counter
primary history_writer.busy_ns per run with band [1.15, 1.40]; runs per
second read cross-binary for regression only, since the writer ceiling binds
only lightly on today's tree. Owed before any round: one-thread identity on
the four tables and porcupine exit codes; by hand, output bytes per run in
[0.97, 1.03] and peak RSS at most 1.05x.

### The implementation, and three readings against the frozen prediction

text-rows-born-contiguous: 1,820 patch lines plus a new text_buffer.rs (270
lines), in spur-core (simulator.rs, exec.rs and its test, state.rs,
explorer.rs, history.rs, path.rs, util_stats.rs, the completeness test);
super.patch only the gitlink. The implementer's checks:

- One-thread identity against 7f607e6 (seed 1000, 3,008 runs): executions
  1,167,064 rows, logs 3,377,240, traces 3,701,447 and runs 3,008 identical
  both ways; porcupine exit 0 on both; the same stall_cap_runs.csv hash; no
  utilization leaf differing outside clocks - queue_full_sends and
  blocked_ns equal on this workload. Output bytes per run 1.0000 on
  executions, logs and traces (runs 1.0007 from the wall columns). Peak RSS
  0.984x.
- 30-thread smoke, 45 s per binary, counters only: busy_ns 346.5 us per run
  against 577.5 on an unpaired baseline session; blocked_ns and
  queue_full_sends 0 on both; commands 1.000 per run;
  text_buffers_allocated 0.025, recycled 3.976, dropped_oversize 0.024 per
  run. Peak RSS 996,896 kB against 901,432 kB, 1.106x.
- On the identity workload text_buffers_allocated read 0.117 and
  dropped_oversize 0.066 per run: VR's trace payload text per run has a
  median of 15 KB and a maximum of 8.4 MB, and 121 of 3,008 runs exceed the
  1 MB recycling cap the judge froze.

Against the frozen falsifiers. text_buffers_allocated and dropped_oversize
are frozen per run "in every round", which is the graded 30-thread workload:
there they read 0.025 and 0.024, under the 0.05 falsifiers, while
allocations miss their predicted 0.01. Peak RSS is frozen as one 30-thread
60 s smoke per binary at most 1.05x; the implementer's pair ran 45 s and
read 1.106x, near the specified measurement but not it, with a plausible
cause that is exactly what the clause guards - recycled buffers keeping
their largest capacity. It is re-measured now as frozen, one 60 s run per
binary in sequence, before any grading round.

### Peak RSS as frozen, and the review

One 30-thread, 60 s campaign run per binary in sequence under /usr/bin/time
-v (tmp/loop/perf/rss-trbc/): baseline peak RSS 968,476 kB, candidate
1,010,796 kB, 1.0437x. Frozen: at most 1.05x. **Held.** The 45 s pair's
1.106x rested on a baseline that peaked at 901,432 kB. The same runs' dumps:
candidate history_writer.busy_ns 337.3 us per run against 670.9 on the
baseline (unpaired, not a graded reading), blocked 0 s against 0.14 s,
queue_full_sends 0 against 278; text_buffers_allocated 0.0249,
recycled 3.976, dropped_oversize 0.0241 per run, both falsifier counters
under 0.05; commands exactly 1.0 per run.

Review of the diff (1,820 patch lines plus text_buffer.rs, 270 lines): each
row's text is appended to the run's buffer and the row records where it
ends, starting where the previous row ended; the set is taken from a
64-slot ArrayQueue at run start and returned by the writer after the
RecordBatch and every row structure are dropped, with the busy timer ending
after that. string_column checks in release builds that offsets never
decrease, lie on character boundaries and fit i32, and the buffers accept
only &str and serde_json output, so new_unchecked's UTF-8 and offset
requirements hold. The dispatch payload copy for TraceEnter is taken from
the buffer before the row is recorded. Tests compare written parquet
column data against arrays built one string per cell across all four tables,
including empty tables and non-ASCII text.

Two notes. The memory bound is loose in the worst case: 64 free sets, 128
queued runs and 30 in-flight runs, each up to four buffers near 1 MB, could
hold several hundred MB for a spec with very large texts; on VR the measured
cost is 42 MB. And runs.wall_us is now computed before the single send, so it
no longer includes time a run spends blocked on a full queue; a
microseconds-per-run reading is flattered wherever the baseline blocks,
which here is 0.14 s per 60 s. The primary is the counter.

### Rounds 1 to 3

Primary, history_writer.busy_ns per run, baseline over candidate: 1.7775,
1.7185, 1.6915; mean 1.7288, interval [1.6233, 1.8411], separated, band
[1.15, 1.40] read above - the whole interval clears the band's upper edge.
A prediction missed on the high side, not a falsifier (the falsifier is an
interval entirely below 1.15). Per round, candidate 332.5, 338.6, 336.4 us
against baseline 591.1, 581.9, 569.0 us. The replay bench's 1.195 was the
writer's text copy alone; the graded workload adds the cross-thread frees
and per-cell array construction the bench did not charge.

Runs per second, confirmation only: 1.0889, 1.1127, 1.0558; mean 1.0855,
interval [1.0167, 1.1590] - not separating downward, and above its expected
[1.01, 1.05]. Microseconds per run 1.0601; steps per run 0.9840.

By hand, every round: history_writer.commands 1.0000 per run;
text_buffers_allocated 0.0210, 0.0206, 0.0232 and dropped_oversize 0.0206,
0.0202, 0.0229 per run, under their 0.05 falsifiers and above the predicted
0.01; candidate blocked_ns 0 and queue_full_sends 0 in every round, while the
baseline blocked 1.56 s (3,550 sends), 0.06 s (124) and 0 s.

One frozen falsifier stands as written: the spread check flags
stall_cap_reached, 34.87 against 34.24 percent (allowance 0.34 points), and
the aos arm share, 17.14 against 16.53 (allowance 0.17). It is the learned-cap
signature that cleared at six rounds on lookups-and-format-once and needed a
caps-engaged identity run on compiled-interpreter. Rounds 4 to 6 bought
before deciding whether that run is needed.

### Six rounds, finished

Rounds 4 to 6 read 1.7963, 1.7081, 1.6658 on the primary. Final: mean
1.7257, sd 0.0292, interval [1.6736, 1.7793], separated, band [1.15, 1.40]
read above, advice gain, no blockers. At six rounds every one of the eleven
neutrality rows sits inside the baseline's spread; the stall_cap_reached and
aos flags of round 3 cleared as the baseline's own spread was measured.
Runs per second 1.0738, interval [1.0420, 1.1066]: separated upward, where
the prediction expected [1.01, 1.05] and only asked that it not separate
downward. Microseconds per run 1.0499; steps per run 0.9981. Baseline for
7f607e6: nine rounds cached, 4,955.6 runs per second, spread 0.0308.

By hand, rounds 4 to 6: commands 1.0000 per run; text_buffers_allocated
0.0215, 0.0223, 0.0225 and dropped_oversize 0.0211, 0.0220, 0.0221 per run;
candidate blocked 0 s and 0 full-queue sends, baseline blocked 0.31 s (650
sends), 0.19 s (365) and 0 s.

Every frozen falsifier held: primary interval clears 1.15; spread check
inside; text_buffers_allocated and dropped_oversize under 0.05 per run in
every round; identity exact; output bytes per run 1.0000 in [0.97, 1.03];
peak RSS 1.0437x at most 1.05x; runs per second not separating downward.
Predictions missed, recorded as such: the primary above its band, the two
buffer counters above their predicted 0.01, and runs per second above its
expected range.

### Decision: merged, with a revert criterion registered before its check

No departure from any frozen falsifier or blocker. The primary is a counter
and the clock can only block, so the revert line is set on regression, not
on gain: the merge is reverted if the fresh baseline at the merged spur
commit reads below 4,807 runs per second over three rounds, 0.97x the
4,955.6 cached for 7f607e6.

### Post-merge baseline: the merge stands

Merged: spur edb9e2f, superproject a2f111d. The fresh baseline at edb9e2f
reads 5,186.6 runs per second over three rounds (5,302.5, 4,970.1, 5,287.2),
spread 0.0362, against 4,955.6 for 7f607e6 - plus 4.7 percent, above the
registered revert line of 4,807. Its writers: 339.7, 348.6 and 336.5 us busy
per run, 0 s blocked and 0 full-queue sends in every round - about 44 percent
of four writers, against about 72 percent before the merge. Ledger row
appended; its ratio field carries the session's runs-per-second
confirmation, 1.0738, because the ledger multiplies runs per second.

### Direction review after the merge

Digest for the user: iteration 11 merged the writer-side change the grid
pool was waiting on: each run's text now travels to the parquet writers in
recycled contiguous buffers turned into arrays without copying. Writer time
per run fell 1.73 times (583 to 338 us), runs per second rose 1.07, and the
writers went from filling their queue to about 44 percent busy with no
blocking. No falsifier departed from. Cumulative since call-frame-one-pass:
1.0634 x 1.3217 x 1.1727 x 1.1005 x 1.1972 x 1.0738, about 2.33.

**Are the costs attacked still the largest explainable?** The writer ceiling
that closed grid-ordered-release-pool is gone for now, which makes the
simulation threads' idle time behind grid batch stragglers the largest cost
the loop can explain again - about 2.8 ms idle per grid run, measured by the
pool's own counters. The profile of edb9e2f is taken for the on-CPU side.

**Has the steering paid for itself?** Yes. Iteration 10's close on its own
writer falsifier turned into this iteration's merge; the judge's insistence
that the pool return as a new candidate rather than by loosening that
falsifier keeps the next reading honest.

**Next directives.**

- grid-ordered-release-pool returns as a new candidate,
  grid-ordered-release-pool-2, on edb9e2f: its declarations and band frozen
  by a judge now, with a blocked_ns-per-run falsifier in place of
  queue_full_sends 0, before any build or smoke. Search-affecting as before,
  so it still owes the lite grader's per-run deep-rung guards before a merge.
  Its patch applies to campaign.rs, which this iteration did not touch.
- integer-columns-delta-encoded is buildable but low priority while the
  writers have 2x headroom; it becomes relevant again if the pool pushes them
  back past about 80 percent busy.

## Iteration 12 - autonomous, grid-ordered-release-pool-2

Preflight carried in session: spur-research-loop inactive, branch
research/lite, spur gitlink edb9e2f, tree clean after 5653259, baseline
rebuilt at edb9e2f with a fresh cache (5,186.6 runs per second, writers 0 s
blocked). No layout control, same build config hash. Profile of edb9e2f
taken at the start of the iteration.

No proposal round. The largest cost the loop can explain is again the
simulation threads' idle time behind grid batch stragglers, which the closed
grid-ordered-release-pool already measured (about 2.8 ms idle per grid run
before, 0.6 ms with the pool) and whose mechanism held every exactness check.
It was closed on writer backpressure; iteration 11 removed that ceiling. Per
iteration 11's ruling it returns only as a new candidate,
grid-ordered-release-pool-2, whose declarations, band and a
blocked_ns-per-run writer falsifier are frozen by a judge on edb9e2f now,
before any rebuild or smoke. The judge also checks whether the kept patch
applies to edb9e2f, since iteration 11 changed explorer.rs and util_stats.rs,
which the pool patch touches too.

### The profile of edb9e2f

research/perf/profiles/edb9e2f.md. The writer merge shows where expected:
parquet writer threads 8.79 percent of samples (11.32 on 7f607e6),
_int_malloc self 2.49 (3.90). The decoded interpreter still leads -
ceval 7.06 self, exec_ops 5.14, run_sync_ops 2.83 - with schedule_runnable
across specializations about 9.3, memmove 3.20, drop glue and EcoVec drop
about 4.4, FrameBuilder::finish 2.16 and format_escaped_str 1.61.

### Judging grid-ordered-release-pool-2

Admitted at gain 7, cost 2, net 5. The kept patch applies to edb9e2f with no
conflicts. Writer headroom plausibly absorbs the pool: today's grid busy
share is 0.607 to 0.623, so 2.06 to 2.28 ms idle per grid run remains, the
largest cost the loop can explain; the old smoke's 0.894 busy share counted
252 s of blocking as busy and splits into 0.719 productive, 0.106 idle and
0.175 blocked; with 29 instead of about 20 running threads on 16 cores the
judge models a per-thread slowdown of 1.18 to 1.32, recomposing runs per
second to 1.03 to 1.21 and writer utilization to 54 to 72 percent with the
pool on, against 86 percent and 805 us blocked per run in the old smoke.

Frozen: search-affecting, shared, primary cross-binary runs per second band
[1.05, 1.20]; a writer falsifier of blocked_ns above 50 us per run - about
1.2 percent of simulation-thread time, a tenth of the band's centre and below
what the cross-binary rate could separate - chosen from the goal's intent
before any reading of this build exists; a pre-round 30-thread 120 s smoke
gate; a voiding rule on grid steps per run; and the lite grader's per-run deep
guards before any merge.

### Decision: build grid-ordered-release-pool-2

The implementer rebases the kept patch on edb9e2f, rebuilds, and runs the
one-thread identity, the debug shadow smoke and the pre-round smoke gate
before any round is bought.

### The rebuild, the identity run, the shadow smoke and the pre-round gate

The kept patch applied at edb9e2f with offsets only, and every rebase
obligation held without edits: iteration 11's history_writer leaves sit
beside grid_pool and both completeness tests pass; the per-run write keeps its
single send; the pool hands back only GridOutcome, never a run's rows or text
buffers; AOS keeps its batched path. One addition: grid_pool.writer_blocked_ns,
the history_writer blocked time during each grid pool, so busy share can be
read with blocking removed from the dump alone; in the debug smoke it equals
the grid arms' history_writer.blocked_ns exactly. All spur-core tests pass.

- One-thread identity against edb9e2f (seed 1000, 3,008 runs): runs,
  executions (1,108,862), logs (3,383,871) and traces (3,702,656) identical
  both ways; the same stall_cap_runs.csv hash; no utilization leaf differing
  outside clocks. One per-arm campaign leaf differed
  (arms[1].text_buffers_recycled 2,391 against 2,387); a second baseline run
  differed from the first on the same leaf and read 2,387, so it is writer
  timing at slice edges, not the change.
- Debug shadow smoke, 30 threads, two slices per arm: shadow_mismatches 0 over
  9,728 grid batches; unfilled_in_ungated_batches 0; gated 7.1 percent (grid
  20.8, grid-short 9.9, the other two one batch each); fresh-ahead 44.4
  percent.

Pre-round smoke gate, release, 30 threads, general_vr.json at the graded 120
s budget, 822,480 runs:

| reading | value | frozen falsifier | |
|---|---|---|---|
| history_writer.blocked_ns per run | 0 us | above 50 us | held |
| grid_pool.worker_idle_ns per grid run | 0.301 ms | above 1.3 ms | held |
| busy share / blocking removed | 0.925 / 0.925 | below 0.75 | held |
| unfilled_in_ungated_batches | 0 | above 0 | held |
| AOS us per run | 3,698.6 (baseline 3,633 to 3,959) | outside | held |

Description: gated 5.9 percent; fresh-ahead 44.4 percent;
text_buffers_allocated 0.0237 per run; queue_full_sends 0; writer busy 399.5
us per run; busy share by arm grid 0.824, grid-short 0.935, grid-no-purgatory
0.971, grid-post-fault-2 0.972. Grid us per run rose about 1.04 to 1.10,
under the predicted 1.15 to 1.35 contention term. The grid arm's steps per
run read 2,385 against the baseline's 2,430 to 2,672 - an ungraded smoke, but
the voiding rule's observable, read in every round from here.

### Review of the rebased diff

Reviewed as a delta against the kept patch, which iteration 10 reviewed in
full: the changed lines differ only by grid_pool.writer_blocked_ns -
run_slice reads the session's history_writer blocked total before and after
the pool and records the difference, a getter exposes HW_BLOCKED_NS, and the
new field is carried through GridPoolSession, GridPoolStats, the reset list,
the dump and the completeness test, with doc comments stating what busy share
with blocking removed is. Only one arm runs per slice, so the per-slice
difference belongs wholly to that grid arm's pool. No other change to the
mechanism.

Session started: grid-ordered-release-pool-2, search-affecting, shared,
cross-binary primary, band [1.05, 1.20], counter grid_pool.worker_idle_ns
(new to the candidate, so read by hand), search loop inactive.

### Rounds 1 and 2, and the basis of the per-arm allowances

Cross-binary runs per second 1.3345 and 1.3841 (candidate 7,018 and 7,015,
baseline 5,259 and 5,068); mean 1.3591, interval [1.0777, 1.7139].
Microseconds per run 0.9679 and 0.9993; steps per run 0.9721 and 0.9365.
AOS share of runs 12.7 percent against 16.65 on round 1.

Frozen falsifiers, both rounds: history_writer.blocked_ns 0.05 and 0.00 us
per run (limit 50); grid idle 0.300 and 0.288 ms per grid run (limit 1.3);
busy share 0.923 and 0.927, identical with blocking removed (floor 0.75);
unfilled_in_ungated_batches 0; gated 5.6 and 5.9 percent; fresh ahead 44.5 and
44.2 percent; queue_full_sends 38 and 0. All held.

The per-arm allowances for the voiding rule and the AOS falsifier are the
baseline's round spread, read over every cached baseline round for edb9e2f -
five so far, three from the post-merge measurement and two from this session
- as range widened by that spread. A first reading built from this session's
two baseline rounds alone put grid and grid-short steps per run and AOS
microseconds per run outside; on the five cached rounds all of them sit
inside: grid 2,244 and 2,213 in [2,189, 2,913], grid-short 1,227 and 1,205 in
[1,173, 1,297], AOS us 3,739 and 3,671 in [3,307, 4,284]. The basis is fixed
here, before round 3, from the frozen wording, not from the readings. Worth
recording as it stands: the grid arm's steps per run sit below the
baseline's observed range [2,430, 2,672], inside only because of its spread,
and AOS runs are shorter too - the shape of learned caps and wall slices
responding to more runs per second.

### Rounds 1 to 3, and where the runs come from

Round 3 read 1.3118. Three rounds: runs per second 1.3431, interval [1.2547,
1.4377], separated, band [1.05, 1.20] read above - a prediction missed on
the high side, not a falsifier. Microseconds per run 0.9768: each run costs
about 2 percent more wall, the contention term, far below the predicted grid
1.15 to 1.35. Steps per run 0.9581, runs shorter in every round; steps per
second therefore about 1.29.

Every frozen falsifier held in every round: writer blocked 0.05, 0.00, 0.00
us per run; grid idle 0.300, 0.288, 0.314 ms per grid run; busy share 0.923,
0.927, 0.924 with blocking removed identical; unfilled_in_ungated_batches 0;
AOS us per run 3,739, 3,671, 3,805 inside [3,011, 4,877] on the six cached
baseline rounds. The voiding rule did not fire: grid 2,244, 2,213, 2,377
steps per run inside [2,189, 2,913], and every other grid arm inside its own.

Runs by arm, candidate over baseline, pooled over the three rounds: aos
1.045, grid 1.440, grid-no-purgatory 1.519, grid-post-fault-2 1.522,
grid-short 1.243. Each arm gets equal wall per slice, so the pool's gain
lands on the four grid arms and AOS, which kept its batched path, stays near
flat. That is what moved the arm shares the spread check reports
(description for a search-affecting candidate): aos 12.84 against 16.52
percent of runs, the grid arms up correspondingly, iterations_exhausted
17.24 against 19.80 percent. The session rate is equal-wall arms run faster,
not composition bought by shorter runs.

Rounds 4 to 6 bought: the voiding rule and the per-round writer falsifier are
read in every round, and the grid arm sat near its allowance edge in rounds 1
and 2.

### Rounds 4 and 5, and how the voiding rule reads

Rounds 4 and 5 read 1.3450 and 1.3575. Five rounds: runs per second mean
1.3464, interval [1.3135, 1.3801], band [1.05, 1.20] read above.
Microseconds per run 0.9703 and 0.9783; steps per run 0.9712 and 0.9402.
Frozen falsifiers held in both rounds: writer blocked 0.00 us per run; grid
idle 0.300 and 0.294 ms per grid run; busy share 0.923 and 0.925, identical
with blocking removed; unfilled_in_ungated_batches 0; AOS us per run 3,516
and 3,634 inside [3,011, 4,877].

The grid arm read 2,157 steps per run in round 5, 32 below its allowance of
[2,189, 2,913]. The frozen wording decides how that is read: the writer
falsifier is frozen as holding "in the pre-round smoke or in any single
round", while the voiding rule is frozen as "any grid arm's steps per run
outside the baseline spread x 2" with no per-round clause. So the voiding
rule reads each arm's session reading, pooled over the candidate's rounds and
weighted by runs, against the allowance from every cached baseline round.
That basis is recorded here before round 6.

Pooled over five rounds, against eight cached baseline rounds: aos 1,779
steps and 3,670 us per run; grid 2,245 and 4,340; grid-no-purgatory 1,863 and
3,876; grid-post-fault-2 1,856 and 3,801; grid-short 1,220 and 2,752. Every
one sits inside its allowance, so the voiding rule has not fired. Two arms sit
below the baseline's observed range though inside its spread - grid at 2,245
against [2,430, 2,672] and grid-post-fault-2 at 1,856 against [1,882,
2,064] - with per-round grid readings 2,244, 2,213, 2,377, 2,242 and 2,157:
shorter runs on the arms the pool speeds up, the learned caps responding to
the higher run rate. Recorded as it stands, not hidden by the allowance.

### Six rounds, finished

Round 6 read 1.3666. Final: runs per second mean 1.3497, sd 0.0188, interval
[1.3233, 1.3767], separated, band [1.05, 1.20] read above, advice gain.
Microseconds per run 0.9758 [0.9627, 0.9891]; steps per run 0.9551 [0.9381,
0.9724]. Baseline for edb9e2f: nine rounds cached, 5,161.4 runs per second,
spread 0.0246.

Every frozen falsifier held in all six rounds: writer blocked at most 0.05 us
per run; grid idle 0.288 to 0.314 ms per grid run; busy share 0.923 to 0.927
with blocking removed identical; unfilled_in_ungated_batches 0; AOS us per
run inside its allowance in every round (3,516 to 3,805). Voiding rule, on
the session reading pooled over six rounds against nine cached baseline
rounds: every arm's steps per run inside its allowance (aos 1,770, grid
2,245, grid-no-purgatory 1,865, grid-post-fault-2 1,859, grid-short 1,226) -
not fired. grid-short's us per run read outside in round 6 alone (2,845
against 2,831); us per run is a falsifier only on AOS, so that is description.

Blockers as expected: the search-affecting declaration owes the lite reading
and the panel note; the declared counter is new to the candidate.

### The lite reading, launched

The frozen order sends the candidate to the lite grader "only if the primary
lands in band and nothing is voided". The primary landed above the band, not
inside it. That condition is read here as "not below the band's lower edge":
a gain larger than predicted makes a merge more plausible, not less, and the
lite reading exists to block a search regression, not to police upside.
Recorded before any chunk is bought.

Launched: a cross-binary lite session, grid-ordered-release-pool-2, two
chunks to start (300 s per side, the first also measuring a lite baseline
for edb9e2f), read against the live v3 rule: per-run deep guards on depth>=6
and depth>=8 at the 0.25 margin must read held; the per-second depth>=8
rung is description; the panel is not run, being blind to GridArm, and that
is recorded as the panel note the blocker asks for.

### User direction, recorded mid-reading

The user asked for two things during grid-ordered-release-pool-2's lite
reading:

- Remove the pool's shadow logic - the cfg(debug_assertions) sequential
  Assigner checked against every batch, and its shadow_batches_checked and
  shadow_mismatches counters - since correctness is already verified (0
  mismatches over 10,006 and 9,728 batches). Not now: the binary under the
  lite reading contains it, and changing the code would invalidate the
  reading. At the iteration boundary, if the pool merges, an agent removes it
  in a follow-up commit, keeping the unit tests that compare the pool against
  a sequential reference and confirming with the spur-core tests and a
  release-build one-thread identity run that release behaviour is unchanged.
  If the pool closes, the shadow logic never enters the tree.
- Build release only. Judges and implementers are no longer asked for
  debug-only instrumentation or debug-build smokes; exactness is checked with
  unit tests and release-build identity runs.

### The lite reading could not be taken: a harness limit

The first lite chunk crashed on the baseline side after its 300 s explore
finished (explore done 10:44, crash 10:52): `RangeError: Invalid string
length` in node's child_process exit handler. The explore itself was sound -
23 GB of tables, campaign and utilization reports written.

Cause, read from research/orchestrator/src/runners.ts: `runsTable()` runs
`traceanalyzer -runs`, which writes the whole runs table - one JSON row per
run, every column - to stdout, and `run()` buffers that stdout into a single
string under a 512 MiB maxBuffer. 512 MiB is 536,870,912 bytes; V8's maximum
string length is 536,870,888 characters. A 300 s lite chunk at today's
throughput holds about 1.5 million runs even on the baseline side, and at a
few hundred bytes a row the table passes V8's limit, so the join throws
instead of returning. The comment on the neighbouring `runVariantTable()`
already records that the full table would not stay under V8's string limit
at millions of runs. Porcupine is not the cause: it runs under the 64 MB
default buffer, whose overflow is handled.

This is the perf loop's own success reaching the search loop's instrument:
the lite grader was sized for about half today's runs per chunk. The fix
belongs in research/orchestrator (project only the columns the lite reading
needs, or stream the table) and is not this loop's to make. Until it is
fixed, the lite grader cannot grade any chunk on this tree, so no
search-affecting perf candidate can receive its owed reading, and the search
loop's own grader will fail the same way.

Cleanup: the chunk's 23 GB eval directory and its sibling files under
tmp/loop/ were removed (the grader crashed before its own cleanup). The lite
session record research/lite/state/grid-ordered-release-pool-2* is left as
the grader wrote it, since research/lite/ is not this loop's to edit.

### Decision: held

grid-ordered-release-pool-2 is held, not closed and not merged. Its perf
reading is complete and every frozen falsifier held, but the goal requires
the search loop's non-inferiority reading before a search-affecting merge,
and that reading cannot be produced now. Computing per-run deep-rung rates by
hand outside the lite grader would not be the search loop's reading, so it is
not substituted. The rebased patch is kept at
research/perf/patches/grid-ordered-release-pool-2.spur.patch; the candidate
binary stays in tmp/loop/perf/grid-ordered-release-pool-2/ for the lite
reading once the grader is fixed. The shadow-logic removal the user asked for
stays scheduled for the boundary at which the pool merges.

### User direction: fix the grader, then return to the pool

The user rejected holding grid-ordered-release-pool-2 behind the harness
fault and authorized fixing the lite grader's runs-table read directly,
including edits to research/orchestrator/ that this loop's skill otherwise
forbids. A fresh agent is making the fix in the main tree, uncommitted:
project only the runs-table columns the evaluation reads (or stream the table
from a file), and make an output-too-large condition a handled evaluation
failure rather than an uncaught exception. It verifies with both graders'
selftests, the orchestrator's tests and a 60 s campaign output compared on
the old and new paths, without running a lite chunk itself. After review and
commit, the lite chunks for grid-ordered-release-pool-2 are re-run and the
pool is decided on them; the "held" decision above is superseded by that
reading. The uncommitted edit to the perf implementer prompt, removing the
shadow-check feature guidance, was the user's and is committed at their
direction (e6866e1).

## Iteration 13 - autonomous, algorithmic lens, search-neutral only (proposals gathered while the lite grader is fixed)

Profile edb9e2f.md. Search-neutral mechanisms only, since no search-affecting
candidate can get its lite reading until the grader fix lands; release builds
only, per the user. Guards scale by R = 3.97, the summed self of exec_plan,
random_range and the NodeIndex collect, which no candidate touches.

### Proposals

- frame-slots-by-liveness: the CFG compiler gives every temp its own slot and
  never reuses one; frames average 17.47 slots, 91 percent of them defaults
  nobody reads (31,318 of 34,410 per run). A compile-time liveness pass per
  function colors local slots, keeping parameters in place and giving slots
  read before any write (the for-in sentinel) their own color. Counter band
  on frame.slots_built per run [1.6, 2.6]; runs per second [1.02, 1.035] for
  regression. The largest and riskiest.
- recovery-placebo-walk-skipped-without-quick-fire: walk_recovery_placebo
  (1.59 self, 2.90 inclusive) ranks on all 1,789 decisions per run while a
  quick-fire candidate exists in 2.1; without one its outputs are known
  constants. Band [1.02, 1.035]. Flagged by the proposer: the placebo was
  built as a cost-matched control, so removing its cost may be the search
  loop owner's call.
- trace-payload-escaped-in-one-pass: parameters are formatted into scratch
  and then scanned again by format_escaped_str (1.61 self); escaping while
  writing gives the same bytes. Band [1.012, 1.02].
- As one composite the wall bands compose to [1.053, 1.093].

Judging runs in parallel with the grader fix; building waits until
grid-ordered-release-pool-2 is decided.

### Grader fix landed; lite reading for grid-ordered-release-pool-2 relaunched

The fix is committed as 0f147a4. The root cause went one layer deeper than
the crash: node's execFile truncates overflowed output to exactly maxBuffer
characters and still joins it, so a 512 MiB buffer is 24 characters past
V8's string limit and the overflow path itself threw. The runs table is now
written to a file and parsed one row at a time; evaluations read the seven
columns they use plus full rows for violating runs; an unreadable table
fails the evaluation instead of yielding an empty one. On a 293,580-run
session every computed result matched the old code exactly; both selftests
pass. The full table is 408.7 bytes a row and would have crossed the limit
at 1.31M rows, which today's ~1.5M-run chunks do. The session record and
the lite baseline cache were untouched; the crashed chunk's output is kept
as crashed-chunk-1.json and two chunks were relaunched.

### Iteration 13 judgment (autonomous)

The first judge was lost with the previous session before writing anything;
a fresh one with the same prompt wrote tmp/loop/perf/it13-judgment.md.

- frame-slots-by-liveness: net 4, admitted with its rule rewritten. As
  proposed, "no two variables sharing a color are live at the same vertex"
  misses dead stores, which this compiler emits, so a written-never-read
  temp could take a live loop variable's color and overwrite it each
  iteration; the proposed unit test would have passed that coloring. The
  frozen prediction now uses def-against-live-out interference, an
  exhaustive use/def match, an independent forward reaching-definitions
  checker over every bin/spur spec and a mutation test it must reject. The
  91 percent figure shows slots filled with defaults, not slots unread.
- trace-payload-escaped-in-one-pass: net 3, admitted. The mechanism needs a
  content-aware sink, since a plain adapter cannot tell string contents from
  structural text; part of format_escaped_str belongs to the executions
  payload and stays, so a summed-self guard stops a moved scan counting as
  removed.
- recovery-placebo-walk-skipped-without-quick-fire: closed at judging, my
  decision. The skip is exact, but the walk's cost is what the placebo exists
  to charge, and the search loop still runs it as a cost-matched control.
  For the user: if that control is retired, the saving is the placebo
  switched off or deleted - a search-loop decision, not a perf candidate.
- Built next, after grid-ordered-release-pool-2 is decided: the H1+H3
  composite on frame.slots_built per run [1.6, 2.6], runs per second
  [1.032, 1.056] for regression only.
- value-without-dead-signature (held) is re-priced if frame-slots lands: its
  ceiling shrinks with the slot count.

### grid-ordered-release-pool-2: lite reading and decision (autonomous)

The lite session ran two graded chunks after the grader fix (the first call
dropped its baseline chunk when porcupine timed out while the host had
476 MiB free; the seed is skipped on both sides). Zed was stopped at the
user's word before the second chunk. `finish` under internal-primary-v3,
cross-binary (no treatment bit):

- depth>=8 per explore-second 1.4389, separated at z 2.7, outside the 0.05
  layout floor; improved depth>=8, 9, 10; regressed none.
- deep guards per run on depth>=6 and depth>=8: unresolvedGuards empty,
  nothing regressed - held. Per graded run by hand, depth>=8 is 1.072x and
  depth>=6 1.063x the baseline's rate, so the per-second gain is not bought
  with shallower runs.
- violations 0 over 4,384,200 candidate and 3,266,640 baseline runs;
  throughput 1.3418; exposure 1.0002.
- adviceVerdict merge; blocker "the regression suite has not passed". Not
  run, as frozen before any chunk: the protocol panel runs without the
  campaign block, so GridArm never executes there. This is the panel note,
  not a waiver.
- advice: the ledger and the measured drift disagree by 6.5 percent; the
  lite baseline for edb9e2f is new this session and host drift since the
  last ledger row is the plain reading.

Decision: merge. The perf reading (1.3497 [1.3233, 1.3767], every frozen
falsifier held, voiding rule not fired) and the lite reading agree, and the
only blocker is the one the plan named in advance.

Revert criterion, fixed before the post-merge baseline is measured: the
merge is reverted if the fresh baseline at the merged spur commit reads
below 5,446 runs per second over three rounds, the band's lower edge 1.05x
over the 5,186.6 cached for edb9e2f.

### Post-merge baseline: the merge stands

Merged: spur 911e265, superproject 1501315. The fresh baseline at 911e265
reads 7,142.3 runs per second over three rounds (7,044.9, 7,264.4, 7,117.6),
spread 0.0157, against 5,186.6 for edb9e2f - plus 37.7 percent, above the
registered revert line of 5,446. Grid idle 0.28 to 0.30 ms per grid run.
Writers: 391.1, 373.9 and 381.1 us busy per run, 0 s blocked and 0
full-queue sends - about 68 percent of four writers at this rate, up from 44
percent on edb9e2f, so writer capacity is again within reach of the
ceiling. Ledger row appended with ratio 1.3497; cumulative 3.379.

Next, in order: a profile of 911e265 (running before any build), the
direction review it feeds, the grid pool's shadow logic removed per the
user, and the frame-slots and trace-escape composite built.

### Direction review after grid-ordered-release-pool-2 (autonomous)

Profile 911e265.md (60 s, 30 threads, frame pointers). The shape did not
change; the grid pool moved time from idle into the same simulation lines.
Largest self lines: ceval 7.22, exec_ops 4.96 (+1.28, 1.16), schedule_runnable
4.19 (+1.97, 1.55, 1.34), memmove 3.09, _int_malloc 2.71, run_sync_ops 2.56,
drop_glue<Value> 2.45, EcoVec<Value> drop 2.08, FrameBuilder::finish 2.02,
make_unique 1.86, format_escaped_str 1.82, exec_plan 1.68,
walk_recovery_placebo 1.30, parquet Int64 interner 1.23 (writer thread),
write_to<String> 1.10, random_range 1.10. Writer threads 9.05 percent
inclusive, the Int64 dictionary interner now the largest writer self line.

Share-inflation reference on 911e265: R = 3.69 (exec_plan 1.68, random_range
1.10, the NodeIndex collect 0.91), against 3.97 on edb9e2f. The composite's
frozen guards are written as x R_cand/3.97 against edb9e2f's shares; on this
tree they are read as x R_cand/3.69 against the same frozen share figures
scaled by 3.69/3.97, which is the prediction's own normalisation, not a new
threshold.

Verdict: stay on course. The admitted composite attacks FrameBuilder::finish,
the two Value drop lines and make_unique (8.41 together) and the trace escape
pair (2.92), still the largest costs with a stated mechanism. The scheduler
family remains the largest single cost; its queue-walk forms are closed, and
only a non-walk argument is worth steering toward. Writers are 68 percent
busy and the Int64 interner is visible: integer-columns-delta-encoded (pool,
low priority while writers read 44 percent) moves up and is re-priced on this
tree next iteration. Steering has not narrowed the search into one function:
the last four merges came from four different lenses.

Running: the grid pool's shadow logic removed in its own worktree (release
tests and a one-thread identity run against 911e265), and the
frame-slots-and-trace-escape composite built in another, on 911e265.

### Grid pool shadow check removed (user direction)

Merged as spur 5df7084 on top of 911e265, not graded: the removed code was
compiled only in debug builds, so the release binary's behaviour is the
same by construction. Checked in a worktree with release builds only:
spur-core tests pass (475 lib tests, both completeness tests, the four
ordered_release tests; the drain test rewritten to compare against the
sequential reference, the shadow-disagreement test deleted); no new warnings;
one-thread identity against 911e265 (VR, seed 1000, 600-run slices, one
round, 3,008 runs) identical on runs, executions (1,167,064), logs
(3,377,240) and traces (3,701,447) both ways, same stall_cap_runs.csv hash;
only the two shadow leaves are absent (0 in the release baseline); the
per-arm split of history_writer.text_buffers_recycled moved by 4 with the
session total equal, which a same-binary pair also shows. Two debug_assert!
drain invariants in run_ordered_release stay: they are invariant checks, not
a second model. No other shadow checks exist in spur. The perf baseline
cache for the moved tree is measured at the next start.

### frame-slots-and-trace-escape: implementer report and review before grading

Built on 911e265 while the shadow removal ran; the patch applies unchanged on
5df7084 and the graded candidate binary is rebuilt there, so both sides
share the tree apart from the candidate's change.

Review of the diff. The frame_layout pass matches the rewritten prediction
and is stricter in four places, all conservative: a write also interferes
with every slot the same label reads after it (TraceEnter stores the trace
id before formatting parameters, so def-against-live-out alone would let the
id overwrite a parameter dead after that label); liveness is per successor
edge, so the for-in binding dies only toward the body; every label the
function emitted is renumbered, not just reachable ones; a function with any
out-of-range slot or successor is left as declared. Entry-live slots
(parameters included) interfere pairwise, so a colour carries at most one
entry-live default. The use/def walks match every Label, Instr and Expr
variant with no wildcard. The independent forward checker caught a real bug
in the implementer's first version (the for-in iterator slot renumbered
twice) that the mutation test alone would not have. write_to now forwards
to one write_text definition over a TextSink with structure and content
entry points; the trace sink escapes content through a 256-entry table
matching serde_json's compact escaper, and TraceScratch is gone.

Checks (release only): spur-core 480 lib tests and every integration test
pass; the checker passes over the 13 bin/spur specs that parse (CRAQ.spur
fails to parse on both binaries); the mutation test rejects the dead-store
colouring; 2,048 generated payload cases match json_string_array; no
compiler/cfg/test.rs expectation edited. One-thread identity against the
main binary on VR (3,008 runs) and Mencius (regression_mencius.json, 2,160
runs): runs, executions, logs and traces identical both ways, same
stall_cap_runs.csv hashes; frame.calls and params_filled identical. VR:
slots_built per run 65,208.1 to 15,809.0 (4.12, above the [1.6, 2.6] band
on this fixed-count config), program slots 655 to 124 (0.189, under 0.62).
Mencius 2.66, 667 to 185. payloads_streamed + enter_payload_reused ==
rows_logged == traces rows on both specs.

Departure, written before any round: the identity falsifier "no leaf differs
outside the disclosed ones" fired on two families, and neither refutes the
candidate.
- history_writer.text_buffers_allocated / dropped_oversize / recycled (VR
  227 to 154, 199 to 122, 11,833 to 11,910): these count writer-side buffer
  capacity events, not anything a run or the search observes. The old
  json_string_array reserved text + 2 + 4n before writing, which seeded
  capacities that crossed the 1 MiB recycle limit more often; the streamed
  writer reserves nothing. Trace bytes are identical. A disclosure the
  prediction missed, favourable in direction.
- stats_local.folded_increments: a count of counter writes, which the two new
  trace_format counters raise by construction. Mencius rises by exactly
  payloads_streamed + rows_logged; VR rises 36,096 less, exactly 12 per run
  over 3,008 runs, a per-run counting convention rather than any change in
  what runs do.
The grid_pool shadow leaves present on the candidate side came from its
911e265 base and are gone in the rebuilt binary.

Grading as frozen: counter primary frame.slots_built per run, baseline over
candidate, band [1.6, 2.6]; runs per second cross-binary composed
[1.032, 1.056], below the floor, read for regression only; H3's counters by
hand in every round; a candidate profile against 911e265's R = 3.69 for both
parts' guards.

### frame-slots-and-trace-escape: three rounds, candidate profile, split

Three rounds (seeds 1000-1002) against a fresh baseline for 5df7084:
- primary frame.slots_built per run, baseline over candidate: 4.1371,
  3.9873, 4.3750; mean 4.1634, interval [3.7072, 4.6758], separated, band
  [1.6, 2.6] read above (candidate 8,185 slots per run against 34,080).
- runs per second 1.0517, 1.0370, 1.1284; mean 1.0717 [0.9577, 1.1991],
  not separated either way (regression-only reading: held). Steps per run
  0.9729 [0.8445, 1.1209].
- by hand, every round: payloads_streamed + enter_payload_reused ==
  rows_logged exactly; program slots 658 to 124; text_buffers_allocated
  and dropped_oversize per run lower; writer blocked 0, 0 and 55 ns per run.
- blocker: campaign end reason deadlock outside the baseline's own spread
  (2.62 against 2.07 per 10,000 runs; 3.05, 2.26, 2.54 against 2.11, 2.12,
  1.96), every other neutrality row inside. As frozen, the caps-engaged
  one-thread identity run (100,000 runs) is owed; it is running on the
  composite binary.

Candidate profile (5df7084-cand-frame-slots-and-trace-escape.md) against
911e265.md; R_cand = 3.93 (exec_plan 1.81, random_range 1.24, NodeIndex
collect 0.88), scale R_cand/3.97 = 0.990.
- H1 FrameBuilder::finish self 0.85, at most 1.29: held.
- H1 drops: drop_glue<Value> is no longer a symbol of its own - it is now
  inlined into drop_glue<ValueKind>, which rose from 1.07 + 0.69 to 1.55 +
  1.34 - so the guard is read on the whole Value drop family: 6.29 on
  911e265 (6.70 scaled to R_cand) against 4.32, a fall of 2.38, at least
  0.79 required: held. Reading the frozen two-symbol sum literally would
  have credited 3.10 by a renamed symbol; the family reading is the honest
  one. _int_malloc 2.71 to 1.61.
- H3 format_escaped_str on the trace path: absent above the cutoff; held.
  json_string_array and TraceScratch absent: held.
- H3 summed self of format_escaped_str, every write_to / write_text
  specialization and the new escape symbol: 0.00 + 1.28 + 1.22 = 2.50, at
  most 1.97 required: FIRED. Against 911e265 (1.82 + 1.10 = 2.92, 3.11
  scaled) the fall is 0.61 where 0.79 was required. The escape scan mostly
  moved into push_json_string_content, as the judge's red team warned for
  payloads that are mostly string text.

Decision on H3 (autonomous): closed on its frozen falsifier, no departure.
The guard was written for exactly this case. Composite patch kept at
research/perf/patches/frame-slots-and-trace-escape.spur.patch.

Decision on H1: continues, per the composite's attribution rule (the part
whose guard failed is closed; the other stands on its own evidence). An
H1-only candidate, frame-slots-by-liveness, is being cut from the composite
on 5df7084 with release tests and a one-thread identity run where only the
frame leaves may differ. It merges only if (a) the caps-engaged identity
run on the composite reads identical - the composite's code is a superset
of H1's, and H3 alone was byte-identical, so an identical reading clears
H1's neutrality - and (b) a three-round session of the H1-only binary shows
its counter in place and runs per second not separating downward.

### Caps-engaged identity run on the composite: identical

One thread, general_vr.json plus session_seed 1000,
deterministic_slice_runs 20000, deterministic_rounds 1; baseline 5df7084
against the composite binary, both 100,000 runs, both exit 0.
- runs (16 columns), executions (24,094,053 rows, payload included), logs
  (76,197,352) and traces (86,370,102, payload included): 0 rows in either
  EXCEPT ALL direction, compared in twenty run_id ranges of 5,000.
- end reasons equal: deadlock 19 (1.9 per 10,000), iterations_exhausted
  30,030, learned_cap_reached 18,308, plan_complete 29,129,
  stall_cap_reached 22,514. Both caps engaged with equal figures
  (stall_cap.stops 22,514, treated_runs 70,260; run_cap.cap_recomputes 2,
  probes 3,143); stall_cap_runs.csv sha256 14c0d98a..., the hash the
  compiled-interpreter identity run recorded.
- utilization leaves: only clocks, the disclosed frame and writer-buffer
  counters, folded_increments and the four new counters differ.
  frame.calls 236,198,217 and params_filled 371,343,754 on both sides.
- campaign.json: one leaf beyond those, arms[0].counters.history_writer.
  commands 20,000 against 19,999, with the session total 100,000 on both.
  The writer thread increments it when it takes a run from the queue and the
  explorer snapshots per-arm deltas right after run_slice returns, so the
  candidate's last grid run was taken between arm 0's end snapshot and arm
  1's start. Writer-thread timing, not run content.

Departure from the deadlock-share neutrality blocker, recorded: at one
thread with both caps engaged the two binaries make identical executions and
end in identical ways, so the 30-thread shift (2.62 against 2.07 per 10,000)
is the faster binary moving through the learned caps and the slice
allocation, the same throughput response compiled-interpreter showed. The
composite's code is a superset of frame-slots-by-liveness's, so this reading
clears the H1-only candidate's neutrality as well; H3 is closed regardless.

### frame-slots-by-liveness: cut from the composite, reviewed, graded alone

The H1-only patch was cut on 5df7084 and checked byte for byte against the
composite: frame_layout.rs identical, the compiler.rs and cfg.rs hunks
identical, util_stats.rs and the completeness test carry only the two
frame_layout gauges and their leaves; no values.rs, exec.rs or text_buffer.rs
change. One test-only adaptation: the checker's label-shape comparison now
also blanks TypeId digits, because assign_type_ids numbers types in hash map
order and two compilations of the current VR.spur (RecoverInit's
persist_data / retrieve_data carry a TypeId) numbered one type 0 and 4. The
composite's implementer had run the checker against a worktree checkout of
bin/spur holding 10 specs and an older VR.spur; the split ran it over all 26
specs that compile (CRAQ does not compile on the baseline either).

Checks, release only: spur-core 521 tests pass, including the checker over
26 specs and the dead-store mutation test. One-thread identity on VR (3,008
runs) against 5df7084: runs, executions (1,167,064), logs (3,377,240) and
traces (3,701,447) identical both ways, same stall_cap_runs.csv hash; only
frame.slots_built (65,264.5 to 15,816.9 per run, 4.13) and
default_slots_filled differ, plus the new frame_layout leaves (658 to 124);
history_writer.text_buffers_* and stats_local.folded_increments now
identical, confirming those moved only with H3. frame.calls and
params_filled identical.

Graded as a new session with the frozen declarations (counter primary
frame.slots_built, band [1.6, 2.6], search-neutral, shared saving; runs per
second [1.02, 1.035] regression only), three rounds. Merge rests on the
counter, no downward separation in runs per second, the composite's profile
guards for H1 (read on the whole Value drop family) and the caps-engaged
identity reading, with a revert line registered before the post-merge
baseline.

### frame-slots-by-liveness: three rounds and decision (autonomous)

Three rounds (seeds 1000-1002; round 0's first attempt was killed by the
host's low-memory killer mid-round and relaunched detached, nothing
recorded from it):
- primary frame.slots_built per run, baseline over candidate: 4.0836,
  4.2158, 4.1708; mean 4.1563 [3.9922, 4.3272], separated, band [1.6, 2.6]
  read above (8,210 against 34,124 per run).
- runs per second 1.0538, 1.0945, 1.0765; mean 1.0748 [1.0252, 1.1268],
  separated upward, above its expected [1.02, 1.035]; microseconds per run
  1.0712 [1.0304, 1.1137]; steps per run 0.9798 [0.9168, 1.0470]. H1 alone
  reads faster than the composite (1.0717), consistent with H3 having paid
  for its own counters and moved rather than removed its scan.
- by hand: program slots 658 to 124 every round; frame.calls and
  params_filled per run track the run mix (the one-thread identity has them
  equal); writers blocked 0, busy per run 1 to 5 percent lower.
- blocker: campaign arm share grid-short outside the baseline's own spread
  (0.2790 against 0.2878, allowed 0.0065). The deadlock row that flagged on
  the composite reads inside here (2.44 against 2.24 per 10,000, allowed
  0.58).

Departure from the neutrality blocker, recorded: the two sessions of this
mechanism flag different rows, each inside in the other session, which is
the pattern of a faster binary moving through slice allocation and the
learned caps rather than of a change in what runs do. The caps-engaged
one-thread identity run on a superset of this code (100,000 runs) read
identical on every table, end reason and cap figure; the H1-only one-thread
identity read identical with only the frame leaves differing. The H1 profile
guards read on the composite's candidate profile stand for H1 alone, since
H3 touches neither FrameBuilder nor the Value drop path: finish self 0.85 at
most 1.29, the Value drop family down 2.38 where 0.79 was required.

Decision: merge. The counter moved as the mechanism predicts (above band:
the prediction's frames were priced at 1,970 calls per run and 17.5 slots
per frame; the layout packs 658 declared slots into 124), runs per second
agrees and separates upward, identity holds, both H1 guards held.

Revert criterion, fixed before the post-merge baseline is measured: the
primary is a counter and the clock can only block, so the line is set on
regression - the merge is reverted if the fresh baseline at the merged spur
commit reads below 6,789 runs per second over three rounds, 0.97x the
6,999.4 cached for 5df7084 over six rounds.

### Post-merge baseline: the merge stands

Merged: spur 45517fd, superproject fa48f64. The fresh baseline at 45517fd
reads 7,669.9 runs per second over three rounds (7,585.7, 7,731.5, 7,692.5),
spread 0.0098, against 6,999.4 for 5df7084 - plus 9.6 percent, above the
registered revert line of 6,789. frame.slots_built about 8,100 per run.
Writers 378.2, 370.3 and 370.1 us busy per run - about 72 percent of four
at this rate - with full-queue sends 0, 29 and 31 and blocked at most 0.07
us per run: the writers are again within reach of the ceiling. Ledger row
appended with ratio 1.0748; cumulative 3.632.

Iteration 13 closes: one merge (frame-slots-by-liveness), one close
(trace-payload-escaped-in-one-pass, on its guard), one close at judging
(recovery-placebo-walk-skipped-without-quick-fire, the search loop's
control). Next: profile 45517fd, then iteration 14 with writer capacity
back in view - integer-columns-delta-encoded re-priced on this tree.

## Iteration 14 - autonomous, allocation lens, profile 45517fd

Profile 45517fd.md (60 s, 30 threads). R = 3.93 (exec_plan 1.67,
random_range 0.97, the NodeIndex collect 1.29). Largest self lines: ceval
7.39, exec_ops 5.34 (+1.37, 1.23), schedule_runnable 4.85 (+1.79, 1.55,
1.52), memmove 3.41, run_sync_ops 2.73, EcoVec<Value>::make_unique 2.03,
format_escaped_str 1.73, _int_malloc 1.68, cfree 1.59,
walk_recovery_placebo 1.59, drop_glue<ValueKind> 1.52, EcoVec<Value> drop
1.42, the parquet Int64 interner 1.33 (writer), write_to<String> 1.28,
malloc 1.17. Writer threads 9.75 inclusive: the byte-array encoder 4.17,
Int64 columns 2.74. FrameBuilder::finish has left the list with the frame
slot merge.

What I can explain and a change could remove: make_unique is copy-on-write
clones of value vectors at update sites and is now the largest value-traffic
line; memmove still needs attributing through the call graph before anything
is priced against it; allocator traffic is about 4.4 together; the writers
are the throughput ceiling again, at about 72 percent busy with full-queue
sends appearing.

Lens: allocation and memory traffic. Focus directive: whether each
make_unique clone is needed (transient refcount, clone for a read, update of
a value about to be dropped), memmove attributed before pricing, allocator
traffic, and the writer path (text column encoding, the Int64 dictionary
interner); integer-columns-delta-encoded and value-without-dead-signature
re-priced on this tree. Both declarations admissible again now that the lite
grader reads at today's throughput. Release builds only.

### Proposals

- node-env-detached-per-segment: make_unique (2.03 self) is the node env's
  copy-on-write. exec_ops (exec.rs:1478) and exec_sync_on_node (exec.rs:105)
  clone state.nodes[i], so the first node write in a segment copies all 20
  slots and the writeback frees the old buffer; frame.entry_frame_copies
  reads 0 on both sides, and the only other reach (eval.rs:252, a store into
  a list) VR never does. The share has grown steadily as other costs left
  (1.11 to 2.03). Moves the env out of the node for the segment, leaving a
  placeholder with sig and writes; the clone path stays under H::EAGER.
  Neutral, shared. New node_env.written_segments [130, 450] per run,
  shared_at_write and error_exits exactly 0. Discloses that a runtime error
  inside a segment would keep the node's partial writes. Runs per second
  [1.02, 1.05], regression only. Offered as the new evidence the closed
  exec-node-env-in-place entry asked for.
- collection-self-updates-in-place (needs the first): x = x[k] := v,
  append and erase compile to one label, and ceval clones the collection out
  of its slot first, so the update always sees it shared - a map update
  clones a 2.8 KB imbl root through _int_malloc (GenericNode::make_mut 2.16
  inclusive), a list push takes reserve's copy branch. New decoded ops
  evaluate key and value first, keep the error order, take the value out,
  update in place, store once. Neutral, shared. value_update.map_in_place
  [60, 400] and list_in_place [15, 200] per run; runs per second
  [1.02, 1.05], regression only. Together with the first, [1.04, 1.10].
- integer-columns-delta-encoded, re-priced: dictionary off and
  DELTA_BINARY_PACKED on seven integer columns; history_writer.busy_ns per
  run [1.05, 1.15], runs per second [1.00, 1.02] regression only, output
  bytes per run [0.85, 1.02], a parquet_metadata encoding check.
- memmove (3.41) could not be attributed: glibc keeps no frame pointer, so
  nothing is priced against it. value-without-dead-signature stays held
  (frame memory now 66 KB per run from 272 KB).

### Judgment (autonomous)

The judge admitted all three and the combination, nothing scored 0:
node-env-detached-per-segment net 4, collection-self-updates-in-place net 3
(only with or after the first), the two as one commit net 4 and built
first, integer-columns-delta-encoded net 2 as its own commit after.

- node-env-detached-per-segment: the central claim holds - make_unique can
  only be the node env copy-on-write on this tree - which is the question
  exec-node-env-in-place was closed on. Two supporting claims were false
  (grow's 1.26 inclusive cannot sit under make_unique's 0.80 of children;
  make_unique read 1.37, not below the cutoff, on 69c488c); corrected price
  3.1-3.4 points. The disclosed error-path difference is unobservable: a
  failed run writes no row. error_exits is description only, since the
  grader blocks on a counter absent from the baseline.
- collection-self-updates-in-place: exact as rewritten; the decoder must
  compare slot kind, because frame slots now let a temp share the target's
  index.
- The combination: counters split by local and node slot, the Value drop
  guard composite-only, one relocation guard; runs per second [1.04, 1.10],
  regression only; identity on VR, Mencius and caps-engaged before rounds.
- integer-columns-delta-encoded: band tightened to [1.04, 1.14] on
  busy_ns; writers not binding today; traceanalyzer and spur debug identity
  restored.

Decision: build the combination and the writer change in parallel, in two
worktrees; grade the combination first, then the writer change on the tree
the combination leaves.

### integer-columns-delta-encoded: implementer report and review

Built on 45517fd, only history.rs: open_parquet_writer takes a column list
and sets dictionary off plus DELTA_BINARY_PACKED per column for run_id,
seq_num, step, unique_id, trace_id, schedulable_count and
causal_operation_id on the executions, logs and traces writers (13 column
chunks); the runs writer keeps every dictionary; SNAPPY and statistics at
default. A new test reads the written files with arrow-rs and asserts the
encoding, the absent dictionary page and min/max on exactly 4, 3 and 6
columns, and a dictionary page on every other column. Reviewed: the diff is
that and nothing else, and applies cleanly on 45517fd.

Checks (release): 522 spur-core tests pass. One-thread VR identity (3,008
runs) against 45517fd: runs, executions (1,167,064), logs (3,377,240) and
traces (3,701,447) identical both ways through go-duckdb; traceanalyzer
default and -runs output identical apart from clock fields; porcupine exit 0
and "All runs are linearizable" on both, with HTML operation order differing
in 310 of 3,008 files - porcupine run twice on the same baseline output
differs in 321, so that is porcupine's own ordering; spur debug combined
byte-identical for run 2 (a crash at step 5, recover at step 6);
stall_cap_runs.csv hash equal; utilization and campaign.json differ only in
clocks. parquet_metadata: the 13 switched chunks read RLE,
DELTA_BINARY_PACKED with no dictionary page and min/max present; every other
column unchanged.

Output bytes per run 28,731 to 20,196 (0.703: executions 0.441, logs 0.653,
traces 0.742, runs 1.000), below the frozen [0.85, 1.02] - a missed
prediction on the favourable side, not a falsifier (which is above 1.02).
Writer busy per run at one thread 472.4 to 403.6 us (1.170), description
only. Graded after node-env-and-in-place-updates, on the tree that change
leaves.

### node-env-and-in-place-updates: implementer report and review before grading

Built on 45517fd as one change: values.rs Env::detach; compiled.rs
Op::SelfUpdate (boxed, so Op keeps its size) decoded only when the right
side's collection is the destination slot, matched on slot kind and index;
exec.rs take_node_env (clone under H::EAGER, detach otherwise) in exec_ops
and exec_sync_on_node, the loop moved into run_record_ops returning Parked
or Returned so the environment goes back on every exit before the
continuation runs, set_node counting shared_at_write, and run_self_update;
util_stats node_env.* and value_update.* counters.

Review of the diff. Detach leaves a placeholder with sig and writes; the
non-eager path writes back on every exit including errors (the eager path
keeps today's clone and discards on error). A reader touching a detached
node's slots would index an empty buffer and panic, not read a wrong value;
none did across the identity runs. run_self_update evaluates key and value
first, takes owned copies of any borrowed operand, checks the collection's
kind, then moves the collection out, updates it, stores it once; a
collection shared elsewhere copies inside imbl or ecow as before; the tree
tallies are bumped as the tree path bumps them (compiled_expr leaves equal
in identity). One edge I could not close from the diff: a negative list index
becomes a large usize and reports IndexOutOfBounds, which may word the error
differently from the tree path; the implementer's 2,592 NoHashing
comparisons cover error text over 21 right sides, and runtime errors write
no rows in graded runs, so it is recorded, not blocking.

Checks (release): 525 spur-core tests pass, frame_layout checker unmodified.
Identity against 45517fd, every table both ways: VR 3,008 runs, Mencius
2,160 runs and the caps-engaged 100,000-run VR identical, stall_cap_runs.csv
hashes equal, end reasons equal (100,000: deadlock 19, iterations_exhausted
30,030, learned_cap_reached 18,308, plan_complete 29,129, stall_cap_reached
22,514), cap figures equal; leaves outside clocks and the new counters: only
text_buffers_allocated 4,076 against 4,112 in the 100,000-run dump (writer
timing). Counters per run, VR / caps-engaged: written_segments 324.5 /
216.1 [130, 450]; shared_at_write 0 / 0; error_exits 0 / 0; map_in_place
348.5 / 236.4 [60, 400], all on node slots; list_in_place 102.7 / 76.2
[15, 200]; list shared at push 0.025 / 0.044 of list updates (at most 0.3).
Two arms of the VR identity sit just outside the written_segments band
(grid-short 127.0, grid-no-purgatory 454.4); the falsifier reads the session
per round, and every arm of the 100,000-run identity is inside.

Deviations accepted: error_exits counts record segments only (sync segments
already wrote back on error); SelfUpdateOp carries the whole right side so
the eager path runs the old assignment.

Graded as frozen: cross-binary runs per second, band [1.04, 1.10], below the
0.05 floor, read for regression only; counters by hand every round; a
candidate profile for the guards (make_unique for the node env part, the
Value drop family composite-only, one relocation guard at 1.5 x r).

### node-env-and-in-place-updates: three rounds

Seeds 1000-1002 against the 45517fd baseline (six cached rounds, spread
0.029):
- cross-binary runs per second 0.9924, 1.0480, 0.9599; mean 0.9994
  [0.8951, 1.1159], not separated; band [1.04, 1.10] not reached. Round 2
  is the noisy one (candidate 6,915 against 7,204). Microseconds per run
  1.0006, steps per run 0.9916.
- counters per run, every round inside its band: written_segments 187.2,
  188.9, 197.5 [130, 450]; map_in_place_node 207.0, 209.5, 219.1 and
  map_in_place_local 0 [60, 400]; list_in_place 69.7, 70.2, 72.4
  [15, 200] with shared at push 0.057 of them (at most 0.3);
  shared_at_write 0; error_exits 0; frame.entry_frame_copies 0 both sides.
  The mechanism fires exactly as described.
- blockers: plan_complete end-reason share outside the baseline's spread
  (0.2756 against 0.2651, allowed 0.0097); and the grader's note that a
  shared saving with no per-run counter primary reads the wall as
  confirmation only - known at declaration, since the new counters cannot
  pair against a baseline that lacks them.
- advice inconclusive; another round could still separate it.

Buying rounds 4-6 after the candidate profile, which settles whether
make_unique left and where its cost went.

### node-env-and-in-place-updates: candidate profile and decision (autonomous)

Candidate profile 45517fd-cand-node-env-and-in-place-updates.md against
45517fd.md; R_cand = 4.09 (exec_plan 1.76, random_range 1.04, NodeIndex
collect 1.29), r = 1.041.
- H1 EcoVec<Value>::make_unique self 2.03 to 1.69, at most 0.42: FIRED.
- H2 GenericNode make_mut inclusive 2.16 to 1.56, at most 0.83: FIRED.
- H2 GenericHashMap::insert inclusive 3.72 to 3.08, a fall of 0.79 against
  the scaled base, at least 1.04: FIRED.
- H2 EcoVec<Value>::reserve self 0.88 to 0.07, fall at least 0.31: held.
- Value drop family down 1.42 scaled, at least 0.52: held.
- relocation (ceval, every exec_ops and run_sync_ops, run_self_update) no
  rise once scaled, at most 1.56: held.
- description: memmove 3.41 to 3.24, _int_malloc 1.68 to 1.53, cfree 1.59
  to 1.43.

Decision: closed, both parts, by the frozen attribution rule - H1's
make_unique guard failed, and H2's own guards failed with
map_in_place_local 0, so there is no locals-only re-grade. No departure.
Rounds 4-6, already running, were stopped: no wall reading could change a
decision taken on frozen falsifiers. Patch kept at
research/perf/patches/node-env-and-in-place-updates.spur.patch.

What the close teaches. With the node environment detached,
shared_at_write read 0 in every round and identity run, yet make_unique
still reads 1.69: most of make_unique is not the node env copy-on-write.
The judge's "only two make_mut sites" attribution missed a source, so
make_unique is again unexplained and must be attributed from call stacks,
not from source reading, before anything else is priced against it. On the
map side the in-place ops fire about 210 times per run and the root clone
went (reserve 0.88 to 0.07, make_mut down 0.60), but insert itself stayed
most of its inclusive cost; the priced 2.8 KB root clone was the smaller
share. Wall 0.9994 is consistent with a saving too small to see, not with a
regression.

Next: integer-columns-delta-encoded, graded on 45517fd (unchanged tree).

### integer-columns-delta-encoded: three rounds and decision (autonomous)

Seeds 1000-1002 against 45517fd:
- primary history_writer.busy_ns per run, baseline over candidate 1.1801,
  1.1800, 1.1964; mean 1.1855 [1.1623, 1.2091], separated, band
  [1.04, 1.14] read above (319.3 against 378.5 us per run). No blockers;
  every neutrality row inside the baseline's spread.
- writers blocked 0 us per run and 0 full-queue sends in every round on both
  sides: the writers were not binding in any of these rounds.
- runs per second 0.9766, 0.9805, 0.9787; mean 0.9786 [0.9737, 0.9835],
  separated downward with a round-to-round sd of 0.002. Microseconds per run
  0.9733 [0.9673, 0.9794]; steps per run 1.0180 [0.9933, 1.0434].

Decision: closed on the frozen falsifier "runs per second separates
downward", no departure. The loss is inside the 0.05 cross-binary layout
floor, and steps per run rising 1.8 percent accounts for most of it (per-step
time about 0.991), so layout or run-mix noise are plausible readings. But the
frozen text makes no floor exemption, no layout control isolates this binary,
and with the writers not binding the change cannot buy wall time today.
Merging a measured 2 percent loss for a future ceiling is not a trade this
loop makes on a counter primary where the clock can only block.

What it proved, for later: writer CPU per run down 18.5 percent and output
bytes per run 0.703 (executions 0.441, logs 0.653, traces 0.742), with every
table and every reader identical. The smaller output is a real saving on
disk - the lite grader's chunk directories run to tens of GB - which is not
this loop's goal; recorded here for the user. Patch kept at
research/perf/patches/integer-columns-delta-encoded.spur.patch. It returns
as a new candidate with its own declarations only when writers block, graded
then beside a layout control.

Iteration 14 closes with no merge: node-env-and-in-place-updates closed on
its frozen profile guards, integer-columns-delta-encoded on its frozen wall
falsifier.

### Direction review after iteration 14 (autonomous)

Iterations 13 and 14 together: one merge (frame-slots-by-liveness, plus
the grid pool before it), four closes on frozen falsifiers
(trace-payload-escaped-in-one-pass, node-env-detached-per-segment,
collection-self-updates-in-place, integer-columns-delta-encoded) and one
close at judging (the recovery placebo skip). Tree unchanged at 45517fd,
7,669.9 runs per second, cumulative 3.632.

What the closes share. Three of the four were priced by attributing profile
lines through source reading - which function "must" reach make_unique,
which part of insert "is" the root clone, which writer line "is" the
interner - and the frozen guards then showed the attribution wrong or the
line unbound. The mechanisms worked exactly as built (counters in band,
identity identical every time); the prices did not. The fourth
(integer-columns-delta-encoded) removed real writer work, but the writers
were not binding and the clock separated 2 percent downward.

Verdict: the largest costs are still the ones being attacked -
schedule_runnable's family (about 11.6), ceval (7.4), exec_ops (7.9 across
specializations), memmove (3.4), allocator traffic (about 4.4),
make_unique (2.0) - but pricing against them now needs caller attribution
from call stacks, not source reading. Before iteration 15's proposer, a
caller attribution of make_unique, memmove (via dwarf unwinding, since
glibc has no frame pointers), the allocator lines, the Value drop family
and the imbl map insert is being recorded on the graded workload; it is
proposer input like a profile, not a graded round. Iteration 15's focus
directive will require every priced line to cite that attribution. The
writer path is parked until writers block (0 blocked in the last six
rounds on 45517fd). Steering has not narrowed into one function: the
closes span values, the node env, trace formatting and the writer.

### Caller attribution on 45517fd (research/perf/profiles/45517fd-attribution.md)

Recorded on the graded workload: one grader-shaped 60 s recording (matches
45517fd.md within about 0.1 on every line), one plain-cycles frame-pointer
recording and one plain-cycles DWARF recording at 49 Hz.

Grader finding. The grader records with perf's default event, which on this
Ryzen is cycles:P served by IBS: the sampled address is exact, but the call
stack is taken after the CPU has moved on. The sampled function is absent
from its own stack for 89 percent of make_unique samples, 93 percent of
drop_glue<ValueKind> and about 80 percent of malloc and cfree. So every
inclusive share and caller reading taken from a grader profile so far
mostly describes whatever ran next. The two events also weight time
differently: under plain cycles memmove reads 5.9 (3.4 under IBS), malloc
2.5 (1.2), make_unique 0.6 (2.0). Guards read from IBS profiles have
undercounted memmove and the allocator and overcounted small, frequent
functions. The closes of node-env-detached-per-segment and
collection-self-updates-in-place stand - their guards read like against
like, both profiles IBS - but their pricing was built on unreliable
inclusive shares.

Where the costs come from:
- make_unique: Env::set's make_mut on every slot write (values.rs:746),
  70 percent from AssignNode (exec.rs:954), 21 percent AssignLocal; of its
  precise samples 67 percent is the entry and refcount check, 21 percent the
  return on an already-unique buffer, 10 percent an actual copy.
- imbl insert: 76-78 percent map literals (CExpr::Map built by repeated
  inserts, compiled_eval.rs:207), Store 21-24 percent; the cost is
  allocating hash-map nodes.
- memmove (DWARF, 91 percent of it in the top 30 call sites): about 48
  percent moving Record and Runnable values through queues and calls
  (push_runnable per RPC exec.rs:1215, Arc::new((record, lhs)) in
  push_waiting_reader state.rs:460, the record argument into exec_ops
  exec.rs:855, Vec::remove in take_local / take_network state.rs:1176 and
  1167, moves in schedule_runnable scheduler.rs:1271, 1483, 1702); 14
  percent the parquet writer; about 11 percent trace payload text; 7 percent
  map inserts; 4 percent string building.
- malloc / realloc: a quarter of malloc and three quarters of realloc are
  schedule_runnable's per-step index lists (eligible at scheduler.rs:1276,
  1301, 1350; local_queue_sizes at 1195); a fifth map literals; 15 percent
  call frames and argument vectors; 10 percent string +; 8 percent Store; 8
  percent trace and history payload boxes.
- cfree: about 47 percent the scheduler temporaries (scheduler.rs:1788,
  1329, 1296); the rest frames dropped at exec_ops exit and SyncCall end and
  overwritten local values; end-of-run teardown 17 percent inclusive.
- drop_glue<ValueKind>: two thirds the old value dropped when AssignLocal
  overwrites a slot. EcoVec<Value> drop: 41 percent node-env writebacks, 43
  percent frame drops.

Grader decision (autonomous): research/perf/grader.ts is the loop's own
file. Its profile command records the default precise event; it will record
plain cycles instead, so call stacks belong to the sampled function and
shares weight cycles. Profiles before this change are the IBS epoch; guards
always compare a candidate profile with a baseline profile recorded the same
way, so 45517fd is re-profiled on the new event before iteration 15.

## Iteration 15 - autonomous, data layout lens, profile 45517fd on plain cycles

Profile 45517fd.md re-recorded on plain cycles (the IBS version is in git
history). Self lines: ceval 7.73; schedule_runnable 6.50 (+2.05, 1.91,
1.13) and the Map<Iter<Vec<Runnable>>> collect 1.35, about 12.9 together;
memmove 5.92; exec_ops 5.06 (+1.29, 1.18); drop_glue<ValueKind> 2.74;
run_sync_ops 2.58; malloc 2.47; EcoVec<Value> drop 2.22; ValueKind::clone
1.81 (above the cutoff for the first time under this event);
walk_recovery_placebo 1.79; exec_plan 1.74; the parquet Int64 interner 1.28
(writer); imbl GenericNode 1.26; format_escaped_str 1.23; _int_free_chunk
1.22; _int_malloc 1.01. Writer threads 9.76 inclusive. random_range and
the NodeIndex collect are below the cutoff under this event, so the old R
lines are gone; each candidate names its own untouched plain-cycles lines.

What I can explain from the attribution and a change could remove: about
half of memmove is Record and Runnable values moved by value through
queues, calls and Arc wrappers; a quarter of malloc, three quarters of
realloc and about half of cfree are schedule_runnable's per-step index
lists; two thirds of drop_glue<ValueKind> is the old value dropped when a
local slot is overwritten; map literals built by repeated inserts carry
most of the imbl insert cost.

Lens: data layout and representation. Focus directive: the size and
movement of Record and Runnable (sizes from the type definitions, which
fields make them large, by-value moves where a box or index would move a
word, Vec::remove shifting a queue per take), and the per-step index lists'
storage. Every priced line cites the attribution file.

### Proposals

From the type definitions: Record is 248 or 256 bytes and Runnable the same
(Record is its largest variant), so every queue push, take, park and pass
into exec copies about 250 bytes through memmove; about 150 of them are read
only at delivery or crash. All three candidates cite the attribution file,
are search-neutral with a shared saving, and read the wall for regression
only. R = 11.50 (ceval, the parquet Int64 interner, imbl GenericNode
make_mut, format_escaped_str), which none of them touches.

- runnable-one-word-record: box Record, Timer, the ChannelSend fields and
  the partition type inside Runnable (32 bytes or less), with a priority copy
  kept beside the box (priority is set only at creation, so the copy is
  exact); exec and exec_ops take the box; parked readers become
  Arc<(Box<Record>, Lhs)>. Removes 2.56-3.39 points of memmove; adds about
  1,500 malloc/free pairs per run (0.30-0.45 points) and 0-0.5 points of
  pointer follows; net 1.6-3.1. Band [1.015, 1.035]. Guards: memmove at most
  3.65 x r, the two scheduler walk lines at most 3.08 x r, allocator rise at
  most 0.7 x r, walk_recovery_placebo within [1.49, 2.09] x r (a reading
  outside goes to the search loop's owner).
- step-index-lists-inline: local_queue_sizes and the eligible lists in
  inline SmallVec storage (smallvec 1.15.1, already in Cargo.lock), same
  indices and order. malloc 0.59, _int_malloc 0.25, realloc 0.41, cfree
  0.40-0.51; net 1.5-1.75. Band [1.012, 1.022]. Guards: realloc at most
  0.25 x r, the scheduler's Vec<usize> collect gone, allocator at most
  4.74 x r, overflows at most 0.05 per run.
- the two as one commit, band [1.027, 1.058], guards separable (the index
  lists add no memmove, the boxing adds no realloc).

Both claim new call-stack evidence against the closed runnable-thin-queue
and the scheduler half of per-step-scratch-buffers, which were closed on
queue-walk arithmetic and IBS shares; the judge is asked to check whether
either close was a measured refutation.

### Judgment (autonomous)

All three admitted, nothing scored 0: runnable-one-word-record net 4,
step-index-lists-inline net 5, the two as one change net 4 and built first.
The judge compiled the type definitions to check sizes (Record and Runnable
248 bytes, about 152 cold, the boxed Runnable 32) and confirmed the nine
credited memmove sites (31.4 percent of memmove), the priority copy's
exactness, every allocator share against the attribution file, R, and that
both earlier closes were arithmetic, not measurement. Corrections frozen:
Vec::remove's tail shift stays a memmove call (2.36-3.22 points removed);
the record_boxes falsifier was wrong by construction and becomes an exact
per-run identity with channels_created; a ChannelSend box counter; the crash
path moves instead of cloning; an exec_ops guard; the scheduler guarded as a
family because H1's walk guard named the collect H2 rewrites; eligible lists
at capacity 14 so their copies stay within 128 bytes; the spill falsifier at
1 percent of lists built. The placebo pairing holds by construction; its
share band stays description, and a reading outside it goes to the search
loop's owner before merge.

Build: two commits (index lists, then boxing), identity on the composite,
two plain-cycles profiles for attribution, three rounds.

### records-boxed-and-index-lists-inline: implementer report and review before grading

Two commits on 45517fd: A, the index lists (smallvec 1.15.1 as a direct
dependency under the simulator feature, Cargo.lock gaining only the name in
spur-core's list, no new package; eligible lists SmallVec<[usize; 14]>,
128 bytes asserted; local_queue_sizes SmallVec<[usize; 15]>, 136 bytes by
arithmetic, so its copies may stay a library call, which the memmove guard
decides); B, the boxing on top (Runnable at most 32 bytes asserted for both
hash policies, Record unchanged at 248; QueuedRecord { inline_priority,
boxed }; Timer, ChannelSend and PartitionType boxed; parked readers
Arc<(Box<Record>, Lhs)>; the crash queue and the partition queue hold
Box<Record>).

Review of the diff. QueuedRecord is built only by new and exposes only a
read-only Deref, with no DerefMut, so code mutating a queued record in place
would no longer compile and the priority copy cannot drift - by
construction, not by audit. Records leave and re-enter queues through
into_record and new; the crash path and activate_partition move the record
instead of cloning it; a shared waiting-reader pop clones the box and counts
it; exec_legacy and exec_ops take the env out with mem::take and put it back
before re-queueing; every creation site (async calls in both interpreters,
client ops, recovery, timers, channel sends, partitions) boxes once with a
counter. The eligible lists collect the same filter into inline storage in
the same order, tested against a Vec reference inline and spilled.

Checks (release): 524 tests at A, 526 at B. Identity, every table both ways:
VR 3,008 runs for A and for B, Mencius 2,160 and the caps-engaged 100,000
for B - identical, stall_cap_runs.csv hashes equal, end reasons equal
(100,000: deadlock 19, iterations_exhausted 30,030, learned_cap_reached
18,308, plan_complete 29,129, stall_cap_reached 22,514), cap figures equal.
Leaves outside clocks, folded_increments and the new counters differ only
in writer timing (the baseline side of the 100,000-run identity blocked
877.8 ms with one full-queue send; the candidate none).

Counters: the exact identity async record boxes + timer boxes + make()
channels = channels_created held on every run and every arm;
eligible_lists_built equals decisions exactly; other_record_boxes 8.4-8.8 per
run (at most 40); channel_send_boxes and partition_boxes 0. Watched, read
per round: timer_boxes 377.8 per run on the 3,008-run VR identity and 230.9
on the 100,000-run one against [150, 320], with three arms of the latter
outside; heap spills 0.19 and 0.90 percent of lists (at most 1 percent), with
three arms of the 100,000-run identity between 1.43 and 2.03 percent. The
bands were set on grader rounds, whose runs are shorter, so the rounds
decide. folded_increments falls short by exactly 3 per run with the boxing
counters, which the implementer places in the servers' Init before a run's
counter block opens; session totals are intact.

Grading as frozen: a plain-cycles profile of commit A (running), then of the
composite, then three rounds on cross-binary runs per second, regression
only, counters by hand every round.

### records-boxed-and-index-lists-inline: index-lists-only profile, H2's own guards

Profile 45517fd-cand-index-lists-inline.md (plain cycles) against
45517fd.md; R_cand = 11.69 (ceval 7.78, Int64 interner 1.25, GenericNode
1.26, format_escaped_str 1.40), r = 1.017. Reporter cutoff 1 percent: a
line absent from the self table is read from the self column of the
inclusive table when its row is there, and is otherwise only known to be
under 1.
- memmove self 5.92 to 6.14 (6.04 x r), at most 6.07: held, narrowly.
- malloc + _int_malloc + cfree + _int_free_chunk: 5.34 to 2.04 + under 1 +
  0.31 + 1.00, at most 4.35 even at the cutoff bound (4.28 x r), at most
  4.74: held.
- realloc 0.54 to below the inclusive cutoff, at most 0.25 x r required:
  unverifiable from this profile (under 1 is all it shows).
- scheduler family, above-cutoff self rows as frozen: 12.94 to 13.50
  (6.70, 2.26, 2.04, 1.29, 1.21), 13.28 x r, at most 13.09: FIRED by 0.19.
  With below-cutoff instances from the inclusive table the family rises 1.27
  on the candidate against 0.70 on the baseline, so the rise is not a table
  artefact. Mechanism: the inline collect's push loop now runs inside
  schedule_runnable, the relocation the +0.15 allowance was set against,
  while the allocator lines fell by about 2.
- walk_recovery_placebo self 1.79 to 1.45, 1.43 x r, outside its described
  [1.49, 2.09]: description, referred to the search loop's owner before any
  merge. Its code is untouched; its cost moved under the list change alone.

Decision on H2 deferred until the composite profile is read, because the
composite's attribution rule reads H1's guards as differences against this
profile.

### records-boxed-and-index-lists-inline: composite profile, H1 guards, departure registered before rounds

Profile 45517fd-cand-records-boxed-and-index-lists-inline.md (plain
cycles); R_cand = 11.68, r = 1.016.
- H1 memmove self 5.92 to 2.81 (2.77 x r), at most 3.65: held, well
  inside (the moves left, beyond the corrected 2.7-3.6 expectation).
- H1 exec_ops self 7.53 to 7.97 (7.85 x r), at most 7.93: held, narrowly.
- H1 scheduler family, composite minus index-lists-only, self rows: 14.13
  x r minus 13.28 x r = +0.85, at most +0.6: FIRED.
- H1 allocator family delta: composite 4.98 (malloc 2.53, _int_malloc 0.94
  from the inclusive table, cfree 0.38, _int_free_chunk 1.13, realloc below
  cutoff) against the index-lists-only 3.35, where _int_malloc and realloc
  were below both tables' cutoff and read as 0 though each may be up to 1:
  +1.61 as read, anywhere from about -0.4 to +1.6 in truth, at most +0.7:
  unverifiable, not a clean fire.
- composite allocator family 4.98 (4.90 x r), at most 5.08: held.
- walk_recovery_placebo self 1.36 (1.34 x r), below its described
  [1.49, 2.09] on both candidate profiles: referred to the search loop's
  owner before any merge.
- composite against 45517fd, self rows: memmove -3.11, scheduler family
  +1.41, allocator family -0.90 (5.88 to 4.98), exec_ops +0.44, placebo
  -0.43.

Departure registered before any round (autonomous). By the frozen text any
fired guard refutes, and the attribution rule would close both parts (H2's
scheduler guard fired by 0.19; H1's scheduler delta by 0.25). This case
differs from the closes of trace-payload-escaped-in-one-pass and
node-env-detached-per-segment, where the mechanism's own central observable
failed (the scan moved; make_unique stayed). Here the central observable -
memmove leaving - held with room, and what fired are the allowances set
for work relocated into the scheduler, which are proxies for net cost. The
wall reads net cost directly, and three rounds are affordable. Criterion,
fixed now and stricter than the frozen wall reading: the composite merges
only if cross-binary runs per second separates UPWARD (the interval's lower
edge above 1.0) with every other falsifier held and the neutrality check
inside or covered by the identical caps-engaged run. Not separated, or
separated downward: closed, both parts, with no second session. A merge is
further held for the user's reading of the placebo referral before it is
committed, since the placebo is the search loop's control.

### records-boxed-and-index-lists-inline: three rounds and decision (autonomous)

Seeds 1000-1002 against 45517fd:
- cross-binary runs per second 1.0101, 1.0816, 0.9519; mean 1.0132
  [0.8644, 1.1875], not separated either way; microseconds per run 1.0150;
  steps per run 1.0106. Every neutrality row inside the baseline's spread.
- counters every round: the exact identity async record boxes + timer boxes
  + make() channels = channels_created held (1,212,903,675 /
  1,194,462,047 / 1,194,949,649); eligible_lists_built equals decisions and
  queue_info_builds equals steps_total exactly; timer_boxes 155.5, 155.3,
  167.2 per run [150, 320]; other_record_boxes 9.4 (at most 40). Heap spills
  1.483, 1.638 and 1.680 percent of lists, above the 1 percent limit in every
  round - the eligible lists outgrow 14 entries more often on the graded
  workload than on the one-thread identity (0.19 percent).
- writers blocked at most 0.09 us per run; full-queue sends 0, 78, 0 on the
  candidate.

Decision: closed, both parts, as registered before the rounds - runs per
second did not separate upward. The close stands on the frozen text as well:
H2's scheduler-family guard and spill falsifier both fired, and H1's
scheduler-family delta fired. No second session. Patches kept at
research/perf/patches/records-boxed-and-index-lists-inline.spur.patch
(composite) and step-index-lists-inline.spur.patch (the lists alone).

What the close teaches. The boxing did remove the moves - memmove fell by
more than half, the largest single-line reduction a candidate has produced
since the switch to plain cycles - but the saving did not reach the wall:
the scheduler family and exec_ops absorbed it, consistent with a pointer
follow per queue element on the walks the scheduler does every step. The
placebo referral is moot with no merge; it is recorded for the user: under
both changes walk_recovery_placebo's self share fell by a fifth to a
quarter with its code untouched, so any future change to how queue elements
are laid out moves the search loop's cost-matched control.

Iteration 15 closes with no merge. The loop pauses here at the user's
request.

## Iteration 16 - autonomous, redundant-work lens, profile 45517fd on plain cycles (one more iteration at the user's request)

The user asked for one more iteration after the pause; the loop pauses again
when it closes. Tree unchanged at 45517fd, so its plain-cycles profile and
caller attribution stand as the proposer's inputs; no new profile.

Lens: redundant work per step. Focus directive, from the attribution and
what iterations 14 and 15 taught (mechanisms that removed a line saw the
work relocate into the scheduler or exec_ops, or left the dominant part of
the line in place):
- Env::set's make_mut on every slot write - most of make_unique is the
  refcount check on an already-unique buffer, not copying; whether
  uniqueness can be established once per segment or frame.
- schedule_runnable's per-step recomputation - queue sizes and eligibility
  recomputed every step over queues no event touched; incremental
  maintenance rather than a new representation, and not a rewrite of how
  selection walks.
- map literals built by repeated inserts (76-78 percent of imbl insert) -
  a decode-time template or a one-pass build.
Every price cites the attribution and states where the removed work could
reappear, with a guard on that relocation.

### Proposals

All search-neutral, shared, priced from the attribution with a relocation
guard; runs per second is regression-only for every one (none clears the
0.05 floor or the round-to-round spread of about 6 percent on this tree).
- eligible-lists-known-from-queue-info (net 1.3-2.1, [1.010, 1.025]): the
  scheduler re-filters the chosen queue into a fresh Vec with the predicate
  its count pass just applied; when the count equals the queue length the
  selection borrows a static identity slice, otherwise the list is collected
  at exact capacity; local_queue_sizes moves into a buffer reused across
  steps. Counter sched.eligible_built; guards: allocator lines down at least
  0.9 x r, scheduler family not rising. Placebo likely to move (disclosed).
- delivered-record-not-copied (net 0.5-1.1): the four by-value hand-offs of
  a delivered Record (scheduler.rs:1271, 1483, 1702, exec.rs:855; 17.5
  percent of memmove) replaced by one take and a direct bind with exec
  inlined. No per-run counter can see it; primary would be the memmove line
  plus an objdump count.
- slot-buffers-owned-per-segment (net 1.7-2.3): Env slots become an owned
  Vec<Value>, each segment detaching its node's environment and writing it
  back, so every refcount check and make_unique itself go (the reason
  node-env-detached-per-segment closed). Record grows 8 bytes; a Record
  clone becomes a deep copy. Counter env.buffer_copies at most 5 per run
  (about 190 today); hard guard: no make_unique call in the binary.
- the three as one change, [1.030, 1.060], guards separable.
Set aside: map-literal templates (the first field write copies the 2.8 KB
root anyway; ceiling about 0.1), an inline refcount check keeping EcoVec
(unsound without patching ecow), queue sizes maintained across steps (the
answers change every step; queue-eligibility-from-counters read no gain).

### Judgment (autonomous)

eligible-lists-known-from-queue-info net 6, slot-buffers-owned-per-segment
net 3 (mechanism and prediction rewritten), the two as one change net 3 and
built; delivered-record-not-copied net 1, kept in the pool unbuilt because
no grader primary can read it. Nothing scored 0. Corrections are in the pool
entries; the full record is tmp/loop/perf/it16-judgment.md.

Ruling on the merge criterion the judge asked for. The standing rule applies:
a merge rests on the counters, identity, every frozen guard held, and no
downward separation of runs per second. Iteration 15's "runs per second must
separate upward" was the price of a departure from fired relocation guards,
not a new standing rule; it applies again only where a guard fires and a
departure is taken. Without that distinction nothing whose saving sits
inside the round-to-round spread could merge, and a reading below the floor
with every guard held is exactly the case the counter-and-guard rule was
written for. Placebo readings outside [1.49, 2.09] x r go to the user before
any merge, as before.

Build: the eligible lists then the owned slots, two commits; identity on
both and caps-engaged on the composite; two plain-cycles profiles; three
rounds.

User direction, recorded: keep running iterations until told to stop again
(the pause after iteration 15 and the one-more-iteration limit are lifted).

### eligible-lists-and-owned-slots: implementer report and review before grading

Two commits on 45517fd. A (eligible lists): EligibleList lends a static
0..128 index slice when the queue's admitted count equals its length and the
length is at most 128, and otherwise builds with the same filter at exact
capacity; local_queue_sizes lives in a buffer owned by exec_plan, cleared
and extended each step; counters sched.eligible_known, eligible_built and
eligible_built_long after the empty-list check. B (owned slots): Slots is a
crate-private Vec<Value> wrapper whose Clone is the only copy path and
counts env.buffer_copies; Env::detach without a clone-under-EAGER branch;
record, sync and legacy segments move the node env out and put it back on
every exit (node_env.moved_out / put_back); the four wake sites store in
place; crash_node's network path and activate_partition move records
instead of cloning.

Review of the diff. The fast path trusts that the admitted count used the
filter's predicate: true for local and network queues, and for the timer
queue under strict_timers too - timer_queue_size is counted with the same
allowed_timers check (scheduler.rs:1169), so the lent list is exact with
strict timers on. A wake site storing into state.nodes[i] for the node that
is mid-segment writes into the placeholder, which put-back overwrites; the
old code wrote into a stale clone that segment end overwrote the same way,
so the behaviour is unchanged. FrameBuilder builds a Vec; set_local no
longer asks whether a frame is shared (it cannot be).

Checks (release): tests pass at A (478 unit plus integration) and B (481).
objdump: direct calls to EcoVec<Value<NoHashing>>::make_unique 591 sites in
85 functions on 45517fd, 1 on the composite (eval::update_collection, the
list store). Identity against 45517fd, every table both ways: VR 3,008 and
Mencius 2,160 on both binaries, caps-engaged 100,000 on the composite -
identical, stall_cap_runs.csv hashes equal, end reasons and cap figures
equal, frame.* identical. Leaves outside clocks and new counters: only
stats_local.folded_increments, rising by exactly the new sched bumps.
Counters: known + built = recovery_weight_placebo.decisions =
multiplier_authority.decisions exactly, per arm, on VR and caps-engaged;
decisions / eligible_built 4,775 (VR) and 78.0 (caps-engaged), band at
least 3; eligible_built_long 0 and 24 (0.0009 percent of built);
env.buffer_copies 0 per run; moved_out = put_back exactly, per arm.
moved_out per run 2,933 and 1,949 against [1,400, 1,800]: these identity
runs are longer (3,389 and 2,200 steps per run against about 1,727 in graded
rounds) and moved_out per step (0.865, 0.886) matches iteration 14's 0.915;
not a falsifier, the rounds decide. Deviations accepted: exec_legacy moves
and puts back too; a failed record segment keeps partial node writes under
both hash policies (unobservable - a failed run writes no row);
frame.entry_frame_copies is 0 by construction; Env.slots is pub(crate).

Grading: profile of commit A (running), then of the composite, a part whose
own guard fires closing before any round; three rounds on cross-binary runs
per second under the standing rule.

### eligible-lists-and-owned-slots: profiles and decisions before rounds (autonomous)

Reading rule as frozen: a row from the self table, or below the cutoff from
the inclusive table's self column; a row absent from both is bounded
[0, 1.0); a guard holds if its upper bound meets it and fires if its lower
bound breaks it. The two families the judgment named by total were
reconstructed on 45517fd before use: R3 = Int64 interner 1.28 + GenericNode
1.26 + format_escaped_str 1.23 + exec_plan (RecordRng) 1.74 = 5.51, and the
interpreter family = every exec_ops and run_sync_ops row = 11.42.

Eligible lists alone (45517fd-cand-eligible-lists-known.md), r = 1.058:
- allocator malloc + cfree + _int_free_chunk 2.15 + 0.39 + 0.92 = 3.46
  (3.27 x r), at most 3.73: held.
- scheduler family: the frozen rows sum to 12.28 with the SpecFromIter row
  gone (bounded under 1), upper bound 13.28, at most 13.11 x r + 0.15 =
  14.02: held; the family fell, as the mechanism predicts.
- Map<Iter<Vec<Runnable>>> fold 1.38 (1.30 x r) within [1.05, 1.65]: held.
- walk_recovery_placebo 1.42 (1.34 x r), below its described [1.49, 2.09]:
  referred to the user before any merge.

Composite (45517fd-cand-eligible-lists-and-owned-slots.md), R3 r = 1.040:
- make_unique absent from both tables; objdump 1 call site, the list store:
  held.
- Value drop family 4.96 to 3.26 (drop_glue<ValueKind> 2.52, EcoVec<Value>
  drop 0.74), a fall of 1.90 against at least 0.62: held.
- interpreter family 11.84, at most 12.28: held. memmove 6.17, at most
  6.47: held. Allocator 3.48, at most 4.50, and +0.02 over the lists-only
  profile, at most +0.1: held.
- scheduler family 13.40 (7.34, 2.32, 2.20, 1.54) against the lists-only
  11.73, at most 11.73 x r + 0.2 = 11.73: FIRED by 1.67.
- placebo 1.93 (1.86 x r3, 2.01 against R), inside its band.

Decisions. slot-buffers-owned-per-segment: closed before rounds on its frozen
scheduler-family guard, no departure. Its central observables held -
make_unique is gone and the Value drop family fell by 1.90 - but the
scheduler rose by 1.67 and the interpreter family by about 0.4, which is the
node-env-detached-per-segment pattern again: the drops leave and the
scheduler and interpreter take the time back. Unlike iteration 15 nothing
here predicts a wall gain, so there is no ground for a departure. Patch kept.
eligible-lists-known-from-queue-info: every frozen guard held on its own
commit, so by the attribution rule it is graded alone on commit A
(cand-spur-h1): three rounds, cross-binary runs per second [1.010, 1.025]
regression only, counters by hand. Identity: VR and Mencius identical on
commit A; the caps-engaged run on the composite covers its code. Its placebo
reading is below the described band, so a merge waits for the user's reading
of that referral.

### eligible-lists-known-from-queue-info: three rounds (autonomous)

Seeds 1000-1002 against 45517fd, the eligible lists alone (commit A):
- cross-binary runs per second 1.0465, 1.0011, 0.9965; mean 1.0145
  [0.9486, 1.0849], not separated; microseconds per run 1.0151. Regression
  reading held.
- counters every round: eligible_known + eligible_built equals
  recovery_weight_placebo.decisions and multiplier_authority.decisions to
  the unit (1,684,190,627 / 1,689,640,535 / 1,683,961,518); decisions over
  built 38.7, 40.4, 40.2 (at least 3); eligible_built_long 855, 852, 1,221
  (0.002-0.003 percent of built). Writers blocked 0.
- neutrality: steps per run 1,833.0 against 1,730.4 (allowed 77.1) and
  grid-no-purgatory arm share 0.2054 against 0.2120 (allowed 0.0021) read
  outside the baseline's spread; every end-reason row inside. The frozen
  falsifier exempts this case where an identical caps-engaged run covers the
  code: the 100,000-run caps-engaged identity on the composite, whose code is
  a superset of this commit, read identical on every table, end reason and
  cap figure, which the judgment names as covering this commit. Recorded all
  the same: the steps-per-run shift (+5.9 percent) is larger than the
  throughput responses seen before, and it arrives with a smaller runs-per-
  second change than they had.
- profile guards (read before rounds) all held.

Reading: merge-eligible under the standing rule - counters exact and in band,
identity identical, every guard held, no downward separation, neutrality
covered by the caps-engaged run. Not merged yet: the frozen prediction sends a
walk_recovery_placebo reading outside [1.49, 2.09] x r to the search loop's
owner before any merge, and this commit's profile read 1.34 x r (1.79 to
1.42 self, code untouched). Put to the user.

### eligible-lists-known-from-queue-info: user reading and merge

The user read the placebo referral and chose to merge: the placebo and the
recovery-weight scoring it is cost-matched to read the same slice through
the same accessors, so the pairing holds and its absolute cost falling is a
side effect of the scheduler getting cheaper.

Revert criterion, fixed before the post-merge baseline is measured: the
primary is regression-only and the clock can only block, so the line is set
on regression - the merge is reverted if the fresh baseline at the merged
spur commit reads below 7295 runs per second over three rounds, 0.97x the
7521.3 cached for 45517fd over 15 rounds.

### Post-merge baseline: the merge stands

Merged: spur 11a720c, superproject 1089040. The fresh baseline at 11a720c
reads 8,017.4 runs per second over three rounds (7,914.9, 8,136.4, 8,000.9),
spread 0.0139, against 7,521.3 cached for 45517fd over 15 rounds - plus 6.6
percent, above the registered revert line of 7,295. Against the 7,669.9
measured right after frame-slots-by-liveness merged it is plus 4.5 percent;
the 15-round cache includes rounds from later sessions, so part of the
difference is session-to-session host drift. Writers 356.6-376.5 us busy per
run, blocked at most 0.03 us, full-queue sends 0, 8, 28. Known over built
eligible lists about 37 per round. Ledger row appended with ratio 1.0145;
cumulative 3.684.

Iteration 16 closes with one merge (eligible-lists-known-from-queue-info)
and one close (slot-buffers-owned-per-segment); delivered-record-not-copied
stays in the pool unbuilt. The loop continues at the user's direction:
iteration 17 profiles 11a720c.

## Iteration 17 - autonomous, contention lens, profile 11a720c

Profile 11a720c.md (plain cycles). Self: ceval 7.96; schedule_runnable
6.45, 2.15, 1.94 and the queue-size fold 1.39; memmove 6.00; exec_ops 5.48,
1.30, 1.18; drop_glue<ValueKind> 2.94; run_sync_ops 2.58; EcoVec<Value>
drop 2.39; malloc 2.14; exec_plan 2.04; ValueKind::clone 1.92;
walk_recovery_placebo 1.44; format_escaped_str 1.32; Int64 interner 1.31
(writer); GenericNode 1.24; score_with_terms 1.13 (above the cutoff for the
first time). Writer threads 10.04 inclusive. No lock, futex or channel
symbol above the cutoff.

Lens: contention and parallelism. A cycles profile cannot see threads
waiting without burning cycles, so the directive asks for pricing from the
utilization counters of the 11a720c baseline cache: grid-pool idle per run,
the batched AOS path where every worker waits for a batch's slowest run,
writer busy share and full-queue sends at about 8,000 runs per second, and
any barrier between arms or slices - priced in lost worker-seconds per
wall-second. Writer-side changes only if writers are shown binding.

### Wall-time accounting and proposals

Accounting from the 11a720c baseline counters (three 120 s rounds, 30
workers, 4 writers), in worker-seconds (ws) per round:
- grid pools 80 percent of the session: 228.0 ws idle, 7.9 percent of
  capacity, 274 us per grid run.
- AOS batched path 19.6 percent of the session: 299.6 ws idle, 42.5 percent
  of AOS capacity - 12.7 of 30 workers idle on average during AOS slices,
  each 60-run batch holding the pool 10.3-11.2 ms against 5.9-6.5 ms of job
  wall per worker.
- outside any pool (slice boundaries, setup): 16.4 ws, 0.45 percent.
- in all, 544 ws per round not running, 15.1 percent of thread wall, 4.53
  workers per wall-second.
- writers 72.5-74.5 percent busy, blocked at most 27.7 ns per row: not
  binding. CPU demand about 30.6 of 32 logical CPUs in grid slices, about
  20.2 in AOS slices.

Proposals:
- aos-draw-ahead-pool (search-affecting): the campaign's AOS arm runs on an
  ordered-release pool that may draw up to two batches ahead of the newest
  credited one while workers would otherwise idle; run ids, draw order, per-run
  seeds, credit order and the once-per-batch bandit recompute are held, and at
  one worker nothing is drawn ahead, so the one-thread schedule is today's.
  Primary batched_worker_idle_ns per row [2.3, 6.5]; runs per second
  1.010-1.062, regression only; owes the lite reading.
- grid-pool-worker-continues (declared neutral, flagged): a completing job
  applies its completion and the pool's passes under a mutex and takes the
  next run itself, instead of waking the main thread per completion; every
  decision is the same code in the same order. Primary worker_idle_ns per row
  [1.6, 5.0]; runs per second [1.01, 1.04].
- the two on one worker-continuing engine, affecting, [1.02, 1.10].
Set aside, noted as a possible rider: GlobalTimeline on a 128-shard DashMap
holding one live key read-locks all shards twice per run (about 257
acquisitions of shared lock words, estimated 20-40 us per run).

### Judgment (autonomous)

The judge recomputed the accounting exactly and ranked: aos-draw-ahead-pool
net 5, built first; timeline-store-one-lock net 3, split out of the rider
into its own candidate and built in parallel; grid-pool-worker-continues net
2, after the AOS pool; the composite not built. Notable findings:
- the counters: grid job wall includes the writer send wait (negligible at
  27.7 ns blocked per row); the batched_ leaves are AOS-only; the AOS pool
  wall is per batch and leaves the serial draw and credit between batches in
  "outside any pool", which H1's per-slice capacity will count - biasing its
  primary against the candidate by at most about 5 percent, disclosed.
- per-arm grid idle from the edb9e2f pool smoke: grid 17.6 percent,
  grid-short 6.5, grid-no-purgatory 2.9, grid-post-fault-2 2.8 - so most grid
  idle is capacity gating, and the grid dispatch round trip is at most about
  43 percent of it. The grid change's band was rewritten down accordingly.
- H1 corrections: one-thread batch size 32; whole batches past the slice cap
  as today (608 runs at 600-run slices); credit before issue for zero
  draw-ahead at one worker; one gated seed batch per session; the drain
  credits and recomputes; the profile reference over every specialization.
- lite grading of H1: the lite grader excludes AOS from its per-second rate
  (decide.ts:29) and pools every arm in its per-run deep guards, so an
  AOS-only change is diluted about eightfold and could not cross the 0.25
  margin; an AOS-arm hand reading of depth>=6 and depth>=8 per run through
  the same posterior test is frozen beside the grader's reading - regressed
  refutes, unresolved goes to the user. Budget 1.5-3 hours of lite chunks.
- H1's extra runs are AOS runs, which the lite per-second rung ignores:
  noted for the user, not a grading issue.

### timeline-store-one-lock: implementer report and review

Built on 11a720c in feedback.rs, util_stats.rs and the completeness test:
GlobalTimeline's DashMap<TimelineTuple, u64> becomes
RwLock<HashMap<TimelineTuple, u64, FxBuildHasher>> with the total still an
atomic. snapshot() takes one read lock and collects into the std HashMap
TimelineSnap already holds (read only through contains_key and get, so no
order is observable); merge() takes one write lock across the run's tuples
and reads the live key count before releasing; decay() retains and recomputes
the total under the write lock. dashmap stays a dependency (arm_selector,
coverage, fault_timing, run_cap, ghost_release, stall_cap, spur-lsp).
Counters timeline_store.snapshots and timeline_store.merges, plain session
atomics under enabled() so folded_increments does not move.

Review of the diff: matches the report. One cost to watch: a merge now holds
the write lock across all of a run's tuples, so run-start snapshots on other
threads wait for it, where the old store took a shard lock per tuple. With one
live key the increments are short; std RwLock on Linux gives waiting writers
priority, so merges are not starved. The rounds read the net.

Checks (release): 523 spur-core tests pass, including a reference test of 400
random merges with decays 0.5, 0.9, 0.0 and 1.0 against a copy of the old
sharded store, comparing snapshot maps and totals after every merge. One-
thread identity against 11a720c: VR 3,008 and Mencius 2,160 runs, runs /
executions / logs / traces identical both ways, end reasons equal,
stall_cap_runs.csv hashes equal. snapshots = merges = runs on VR (1 per run,
per arm too); 0 on Mencius, whose config has no feedback block. Other leaves:
only history_writer text-buffer and per-arm command counts, which a second
baseline-against-baseline run shows move by writer timing alone.

Graded in its own session after aos-draw-ahead-pool is decided.

### aos-draw-ahead-pool: implementer report and review before grading

Built on 11a720c: campaign.rs AosArm on run_aos_release (AOS_LOOKAHEAD_BATCHES
= 2) behind a small AosPlan trait; Completion and CompletionSender generic
over the outcome, the grid pool changed only in type parameters; explorer.rs
AosExplorer::split into a runner half (envelope, global state, weights) and a
controller half (ctrl_rng, bandit, scenario tuples, population, seeded);
util_stats AosPoolSession writing the existing batched_ leaves once per slice
over the slice's pool wall, plus aos_pool.drawn_ahead_batches,
gated_seed_batches and uncredited_at_draw_sum. AosExplorer::step, standalone
-e aos and Mode C unchanged.

Review of the diff. Each wake credits finished batches in batch order, then
position order, with one recompute per batch; then draws only while
in_flight + ready < workers and at most two batches are uncredited; then
starts runs oldest batch first in position order. At one worker a draw needs
in_flight = ready = 0, so the previous batch is launched, finished and
credited first - drawn_ahead is 0 by construction. seeding() reads credited
state: a seed batch waits while any batch is uncredited (counted once per
wait) and seeded flips only in finish_batch, so population is non-empty
whenever a non-seed draw calls select_parent. A completion's batch index
cannot fall behind front_seq, since front_seq advances only past fully
finished batches. next_batch issues whole batches, as StrategyArm does. The
runner and controller borrows are disjoint by construction.

Checks (release): 483 lib tests plus every integration file. New tests: at
one worker the pool's draw / credit / close sequence equals whole batches with
starts in id order; against AosExplorer::step on the kv fixture the random
stream state, bandit q and p bits, population, seeded flag and run counter
are equal after every slice; at 30 workers staleness never exceeds 2
recomputes and 120 insertions, a seed batch is never drawn ahead, credits in
id order, gated_seed_batches exactly 1; the drain leaves everything credited;
a 600-run slice at batch 32 gives 608 runs at 1 and 30 workers. Identity
against 11a720c: VR 3,008, Mencius 2,160 (regression only; not a campaign
arm) and caps-engaged 100,000 identical on every table both ways, stall_cap
hashes equal, end reasons, per-arm runs and cap figures equal,
drawn_ahead_batches 0. Other leaves: only writer-timing text-buffer counts.
At one thread batched_worker_idle_ns rises as disclosed (the coordinator's
draw and credit time now counts inside capacity).

Pre-round smoke gate, 30 threads, 120 s, seed 1000 (963,360 runs): AOS busy
share 0.924 (below 0.78 falsifies: held); batched_worker_idle_ns 57.0 us per
row against the cache's 305-314 (about 5.4x; primary below 2.3 falsifies:
held); AOS runs per AOS pool-second 7,354 against 5,356-5,830 (below 1.10x
falsifies: held); AOS us per run 3,709 against 2,929-3,190 (above 1.40x
falsifies: held, about 1.16-1.27x); writers blocked 0; drawn_ahead 98.5
percent of batches (description band 55-95, above); uncredited at draw 1.644
per batch (inside); gated seed batches 1. Per-arm share: aos 0.183. The
exported binary was rebuilt after test- and comment-only edits; its .text and
.rodata are byte-identical to the identity build.

Grading next: plain-cycles candidate profile (running), three or more rounds
on the primary batched_worker_idle_ns per row, then the lite reading with the
frozen AOS-arm hand reading if the primary is not below 2.3.

### aos-draw-ahead-pool: candidate profile

Profile 11a720c-cand-aos-draw-ahead-pool.md (plain cycles) against
11a720c.md. R_all over every specialization of ceval, exec_ops, run_sync_ops,
memmove and drop_glue<ValueKind>: 28.70 on the baseline (reproduces the
frozen figure), 28.23 on the candidate, r = 0.984.
- new pool symbols self at most 0.30 x r: nothing above the cutoff (the
  pool's spawn wrapper and AosRunner appear only in the inclusive table at
  0.00 self): held.
- no std Mutex, futex, lock_contended, parking_lot or rayon sleep symbol in
  either table: held.
- description: ceval 7.96 to 7.59, exec_ops 7.96 to 7.70, run_sync_ops 3.84
  to 3.92, memmove 6.00 to 6.17, drop_glue<ValueKind> 2.94 to 2.85,
  schedule_runnable family 11.93 to 12.47, malloc 2.14 to 2.16.
- walk_recovery_placebo 1.44 to 1.72, 1.21 times its reference against the
  described [0.9, 1.1]: referred to the user before any merge. A plausible
  reading is the run mix - AOS runs rise from about 13 to about 18 percent of
  the session - rather than any change to the walk, whose code is untouched.

Rounds running (primary grid_pool.batched_worker_idle_ns per row, band
[2.3, 6.5]).

### aos-draw-ahead-pool: three rounds

Seeds 1000-1002 against 11a720c:
- primary grid_pool.batched_worker_idle_ns per row, baseline over candidate
  7.1747, 6.5997, 6.1020; mean 6.611 [5.406, 8.084], separated, band
  [2.3, 6.5] read inside (mean at the upper edge): 316.5 / 313.2 / 331.6 us
  per row to 44.1 / 47.5 / 54.3.
- falsifiers, every round: AOS busy share 0.943, 0.936, 0.931 (below 0.78
  falsifies: held); AOS runs per AOS pool-second 1.303, 1.327, 1.501 times
  the baseline (below 1.10: held); AOS us per run 1.242, 1.216, 1.062 times
  (above 1.40: held); writers blocked at most 0.085 us per row (above 50:
  held), full-queue sends 0, 39, 82.
- drawn ahead 99.5, 99.2, 99.2 percent of batches (description 55-95,
  above); uncredited at draw 1.72, 1.76, 1.69 per batch (inside); one gated
  seed batch per session.
- runs per second 1.0030, 1.0190, 1.0241; mean 1.0153 [0.9882, 1.0431], not
  separated (regression reading held). Microseconds per run 0.933, the mix
  moving toward longer AOS runs; AOS share of runs 0.131 to 0.181; grid idle
  per row unchanged (231.7 / 226.8 / 249.9 to 228.3 / 215.0 / 226.3).
- neutrality rows (plan_complete share, four arm shares) outside the spread:
  description for a search-affecting declaration.
- blocker: the owed lite reading and the protocol panel note.

Next: the lite session, two cross-binary chunks to start under v3 (the
first also measuring a lite baseline for 11a720c), deep guards per run on
depth>=6 and depth>=8 at the 0.25 margin, the frozen AOS-arm hand reading
beside it, and the panel recorded as blind to the campaign arms.

### aos-draw-ahead-pool: lite chunk 1 (of at least 2)

Cross-binary lite session under internal-primary-v3, the first chunk also
measuring the lite baseline for 11a720c. After chunk 1 (240 s of exposure a
side, 0 violations, throughput 1.031):
- depth>=8 events per explore-second 0.9485, separated below the baseline at
  z 2.7 (-5.14 percent, beyond the 5 percent layout floor); depth>=6 0.9668.
- if stopped now the rule reads close ("depth>=8 per second separated below
  the baseline"); canStillAdvance false.

A plausible mechanism, recorded before chunk 2 reads: the lite grader
excludes AOS runs from its per-second rate (decide.ts RATE_EXCLUDED_ARM_MODES)
and the pool moves worker time from grid runs to AOS runs (AOS share of runs
0.131 to 0.181 in the perf rounds), so the grid runs the rate counts fall even
while total runs per second rise. The pool buys runs the search objective does
not count at the cost of runs it does. Chunk 2 (the grader's minimum) runs
before any decision.

### aos-draw-ahead-pool: lite chunk 2 and decision (autonomous)

After two chunks (480 s of exposure a side, 0 violations, throughput
1.023), every rung per explore-second reads about 4 percent below the
baseline in both chunks: depth>=4 0.9575, depth>=6 0.9567, depth>=8 0.9578
(per chunk 164.5 and 165.5 events per second on the candidate), depth>=9
0.9643, depth>=10 0.9649, pGreater near 0 on the first three. The rule
reads human: the -4.22 percent on depth>=8 sits inside the 5 percent layout
floor, while its own blockers name depth>=8 per second separated below at
z 2.7, and no remaining chunk can produce a separated advance. The finish
record (per-run deep guards) is at tmp/loop/perf/lite-aos-draw-ahead-pool/
finish.json and its reading is appended below the decision row's reason.

Decision: closed. The loss is uniform across rungs and is what the mechanism
registered before chunk 2 predicts: worker time moves from the grid runs the
lite per-second rate counts to the AOS runs it excludes (AOS share 0.131 to
0.181 in the perf rounds), so deep events per explore-second fall even as
total runs rise. Chunks 3-4 cannot reach an advance, and a 4 percent loss of
the search objective is not a trade this loop makes for runs the objective
does not count. Its perf counters were excellent; they measured utilization,
not search. Patch kept.

What it teaches: in this campaign, idle AOS capacity is not free capacity -
the AOS arm's share of workers is set by its slice, and filling its idle
workers with more AOS runs displaces nothing only if grid runs were not
waiting for those workers. Pricing a contention change here has to follow
where the recovered worker time goes, by arm, against what the objective
counts.

Next: timeline-store-one-lock, candidate profile then three rounds.

aos-draw-ahead-pool lite finish, appended: adviceVerdict human
("cross-binary depth>=8/s -4.22% is inside the 5% build-layout floor");
improved none, regressed none, unresolved guards none. Per graded run the
pooled deep guards rose - depth>=6 +1.98 percent, depth>=8 +0.71 percent -
while per explore-second the same rungs fell 4.29 and 4.22 percent;
throughput +2.29 percent. So runs did not get shallower: the counted runs per
second got fewer, which is the composition mechanism the close rests on.
The lite state (research/lite/state/aos-draw-ahead-pool*) and its baseline
cache for 11a720c are left as the grader wrote them.

### timeline-store-one-lock: candidate profile, departure criterion registered before any round is read

Profile 11a720c-cand-timeline-store-one-lock.md (plain cycles) against
11a720c.md; r over R_all (every ceval, exec_ops, run_sync_ops, memmove and
drop_glue<ValueKind> row) = 28.66 / 28.70 = 0.999.
- GlobalTimeline::snapshot, merge and every dashmap, RwLock, futex or
  lock_contended symbol absent above the cutoff: held - trivially, since none
  was above it on the baseline either.
- malloc not rising over x r: 2.14 to 2.22 (base x r 2.14): FIRES as frozen
  text. The mechanism removes 128 malloc/free pairs per run, roughly 1 percent
  of this workload's mallocs, a drop of a few hundredths of a share - smaller
  than the 0.08 that moved. The guard was the only profile evidence the
  judgment could name and it is noise-sized either way. _int_malloc 0.79 to
  0.83, cfree 0.38 to 0.40, _int_free_chunk 0.97 to 0.90 (inclusive-table
  self), description.
- walk_recovery_placebo 1.44 to 1.66, 1.154 of its reference against the
  described [0.9, 1.1]: referred to the user before any merge.
- description: schedule_runnable family 11.93 to 12.98, ceval 7.96 to 7.88,
  exec_plan 3.22 to 3.06, memmove 6.00 to 6.05.

Departure registered before any round result is read (the rounds started
before this profile was read; none has been looked at): by the frozen text
the fired malloc guard refutes. By the standing departure rule stated in
iteration 16, the candidate merges only if cross-binary runs per second
separates UPWARD (interval lower edge above 1.0) with every other falsifier
held, the counters exactly one snapshot and one merge per run, and the
placebo referral read by the user. Otherwise it closes on the malloc guard.

### timeline-store-one-lock: three rounds and decision (autonomous)

Seeds 1000-1002 against 11a720c: runs per second 0.9602, 0.9886, 0.9960;
mean 0.9815 [0.9355, 1.0298], not separated upward. Counters exactly one
snapshot and one merge per run every round. Neutrality: grid, grid-short and
grid-no-purgatory arm shares outside the spread (moot with the close).
Decision: closed on the fired malloc guard, as the criterion registered
before the rounds were read required. Patch kept.

grid-pool-worker-continues: not built, left in the pool - ceiling about 1
percent after the judge's rewrite, below the round spread, and most grid idle
is capacity gating rather than the dispatch round trip it removes.

Iteration 17 closes with no merge: aos-draw-ahead-pool closed on its lite
reading, timeline-store-one-lock on its malloc guard, grid-pool-worker-
continues and the composite not built.

### Direction review after iteration 17 (autonomous)

Iterations 14-17: one merge (eligible-lists-known-from-queue-info, plus
frame-slots-by-liveness in 13), eight closes. Tree 11a720c, 8,017.4 runs per
second, cumulative 3.684.

What the closes share, now that caller attribution and plain-cycles profiles
exist. Every mechanism built did what it was built to do - identity
identical, counters exact - and three patterns ate the saving:
- relocation: work removed from one line reappeared in schedule_runnable or
  exec_ops (node-env-detached, collection updates, boxed records, inline
  lists, owned slots). The scheduler family has absorbed every nearby
  saving.
- unbound cost: removing work where the resource was not the limit (integer
  columns while writers were idle; the timeline store's allocations).
- the wrong runs: recovering worker time for runs the search objective does
  not count (the AOS pool).

The largest costs are unchanged in kind: schedule_runnable's family about
12, ceval about 8, exec_ops about 8, memmove about 6. Per-line savings around
them keep relocating into the scheduler. Direction for iteration 18
(algorithmic lens): attack what the scheduler computes per step as a whole -
which parts of schedule_runnable's per-step work (eligibility counts per
queue, scoring and term evaluation, audits and probes that run under stats)
have answers that change rarely - with the scheduler family itself as the
guarded line, so relocation within it cannot count as a saving. No new
profile is needed; 11a720c.md and the 45517fd attribution stand.
