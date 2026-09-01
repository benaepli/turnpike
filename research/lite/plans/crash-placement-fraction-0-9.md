# crash-placement-fraction-0.9 (Step 4)

Frozen before grading.

Change: `DEFAULT_FRACTION` 0.5 -> 0.9. Placed share goes from 31/64 (0.484)
to 57/64 (0.891): phases 6..63 less the one probe phase among them.

Why the extrapolation is licensed here and was not when the plan was
written. Both session-global learners now read run-cap probes only, and
probes are exempt from placement at every fraction, so neither learner's
input changes with the fraction. The stock rate `u` is therefore invariant
to `f`, and `p = u(1 + f(r-1))` extrapolates.

Sizing from the measured internal contrast r = 4.579 [4.507, 4.653] and a
treated-run wall cost of 1.080x:

  per run:  (1 + 0.891*3.579) / (1 + 0.484*3.579) = 4.188 / 2.733 = 1.532
  wall:     (0.891*1.080 + 0.109) / (0.484*1.080 + 0.516) = 1.071 / 1.039
  per sec:  1.532 * (1.039/1.071) = 1.486

- Rung: depth>=6 events per explore-second.
- Band: +35% to +65%, centred on +49%.
- Firing: the placed share in the runs table rises from about 0.484 to
  about 0.891, and ordinary stock runs (not probes, not placed) survive as
  a control at about 7.8% of runs.
- Falsifier: a placed share that does not reach ~0.89 means the default did
  not take effect. A per-second ratio below the band means placement's
  effect is not additive across the population - it saturates - which would
  be a finding about the mechanism, not about the knob.
- Watch: throughput. Treated runs are 8% longer, so runs per second should
  fall about 3%. A larger fall eats the per-run gain.
