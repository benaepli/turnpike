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

## The consultation denominator

`preference_consulted` counts every read of a preference source, taken before
the reader decides what to do with the answer; `preference_source_absent` is
the subset of those reads that found nothing configured to have a preference.
A zero anywhere else in the block is readable only against these two.

Measured on `bin/spur/VR.spur` under `scheduler_configs/loop/general_vr.json`,
campaign explorer, one 25-second budget, all `steer_terms` weights at zero:

| field | value |
| --- | --- |
| `steps` | 79,387,355 |
| `preference_consulted` | 238,154,954 |
| `preference_source_absent` | 238,154,954 |
| everything else in the block | 0 |

Three consultations per scheduling step, and every one of them found no
source. The decision sites execute; there is nothing configured for them to
prefer. The all-zero authority block under the general config is a policy
fact, not a dead counter, and a steer hypothesis that reads it as evidence of
broken wiring is reading it backwards.

## Where a field can still be lost

Both paths out of the simulator carry the whole struct: the utilization dump
the CLI writes, and the per-arm `counters` object a campaign builds by
differencing and accumulating snapshots. `spur-core/tests/stats_export_parity.rs`
runs a small campaign and asserts both key sets equal the struct's field set,
so a projection interposed on either path fails with the names it dropped.

The projection that does drop fields is downstream of the simulator, in the
orchestrator's `utilSubset` and the `UtilStats` schema it validates against:
an evaluation record keeps five of the twelve names, and
`preference_consulted` and `preference_source_absent` are not among them. Both
files are harness code, so the numbers above have to be read from
`<output_dir>.utilization.json` until an operator widens the subset.
