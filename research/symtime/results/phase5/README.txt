Phase 5 readings: durations open, floating point with an exact certificate,
the deterministic cap, the audit share.

entry_policies.txt   Entry test: the offline float, draw and cap figures with the
                     phase 1 liveness model, all datasets (policy_table.py).
float_scale.txt      Risk 7a: float against exact at scales 1e-6, 1 and 1e6.
calibration_float.txt  The cap's units fitted to wall time (calibrate.py).
sessions.txt         Per session: shares by the run's own wall time,
                     concessions, flips, certificates (shares.py).
exit_share.txt       Exit reading 1: the engines' time over the run's own time
                     taken concretely (the concrete session of the same seeds,
                     per step), against section 3.2's float, draw and cap
                     column, with the cap at 5 (exit_share.py).
                     xcap: exact numbers, cap 5. fcap: float with the exact
                     certificate on every taken flip, cap 5.
runs/                `reach runs` CSVs of every session: concrete, exact
                     (uncapped), xacc (float, exact accept, uncapped), xcap,
                     fcap.

Determinism, one thread, cap at 2, idioms, 160 runs, exact and float: two
sessions made the same time decisions and actions in every run, and the
same runs table apart from wall time.
