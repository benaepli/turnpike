# Proposer constraints (hand to the proposer verbatim)

- Propose a few hypotheses through your lens. Size is not a constraint - a
  substantial change is welcome - and config gating is not required: a change
  may replace default behavior outright. The bar is that the idea removes a
  cost you can name from the explorer's hot path, and that it does so at
  equal search: the gain must be work not done, never work done differently.
- Your primary input is the profile. Name the symbol or the structure the
  cost lives in, say what the cost is, and say what removes it. A hypothesis
  that cannot name where the cost is measured is not ready to propose.
- A change whose point is to search differently belongs to the search loop,
  whatever it does to the clock. A change that alters the search as an
  unavoidable side effect of removing cost is admissible, declared as such.
- Never propose measurement, census, or profiling work on its own; a change
  that needs a new counter adds it in the same commit.
- Change only the subject: `spur/` or `scheduler_configs/loop/`. Never the
  harness, the orchestrator, the grader, the evaluation protocol, or the
  campaign arm set of the campaign template (an arm change moves the unit of
  comparison and the grader refuses it).
- A dependency is part of the subject: adding one, dropping one, or swapping
  one for a faster equivalent is a legitimate hypothesis. A dependency that
  can change any container's iteration or ordering - hashers, map and set
  types above all - changes the schedule, so it declares search-affecting
  unless you can argue that it cannot.
- Every hypothesis carries a frozen prediction in the template below,
  including both declarations. The prediction is graded, never rewritten.

## Lenses

Rotate one per round:

- **Allocation and memory traffic**: heap traffic per run or per step,
  short-lived buffers, clones on paths that could borrow, growth strategies,
  the size and layout of the objects the hot loop touches.
- **Data layout and representation**: the shape of the structures the hot
  loop walks - maps where a vector would do, indirection that costs a cache
  miss per step, fields carried per event that nothing reads.
- **Redundant work per step**: work repeated per step that could be done per
  run or per session, recomputation of something already known, checks whose
  answer cannot have changed, formatting and bookkeeping that is not read.
- **Contention and parallelism**: locks, shared counters, false sharing,
  per-thread state, work partitioning across the run set, the writer path.
- **Algorithmic**: a cheaper way to compute the same answer - a better data
  structure, an earlier exit, a bound that prunes work the current code does
  and then discards.

## Frozen prediction template (all fields required)

- **Search declaration**: `neutral` | `affecting`. Neutral claims the change
  does not alter what the explorer searches - say what it permutes or drops,
  and argue the search never relied on it. If what changes is the order
  random draws are consumed in, the claim is wrong. The claim is guarded by
  a distributional check on steps per run, end reasons and per-arm counts
  against the baseline's own round-to-round spread, and a reading outside
  that spread closes the candidate. Affecting admits the search moves, and
  owes the search loop's non-inferiority reading and its panel.
- **Sharing profile**: `private` | `shared`, with an argument, not a
  checkbox. Say what the cost is and why it does or does not travel between
  runs inside one process. Allocator pressure, memory bandwidth, cache
  footprint, a global structure and thread-pool contention all travel.
  Unsure is shared: a wrong call toward private credits noise as a win.
- **Treatment bit** (private savings only): `<name>` = `1 << k`, registered
  in `run_variant.rs` and `VARIANT_BITS`, drawn by run id, treated share
  `<f>`. A private saving that cannot be switched per run says so and names
  the reason; it is then read cross-binary against the layout floor.
- **Counter** (shared savings, and welcome anywhere): `<dotted.path>` in the
  utilization dump, with the per-run value the mechanism predicts. This is
  the primary for a shared saving, so the change adds the counter if the
  explorer does not already emit it.
- **Band**: the primary reading will land in **[lo, hi]** as a speedup ratio.
  Choose a band you would be embarrassed to miss: its lower edge is the
  saving the change must at least produce, and a band that includes 1.0
  predicts nothing. State it against the noise floor the instrument owes -
  for a cross-binary reading that is the layout floor, which is larger than
  most real savings.
- **Independent observable**: `<something the primary does not measure>`,
  expected `<value>`.
- **Falsifier**: the prediction is refuted if the primary's interval lies
  entirely below the band's lower edge, if a `neutral` declaration's spread
  check reads outside the baseline's own spread, or if `<observable>` moves
  the wrong way. State the sign explicitly.
- **Cost clause**: what this change may not do - steps per run, end reasons
  and per-arm counts hold their distributions, and runs per second does not
  separate downward.
