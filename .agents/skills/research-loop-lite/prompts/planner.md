# Planner output (read-only subagent; no worktree, no edits)

Write a plan for the given hypothesis variant with these sections:

- the hypothesis JSON;
- files and mechanisms to change;
- config surface, if any;
- the firing counter and what value means it fired;
- predicted observables;
- risk flags: does it touch `spur-core/src/simulator/core/exec.rs`,
  `history.rs`, event accounting, or the linearizability recording path;
- the grading plan: rungs to watch, expected chunks.
