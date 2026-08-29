# How to read `utilization.json -> steer_authority`

Reporting only. Changes no gate.

`steps` and `audited` are two different denominators, and a hypothesis that
cites one while meaning the other reads its own falsifier backwards.

| field | counts | when it moves |
| --- | --- | --- |
| `steps` | every scheduling point the session reached | whenever `feedback.steer_audit` is on, whatever the scoring weights are |
| `audited` | the subset of those points whose ranking was resolved against what the step ran | only when the queue audit ran |
| `honored`, `no_eligible_candidates`, `blocked_by_order`, `blocked_by_timer_gate`, `other_queue`, `sampler_chose_other` | what stood between the top-ranked runnable and the one the step ran | they partition `audited`, not `steps` |
| `preference_expressed` | points where the blended ranking put a different runnable on top than priority alone | a subset of `audited` |
| `preference_honored` | of those, the ones the step then ran | a subset of `preference_expressed` |

The queue audit walks and scores every runnable in every queue at every
scheduling point, so it is not free. It runs when a predicate in `steer_terms`
carries weight, and otherwise only when `feedback.steer_audit_always` is set.
With neither, `steps` still counts and `audited` is zero, and the gap is
counted by `steer_empty_slice.queue_audit_skipped`.

Consequences for reading a session run under the loop's general config, whose
`steer_terms` weights are all zero:

- `steps` at zero over a session that consumed scheduling steps is a wiring
  fault, not a policy fact. A debug build asserts against it at the end of
  every run.
- `audited` at zero there is expected, and the outcome breakdown and the two
  preference fields are then empty for want of an audit, not for want of
  authority. To get them, run the session again with
  `feedback.steer_audit_always` set and pay the per-runnable cost.
