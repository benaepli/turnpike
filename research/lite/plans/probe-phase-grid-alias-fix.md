# probe-phase-grid-alias-fix

## Defect

A run's phase in the session-global mechanisms was read straight off its run
id (`id % 32`, `id % 64`). A grid is walked in order, so a run's
configuration is a deterministic function of its id, and the phase then
shares the id's factors with the grid width. At a 32-run probe period
against the 54-configuration general_vr grid the common factor is two.

Measured on a 120s campaign, 125,880 non-aos runs: 3,935 run-cap probes
covering 27 distinct configurations, every one an even index, zero odd. All
four grid arms independently. `dependency_density` is the innermost grid
axis over [0.0, 0.3], so config parity is density, and every probe ran at
density 0.0.

The never-probed half is the more productive one:

| | density 0.0 (probed) | density 0.3 (never probed) |
|---|---|---|
| median completed length | 1002 | 1200 |
| P(depth>=6) | 0.0689 | 0.0999 |
| runs hitting the learned cap | 7,323 | 8,247 |

So `run_cap` learns its quantile from a distribution 20% short of the other
half's and truncates the productive half harder, and `fault_timing` bounds
its placement span by a median learned from the same half.

## Change

`run_phase::phase(run_id, period)` reduces a SplitMix64-mixed id, and
`run_cap::is_probe`, `timer_context::run_mode`, `fault_timing::is_placed`
and `fault_timing::feeds_learner` read it. Nested periods keep their
relationships, since both are the same mixed value reduced: a run at phase 0
of 64 is still at phase 0 of 32. Every phase stays a pure function of the
run id, so sessions stay reproducible.

## Frozen prediction

- **Rung**: depth>=6 events per explore-second.
- **Band**: +3% to +25%. The learners stop being calibrated on half the
  grid, and the half they never saw is the productive one.
- **Firing**: run-cap probes must cover all 54 configurations rather than
  27, checked from the runs table; `run_cap.current_cap_max_scope` should
  rise above the baseline's 5219 as longer runs enter the quantile.
- **Falsifier**: probes still missing a config residue means the mechanism
  did not fire, whatever the rung did. A depth>=6 per-second ratio inside
  the A/A null band means the fix is free but pays nothing.
- **If neutral**: file for the user rather than merge. "Neutral but more
  correct" is a judgment the gate does not encode, and merging on it would
  be a departure from the rule.

## Caveats

Throughput may fall: a higher cap means longer runs. The objective is per
explore-second, so a per-run gain that costs run time can wash out.
