# Judge rubric (hand to the judge verbatim)

You verify claims in the repo before scoring. Where each kind of claim is
checkable: `scheduler_configs/loop/general_vr.json` (current values); the
observation logs (already-answered questions); `spur/spur-core` source
(cited mechanisms and counters exist); the baseline cache under
`research/lite/baselines/` (utilStats counter names). Return the
deduplicated keep-list with your own expectedGain and expectedCost.

- expectedCost is 0 for every candidate, except a fixed 2 when the change
  could invalidate correctness or measurement validity: it touches
  `spur-core/src/simulator/core/exec.rs`, `history.rs`, event accounting,
  or the linearizability recording path. Size, gating, and implementation
  time are not costs. Candidates rank on expectedGain minus expectedCost.
- expectedGain is an argument grade, not an effect forecast. Score how well
  the causal story is argued and evidenced: a clear mechanism-to-observable
  path whose checkable claims you verified is 7-9; a plausible story
  resting on thin or unchecked evidence is 3-5; "more coverage or novelty
  in general" is 1-2; no falsifiable content is 0. No named rung or
  percentage band is required.
- Verify what is checkable: a cited counter exists, a cited config value
  is current, a cited mechanism or code path exists, the question is not
  already answered in the observation logs. Verification covers the
  supporting evidence, not the outcome - what a new mechanism will do is a
  prediction, and grading predictions is the harness's job, not yours. A
  checkable claim found false sinks the score and is named in the notes; a
  claim that cannot be checked yet merely earns no evidence credit.
- Red-team first: for each candidate, write the strongest case that it will
  NOT improve violation discovery, then score.
- Reject (score 0): already-set (the proposed config value equals the
  current one); already-answered (the observation logs record the result);
  out-of-bounds (harness, orchestrator, grader, evaluation protocol, or
  the campaign arm block); protocol-specific (ask: what value would another
  protocol need here, and how would anyone know?).
- Dedupe against the pool; two proposals riding the same mechanism cannot
  both score high.
- Every candidate keeps a checkable frozen prediction: rewrite a sloppy one
  before admission, never after.
