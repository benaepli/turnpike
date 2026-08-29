# Direction review, 2026-08-29 (epoch 8)

Due after the epoch 8 change. Steps 2 and 7 need the CPU mask and are
deferred to the end of the CCD 0 baseline; everything below is from the
recorded evaluations and decisions.

## 1. Has the ground truth moved

No. Across all 372 recorded evaluations the violation count is zero, in the
reference, in every baseline and in every sequential evaluation. One general
config violation is known to have happened before evidence preservation
existed and its corpus is lost, so it is not in the record and cannot be
re-read.

Every other number on the board is therefore a proxy whose link to the goal
is unverified, and should be written and read that way.

## 3. Effect sizes against the gate's own bar

The minimum effects the gate can separate are 2.4% at d>=4, 2.6% at d>=5 and
3.8% at d>=6. The measurable candidates in the last ten decisions came in at
+0.09% to +0.12% at d>=4 and -0.02% to +0.01% at d>=6: two orders of
magnitude under the bar, not near it. Three of the ten were blocked before
producing a number, two are meta changes parked for human review, and the
only movement is a perf merge at +12.8% throughput.

This is not a measurement failure. Candidates of the size the gate accepts
are not being found.

## 4. What the merges are

28 merges, by kind:

| kind | merged | decided | rate |
| --- | --- | --- | --- |
| enabling | 14 | 18 | 78% |
| meta | 6 | 21 | 29% |
| ablate | 5 | 6 | 83% |
| perf | 2 | 2 | 100% |
| add | 1 | 26 | 4% |
| arm | 0 | 2 | 0% |
| grader | 0 | 8 | 0% |

`add` is the only kind that changes how the explorer searches. One of them
has merged, against 25 closed, 18 parked and 5 still proposed out of 51 ever
written. Plumbing, policy and removals account for 25 of the 28 merges, and
none of those can move a rung by construction.

The merge count is not a progress measure. Read the `add` column alone.

## 5. Does the proxy still track the goal

Unverified, and there is direct evidence against it at the top. General
config runs at full prefix depth have all been linearizable, against 71%
violation at depth 8 in the plan corpora. Termination is the confound named
in `TERMINATION_DEPTH.md`: completed runs are six times more likely to reach
d>=6 and carry every plan-corpus violation, while only 3.4% of runs complete
and 70.9% end on an exhausted step budget. A mechanism that slows plan
completion raises prefix depth without exploring more.

## 8. Iteration economy

37 min per iteration: evaluate 24.9 (67%), implement 7.8 (21%), rejudge 1.8
(5%), regression 1.5 (4%). Grade is 86 s against a 301 s chunk, 22%, under
the 25% threshold. Implement is under the 15 min mean. Rejudge is at the 5%
line. Decisions run better than one per two iterations. No threshold is
crossed; the economy needs no action.

## Verdict

Change direction on the mechanism lane. Continuing to draw `add` hypotheses
against the bulk rungs cannot be justified by a 4% merge rate, effect sizes
two orders of magnitude under the bar, and a goal metric that has never left
zero. The lane is not unlucky, it is out of levers of the size this gate
accepts, and proposing more of the same cannot change that.

Three things follow, in order of cost.

The cheapest is to stop drawing blind. There is no measurement of what
separates a deep run from a shallow one, which is exactly what the parked
grader proposal asks for, and the two flags it needs already exist:
`traceanalyzer -grade -grade-run-depths` gives per-run depth and
`traceanalyzer -runs` gives per-run end reason, steps and timer counters.
That is an observation script, not a grader change, and it turns the next
`add` hypothesis from a draw into a targeted one.

The second is the one live signal on the board. `crash_after_timer_sends` at
d>=8 is +30.7% (z 3.1, 308 events against 233) in the recovered factorial,
at the rung nearest the bug and the one the gate records but never decides
on. A two-arm campaign holding that term at 0 and 2.33, and nothing else,
buys four times the exposure per arm and tests one pre-registered contrast.

The third is the one the operator owns. Perf is the only lane that reliably
moves the objective, because a rung is events per explore-second and a
speedup raises every rung by construction. It also cannot find the bug: it
raises the rate of finding nothing. With violations at zero across 372
evaluations, the question of whether depth is the right objective is now
older than the evidence for it, and it is not a question this loop can
settle about itself.
