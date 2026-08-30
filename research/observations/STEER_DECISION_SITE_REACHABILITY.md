# Steer decision site reachability

## Question

`steer_authority.preference_expressed` has been exactly 0 over roughly 1.8e9
scheduling steps. Two readings fit that: the ranking runs and never disagrees
with priority, or the ranking never runs. The aggregate counters cannot
separate them, because `record_steer_authority` - the only writer of
`preference_expressed` - is itself downstream of the guard that would have to
be reported on.

## Method

A per-step census (`util_stats::SteerReach`, exported as the `steer_reach`
block of `utilization.json`) records exactly one of six outcomes per budget
step, ordered by how far the step travelled toward the point where the score
ranking and the priority ranking are compared:

| bucket | meaning |
| --- | --- |
| `no_schedule_attempt` | nothing queued, the scheduling point was not reached |
| `audit_disabled` | scheduling point reached, `feedback.steer_audit` off |
| `no_weighted_predicate` | audit on, no `steer_terms` predicate carries weight |
| `single_candidate` | ranking ran, one candidate offered |
| `ranking_agreed_with_priority` | ranking ran over competitors, agreed with priority |
| `preference_expressed` | ranking ran over competitors, disagreed with priority |

The last three sum to the steps that reached the decision site.

`spur/spur-core/tests/steer_decision_site_reachability.rs` drives three seeds
of `general_vr.json`'s unoverlaid (`grid`) arm settings against `VR.spur`
in-process, at a reduced grid and a 400-step budget, once with the config's
weights as written and once with a single predicate weighted.

## Result

Weights as the config carries them (all four `steer_terms` predicates 0):

```
seed 11     no_weighted_predicate 2328   reached_decision 0
seed 2029   no_weighted_predicate 2187   reached_decision 0
seed 90210  no_weighted_predicate 2298   reached_decision 0
```

Every step stops at the same guard. `crash_after_timer_sends` raised to 1.0,
nothing else changed:

```
seed 11     no_weighted_predicate 0   ranking_agreed 2326   expressed 2
seed 2029   no_weighted_predicate 0   ranking_agreed 2185   expressed 2
seed 90210  no_weighted_predicate 0   ranking_agreed 2298   expressed 0
```

## Reading

The decision site is not dead code. It is switched off by the evaluation
config: `scheduler_configs/loop/general_vr.json` sets all four `steer_terms`
weights to 0, so `resolvable = terms.any_predicate() || steer_audit_always()`
is false at every step and the ranking is never resolved. The zero was a
property of the config, not of the code path, and no amount of further
instrumentation on the counters downstream of that guard could have said so.

Two consequences for the pool.

The preference/honored lineage should not be closed on the grounds that the
site is unreachable - it is reachable, and reaching it costs one nonzero
weight in the one config. Any hypothesis in that lineage must set a weight;
one that does not is measuring a branch it did not enter.

With the site reached, the ranking disagrees with priority on roughly 0.09% of
steps (4 of 6809 across three seeds). That is the same order as the 0.1%
divergence already measured for the within-queue steer, and it was already
established that raising divergence structurally does not move the ladder.
So the reachable version of this lever is small before it is measured, and a
proposal to weight a predicate should say what it expects the preference to
be, not merely that the preference will now exist.
