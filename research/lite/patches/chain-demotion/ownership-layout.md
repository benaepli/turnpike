# Ownership and layout

The candidate keeps one fixed `ChainState` per simulator state. Its measured size is 688 bytes, including root counters, private seed, activation/cap fields, two change points, two demotion slots, dispatch observation state, 128 fixed u32 length bins and four readiness counters for each dispatch category. It owns no Vec, map, set, Box, tape, ancestry graph, per-step log or other backing allocation. Ordinary runs allocate roots and propagate one u64 on executable objects. Ranking is active only in an actual filled prefix child after its own signal and source exhaustion.

The ordinary firing smoke reported `max_run_owned_bytes=688`, `run_dynamic_capacity_bytes=0`, `max_retained_demotion_entries=2`, and zero missing-ancestry roots. The allocated demotion capacity is two whether or not either point is reached. Counts and histograms are not truncated when their diagnostic population qualifies; only run length is binned, with the last bin explicitly meaning >=32.

| Representation | Baseline bytes | Candidate bytes | Growth |
| --- | ---: | ---: | ---: |
| Record | 240 | 248 | 8 |
| Runnable, including ChannelSend | 240 | 248 | 8 |
| Partition QueuedMessage | 256 | 264 | 8 |
| RunAttribution | 32 | 32 | 0 |

The object measurements are identical under NoHashing and WithHashing. The layout test uses exact original fields and enum variants without chain IDs as the baseline mirrors, compiled alongside the tagged types. Rust repr and alignment remain ordinary. This measures added layout directly without acquiring a baseline run or using the warm build cache as baseline evidence. The mirror definitions are in `core/state.rs::chain_layout_tests`; the focused log prints all six comparisons.

Selector scratch also remains fixed: WithinPick is 24 bytes, FreshPreview is 40, the optional best ranked candidate is 56, and optional first-chain/shadow indices are 16 each. These are temporary scalar values, not retained run allocations or dynamic per-chain storage. The independent mirror probe is retained as `layout-scratch.rs`; its RunAttribution mirrors both measure 32 bytes. Neither chain comparison nor shadow preference preview allocates a sample list, clones simulator state, or makes an RNG draw. The existing candidate/eligibility storage remains stock. Global utilization tables have fixed dimensions and aggregate across runs; none stores individual run objects.

Source propagation preserves Record metadata through async/sync calls, waiting readers, continuations, delays, crash reset/redelivery, partition buffering and healing. Ordinary channel wakeups retain the waiting reader chain. Timer wakeups assign a new root to an actually resumed reader; a buffered unit value consumed by an already executing record has no ancestry transfer. Inline recovery Record execution updates the most recently executed chain for demotion while the enclosing fault still ends a dispatch stretch.

Tests cover pure shadow preference preview with one actual displacement commit; identical stock candidate draws and same-chain ties; non-executable stock winner preservation; proportional and singleton exclusions; queue-class and empty-fallback draw parity; source exhaustion versus output position; exact minimum-cap point domain; repeat/no-chain points; metadata and hashing through crash/partition/channel/timer paths; short-dispatch qualification; final censored stretches; reset; all exported numeric leaves through render/delta/accumulation. All 471 tests passed across 25 unit/integration/doc suites with the required RUST_MIN_STACK=33554432 command. Existing unrelated compiler warnings remain.

The single smoke only checked firing. Its one-second runtime budget was a command-line override; the exported general_vr.json and its campaign block are byte-identical to main. No performance, applicability/supply, utility, linearizability or memory-RSS inference is drawn from it. No efficacy experiment, baseline acquisition, protected-source edit, network action or commit was performed.

The explicit sampled distinct-chain histogram uses exact categories zero, one, and two-or-more. It retains no sampled chain list, so the >=2 authority denominator is exact within the storage bound. This histogram was added after the sole firing smoke; the final full tests and release build cover it. The smoke binary hash and its source-patch hash are retained separately in implementation.json.
