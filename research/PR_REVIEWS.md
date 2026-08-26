# PR reviews

Operator decisions on hypotheses the gate routed to `needs_human`. The gate
checks whether a change is safe and non-inferior; it cannot check whether the
experiment the hypothesis described actually ran. That is what these reviews
are for. Each entry records the verdict and the evidence.

## 2026-08-26, epoch 3

### timer-weight-response-curve (iteration 5263) - rejected

Gate result was `advance`, "non-inferior on depth>=4 and h2", regression and
lint passing, routed to `needs_human` only because `kind=meta`. All of that
is true and none of it means anything: the evaluated binary is an identity
transform of baseline.

`QueuePolicyConfig` gains a `timer_weight` field defaulting to 1.0, and
`weighted_p_timer(p, 1.0) == p`. `scheduler_configs/loop/general_vr.json`
never sets the field, so both evaluation seeds explored baseline behavior.
The +0.0019 depth>=4 delta is seed noise, and `advance` is vacuous:
non-inferiority is trivially satisfied by a change that does nothing.

The sweep the hypothesis was named for never ran. Four variant configs were
emitted (`general_vr_timer_w025/050/200/400.json`) and nothing loads them:
`research/orchestrator/src/evaluate.ts:91` resolves the config as
`ctx.configTemplateOverride ?? policy.evaluation.configTemplate`, pinned to
`general_vr.json`, and `configTemplateOverride` is declared at
`evaluate.ts:17` and set nowhere. A grep for `general_vr_timer_w` across the
tree returns no hits. The hypothesis's own reflect reached this conclusion
independently, which is the reason the finding surfaced at all.

Recorded, not merged:

- The plateau claim for w != 1 is **unmeasured, not confirmed**. It must not
  enter the record as evidence, and a future timer hypothesis may not cite it.
- The diff adds a tunable with no demonstrated benefit. GOAL.md counts
  parameters as a cost.
- A multi-point sweep is ill-formed for this harness: one evaluation explores
  one config. Config work that is meant to be measured edits a loaded file in
  place, as `enable-purgatory-general-config` did (+0.0151 depth>=4, real).

Systemic remedy, landed with this review: `lintInertConfigs` fails any
hypothesis whose `scheduler_configs/loop/` additions are not one of the files
a runner actually loads (`policy.evaluation.configTemplate`, the two
regression configs, `policy.perf.benchConfig`). This class previously
returned a false `advance` rather than failing, which is the more dangerous
direction - the credential outage manufactured false negatives, and this
manufactured false positives.

Not requeued. The variant-config approach cannot be made to work by retrying;
a per-point hypothesis editing the template in place is the shape that runs.

### acted-fraction-instrumentation (iteration 76) - changes required

Held, not merged. The instrumentation is worth having: it is the only thing
that answers "did the mechanism have an effect" rather than "did it fire",
and six purgatory-family hypotheses closed for want of that distinction.
The design also avoids what sank `guard-absorption-counter` - there is no
ACTED/ABSORBED classifier and no protocol knowledge, just an observation of
whether the receiver's env was written across the delivery.

The defect is the observation itself. `State::node_state_token` returned
`self.nodes[node.index].slots.as_ptr()`, a raw pointer into the slots buffer,
and the caller compares the value before and after `exec` to decide whether
the delivery acted. A pointer does not answer that question. `Slots` is an
`EcoVec`, which shares its buffer across clones and reallocates only when
copy-on-write fires, and `exec.rs:28` and `exec.rs:478` clone the node env
before running the handler. So the token reports whether copy-on-write
happened to trigger, which fails in both directions: a write that stores an
identical value counts as acting, and a write taken while the env is unshared
mutates in place and is missed. Which case applies depends on refcount timing
that any unrelated refactor can change.

Required change, applied by the operator: a monotone `writes: u64` on `Env`,
incremented in `Env::set`, with `node_state_token` returning it. Excluded
from `Hash` and from `sig` so deduplication and scheduling cannot see it.
Unit tests cover the case the pointer token misses, and one of them asserts
the slots pointer stays equal across a real in-place write.

The figures the pointer token produced were held back until this was
measured, and measurement cleared them. Running the same 1,080-run session
with only the token differing:

| | pointer | writes | delta |
|---|---|---|---|
| all | 41.36% | 40.90% | -0.46pp |
| biased | 13.92% | 13.67% | -0.25pp |
| delayed | 14.03% | 13.79% | -0.24pp |
| sender_restarted | 15.79% | 15.87% | +0.08pp |
| receiver_restarted | 2.45% | 1.80% | -0.65pp |

The two agree within run-to-run noise; exploration is rayon-parallel and not
bit-reproducible, so the sessions differ by 1.1% in delivery count on their
own, and the `receiver_restarted` gap is about one binomial sigma on ~48
acted events. The pointer was right here only because `exec.rs:28` and
`exec.rs:478` clone the node env before the handler runs, leaving refcount
>= 2 so any write triggers copy-on-write. The absorption figures therefore
stand, and the change buys correctness that does not depend on that.

Merged.
