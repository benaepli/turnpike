# crash-placement-probe-exemption (Step 3)

Frozen before grading.

Change: run-cap probes are never placed, and every probe now feeds the span
learner (feed 1/64 -> 1/32 of runs). Fraction stays at its 0.5 default, so
the placed share falls slightly, from 32/64 to 31/64.

- Rung: depth>=6 events per explore-second.
- Band: +2% to +15%. The learner's sample floor is crossed in half the runs
  it used to take, so less of the treated pool sits inert; against that,
  the placed share falls by 1/64 and the learner's input changes from a
  50/50 placed/stock mix to 100% stock, which moves the learned span and
  therefore the cap.
- Firing: the internal crashPlaced contrast should hold near its measured
  3.80x, and the share of placed runs with the acted bit set should rise
  above the 62% measured at 300s.
- Falsifier: a placed-run acted share that does not rise means the feed
  change did not reach the floor any sooner, whatever the rung did. A
  depth>=6/s ratio inside the null band means the faster warm-up buys
  nothing at chunk length.
- Watch: the cap gauge. The learner's input composition changes, so a
  moved cap is expected and is not by itself evidence either way.
