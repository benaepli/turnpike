# Performance Goal

Make the Spur explorer faster: more runs per second at a fixed thread count,
by removing cost from the simulator (`spur/spur-core/src/simulator/`) and its
supporting crates - never by changing what the search does.

Success = a merged change that raises runs per second on the campaign
workload named in `research/perf/perf.json`, at a fixed thread count. That
workload is wall-budgeted and its allocator and learners adapt as it runs, so
the goal is a noisy instrument: the per-run counter a change names is the
sharper read, and the layout floor guards wall time.

## Core ideas

**Throughput multiplies every other result.** Every rare-event objective in
this repository is a per-run probability times runs per second, so a saving
here is carried by every search the explorer will ever run. That is also the
trap: a gain bought by searching differently is not a saving, it is a change
of subject.

**Wall time is ground truth; a counter is the sharper read.** Wall time is
the objective and it is a noisy instrument. The counter a change claims to
move - allocations, instructions, steps, bytes - is the read that says the
mechanism did what it claimed. A win nobody can explain through such a
counter is a suspect win, and a mechanism that counts nothing cannot be told
apart from one that never ran.

**Declare whether the change touches the search at admission, and freeze it
there.** Failing your own declaration closes the candidate: that is a refuted
prediction, which is information, not an obstacle.

- *Search-neutral.* The change is claimed not to alter what the explorer
  searches. Owes a written argument saying why - which collection it
  permutes or which work it drops, and why the search never relied on it -
  and is guarded by a distributional check against the baseline's own
  round-to-round spread, read on high-count observables: steps per run, end
  reasons, per-arm counts, never rare events. A check that reads outside
  that spread refutes the declaration. The trap: if what changed is the
  order random draws are consumed in, choices correlate with the new order
  and the change is not neutral.
- *Search-affecting.* The candidate admits it alters the search. Owes the
  search loop's non-inferiority reading and its protocol panel, recorded in
  the log before a merge. The spread check is still reported there, as
  description rather than as a gate.

**Declare the sharing profile at admission; it picks the instrument.** Both
halves of one session share an allocator, a cache hierarchy, a memory bus and
a thread pool. A saving that travels between runs makes the untreated half
faster too, so the within-binary contrast reads flat exactly when the
mechanism works. There is no default instrument.

- *Private saving* - the cost is paid by the run that takes it and does not
  travel. Primary is the within-binary contrast: draw a treatment bit by run
  id and read the treated and untreated runs of one binary, which share a
  build layout and meet the same contention.
- *Shared saving* - the cost travels: allocator pressure, memory bandwidth,
  cache footprint, a global structure, thread-pool contention. The
  within-binary contrast is invalid there, not merely weak. Primary is a
  per-run counter the change names, and wall time is confirmation, read
  cross-binary against the layout control. The counter usually does not
  exist yet; adding it is part of the same change.
- *Unsure* - treat as shared. A wrong call toward private credits noise as a
  win; a wrong call toward shared costs a slower reading of a real one.

**Read microseconds per run and steps per run separately.** Never fuse them
into microseconds per step: steps are a denominator the change can move, so
the fused ratio improves when runs get longer and cheaper. Steps per run
holding its distribution is itself part of the search-neutral guard, so the
wall reading there is microseconds per run; where the search moves, neither
reading is clean and the read falls back to the cross-binary rate.

**Every cross-binary read needs the layout control.** Two builds of identical
source differ on the per-second rung by more than many real savings, and
interleaving does not remove it. The baseline commit built a second time in a
separate directory, measured, and its spread is the floor a cross-binary gain
must clear.

## Boundaries

Protected, never edited by research iterations: `bin/spur/**` (protocol
specs), `porcupine/**`, `research/oracle/**`, `research/corpus/**`,
`scheduler_configs/**` outside `loop/`. The measurement harness is not the
subject: changing the graders or the loop machinery is operator work, not a
hypothesis.

**Search quality can only block, never credit.** A candidate may not claim a
gain that comes from searching differently; its gain must be cost removed at
equal search. A change that alters the search as an unavoidable side effect
of removing cost is admissible, declared search-affecting, where the
non-inferiority reading is the price of admission and never a source of
credit. A candidate whose point is to search differently belongs to the
search loop, whatever it does to the clock.
