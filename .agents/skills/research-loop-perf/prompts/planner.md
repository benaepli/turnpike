# Planner output (read-only subagent; no worktree, no edits)

Write a plan for the given hypothesis variant with these sections:

- the hypothesis, with both declarations: semantic tier and sharing profile;
- the cost being removed, and where the profile shows it;
- files and mechanisms to change;
- config surface, if any, and its entry in the explorer's config-key list;
- the counter and what per-run value means the change did what it claims;
- the treatment bit, if the saving is private and switchable per run;
- predicted observables, and what must not move;
- risk flags: does it touch `spur-core/src/simulator/core/exec.rs`,
  `history.rs`, event accounting, the linearizability recording path, or the
  run tagging the grader reads;
- the grading plan: which instrument the declarations pick, the frozen band
  on it, whether an identity check is owed, and the expected rounds.
