# panel-per-cell-read

The panel subcommand (`research/lite/grader.ts`, `cmdPanel`) reports one violation count per member. Every merged ordering mechanism is a salted per-run arm, so a bias toward or against a member's bug averages out inside that count. This plan makes the panel report violations and runs per variant cell per member, matched the way the grader's internal primary is.

## 1. What is measured

Per member and per registered treatment bit, the per-run violation rate on the treated and untreated runs of that member's corpus, the ratio, and a 2.7-sigma log-ratio interval, plus raw counts.

Bits. The checked-out simulator (`spur` submodule 327bf72, `spur/spur-core/src/simulator/run_variant.rs`) tags only these id bits: 1 crashPlaced, 2 runCapProbe, 4 timerSteerOff, 8 crashHoldDrawn (outcome), 9 crashPhase, 15 pairSendOrder, 18 clientFanoutRelease (the post-fault deferral; `client_anchor.rs` has `EXPIRY_STEPS = 32` in this checkout, so confirm the 64-step merge's submodule pointer before the first read), 19 ghostAbsorberRetarget, 24 freshFirstPair, and 20/21 replay (grid-arm only; the panel drops `campaign`, so these never appear). `VARIANT_BITS` in `research/orchestrator/src/decide.ts` also lists 23, 27, 28 and other retired bits; `variantBitsMissingFromSource()` names them and the panel skips any bit with zero treated runs. Excluded from the cell table: 2, 4, 8 (`NON_DECLARABLE_BITS`).

Matching. Bits 15, 18, 19, 24 are independent salted halves (`run_phase::salted_phase` with a bit-specific salt), so a plain probe-free split is balanced by construction. Two are not: bit 1 is a positional posture phase with `DEFAULT_FRACTION` 0.9, so its untreated half is about 10 percent of runs; bit 9 (`crash_phase::is_anchored`) is nested inside bit 1. The direction note's 27/28-in-18 and 23-in-9/19 nestings no longer exist in the source. Use the matched scope anyway, generically: `probeFreeScope(cells, bit)`, then `invariantCoBits(treated, bit)` (both exported from decide.ts) to restrict the control to runs carrying the treated population's invariant co-bits. That is a no-op for the salted bits and gives crashPhase its placed-only control. This is the same arithmetic as `matchedContrast` in decide.ts, which is not exported; either export it or reimplement its ten lines in the grader.

Interval. Two-binomial log-ratio SE `sqrt((1-p1)/vt + (1-p2)/vc)`, inflated by `INTERNAL_OVERDISPERSION` (1.3) so the panel's z is the primary's regime, `lo/hi = ratio*exp(-+2.7*se)`. `read` is `count-only` when either half has under 5 violations, `up` when lo > 1 and ratio-1 >= `INTERNAL_MIN_EFFECT`, `down` symmetrically, else `flat`. The effect floor matters for the easy members (thousands of events resolve 1.02).

## 2. Data and join

Violating ids: `porcupine/batch` already emits `violating_run_ids` (and `unknown_run_ids`), parsed by `PorcupineJson` in `research/orchestrator/src/schemas.ts`. Nothing more is needed from porcupine.

Run id to tag: the runs table is a parquet directory `out/runs/*.parquet` read by `traceanalyzer/reader/runs.go` (`ReadRuns`) through Go DuckDB and emitted by `traceanalyzer/main -runs` as one JSON array; `runsTable()` in `research/orchestrator/src/runners.ts` wraps it with a 512 MB `maxBuffer`. Neither a `duckdb` CLI nor the Python duckdb module is installed, so traceanalyzer is the only reader. Cost: the quick set (48k-280k runs, about 330 bytes per row, under 100 MB) works today. The slow set (2.88M runs for the Raft members) would produce about 950 MB, over `maxBuffer` and over V8's string limit. Strictly needed traceanalyzer change, additive: a `-runs-columns run_id,variant` flag in `main.go` that projects `ReadRuns` output to the named fields before encoding (about 90 MB at 2.88M rows). No porcupine change.

Join, in TypeScript: `variantMetrics(rows, [], violatingIds)` from `research/orchestrator/src/evaluate.ts` already builds `VariantMetrics` cells keyed by (arm, variant) with a `violations` field; the panel calls it with an empty depth list, then computes per-bit contrasts as in section 1. Do not route through `ghost_census.py select --split-bit`: it needs a grade file and prints ids, not counts.

Cleanup: `cmdPanel` today calls `cleanupDir(dir)` right after porcupine; move the runs-table read before it. Keep two small files per member for re-reads and pooling across sessions: the porcupine JSON and the projected runs JSON, under `research/lite/state/panel/<iso>/<member>/`. `out/` is still deleted.

## 3. Output shape

Each member row gains `cells: [{bit, name, treatedRuns, treatedViolations, controlRuns, controlViolations, ratio, lo, hi, read}]`, plus `cellsMatchedOn` (names of invariant co-bits, so a nested bit's control is legible), and a `summary` string the operator can paste:

`panel-cells raft-stale-vote: crashPlaced 1.10 [0.83,1.46] 101/250k vs 11/28k flat; crashPhase 1.31 [1.0,1.7] up; clientFanoutRelease 0.72 [0.55,0.94] down; ghostAbsorberRetarget 0.98 flat; freshFirstPair count-only 3 vs 4; pairSendOrder 1.05 flat`

Observation-log convention: after each panel read, one paragraph headed `**Panel cells.**` followed by a table member x bit holding the ratio for `read != count-only` cells and `a/b events` otherwise; a cell is named as moved only at `up`/`down`, and any cell flipping direction against the previous cells read is called out with both intervals. Mencius (numCrashes 0) is the null row: every crash- and post-fault bit is inert there and must read flat.

## 4. Cost

No extra explore. Extra wall per member is one `traceanalyzer -runs` pass: a DuckDB scan plus JSON encode, a few seconds at 300k rows, roughly 30-60 s at 2.9M with the projection. The quick set stays under ten minutes; the slow set adds under three minutes. Porcupine already carries what is needed.

## 5. Members by ordering class

Axes and the side the VR target needs: request timing (post-fault write deferred, after the recovered node's ghost has acted at the new primary: deferred), crash placement (crash inside the victim's fan-out: fan-out-timed), retarget (crash on the absorber: yes), fresh-first and send order (fresh incarnation and lowest ordinal first: yes, per iterations 31-33).

| member | request timing | crash placement | retarget | fresh-first / send order |
| --- | --- | --- | --- | --- |
| paxos-accept-stale-ballot (`HandleP2a` guard dropped) | neutral: two concurrent writes at two proposers, no recovery | neutral, crash optional | neutral | neutral |
| mencius-opt1-2 (rule-2 gap fill) | inert (no crashes) | inert | inert | inert; null row |
| raft-stale-vote (`RequestVoteReply` term guard) | immediate: the write must land while the illegitimately elected leader still leads | fan-out: crash the candidate after its RequestVote fan-out | plausibly yes | opposite: the stale (dead-incarnation) reply must be taken first |
| paxos-fixed-recover-stale-scout (`HandleP1bResponse` ballot clause) | deferred: proof plan issues w2 after recover and stale P1b delivery, VR side | fan-out: crash after P1a fan-out | plausibly yes | opposite: stale P1b first |
| paxos-fixed-forget-promise (`RecoverInit` drops `acceptor_ballot`) | concurrent: the superseded P2a must be pending across the crash | opposite: crash a node whose single reply has already landed, no fan-out phase | opposite: victim chosen by role, not by absorbing | neutral |
| raft-forget-vote (`RecoverInit` drops `voted_for`) | immediate-short: both same-term leaders need a request before either is displaced; one post-fault op per run | opposite: crash after the vote landed | opposite | neutral |
| raft-commit-prev-term (`advance_commit_index` term check) | immediate: w2 must be issued at the new leader and appended before that leader's crash | fan-out: two leaders crash mid-replication | mixed | neutral |

Candidates on the opposite side of the VR target, with the injection and proof each needs (pattern of panel-hard-bugs.md: plan JSON in `research/lite/plans/`, `spur run-plan SPEC -p PLAN -o tmp/loop/lite/plan-X -y`, porcupine exit 2 on the injected spec and exit 0 on its host under the identical plan):

N1. `bin/spur/panel/raft_recover_stale_append_reply.spur` from `raft_clean.spur`: drop the `resp_term != current_term` return at `raft_clean.spur:391-395` (`AppendEntriesReply`). Request timing: immediate; the second write must reach the new leader and be appended at the follower before the ghost reply is consumed. Crash placement: the leader's crash must fall after its AppendEntries fan-out but before the reply lands, fan-out-timed, so this member is opposite on timing only. Proof plan: `allow_timer 0`, RequestVote 0->1 and reply (0 leads term 1), `w1` at 0, AppendEntries 0->1, `crash 0` before `AppendEntriesReply 1->0` is delivered, `allow_timer 2`, 2 leads term 2, `w2` at 2, AppendEntries 2->1 truncating index 1, `crash 2`, `recover 0`, `allow_timer 0` (0 leads term 3 with 1's vote), deliver the held `Node.AppendEntriesReply 1->0`, read at 0 returns w1 while 1's state machine holds w2. Host reads 0.

N2. `bin/spur/panel/paxos_fixed_recover_forget_accepted.spur` from `paxos_host_fixed.spur`: drop `accepted = s.accepted;` at line 99 of `RecoverInit`. Shape: a recovered acceptor answers a later scout with empty pvals; `pmax` misses a chosen command and the new leader puts a second command in that slot. Request timing: immediate; w2 must reach the new leader before `HandleDecision` for the slot arrives at it (`lowest_unused_slot` then skips the slot). Crash placement: opposite; the acceptor's P2b must have landed (so the slot is chosen) before it crashes, a quiescent-node crash the fan-out arms wait past and the retarget never picks. Proof plan: leader 0 scouts (2,0), promises from 1 and 2, `w1` at 0, P2a 0->1 and 0->2, P2b 1->0 and 2->0 (decided; hold Decision 0->2), `crash 1`, `recover 1`, `allow_timer 2` (2 scouts higher), P1a 2->1 and 2->2, P1b 1->2 (empty) and 2->2, `w2` at 2, P2a 2->1 accepted, P2b 1->2 and 2->2, Decision 2->all, reads at 0 and 2 disagree. Host under the same plan reads 0. Both need the three-seed calibration and a 20x separation from `paxos-fixed-host-control` or `raft_clean` before joining.

## 6. Sequencing and risks

Order: (1) the smallest real read: in `cmdPanel`, read `runsTable` before `cleanupDir`, build cells with `variantMetrics`, emit `cells` and `summary` for the quick set; no traceanalyzer change yet, mencius is the built-in null. (2) Add `-runs-columns` to traceanalyzer and a narrow `RunVariantRow` schema so the slow set reads. (3) Persist the two small files per member and add a `--pool <dir,...>` flag that sums stored cells with `sumVariantCells` so rare members accumulate across sessions. (4) Build N1 and N2 with proofs, then calibrate.

Risks: cell counts on rare members (raft-forget-vote 78 events splits to about 39/39, resolving only a 1.9x move; crashPlaced's 10 percent control gives about 8 events there, so bits 1 and 9 will be count-only on every hard member until pooled). The two easy members saturate: thousands of events make 1.03 separate, so the 2 percent floor and a reading against the member's own previous cells, not the manifest, are mandatory. A tag skew is not a mechanism effect: check treated shares near 0.5 (0.9 for bit 1) per member first, since a run-count grid cut can leave a phase imbalance on a small corpus. Direction on a member is a hypothesis about its bug's ordering class, so a cell that moves should be confirmed by one classified trace from each half before it is recorded as a bias. Boundaries: `bin/spur/**` changes are the two additive panel files only; `porcupine/` is untouched; the one `traceanalyzer/` change is the additive projection flag.

Written by a planning agent on 2026-09-04 under the user's direction:
strategies as arms, read per cell. Two facts to carry: the checked-out
client_anchor.rs has EXPIRY_STEPS 32 until the 64-step merge lands, and
bits 23, 27 and 28 exist only in candidate patches, not in the tree.

