# Zero point first

Standing rule for hypotheses that set a number on a scalar scheduler knob.
It is binding at judge time: a candidate that breaks it scores expectedGain 0,
with this file named in the notes.

## The rule

A hypothesis that doses or tunes a scalar scheduler knob may not open a second
evaluation in that knob's family until the knob-off point for that family has
been measured and recorded in the registry below.

The first evaluation a family spends is therefore its off point - unless the
graded config already sits at the off value, in which case the rule is already
satisfied and the first evaluation is any nonzero point.

## Definitions

Scalar scheduler knob: a numeric field of the explorer config that scales how
often, how hard, or how long a mechanism acts. Out of scope: booleans (an
opt-in flag is its own off point), structural choices (arm sets, allocation
kind, reward kind, policy strings), and run budgets - `max_iterations` bounds a
run rather than dosing a mechanism, and it has no off value.

Knob family: every hypothesis that varies the same mechanism's numbers, through
whatever field it reaches them - the amount itself, a probability that gates it,
a window it applies over, or a schedule across a run. Two fields belong to one
family when setting either to its off value silences the same firing counter.

Off point: the setting at which the mechanism's own firing counters read zero.
For a multiplier that is the value at which it cannot change an ordering (1.0),
not 0.

## What the off measurement has to be

1. Encoding. An in-place scalar override in the graded settings of
   `scheduler_configs/loop/general_vr.json`: the same field, edited to its off
   value. Never a new campaign arm, and never a re-overlaid arm. The arm list
   must be identical between the two stages, because a candidate is compared
   against the baseline campaign as a whole, so a changed arm mix moves the
   rungs on its own and the contrast stops being about the knob.

2. Firing counters. Name the counter (or counter pair) in the hypothesis
   `firingCounter` field, and report it per arm in the result. The off stage
   counts as off only when those counters read zero in every arm that does not
   carry a deliberate positive-control overlay. "The mechanism was off" is a
   measurement, not an assertion: a null from a knob whose counters nobody read
   cannot be told apart from a knob that was already inert.

3. Reading. Report the primary rung and throughput under the usual protocol. An
   off point that is non-inferior on depth and neutral on throughput closes the
   family for dose work. Whether the flat knob is then deleted is a separate
   question this rule does not decide - a knob may stay in the config for its
   parameter-surface cost alone.

## Why the order and not just the count

Interior dose points cannot separate a weak effect from no effect. A ladder that
starts at a nonzero value spends its evaluations comparing points that may all
sit on the same flat stretch, and only the off point asks the question the
family exists to answer. `post_fault_client_ops` spent five evaluations - dose
grid, quiescence window, probabilistic dose, in-campaign arm, zero ablation - to
reach a verdict the off point alone delivers first.

## Scope

This governs evaluation order inside one knob family and nothing else. It does
not touch the gate, the sequential protocol, the runner, the fidelities, which
config anything is graded against, or the deletion policy for flat knobs. It
imposes nothing on a hypothesis that is not setting a number on a scalar knob.

## Registry of off points

| knob (graded value) | off value | firing counters | status |
| --- | --- | --- | --- |
| `post_fault_client_ops` (1) | 0 | `post_fault_ops.pairs_seen`, `post_fault_ops.edges_added` | measured: null on depth at every rung, throughput -0.034; family closed |
| `purgatory.delay_probability` (0.15) | 0.0 | `purgatory.delayed_sends` | outstanding |
| `purgatory.delay_duration_range` ([5, 300]) | same family as the probability above | `purgatory.delayed_sends` | outstanding |
| `partial_fanout_crash_bias` (0.5) | 0.0 | `crash_anchor.timing_bias_examined`, `crash_anchor.timing_bias_withheld` | outstanding |
| `quick_fire_multiplier` (5.0 by default, not written in the graded config) | 1.0 | `steer_authority.preference_expressed`, `steer_authority.honored` | blocked on reachability: every step reports `steer_reach.no_weighted_predicate`, so a dose here measures nothing until a predicate source is bound |
| `steer_terms.*` (all 0) | 0 | `steer_terms.<term>.evaluated` | already at the off value, so the rule is satisfied and the next point is nonzero; same reachability caveat |

`grid-no-purgatory` sets `purgatory.delay_probability` to 0.0 as an arm overlay.
That is a within-campaign contrast under a different arm mix, not a graded off
point, and by the encoding rule above it does not discharge the requirement.

## Recording an off point

Append a row, or edit the knob's status in place, with the value the firing
counters read in the off stage and the primary and throughput deltas. A status
of `outstanding` is what makes a second evaluation in that family rejectable.
