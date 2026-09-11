# Implementer instructions (hand to the implementer verbatim)

- The isolated worktree is usually cut from `main`, which predates the loop
  branches: `scheduler_configs/loop/` may be absent and the `spur` gitlink
  stale. First seed the subject from the loop branch and stage that base so
  later diffs show only the hypothesis edit:
  `git restore --source <loop branch> --staged --worktree -- scheduler_configs/loop spur`
  then `git submodule update --init spur` (verify `spur/Cargo.toml` exists
  afterwards).
- Implement exactly this hypothesis, at whatever size it needs and no
  bigger. Config gating is optional: changing default behavior is fine; add
  a config field only when the hypothesis calls for one. A new top-level
  config field must also be listed in `EXPLORER_CONFIG_KEYS`
  (`spur/spur-core/src/simulator/explorer.rs`), or configs with
  `strict_config_keys` set are rejected outright.
- Rust work lives in `spur/spur-core`; config work in
  `scheduler_configs/loop/`. If the mechanism must be enabled for
  evaluation, enable it in the templates the loop's configuration names -
  but never touch the `campaign` block of the campaign template.
- If the hypothesis declares a treatment bit, draw it by run id in
  `spur/spur-core/src/simulator/run_variant.rs` and register its name in
  `VARIANT_BITS` (`research/orchestrator/src/decide.ts`).
- If the hypothesis declares a counter, add it in
  `spur-core/src/simulator/util_stats.rs` so it reaches the utilization dump
  under the dotted path the hypothesis names. For a saving declared shared
  this counter is the primary reading, not a nicety.
- Build: `cargo build --release --manifest-path spur/Cargo.toml --bin spur`,
  always from the repository root and never with a working directory inside
  `spur/`. Run `cargo test -p spur-core` if spur-core logic changed.
- A short smoke run to confirm the change works and the counter moves is
  fine, writing to `tmp/loop/<name>`; its numbers are discarded. **No
  measurement of your own** - no A/B, no timing comparison, no seed sweep.
  A timing number measured in a worktree beside your own build and your own
  editor is worse than no number, and the grader's reading is the only one
  the loop records.
- No git commits, no gh, no network.
- MANDATORY export before finishing (the worktree may be cleaned): create
  `<project root>/tmp/loop/perf/<name>/` and copy into it the built binary as
  `cand-spur`, `git -C spur diff > spur.patch` (plus any untracked spur files
  under an `untracked/` mirror), `git diff > super.patch` for superproject
  changes, and any edited template. End with a summary: files changed, the
  config field if any, the counter if any, the cost the change removes, and
  any deviation from the hypothesis or plan you were given.
- Config-only hypothesis (no spur edit): skip the build and the smoke run;
  export the baseline binary `spur/target/release/spur` (main tree) as
  `cand-spur` and an empty `spur.patch`.
