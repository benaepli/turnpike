# Proposer constraints (hand to the proposer verbatim)

- Propose a few hypotheses through your lens. Size is not a constraint - a
  substantial mechanism is welcome - and config gating is not required: a
  change may replace default behavior outright. The bar is that the idea
  plausibly improves violation discovery per explore-second and generalizes
  to the full protocol panel (nothing VR-specific; the generalityArgument
  field carries this).
- Propose mechanism-level hypotheses: new scheduling behavior, new feedback
  signals, new fault-timing structure, adaptive switching among strategies,
  branching from checkpoints - changes to HOW the explorer searches. A
  priority or hold rule on some class of records is the cheapest shape and
  is not wanted unless the lens demands it. A parameter dose on an existing
  knob is worth proposing only as a follow-up to a merged mechanism or to a
  recorded observation that names that knob. Never propose measurement,
  census, or calibration work on its own; a mechanism that needs a new
  observable adds it.
- A nested dose or cell must have its own variant bit. A cell that is a
  pure function of the run id cannot be split by the grader, and the
  question it was meant to answer goes unanswered.
- Two overrides to the JSON guide: the description names the mechanism, and
  mentions a gating config field only if the change has one; firingCounter
  may name a counter the change itself adds, not only one the explorer
  already emits.
- Change only the subject: `spur/` or `scheduler_configs/loop/`. Never the
  harness, the orchestrator, the grader, the evaluation protocol, or the
  campaign arm set of `general_vr.json` (an arm change moves the unit of
  comparison and the grader refuses it).
- Every hypothesis carries a frozen prediction in the template below. The
  prediction is graded, never rewritten.
- Ship both sides of the mechanism inside the explorer: on for a
  randomized share of runs drawn by run id, off for the rest, and where
  the mechanism has a natural inverse, the inverse as a third cell. Tag the
  runs (`spur/spur-core/src/simulator/run_variant.rs`) and register each
  bit's name in `VARIANT_BITS` (`research/orchestrator/src/decide.ts`) in
  the same commit. The untreated share is the control the merge is decided
  on, and it is what lets the protocol panel show, per cell, that a
  mechanism which helps VR hurts another protocol. A mechanism that cannot
  be turned off per run can only be graded on the cross-binary rung, where
  only an effect well outside the build-layout floor separates.

## Frozen prediction template (all fields required)

- **Treatment bit**: `<name>` = `1 << k`, registered in `run_variant.rs`
  and `VARIANT_BITS`. Treated share: `<f>` of runs, drawn by run id. If the
  mechanism cannot be turned off per run, say so here and name the reason;
  the candidate is then graded on the cross-binary rung.
- **Rung and band**: on the epoch's primary rung (the grader prints which),
  the **per-run ratio** of treated to untreated runs in the same session,
  probe-free and matched on co-bits, will land in **[lo, hi]**. Choose a
  band you would be embarrassed to miss: its lower edge is the effect the
  mechanism must at least produce, and a band that includes 1.0 predicts
  nothing. (A per-run ratio, not a per-second figure: per-second mixes
  throughput with build-layout noise.)
- **Firing counter**: `<dotted.path>` in `utilization.json` at or above
  `<floor>` per chunk.
- **Independent observable**: `<something the rung does not measure>`,
  expected `<value>`.
- **Falsifier**: the prediction is refuted if the contrast's interval lies
  entirely below the band's lower edge, or if `<observable>` moves the
  wrong way. State the sign explicitly; "no effect" is refutation only if
  the band's lower edge is above 1.
- **Cost clause**: cross-binary throughput will stay at or above `<floor>`
  of the paired baseline; a shared hot-path cost is invisible to the
  contrast and must be read there.
