# Host Compatibility: Claude vs. Codex

The canonical skills live in `.agents/skills/`; Claude discovers them through
symlinks in `.claude/skills/`. Skill workflow text is host-neutral except where
a tool mechanic has no cross-host name; those mechanics map as follows.

## Skill invocation

- Claude: slash command, e.g. `/debug-protocol`, or the Skill tool.
- Codex: explicit `$skill-name` invocation, e.g. `$debug-protocol`. Skills are
  discovered from `.agents/skills/` (each directory's `SKILL.md` carries `name`
  and `description`).
- Inputs are the named items in each skill's Inputs section; neither host
  passes shell-style positional arguments.

## File operations

- Claude: Read/Write/Edit tools.
- Codex: shell commands and apply-patch equivalents. Behavior must be the
  same: read a file before modifying it, prefer targeted edits over rewrites.

## Subagents

- Claude: the Agent tool spawns proposer/judge/implementer/planner subagents
  with their own context; skills that say "spawn a subagent" mean this.
- Codex: use Codex-native subagents if available. If not, execute the roles
  sequentially in the current session, one role at a time, keeping each role's
  inputs and outputs as the skill describes (e.g. the judge still scores
  candidates blind to origin marks).

## Worktree isolation

- Claude: the Agent tool's `isolation: "worktree"` gives the implementer an
  isolated checkout.
- Codex: create a per-hypothesis Git worktree under `tmp/loop/` (e.g.
  `git worktree add tmp/loop/wt-<name> main`), work there, and remove it with
  `git worktree remove` + `git worktree prune` afterwards. The export
  directory contract (`tmp/loop/lite/<name>/`) is unchanged: the worktree may
  not outlive the iteration, so exports are mandatory either way.

## Monitor stopping

- Claude: background monitor tasks are stopped with `TaskStop`.
- Codex: kill monitor processes by PID after verifying with `ps` that the
  PID is the monitor. Never assume a process died; check. A grader stopped
  this way releases `tmp/loop/measuring.lock` on SIGINT, SIGTERM and SIGHUP;
  after SIGKILL the next measuring command reclaims it.

## Commit attribution

- Claude: loop commits keep the existing Claude trailers
  (`Co-Authored-By` / session links) as the research-loop skills specify.
- Codex: loop commits use normal repository attribution (the configured
  git user). Do not invent Claude-specific trailers.
