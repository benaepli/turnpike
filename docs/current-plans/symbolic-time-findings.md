# Symbolic Time: Measured Findings

Four claims stood behind a symbolic backend for time. This records what each
measured at, on 2026-09-20, against the pass line set before measuring.

## Verdict

| | Claim | Pass line | Reading | Result |
| --- | --- | --- | --- | --- |
| H1 | Time comparisons are two-point difference constraints when rates and durations are concrete | >= 95% of executed comparisons | 100% of 240,068 comparisons and 1,395,303 timer constraints | pass |
| H2 | Incremental feasibility checking is cheap | median <= 5% of a run, p99 <= 25%, no run doubles | median 0.5%, p99 2.0%, worst 2.4% of the run's own time, with dead unknowns eliminated | pass, conditionally |
| H3 | A solved timeline survives integer ticks, floor readings and ceiling deadlines | >= 99% of runs keep every outcome; every sampled artifact replays | 100% with a floor margin, 96.9% to 99.3% without; 600 of 600 rewritten artifacts replayed | pass, conditionally |
| H4 | Choosing branches by feasibility reaches outcomes concrete sampling rarely takes | some outcome taken in < 1% of runs yet open in > 20% | rarest outcome is taken in 24.6% of runs; largest gap is 36.0% taken against 86.9% open | not met |

The backend is buildable and cheap. The measurements do not show that it
would find more on the specs that exist: at the level of a single comparison,
concrete sampling already takes both outcomes often. The case for building it
now rests on what it would report about a finding, not on reach.

## What was measured

Three specs, 20,000 runs each, session seed 1000, under the lease panel's
overlay (`rho` 0.05, extreme rates, purgatory, n = 3; pause fraction 1.0 for
the cached flag):

- `bin/spur/panel/raft_lease_read_clean.spur`
- `bin/spur/panel/raft_lease_read_recv_anchor.spur`
- `bin/spur/panel/raft_lease_cached_flag.spur`

A feature-gated recorder in the simulator wrote, per run, every clock
observation, how each time value was derived, every time comparison with its
outcome, and every timed registration and fire. An offline analyzer rebuilt
each run from that record. Before any number was read:

- The analyzer re-evaluated every recorded value, comparison and deadline
  from its derivation: 11,653,185 values, 240,068 comparisons and 1,592,290
  deadlines, with 0 mismatches and 0 operands of unknown origin.
- Replay artifacts were byte-identical with the recorder compiled out and
  compiled in, over 160 runs under a fixed session seed.

## H1: the form of the constraints

Every executed comparison and every timer constraint was two-point. Each spec
has one time comparison site: `mono_now() >= lease_expiry!` in the two
read-lease specs, `mono_now() < lease_expiry!` in the cached flag.

This is a statement about three specs that share one lease idiom. A fixture
(`forms.spur`) shows what the language allows beyond it: comparing two
elapsed spans over three readings is general linear (27,375 of its 62,339
comparisons), while a truetime commit-wait test stays two-point. A spec that
writes the first kind needs a general solver or a concrete fallback, and
nothing in the language stops one from being written. The two-point form is a
habit of lease code, not a guarantee.

## H2: solver cost

The solver keeps one satisfying assignment and repairs it when a new
constraint breaks it. A comparison costs a trial of the other outcome plus
the outcome taken. Cost is compared with the same run's wall time in a
single-threaded session of the unmodified binary (median 388 to 412 us).

| Spec | Unknowns kept | Median | p99 | Worst |
| --- | --- | --- | --- | --- |
| clean | all | 0.49% | 1.5% | 2.5% |
| recv anchor | all | 0.54% | 1.9% | 2.5% |
| cached flag | all | 0.55% | 76% | 644% |
| clean | live only | 0.46% | 1.5% | 2.0% |
| recv anchor | live only | 0.50% | 1.7% | 2.2% |
| cached flag | live only | 0.48% | 2.0% | 2.4% |

A check costs 112 to 141 ns at the median. Keeping every past event as an
unknown fails the pass line on the cached flag: that spec compares on every
heartbeat, a trial of "the lease still holds" walks back through every event
since the lease round, and long runs go quadratic. Eliminating an unknown
once nothing later mentions it removes the tail, and gave the same answer on
every comparison in all 60,000 runs.

The condition on the pass: the analyzer knows the last mention of an unknown
because it reads the whole run. An engine would have to learn it from which
time values are still reachable and which timers are still pending. That is
at least as conservative, but it was not built or measured.

## H3: rounding

The concrete clock reads `origin + floor(rate * T)`, a fractional deadline
counts from its ceiling, and `T` is an integer. For each run the analyzer
discarded the recorded times, solved for the earliest integer timeline and
for the latest one ending no later than the record, recomputed every reading
and deadline exactly, and re-evaluated every comparison and every fire.

| Timeline | Runs keeping every outcome |
| --- | --- |
| earliest, no margin | 96.9% to 98.5% |
| latest, no margin | 97.2% to 99.3% |
| earliest, with margin | 100% of 59,999 |
| latest, with margin | 100% of 59,997 |

Without a margin, a comparison changes outcome in 1 to 3 runs in 100: two
floored readings can differ by one unit more than their unfloored difference.
The margin asks each constraint for slack equal to the sum of its positive
coefficients on floored readings, which makes the outcome independent of the
floors. It cost a solution in 2 runs of 60,000. No fire ever became
ineligible, with or without it.

The engine agreed: 600 artifacts rewritten to carry a solved timeline (every
one differing from its record) replayed to their recorded endpoints through
`spur replay`, with 0 refusals.

## H4: reach

Share of all runs in which the comparison took an outcome, against the share
in which that outcome was open when it was decided:

| Spec | Outcome | Taken | Open |
| --- | --- | --- | --- |
| clean | lease expired | 80.7% | 93.3% |
| clean | lease holds | 36.0% | 86.9% |
| recv anchor | lease expired | 53.6% | 93.3% |
| recv anchor | lease holds | 69.1% | 90.9% |
| cached flag | lease holds | 24.6% | 32.4% |
| cached flag | lease expired | 75.1% | 76.4% |

Between 42% and 85% of comparisons had both outcomes open, so the choice
points are real. But no outcome is rare: the largest gain available to
choosing by feasibility is a factor of 2.4 on one outcome, not orders of
magnitude. This matches what the lease panel already showed. The receipt
anchor mutant does not falsify because it needs a second leader to commit
while the first is starved of its messages, which is a shape of the schedule;
the cached flag needed a pause between a read and a store. Neither was
waiting on a time value.

What this did not measure is conjunctions: "the lease holds here *and* an
election has completed there". The record carries no protocol state, so it
cannot say how often both were open together. A symbolic backend removes the
time advance from the scheduler's action space, which helps exactly there,
and that gain is unmeasured.

## General solvers, with less fixed

The same records were played through Z3 4.13.3 and Yices 2.6.4 (3,000 runs
per spec) with progressively less fixed: rates and durations concrete;
durations left as unknowns bound only by the specs' `require` lines; rates
left as unknowns inside the band. At the concrete level both gave the
difference solver's answer on every comparison of every run, and the two
agreed with each other on every count at every level.

Share of runs where "lease holds" was open, and Yices's cost over the run's
own wall time:

| Spec | Concrete | Durations open | Rates open | Median cost | p99 cost |
| --- | --- | --- | --- | --- | --- |
| clean | 86.9% | 88.3% | 86.9% | 0.36x to 0.42x | 0.7x |
| recv anchor | 91.0% | 91.0% | 93.2% | 0.36x to 0.41x | 0.8x |
| cached flag | 33.0% | 68.5% | 33.0% | 0.59x to 0.66x | 25x to 39x |

- Durations fixed at setup close outcomes in one spec. The cached flag
  compares on heartbeat ticks, so whether the lease holds at a tick depends on
  the ratio of heartbeat to lease less margin; leaving it open doubles the
  runs where "holds" is open, against 25.3% taken.
- Rates fixed at setup close almost nothing: 2.2 points in one spec.
- Unknown rates are linear, not bilinear, when written the right way. A
  comparison the language allows involves readings of one clock with
  coefficients summing to zero, so dividing by that clock's rate leaves
  `sum(c * T) + (durations and constants) / rate`, linear in the times and in
  `1 / rate`. Every recorded constraint divided this way. Writing the reading
  as `rate * T` instead hands the solver a product of unknowns: Z3 then cost
  111x the run at the median and left 5% of comparisons undecided in a second.
- Durations and rates open together multiply two parameters, never a time.
  Z3's nonlinear engine took 15x the run at the median on the clean spec and
  did not finish 1,000 cached-flag runs in nine minutes.
- Z3 costs about four times Yices here (1.5x to 2.2x the run at the median).
  Neither can drop an unknown nothing mentions again, so both keep the
  quadratic tail the difference solver lost. A general solver fits a fallback,
  not the main path, which costs 0.005x.
- Threads. Yices is thread safe only when configured with
  `--enable-thread-safety`, which 2.6.4 cannot combine with its nonlinear
  engine; the `yices2-sys` crate configures the nonlinear engine, so its
  library reports `yices_is_thread_safe() == 0`. Rebuilt the other way, a
  context per thread works and gives the same answers, but every term goes
  through one locked table and it does not scale. Runs a second on the clean
  spec with durations open, one context per thread:

  | Threads | 1 | 2 | 4 | 8 | 16 | 30 |
  | --- | --- | --- | --- | --- | --- | --- |
  | Yices | 4,519 | 5,982 | 5,197 | 4,472 | 3,542 | 2,635 |
  | Z3 | 677 | 1,092 | 1,717 | 1,944 | 3,375 | 4,547 |

  The explorer itself reaches about 18,000 runs a second on this workload, so
  either solver in the loop would cap it at a quarter of that or less.
- Yices and its bindings are GPL-3.0; Z3 is MIT.

## Linear solvers compared

Nine solvers played one solver-neutral script per run: every unknown, every
constraint as a linear row, and at each comparison a trial of the other
outcome followed by the outcome taken. 500 runs per cell, 60 s cap, each
solver used as its interface offers and none given help of ours. Cost is the
solver's time over the run's own wall time, median / p99. Every answer was
checked against Z3.

| Solver | Kind | clean, concrete | clean, durations open | cached flag, concrete | cached flag, durations open |
| --- | --- | --- | --- | --- | --- |
| Yices 2.6.4 | SMT, exact | 0.28 / 0.58 | 0.38 / 0.72 | 0.43 / 25 | 0.62 / 40 |
| Clarabel 0.11 | interior point, float | 0.59 / 2.0 | 0.60 / 1.3 | 0.86 / 98 | 0.99 / 128 |
| own simplex | general simplex, exact | 0.28 / 2.4 | 1.13 / 52 | 0.81 / 352 | over the cap |
| microlp 0.6 | simplex, float | 0.95 / 5.1 | 1.27 / 6.3 | 1.37 / 54 | 1.80 / 91 |
| SoPlex, real | simplex, float | 1.18 / 5.2 | 1.56 / 8.8 | 1.72 / 200 | 2.17 / 383 |
| SoPlex, rational | simplex, refined to exact | 1.53 / 5.9 | 2.00 / 9.8 | 2.14 / 203 | 2.69 / 386 |
| Z3 4.13.3 | SMT, exact | 1.41 / 3.3 | 1.80 / 3.6 | 1.81 / 15 | 2.43 / 33 |
| HiGHS 1.x | simplex, float | 3.30 / 18 | 4.07 / 25 | 4.67 / 565 | 5.80 / 825 |
| cvc5 1.4.0 | SMT, exact | 7.68 / 17 | 9.33 / 21 | 10.0 / 211 | 13.0 / 372 |

- No solver is cheap. The best median adds 28% to 62% to a run; most double
  it or worse.
- No solver is predictable. On the cached flag, which compares on every
  heartbeat and so has long constraint histories, every p99 is 15 to 825
  times the run. Z3 and Yices have the mildest tails.
- Every simplex and SMT solver agreed with Z3 on every comparison, including
  the three that work in floating point. Clarabel did not: 15 of 897
  comparisons wrong on one cell, 4 wrong and 6 taken outcomes rejected on
  another. An interior-point tolerance is not a decision procedure.
- What each number includes: the SMT solvers build a term per constraint;
  microlp must clone its state before each constraint, because adding
  consumes it and an infeasible result returns nothing; SoPlex's bindings
  take dense rows; HiGHS pays a fixed cost per solve meant for large models;
  the simplex written here is a first cut without column indexing.
- Licences and threads: Z3 MIT, a context per thread; cvc5 BSD, a term
  manager per thread; HiGHS MIT; SoPlex and microlp and Clarabel Apache-2.0;
  Yices GPL-3.0 and one locked term table (see above). The static cvc5 and
  the Yices crate both carry libpoly, so they cannot share a binary.

### The same solvers across worker threads

Each worker thread owned its solver state and took the next run from a
shared counter, as the explorer's workers do. Durations open; runs a second;
60 s cap per cell (45 s for the last three rows). The host has 16 cores and
32 hardware threads. Yices is the build configured for thread safety.

Clean spec, 2,000 runs:

| Threads | 1 | 2 | 4 | 8 | 16 | 30 |
| --- | --- | --- | --- | --- | --- | --- |
| explorer alone | 1,504 | | | | | 24,441 |
| Clarabel | 3,254 | 6,500 | 12,687 | 23,915 | 39,139 | 40,309 |
| Z3 | 680 | 1,334 | 2,540 | 4,527 | 6,890 | 6,807 |
| microlp | 317 | 629 | 1,212 | 2,252 | 3,954 | 4,396 |
| own simplex | 296 | 589 | 1,158 | 2,157 | 3,518 | 3,771 |
| cvc5 | 112 | 221 | 422 | 765 | 1,393 | 1,587 |
| Yices | 4,647 | 4,881 | 4,103 | 2,824 | 2,220 | 1,489 |
| SoPlex, real | 111 | 216 | 398 | 733 | 672 | 734 |
| SoPlex, rational | 107 | 205 | 370 | 570 | 462 | 423 |
| HiGHS | over cap | 58 | 111 | 212 | 369 | 450 |

Cached flag, 1,000 runs:

| Threads | 1 | 2 | 4 | 8 | 16 | 30 |
| --- | --- | --- | --- | --- | --- | --- |
| explorer alone | 1,538 | | | | | 25,361 |
| Z3 | 245 | 473 | 835 | 1,307 | 1,982 | 1,947 |
| microlp | 134 | 254 | 466 | 794 | 1,223 | 1,376 |
| Clarabel | 113 | 217 | 404 | 689 | 970 | 1,184 |
| Yices | 305 | 576 | 978 | 1,264 | 1,113 | 847 |
| SoPlex, real | 44 | 86 | 157 | 221 | 204 | 218 |
| cvc5 | 23 | 37 | 53 | 77 | 105 | 113 |
| own simplex | over cap at every count | | | | | |

HiGHS and SoPlex's rational mode were not run on the cached flag: both were
already the slowest on the easier spec.

- Z3, microlp, cvc5, Clarabel and the simplex here scale close to linearly to
  the 16 cores. Yices is fastest on one thread and slowest on thirty: its
  term table is one lock. SoPlex stops at 8 threads.
- At 30 threads the explorer alone does about 25,000 runs a second. The best
  exact solver does 6,800 on the clean spec and 1,900 on the cached flag, so
  with a solver in the loop the explorer would run at roughly a fifth of its
  rate on the first and under a tenth on the second.
- Clarabel outruns the explorer on the clean spec, and is the one solver
  that gave wrong answers.

### The simplex written here, optimised

The other solvers were dropped and the exact simplex was tuned in measured
steps, each checked against Z3 on every comparison. One thread, durations
open, runs a second:

| Step | clean | cached flag (500) |
| --- | --- | --- |
| as first written | 296 | over the cap |
| exact 64-bit rationals, replayed over 128 bits on overflow | 881 | over |
| a column index and a set of suspect rows | 1,006 | over |
| every division kept in 64 bits | 1,318 | over |
| drop the defining row of a dead unbounded unknown | 1,876 | over |
| enter on the unknown found in the fewest rows | 11,217 | 573 |
| one allocation-free merge per row in a pivot | 11,439 | 781 |
| dead unknowns leave as soon as they can (two steps, below) | 10,694 | 3,002 |

Tried and reverted: deferring repairs to the next comparison, and repairing
the newest or the shortest violated row first. All three were slower.

- Same answers. It agrees with Z3 on every comparison of all 20,000 runs of
  the clean and receipt-anchor specs at all three levels, and on 6,000
  concrete and 2,000 durations-open runs of the cached flag. No run needed the
  128-bit replay.
- Typical cost is now small: 5% to 10% of a run at the median and 17% to 41%
  at p99 on the read-lease specs, against 28% and 58% for Yices. On thirty
  threads it plays 65,000 clean runs a second, more than the explorer
  produces.
- Long runs, first reading. On 1,000 cached-flag runs the dozen slowest took
  95% of the solver's time. The explorer spends 2.5 to 3.4 ms on each of
  them; Z3 50 to 260 ms, Yices 56 to 320 ms, and the simplex 77 to 220 ms on
  nine and 0.7, 1.1 and 5.7 s on three.
- Two more exact steps fixed the outliers. An unknown that dies outside the
  basis used to keep its row for good once it came in later; now its row goes
  the moment it turns basic, and an unknown that dies outside the basis is
  pivoted in at once, on its shortest row and without moving any value, so
  that it can go too. The 5.7 s run takes 126 ms, the other long runs 18 to
  32 ms against 86 to 200 ms for Z3 and 56 to 91 ms for Yices, and the 1,000
  runs take 0.51 s of solver time instead of 8.9 s: 1,939 runs a second on one
  thread and 6,700 on sixteen, where Z3 reaches 1,982.
- Answers still match Z3 on every comparison: 20,000 clean runs with
  durations open, 20,000 receipt-anchor runs with rates open, and 3,000 and
  6,000 cached-flag runs with durations open and concrete.
- What is left. A long run still costs 6 to 12 times what the explorer spends
  on it (p99 5.6x and worst 36x over 3,000 cached-flag runs). What remains in
  the tableau is about one row for every two unknowns the run ever had: old
  constraints written over the slacks of other old constraints. Removing
  finished columns that can only help clears 45% to 100% of those rows at the
  end of a run and none while it is running, because the removal unravels
  backwards from the newest constraints and those are still live. Bounding a
  long run's cost exactly needs a real projection of the dead history onto
  the live unknowns and the durations, which was not built.

### The same simplex with a row budget

A second mode gives up completeness for a bounded tableau. Once more rows are
live than the budget allows, the oldest finished columns are fixed at a
concrete value and folded into the rows' constants; a finished row left with
no column is dropped, and one left with a single column becomes a bound on
that column. Fixing a column only removes solutions, so an outcome reported
open is open in the full system. With a debug switch on, every open trial was
checked against every constraint asked so far, at the values the solver gives
the script's unknowns: no violation in 300 runs at any setting, and no outcome
was ever open here and closed in the exact solver.

Cached flag, durations open, 1,000 runs, one thread. "Open kept" is the share
of outcomes the exact solver found open that this one also found open, judged
while it could still follow the record; "runs left" is how often the record
asked for an outcome it had closed.

| Budget | Open kept | Runs left | Median | p99 | Worst | Runs/s | Peak rows |
| --- | --- | --- | --- | --- | --- | --- | --- |
| exact | 100% | 0% | 0.24x | 5.8x | 37x | 1,930 | 710 |
| 256 | 92.1% | 0.2% | 0.23x | 3.4x | 5.6x | 3,557 | 311 |
| 128 | 84.8% | 1.1% | 0.23x | 1.6x | 2.1x | 4,794 | 259 |
| 64 | 76.2% | 1.8% | 0.23x | 1.2x | 2.9x | 5,224 | 270 |
| 32 | 60.9% | 4.7% | 0.24x | 1.0x | 1.6x | 5,995 | 272 |

On the clean spec the budget costs almost nothing: every open outcome kept
down to 128 rows, 99.8% at 64, 96.9% at 32, and the cost does not move because
it was already small.

- The budget buys the tail. The worst run drops from 37 times its own cost to
  between 1.6 and 5.6, and the median is untouched.
- The loss is in the value, not the mechanism. Columns are fixed where the
  assignment happens to have them, which is where many constraints are tight
  at once: timers firing exactly at their deadlines, events at the same
  instant. A second policy that moves one column to the middle of its room
  changed nothing, because with every other column held still that room is
  almost always empty. Keeping more outcomes open needs a choice that moves
  many columns together, which is the decision a learned policy would make.
- Rows settle near 260 to 310 whatever the budget below that: what is left
  mentions two or more live columns, mostly durations, and is neither dropped
  nor merged yet.

### Where to fix the values: policies tried

The decision is where the assignment sits when finished columns are fixed.
Scored on 6,000 cached-flag runs against the exact solver, which no policy
sees. "Kept" is judged while the budgeted solver can still follow the record;
"of all" counts every comparison after a run leaves the record as lost, and is
the stricter reading because the runs that leave are the long ones.

| Policy | Budget 64: kept | of all | runs left | worst cost | Budget 32: kept | of all | runs left | worst cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| as before | 76.2% | 63.5% | 1.3% | 3.0x | 58.2% | 43.0% | 5.0% | 2.8x |
| scale fixed | 97.6% | 78.7% | 1.1% | 1.6x | 95.1% | 72.9% | 2.8% | 1.5x |
| scale fixed, margin 1/256 on upper-bounded constraints | 98.2% | 84.6% | 0.9% | 2.7x | 96.5% | 80.7% | 1.7% | 2.7x |
| scale fixed, margin 1/256 on lower-bounded constraints | 99.2% | 68.8% | 2.1% | 5.7x | 95.6% | 53.2% | 9.7% | 12x |
| scale fixed, margin 1/16 on both | 99.5% | 68.5% | 2.1% | 42x | 96.7% | 59.0% | 8.5% | 39x |
| bandit over 16 margin pairs, open-share reward | 98.9% | 73.1% | 1.8% | 19x | 95.9% | 59.5% | 7.1% | 41x |
| bandit, novelty-weighted reward | 99.0% | 74.9% | 1.7% | 13x | 95.3% | 59.8% | 7.5% | 22x |

- Fixing the scale is exact and is most of the gain. With durations open
  every constraint is homogeneous, so the feasible set is a cone and the
  solver sat where every duration was infinitesimal; fixing a column there
  fixed a span of events at nothing. Requiring the election timeout to be one
  changed the exact answers of none of the 6,000 runs, and made the budgeted
  solver both keep far more and run faster.
- A small margin on the upper-bounded constraints, the "lease still holds"
  kind, is the best policy found: most kept on the strict reading, fewest runs
  leaving the record, and a worst case still under three times the run.
- Margins on the lower-bounded constraints look best on the lenient reading
  and are the worst on the strict one. Spreading events apart before fixing
  them closes "holds" for the long spans a long run goes on to need, so long
  runs leave the record two to three times as often, and the search for a
  feasible margin costs up to 42 times the run.
- The bandits learned nothing useful: they spread their pulls and scored like
  an average arm. Only 613 and 1,636 of the 6,000 runs reach the budget, the
  arms differ by well under a point in the reward they can see, and that
  reward, the share of comparisons with both outcomes open, is blind to the
  failure that separates the arms, a closed outcome that the run later needed.

### How far the scale fix generalises

Fixing the scale is exact under two conditions, and useful under a third.

- The run's system has to be homogeneous. The language guarantees that of
  everything a spec can write: no duration literal but zero, no instant
  literals, origins that cancel within a clock, `require` lines that must be
  homogeneous. Only the engine's own settings add an absolute constant: a
  truetime width in ticks, a delay bound in ticks, durations given as numbers.
  So the engine can decide this from its configuration before a run. Tested
  both ways: on the three lease specs no row over two or more unknowns
  carries a constant and neither anchor changes any exact answer in 3,000
  runs each; on the fixture, whose truetime width is 40 ticks, 852 of 1,000
  runs carry such rows and anchoring closes outcomes the exact solver had
  open, 84 in 58 runs with the election timeout as the unit and 12 in 11 with
  the sum of the durations. It never opens one.
- What is set to one has to be positive everywhere in the feasible set. Named
  durations are, by definition, so their sum is a unit that needs no
  knowledge of the spec. A spec with no `timing` block has nothing of the
  kind: its durations are differences of readings, and every event being
  simultaneous is a real part of its feasible set. The earliest exact anchor
  there is the first strict inequality the run commits to, which may never
  come.
- It only reaches what is tied to a named duration. A stretch of the timeline
  related to the rest by event order alone can still be squeezed to nothing,
  and fixing columns there is as harmful as before.

So this is a conditional improvement with a safe fallback, not something an
arbitrary protocol can rely on. What an arbitrary protocol can rely on is that
results are sound, that the exact mode is exact, and that a budgeted run says
what it gave up: whether an anchor applied, how many columns were fixed, how
many comparisons were left with one outcome.

### The simplex across spec shapes

The simplex had been tuned on lease-shaped specs only, and the first other
shape broke it: on a fixture with comparisons over three readings and
truetime, one run took 2 s and another did not finish. Three more datasets
were added to find what else breaks: the clean lease spec at n = 5 with more
operations, and a fixture of idioms a lease does not use (a span measured on
one node and compared on another, a round trip scaled and divided, `min`,
`set_timer_at` with a deadline of several terms, three-reading comparisons,
truetime against a named duration), in which 39% of comparisons and 25% of
timer constraints are outside the two-point form. No scale anchor is used
anywhere below; that choice is left to a learner.

What was wrong, and what replaced it:

- The guard against cycling switched to the smallest-index rule after 64
  pivots in one check. Long healthy checks tripped it, and that rule then took
  8,788 pivots where choosing by cost takes 71. Counting how often one unknown
  re-enters the basis tripped on healthy checks too. The guard now fires only
  when a check returns to a basis it has already been at, by a hash of the
  basis kept up to date at each pivot; it then picks entering unknowns at
  random from a fixed seed, and falls back to the smallest index only if that
  also runs very long.
- The fallback for numbers that outgrow 64 bits was the generic 128-bit
  rational, slow enough that runs appeared to hang. It now has the same fast
  paths as the 64-bit type, with every product checked.
- Making each clock's elapsed reading the unknown, so that the spec's own
  constraints have unit coefficients, changed nothing: it is a column scaling
  of the same problem and pivots identically.

One thread, 1,000 runs per cell (150 for idioms), every answer checked against
Z3's independent encoding with zero differences throughout. Runs a second:

| Dataset | Level | Simplex | Z3 | Yices | Simplex cost over the run, median / p99 / worst |
| --- | --- | --- | --- | --- | --- |
| clean | concrete | 10,949 | 706 | 5,392 | 0.08 / 0.33 / 1.2 |
| clean | durations open | 9,447 | 607 | 4,779 | 0.11 / 0.35 / 0.8 |
| receipt anchor | concrete | 10,755 | 678 | 5,192 | 0.08 / 0.32 / 1.0 |
| receipt anchor | durations open | 9,042 | 585 | 4,667 | 0.12 / 0.39 / 0.7 |
| cached flag | concrete | 6,523 | 499 | 502 | 0.12 / 1.1 / 1.6 |
| cached flag | durations open | 2,449 | 232 | 316 | 0.21 / 5.6 / 12 |
| long | concrete | 380 | 56 | 696 | 0.10 / 2.6 / 4.3 |
| long | durations open | 707 | 50 | 625 | 0.13 / 1.4 / 2.1 |
| forms | concrete | 798 | 129 | 39 | 0.18 / 6.2 / 16 |
| forms | durations open | 982 | 145 | 40 | 0.23 / 3.8 / 17 |
| idioms | concrete | 130 | 48 | 5 | 0.61 / 42 / 60 |
| idioms | durations open | 3 | 6 | 3 | 1.7 / 1,394 / 2,165 |

A later pass on the idioms fixture added three things, each checked against Z3
on the whole table again: a mild preference for pivots of one or minus one,
which bring no new denominator into a row; a 64-bit fast path and a cheaper
gcd inside the 128-bit numbers; and, once a check has taken eight pivots,
repairing the unknown furthest outside its bounds instead of the smallest
index. Idioms went from 130 to 190 runs a second concrete and from 3 to 13
with durations open (p99 from 1,394 to 269 times the run), forms from 798 and
982 to 825 and 1,036, and the lease cells moved by about 2%. The table above
is from before that pass; `research/symtime/results/simplex_shapes.txt` has
both.

A second pass on the same fixture, asked to double the concrete cell, took
idioms concrete from 272 to 558 runs a second on a 400-run sample (190 to 405
on the 150-run sample the table uses), again with every answer on all twelve
cells equal to Z3's. In the order of what each step gave:

- The time unknown is global time again, not each clock's elapsed reading.
  The elapsed form puts a rate into every ordering row, and 60% of tableau
  entries were fractions against 41%.
- Rationals are reduced only once a part passes 2^40, since the gcd was most
  of the cost of an operation, and the build uses fat LTO with one codegen
  unit.
- When a dead unknown is eliminated through a row whose finished slack can be
  fixed at its bound without loss, the slack is fixed, so the unknown leaves
  without a column taking its place. 43% of eliminations qualify.
- A row is whole numbers over one positive denominator, not a rational per
  entry. A pivot then costs two multiplications and an addition per entry and
  no gcd; the row is brought to lowest terms only when it was scaled up, by
  one remainder per entry. Values and constants stay rational.
- When the other outcome of a comparison is closed and is exactly the taken
  outcome negated, the taken outcome is already implied and adds no row. 38%
  of trials end closed. A failed trial can leave basic unknowns outside their
  bounds until the next check, so eliminating a dead unknown no longer pivots
  on a row whose owner is outside its bounds: an unknown outside the basis
  has to be inside them.
- A new slack takes its value from its own terms, not from the sixty entries
  of its row.
- Values outgrow 64 bits in 2 of the 400 runs while the rows do not, so there
  is a tier of 128-bit values over 64-bit rows before the fully 128-bit one.
- A 128-bit sum or product that does not fit is tried once more with both
  operands in lowest terms. Lazy reduction had made overflow depend on how a
  value was written, and one run with durations open overflowed 128 bits for
  that reason alone; the cross-check caught it.

Tried in this pass and dropped: repairing without a pivot by moving one
unknown outside the basis (no fewer pivots), undoing a trial's pivots (the
basis moves a trial makes are useful work), a sweep fixing finished columns
that can only help (finds nothing mid-run), a limit on the fill an
elimination may cause (no effect), and dropping the unused slack of an
implied outcome (slower).

After this pass, same cells and cross-check:

| Dataset | Level | Simplex | Z3 | Yices | Simplex cost over the run, median / p99 / worst |
| --- | --- | --- | --- | --- | --- |
| clean | concrete | 10,737 | 776 | 5,932 | 0.08 / 0.32 / 1.1 |
| clean | durations open | 9,650 | 669 | 5,041 | 0.12 / 0.34 / 0.6 |
| receipt anchor | concrete | 10,469 | 714 | 5,708 | 0.09 / 0.32 / 0.6 |
| receipt anchor | durations open | 9,305 | 644 | 4,861 | 0.12 / 0.35 / 0.5 |
| cached flag | concrete | 7,263 | 553 | 526 | 0.12 / 0.97 / 1.2 |
| cached flag | durations open | 3,228 | 245 | 310 | 0.18 / 4.0 / 6.5 |
| long | concrete | 540 | 71 | 793 | 0.09 / 1.6 / 4.7 |
| long | durations open | 1,021 | 64 | 705 | 0.12 / 0.71 / 1.7 |
| forms | concrete | 1,686 | 172 | 53 | 0.14 / 2.4 / 4.1 |
| forms | durations open | 1,892 | 178 | 51 | 0.21 / 1.7 / 3.9 |
| idioms | concrete | 405 | 58 | 6 | 0.44 / 7.9 / 10 |
| idioms | durations open | 33 | 7 | 4 | 0.78 / 113 / 142 |

A third pass took the cell with durations open, asked to be four times
faster: 51 to 235 runs a second on the 400-run sample, 33 to 165 on the
150-run sample the tables use, and p99 cost from 113 to 18 times the run. The
concrete cell rose with it, 558 to 795. What the measurements showed, in the
order they were found:

- Nearly all the time was 27 runs of 400 played three times over. Their row
  numbers outgrow 64 bits about 70% of the way through, and each tier started
  again from the first step. A run is now copied at step boundaries, at pivot
  counts half as far apart again each time, and goes on from the last copy in
  the next tier. A row merge whose products overflow is redone in the wider
  type and reduced, which keeps some runs in 64 bits outright.
- 1% of trials took 65 pivots or more and were 73% of trial work. In those
  checks a hundred rows stay violated throughout, nearly all of them plain
  ordering rows between two dead times: a repair moves one time, breaks the
  order with its neighbour, and the break travels down the history. The
  entering unknown is now the least harmful of the four cheapest candidates,
  where harm is how many rows that hold the move would push outside their
  bounds, judged in floating point since it only ranks correct choices. That
  alone took the cell from 81 to 152.
- A new time is brought into the basis through the row that orders it, so
  the gap to the time before is what stays outside the basis, and moving a gap
  moves every later time with it. Without a limit this halves long runs with
  durations open, because each new time's row copies the one before it; with
  the rule applied only through ordering rows of at most 96 entries it helps
  everywhere, and long concrete runs go from 540 to 1,931 a second.
- The pivot row was listed again in the column of every unknown it held at
  each pivot, though only the leaving unknown is new to it. Columns filled
  with repeats, which cost a sort and a dedup per read and made column
  lengths, the cost estimate the entering choice uses, wrong. Listing it once
  gave 197 to 216.
- The rest is machinery: the violated unknowns kept in a bitset, not an
  ordered set; a row visited once per column read by a stamp; the row merge as
  a standalone kernel; the pivot row built in order without a sort; a
  multiplicative hash for the slack lookup; a scaled row reduced only once its
  denominator passes 2^32.

Tried in this pass and dropped, each measured: a phase-one primal simplex
with a ratio test for long checks (as many pivots, on longer columns, four
times slower); skipping a row an older row of the same shape implies, and
releasing the older one a newer one implies (+4% here, -8% concrete);
starting unknowns at their recorded values, durations only and then times as
well (no effect); repairing a different violated row when the first has no
harmless repair (half the speed); weighing harm against column length
(slower than harm first); counting rows a move would mend; dropping finished
rows the bounds keep satisfied, and fixing finished columns that can only
hurt (each costs what it saves); a cache of known assignments (it can never
hit: an assignment that shows the other outcome open fails the taken one).

A diagnostic, not adopted: fixing the scale with `election == 1` makes this
cell 2.5 times faster still, but it changes 177 of 32,020 answers, because
the fixture has constants and so is not homogeneous.

After this pass, same cells and cross-check; the simplex is the fastest in
all twelve:

| Dataset | Level | Simplex | Z3 | Yices | Simplex cost over the run, median / p99 / worst |
| --- | --- | --- | --- | --- | --- |
| clean | concrete | 15,758 | 786 | 5,904 | 0.05 / 0.20 / 0.4 |
| clean | durations open | 11,940 | 670 | 4,860 | 0.08 / 0.27 / 0.4 |
| receipt anchor | concrete | 14,763 | 714 | 5,595 | 0.06 / 0.24 / 0.5 |
| receipt anchor | durations open | 11,461 | 642 | 4,912 | 0.08 / 0.28 / 0.4 |
| cached flag | concrete | 11,664 | 557 | 529 | 0.07 / 0.54 / 0.6 |
| cached flag | durations open | 4,456 | 244 | 312 | 0.12 / 2.9 / 4.3 |
| long | concrete | 1,931 | 70 | 780 | 0.05 / 0.31 / 1.9 |
| long | durations open | 1,508 | 64 | 691 | 0.08 / 0.36 / 1.8 |
| forms | concrete | 1,886 | 171 | 53 | 0.09 / 2.1 / 3.4 |
| forms | durations open | 2,313 | 178 | 50 | 0.14 / 1.4 / 2.8 |
| idioms | concrete | 606 | 58 | 6 | 0.33 / 3.8 / 4.0 |
| idioms | durations open | 165 | 7 | 4 | 0.58 / 18 / 27 |

A fourth pass was asked to double the durations-open cell again, to 470 runs
a second. It reached 296 (165 to 214 on the 150-run sample, p99 18 to 12
times the run), so the target was not met; the concrete cell went from 795 to
1,445. What it found:

- 40 of the 400 runs, those with about 600 comparisons and 900 live rows,
  are 87% of the time, and the tableau cannot be made smaller exactly by
  cheap means: trying the negation of every finished bound shows about 5%
  implied by the rest, and a one-sided elimination rule frees 5 to 10% of
  rows.
- A trial is now a primal probe. From the assignment that holds, the row of
  the other outcome is moved towards its bound one unknown at a time, each
  only as far as every row allows, so no row is ever broken; it stops as soon
  as the bound is within reach, without making that move, and the assignment
  it leaves still satisfies the taken outcome, which is then accepted for
  free. When nothing in the row can move it further the basis is optimal and
  the outcome is closed. At the concrete level this alone gives 822 to 1,350.
- With durations open the probe by itself is ruinous (12 runs a second):
  most steps have no length, and a step on a duration pivots a column that
  sits in every row, after which numbers outgrow every tier. So the probe
  runs with the named durations held by bounds at their present values. That
  settles 91% of trials: an outcome open that way is open, and one closed
  that way is closed for good when no duration outside the basis could move
  the row either, since freeing a basic unknown changes no reduced cost. The
  rest, 9% of trials, take the old trial with durations free and are 30% of
  the time, about 110 microseconds each: the cases where a duration has to
  enter the basis. No cheap exact substitute was found for that pivot.
- Holding pays only where it usually settles the trial. On the cached flag
  it misses 29% of the time and the fallback there is cheap, so it cost 25%.
  A run now tracks its miss rate, skips holding above about a quarter, and
  samples it every eighth trial. The rule counts trials and reads no clock.
  The cached flag with durations open is still 8% below the last pass, the
  one cell that went down.
- A new time whose ordering row is the usual one is written into the tableau
  as the row of the time before plus a gap, or takes that row over when the
  older time ends there. Accepting ordering rows was 23% of the time.

Tried and dropped in this pass: the probe with durations free, as the first
or as the second attempt; holding durations while accepting rows (more runs
outgrow 64 bits); keeping durations outside the basis by evicting them;
accepting rows by a primal move; choosing the probe's move by furthest reach
or by unit pivot; a cap on the probe's moves; longer rows for a takeover.

After this pass, same cells and cross-check:

| Dataset | Level | Simplex | Z3 | Yices | Simplex cost over the run, median / p99 / worst |
| --- | --- | --- | --- | --- | --- |
| clean | concrete | 17,643 | 777 | 5,911 | 0.05 / 0.16 / 0.4 |
| clean | durations open | 13,441 | 672 | 4,952 | 0.08 / 0.22 / 0.3 |
| receipt anchor | concrete | 16,616 | 718 | 5,634 | 0.05 / 0.19 / 0.4 |
| receipt anchor | durations open | 13,561 | 646 | 4,668 | 0.08 / 0.25 / 0.4 |
| cached flag | concrete | 13,124 | 545 | 529 | 0.07 / 0.45 / 0.5 |
| cached flag | durations open | 4,068 | 245 | 312 | 0.12 / 3.7 / 5.7 |
| long | concrete | 2,134 | 71 | 799 | 0.05 / 0.28 / 1.6 |
| long | durations open | 1,808 | 64 | 703 | 0.07 / 0.31 / 1.4 |
| forms | concrete | 3,130 | 172 | 53 | 0.08 / 1.2 / 2.9 |
| forms | durations open | 3,092 | 178 | 51 | 0.13 / 1.0 / 2.2 |
| idioms | concrete | 1,071 | 58 | 6 | 0.20 / 2.0 / 2.4 |
| idioms | durations open | 214 | 7 | 4 | 0.54 / 12 / 13 |

A fifth pass reached the target the fourth had missed, by a redesign and not
by tuning: idioms with durations open from 296 to 756 runs a second on the
400-run sample (214 to 589 on the 150-run sample, p99 12 to 4.0 times the
run), every answer on all twelve cells equal to Z3's.

What the measurements said first. Timing each pivot by how many rows it
touches showed 4,311 pivots touching 257 rows or more, 63 microseconds each
and a fifth of all time, with the fill they leave making mid-sized pivots five
times as common as at the concrete level, where no pivot is ever that large.
Those are pivots on a named duration, which sits in nearly every row.
Freezing the durations outright, at arbitrary values and so with wrong
answers, ran everything else at 738 runs a second with no run leaving 64
bits and only 3% of open outcomes missed. So the cost was durations entering
the basis, not durations being free.

The redesign: the unknowns a whole run shares never enter the basis. They are
parameters.

- Everything is solved with them where they are: the probe for a trial, the
  ordinary repair for accepting rows.
- When that fails, the row that could not be repaired is an identity in which
  every other unknown sits on the bound that stops it. Read as a statement
  about the parameters alone it is a condition every solution meets, whatever
  the other unknowns are: a cut.
- New values for the parameters come from the cuts: first a search along the
  newest cut's own direction, kept inside the plane any equality cuts define,
  which lands in the middle of the room there is with as short a number as
  fits; failing that, a small problem over the parameters alone, kept between
  calls, with room asked for as a share of the parameters' own size so that
  nothing depends on the unit durations are written in.
- An outcome is open when some values of the parameters let the probe reach
  it, which is a witness; it is closed when no values meet the cuts, which is
  exact because every cut is necessary. Cuts learnt from rows that are
  accepted are kept for the run, since what is accepted only grows; cuts that
  depend on the row being tried last for that trial.
- The answers do not depend on how values are chosen, only the speed does.

What else this pass kept: the unused row of an outcome found closed is
dropped at once, where before it lingered and was merged into (754 from 720);
after a closed verdict the parameters stay where they are when everything
already holds there.

Tried and dropped, each measured: moving well past what a cut needs when
nothing limits the move (no effect); repairing a row to past its bound so
that later moves find slack (it can keep a check from ever ending, which is
how a run exhausted the machine's memory: every run now goes through
`research/symtime/capped.sh`, which caps memory and time); the parameter
method under a budget, which is sound but fixes columns where they suit the
present values of the parameters, so that those cannot move later and four
times as many runs leave the record.

After this pass, same cells and cross-check, run under the memory cap:

| Dataset | Level | Simplex | Z3 | Yices | Simplex cost over the run, median / p99 / worst |
| --- | --- | --- | --- | --- | --- |
| clean | concrete | 19,490 | 801 | 5,923 | 0.04 / 0.14 / 0.3 |
| clean | durations open | 14,951 | 685 | 5,032 | 0.08 / 0.19 / 0.3 |
| receipt anchor | concrete | 19,348 | 727 | 5,669 | 0.04 / 0.16 / 0.3 |
| receipt anchor | durations open | 14,895 | 657 | 4,927 | 0.09 / 0.22 / 0.4 |
| cached flag | concrete | 15,034 | 568 | 528 | 0.05 / 0.40 / 0.5 |
| cached flag | durations open | 10,991 | 249 | 313 | 0.10 / 0.49 / 0.5 |
| long | concrete | 2,375 | 72 | 801 | 0.04 / 0.26 / 1.5 |
| long | durations open | 2,005 | 65 | 713 | 0.06 / 0.29 / 1.2 |
| forms | concrete | 3,460 | 175 | 53 | 0.07 / 1.1 / 2.4 |
| forms | durations open | 3,578 | 180 | 51 | 0.13 / 0.79 / 1.9 |
| idioms | concrete | 1,165 | 59 | 6 | 0.17 / 2.1 / 2.2 |
| idioms | durations open | 589 | 7 | 4 | 0.35 / 4.0 / 4.0 |

The cached flag with durations open, the one cell the fourth pass had
lowered, went from 4,068 to 10,991, and its p99 from 3.7 to 0.49 times the
run. With durations open the exact solver now costs about what it does at the
concrete level on every dataset but idioms, where it is half as fast. Across
threads, all 2,000 idioms runs with durations open in one process: 667 runs a
second on one thread, 4,437 on eight, 7,346 on sixteen, within 1.8 GB.

A sixth pass was asked for another doubling of the same cell, to 1,512 runs
a second, and did not get there: 756 to 813, with the concrete cell from
1,525 to 1,780 and every cell of the table up by 5 to 20%, all equal to Z3's
answers. What it established:

- Where the time is. A stopwatch over the parts of a trial, on the 400-run
  sample (about 540 ms at the start of the pass): settling the rows a move of
  the durations breaks 170 ms, the first probe 100 ms, building constraint
  rows 86 ms, accepting rows 40 ms, new times 44 ms, choosing values 22 ms,
  the moves themselves 21 ms. The same runs at the concrete level take 267
  ms, so what duration freedom still costs is about 210 ms, nearly all of it
  re-laying the history after a move: a move breaks 22 rows on average, each
  needs a pivot, and there are about 1,500 moves.
- The moves are intrinsic. Two comparison sites, a truetime reading against
  the margin and a round trip against the heartbeat, are 60% of trial time;
  at each, the other outcome wants a duration one way. How many moves there
  are does not respond to where values are placed: starting at the values the
  run was sampled with moves the learning from accepting rows to trials and
  changes nothing else; returning there after each trial is five times
  slower; taking a small step or a large one, or the nearest values the cuts
  allow, leaves the count between 12,000 and 14,000. The nearest values break
  fewer rows per move (17 against 22) and cause more moves.
- Showing an outcome open by sliding the durations along a line with nothing
  else moving, which needs no pivot and leaves the state alone, works in 337
  of 5,176 attempts: after a probe the tight history rows are outside the
  basis, where a slide cannot use them.
- Repairing a row by moving an unknown with no pivot, when that provably
  breaks nothing, cuts pivots by 30% and is slower overall: long columns stay
  outside the basis and rows sit exactly on their bounds, so later moves
  break more.
- A fifth of the solver's time was the system allocator. With a faster one
  (the `fast-alloc` feature, kept as a diagnostic since the simulator uses
  the system's) the cell went from 756 to 873 and concrete from 1,611 to
  1,992. Taking allocations out of the code instead, which carries over
  whatever allocator is used, got about half of that: buffers of dropped rows
  and used-up columns are recycled, the lists of slacks that mention an
  unknown are chains through one shared list, plain ordering rows are not
  entered in the map that finds a slack by its terms, and a constraint row is
  reduced once when built. The allocator's share fell from 21% to 13%.
- Also tried and dropped: the gap basis off or with other limits (96 is still
  best), the probe stopping its scan of a row early, the look ahead only
  after a check's first pivot.

What would take it further is not tuning. With the durations as parameters
the remaining cost is the size of the history that has to be re-laid and
merged into; the exact projection of the dead part of a run onto the
durations and the oldest live time would bound that, and the cuts are a
lazy form of exactly that projection, but a witness for an open outcome
still needs the history laid out. The other lever is the one left to a
learner: where the durations are kept decides how often a trial has to move
them.

| Dataset | Level | Simplex | Z3 | Yices | Simplex cost over the run, median / p99 / worst |
| --- | --- | --- | --- | --- | --- |
| clean | concrete | 23,165 | 793 | 5,967 | 0.03 / 0.11 / 0.3 |
| clean | durations open | 17,970 | 683 | 5,043 | 0.07 / 0.14 / 0.2 |
| receipt anchor | concrete | 23,077 | 736 | 5,729 | 0.03 / 0.12 / 0.3 |
| receipt anchor | durations open | 16,745 | 656 | 4,966 | 0.07 / 0.16 / 0.4 |
| cached flag | concrete | 16,943 | 563 | 533 | 0.04 / 0.35 / 0.5 |
| cached flag | durations open | 12,642 | 248 | 313 | 0.09 / 0.41 / 0.5 |
| long | concrete | 2,696 | 72 | 802 | 0.03 / 0.23 / 1.4 |
| long | durations open | 2,394 | 65 | 712 | 0.05 / 0.25 / 1.0 |
| forms | concrete | 3,747 | 176 | 53 | 0.05 / 1.0 / 2.2 |
| forms | durations open | 4,045 | 180 | 51 | 0.11 / 0.68 / 1.8 |
| idioms | concrete | 1,315 | 59 | 6 | 0.14 / 1.9 / 2.0 |
| idioms | durations open | 614 | 7 | 4 | 0.29 / 3.7 / 3.8 |

A second pass on allocation alone, still with the system allocator and no
outside dependency, counted the calls first. A wrapper round the system
allocator behind the `count-alloc` feature counts calls and bytes while the
runs are solved, by what the solver is doing at the time. On idioms that was
3,569 calls a run with durations open and 2,006 concrete. Where they were,
and what took them out:

- Every run built its tableau from nothing and freed it at the end. Row and
  column buffers are now kept per thread between runs, a few megabytes a
  thread, and the outer lists are sized from the script: 3,569 to 2,401.
- 573 calls a run were lists of rows growing an entry at a time. The worst
  case was the unknown leaving the basis: its list had been handed over when
  it entered, so it started from nothing and was then listed in every row the
  pivot touched. It now starts from a spare buffer before the pivot, and a
  slack that starts in the basis gets no list until it leaves: to 1,708.
- Every slack's terms were a vector of their own as the key of a map. They
  are now kept end to end in one list and found by their hash, with the
  terms compared on a hit: to 1,396.
- The throwaway small problem over the parameters is built on the spare
  buffers and hands them back: to 1,268, and 408 at the concrete level.
- Tried and dropped: giving copies of a run the spare buffers and a larger
  pool, which makes fewer calls and runs slower (857 against 877), since more
  bytes move and the pool goes cold.

Idioms went from 813 to 870 runs a second with durations open and from 1,780
to 1,979 concrete, which is what the faster allocator had given before this
pass; with it the same build now reaches 940 and 2,239, so 7% and 13% are
still the allocator's. What is left is mostly real growth: new rows and lists
when the spares run out, and the first copy of a long run. The datasets of
short runs gained most, since a short run is mostly set-up: the clean lease
spec from 23,165 to 28,622 concrete, long runs from 2,696 to 3,225. Sixteen
threads in one process reach 7,617 runs a second on all 2,000 idioms runs
with durations open, within 2.0 GB.

| Dataset | Level | Simplex | Z3 | Yices | Simplex cost over the run, median / p99 / worst |
| --- | --- | --- | --- | --- | --- |
| clean | concrete | 28,622 | 804 | 5,945 | 0.02 / 0.07 / 0.3 |
| clean | durations open | 21,409 | 686 | 5,092 | 0.05 / 0.09 / 0.2 |
| receipt anchor | concrete | 29,240 | 731 | 5,730 | 0.02 / 0.07 / 0.3 |
| receipt anchor | durations open | 20,370 | 660 | 4,960 | 0.05 / 0.11 / 0.3 |
| cached flag | concrete | 20,623 | 566 | 534 | 0.03 / 0.27 / 0.4 |
| cached flag | durations open | 15,197 | 249 | 316 | 0.06 / 0.33 / 0.4 |
| long | concrete | 3,225 | 72 | 804 | 0.02 / 0.20 / 1.2 |
| long | durations open | 2,878 | 64 | 713 | 0.03 / 0.22 / 0.9 |
| forms | concrete | 4,446 | 175 | 53 | 0.03 / 0.88 / 2.0 |
| forms | durations open | 4,790 | 181 | 51 | 0.08 / 0.58 / 1.6 |
| idioms | concrete | 1,434 | 59 | 6 | 0.09 / 1.8 / 1.9 |
| idioms | durations open | 661 | 7 | 4 | 0.23 / 3.5 / 3.5 |

The budgeted mode still uses the fourth pass's method. On idioms with
durations open the exact solver at 756 a second has now passed a budget of
256 rows (700) and nearly reached a budget of 128 (939), so at these sizes a
budget buys little that exactness does not.

The budgeted mode uses the probe and the held attempt as well. That is
sound there for the reason the budget is: what the probe finds open is open
in the smaller system the budget leaves, which is inside the real one. The
debug self-check reads a witness off the assignment, which the probe does not
move to, so it runs without the probe. Idioms, 400 runs, one thread, no
outcome gained at any budget on any dataset:

| Budget | Durations open: runs/s | kept | runs left | p99 cost | Concrete: runs/s | kept | runs left |
| --- | --- | --- | --- | --- | --- | --- | --- |
| exact | 293 | 100% | 0% | 10.8x | 1,444 | 100% | 0% |
| 256 | 691 | 98.2% | 2.3% | 4.0x | 1,412 | 99.9% | 0% |
| 128 | 918 | 97.0% | 7.5% | 3.7x | 1,694 | 99.4% | 1.0% |
| 64 | 1,244 | 95.4% | 24.8% | 1.7x | 1,987 | 98.5% | 4.8% |
| 32 | 1,206 | 90.4% | 60.5% | 2.0x | 1,893 | 95.9% | 31.8% |

Before the port a budget of 256 gave 581 a second with durations open and 660
concrete. On forms with durations open a budget of 128 gives 3,547 a second
and keeps 99.7%; on the cached flag a budget of 256 gives 5,556 and keeps
92.4%, the scale problem described above.

One thing the third pass exposed is still open. Which runs outgrow 128 bits
depends on the path the pivots take: under the defaults none does on any
dataset, but other settings of the pivot rule left up to 27 of 400 idioms
runs unfinished. Such a run is flagged, never answered wrongly, and the
benchmark now prints the count; but there is no tier above 128 bits to finish
it in, and an integration needs one.

The budgeted mode shares the code and gained from each pass, still with no
outcome gained at any budget. On idioms concrete a budget of 64 now runs at
1,074 a second and keeps 98.2%. With durations open the exact solver at 165 a
second has closed most of the distance to it: a budget of 256 gives 470 a
second, keeps 97.6% and leaves 2.7% of runs; a budget of 64 gives 876, keeps
95.4% and leaves 27%. The budget table further down is from before these
passes.
Its debug self-check, which keeps dead unknowns alive to read their values
back, prints alarms on this fixture both before this pass (32) and after
(6). The measure that counts, an outcome open under a budget and closed
exactly, is zero in both; the alarms have not been traced and may be the
stale-value artifact the self-check has shown before.

- The simplex is now the fastest on all twelve cells, and no longer has a
  shape it fails on.
- The last cell is still the expensive one. The simplex is over twenty times
  faster than Z3 there, but its p99 is 18 times the run and its worst 27
  times: runs the explorer plays in 4 ms take it up to 0.1 s, with several
  hundred comparisons a run, many outside the two-point form, and durations
  open.
- That is what the budgeted mode is for, and there it holds its cost and
  pays in information. Idioms with durations open, 150 runs, no anchor:

  | Budget | Runs/s | p99 cost | worst | kept | of all | runs left |
  | --- | --- | --- | --- | --- | --- | --- |
  | exact | 3 | 1,392x | 2,154x | 100% | 100% | 0% |
  | 256 | 41 | 229x | 509x | 98.2% | 91.5% | 2.0% |
  | 128 | 178 | 39x | 46x | 96.9% | 65.5% | 11.3% |
  | 64 | 446 | 4.7x | 4.8x | 95.2% | 44.3% | 28.7% |

  No outcome was gained at any budget on any shape. On forms a budget of 128
  keeps 99.5% and leaves no run; on idioms concrete, 256 keeps 99.8%.

### Three harder fixtures, and numbers that outgrow every tier

Three more fixtures were written from `idioms.spur` to look for worse cases,
each recorded for 2,000 runs under the idioms config and checked by the
recorder's own replay (no mismatch):

- `webs.spur`: eight named durations, four of them with no `require` tying
  them to the others, used with fractions in comparisons, timer deadlines and
  the truetime margin. 70% of its comparisons are in two-point form.
- `chains.spur`: a deadline that drifts by half the elapsed span plus a third
  of the heartbeat every round, and a running sum of half round trips; 45%
  two-point.
- `crossclock.spur`: a truetime reading and an elapsed span carried in
  messages and compared on another node's clock, with a running sum of the
  carried spans; 58% two-point.

One thread, exact, runs a second (100 runs; Z3 and Yices did not finish a
batch inside a minute on most of these cells):

| Fixture | Concrete | Durations open |
| --- | --- | --- |
| webs | 1,202 | 111 |
| chains | 345 | 13 |
| crossclock | 105 | 53 (65 over 400 runs) |

**Falling back to concrete time.** crossclock is the first dataset where a
run's numbers outgrow 128 bits: 7 runs in 400 with durations open. There is
no wider tier and none is wanted. Such a run now keeps every answer given
before the step that failed and reports every later comparison as left to
concrete time (`None`, the taken outcome only); it is never unfinished and
never guessed. Online that is the point at which the run goes on in concrete
time, which needs values that satisfy everything accepted so far; offline
the solver checks that such a point can be had by playing the last copy of
the run forward accepting rows only, with no trial, up to the failed step.
In every case but one over all the batches played, it could. The cause is
always a value, never a row or the cap on rounds, and it is not the choice
of duration values: with those on a grid of halves and every unknown outside
the basis on a whole number, row denominators still pass 90 bits. The
products of clock rates in comparisons across two clocks are what grows.
`SIMPLEX_TIERS=1` or `2` forces the path; with 64 bits only, idioms leaves
350 of 11,912 comparisons to concrete time and every answer before them
equals Z3's.

**A wrong answer in the budgeted mode, found by crossclock and fixed.** The
older method, which the budgeted mode still uses, has a shortcut that shows
an outcome open by moving one duration alone. It left the trial slack's own
row out of the reach it computed, and with it the bound the slack already
had on the other side, so a target past that bound came out open. One
comparison in 200 crossclock runs; Z3 and the exact method both say closed.
The shortcut now checks that bound first, and no outcome is gained at any
budget on crossclock again. The twelve earlier cells never reach this case.

**A pass at four times crossclock with durations open, which did not get
there.** What it established:

- Where the time is. 40 of 400 runs take 75% of it: the long ones, 1,400 to
  2,600 comparisons, whose tableau peaks at 1,500 to 2,200 rows. In them 98%
  of the rows belong to finished slacks over finished columns; about 20 rows
  are live. 89% of all merge work is pivots that exchange one finished
  unknown for another during trials, and it lands half on finished rows and
  half on the 35 or so live time rows, each of which carries the same 600 to
  800 entries of old columns.
- A run that leaves 64 bits costs 27 us a pivot against 11 us at a like
  tableau size, and those runs are 85% of the time. In the widest tier only
  10% of merges meet a number past 64 bits.
- Comparing two settings by runs a second misleads here, since a run that
  falls back sooner does less work. Every setting below was judged on the
  runs both settings finished.
- Tried and dropped, each within 5% of nothing on that measure or worse:
  dropping finished rows whose bounds follow from the bounds of what they
  mention (few qualify); fixing finished columns at their bound when moving
  them could only hurt (19,000 columns go, the rows stay); taking a time out
  of the basis when its row is long so that later times start short (it is
  pulled back in through a long row within a dozen events); keeping finished
  unknowns from evicting live times; measuring durations in a unit that
  makes their coefficients whole (more runs leave 64 bits, not fewer);
  duration values on a grid of halves; reducing rows to lowest terms sooner
  or later; other limits on the length of a new time's row; restoring the
  tableau after every trial (40% more pivots, 16% less merge work).
- Exact projection of the finished part is not cheap here: no finished
  column can be eliminated without multiplying rows, and an LP test finds
  only 30% of finished rows redundant.
- What would move it is a different kind of solver step: not rewriting rows
  that no pivot needs (a revised simplex over a factored basis, or live time
  rows that share their old part by reference), and arithmetic that stays in
  64 bits until a particular row needs more.
- Under a budget, crossclock with durations open: 256 rows 41 runs a second
  keeping 98.9% of open outcomes in the runs it stays with (14% of runs
  leave the record), 128 rows 99 a second and 97.8%, 64 rows 288 a second
  and 95.1%.

**A larger change that did pay: a time's row mentions the time before it.**
The measurement above said half the merge work was rewriting some 35 live
time rows that each carried the same old entries. A row could only mention
unknowns outside the basis, so each new time copied the row of the one
before. Now a row whose owner has no bounds (a time) may mention a time that
is in the basis: a new time is the one before plus a gap, by name, once that
one's row has 16 entries or more, and a copy of it, mentions included, while
it is shorter. Such a row is never broken, never pivoted on and never limits
a move, so no rule of the method reads it; a row that gets bounds has every
such mention written out when it is built, newest first, through the same
merge pivots use, and two times a row takes the difference of nearly always
mention the same older one, which cancels before anything is written out. A
finished time that several rows still mention keeps its row until they are
down to one, which then takes the row in. Values follow the mentions when an
unknown moves.

- Idioms, 400 runs, one thread: durations open 870 to 1,218 runs a second,
  concrete 1,979 to 3,035, the same answers. All ten cells of the five
  earlier datasets checked again equal Z3.
- crossclock with durations open, 400 runs: 65 to 104 runs a second. On the
  runs both finish, 1.3 times overall and 1.5 times on the long runs; the
  entries merged per pivot fall from 5,352 to 1,628. Short runs on the lease
  specs gain 3 to 6%.
- Forgetting needs far fewer pivots (1,275 to 150 per 100 runs), since a
  finished time is folded into the one row that mentions it.

Tried on top of it and dropped, each measured on runs both settings finish:
a value kept over its row's denominator with no gcd when the move is whole
(the moves are fractions; never taken); values read off the merged row as
whole-number sums (0.90); going back from wide numbers to narrow ones when
everything fits again. That last one came from a measurement worth keeping:
in the widest tier only 0.03% of rows and 0.7% of values are past 64 bits at
a comparison, and at three comparisons in four nothing is. But the same run
costs the same in all three tiers when its numbers are small, so there is
nothing to win by going back (0.97), and 64-bit values overflow again at
once on products. What a widened run pays for is the few operations on
numbers that really are large. Taking copies of a run four times as often
saves about 10% of what is replayed. The rules that choose pivots are at
their best settings under the new rows as well.

Where crossclock with durations open stands after it, 400 runs, 3.7 s in
comparisons: the first probe 1.15 s, settling after a move of the durations
1.19 s, choosing values 0.43 s, moving them 0.39 s, later probes 0.14 s,
accepting rows 0.24 s. Moves of the durations are 57% of it: 14,000 moves in
trials, 12.5 rows broken and 9.7 pivots each, and 24,000 trials closed by the
cuts with no move at all.

**A further pass at four times crossclock with durations open, by larger
changes, which found none that pays.** It stands at 104 runs a second from
65, and what this pass established is why:

- With the shared rows the cost of a comparison no longer grows along a run:
  20 us each for the first 250 comparisons of a run, 37 to 45 us each after,
  whether the tableau has 370 rows or 1,570. 44% of the time is now in the
  first 250 comparisons of each run. What is left is what one comparison
  costs: 2 to 3 pivots and, early in a run, 0.6 moves of the durations.
- The same fixture at the concrete level runs at 310 a second, three times
  the speed. Four times the old figure therefore means making open durations
  nearly free, and the moves are what they cost.
- Every run that leaves 64 bits does so because a value does not fit, never a
  row; and reducing values to lowest terms is the top entry of the profile
  (23% on the short runs).

Tried, each giving the same answers, and dropped:

- A trial with the durations free to move like any unknown, and the tableau
  put back afterwards from a journal of what changed, so that the dense
  pivots leave nothing behind. One search instead of rounds of cuts and
  moves, and a hundred times slower (idioms 966 to 9 a second): with the
  durations free a closed trial is a search over the whole history.
- The same journal used only to undo a trial's moves of the durations: 0.84
  on idioms and more pivots on crossclock. Where the last trial left the
  durations is where the next one most often wants them.
- Going back to values the durations were at lately when they meet every
  cut, since 67% of trials that move them (80% on idioms) first ask for
  something one of the last four places already met: 0.88. Places that were
  left sit on the edge of what the cuts allow, and cost more rounds than a
  fresh place in the middle.
- A value in the basis kept as its numerator over its row's denominator, so
  that a move changes it by one product and one sum with no gcd: correct,
  0.9, and more runs leave 64 bits (144 against 104), since the numerator is
  the larger number.
- Long runs started in the widest numbers, and copies taken eight times as
  often: 1.12 on crossclock together and 0.91 on every dataset that fits 64
  bits, so both stay settings (`SIMPLEX_START_WIDE_FROM`,
  `SIMPLEX_COPY_EVERY`, `SIMPLEX_COPY_SPACING`) and not defaults.
- Not built, on a measurement: rows with bounds that mention times by name
  as well, so that a pivot passes them by. Of the merge work, 15% lands on
  rows with no bounds, 50% on rows that were a pivot row at some point and
  have to be written out anyway, and 35% on rows that never were; the most
  it could save is about a tenth of the time.
- Not built, on an estimate: several tableaus kept with the durations parked
  in different places. Every accepted row has to go into each, which costs
  about what half the moves would save.

**A second opinion, from a fresh reading of the code and its own profile.**
It did not think another 2.5 times is there in this design either, and put
four safe items at 1.6 to 1.8 times together. Measured, they came to far
less:

- Its profile: keeping values up to date costs more than pivoting (`update`
  39% of solve time against 33% for `pivot`), a third of solve time is
  reducing fractions, the chain walk that carries a move through rows that
  mention each other is 11%, and choosing duration values is 12%, two thirds
  of it the generic `check` of the small problem. The first probe, accepting
  and building rows and bookkeeping are 1.66 s of 3.85 s, which caps the
  cell near 240 runs a second even with the durations free of charge.
- Fractions reduced by what the denominators share before multiplying, in 64
  bits (the code had this unused for the narrow tier): 0.91 to 0.93 in two
  forms. It takes up to four 64-bit gcds where the plain product and one wide
  gcd take one.
- The small problem over the durations kept every cut a trial had tried, as
  a row without bounds that each later pivot rewrote. Built again from the
  kept cuts once those rows outnumber them: 1.03 to 1.04. Kept.
- All the durations moved in one pass over the rows, each row by the sum of
  what they do to it: no faster, but fewer runs outgrow 128 bits (3,446
  comparisons left to concrete time against 4,514). Kept.
- The chain walk taken out: a time's row keeps only the part of its value
  the unknowns outside the basis give, and what it mentions is added when
  the value is read. 1.10 on crossclock and 0.87 to 0.97 on idioms, forms and
  long, where a read walks about six rows of mentions and reads outnumber
  the moves that were saved. Not kept. Not keeping times' values at all and
  reading a new row's value off the row itself: 1.11 here, 0.65 on idioms
  concrete.

**A revised simplex over a factored basis, tested for whether it could pay
before building one.** The solver was made to write its basis out in the
script's own unknowns at chosen comparisons of long runs (the terms of every
slack and gap outside the basis, and which times are in it), and the rest was
worked out from those dumps with exact fractions. The tooling was removed
again; what it showed:

- The basis comes down to one square kernel, the tight rows against the
  times in the basis, and the dumps rebuild it exactly square: 432, 998 and
  1,717 rows at comparisons 300, 700 and 1,200 of one crossclock run, 2.4
  entries a row, a third of them not plus or minus one. Its rows and the
  solver's own agree: the exact row worked out for a slack in the basis has
  as many entries as the tableau's row for it (median 21 against 24, the
  difference being the durations).
- The kernel is block triangular. About 70% of it is blocks of one; the rest
  is a couple of dozen blocks that cannot be split, the largest 78 to 93
  rows, on crossclock and on idioms alike. A factorization is therefore a
  matching, an ordering of blocks and a small exact factorization of each
  block, with no fill outside the blocks.
- A solve for one row that does not stop at exact zeros reaches 440 to 740
  kernel rows, a third to a half of the history: both times of a comparison
  lead back to the start of the run and only cancel there. One that stops
  where the two cancel visits 80 rows at the median on crossclock (26 on a
  second run, 10 on idioms), but on crossclock it passes through one of the
  large blocks nearly every time.
- The numbers in an exact row are small: 5 bits at the median, 23 at most,
  where the tableau's rows of whole numbers over one denominator reach 90
  bits on the same fixture. The size that drives runs out of 64 bits and
  past 128 is the common denominator of a long row, not any entry of it.
- What that adds up to. An iteration would be two such solves, some twenty
  value updates and a repair of the block structure, a few hundred
  operations on small fractions: about what a tableau pivot costs in 64 bits
  (11 us) and well under what one costs in a run that has left them (27 us,
  and those runs are three quarters of the time here). So perhaps 1.5 to 2
  times on this fixture, mostly from never leaving small numbers, nothing on
  the fixtures that fit 64 bits already, and no answer to the moves of the
  durations, which need every slack's value afresh in either design. Against
  that, keeping a matching, the blocks and their factors right under every
  change of basis, exactly, is a new solver. Not built.

**The other slow fixtures: chains with durations open, three times faster.**
chains ran at 31 runs a second with durations open against 764 concrete, and
one comparison, `here >= drift_deadline`, took two thirds of the time: its
other outcome is never open, 3,273 trials in 200 runs at 1.3 ms each. The
cause was not the proof but where the durations were sent on the way to it.
When the line search along a cut fails, values come from a small problem
solved from nothing, and with nothing bounding the durations above it lands
at any scale: one run went from an election of 3.6 to 115, to 4.2, to 1,020,
to 720, with the heartbeat between 0.016 and 9,274. Each such move broke 73
rows and took 45 pivots to settle, against 12 and 10 on crossclock.

- The small problem now starts from where the durations are, so its repairs
  move them only as far as the cuts need, and its answer goes onto a grid of
  halves when a grid point meets every cut. On chains a move then breaks 33
  rows and takes 24 pivots: 31 to 96 runs a second, the same answers.
- Values found nearby make the next trial more likely to need a move of its
  own, the old finding. Where a move is cheap that costs more than it saves
  (forms, 6,168 to 5,219), so a run looks nearby only once its moves have
  cost 4 pivots or more each on average over at least 8 moves; forms and
  idioms are then unchanged. A rule on how far the plain values are from the
  present ones lost most of the gain on chains (45).
- Starting nearby changes which numbers a run meets, and on webs three runs
  in 200 then outgrew 128 bits where none had. Overflow inside a small
  problem no longer ends the run, since its result is only a place to try;
  a move to values with large parts is tried on paper first; and a run that
  still has to leave comparisons to concrete time is played once more with
  the search from nothing, the run that answered more standing. Both are
  exact. webs then answers everything again, and crossclock leaves 2,048
  comparisons to concrete time where it left 3,446; the second play costs
  13% there and brings webs back to what it was (175 against 180), and
  `SIMPLEX_SECOND_TRY=0` turns it off (webs 220, crossclock 108).

**A further pass at the slow fixtures, asked for another two times, which
got 1.2 to 1.4.** chains with durations open 96 to 118 runs a second (3.8
times where it started), webs 175 to 238, the same answers.

- On webs the same two cuts alternate, each the other negated: the two
  outcomes of one comparison want the durations on opposite sides of one
  plane, and the run carried them across at every such comparison, landing
  in the middle of whatever room there was (one duration went from 2,672 to
  25,171 and back), 27 rows broken each time. And most moves are for
  nothing: after a move the probe fails 78% of the time on webs, and the
  trial ends closed.
- Short steps in a run where a move is costly, a quarter of the room at most:
  webs 174 to 195. The least step there is, onto the cut and an
  infinitesimal past it, is worse everywhere (chains 95 to 77): more moves.
- A second tableau, kept only in a run that has been seen to carry the
  durations back to where they had just been 16 times and whose moves cost 14
  pivots or more each. A trial goes to the tableau whose durations already
  meet the first cut that comparison's last trial read; everything accepted
  goes into both. webs 194 to 238, chains 97 to 118. Kept in every run where
  moves are costly it takes 8% off crossclock and idioms, which accept rows
  at a greater share of their cost.
- Tried and dropped: keeping a taken outcome that was implied as a row after
  all, either all of them (chains 95 to 47) or the latest for each comparison
  site with the one before it retired, which is exact since an implied row
  can go at any time (chains 118 to 105, everything else down 8 to 10%). The
  comparison that is never open on chains still costs over half the time
  there, 0.3 ms a trial, and what it costs is the first probe, not moves.

**Another two times on chains, from what the second tableau is chosen by.**
chains with durations open 118 to 243 runs a second (7.8 times where it
started), webs 238 to 260, the same answers; idioms, forms and crossclock as
they were.

- The comparison on chains that is never open was not costly to refute: with
  a row that made its proof one step, kept from the comparison before, its
  trials cost as much as without (an expensive one still took 215 pivots).
  Capping the probe and falling back to bounding the row is far worse (118
  to 24 at 12 moves), and taking the unknown that gains most on a long walk
  worse still (13): it brings long columns in.
- What the pivots were: the run's times being carried back. A trial of
  `here >= drift_deadline` pulls a recent time early through every event
  since, a pivot each as the gaps between close one by one; the next trial of
  another comparison pushes them late again. Two comparisons, 60% of the
  time between them. Sending either one's trials to a second tableau by hand
  took the cell to 290 to 300 and the never-open comparison from 894 ms to
  109.
- The rule that does this unaided: a trial is costly from 16 pivots; a
  costly trial that follows another comparison's costly trial in the same
  tableau is a conflict; after 8 conflicts a run keeps a second tableau, and
  from then on a comparison that conflicts moves its trials to the other
  one. It replaces the choice by the first cut a trial read, which only saw
  the durations being carried across; this one sees the times as well, and
  covers what that one did (webs 238 to 260). Lower thresholds gain more on
  chains (271) and cost idioms and crossclock 5 to 10%.
- At the concrete level it is about even: crossclock 271 to 292, chains 796
  to 735, the rest unchanged. A run that leaves comparisons to concrete time
  is now played again with one tableau and the search from nothing,
  whichever of those it had used; on crossclock concrete that second play
  of one run brings the cell to 239, with nothing left to concrete time.

**A pass at yet another two times, which found none.** What was measured
first: on webs under 1% of comparisons, those of 64 pivots or more, take 43%
of the pivots; in trials of 16 pivots or more, making everything hold again
after a move of the durations is 93% of the pivots on webs and 73% on
crossclock; and the largest group of such trials, half of webs' and a third
of crossclock's, end closed after one move, the move having been for nothing.
On webs 44% of the probes that fail after a move say the outcome is closed
wherever the durations are. Each of the following gave the same answers and
was dropped:

- A few moves with the durations free before any move of them, put back from
  a journal: 2 moves halve webs and quarter crossclock. A pivot on a duration
  touches every row that mentions one, however few are made.
- Making everything hold again by the dual simplex with the trial's row kept
  optimal, which lets a trial stop as soon as its row's value passes the
  target and needs no probe afterwards: chains 225 to 86. It stops early
  often (5,605 times in 200 chains runs), but what it reads off then is a
  weak cut, and the trial takes more rounds.
- Putting back the moves of a trial that ends closed, and only those: chains
  226 to 19, webs 245 to 181. Where a closed trial leaves the durations is
  where the next trial of its comparison sees at once that it is closed.
- Three and four tableaus: no better than two anywhere.
- Values for the durations chosen to meet the cuts other comparisons last
  asked for as well, as far as those go together: the moves barely fall and
  chains halves.
- The least step for a comparison whose moved trials mostly end closed: no
  gain. The durations started at the run's own values, or searches from
  nothing started there: no effect, as found before on idioms.
- One row kept for an implied outcome of each chain of comparisons (told by
  the oldest time in it): no gain, which is how it was found that the long
  trials on chains were not long proofs.

What stands in the way is stated by those results together: a move of the
durations costs ten to twenty pivots because the tableau sits at a vertex
where most rows that mention a duration are tight; where a trial leaves them
is worth keeping whether it ended open or closed; and no way was found to
tell that a move will be for nothing without making it.

**Finished times glued to a neighbour.** Three fresh readers were given the
profile and the list of what had been tried and asked for ideas with an
argument each. What was built is the one with a proof: a finished time whose
accepted rows all allow it to move one way can be taken as equal to the
neighbour on that side. The script keeps, for each run of times already taken
as equal, the net coefficient of every accepted row on the run (the ordering
rows aside); when the last time in it is finished and no row has a negative
coefficient, the run is raised to the time after it, and when none has a
positive one it is lowered to the time before. Nothing that is still live
changes value, and every row still holds, so no answer changes; Z3 given the
same equalities (`Z3_GLUE`) gives the reference answers on every run tried.
The solver takes the step as an upper bound of zero on the gap the ordering
was recorded with, folded away at once when the gap sits outside the basis
at zero (93% of them on chains) and repaired with a pivot otherwise.

- On chains 48% of times are glued, the pivot row falls from 24 entries to
  17 and the merged rows from 58 to 41, and the merge work by a third; the
  pivots do not fall. On runs both settings finish, one thread, durations
  open: chains 1.16 (243 to 281 runs a second), idioms 1.15, crossclock
  1.07, webs 1.06, long 1.06, forms 1.00; concrete: crossclock 1.17 (201 to
  262), chains 1.16, webs 1.10, long 1.05, idioms and forms 1.02. The same
  open outcomes, and no answer differs from Z3 on 14 cells (chains 5 runs,
  webs 60, crossclock 20, idioms 100, forms 150, long 200, cached flag 300,
  each with durations open and concrete).
- Folding the gap found a fault in fixing a column: a finished row left
  with one column became a bound on that column and was dropped, and when
  that column was a time mentioned by name from the basis, dropping the row
  could drop that time's own row with it, bound and all. It was reached only
  under the row budget before, where mentions by name are off. A row whose
  one column is in the basis is now kept.
- The debug check of open trials against every row asked (`SIMPLEX_DEBUG`)
  reports violations on every dataset with the durations open, gluing or
  not, so it no longer reads the tableau it was written for; Z3 is the
  reference.

What the census of a long chains run says about the rest: at the end, 1,500
of its 1,640 live rows belong to finished gaps, and 29,000 of its 32,000
entries sit in those rows; the pivots touch such rows two times in three and
merge 80% to 90% of their entries there. Every row of that history is short
in itself (a span of ten to forty gaps), and their projection onto what is
live is the Fourier-Motzkin product noted before. Keeping them out of the
tableau and checking them at a probe's end costs the same information flow
as folding them, so it was not built. Also measured: a run played in 128-bit
numbers throughout costs 1.15 times its 64-bit self, so the width is not the
lever; the runs that outgrow 64 bits are simply the long ones, 37% of the
time on chains, 70% on webs and 83% on crossclock, and what a value form
that never outgrows the rows would save is the wasted 64-bit attempt, about
a seventh of those runs' time.

**A second round of proposals, each killed by its own counter.** Two more
readers were given the census and the profile and asked for mechanisms with
a counter that would confirm or kill each before building. Measured first,
on 100 runs of each fixture:

- Nearly every row a duration move breaks belongs to the finished history:
  20.7 of 20.8 on webs, 14.3 of 15.1 on chains, 9.5 of 9.9 on crossclock.
- The basis oscillates: of the pivots made in trials, 64% on webs, 41% on
  crossclock and 32% on chains repeat a (leaving, entering) pair already
  pivoted on in the same run.
- Deferring the move back after a settle that fails: such settles are 3% of
  moves on webs (89 of 2,970), so there is nothing to save.
- The parametric walk along a move (pivot at each breakpoint with the trial
  row kept optimal, stop at the target): under the present basis the trial
  row reaches its target within the move in every case, but 84% of the rows
  the move breaks break before that point, so the walk would make nearly
  every pivot the settle makes now.
- Bringing in the oldest eligible column when a taken outcome is accepted,
  so that fill lands in rows only the walk touches: merged entries a pivot
  rise slightly (1,160 to 1,179 on chains), and the same rule in every phase
  costs 40%.
- The durations as a dense strip beside each sparse row: their entries are
  6% of what pivots merge on chains and 7% on crossclock, 22% on webs, where
  eight dense slots a row would cost about what the sparse entries do.
- Broader triggers for the second tableau on webs: at most 1.08.

Left unbuilt, with their estimates: duration moves screened in floating
point so that only rows that can break are updated exactly (about 13% of
webs, none of the answer, a stale-read risk), and cuts learnt without a move
where the row that will break has nothing to repair it. Both readers put
the remaining cost where the census does: a vertex tableau re-lays the
finished history whenever the parameters move, one pivot per tight row in
the move's path, and no cut rule changes that. A revised simplex over a
factored basis, whose duration moves are re-solves against one
factorisation, is the one design left that does, and it was estimated at
1.5 to 2 times on crossclock from dumped bases and is a new solver.

**Several tableaus, and a trial that asks each before moving anything.**
The second tableau became any number (`SIMPLEX_TABLEAUS`, still 2), and a
trial whose comparison's own tableau would have to move the durations now
gives up there first, asks each other tableau the same way (a probe capped
at the costly-trial length, no move), and only then moves in its own
(`SIMPLEX_PROBE_EVERYWHERE`, on). A tableau that gave up accepts nothing
until the answer is in; an earlier form of this accepted the taken outcome
before the trial was made again in the same tableau, which closed the
negation for free and looked like 1.67 on webs until Z3 said otherwise.
Sound, on runs both finish: crossclock 1.14, webs 1.07, chains, idioms and
forms within 2% of even; 14 cells Z3-equal. Of the trials that give up in
one tableau, 22% on webs and 26% on crossclock are answered in another
without a move; the rest move at home after all.

Tried on top and dropped: a tableau spawned for a comparison that keeps
having to move after every tableau gave up (`SIMPLEX_SPAWN_FROM`, off), with
up to four tableaus: webs 1.00 to 1.09, chains 0.88 to 0.98. A tableau
spawned at a trial's first move elsewhere, and a trial routed to the
tableau whose durations meet the first cut its comparison's last trial
read: the cut belongs to that comparison's times, the next comparison at
the same site wants another, so no tableau meets it and the run spawns its
way to the limit; chains 0.63.

What that settles: the regions the durations move between are not a few
per run but one per comparison, so keeping bases is not what a revised
simplex would buy either. With the width finding above, its remaining case
is the cost of a pivot, which the dumped bases put at about what a tableau
pivot costs in 64 bits; it is not built.

**A side problem that shows a move futile before it is made, which pays
for nothing.** Before a move, a small problem of its own: the rows the move
would break, the rows sitting on a bound in its path, the trial's row and
the kept cuts, as equalities over their own columns with their bounds, the
durations free; the trial's row probed for its target. It is a relaxation,
so a target out of reach there is out of reach everywhere. It closes 65% of
the trials that were about to move on webs and chains and 37% on crossclock,
from ten rows and a dozen pivots each, and the run is slower with it: webs
0.88, crossclock 0.77, chains 0.75. A side problem costs 64 us where a move
with its settle costs about 50, and a move that was futile for its own
trial still leaves the durations where the site's next trial finds them;
skipping it moves that cost to the next trial. Removed.

**Bounding the cost on the hard fixtures: a row budget against a time
cap.** 400 runs each with durations open, one thread. The row budget
(`play_within`) fixes finished columns once live rows pass it; "kept" is the
share of the exact solver's open outcomes it also finds open while it can
still follow the record, "of all" counts every comparison after a run
leaves the record as lost, "left" is the share of runs that leave it.

| fixture | setting | kept | of all | left | cost over the run: median / p99 / max | runs/s |
| --- | --- | --- | --- | --- | --- | --- |
| webs | exact | 100% | 100% | 0% | 0.97 / 10.3 / 16.9 | 259 |
| webs | budget 128 | 97.1% | 49.7% | 16% | 0.67 / 6.4 / 7.4 | 432 |
| webs | budget 64 | 97.0% | 29.6% | 50% | 0.50 / 3.0 / 3.9 | 1,124 |
| chains | exact | 100% | 100% | 0% | 0.83 / 13.1 / 17.4 | 279 |
| chains | budget 128 | 98.6% | 37.9% | 22% | 1.13 / 10.8 / 15.6 | 479 |
| chains | budget 64 | 97.4% | 24.3% | 50% | 0.87 / 2.7 / 3.6 | 1,079 |
| crossclock | exact | 100% | 100% | 0% | 2.75 / 41.0 / 69.7 | 91 |
| crossclock | budget 128 | 98.3% | 44.7% | 40% | 4.66 / 23.7 / 32.0 | 151 |
| crossclock | budget 64 | 96.5% | 20.8% | 87% | 1.20 / 7.0 / 8.4 | 605 |

A time cap instead: a run whose solver time passes a multiple of its own
wall time leaves the rest of its comparisons to concrete time, keeping the
answers it has (the concession the tiers already make on overflow). Worked
out from each run's measured solver time and wall time, taking a run's
cost as even along it, which the shared rows made nearly so:

| fixture | solver over the runs' wall, uncapped | cap 3x: runs cut, comparisons kept, cost | cap 5x | cap 10x |
| --- | --- | --- | --- | --- |
| webs | 2.42x (median 0.94, p99 9.2) | 9.5%, 89.0%, 1.74x | 4.0%, 95.9%, 2.08x | 0.8%, 99.2%, 2.33x |
| chains | 3.54x (0.81, 13.0) | 19.0%, 76.9%, 2.12x | 8.5%, 90.7%, 2.80x | 2.0%, 98.3%, 3.35x |
| crossclock | 7.93x (2.55, 47.1) | 41.5%, 60.1%, 2.61x | 27.0%, 74.8%, 3.73x | 9.5%, 91.1%, 5.41x |
| idioms | 0.77x (0.26, 2.0) | 0%, 100%, 0.77x | 0%, 100%, 0.77x | 0%, 100%, 0.77x |

The cap is the better policy on every fixture: at about the same total
cost, budget 64 keeps 20% to 30% of all outcomes where a cap of 3x to 5x
keeps 75% to 96%, and the cap loses nothing on runs that were cheap. What
it gives up is the tail of the long runs, which is where the exact solver's
time goes; for crossclock even a 10x cap still costs 5.4 times the runs'
own time, since half of its runs are past 2.5x at the median.

Then the cap built in (`play_until`; `SIMPLEX_CAP=k` on `linear-threads`
with `--walls`), and the budget beside it (`SIMPLEX_BUDGET`). 400 runs,
durations open, one thread; "open kept" is the open outcomes reported
against the exact solver's, which under a budget are lost to closing and
under a cap to concession:

| fixture | exact | cap 10x | cap 5x | cap 3x | budget 128 | budget 64 + cap 5x |
| --- | --- | --- | --- | --- | --- | --- |
| webs | 248 | 256, 99.7% | 283, 97.0% | 328, 90.0% | 372, 60.5% | 967, 42.5% |
| chains | 260 | 267, 99.0% | 313, 91.7% | 396, 74.7% | 402, 44.8% | 944, 28.7% |
| crossclock | 109 | 155, 93.1% | 219, 78.3% | 302, 66.8% | 153, 87.6% | 653, 40.9% |

The cap keeps what it answers exact and loses only the tails; the budget
answers every comparison but closes most of what was open. A cap of 5x is
the setting to use where cost must be bounded; on crossclock a run's
median cost is already past 2.5x, so its cap bites the middle of the
distribution and not only the tail.

A cap on a trial instead of on a run (`SIMPLEX_TRIAL_CAP`, pivots; a
trial stopped by it leaves its one comparison to concrete time and the run
goes on exactly) changes little: at 16 pivots, chains 258 to 233 runs a
second with 2.5% of comparisons left, webs 249 to 276 with 2.0%, crossclock
108 to 119 with 1.8% more. The cost of these fixtures is not in long trials
but in the bulk of short ones, each a move of the durations and a settle of
about fourteen pivots, so a cap on trials has almost nothing to cut. What a
run cap cuts is long runs, which are many comparisons, not long trials.

Where the cost sits by site: on chains one comparison whose other outcome
is never open (2,927 trials, 0 open, 44% of the time) would answer to a
policy that stops trying a site after enough closed trials; on webs and
crossclock every costly site is open a third to four fifths of the time,
and such a policy would only lose answers there.

Passing over a comparison whose trials keep moving the durations and
finding the outcome closed, trying it only every eighth time after four or
eight such trials in a row: chains 258 to 193 runs a second with 6% of its
comparisons left, webs and crossclock about even. On chains the never-open
site's trials, 2,927 of them costing 255 ms when every one is made, cost
479 ms for the 1,122 that remain when most are passed over: each trial
kept the tableau laid out for the next, and one made only now and then
lays it out from wherever the others left it. The cost of that site is
the upkeep of a layout, not the trials. Removed.

The policies on the realistic fixtures, 1,000 runs each, durations open:

| fixture | exact | cap 5x | budget 64 | budget 64 + cap 5x |
| --- | --- | --- | --- | --- |
| idioms | 1,296 | 1,263, 100% | 2,003, 74.1% | 1,949, 74.1% |
| cached flag | 14,981 | 14,112, 100% | 13,075, 77.4% | 12,354, 77.4% |

The cap never bites on them (no run reaches five times its own cost), and
the budget closes a quarter of what is open for at most 1.5 times the
speed, and on the lease spec for less than none.

**The same solver in floating point.** A fourth number type `F` under the
same generic solver (`--backend float`, `play_float`): rows over `f64` with
one denominator that stays one, a relative tolerance of 1e-7 in equality
and order (at 1e-9 a degenerate corner is circled for good), an entry
dropped when it cancels against the size of what was added, no widening,
and a check that passes 4,096 pivots gives the run up. Every mechanism the
exact solver has runs unchanged over it, so the two compare fairly. 400
runs each (1,000 to 2,000 on the cheap fixtures), durations open, one
thread, runs a second and, on runs both finish, the ratio of their time:

| fixture | exact | float | on runs both finish | answers |
| --- | --- | --- | --- | --- |
| webs | 249 | 520 | 2.11 | 3 of 6,097 open where Z3 says closed (60 runs); 3.6% of comparisons given up |
| crossclock | 109 | 245 | 2.16 | equal to Z3 on 20 runs; nothing given up where exact left 1.8% to overflow |
| chains | 259 | 399 | 1.54 | 1.9% of the exact solver's open outcomes answered closed; Z3 does not finish these |
| idioms | 1,298 | 1,545 | 1.16 | equal to Z3 on 100 runs |
| forms | 5,853 | 5,763 | | equal to Z3 on 150 runs |
| long | 4,125 | 3,880 | | equal to Z3 on 200 runs |
| cached flag | 15,909 | 13,942 | | equal to Z3 on 300 runs |

- It pays where the exact solver's numbers are large: the three synthetic
  fixtures, 1.5 to 2.2 times. On the cheap fixtures it is slower, by up to
  13%: a tolerant comparison costs more than an integer one, and the key a
  slack is found by is a rational read off the float by continued
  fractions, where the exact solver has it for nothing.
- Its errors go both ways. An answer of open that Z3 refutes (webs, 0.05%)
  is the dangerous direction and is caught by a certificate; an answer of
  closed that the exact solver refutes (chains, about 2% of open outcomes)
  is a flip never offered, and nothing catches it.
- Certifying every open at once does not work as hoped: a rational point
  read off the float assignment by continued fractions satisfies every
  accepted row exactly for only 2% (webs) to 3% (idioms) of the answers,
  because the point sits on its bounds and the rows tight there come out
  a rounding away from holding; and evaluating a thousand rows at a point
  costs more than the trial (66 runs a second). A certificate needs the
  basis solved exactly, which is the factored-basis solve estimated
  before, and so belongs where an answer is acted on, once per flip, not
  once per trial (`SIMPLEX_CERTIFY=1` turns the per-trial form on).

The float solver under the same policies (`play_float_within`), runs a
second and the share of the exact solver's open outcomes still reported:

| fixture | exact | float | float, cap 5x | float, cap 3x | float, budget 64 |
| --- | --- | --- | --- | --- | --- |
| webs | 249 | 520, 96.2% | 522, 96.2% | 521, 95.9% | 1,585, 42.5% |
| chains | 259 | 399, 98.1% | 393, 97.2% | 422, 90.1% | 1,197, 28.6% |
| crossclock | 109 | 245, 101.9% | 298, 97.5% | 341, 89.0% | 1,013, 41.8% |
| idioms | 1,298 | 1,545, 100% | 1,537, 100% | 1,533, 99.9% | 2,260, 74.1% |
| cached flag | 15,909 | 13,942, 100% | 13,817, 100% | 13,648, 100% | 13,885, 75.8% |

The cap has less to cut in float than in exact numbers, since the tail it
cuts was mostly the exact solver's wide arithmetic: at 5x it gains
nothing on webs and chains and 22% on crossclock. The budget behaves as
before, three to four times the speed for a third of the answers.

**No move for a trial, measured and removed.** A mode that answered
unknown wherever a trial would have to move the durations kept 92% to 99%
of open outcomes offline at 1.2 to 2.1 times the speed, but only because
the recorded run took branches it had marked unknown, and accepting those
moved the durations for it. Online the explorer takes only what the solver
offers, so the durations never move and the mode is the concrete level
with symbolic times: 78% to 89% of opens on the synthetic fixtures, 58% on
the lease spec. Removed.

**Draw, then verify.** A planner asked for approximations that serve
online put first a chooser that draws its outcome before asking: a draw of
the outcome the present values already witness needs no trial, and only a
draw of the other one is a trial, which the accept then settles. Nothing
answered is wrong; what is lost is the answers nobody asked for. Offline,
a comparison whose recorded outcome is witnessed skips its trial except
for a share q (`SIMPLEX_DRAW=q`, seeded); solver time on the same runs,
base over draw:

| fixture | q = 0.5 | q = 0.25 | comparisons without an answer, q = 0.5 |
| --- | --- | --- | --- |
| webs (300 runs) | 1.46 | 2.30 | 39% |
| crossclock (300) | 1.38 | 2.31 | 42% |
| idioms (400) | 1.30 | 1.66 | 37% |
| chains (200) | 0.77 | 0.95 | 41% |

On chains a trial kept the tableau laid out for the next, as found when
passing over a never-open site, and fewer trials cost more each. Online
the share q is the explorer's: how often it draws the outcome already
witnessed and still wants to know whether the other was open.

**Priced opens: the durations move only at an accept.** A trial whose
outcome would need the durations elsewhere stops where it would have moved
them and offers the outcome as open at a price (`SIMPLEX_PRICED=1`, one
tableau): an explorer that takes it pays the move at the accept, which
either settles or fails on the spot, and the run then takes the witnessed
outcome. So every error is an open that is not, and each one is seen when
it is taken. Offline this is a fair proxy, unlike the mode it replaces:
the record never takes a proven-closed outcome, and every other outcome
is offered, so each branch the record takes is one the explorer could.

Against Z3, every open outcome is offered and the closed ones are offered
at these rates (webs 60 runs, crossclock 20, idioms 100, cached flag 300,
long 200): webs 48% of closed outcomes, crossclock 26%, idioms 19%, cached
flag 18%, long 8%. Of the outcomes offered at a price, the audit
(`SIMPLEX_PRICED_AUDIT=1`, which goes on with the full trial and puts the
durations back) finds these open: webs 27%, chains 32%, crossclock 59%,
idioms 11%, cached flag 49%.

Runs a second, one thread, durations open; the offline figures leave out
the failed accepts an explorer would pay when it draws a false open, each
about a move and a settle:

| fixture | exact | priced | priced, float |
| --- | --- | --- | --- |
| webs (400) | 247 | 519 | 1,070 |
| chains (400) | 260 | 260 | 694 |
| crossclock (400) | 109 | 219 | 479 |
| idioms (1,000) | 1,304 | 2,244 | 2,377 |
| cached flag (2,000) | 16,012 | 16,560 | |

**The policies across every spec, against the run's own time.** Each
policy on every dataset, one thread, durations open; the figure is solver
time over the runs' own execution time, then the p99 of that ratio per
run, then the share of comparisons given no answer. "Draw" is
draw-then-verify with a chooser that takes each outcome half the time;
"priced" pays the full trial for half of its priced offers, as a chooser
taking them would, and puts the durations back afterwards, which
overstates what a taken offer costs online.

| spec | exact | exact, cap 5x | draw | priced | float | float, draw | float, priced |
| --- | --- | --- | --- | --- | --- | --- | --- |
| clean | 0.09, 0.2 | 0.10 | 0.09, 27% | 0.09 | 0.10 | 0.10, 27% | 0.10 |
| receipt anchor | 0.09, 0.2 | 0.10 | 0.09, 34% | 0.09 | 0.11 | 0.10, 34% | 0.10 |
| cached flag | 0.13, 0.3 | 0.14 | 0.12, 37% | 0.14 | 0.14 | 0.13, 37% | 0.15 |
| long | 0.09, 0.1 | 0.10 | 0.09, 13% | 0.09 | 0.09 | 0.09, 13% | 0.09 |
| forms | 0.25, 0.5 | 0.26 | 0.22, 24% | 0.24 | 0.25 | 0.22, 24% | 0.24 |
| idioms | 0.89, 2.2 | 0.90 | 0.67, 37% | 0.81 | 0.73 | 0.56, 37% | 0.66 |
| webs | 2.52, 9.3 | 2.21, 2.7% | 1.70, 39% | 2.39 | 1.18, 3.6% | 0.88, 40% | 1.19 |
| chains | 3.69, 13.1 | 3.07, 7.3% | 4.03, 41% | 27.1 | 2.36 | 2.25, 41% | 10.4 |
| crossclock | 8.13, 47.1 | 4.06, 23% | 5.71, 42% | 9.13, 2.7% | 3.51 | 2.30, 41% | 3.81 |

- On the five specs from the panel and forms the solver adds 9% to 25% to
  a run's own cost under every policy, with a p99 at half a run or less.
  They need no policy.
- Where a policy matters, float with draw-then-verify is best on every
  fixture: idioms 0.56, webs 0.88, chains 2.25, crossclock 2.30. The
  comparisons it leaves unanswered are the ones the chooser did not ask
  about, not lost answers.
- Priced offers lose once a chooser takes them: every failed accept is a
  move and a settle, and on chains most offers fail.

With the 5x cap on top of float and draw-then-verify, the averages barely
move (chains 2.25 to 2.23, crossclock 2.30 to 2.18, everything else within
noise, since no run on the other specs reaches five times its cost) and
the worst run falls from 9.5 to 6.0 on chains and from 9.8 to 6.3 on
crossclock, for 0.7% and 1.5% more comparisons left to concrete time. The
cap is checked between comparisons and conceding finds its continuation
point, so a run ends a little past the cap.

## Limits

- Three specs, one lease idiom, one comparison site each. No spec in the
  repository uses `tt_now` or `set_timer_at`; only the fixture exercised
  them.
- The four pass lines were read with rates and named durations concrete per
  run. Leaving them open was tried only through general solvers, on 3,000
  runs per spec.
- Message delay was not recorded, so no constraint ties a delivery to its
  send.
- The smallest `rho` a violation needs was not computed. A cached-flag
  violation appears about once in 300,000 runs, and recording that many
  replay artifacts to catch one was not worth the disk.
- Solver cost is for one run in isolation, measured offline. It does not
  include carrying symbolic values through the interpreter.

## What follows

1. A symbolic mode is not justified by reach on the current panel. Schedule
   shape is still the binding constraint for the lease mutants.
2. The cheap, separable piece is reporting. Extracting a violating run's
   constraints and asking what it needs (the smallest `rho`, and with sends
   recorded, the smallest delay bound) uses only what was built here, needs
   no change to exploration, and answers a question the concrete engine
   cannot.
3. If a symbolic mode is built later, three requirements come from these
   readings: eliminate dead unknowns, solve with the floor margin, and
   classify each comparison site at compile time so a spec outside the
   two-point form is reported rather than silently slow.

## Where the tooling is

Nothing here is merged. The recorder is on the `experiment/time-constraints`
branch of the `spur` submodule (feature `time-constraints`, two commits on
7a72bef). The analyzer, configs, fixture, script and per-spec result files
are on the superproject branch `research/symtime` under `research/symtime/`.
Deleting both branches removes all of it.

## Online reach (go/no-go R)

Symbolic time in the simulator, measured on the three lease specs under the
panel overlay (`research/symtime/configs/lease.json`, `lease_pause.json` for
the cached flag). Explorer `standard`, 30 threads, linearizability on,
`stop_on_violation` off. The arms alternated in 300 s chunks, concrete
then symbolic, with session seeds 1000 and 1001. That gives each arm
600 s of wall time per spec. The `trials: all` arm ran one 120 s chunk
per spec and is read for open shares only. The symbolic arm is
`time.mode = symbolic`, sampled durations, exact arithmetic, `trials:
drawn`, `confirm: violations`: a symbolic violation counts only once a
concrete replay of its witness is illegal too. Per-chunk summaries are in
`research/symtime/results/reach/`, and the table is in
`results/reach_sessions.txt`.

| Spec | Concrete | Symbolic (drawn) | Per wall-hour |
|---|---|---|---|
| cached_flag | 54 in 16.7M runs (27.9k runs/s) | 51 in 8.9M (14.9k runs/s) | 324 against 306: 0.94x |
| recv_anchor | 1 in 16.3M | 6 in 8.7M | 6 against 36: 6x |
| clean | 0 in 16.0M | 2 in 8.9M (1 more in a 300 s re-run) | 0 against 12 |

- **Per run**, symbolic finds the cached flag about 1.8 times as often
  (1 in 175k against 1 in 310k). It runs at 0.53 of the concrete speed,
  which cancels that per wall-hour. 600 s per arm bought about 50 events
  an arm, so the 0.94 ratio is good to roughly plus or minus 30%. The
  recv_anchor and clean counts are single figures.
- **Every symbolic candidate was confirmed**: 51 + 13 + 6 + 1 + 2 replayed
  illegal, with no unconfirmed candidate and no conceded run. The
  unconfirmed share is 0%, and none was lost to a concession.
- **The clean control is not clean.** The confirmed run
  (`results/reach/clean_violation_witness.json`) replays concretely as
  follows:
  1. Node 1 holds a lease from its round-2 heartbeat, acknowledged by
     node 2.
  2. Node 0 has not heard a heartbeat, so its own election timeout fires.
  3. Node 2 grants node 0 its vote a few steps after acknowledging node 1.
  4. Node 0 commits a write.
  5. Node 1 then answers a lease read without that write.

  The spec's `RequestVote` grants any vote whose log is up to date. It
  lacks the thesis's rule (section 4.2.3) that a server which heard from a
  current leader within the minimum election timeout refuses votes. The
  lease argument of section 6.4.1 silently needs that rule. This reads as
  ambiguous in the thesis, since 6.4.1 does not say it depends on 4.2.3,
  and as an omission in the spec. The recv_anchor violations were not
  diagnosed; its vote handling is the same, so they may be this bug too.
  32M concrete runs of clean found nothing.
- **Open shares (trials: all)**: 0.40 on cached_flag, 0.84 on recv_anchor,
  0.77 on clean. The offline range was 42% to 85%.
- **What a flip finds**: flip-taking runs compared with runs that took
  none, matched by grid configuration, 100,000 symbolic runs per spec
  (session seed 2000). A run is new when its set of per-node handlers and
  digit-masked log lines, or its ordered leadership and lease events, has
  not been seen earlier in the session. Flip runs are new slightly less
  often by branch set (matched difference -0.03 to -0.05). By event
  timeline they are +0.07 on cached_flag and -0.03 to -0.04 on the other
  two.
- **Conjunctions**: joint (node, site, result) patterns over the first
  30,000 runs of each sample, concrete from the recorder:
  - Distinct patterns are the same in both arms: 55 against 54, 51
    against 51, 47 against 48.
  - Runs in which the lease held on two nodes at once:

    | Spec | Concrete | Symbolic |
    |---|---|---|
    | cached_flag | 4.6% | 2.7% |
    | recv_anchor | 6.1% | 2.9% |
    | clean | 1.6% | 2.3% |

- **Costs, symbolic drawn**:
  - Solver share of run wall time: 1.0% on cached_flag, 0.3% on the
    other two.
  - Draws of the non-witnessed outcome, as a share of comparisons: 0.50.
  - Taken: 0.20 on cached_flag, 0.39 on clean, 0.42 on recv_anchor.
  - Refused: 0.30, 0.11 and 0.08.
  - Runs with a taken flip: 31%, 63% and 67%.
  - No widenings, no concessions, no barrier fallbacks, no implicit
    decisions.
  - Shadow releases: about 69 a run, 2.3 per timed fire.

Verdict against the R thresholds:
- **Go fails** because the clean control has confirmed violations. The
  other Go conditions hold: recv_anchor falsifies at 6x (and falsified
  concretely once), and the unconfirmed share is 0%.
- **No-go does not apply**, since recv_anchor is above 1.5x.
- The reading is therefore **the middle band**. The one entry that
  blocks Go is a real bug that symbolic time found and concrete sampling
  did not.

### After the vote rule

The three lease specs now refuse a vote while the voter has heard from the
leader of its current term within `durations().election` on its own
clock (thesis section 4.2.3). Each mutant keeps its mutation. The reach
protocol was run again unchanged: same configs, seeds 1000 and 1001, two
300 s chunks per arm alternating, one 120 s `trials: all` chunk, 30
threads. Summaries are in `research/symtime/results/reach_fixed/`, and
the table is in `results/reach_sessions_fixed.txt`.

The clean witness from before does not replay against the fixed spec.
Replay refuses it before the first step, because the artifact names the
old program's digest. The vote it depended on is one the rule refuses:
node 2 had heard node 1 3.3M ticks earlier, against an election timeout
of 6.3M.

| Spec | Concrete | Symbolic (drawn) | Per wall-hour |
|---|---|---|---|
| cached_flag | 31 in 15.6M runs | 35 in 8.2M | 186 against 210: 1.13x |
| recv_anchor | 0 in 15.7M | 3 in 8.1M | 0 against 18 |
| clean | 0 in 15.3M | 0 in 8.2M | 0 against 0 |

- Every symbolic candidate replayed illegal. The unconfirmed share is 0%,
  and no run conceded. One concrete recv_anchor chunk left 209 histories
  unchecked when its check queue deferred them at the end of the session.
- Open shares: 0.45 on cached_flag, 0.75 on recv_anchor, 0.71 on clean.
- Flip runs are now at least as new as matched runs that took no flip:
  - by branch set, +0.10, +0.02 and +0.01;
  - by event timeline, +0.15, +0.06 and +0.05.
- Distinct joint patterns, 30,000 runs each, concrete against symbolic:
  1533 against 1470, 1675 against 1534, 1599 against 1496. The vote check
  is a second comparison site, so the two-node count now mixes that site
  with the lease check and is not read.
- Costs, symbolic drawn:
  - Solver share 1.3% on cached_flag and 0.6% on the other two.
  - Taken flips 0.23, 0.38 and 0.35 of comparisons; refusals 0.28, 0.12
    and 0.15.
  - No widenings, concessions or barrier fallbacks.
  - About 69 shadow releases a run.

Classification of the confirmed stale lease reads
(`results/reach/votes_all.txt`: for each read, whether the vote that
elected the superseding leader came within the voter's election timeout
of hearing the stale leader):

- **The clean control's read, and four of the six recv_anchor reads on
  the unfixed specs.** Each needed a vote the section 4.2.3 rule refuses.
  In recv-1000 run 1489819, for example, node 0 voted for node 1 in term 4
  in the same tick it heard node 2, the term-3 leader. Node 1 then
  committed, and node 2 served a lease read at step 114. This is
  **ambiguous**: section 6.4.1 derives the lease from followers not timing
  out, and never says that followers must also refuse votes, which the
  spec as written did not do.
- **The other two unfixed recv_anchor reads (runs 1005288 and 353531) and
  all three reads on the fixed recv_anchor spec (2243085, 2919364,
  1005288 again).** In each, the voter was past its own timeout, so the
  vote was legitimate. In run 1005288 node 2 becomes leader for term 3 at
  step 168. It takes its lease at step 171 from the moment node 0's
  acknowledgement arrives, adds the full lease with no drift margin, and
  its clock runs slow. Node 0's timeout runs from the heartbeat it last
  received. Node 0 votes for node 1 at step 193, 760k ticks after it
  last heard node 2, against a 688k timeout. Node 1 commits, and node 2
  answers a lease read at step 206. This is the intended mutation, an
  **implementation bug** by design: the lease is anchored at the
  acknowledgement's arrival rather than the heartbeat's send, and its
  margin is dropped.

Verdict against the R thresholds, fixed specs: **Go**.
- The clean control has no confirmed violation in either arm.
- recv_anchor falsifies under symbolic time (3 confirmed in 8.1M runs)
  and not concretely (0 in 15.7M).
- The unconfirmed share is 0%.
- cached_flag stays near parity per wall-hour (1.13x, about 30 events per
  arm, so roughly plus or minus 35%). It is 2.2 times as likely per run.

### Recovery and the vote rule

The time a node last heard its leader is volatile. A follower that
acknowledged the leader, crashed and recovered could therefore vote at
once. All three lease specs now set that reading to `mono_now()` in
`RecoverInit`, with the restored term, so a recovered node waits out a
full election timeout before it votes. The monotonic clock survives a
crash, so nothing has to be persisted. Persisting the reading would only
move the wait's start earlier, to the last heartbeat before the crash,
which is shorter but asks for a durable write on every heartbeat.

Checks, same overlay, 30 threads, 300 s chunks, seeds 1000 and 1001:

- **Clean, concrete:** 0 confirmed in 15.4M runs. Seed 1001 left 15
  histories unchecked when its check queue deferred them; run again with
  the queue blocking, it checked all 7.69M and found none.
- **Clean, symbolic:** 0 confirmed in 8.2M runs.
- **Crashes occur:** in both arms half the runs take one (7.69M of 15.4M
  concrete, 4.08M of 8.2M symbolic), the overlay's 0-to-1 crash range.
- **recv_anchor, symbolic, 600 s:** 3 confirmed in 8.0M runs (runs
  2243085, 2919364 and 1005288). In all three the voter was past its own
  timeout (`results/reach_recovery/votes.txt`), so the anchor mutation is
  still found.
- **The phase 4 concrete recv_anchor chunk that deferred 209 histories:**
  run again on the same spec with the queue blocking, it checked all 7.87M
  and found no violation. The concrete count stays at 0.

## Phase 5 and the witness

### Where the cost gap on the fixtures comes from

A reading only; the cost exit criterion is left to the perf loop.
- Per comparison the online solver matches the offline harness, about 7 us:
  the gap on idioms and forms is not the engine.
- Symbolic runs make about twice the comparisons a run. A concrete run
  spends about a third of its steps on advances and idling (idioms: 345
  dispatches, 167 advances and 154 idle steps a run), while a symbolic run
  samples no advances and fires timers freely.
- On the timer-heavy fixtures 85% to 90% of symbolic wall time is outside
  the solver.

### The audit as a regression check

Every run audited, each log played again through a fresh engine with the
calls the simulator made (`symtime audit`): 320 runs on each of the six
datasets, about 200,000 decisions and 83 withdrawn trials, 0 differences in
any answer, taken flip, implied or rejected flag, or require. Runs with open
durations are not covered: the log does not keep where an open duration
started (`results/phase5/audit_regression.txt`).

### Refusals by site

Share of drawn flips refused: 0.28 clean, 0.23 recv_anchor, 0.57
cached_flag, 0.53 forms, 0.48 idioms, 0.58 crossclock. Refused trials take
0.01 of solver time on the two lease read specs, 0.07 on cached_flag and
up to 0.19 on crossclock. A few sites almost never flip (forms site 6 refuses
100%, idioms site 18 99%) and carry most of their dataset's refused-trial
time; they are what phase 6's down-weighting is for
(`results/phase5/refusals_by_site.txt`).

### Starting point

Open durations started at the sampled assignment, at another seed's sample,
and at one fixed assignment; runs paired and compared while they take the
same path. The witnessed outcome differs in 1.3%, 0.3% and 1.9% of
decisions against another seed's start (clean, recv_anchor, cached_flag),
and in 1.9%, 0.3% and 5.1% against the fixed start. The fixtures have no
named durations (`results/phase5/starting_point.txt`).

### Reach with open durations

The phase 4 protocol again on the fixed lease specs, recovery fix included:
seeds 1000 and 1001, 300 s chunks alternating concrete, drawn and open, one
120 s `trials: all` chunk, 30 threads (`results/reach_p5/`,
`results/reach_sessions_p5.txt`).

| Spec | Concrete | Drawn | Open |
|---|---|---|---|
| cached_flag | 30 in 15.9M (180/h) | 35 in 7.8M (210/h) | 31 in 7.0M (186/h) |
| recv_anchor | 0 in 15.7M | 3 in 7.7M | 3 in 7.1M |
| clean | 0 in 15.5M | 0 in 7.8M | 0 in 7.1M |

- Every candidate replayed illegal; no run conceded or widened.
- The open arm finds the same three recv_anchor runs as the drawn arm
  (2243085, 2919364, 1005288): open durations start where the run sampled
  them, and these violations need no other assignment.
- Open costs throughput: 11.7k to 11.9k runs/s against 12.9k to 13.1k,
  solver share 0.05 to 0.07 against 0.04 to 0.05. On cached_flag it takes
  far more flips (0.40 of comparisons against 0.23) and refuses fewer (0.10
  against 0.27): moving the durations opens outcomes the sampled ones close.
  That has not turned into more violations per wall-hour.

### Witness and concession: why the exit falls short

Under `confirm: all` idioms replays 316 of 320 (0.9875: 3 witness
overflows, 1 concession off a witness) and crossclock 269 of 320; of
crossclock's 47 conceded runs 2 replay past the concession. The lease specs
and forms replay 320 of 320.

Eliminating finished unknowns in the witness solve and working their values
out again afterwards was built and checked (the values it gives meet every
row) and taken out: the rows that stay are those of dead slacks with
bounds, which forgetting cannot remove, so the tableau still peaks at 1,300
to 2,800 rows, and the solve was about 6 times slower and lost a run.
Leaving implied rows out, starting from the engine's own point, pivot-rule
sweeps and a floating-point solve checked exactly (2 of 5 recovered) did
not recover the failing runs either.

The cause is in the rows. Cross-clock comparisons at the extreme rates
(19/20, 21/20) compound, and the accepted rows need times far past any
concrete run. On one 474-unknown idioms run the rows admit no point with
every unknown below 2^45 ticks; witness values reach 3e16 and the online
engine's own point is as large. Taking out the four-term two-clock rows
alone removes the overflow. The same sizes explain crossclock's reading
overflows, its concessions without a point and its diverging
continuations. A horizon on time, the online engine refusing flips that
need times past about 2^40 ticks, would bound all of it; it changes which
behaviours a symbolic run can reach and is left to the owner.

### The horizon

Every time and open duration is now bounded by `H`, the largest global
time at which a concrete run still fits (plan 4.7). It comes from the clock
configuration and is 4.50e18 (2^61.96) on every dataset measured, since all
use `rho` 0.05.

**Witness and concession** (`confirm: all`, 320 checks each):

| Dataset | Replayed before | Replayed with the horizon |
|---|---|---|
| clean, recv_anchor, cached_flag, forms | 320 | 320 |
| idioms | 316 | 316 (2 witness overflows, 2 concessions) |
| crossclock | 269 | 282 |

- Conceded crossclock runs now replay past the concession in 17 of 39
  cases, up from 2 of 47. Unconceded crossclock runs replay in 265 of 281.
- No run ends in a reading overflow or a negative value after a concession.
- Idioms still misses the 0.99 target.

**Why idioms still fails.** A fixed, tighter `H` makes things worse:

| `H` | idioms replayed | crossclock replayed |
|---|---|---|
| 2^45 | 311 | 259 |
| 2^40 | 312 | 258 |

Witness overflows and infeasible witnesses both rise as `H` shrinks. The
remaining overflow is therefore the size of the fractions a long chain of
cross-clock rows builds in the witness solve (rates 19/20 and 21/20), not the
size of the times. The horizon cannot remove it. It stays open as risk 15.

**Z3 agreement.** Each log's horizon lines were asserted in Z3 too, so both
sides judged the same system:

| Dataset | Runs checked | Differences |
|---|---|---|
| clean, recv_anchor, cached_flag, forms | 3,200 each | 0 |
| idioms | 2,600 (Z3 hit the 3,600 s cap) | 0 |
| crossclock | under 200 (Z3 hit the cap) | none recorded |

Z3 is slower here because of the horizon's large constant.

**Reach.** Same protocol and seeds as phase 4. Results are in
`results/reach_horizon/` and `results/reach_sessions_horizon.txt`.

- **Refused flips are unchanged.** The share of drawn flips refused is:
  - cached_flag: 0.272 with the horizon, 0.274 without;
  - clean: 0.147, the same both ways;
  - recv_anchor: 0.125 with, 0.124 without.

  Horizon refusals are too few to show in these shares, so the horizon
  loses nothing real on the lease specs.
- **Confirmed violations:**

  | Spec | Drawn arm | Open arm |
  |---|---|---|
  | cached_flag | 35 (was 35) | 36 (was 31) |
  | clean | 0 | 0 |
  | recv_anchor | 3, the same runs as before | 4 |

  Every candidate replayed illegal, and no run conceded.
- **recv_anchor's open-arm runs.** The four are 2243085, 1005288, 368105
  and 976998. The last two are new, because the engine now takes different
  paths through the same exact answers. All come from the anchor mutation.
- **The cost.** The constant `H` does not fit the 64-bit tier's arithmetic,
  so almost every symbolic run on the lease specs now widens once, about
  0.6 widenings a run where there were none. As a result:
  - solver share rises from 0.04-0.07 to 0.11-0.14;
  - symbolic throughput drops 6% to 10%, to 10.5k-12.3k runs/s.

  This is a cost of the horizon as specified, recorded as a reading. An `H`
  that fits the narrow tier would avoid it, but it is not the clocks' range.

### The horizon, on the witness side only

The owner took the horizon out of the online engine. `H` now bounds only the
witness solve and the concession point. A witness that needs times past `H`
fails with reason `witness_past_horizon`. The 99% witness gate was dropped,
and the fraction growth on long cross-clock chains is accepted as a known
limit (plan 5(h), risk 15).

**Reach on the lease specs.** Drawn and open arms, seeds 1000 and 1001, two
300 s chunks each (`results/reach_horizon_witness/`). The figures match the
phase 5 run from before the horizon:

- Throughput: 13.0k to 13.2k runs/s drawn and 11.8k to 12.0k open.
- Solver share: 0.04 to 0.07. No run widens or concedes.
- The same confirmed violations as before:

| Spec | Drawn | Open |
|---|---|---|
| cached_flag | 35 | 31 |
| recv_anchor | 3 (2243085, 2919364, 1005288) | 3 (2243085, 2919364, 1005288) |
| clean | 0 | 0 |

- Every candidate replayed illegal.

**Phase 3 exit.** `confirm: all`, 320 checks each:

| Dataset | Replayed | Failures |
|---|---|---|
| idioms | 316 (0.9875) | 3 witness overflows, 1 concession |
| crossclock | 273 (0.853) | 28 witness overflows, 15 concessions, 4 divergences |

- No run ends in a clock overflow after a concession.
- Crossclock's conceded runs replay 6 of 47. Before the horizon it was 2 of
  47, and with the horizon in the engine 17 of 39.
- With the horizon in the engine, crossclock replayed 282. That count came
  from the online engine refusing flips past `H`, which no longer happens.
  Against the pre-horizon 269, the result is no worse.
- The four divergences come from runs that conceded off a witness. None is a
  wrong verdict.
