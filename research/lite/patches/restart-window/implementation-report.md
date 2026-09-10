# restart-window: implementation report

Hypothesis `restart-window-queue-shape-switch` (iteration 74), candidate
`restart-window`. Submodule base b86baad3f94ce14dbdf20688b61fd92317a75cc2.

## What was built

A `WindowedSelector` (spur-core/src/simulator/core/queue_selector.rs) wraps
the configured stock queue selector in `path.rs` `exec_plan`. A restart
window opens for a node when `exec_plan` observes `ScheduleResult::Recover`
for it and closes when the node has taken 8 handler entries since its
restart (`State::entries_since_restart`) or 96 selection steps have passed
since the opening step, whichever comes first; windows of several nodes
union. Windows are tracked on every cell so the census is comparable; only
the two treated cells change a selection.

Cells (`restart_window::cell`, salt `WINDOW_SALT` = "RSTWINDO",
`salted_phase(run_id, WINDOW_SALT, 4)`): phases 0 and 1 stock; phase 2
local-drain, bit `RESTART_WINDOW_LOCAL_DRAIN` = 1<<16; phase 3
network-heavy, bit `RESTART_WINDOW_NET_HEAVY` = 1<<17. Run-cap probes and
timer-context probes are on the stock cell (both exemptions, as
`pair_order::is_treated` does). The bits are joined into `run_variant::of`
and `run_variant::from_run_id`; VARIANT_BITS rows 65536 and 131072 were
renamed `restartWindowLocalDrain` and `restartWindowNetHeavy`.

Every step, on every cell, the wrapped stock selector makes its own
selection first (drawing the stock roll on `Stream::QueueChoice`). Outside a
window that selection stands. Inside a window:

- stock cell: the stock selection stands; the step is only counted;
- treated cells: if the stock selection is the timer, the timer is taken -
  the timer decision is the wrapped selector's `select_timer_biased` with
  the forwarded timer-context bias (the `implementerMustDefine` clause);
  otherwise the cell's shape replaces the selection, drawing on the new
  `Stream::WindowShape` (Stream::COUNT 8 -> 9):
  - local-drain: forced network pull once 16 local steps have passed since
    the last pull, else the active node's local queue while it has items,
    else a new active node: the most recently restarted node inside its
    window with a non-empty local queue, else the stock size-weighted pick;
    then network, then timer as fallbacks. Opening a window drops the
    active node so the next local pick falls on the restarted node's queue.
  - network-heavy: one roll on `Stream::WindowShape` against p_local 0.5
    between local (size-weighted) and network, with the stock fallbacks.

The scheduler's selection site now calls one trait method,
`QueueSelector::select_streamed(info, Option<bias>, &mut impl StreamRng)`,
whose default forwards to `select`/`select_timer_biased` exactly as the
previous three-arm dispatch did; the `util_stats` timer-context records at
that site are unchanged. `ProbabilisticSelector::try_select` became the free
function `select_from` so the network-heavy shape can share it.

Stock-preemptive runs: when the configured policy is already `Preemptive`,
the window applies the same way over that selector's selection (its timer
draw is the timer decision; inside a window on the local-drain cell the
window's own 16-step interval and active-node state replace the stock
preempt interval, on the network-heavy cell the 0.5 roll replaces its
active-node drain). They are counted under
`restart_window.stock_preemptive_runs` by cell so the contrast can be read
on the Probabilistic majority.

## Counter block `restart_window` (util_stats.rs)

All by cell (`stock`, `local_drain`, `net_heavy`): `runs`,
`stock_preemptive_runs`, `windows_opened`, `window_steps`,
`steps_group_changed`, `closed_by_entries`, `closed_by_steps`,
`restarted_local_steps`. Firing counter:
`restart_window.window_steps.local_drain`. Counters reset with
`util_stats::set_enabled(true)`; the block reaches the rendered
utilization JSON and the difference/accumulate path
(`tests/util_stats_export_completeness.rs` extended).

Definition choice: `steps_group_changed` compares the full selection, so a
switch from one node's local queue to another node's local queue counts as
a change. The category-only reading would hide the local-drain shape's
main lever (which local queue is served): on the smoke run the
category-only count was 54k of 646k local-drain window steps, the
full-selection count is 91k of 622k.

## Files changed

Submodule `spur` (spur.patch, plus untracked/ mirror):
- spur-core/src/simulator/restart_window.rs (new): salt, cell assignment,
  limits, cell tests.
- spur-core/src/simulator/core/queue_selector.rs: `select_streamed` trait
  method, `select_from`, `WindowedSelector`, `PartialEq` on
  `QueueSelection`, nine tests.
- spur-core/src/simulator/core/scheduler.rs: selection site calls
  `select_streamed`.
- spur-core/src/simulator/path.rs: wraps the selector, records the run's
  cell, advances windows each step, opens a window on `Recover`.
- spur-core/src/simulator/rng.rs: `Stream::WindowShape`, COUNT 9.
- spur-core/src/simulator/run_variant.rs: the two bits,
  `restart_window_bits`, joined in `of` and `from_run_id`; tests extended
  plus one new test.
- spur-core/src/simulator/util_stats.rs: the block, record functions,
  reset, snapshot field, one test.
- spur-core/src/simulator.rs: module registration.
- spur-core/tests/util_stats_export_completeness.rs: the block's marks and
  leaves.

Superproject (super.patch): research/orchestrator/src/decide.ts VARIANT_BITS
rename only, plus the submodule pointer line. `general_vr.json` unchanged.
No config field.

## Tests

`RUST_MIN_STACK=33554432 cargo test --manifest-path spur/Cargo.toml -p spur-core`:
467 passed, 0 failed over all test binaries (test.log; the per-binary
result lines are appended below). New tests: stream isolation on an
untreated run (byte-identical selections and identical next draw on both
streams, isolated and shared), treated cells leave the queue-choice stream
untouched under isolation and draw on the window-shape stream, window
close on entry limit and step limit, union over several nodes and reopen,
timer bias inside a window on both treated cells (0.10 -> 0.40 at bias 4,
0 at bias 0) and the preemptive-stock timer share, local-drain shape
(restarted node drained, network pull every 16 local steps, most recently
restarted node preferred, stock pick when the restarted queues are empty,
stock selection after close), network-heavy shares (0.485/0.485/0.03),
counters through the selector API, counters through the exported snapshot,
probe exemption and quarter split, cell independence from the fresh-first
salt, tag bits agree with the cell and spare every probe.

## Smoke run (30 s wall budget, general_vr.json unchanged, override on the command line)

restart_window block (smoke_restart_window.json), 46592 runs:
- runs: stock 24623, local_drain 10802, net_heavy 11167
- stock_preemptive_runs: 592 / 267 / 241
- windows_opened: 40638 / 17542 / 18704
- window_steps: 1450640 / 621696 / 632265
- steps_group_changed: 0 / 91282 / 337524
- closed_by_entries: 26329 / 11121 / 13146
- closed_by_steps: 7411 / 3392 / 2671
- restarted_local_steps: 236569 / 106548 / 84899

Run tags (smoke_run_tags.json via traceanalyzer -runs): 10802 runs carry
bit 65536 and 11167 carry bit 131072, equal to the block's `runs` on those
cells; no run carries both; no probe carries either.

## Predicted effect

Per the frozen prediction: depth>=8 per-run ratio of the local-drain cell
to co-bit-matched stock runs in [1.08, 1.30], network-heavy in
[0.80, 0.98]; `restart_window.window_steps.local_drain` well above the
2,000,000 per-chunk floor at the smoke rate (about 620k per 30 s).

## Discrepancies and observations (numbers are for context only)

- `steps_group_changed.local_drain` on the smoke was 91k per 30 s, so the
  500,000 per-chunk clause depends on the chunk length; the category-only
  reading would have been lower still (54k). The stock roll and the
  local-drain shape agree on most window steps because p_local is high.
- `restarted_local_steps / windows_opened` on the smoke: stock 5.8,
  local_drain 6.1, net_heavy 4.5. The 1.5x observable is not met on the
  smoke; the red-team note (the restarted node's post-restart local segment
  is short, so the drain falls to the stock pick) looks relevant. This is
  reported, not acted on.
- Stock-preemptive share: the hypothesis says about 20 percent
  (SingleRunConfig::random). On general_vr.json only 2.4 percent of runs
  are stock-preemptive (592 of 24623 on the stock cell): the grid explorer's
  runs take the configured queue policy (general_vr.json sets none, so the
  default Probabilistic p_local 0.80, p_timer 0.03), and only the AOS
  explorer's seeded runs draw SingleRunConfig::random with its 20 percent
  Preemptive mix.
- Window span: closes when `step - opened_step > 96`, so a window covers
  the 96 selection steps after the recover step; the recover step's own
  selection precedes the open.
- On a run without stream isolation the window-shape draws share the single
  generator; general_vr.json has `rng_stream_isolation: true`, and the
  smoke reported 46592 isolated runs, 0 shared.

## Verbatim test result lines (test.log)

```
     Running unittests src/lib.rs (spur/target/debug/deps/spur_core-9af36a882a6b8e09)
test result: ok. 426 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.64s
     Running tests/campaign_allocation.rs (spur/target/debug/deps/campaign_allocation-70b962263207857a)
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 9.40s
     Running tests/client_anchor_release.rs (spur/target/debug/deps/client_anchor_release-0a966977ea693295)
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.56s
     Running tests/compiler_integration.rs (spur/target/debug/deps/compiler_integration-7681a66586dcc063)
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
     Running tests/config_override_effect.rs (spur/target/debug/deps/config_override_effect-0c074256bc9264fb)
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
     Running tests/crash_census_landing.rs (spur/target/debug/deps/crash_census_landing-f89420895a45e309)
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.11s
     Running tests/crash_phase_anchor.rs (spur/target/debug/deps/crash_phase_anchor-5e744325a5154bbc)
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.31s
     Running tests/fresh_first_dispatch.rs (spur/target/debug/deps/fresh_first_dispatch-ea23cd0d3a439333)
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.22s
     Running tests/ghost_absorber_retarget.rs (spur/target/debug/deps/ghost_absorber_retarget-7ac8643b10b0718c)
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.15s
     Running tests/map_iteration_identity.rs (spur/target/debug/deps/map_iteration_identity-fab470e89408d651)
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s
     Running tests/message_order_probe.rs (spur/target/debug/deps/message_order_probe-09b9043c99fa910f)
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running tests/pair_order_dispatch.rs (spur/target/debug/deps/pair_order_dispatch-dcf64536cb1348cb)
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.22s
     Running tests/refinement_diagnostics.rs (spur/target/debug/deps/refinement_diagnostics-817ed8993f92fdd3)
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running tests/refinement_types.rs (spur/target/debug/deps/refinement_types-da920988b5b0996d)
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running tests/replay_prefix_fidelity.rs (spur/target/debug/deps/replay_prefix_fidelity-a851efc09f1a8ca9)
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.15s
     Running tests/run_cap_exit.rs (spur/target/debug/deps/run_cap_exit-90b2025766e9a4b0)
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
     Running tests/stats_export_parity.rs (spur/target/debug/deps/stats_export_parity-2ac3c55b59b1b46e)
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s
     Running tests/steer_authority_wiring.rs (spur/target/debug/deps/steer_authority_wiring-b5eaef0c7537a8dd)
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
     Running tests/steer_decision_site_reachability.rs (spur/target/debug/deps/steer_decision_site_reachability-6ffcfb5a3a6d9812)
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.48s
     Running tests/steer_terms_fire.rs (spur/target/debug/deps/steer_terms_fire-6d0415c7e7603eda)
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.07s
     Running tests/steer_terms_identity.rs (spur/target/debug/deps/steer_terms_identity-236f77dbd6e15352)
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.06s
     Running tests/timer_effects.rs (spur/target/debug/deps/timer_effects-730b25933cc6747d)
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
     Running tests/util_stats_export_completeness.rs (spur/target/debug/deps/util_stats_export_completeness-517d4cb8def6ce11)
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
     Running tests/wall_budget.rs (spur/target/debug/deps/wall_budget-519837c5b88dc2db)
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 4.12s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```
