# ghost-absorber-retarget-redraw

Iteration 20, epoch 13. Parent: ghost-absorber-crash-retarget (merged
fabf0ea, spur 1c4d55f). Origin: operator-agent, admitted by the judge.

## What changes

On a salted half of the retarget-treated runs (bit 1 << 23,
ghostAbsorberRedraw, own salt), a placed crash whose planned victim is
already down is not held. It lands on the best live absorber if one
exists, otherwise on a live node without an outstanding crash-recover
pair drawn from a dedicated RNG stream, and the paired recover is
remapped as in the parent. With no such node the crash falls back to the
merged hold. Retarget-treated runs outside this half keep the hold byte
for byte; untreated runs are unchanged. The census gains a third cell so
crashes per run are readable for control, hold and redraw runs.

## Why

The merged retarget read 1.709 on depth-6 per run while landing 6.5%
fewer crashes and completing 6.6 points fewer plans on treated runs. The
hold may be a rail cost, a hidden contributor to the gain, or neither.
Comparing redraw runs to hold runs inside the retargeted half decides it.

## Frozen prediction

- Bit: GHOST_ABSORBER_REDRAW = 1 << 23 (ghostAbsorberRedraw), salted half
  of ghost_absorber::is_treated runs; probes exempt by inheritance.
- Rung and band: depth>=6 per-run ratio of redraw runs to hold runs,
  probe-free, co-bit matched within ghostAbsorberRetarget = 1, in
  [1.02, 1.15].
- Firing: victim_swap.victim_down_landings >= 2,000 per chunk on the redraw
  quarter, with victim_swap.victim_down_holds on the hold quarter (per
  crash) expected within 15% of it. Below the floor the round closes with
  the hold bounded harmless by population.
- Independent observables: redraw crashes applied per run >= 1.03x hold
  runs; redraw plan_complete >= hold + 3 points; redraw absorbed-victim
  share >= 0.9x hold share, both >= 1.5x untreated.
- Falsifier: the depth>=6 interval entirely below 1.00; or redraw crashes
  per run below 1.02x hold; or redraw plan_complete not above hold's; or
  redraw steps per run above 1.02x hold; or absorbed share below 0.9x hold.
- Cost clause: cross-binary throughput >= 0.97; within-session, redraw
  wall per run <= 1.00x hold wall per run.
- Verdict rule: band met and rails clean, merge; interval containing 1.00
  with rails clean, merge on the rails with depth recorded neutral; any
  falsifier, close with the named reading.

## Grading

`start --treatment-bit 8388608 --band-min 0.02 --band-max 0.15`, two
chunks minimum. The spur tree moved at the parent's merge, so this
session measures the fresh baseline cache.
