# Ending stalled runs: the largest measured gain, and why it did not merge

Iteration 5315, `end-run-at-plan-stall`. One chunk, 369,180 runs in 300 s.
Closed by the merge gate. The implementation survives unreferenced at
`32ad5b9` (superproject) and `6af4c5a` (spur), 138 lines across seven files.

Reporting only. Changes no gate.

## What it measured

| rung | ratio per explore-second | pGreater | pMei | per run |
| --- | --- | --- | --- | --- |
| depth>=4 | 1.435 | 1.0 | 1.0 | 0.987 |
| depth>=5 | 1.462 | 1.0 | 1.0 | 1.006 |
| depth>=6 | 1.506 | 1.0 | 1.0 | 1.036 |
| depth>=7 | 1.519 | 1.0 | 1.0 | 1.045 |
| throughput | 1.454 | | | |

Every rung clears its minimum separable effect with posterior probability 1,
which no candidate in this project had done before, and `pRegress` is zero on
all of them. The chunk also produced a violation, the second on record and a
different signature from the first.

## Why it did not merge

`decide.ts` reads each rung twice. Improvement is a rate per explore-second;
the guard against shallower runs is a rate per graded run, and for
`depth>=4` it is a bare confidence-interval separation with no margin, while
`depth>=5` and `depth>=6` are held to a non-inferiority margin instead. A
merge requires an empty regression list.

Per run this candidate moves depth>=4 by -1.3%. At 369,180 runs that is
about five standard errors, so the bare guard fires; the same shift at
depth>=6 would sit inside the margin its guard allows. The rung with the
most events and the least bearing on the objective is the one held to the
strictest test, so a candidate that shifts the run-length distribution at
all can be vetoed there whatever it does elsewhere.

## Does the guard catch what it is for

Flat depth per run at higher throughput is the signature of truncation, and
the audit at 5315 shows truncation is already half the measured objective:
`grid-short` caps iterations at 1500 against 6000 and supplies 48% of all
depth>=6 events per second. An objective counting events per explore-second
rewards shortening runs, so a guard against it is worth having.

The depth>=4 per-run guard is not that guard. Measured against the same
`grid-short` arm, truncation moves per-run rung probability by +0.4% at
depth>=4, -0.8% at depth>=5, -7.1% at depth>=6 and -10.9% at depth>=7. The
rung the bare guard watches is the one truncation leaves alone, and it sits
below the roughly 0.5% relative separation the guard fires at, so the
truncation exemplar passes. The rungs truncation actually costs are the ones
held to a permissive margin, or to nothing.

The guards are placed away from the effect they are meant to catch, and the
sensitivity follows the event counts rather than the stakes: depth>=4 carries
the most events, so the smallest shifts separate there.

The same measurement clears this candidate. Truncation reads as depth>=4 flat
or up with depth>=6 and depth>=7 down. This candidate reads as depth>=4 down
1.3% with depth>=6 up 3.6% and depth>=7 up 4.5% - the inverse. It is not
capping runs part-way through their work; it is ending runs that had stopped
producing events, which is why the rungs above the guard improve.

Two of the last three add-kind candidates were closed by this one rule, in a
lane whose merge rate is 1 in 26.


## The controlled comparison

Iteration 5318 proposed nearly the same idea, `stall-abort-progress-termination`,
and running it produced the comparison neither hypothesis could give alone.

| per run | 5315 end-at-stall | 5318 stall-abort | grid-short |
| --- | --- | --- | --- |
| throughput | 1.454 | 1.832 | 3.45 |
| depth>=4 | 0.987 | 0.987 | 1.004 |
| depth>=5 | 1.006 | 0.962 | 0.992 |
| depth>=6 | 1.036 | 0.930 | 0.929 |
| depth>=7 | 1.045 | 0.922 | 0.891 |
| violations | 1 | 0 | - |

The two candidates agree on depth>=4 per run to three decimals and disagree
everywhere else. 5318 reproduces the truncation arm's profile almost exactly,
so it is cutting runs short; 5315 inverts it, so it is ending runs that had
stopped. The rung the guard watches cannot tell them apart. The rungs that
can are held to a margin, or to nothing.

Both were closed by the same rule, quoting the same number.

## What would settle it

Violations per explore-second, which is the goal rather than a proxy and is
already a rung in the gate. This candidate produced one violation in 369,180
runs where the baseline produced none in 690,592. Two violations in the
whole record cannot separate anything, so the question is exposure, not
policy: run the recovered commits against the baseline until the violation
rung can be read, and let that decide whether ending stalled runs helps the
goal or only the proxy.
