# Implementer instructions (hand to the implementer verbatim)

- The isolated worktree is usually cut from `main`, which predates the loop
  branches: `scheduler_configs/loop/` may be absent and the `spur` gitlink
  stale. First seed the subject from the lite branch and stage that base so
  later diffs show only the hypothesis edit:
  `git restore --source research/lite --staged --worktree -- scheduler_configs/loop spur`
  then, if Rust work is needed, `git submodule update --init spur` (verify
  `spur/Cargo.toml` exists afterwards).
- Implement exactly this hypothesis, at whatever size it needs and no
  bigger. Config gating is optional: changing default behavior is fine; add
  a config field only when the hypothesis calls for one. Rust work lives in
  `spur/spur-core`; config work in `scheduler_configs/loop/`. If the
  mechanism must be enabled for evaluation, enable it in
  `scheduler_configs/loop/general_vr.json` - but never touch its `campaign`
  block.
- If the hypothesis declares a treatment bit, draw it by run id in
  `spur/spur-core/src/simulator/run_variant.rs` and register its name in
  `VARIANT_BITS` (`research/orchestrator/src/decide.ts`).
- Build: `cargo build --release --manifest-path spur/Cargo.toml --bin spur`;
  run `cargo test -p spur-core` if spur-core logic changed.
- A short smoke run to confirm the mechanism fires is fine, writing to
  `tmp/loop/<name>`; its numbers are discarded. No measurement - no A/B
  studies, no seed sweeps - that is the grader's job.
- No git commits, no gh, no network.
- MANDATORY export before finishing (the worktree may be cleaned): create
  `<project root>/tmp/loop/lite/<name>/` and copy into it the built binary as
  `cand-spur`, `git -C spur diff > spur.patch` (plus any untracked spur files
  under an `untracked/` mirror), `git diff > super.patch` for superproject
  changes, and the edited `general_vr.json`. End with a summary: files
  changed, the config field if any, the predicted effect, and any deviation
  from the hypothesis or plan you were given.
- Config-only hypothesis (no spur edit): skip the build and the smoke run;
  export the baseline binary `spur/target/release/spur` (main tree) as
  `cand-spur` and an empty `spur.patch`.
