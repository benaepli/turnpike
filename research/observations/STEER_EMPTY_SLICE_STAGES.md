# The three scoring-path stages skipped when no predicate carries weight

Reporting only. Changes no gate.

`ResolvedTerms::any_predicate()` is false whenever every predicate weight in
`steer_terms` is zero. Three stages of the scoring path then compute a constant,
and each is now skipped and counted separately under
`utilization.json -> steer_empty_slice`. The three are independent hunks, so
reverting any one of them yields the single-stage build its row measures.

| stage | counter | code site | what it stops doing |
| --- | --- | --- | --- |
| candidate mask | `candidate_mask_skipped` | `core/scheduler.rs`, `select_within_queue`, the `present` fold and the `count_terms` argument passed to `score_with_terms` | the per-candidate `State::term_mask` reads (`crash_after_sends_term`, `stale_late`, `request_before_stale`) over the eligible set and over every scored candidate |
| ranking pass | `ranking_pass_skipped` | `core/scheduler.rs`, `select_within_queue`, the blended-versus-priority argmax block | a second full pass over the eligible set, one `runnable_novelty` per candidate |
| queue audit | `queue_audit_skipped` | `core/scheduler.rs`, `schedule_runnable`, the `audit_steer_preference` call | one `runnable_novelty` and one `term_mask` per runnable in every queue, at every scheduling point, plus the `steer_authority` atomics |

The queue-audit stage only exists when `feedback.steer_audit` is on; the other
two only when `stats` is on. All three are silent when a predicate does carry
weight, which is the identity check: a weighted session must show
`steer_empty_slice` all zero and the ordinary counters at their usual values.

Counters observed on a 25 s campaign over `scheduler_configs/loop/general_vr.json`
with every weight at zero: 65,490,276 candidate-mask skips, 29,252,733
ranking-pass skips, 65,495,529 queue-audit skips over 21,480 runs.

Note the sizes against each other. The queue audit fires once per scheduling
point and touches every runnable in every queue; the candidate mask fires once
per within-queue selection; the ranking pass only when more than one candidate
is eligible, which is 45% of selections here. Per-runnable work therefore
dominates the audit row by a wider margin than the counts alone suggest.
