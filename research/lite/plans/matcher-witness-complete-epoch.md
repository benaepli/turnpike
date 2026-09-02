# Plan: witness-complete prefix depth, epoch 13

status: planned (operator lane, measurement plane) | source: planner agent, 2026-09-02

# Implementation plan — witness-complete prefix depth with contraction by kind

## Finding that changes the shape of the plan (read this first)

The premise that step 3 recovers the 2 lost violations is **false**. I checked it against the judge's own artifacts rather than assuming it.

`plan_base.json` vs `plan_wc.json` in the session scratchpad differ at exactly one rung: depth 9, 103 → 90 runs. Thirteen runs drop, two of them violating (2345, 2721). Dumping those runs from `tmp/loop/judge-plan` with `ta-main -dump-run` shows the loss is **in the corpus, not in the matcher**:

| run | only `r1`/`r2`/`r3` candidate (exec step) | only `deliver_svc_2_to_0` candidate (trace step) |
|---|---|---|
| 2345 | 49 | 80 |
| 2721 | 53 | 97 |

`r1`'s direct predecessors in `research/oracle/relax_minimal.json` are **both** `deliver_svc_1_to_0` and `deliver_svc_2_to_0`. Every read in those runs happens strictly before node 2's StartViewChange reaches node 0, so **no assignment whatsoever** — greedy, swap, exhaustive — puts a read after both delivers. I ran the same check on all thirteen dropped runs (251, 1036, 1043, 1112, 1241, 1292, 1417, 1668, 1979, 2345, 2540, 2721, 2787): in every one, no read on any node occurs after both earliest deliveries. Run 1979 is the tightest (read at 57, `deliver_svc_2_to_0` Enter at 57, cross-table same step → `lessThan` false at `matching.go:33-41`).

Consequences:

1. **The correctness gate as written cannot be met by any implementation.** It must be restated as a *provable* gate (section 3), not a number.
2. Step 3 is still worth doing, but for a different reason (it makes the greedy an exact earliest-witness finder), and it needs a companion — the prefix must be evaluated on the greedy assignment as well as the swap-optimal one, because the swap's objective (`better()` at `matching.go:271-277`) is edge count, which is not depth.
3. Manifest invariant 2 must be re-founded on `find_bug_plan` (regenerable, ids reproduce exactly) rather than `findbug_archive` (no run store on disk, no plan, not regenerable).

Two further facts I confirmed from the artifacts, which the plan below relies on:

- `grade_wcnc.json` (witness-complete **without** contraction) is the configuration that yields 83/12,000 = 0.69% at depth≥6 with 0 lacking `crash_nl`. `grade_wc.json` (witness-complete **with** zero-candidate contraction) yields 569 = 4.74%, of which 405 still lack `crash_nl`. Since neither `relax_minimal_general.json` nor `relax_minimal.json` contains a `partition` or `heal` label, **`structuralUnmatchable` is the empty set for both oracles**, so contraction-by-kind is exactly `wcnc`. The specified change reproduces the headline number; the contraction clause is defensive, not load-bearing today.
- On the plan corpus `plan_wc.json` and `plan_wcnc.json` are byte-identical in every aggregate, confirming rung 6 (751/3000 = 25.0%) is untouched.

---

## 1. Matcher change, precisely

### 1.1 What "contracted" means after the change

```
contracted(label) ⟺ !cfg.Events[label].Kind.Matchable()
```
computed once per config, not per run. This is the same map already built at `dagorder.go:149-154` (`structuralUnmatchable`) and used today only for edge accounting at `:157` and `:341`. Today's contraction predicate — "zero candidates in this run", `matching.go:324-327` feeding `a.unmatch` — stops driving the prefix. `a.unmatch` stays exactly as it is and keeps driving `edgeSatisfaction` (`matching.go:471-497`); that metric's denominator rule does not change.

**Re-linking.** A contracted vertex is spliced out of the predecessor relation: its successors inherit its own direct predecessors, transitively. Formally, for each `v`:

```
survIn(v) = closure of depIn(v) under "replace contracted u by depIn(u)"
```

A contracted vertex is never a chain member, never a parent, never contributes to `dp`. If every predecessor of `v` contracts away, `v` becomes a root. This is the prototype's `walk` in `scratchpad/patch.py`, keyed on `contracted` instead of `a.unmatch`.

A label whose kind is observable but which has zero candidates in this run stays in `survIn`, is never assigned, and therefore **fails** every vertex that has it as a surviving predecessor. That is the whole point: `crash_nl` no longer vanishes when node 1 never crashed.

### 1.2 Plumbing (the assignment does not know about kinds today)

- `matching.go:45-56` — add to `assignment`:
  ```go
  contracted map[int]struct{} // label indices whose kind is structurally unobservable
  survIn     map[int][]int    // direct predecessors with contracted vertices spliced out
  ```
- `matching.go:279` — `newAssignment(labels, cands, directDeps, allDeps, unobservable map[string]bool)`. After the `depIn`/`depOut` build at `:303-312` and before the topo sort at `:330`, fill `contracted` from `unobservable` and compute `survIn` by the walk above (13 labels: cost is nil; it is run-independent given the config but cheap enough to build per run).
- `matching.go:75-81` — `bestMatchingFull(..., unobservable map[string]bool, seed int64, nSwaps int)`; pass through at `:82`.
- `matching.go:192-201` — legacy `bestMatching` wrapper passes `nil` (all 20 call sites in `matching_test.go` compile unchanged).
- `dagorder.go:262` — pass `structuralUnmatchable` (already in scope from `:149`).
- `prefix_test.go:17,33,52,67,79` — five call sites gain the new argument.

**Corpus-level extension (recommended, see §5).** `KindAllowTimer` is `Matchable() == true` (`planconfig.go:56`). On a corpus written before timer firings were recorded, `reader.TimerEncoding` returns `"none"` (`reader/reader.go:411-430`) and `allow_t1` has zero candidates in every run — under the new rule the whole ladder collapses to depth ≤ 1. At `dagorder.go:265-269` the encoding is already probed. Add:

```go
if encoding == "none" {
    for id, spec := range cfg.Events {
        if spec.Kind == KindAllowTimer { structuralUnmatchable[id] = true }
    }
}
```
This keeps "structurally unobservable" a statement about the corpus + kind, never about the run, and preserves comparability with pre-timer archives. Also fix the now-wrong comment at `planconfig.go:49-53` (it says zero-candidate labels are contracted).

### 1.3 `rootAnchoredPrefix` — replaces `matching.go:203-267`

```
func (a *assignment) rootAnchoredPrefix(choice []int) (int, []string):
    assigned(li) = choice[li] >= 0
    eventOf(li)  = a.cands[a.labels[li]][choice[li]]

    dp[0..n-1] = 0 ; parent[..] = -1
    for li in a.topo:
        if li in a.contracted: continue          // never a chain member
        preds := a.survIn[li]
        if len(preds) == 0:                      // root
            if assigned(li): dp[li] = 1
            continue
        if !assigned(li): continue               // dp stays 0
        ok := true ; best, bestParent := 0, -1
        for u in preds:                          // EVERY surviving predecessor
            if dp[u] < 1 || !assigned(u) || !lessThan(eventOf(u), eventOf(li)):
                ok = false ; break
            if dp[u]+1 > best: best, bestParent = dp[u]+1, u
        if ok: dp[li], parent[li] = best, bestParent

    argmax over dp ; walk parent[] back ; reverse ; return (depth, path)
```

Differences from the prototype: it takes `choice` as a parameter (so it can be run twice), uses `a.survIn`/`a.contracted` instead of `a.unmatch`, and drops the `STRICT_NOCONTRACT` env switch. `a.edges` (the closure, built at `:214-215`) is no longer read here at all; it remains the edge-satisfaction edge set.

Note `dp[u] >= 1` is what forbids a chain from starting mid-DAG: an unassigned root has `dp = 0` and poisons everything below it.

### 1.4 `assignEarliestAfterPredecessors` — `matching.go:387-425`

Replace the predecessor collection at `:394-403`:

```go
var preds []Event
for _, p := range a.survIn[li] {          // was a.depIn[li]
    c := a.choice[p]
    if c < 0 { return }                   // NEW: required predecessor unassigned -> leave li unassigned
    preds = append(preds, a.cands[a.labels[p]][c])
}
```

`survIn` (not `depIn`) so a `partition`/`heal` label cannot block the whole chain. Topo order guarantees every element of `survIn[li]` — all of them ancestors — is already processed.

**Why this matters:** with this rule the greedy pass computes, by induction, `earliest[v] = min candidate strictly after max(earliest[u] : u ∈ survIn(v))`, which is the *minimum possible* event for `v` over all witness-complete embeddings. That makes the greedy an **exact** witness finder, modulo injectivity (`usedKey`), which can only ever push a choice later and so is strictly conservative. Injectivity is automatically satisfied between a chain vertex and each of its ancestors, because the ordering required is strict.

Reported side effects: labels the tightened greedy leaves unassigned land in `CrowdedOut` (`matching.go:160-163`) if the swap does not recover them. That bucket already covered "no predecessor-respecting candidate" (see `TestUnassignedEdgeCounted`), so no schema change; update the doc at `matching.go:65` and `dagorder.go:25`. `edge_satisfaction` / `mean_score` will move slightly. That is inside the epoch bump.

### 1.5 The greedy/swap answer, and `dag_swaps`

The swap phase accepts a move iff it raises the satisfied-edge count (`better`, `matching.go:271-277`; `eligible` is invariant to `choice`, so the ratio comparison reduces to `sat > bestSat`). That objective is **not** prefix depth: a single move that raises the edge count can break the witness chain, and the hill climb is single-move so it cannot perform the two-move repair that would restore it. Under the old closure dp this was masked — a broken middle hop was skipped. Under witness-completeness it is fatal.

**The fix, and the only search change needed:** evaluate the prefix on both admissible assignments and take the deeper.

- `matching.go:87-89` — after the greedy loop, `greedyChoice := append([]int(nil), a.choice...)`.
- `matching.go:177` — replace the single call with:
  ```go
  prefixDepth, prefixPath := a.rootAnchoredPrefix(a.choice)   // a.choice == bestChoice here
  if gd, gp := a.rootAnchoredPrefix(greedyChoice); gd > prefixDepth {
      prefixDepth, prefixPath = gd, gp
  }
  ```
  Ties go to the edge-optimal assignment, so `PrefixPath` agrees with the reported `Assign` whenever it can. Document at `matching.go:66-69` that `PrefixDepth` is a max over two admissible injective assignments while `Score`/`Assign` come from the edge-optimal one.

Cost: one extra O(V+E) dp per run, on 13 vertices. Nothing measurable — the judge measured matching at 2.4 s of a 34.6 s grade.

**`dag_swaps` stays 200.** With this construction the swap can only ever *add* depth, never remove it, so the metric is no longer sensitive to the swap budget. That is one fewer constant to recalibrate, and it should be asserted (§2, the swap-invariance test).

**Pre-registered expectation:** on both corpora the max-of-two must equal the bestChoice-only value, because `plan_wc == plan_wcnc` and `grade_wcnc` were both measured on bestChoice alone. Report the delta. Zero delta = the insurance is inert and the judge's numbers reproduce exactly; nonzero delta = the swap was destroying chains, which is information, not a failure.

---

## 2. Tests

### Existing tests in `prefix_test.go` that invert

| test | line | today | after |
|---|---|---|---|
| `TestPrefixDepthLinear` | 13-24 | 3, `[a b c]` | unchanged — keep as the "full in-order chain" case |
| `TestPrefixDepthSkipsViolatedMiddle` | 29-40 | 2, `[a c]` | **inverts**: rename `TestPrefixDepthFailsOnViolatedMiddle`; `a(10) -> b(5) -> c(20)` must give depth **1**, path `[a]`. `b`'s only candidate precedes `a`, so `b` is unassigned; `c`'s surviving predecessor `b` is unmatched, so `c` fails. The comment must state the new rule: the closure hop `a->c` is no longer a chain edge |
| `TestPrefixDepthAnchored` | 48-59 | `LongestChain 2`, depth 1 | unchanged assertions, but the mechanism comment at 42-47 must be rewritten: `c` and `d` now fail because `b` is unassigned, not merely because no closure chain reaches them. `LongestChain` still 2 (`longestSatisfiableChain` is untouched). Add an assertion that `assign["c"]` and `assign["d"]` are absent, pinning the tightened greedy |
| `TestPrefixDepthContractsUnmatchable` | 63-71 | 2 via zero candidates | **changes mechanism**: `t` must now be declared unobservable via the new argument (`map[string]bool{"t": true}`) to still give 2. Split into two tests — see below |
| `TestPrefixDepthZero` | 75-83 | 0, nil | unchanged |

### New tests (all in `prefix_test.go`)

1. **`TestPrefixDepthFailsOnSkippedDirectPredecessor`** — `a->b->c`, `a=1`, `b` has a single candidate at 0 (before `a`), `c=5`. Expect depth 1, path `[a]`. Distinguishes "predecessor exists but is misordered" from "predecessor absent".
2. **`TestPrefixDepthFailsOnZeroCandidateObservableLabel`** — the `crash_nl` case in miniature: `a->b->c`, `cands["b"] = nil`, `unobservable = nil`. Expect depth **1**. Under the old code this was 2. Add an explicit comment naming `crash_nl` and the 66.9% figure so the intent survives.
3. **`TestPrefixDepthContractsUnobservableKind`** — same graph, `cands["t"] = nil`, `unobservable = {"t": true}`. Expect depth 2, path `[a b]`.
4. **`TestPrefixDepthRequiresAllDirectPredecessors`** — diamond: `a->b`, `a->c`, `b->d`, `c->d` with `a=1, b=2, c=9, d=5`. `d` must fail (`c` is after it) → depth 2. This is exactly the run-2345 shape and is the test that documents why runs 2345/2721 legitimately stop at 8.
5. **`TestPrefixDepthFullChainReachesMaxDepth`** — the nine-vertex `relax_minimal` shape built from literal candidate lists, all in order, plus the two "join" labels `recover_nl` and `deliver_svc_2_to_0` placed correctly. Expect depth 9 and the exact path. This is the unit-level version of the corpus gate.
6. **`TestPrefixDepthIgnoresSwapBudget`** — same inputs graded at `nSwaps = 0`, `200`, `2000`; `PrefixDepth` must be identical. Pins the claim in §1.5 and licenses leaving `dag_swaps` at 200.
7. **`TestPrefixDepthMatchesExactWitness`** (property test) — implement `exactWitnessDepth(labels, cands, directDeps, unobservable)` as a **test-only** helper computing `earliest[v]` directly, ignoring injectivity (an upper bound). Over a few hundred randomized small DAGs and candidate sets, assert `bestMatchingFull(...).PrefixDepth == exactWitnessDepth(...)` except where injectivity provably binds (two incomparable labels sharing an identical candidate list — exclude those by construction). This helper is reused as the gate's escape valve in §3.

### `matching_test.go`

No signature change (the `bestMatching` wrapper passes `nil`), but two tests now document a changed greedy and need comment updates, not assertion changes:
- `TestGreedySkipsOnBadCandidate` (287-305) — still passes; add "and any successor of `b` is now skipped with it".
- `TestSwapCanUnassign` (310-327) — still passes; note that `PrefixDepth` is now read off both the greedy and the swapped assignment.

`timer_test.go` and `planconfig_test.go` are untouched.

---

## 3. Correctness gate procedure

Everything below is read-only against the tree except the two output directories under `tmp/`.

### 3.0 Build

```bash
cd /home/benaepli/Rust/turnpike/traceanalyzer && go test ./... && go build -o main main.go
```

### 3.1 Regenerate the plan corpus

```bash
cd /home/benaepli/Rust/turnpike
spur/target/release/spur run-plan bin/spur/VR.spur \
  -p research/oracle/tiers/find_bug_plan.json \
  -o tmp/loop/gate-plan --log-backend parquet -y
```
(`num_runs: 3000`, `max_iterations: 10000`, `strict_timers: true` come from the plan file; CLI shape from `spur/spur-cli/src/main.rs:99-115`.)

### 3.2 Ground truth must reproduce exactly

```bash
porcupine/batch -input tmp/loop/gate-plan -model kv -timeout 3000 > tmp/loop/gate-plan.porc.json
```
**Assert** `violations == 11` and `violating_run_ids == [572,594,791,828,1024,1447,1646,1802,1824,2345,2721]`, identical to `research/corpus/find_bug_plan.porcupine.json`. The judge's regeneration reproduced these ids exactly, so a mismatch here means the spur binary drifted and the gate is void before the matcher is even tested.

### 3.3 Grade with the new analyzer

```bash
traceanalyzer/main -input tmp/loop/gate-plan -grade \
  -dag-config research/oracle/relax_minimal.json \
  -dag-swaps 200 -grade-max-runs 0 -grade-budget-ms 0 \
  -grade-per-run -format json > tmp/loop/gate-plan.grade.json
```
`-dag-swaps 200` and grading all 3,000 runs match `manifest.json.grader_settings` (`grade_max_runs: 2000` in the manifest is the *live* cap; the gate grades everything so no sampling can hide a run).

### 3.4 Assertions on the plan corpus

Against `plan_base.json` / `plan_wcnc.json` in the session scratchpad:

| # | assertion | expected |
|---|---|---|
| P1 | `depth_at_least[0..7]` unchanged from the pre-change grade | `[3000,3000,3000,3000,751,751,751,145]` |
| P2 | `max_prefix_depth` | `9` (unchanged) |
| P3 | runs at depth 9 | `90` (was 103) |
| P4 | rung 6 = `depth_at_least[5]` | `751` = 25.0% (primary untouched) |
| P5 | all 11 violating runs at depth ≥ 8 | 9 at 9, 2 (2345, 2721) at 8 |
| P6 | **witness-existence proof** for every violating run below max | see below |
| P7 | max-of-two delta vs bestChoice-only | expected 0 |

**P6 is the real gate.** For every run whose depth fell, and for every violating run below `max_prefix_depth`, run the exact witness checker (test 7's helper, exposed as `traceanalyzer/main -dag-witness-check <dir> -dag-config <cfg>` or as a `go test -run TestCorpusWitnessExactness` reading the corpus path from an env var) and require `heuristicDepth == exactWitnessDepth` for **every graded run**. If the two agree everywhere, the matcher is optimal and any lost depth is a fact about the corpus. If they disagree on any run, the implementation is wrong — this is exactly the failure mode "greedy sensitivity zeroing chains" (§7).

I have already established the expected answer for the thirteen dropped runs by hand: `exactWitnessDepth == 8` for all of them, because no read occurs after both StartViewChange deliveries at node 0. The gate should reproduce that mechanically and record the per-run evidence (the candidate step lists) in the epoch note.

**Restated manifest invariant 2** (this is the recalibration the epoch bump buys):

> On `find_bug_plan`, every violating run reaches the deepest witness-complete prefix its own event set admits, and every violating run sits at depth ≥ max−1. 9 of 11 reach max (9); runs 2345 and 2721 stop at 8 because no read in either run follows both deliveries to node 0 — proved by the exact witness checker, not asserted.

Precision at max is 9/90 = 10.0%, against 11/103 = 10.7% before: unchanged. Recall at max falls 100% → 82%, on a rung three orders of magnitude below the power floor. That trade must be written down, not glossed.

### 3.5 General store

```bash
traceanalyzer/main -input tmp/loop/judge-store -grade \
  -dag-config research/oracle/relax_minimal_general.json \
  -dag-swaps 200 -grade-max-runs 12000 -grade-budget-ms 0 \
  -grade-per-run -format json > tmp/loop/gate-general.grade.json
```
`sampleRunIDs` (`dagorder.go:538-549`) is seeded from the id-list shape, so `-grade-max-runs 12000` selects the *same* 12,000 runs the judge graded; comparison against `grade12k.json` / `grade_wcnc.json` is per-run exact.

| # | assertion | expected |
|---|---|---|
| G1 | `depth_at_least` | `[6609,4729,1492,1434,90,83,4,3]` |
| G2 | depth≥6 fraction | 83/12000 = **0.69%** (was 2396 = 19.97%) |
| G3 | depth≥6 runs whose `prefix_path` lacks `crash_nl` | **0** (was 1604 of 2396) |
| G4 | modal depth-6 path | `w1, allow_t1, crash_nl, deliver_svc_1_to_2, crash_2, recover_2` — all 83 runs, i.e. bug.md steps 1-4 exactly |
| G5 | `max_prefix_depth` | 8 (was 9) |
| G6 | max-of-two delta | expected 0 |

An exact match on G1 is the strongest available check that the implementation equals the measured prototype plus the two additions that should be inert on this corpus (contraction-by-kind is a no-op here, max-of-two expected inert).

---

## 4. Epoch bump

Current epoch is **12** (`research/state.sqlite` meta). Bump to **13**.

```bash
npm --prefix research/orchestrator run loop -- epoch bump \
  "witness-complete prefix depth: direct-predecessor chains, contraction by kind. depth k now means the first k events of bug.md happened in order with nothing skipped. depth>=6 per-run rate 19.97% -> 0.69%; general max depth 9 -> 8. Pre-epoch depth figures are on a different scale."
```

### 4.1 Preventing pre/post chunks from pooling

`graderVersionOf()` (`lite/grader.ts:93-98`) is `ta:<last commit touching traceanalyzer>+porc:<porcupine HEAD>` — it changes **automatically** when `matching.go` is committed (`ta:ac521f5` → new). It is stamped on every `Evaluation` (`grader.ts:283`, `schemas.ts:275`) and rendered (`render.ts:151`). But **nothing checks it before pooling**. The holes:

1. `BaselineIdentity` (`lite/grader.ts:120-130`) has no grader term. A cached baseline measured under the old analyzer will pool with new candidate chunks. **Fix: add `graderVersion: string` to `BaselineIdentity`, set it in `identityFor` (`:139-146`), include it in `identityKey` (`:149`) and in `cacheFileFor` (`:153`)** — e.g. `${spurTree12}-${threads}-${templateSha8}-${chunkSec}-${graderVersionSlug}.json`. Both existing caches then miss and are re-measured rather than silently adopted.
2. `loadCache` (`:161-172`) accepts any chunk that parses. **Add: drop (or refuse) chunks whose `e.graderVersion !== identity.graderVersion`.**
3. `tryAdoptRecord` (`:176-217`) checks spurTree, template sha, arm set, threads and exposure, but not the grader. `research/evaluations/000-baseline-30.json` carries `graderVersion: "ta:5f45250+porc:ebf06c5"` at top level. **Add a `raw.graderVersion !== id.graderVersion → return null` check** beside the `rayonThreads` check at `:185`.

**Should the oracle file be in the identity?** Yes, and it is the second half of the same hole: `policy.evaluation.oracleDags` (`policy.json`) selects `relax_minimal_general.json`, and editing that file would rescale depth without touching `traceanalyzer` at all, so `graderVersionOf` would not notice. Cheapest correct fix: fold the oracle content into the grader version —

```ts
function graderVersionOf(): string {
  const ta   = gitOut(ROOT, ["log", "-1", "--format=%h", "--", "traceanalyzer"]);
  const porc = gitOut(path.join(ROOT, "porcupine"), ["rev-parse", "--short", "HEAD"]);
  const { policy } = loadPolicy(path.join(ROOT, "research", "policy.json"));
  const oracle = sha256(policy.evaluation.oracleDags
    .map((p) => fs.readFileSync(resolveRoot(p), "utf8")).join("\0")).slice(0, 8);
  return `ta:${ta}+porc:${porc}+oracle:${oracle}`;
}
```
This makes the depth scale's full definition — analyzer code, checker, and DAG — one string, which then propagates into the baseline identity, the cache filename, the chunk records and the rendered status. It also means the `dispatch_step` reader column (§5), which touches `traceanalyzer`, invalidates the caches once, in the same commit, rather than twice.

`orchestrator/src/loop.ts:47`'s `graderVersion()` should get the same treatment for symmetry, though the big loop is stopped.

### 4.2 Baselines to re-measure

Both caches for the current tree `7555e6a5bbef`:

| cache | template | chunks | runs | depth≥6 today | projected after |
|---|---|---|---|---|---|
| `7555e6a5bbef-30-f9daa01b-300.json` | f9daa01b | 4 | 2,051,160 | 466,352 (22.7%) | ~14,150 (~3,540/chunk) |
| `7555e6a5bbef-30-1497728c-300.json` | 1497728c | 2 | 700,740 | 159,778 (22.8%) | ~4,840 (~2,420/chunk) |

```bash
npx tsx research/lite/grader.ts baseline \
  --base-bin spur/target/release/spur \
  --base-template scheduler_configs/loop/general_vr.json --chunks 4
```
and the same for the second template. Wall: 4 × 300 s explore + grade per cache. Grading is unaffected by this change (the dp is O(V+E) on 13 vertices; `survIn` is smaller than the closure `closIn` it replaces), so `sequential.wallSecPerChunk: 1800` needs no increase — the judge measured matching at 2.4 s of a 34.6 s grade.

The seven caches for other spur trees are stale by construction (different `spurTree`); leave them, they can never be adopted.

### 4.3 `research/corpus/manifest.json`

Honest accounting of what can and cannot be recomputed:

**Regenerable** (`plan != null`, via `spur run-plan`): `find_bug_plan`, `relax_3`, `relax_5`, `relax_minimal`. For each: regenerate, run `porcupine/batch` and require the recorded `violating_run_ids` reproduce, then grade with the new analyzer at `-dag-swaps 200 -grade-max-runs 2000` (the recorded grader settings) against `research/oracle/relax_minimal.json`, and rewrite `mean_prefix_depth`, `max_prefix_depth`, `depth_at_least`, `sha256`.

**Not regenerable**: `findbug_archive` (`plan: null`, no run store, produced by a find-bug explorer session at spur `b04c56f0`) and `unconstrained_c0` (`plan: null`, an explore). Invariants 2 and 3 as written live on `findbug_archive` and **cannot be recomputed**. Do not fabricate them.

Therefore:

- **Invariant 1** ("plan corpora mean depth exceeds unconstrained by ≥ 1.0") — re-found the unconstrained arm as a *reproducible* corpus: a fixed-seed, fixed-budget explore with `scheduler_configs/loop/general_vr.json`, recording seed, `wall_budget_sec`, spur commit and sha256s. Recompute the margin. Expect the margin to **widen**, because witness-completeness costs a general corpus ~16x at rung 6 and the plan corpus nothing.
- **Invariant 2** — re-founded on `find_bug_plan` per §3.4, in its provable form.
- **Invariant 3** ("372 at depth 8, 266 violate") — retire with an explicit note that the corpus behind it no longer exists on disk, and replace with the `find_bug_plan` equivalent: 145 runs at depth ≥ 8 of which 11 violate, 90 at depth 9 of which 9 violate.
- **Invariant 4** (porcupine verdicts) — unchanged and re-verified in §3.2.
- Add to the manifest: `epoch: 13`, `analyzer_grader_version`, `generator_spur_commit` refreshed, and the note that relax-tier ordering by depth is *expected* to become monotone in constraint count now that skipping is forbidden — record it as an observation, not an invariant.

### 4.4 `PRIMARY_RUNG` — stays 6, confirmed

`decide.ts:284`. Depth 6 under the new numbering is `w1, allow_t1, crash_nl, deliver_svc_1_to_2, crash_2, recover_2` — confirmed as the path of **all 83** depth-6 runs in `grade_wcnc.json`. That is `recover_2`, bug.md steps 1-4. It is also the last rung with power: projected ~3,540 events/chunk against the ~1,000-event floor (`observations/POWER_FLOOR.md`). Rungs 7 and 8 fall to ~180 and ~135 per chunk, which is why they must stay out of `ADVANCE_RUNGS` (`decide.ts:281`, already `[4,5,6]`).

`DEEP_GUARD_RUNGS = [5,6]` (`decide.ts:322`) stays: rung 5 lands at ~0.75%/chunk, essentially the same population as rung 6 (90 vs 83 per 12,000 — a 92% conditional advance). The ladder now has three plateaus rather than a smooth slope: rungs 1-2 (55%/39%), 3-4 (12.4%/11.95%), 5-6 (0.75%/0.69%), 7-8 (0.03%/0.025%). Nothing in the gate depends on smoothness, but the stopper payload (`stopper.ts:20`, `RUNGS = [4,5,6,7,8]`) will show two near-identical pairs; leave it, and say so in the epoch note so the operator does not read the pairing as a bug.

**Go/no-go on PRIMARY_RUNG:** it stays 6 *conditional on the re-measured baseline showing ≥ 1,000 depth-6 events per chunk*. If it comes in below that, primary moves to 4 (~64,000/chunk) and rungs 5-6 become guards. Decide this from the baseline re-measure in 4.2, not from the 12,000-run probe.

### 4.5 `nullBand` / `MERGE_Z`

Neither is a constant that needs a new value. `nullBand(ce, be) = sqrt(1/ce + 1/be)` (`decide.ts:235-238`, `stopper.ts:74-77`) is computed from the event counts, so it self-rescales; `MERGE_Z = 2.7` is a Bonferroni constant over the objectives tested, independent of rate. What changes is the **resolvable effect**, and that must be recorded before the first candidate is graded:

| | events/chunk at rung 6 | 4-chunk null band | MEI at z 2.7 |
|---|---|---|---|
| epoch 12 | ~117,000 | 0.21% | ~0.6% |
| epoch 13 (projected) | ~3,540 | 1.19% | ~3.2% |

A 5.7x wider band. Historical merges sat at +5% (iteration 16: 1.0500 [1.0448, 1.0551]) — still separable at 4 chunks, but with little margin. Actions:

- Do **not** change `MERGE_Z`, `DEEP_RUNG_MARGIN` (0.25), or `DEEP_RUNG_NIP` (0.95). Widening the merge threshold to compensate for a noisier primary is how a gate stops meaning anything.
- Record the measured MEI from the first post-epoch session. If it exceeds 5%, raise `lite.json.budgets.maxChunks` 4 → 6 (`HARD_LIMITS.maxSequentialChunks` is 12, so this is legal) rather than loosening the threshold. Six chunks give band 0.97%, MEI ~2.6%.
- Re-run `npx tsx research/lite/grader.ts selftest` after the baselines are re-measured — `selfTestGateConsistency` pools live baseline chunks (`grader.ts:829-856`) and its thresholds were derived under the 300 s policy at the *old* rates. Expect it to need its live-figure path re-pointed at the new caches; investigate any failure before grading a candidate.
- `research/observations/POWER_FLOOR.md` is regenerated by `node research/observations/power_floor.mjs --out ...` from archived evaluation records. It cannot be regenerated meaningfully until post-epoch records exist. Annotate its header with "measured under epoch ≤ 12; depth buckets are on a different scale from epoch 13" and regenerate after ~8 post-epoch same-seed families exist.

### 4.6 `GOAL.md`

One sentence, in "Core ideas": append after "graders separate candidates on depth>=6 events per explore-second — per-run probability times runs per second — so throughput multiplies every rung." →

> From epoch 13 the rung is witness-complete: depth ≥ k means the first k events of the oracle DAG occurred in order with nothing skipped, so depth ≥ 6 requires the initiating crash and its stale view-change delivery, not merely six events that happen to be ordered. Depth figures from earlier epochs are on a different scale and are not comparable.

The paragraph above it already says "Depth has already decoupled once" — leave that; this change is the repair, and the sentence stays true history.

### 4.7 Annotating the observation logs

Annotate, do not restate. In both `research/observations/OBSERVATIONS.md` (85 occurrences of `depth>=6`) and `research/lite/observations.md` (28), add a single banner at the top of each:

> **Epoch note.** Every prefix-depth figure recorded before *(date, commit)* was measured under the closure-skipping, zero-candidate-contracting matcher. From epoch 13 depth is witness-complete over direct predecessors with contraction by kind: general-mode depth ≥ 6 moves from ~20% to ~0.7% of runs and general max depth from 9 to 8. Ratios *within* one epoch remain valid; levels across the boundary are not comparable.

Then a one-line marker beside the two places where the old number is load-bearing rather than incidental: the allow_timer prototype section (`OBSERVATIONS.md` ~lines 600-680, where "d≥6 1.9% to 3.5%" appears) and `lite/observations.md`'s ranking paragraph. Do not edit the historical figures themselves.

---

## 5. Bundled extras

### 5.1 `dispatch_step` reader column — **GO**

`reader/reader.go:378-380`, the `d` CTE:
```sql
SELECT run_id, trace_id, arg_min(node_id, seq_num) AS sender,
       arg_min(step, seq_num) AS dispatch_step
FROM ... WHERE ... AND trace_kind = 'Dispatch' GROUP BY run_id, trace_id
```
plus `DispatchStep int32` on `EnterRow` (after `Sender`, `reader.go:351`), `coalesce(d.dispatch_step, -1) AS dispatch_step` in the projection at `:386`, the column added to the outer `SELECT` at `:384`, and `&r.DispatchStep` in the scan at `:398`.

Why go: one extra aggregate inside a `GROUP BY` that already exists, one extra int32 per row; nothing reads it, so **no metric moves**. It changes `traceanalyzer`, which changes `graderVersion`, which invalidates both baseline caches — but those are being re-measured anyway in this same epoch bump. Landing it later would cost a second baseline re-measure for zero science. Do not touch `candidates.go`; the field exists for a future stale-incarnation predicate.

### 5.2 Commit-time client labels as diagnostics — **NO-GO, defer**

It is not free:
- It edits `research/oracle/**`, which is protected, and would have to edit **both** `relax_minimal.json` and `relax_minimal_general.json` or the plan-corpus gate compares apples to oranges.
- It adds vertices (`deliver_sv_to_0`, `deliver_sv_to_2`) and edges, changing max depth and the width of `depth_at_least` for **every** corpus, forcing invariants 1-3 to be recomputed a second time inside one epoch — with the `findbug_archive` problem of §4.3 unresolved either way.
- Its payoff sits at rungs 7-9, which after this change run at 4 and 3 events per 12,000 runs (~180 and ~135 per chunk), three orders of magnitude below the primary and far below the power floor. It would be a diagnostic on a population of single digits per corpus.
- The judge's own note stands: the general config issues 2-4 writes over one key with uniform target, so raising `num_write_ops` buys the second-write rung more cheaply than any matcher mechanism.

Defer it to a proposal that also answers what `findbug_archive` is replaced with.

### 5.3 Node symmetry, stale-incarnation deliver typing — **NOT ADOPTED**, per the brief. Record the reasons in the epoch note so they are not re-proposed: rung 6 clears the floor at ~3,540/chunk without symmetry, and the node-id space is not role-qualified (`spur/spur-core/src/simulator/history.rs:40,73` discard the role; client and server indices overlap), so a bijection over "node indices" would mix clients with servers.

---

## 6. Panel and regression

**Panel: no dependency, no re-run required.** `cmdPanel` (`lite/grader.ts:915-985`) runs `explore` + `porcupine` per member and reports violations per explore-second against `research/panel/manifest.json` calibration. It never calls `grade()`, never reads `policy.evaluation.oracleDags`, and never touches `traceanalyzer`. Paxos/Mencius violation rates are unaffected by anything in this change.

**Regression: no dependency, no re-run required.** `orchestrator/src/regression.ts` imports only `explore` and `porcupine` (`:7`) and decides on throughput and porcupine verdicts (`:63`, `:119`). `policy.regression.throughputTolerance = 0.2` is unaffected.

**What does re-run:**
1. `go test ./...` in `traceanalyzer` (§2).
2. The gate of §3 (plan corpus + general store).
3. Both baseline caches (§4.2) — this is the expensive item, ~4 × 300 s + ~2 × 300 s of explore plus grading.
4. `npx tsx research/lite/grader.ts selftest` (§4.5).
5. `npm --prefix research/orchestrator run typecheck` after the `grader.ts` / `loop.ts` identity edits.

Optionally, `npx tsx research/lite/grader.ts panel` once as a sanity check that the tree still builds and explores — but its numbers are not evidence about this change and should not be reported as such.

---

## 7. Risk flags

**R1 — harsher but still crash-blind.** The change makes every rung rarer; a wrong implementation could produce a plausible-looking collapse (say 2-3% at rung 6) while still crediting chains that skip `crash_nl` — for instance if `survIn` is built from `a.unmatch` instead of `contracted` (the prototype's actual behaviour: 4.74% at rung 6, 405 of 569 still crash-blind). A rate that merely *fell* proves nothing. **Caught by G3/G4 in §3.5:** the assertion is not "depth≥6 fell" but "**zero** of the depth≥6 runs lack `crash_nl` on the winning path, and all 83 carry the identical six-label path". A single crash-blind survivor fails the gate.

**R2 — greedy sensitivity zeroing chains.** If the prefix is read only off the swap-optimal assignment, a run that genuinely contains the full chain can score short because the hill climb traded a chain hop for an unrelated closure edge — and the failure is silent, seed-dependent and invisible in aggregates. **Caught by P6 (exact-witness equality on every graded run) and by `TestPrefixDepthIgnoresSwapBudget`.** The max-of-two construction (§1.5) is the fix; the exactness check is what proves it worked. Note this is precisely the failure the judge diagnosed — the diagnosis was right in kind, wrong in this instance.

**R3 — the timer-less corpus cliff.** `allow_t1` is `Matchable()` but has zero candidates on any corpus written before timer firings were recorded. Without the `encoding == "none"` clause of §1.2, every such corpus grades at depth ≤ 1 and looks like a catastrophic regression. **Caught by:** run the gate's grade against one archived corpus with `TimerEncoding == "none"` if one exists, or at minimum assert in code that `depth_at_least[0] > 0` and log loudly when the clause fires.

**R4 — over-tightened greedy starving edge satisfaction.** `assignEarliestAfterPredecessors` returning early when a predecessor is unassigned leaves more labels for the swap to recover; if the swap budget is inadequate, `mean_score` drops for a reason unrelated to depth. **Caught by:** P1 (rungs 1-8 identical on the plan corpus) plus recording `mean_score` before/after in the gate output. A shift beyond a few percent warrants investigation before the epoch bump lands.

**R5 — silent pooling across the epoch.** A stale baseline cache adopted post-change would compare a 0.69% candidate against a 22.8% baseline and read as a catastrophic regression on every candidate forever. **Caught by:** the `graderVersion` terms added to `BaselineIdentity`, `identityKey`, `cacheFileFor`, `loadCache` and `tryAdoptRecord` (§4.1) — the cache *filename* changes, so the failure mode becomes "measures fresh", which is correct behaviour, not a wrong number. Verify by confirming the new cache filenames differ from the two existing ones before measuring.

**R6 — the gate is weakened to fit the result.** Restating invariant 2 because the change broke it is the single most dangerous move in this plan. **Mitigation:** the restatement is not "9 of 11 is close enough"; it is a *stronger* property (the matcher is provably optimal per run) plus a per-run proof of infeasibility for each exception, recorded with its evidence (run 2345: sole read at step 49, sole `deliver_svc_2_to_0` at step 80). If the exact-witness checker disagrees with the heuristic on even one run, the gate fails and the change does not land.

---

## 8. Order of operations and rollback

Branch: work on `research/lite` (current branch, clean apart from untracked `docs/current-plans/`). Keep every step before step 9 revertable by `git revert` of a single commit.

| # | step | revertable |
|---|---|---|
| 1 | Edit `matching.go` (§1.2-1.5), `dagorder.go:262` + the `encoding == "none"` clause, `planconfig.go:49-53` comment | yes |
| 2 | Edit `prefix_test.go` (§2), add the exact-witness helper; `go test ./metrics/...` green | yes |
| 3 | Add the `dispatch_step` reader column (§5.1); `go test ./reader/...` green | yes |
| 4 | `go build -o main main.go`; **commit 1** — "traceanalyzer: witness-complete prefix depth over direct predecessors, contraction by kind" | yes |
| 5 | Run the gate §3.1-3.5. **If any assertion fails, stop and revert commit 1.** Nothing outside `tmp/` has changed yet | yes |
| 6 | Edit `lite/grader.ts` (`graderVersionOf`, `BaselineIdentity`, `identityFor`, `identityKey`, `cacheFileFor`, `loadCache`, `tryAdoptRecord`) and `loop.ts:47`; `npm run typecheck` | yes |
| 7 | Rewrite `research/corpus/manifest.json` invariants (§4.3) from the regenerated corpora; annotate both observation logs (§4.7); edit `GOAL.md` (§4.6). **Commit 2** — "corpus: re-found the depth invariants for epoch 13" | yes |
| 8 | Re-measure both baseline caches (§4.2). Two new files appear under `research/lite/baselines/`; the two old ones are untouched and unreachable. **Commit 3** | yes |
| — | **POINT OF NO RETURN** ↓ | |
| 9 | `npm --prefix research/orchestrator run loop -- epoch bump "<reason>"` — writes `epoch = 13` to `research/state.sqlite` and appends to `research/journal.jsonl` | see below |
| 10 | `npx tsx research/lite/grader.ts selftest`; record the measured rung-6 events/chunk and MEI (§4.5); confirm PRIMARY_RUNG 6 clears the floor | yes |
| 11 | First candidate graded under epoch 13 | — |

**Why step 9 is the boundary.** Steps 1-8 are all in git and all revertable; the tree can go back to epoch-12 behaviour with three reverts plus deleting the two new baseline cache files. Step 9 mutates `research/state.sqlite`, which is not the kind of thing to undo by hand, and from that moment every earlier decision record is marked SUPERSEDED (`loop.ts:514`) and drops out of lineage scoring and the re-judge (`select.ts:89-101`). Do not bump the epoch until the gate has passed and both baselines are measured.

**To revert, keep:**
- The three commit SHAs from steps 4, 7 and 8.
- The two pre-change baseline cache files `research/lite/baselines/7555e6a5bbef-30-f9daa01b-300.json` and `...-1497728c-300.json` — under the new naming scheme they become unreachable rather than overwritten, so reverting commit 6 restores them intact. **Do not delete them.**
- `tmp/loop/judge-store`, `tmp/loop/judge-plan` and the session scratchpad (`plan_base.json`, `plan_wcnc.json`, `grade12k.json`, `grade_wcnc.json`, `ta-main`) until the gate has passed — they are the only pre-change per-run records of these corpora, and every expected number in §3 is computed from them.
- The epoch-12 value (12) noted in the journal entry, in case the state has to be walked back.

Reverting after step 9 means: revert commits 8, 7, 6, 4; delete the new cache files; and set `epoch` back to 12 with a journal entry explaining why — a manual `state.setMeta` operation with no CLI affordance, which is exactly why it is the point of no return.

---

### Critical Files for Implementation

- /home/benaepli/Rust/turnpike/traceanalyzer/metrics/dagorder/matching.go
- /home/benaepli/Rust/turnpike/traceanalyzer/metrics/dagorder/prefix_test.go
- /home/benaepli/Rust/turnpike/traceanalyzer/metrics/dagorder/dagorder.go
- /home/benaepli/Rust/turnpike/research/lite/grader.ts
- /home/benaepli/Rust/turnpike/research/corpus/manifest.json