# Judge rubric (hand to the judge verbatim)

You verify claims in the repo before scoring. Where each kind of claim is
checkable: the profile under `research/perf/profiles/` (the cost is where the
candidate says it is); `spur/spur-core` source (the cited function, structure
or allocation exists and is on the hot path); the observation log
(already-answered questions); the utilization dump (whether a cited counter
already exists). Return the deduplicated keep-list with your own
expectedGain and expectedCost.

- expectedCost is 0 for every candidate, except a fixed 2 when the change
  could invalidate correctness or measurement validity: it touches
  `spur-core/src/simulator/core/exec.rs`, `history.rs`, event accounting, the
  linearizability recording path, or the run tagging the grader reads. Size,
  gating, and implementation time are not costs. Candidates rank on
  expectedGain minus expectedCost.
- expectedGain is an argument grade, not an effect forecast. Score how well
  the causal story is argued and evidenced: a named cost, a named place it is
  paid, and a mechanism that removes it, with the checkable claims verified,
  is 7-9; a plausible story resting on thin or unchecked evidence is 3-5;
  "this function looks slow" is 1-2; no falsifiable content is 0. The size of
  the cost matters: a cost you can explain and that the profile shows to be
  large outranks a well-argued saving on something small.
- **Audit the sharing profile. This is your load-bearing job.** A candidate
  declared private whose saving actually travels between runs will be graded
  on an instrument that cannot see it, and a small positive reading there is
  noise credited as a win. Ask: does the cost removed leave the process
  faster for every run, or only for the run that takes it? Allocator
  pressure, memory bandwidth, cache footprint, a shared structure and
  thread-pool contention all travel. If the answer is not clearly private,
  say so and rewrite the declaration to shared before admission.
- Audit the search declaration the same way. A `neutral` claim must name what
  the change permutes or drops and argue the search never relied on it; if
  what changes is the order random draws are consumed in, the claim is wrong
  and the declaration is `affecting`. A claim the candidate cannot argue in
  writing is not `neutral`.
- Verify what is checkable: the cited symbol or structure exists, the cited
  profile line says what the candidate says it says, the cited counter exists
  or is added by the change, the question is not already answered in the
  observation log. Verification covers the supporting evidence, not the
  outcome - what a change will do to the clock is a prediction, and grading
  predictions is the harness's job, not yours. A checkable claim found false
  sinks the score and is named in the notes; a claim that cannot be checked
  yet merely earns no evidence credit.
- Red-team first: for each candidate, write the strongest case that it will
  NOT make the explorer faster - the cost is not where the profile suggests,
  the saving is smaller than the floor the instrument owes, the compiler
  already does it, the work reappears elsewhere - then score.
- Reject (score 0): a candidate whose gain comes from searching differently
  rather than from work not done; out-of-bounds (harness, orchestrator,
  grader, evaluation protocol, or the campaign arm block); a measurement,
  census or profiling task with no mechanism attached; already-answered.
- Dedupe against the pool; two proposals removing the same cost cannot both
  score high.
- Every candidate keeps a checkable frozen prediction with both
  declarations: rewrite a sloppy one before admission, never after.
