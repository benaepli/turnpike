# Plan: randomized within-session per-run contrast as the merge primary

status: planned (operator lane, harness) | source: planner agent, 2026-09-02

I explored the full decision path and recomputed the new rule over every recorded session's chunk records. Findings and plan follow.

---

# Plan: make the randomized within-session per-run contrast the merge primary

## 0. What I measured first (this drives every threshold below)

I recomputed internal contrasts from the recorded `metrics.variants` cells in `/home/benaepli/Rust/turnpike/research/lite/state/<name>/chunk-*.cand.json`, pooling as `pooledVariantCells` does (aos excluded), for every session that carries a tagged bit. Three facts changed the design:

**(a) The naive contrast is wrong for a nested bit.** For `crash-fanout-phase-anchored-release` (bit 512) the treated cells are `{513, 517, 521, 525}` — every one carries bit 1, because the anchor only exists on placed runs. `variantContrasts` (`decide.ts:125-126`) puts *all* non-512 runs in the control, including unplaced ones, and reads **1.1904**. Restricting the control to placed runs reproduces the recorded figure: **1.0497 [1.0440, 1.0554]** against the operator's hand-computed 1.0500 [1.0448, 1.0551]. Same for bit 1024 (`activity-clock`): naive 1.1462, matched **1.0109**.

Critically, **the balance checks the judge asked for do not catch this**: on the naive 512 contrast, steps/run treated:control is 1.0071 and arm-composition L1/2 is 0.0005 — both pristine. The confound is entirely in the *co-bit* composition (placed share 1.000 vs ~0.45). So the rule must **match the control on the treated population's invariant co-bits**, not merely check margins.

**(b) The probe drop.** Where probe coverage is proportional (bits 16/32/64/256), dropping probes moves the contrast by ≤0.16% (e.g. 256: 0.9646 → 0.9650). Where the mechanism exempts probes (bits 1, 512, 1024, and iteration 8's client bit), *not* dropping biases it by +3% to +5% (client-placement: 1.0325 with probes → **0.9851** without; bit 512: 1.2449 → 1.1904). Always dropping costs ~3% of the sample and removes the whole class of confound.

**(c) The internal contrast is overdispersed chunk-to-chunk.** Iteration 16's four seeds read 1.0473 / 1.0612 / 1.0445 / 1.0460; sd(log) = 0.00734 against a mean counting SE of 0.00555. Pooling `(sd/SE)²` over 12 sessions weighted by dof gives a variance inflation of **1.26**. The binomial log-ratio SE at `decide.ts:140` is therefore optimistic by ~12%, and iteration 15's +1.1% sits at counting z = 2.84 — it would merge on the raw SE, which is the decision the operator overrode.

**(d) A declared bit whose treated *share* moved between candidate and baseline is not measurable internally.** `crash-placement-fraction-0-9` shifted bit 1's treated share 0.484 → 0.891; the candidate-side contrast (4.33) is *lower* than the baseline-side contrast (4.60), difference-in-differences 0.941 — the internal read is negative for a merge that was worth +48% per second. The effect was share, not contrast, and the internal contrast is structurally blind to it. Detectable exactly: `|shareCand − shareBase| = 0.407`, against 0.016 for `crash-placement-probe-exemption`, which is a legitimate internal case.

---

## 1. Decision rule, precisely

### New constants (`research/orchestrator/src/decide.ts`, inserted after `VARIANT_BITS` at :42-54)

```ts
export const PROBE_BIT = 2;
// Bits that name an instrument or an outcome, never a treatment. 2 and 4 are
// probe postures the loop already merged; 8 is downstream of the treatment,
// not randomized by the run id.
export const NON_DECLARABLE_BITS = [2, 4, 8] as const;

export const INTERNAL_Z = 2.7;              // = MERGE_Z, same Bonferroni argument
export const INTERNAL_MIN_EFFECT = 0.02;    // resolution floor on |r - 1|
export const INTERNAL_OVERDISPERSION = 1.3; // measured 1.26 over 12 sessions
export const TREATED_SHARE_MIN = 0.05;
export const TREATED_SHARE_SHIFT_MAX = 0.05;
export const COBIT_SHARE_MAX = 0.02;        // observed after matching: <= 0.006
export const ARM_COMPOSITION_MAX = 0.02;    // observed: <= 0.0066
export const STEPS_PER_RUN_MAX = 0.25;      // gross tripwire only
export const MATCHED_CONTROL_MIN_GRADED = 20_000;
export const CROSS_BINARY_NULL_FLOOR = 0.05; // bb-control: 0.951 on the rung
export const RULE_VERSION = "internal-primary-v1";
```

`INTERNAL_Z = 2.7`, justified against the recorded A/A on the run-cap-probe bit (`probe-phase-grid-alias-fix`, bit 2): I recompute it as **0.9760 [0.9398, 1.0136]**, SE 0.01930, so |log r|/SE = 1.26. That bit is the loop's only within-session contrast on a population that differs from its control by an instrument rather than a hypothesis, and it is 1.26 SE from unity — under z 1.96 it is already safe, and z 2.7 leaves 2.1 SE of margin while keeping the *same* familywise argument the cross-binary gate used (`decide.ts:310-311`), so the two paths are not two different confidence regimes. `INTERNAL_MIN_EFFECT = 0.02` is the second half of the criterion, and its justification is iteration 15: a reclocking verified not to have moved placement (entries-per-step constant, quantiles equal at p10/p50) still read **+1.09%** internally. Below 2% the contrast is not distinguishing mechanisms from harness residue, and residue sources are measurable — arm composition drifts up to L1/2 = 0.0066 across arms whose per-run P(d≥6) spans 0.2165–0.2487, worth ≈0.1%; co-bit shares after matching drift ≤0.6 points.

### New types

```ts
export interface InternalSide { runs: number; gradedRuns: number; events: number; rate: number;
                                meanStepsUsed: number; meanWallUs: number; planCompleteShare: number; }
export interface InternalPrimary {
  bit: number; name: string; rung: string;
  applies: boolean; inapplicableReason: string | null;
  matchedOnMask: number;            // the invariant co-bits the control was matched on
  treatedShare: { candidate: number; baseline: number | null };
  treated: InternalSide; control: InternalSide;
  ratio: number; seCount: number; seEff: number; lo: number; hi: number; z: number;
  separatedUp: boolean; separatedDown: boolean;
  balance: { cobit: Array<{bit:number;name:string;treated:number;control:number}>;
             armL1: number; stepsPerRunRatio: number | null; probeShare: {treated:number;control:number};
             faults: string[] };
  band: { min: number; max: number } | null;
  bandReading: "met" | "undecided" | "refuted" | null;
  meiAtCap: number;
  perChunkRatios: number[];
}
```

### Computation (new exported `internalPrimary(candEvals, baseEvals, bit, band, maxChunks)` in `decide.ts`, beside `variantContrasts`)

```
1. cells      := pooledVariantCells(candEvals)            // decide.ts:95-102, unchanged
   baseCells  := pooledVariantCells(baseEvals)
2. if bit is null            -> applies=false, reason "no treatment bit declared"
   if bit not in VARIANT_BITS-> applies=false, reason "bit N is not on the roster"
   if bit in NON_DECLARABLE_BITS -> applies=false, reason "bit N names an instrument/outcome"
3. scope := cells with (variant & PROBE_BIT) == 0          // ALWAYS, see section 5
4. treated := scope cells with (variant & bit) != 0
   inv := AND over treated cells (runs>0) of (variant & ~bit)      // invariant co-bits
   control := scope cells with (variant & bit) == 0 and (variant & inv) == inv
5. applies=false when: treated.graded == 0 or control.graded == 0
                       control.graded < MATCHED_CONTROL_MIN_GRADED
                       treatedShare(cand) < TREATED_SHARE_MIN
                       |treatedShare(cand) - treatedShare(base)| > TREATED_SHARE_SHIFT_MAX
                       any balance fault (section 5)
6. p1 := treated.events/treated.graded ; p2 := control.events/control.graded
   ratio := p1/p2
   seCount := sqrt((1-p1)/treated.events + (1-p2)/control.events)     // as decide.ts:140
   chunkVar := chunks >= 3 ? var(log per-chunk ratios)/chunks : 0
   seEff := sqrt(max(INTERNAL_OVERDISPERSION * seCount^2, chunkVar))
   lo,hi := ratio * exp(-/+ INTERNAL_Z * seEff)
7. if the bit is present on BOTH sides (baseline treatedShare > 0):
        ratio := ratioCand / ratioBase ; seEff := sqrt(INTERNAL_OVERDISPERSION*(seC^2+seB^2))
        (difference-in-differences; this is the probe-exemption case, DiD 1.2269, z 15.1)
8. separatedUp   := lo > 1 and (ratio - 1) >= INTERNAL_MIN_EFFECT
   separatedDown := hi < 1 and (1 - ratio) >= INTERNAL_MIN_EFFECT
9. bandReading   := band == null ? null
                  : hi < 1 + band.min ? "refuted"
                  : (ratio >= 1+band.min and ratio <= 1+band.max) ? "met" : "undecided"
10. meiAtCap := max(INTERNAL_MIN_EFFECT, INTERNAL_Z * seEff * sqrt(chunks/maxChunks))
```

### `ruleVerdict` (replacing `decide.ts:625-652`)

`MergeFigures` (`decide.ts:496-532`) gains `internal: InternalPrimary | null`, `crossBinaryNullFloor: number`, `epochThroughput: { frozenRps: number|null; cumulative: number|null; floor: number } | null`. `figuresOf` (`decide.ts:564`) takes the internal primary as a new argument computed in `finalGateParts` (`decide.ts:692`) — that function already holds `i.confirmEvals`/`i.baselineEvals`, and `FinalGateInputs` (`decide.ts:447-479`) gains a required `treatmentBit: number | null` and `perRunBand: {min,max} | null` (required, for the same reason `unmeasurable` is).

```
ruleVerdict(f):
  # --- cost blockers first: unchanged in kind, cross-binary is the honest cost read
  if f.primaryRungRegressed and |deltas["depth>=6"]| > f.crossBinaryNullFloor:
      close  "depth>=6 per second separated below the baseline at z 2.7 by more than the
              5% build-layout floor"
  if f.throughput.ratio < f.throughput.floor:
      close  "throughput ratio X below floor 0.8"
  if f.epochThroughput and f.epochThroughput.cumulative * f.throughput.ratio
                          < f.epochThroughput.floor:
      close  "merging would put cumulative throughput at X of the frozen epoch baseline,
              below the 0.90 budget"
  if f.regressed.length > 0:  close   (deep per-run guards, violations - unchanged)

  # --- the primary
  if f.internal and f.internal.applies:
      if f.internal.separatedDown:      close  "the internal contrast separated below 1.0"
      if f.internal.bandReading == "refuted":
                                        close  "the frozen per-run band is excluded by
                                                [lo, hi]"
      if not f.internal.separatedUp:
          human "the internal contrast r [lo,hi] resolves neither the mechanism nor its band"
      if f.deepRungsUnresolved.length > 0: human   (unchanged)
      merge "internal per-run contrast on depth>=6: r [lo,hi] at z 2.7, effect >= 2%"

  # --- fallback: no declared bit, a non-declarable bit, a shifted treated share,
  #     a balance fault, or a control too small
  if f.primary <= f.crossBinaryNullFloor:
      human "cross-binary depth>=6/s +X% is inside the 5% build-layout floor; with no
             declared treatment bit nothing here can separate"
  if f.improved does not include "depth>=6":
      human   (unchanged shape)
  if f.violationsOnlyImprovement: human   (unchanged)
  merge "cross-binary fallback: depth>=6/s +X% clears the 5% layout floor and separates at
         z 2.7 (no internal control declared)"
```

`mergeBlockers` (`decide.ts:655-682`) gains, in the same style: the epoch-throughput blocker, `"the declared bit's control population is unbalanced: <faults>"` (so a *supplied* merge cannot bypass the balance check), and `"the internal primary applies and did not separate"`.

`primaryRungRegressed` (`decide.ts:411-418`) keeps its body; the layout floor is applied by the callers so the function stays a pure separation test.

---

## 2. Stopping rule

`research/orchestrator/src/sequential.ts`:

- **Threading.** `PooledCounts` (`sequential.ts:32-50`) gains `variants: VariantMetrics[]`; `pooledCountsOf` (:72-92) fills it from `e.metrics.variants` (filtered by `RATE_EXCLUDED_ARM_MODES` via the chunk's own arm modes, as `pooledVariantCells` does); `emptyCounts` (:65) seeds `[]`; `pooledFromSeq` (:94-102) reads a new `SeqState.variants` field. `SeqRule` (`sequential.ts:112-117`) gains `treatmentBit: number | null` and `perRunBand: {min,max} | null`, set in `seqRuleOf` (:119-121) from a new argument. Cell counts are 30–200 per session, so the state file grows by a few kB.

- **`decideSequential` (:145-259).** After the throughput/deep-guard rails at :235-240, and *before* the cross-binary separation block at :241-247, insert:

  ```
  const ip = internalPrimary(cand.variants, base.variants, p.treatmentBit, p.perRunBand, p.maxChunks);
  if (chunks >= p.minChunks && ip.applies) {
    if (ip.separatedDown) return out("stop", `the internal per-run contrast separated below 1.0 (${ip.ratio})`);
    if (ip.bandReading === "refuted") return out("stop", `the frozen per-run band is excluded by [${ip.lo}, ${ip.hi}]`);
    if (ip.separatedUp) return out("stop", `the internal per-run contrast separated at z ${INTERNAL_Z} (${ip.ratio} [${ip.lo}, ${ip.hi}])`);
  }
  ```

  and change the cross-binary stop at :241-243 to require the delta to clear the layout floor: `sep(6) && Math.abs(d6.meanRatio - 1) > CROSS_BINARY_NULL_FLOOR`. Rationale: a +3% cross-binary separation resolves nothing (bb-control read 0.951 for identical source), so stopping on it buys a stop that cannot become a verdict. New posteriors published: `internal:ratio`, `internal:lo`, `internal:hi`, `internal:z`, `internal:mei`, `internal:applies`, `internal:share`.

- **`canStillAdvance` (:266-275)** becomes a disjunction. Keep the cross-binary projection (it still gates the fallback path) but add the internal projection when a bit is declared, since the internal SE shrinks with pooled *events* rather than exposure:

  ```
  seAtCap = ip.seEff * sqrt(chunks / p.maxChunks)
  meiAtCap = max(INTERNAL_MIN_EFFECT, INTERNAL_Z * seAtCap)
  internalCouldAdvance = ip.applies && (ip.ratio - 1) >= meiAtCap
  ```

  Worked number: at iteration 16's per-chunk counts (≈190k graded and ≈47.5k depth≥6 events per side per chunk) `seEff` at the 4-chunk cap is ≈0.0037, so `INTERNAL_Z * seAtCap` ≈ 1.0% and the 2% floor binds — `meiAtCap = 0.02`, and the observed +5.0% clears it. For a bit treating 1/32 of runs (the probe bit's shape) `seEff` at the cap is ≈0.014 and `meiAtCap` = 3.7%; that is the honest statement that a 3%-of-runs treatment cannot carry a session-level per-run claim, and is why `TREATED_SHARE_MIN = 0.05` refuses it up front.

- **`classifyPooled` / `resolvedIfStopped` (:283-288).** Body unchanged (recompute at `maxChunks = chunks`), but its *meaning* is now "the sampler's terminal reading with the internal rails in force". Because the operator's real question is what `finish` will print, `buildStatus` (`grader.ts:382-421`) additionally publishes `resolvedIfStopped.rule = ruleVerdict(figuresOf(...))` computed from the chunks in hand — the same call `cmdFinish` makes at `grader.ts:738-740`, minus the regression suite. Today the operator has to run `finish` to learn this.

---

## 3. Frozen epoch baseline

**New file `research/lite/epoch-baseline.json`** (tracked on `research/lite`, alongside `decisions.jsonl`):

```json
{
  "epoch": 8,
  "frozenAtIso": "2026-09-02T...",
  "identity": { "spurTree": "d22321ae599f...", "superCommit": "...",
                "templateSha": "1497728c...", "armIds": ["grid","grid-no-purgatory",
                "grid-post-fault-2","grid-short"], "rayonThreads": 30, "chunkSec": 300 },
  "runsPerSec": 1152.5,
  "source": "median over research/lite/baselines/d22321ae599f-30-1497728c-300.json (2 chunks)",
  "layoutNullBand": 0.05,
  "layoutSource": "bb-build-layout-control, 2026-09-02: depth>=6/s 0.9510, throughput 0.9466 for identical source",
  "merges": [
    { "atIso": "...", "name": "learned-run-cap-probe-p99", "commit": "3bb90a1",
      "ratio": 1.2009, "cumulative": 1.2009, "measuredRps": 1331.7 }
  ]
}
```

- **How it is set.** `runsPerSec` = `medianRps(pooledCountsOf(cache.chunks))` (`grader.ts:406`, `sequential.ts:321-326`) of the baseline cache belonging to the epoch's **first** session — i.e. exactly the number `cmdBaseline` already emits at `grader.ts:819`. A new command `grader.ts freeze-epoch --epoch <n>` writes the file from the current `identityFor(...)` cache and refuses to overwrite an existing epoch without `--force`. It is never written automatically: an automatic re-freeze is the compounding hole under another name.

- **How the blocker reads it.** In `cmdFinish` (`grader.ts:695-767`), after `throughputRatio` is computed at :708-710:

  ```ts
  const epoch = loadEpochBaseline();               // null -> blocker inert, reported as "unset"
  const cumulative = epoch === null ? null : epoch.merges.at(-1)?.cumulative ?? 1;
  const projected  = cumulative === null ? null : cumulative * throughputRatio;
  const measured   = epoch === null ? null
      : (candCounts.runs / candCounts.exposureSec) / epoch.runsPerSec;
  ```

  `projected < EPOCH_THROUGHPUT_FLOOR (0.90)` is a close in `ruleVerdict` and a blocker in `mergeBlockers`. `measured` is the independent cross-check: `|measured/projected − 1| > EPOCH_DRIFT_WARN (0.05)` prints an advisory ("the ledger and the measured drift disagree: host drift, a template change, or a missing ledger row"). On merge, the operator appends the row — the skill's merge procedure step 3 gains it.

- **What the ledger already says.** Reconstructing from this session: the recorded merge ratios are 1.2009, 0.9153, 1.0156, 0.9972, 0.9949, 0.9781, 1.4651 → cumulative **1.587**; measured `medianRps` moved 1152.5 → 1763.8 = **1.530**. The 3.6% gap over seven merges is the host-drift-plus-layout residue the epoch file is designed to make visible instead of silent. Note the ablation's 1.49 *raises* cumulative headroom — that is correct and is why no re-freeze is needed for a legitimate speedup; a re-freeze happens only at an epoch bump.

---

## 4. Declared bit and fallback

- **Declaration.** New `start` flags in `cmdStart` (`grader.ts:459-526`) and the parser at `grader.ts:993-1005` (value flags, so no change to the boolean list at :998):

  ```
  --treatment-bit <int>     # power of two, must be on VARIANT_BITS, not in NON_DECLARABLE_BITS
  --band-min <frac> --band-max <frac>   # the frozen per-run band, e.g. 0.05 and 0.25
  ```

  Stored in `SessionState` (`grader.ts:216-232`) as a new optional field
  `treatment?: { bit: number; name: string; band: { min: number; max: number } | null; declaredAtIso: string }`.
  `SessionState` is a plain interface with no zod schema, so old state files load unchanged (`loadState`, `grader.ts:242-250`, only validates `seq`).

  `cmdStart` **fails fast** — before a single chunk is bought — when the bit is not on the roster (`"bit 2048 is not named in VARIANT_BITS (decide.ts:42); add it in the same commit that adds the tag to run_variant.rs"`), when it is in `NON_DECLARABLE_BITS`, or when `--band-min` is given without `--band-max`. The existing practice of naming a bit in a dedicated commit ("lite: name variant bit 512 for the fan-out phase posture") becomes a hard precondition rather than a convention.

- **No declaration.** `status`/`finish` report `primaryKind: "cross-binary"` with `internal.inapplicableReason`. The rule takes the fallback branch with `CROSS_BINARY_NULL_FLOOR = 0.05`.

- **Fallback null floor: 0.05, and I would NOT automate the bb-control run.** The floor is read from `epoch-baseline.json.layoutNullBand` (default 0.05 when the file is absent), so re-measuring it updates the rule without a code change. An automatic per-session build-layout control costs a second full release build plus one or two 6-minute paired chunks *per session*, to re-measure a quantity that is a property of the toolchain and the tree, not of the candidate — and it would itself be a single sample of a 4-5% effect, so it would need chunks of its own to be worth anything. The right cadence is once per epoch (or after a toolchain change), run by the `bb-control` protocol as it was run this session, with the result written into `epoch-baseline.json`. `selftest` warns when `layoutSource` is older than the epoch's `frozenAtIso`.

- **Which candidates land in the fallback, by construction:** config-only ablations (iteration 11 — no bit to declare); whole-binary changes (iteration 14's shared hot-path cost, iteration 12's global scoring change — these *do* declare a bit, and the bit is honest, but the cross-binary throughput blocker is what catches them); parameter doses that move a treated share (iteration 7's 0.484 → 0.891); and everything recorded before the variant column existed.

---

## 5. Probe rule and balance check

**Exact replacement for `decide.ts:121-124`** (in `variantContrasts`, and the same helper used by `internalPrimary`):

```ts
  // Probes are 3% of runs, uncapped, and never placed, so they reach depth>=6
  // at a fraction of an ordinary run's rate. A mechanism that exempts them puts
  // every probe in its control and reports the exemption; one that covers them
  // in proportion loses nothing by their removal. Measured over this session's
  // records: dropping moves a proportionally-covered contrast by <= 0.16%
  // (bit 256: 0.9646 -> 0.9650) and removes a 3-5% bias where coverage is
  // partial or absent (bit 16: 1.0325 -> 0.9851; bit 512: 1.2449 -> 1.1904).
  // So probes leave every contrast except the one about probes.
  let scope = bit === PROBE_BIT ? cells : cells.filter((c) => (c.variant & PROBE_BIT) === 0);
```

The old `treatedHasProbe` test is deleted outright. The pre-drop shares are still *reported* (`balance.probeShare`) so a reader can see when the drop mattered.

**Matching, then balance.** After the drop, the control is restricted to the treated population's invariant co-bits (`inv`, section 1 step 4). This is what turns the naive 1.1904 on bit 512 into 1.0497. Then the checks, each producing a `balance.faults` entry that makes the internal primary inapplicable:

| check | constant | value | justification from the record |
|---|---|---|---|
| co-bit share, per roster bit | `COBIT_SHARE_MAX` | 0.02 | after matching, observed \|Δ\| ≤ 0.0054 (bit 1024 vs crashHoldDrawn) and 0.0007 (bit 512). Unmatched, bit 512 shows Δ = 0.55 on `crashPlaced` — this is the check that generalizes the iteration-8 probe confound to every other bit. |
| arm composition, ½·L1 over probe-free run shares | `ARM_COMPOSITION_MAX` | 0.02 | observed 0.0005–0.0066. Arms span P(d≥6) 0.2165–0.2487, so 0.02 bounds the induced bias at ≈0.3%, well under the 2% effect floor. |
| steps per run, treated:control | `STEPS_PER_RUN_MAX` | 0.25 | a *gross* tripwire only. Legitimate mechanisms move it: partition 1.075, novelty 1.020, iteration 16 1.0155. It does **not** catch the probe confound (the confounded client contrast read 1.010), which is why the co-bit check is the load-bearing one. Reported, not decisive, below 1.25. `stepsUsedSum` defaults to 0 on records written before `schemas.ts:130-132`, so the check reports "unavailable" rather than dividing by zero — six recorded sessions are in that state. |
| treated share, candidate vs baseline | `TREATED_SHARE_SHIFT_MAX` | 0.05 | probe-exemption Δ = 0.016 (internal primary applies, DiD 1.2269 z 15.1); fraction-0-9 Δ = 0.407 (routed to fallback, where its +48% merges). |
| treated share, absolute | `TREATED_SHARE_MIN` | 0.05 | at 3% of runs the MEI at the chunk cap is 3.7% and the co-bit balance is fragile. |
| matched control size | `MATCHED_CONTROL_MIN_GRADED` | 20 000 | below this the interval is wider than the effect floor at any plausible ratio. |

`planCompleteShare` and `meanWallUs` are reported beside these (all already on `VariantSide`, `decide.ts:56-62`) as mechanism cost, never as gates.

---

## 6. Reports

`status` (`buildStatus`, `grader.ts:382-421`) — keep `variantContrasts` exactly as it is (`variantReport`, :688-693; it is the survey and it is how a new bit gets sanity-checked), and add:

```json
"primary": {
  "kind": "internal",
  "bit": 512, "name": "crashPhase", "rung": "depth>=6",
  "ratio": 1.0497, "lo": 1.0394, "hi": 1.0602, "z": 13.2,
  "seCount": 0.00278, "seEff": 0.00367, "perChunkRatios": [1.0473,1.0612,1.0445,1.0460],
  "matchedOnMask": 1, "matchedOn": ["crashPlaced"],
  "treatedShare": { "candidate": 0.4457, "baseline": 0.0 },
  "meiAtCap": 0.02, "band": {"min":0.05,"max":0.05}, "bandReading": "undecided",
  "balance": { "armL1": 0.0005, "stepsPerRunRatio": 1.0155,
               "probeShare": {"treated":0.0,"control":0.0567}, "faults": [] },
  "verdict": "separated up at z 2.7"
},
"cost": {
  "label": "cross-binary depth>=6 per explore-second - COST AND REGRESSION ONLY, not the primary",
  "ratio": 1.0301, "nullBand": 0.0023, "layoutFloor": 0.05,
  "insideLayoutFloor": true,
  "throughput": { "ratio": 1.0056, "floor": 0.8,
                  "epoch": { "frozenRps": 1152.5, "cumulative": 1.587,
                             "projected": 1.596, "measured": 1.530, "floor": 0.90 } }
}
```

`adviceOf` (`grader.ts:342-362`) gains three lines: the internal verdict in words; `"the cross-binary rung ratio X sits inside the 5% build-layout floor: it is a cost reading, not evidence of a gain"` whenever `|ratio−1| < layoutFloor`; and `"no treatment bit was declared, so this session is on the cross-binary fallback path (null floor 5%)"`. The existing null-band advice at :345-348 is retitled to say "cost rung".

`finish` (`grader.ts:743-766`) emits the same `primary`/`cost` blocks plus `ruleVersion: RULE_VERSION`, `primaryKind`, and keeps `adviceVerdict`/`adviceReason`/`blockers` unchanged in shape. The `comparison` block at :746-757 stays (it is the cost read) with its key renamed in the doc, not in the JSON, so existing readers do not break.

---

## 7. Skill and template

In `/home/benaepli/Rust/turnpike/.claude/skills/research-loop-lite/SKILL.md`:

- **:175-181** (proposer constraints). The tagging bullet becomes mandatory-with-consequence and the prediction bullet moves to per-run terms:

  > - Every hypothesis carries a frozen prediction: the **declared variant bit**, the rung, the **band on the per-run ratio** of treated to untreated runs, the firing counter, and the falsifier. The prediction is graded, never rewritten.
  > - If the mechanism can be turned off for part of a session's runs, it **must** be: turn it off for a randomized part of them and tag those runs (`spur/spur-core/src/simulator/run_variant.rs`), declare the bit at `start`, and register its name in `VARIANT_BITS` (`research/orchestrator/src/decide.ts:42`) in the same commit. The untreated remainder is the control the merge is decided on. A mechanism with no internal control can only be graded on the cross-binary rung, where nothing under 5% separates.

- **:290-295** (how to read the status). Replace with: `primary` carries the merge criterion — the randomized per-run contrast, its interval, `meiAtCap`, and its band reading; `cost` carries the cross-binary per-second rung and throughput, which can only block.

- **:297-314** (when to stop). Add: stop when `primary.verdict` separates in either direction or reads `refuted`; the cross-binary bullet gains "and its ratio is outside the 5% build-layout floor".

- **:316-336** (decision checklist). Rewrite the three bullets:
  - **Close** when the internal contrast separates below 1.0, or its interval excludes the frozen band; when the cross-binary rung is separated below the baseline by more than 5%; when throughput is below the floor or a merge would put cumulative throughput under 0.90 of the frozen epoch baseline; when anything is in `regressed`; when the suite failed; when the mechanism never fired.
  - **File for the user** when the internal primary applies and resolves neither way; when `balance.faults` is non-empty; plus the existing cases.
  - **Merge** only when the internal contrast separates above 1.0 at z 2.7 with an effect of at least 2%, no blocker stands, the firing counter shows occasions, and `finish --regression` passed. The A/A control chunk requirement at :335-336 is **replaced** by the layout statement: a same-binary A/A cannot see build layout (iteration 15); the internal contrast is what carries a small effect.

- **:338-344** (the variantContrasts paragraph) is rewritten to say the contrast is now the gate, with the two standing caveats kept verbatim in substance: it is blind to shared hot-path cost (iteration 14) and it measures a marginal effect where the mechanism feeds a session-global learner.

- **:400-404** (decisions.jsonl shape) gains `"ruleVersion"`, `"primaryKind"`, `"treatmentBit"`, `"internalRatio"`, `"internalLo"`, `"internalHi"`, `"epochCumulativeThroughput"`.

- **:378-395** (merge procedure) gains a step: append the merge's row to `research/lite/epoch-baseline.json` (`name`, `commit`, `ratio`, `cumulative`, `measuredRps` after the rebuild at step 4).

**Draft frozen-prediction template (new block for the proposer/judge prompts, replacing the sizePct-on-per-second language):**

> **Frozen prediction** (all five fields required; graded, never rewritten)
> - **Treatment bit**: `<name>` = `1 << k`, registered in `run_variant.rs` and `VARIANT_BITS`. Treated share: `<f>` of runs, drawn by run id. If the mechanism cannot be turned off per run, say so here and name the reason; the candidate is then graded on the cross-binary rung, where nothing under +5% separates.
> - **Rung and band**: on `depth>=6`, the **per-run ratio** of treated to untreated runs in the same session, probe-free and matched on co-bits, will land in **[1.05, 1.25]**. (Not a per-second figure: per-second mixes throughput and 4-5% of build-layout noise.)
> - **Firing counter**: `<dotted.path>` in `utilization.json` at or above `<floor>` per chunk.
> - **Independent observable**: `<something the rung does not measure>`, expected `<value>`.
> - **Falsifier**: the prediction is refuted if the contrast's 2.7-sigma interval lies entirely below 1.05, or if `<observable>` moves the wrong way. State the sign explicitly; "no effect" is refutation only if the band's lower edge is above 1.
> - **Cost clause**: cross-binary throughput will stay at or above `<floor>` of the paired baseline; a shared hot-path cost is invisible to the contrast and must be read here.

---

## 8. Paper replay validation

**Script sketch: `research/lite/replay-lite.ts`** (modelled on `research/orchestrator/src/replay.ts`, which already has the `--assert` + expectations-table shape; run as `cd research/orchestrator && npx tsx ../lite/replay-lite.ts [--assert]`).

```ts
// For every research/lite/state/<name>.json:
//   1. load the session's chunk records: state/<name>/chunk-*.cand.json  (Evaluation.safeParse)
//   2. load its paired baseline: loadCache(state.cacheFile).chunks filtered to state.usedSeeds
//   3. take the declared bit and band from a REPLAY_DECLARATIONS table below (the sessions
//      predate the flag; the table records what each candidate would have declared, taken
//      from research/lite/observations.md, and is asserted against the tag actually present
//      in the cells so it cannot be invented)
//   4. build FinalGateInputs exactly as cmdFinish does (grader.ts:724-737), with
//      regressionPassed from decisions.jsonl, throughputRatio recomputed from the counts
//   5. verdict := ruleVerdict(figuresOf(...)) ; blockers := mergeBlockers(...)
//   6. print old (decisions.jsonl verdict) vs new, plus primaryKind and the internal figures
//   7. --assert: fail on any row whose new verdict differs from EXPECTED below
```

`REPLAY_DECLARATIONS` (bit, band) and `EXPECTED` are the assertion table. Verified by direct recomputation over the recorded cells:

| session (iteration) | declared bit | internal (matched, probe-free) | cross-binary d≥6/s | new verdict | recorded |
|---|---|---|---|---|---|
| `crash-placement-completion-span-draw` (5) | none on disk | — (no variant cells) | 2.3903, thr 0.997 | **merge** (fallback, ≫5%) | merge |
| `learned-run-cap-probe-p99` | none on disk | — | 1.1618, thr 1.2009 | **merge** (fallback) | merge |
| `timer-admission-context-odds-probe` | none on disk | — | 1.1901, thr 0.9153 | **merge** (fallback) | merge |
| `crash-placement-probe-exemption` (6) | 1, both sides, Δshare 0.016 | DiD **1.2269**, z 15.1 | 1.1508 | **merge** (internal) | merge |
| `crash-placement-fraction-0-9` (7) | 1, Δshare **0.407** → inapplicable | (DiD 0.941, correctly discarded) | 1.4831 | **merge** (fallback) | merge |
| `client-request-placement-span-draw` (8) | 16 | **0.9851 [0.9758,0.9944]**, z −2.73 | 1.0097 | **close** (separated down) | close |
| `stale-incarnation-order-stratification` (9) | 16 | **0.9960 [0.9855,1.0072]**, z −0.83 | 1.0156 | **close** (band 1.04 excluded: hi 1.0072) | close |
| `restart-latency-foreign-progress-draw` (10) | 32 | **0.9856 [0.9711,1.0004]**, z −2.69 | 1.0407 | **close** (band 1.10 excluded) | close |
| `purgatory-blind-delay-default-ablation` (11) | **none** (config-only) | — (bit 1 is unrelated; declaring it would give a spurious DiD 1.0896 — this row is the test that an undeclared bit is not invented) | 1.4651, thr 1.4907 | **merge** (fallback) | merge |
| `timeline-novelty-scalefree-rarity-restore` (12) | 64 | **0.9785**, z −2.87 | 0.8065, thr 0.8064 | **close** (throughput floor first) | close |
| `partition-fault-class-restore-with-repair-hold` (13) | 128 | **0.7914 [0.7813,0.8016]**, z −47 | 0.8635 | **close** | close |
| `directed-link-speed-class-run-skew` (14) | 256 | **0.9650**, z −6.8 | 0.7663, thr 0.7671 | **close** (throughput floor) | close |
| `activity-clock-crash-placement` (15) | 1024, matched on bit 1 | **1.0109 [0.9992,1.0227]**, z **2.48** | 1.0659, thr 1.0498 | **human**, not merge (band 1.04 excluded → **close**) | close (operator override of a typed merge) |
| `crash-fanout-phase-anchored-release` (16) | 512, matched on bit 1 | **1.0497 [1.0394,1.0602]**, z 13.2 | 1.0301, thr 1.0056 | **MERGE** | filed for the user |
| `probe-phase-grid-alias-fix` | bit 2 → non-declarable | (A/A reference 0.9760 ± 0.0193) | 1.0323 (<5% floor) | **human** | human, then operator override on correctness |
| `timer-refire-outcome-quantile` | none | — | 1.0364 (<5% floor) | **human/close** | close |
| `aa-check`, `aa-drift-check{,-2}`, `aa-runcap-freeze-{1,2}`, `aa-timer-context-check`, `aa-control-ablation-1`, `bb-build-layout-control`, `dry-fanout-bias`, `runcap-freeze-vs-merged` | controls | reported, no verdict asserted | | | |

Two rows are the point of the exercise: **iteration 15 stops being a typed merge** (it merges today at counting z 2.84; the 1.3 overdispersion charge puts it at 2.48 and the 2% floor blocks it independently), and **iteration 16 becomes a merge** on 1.0497 [1.0394, 1.0602].

**Records on disk.** All 26 sessions still have their `chunk-*.cand.json` files. **14 carry `metrics.variants`**: `aa-control-ablation-1`, `activity-clock-crash-placement`, `bb-build-layout-control`, `client-request-placement-span-draw`, `crash-fanout-phase-anchored-release` (4 chunks), `crash-placement-fraction-0-9`, `crash-placement-probe-exemption`, `directed-link-speed-class-run-skew`, `partition-fault-class-restore-with-repair-hold`, `probe-phase-grid-alias-fix`, `purgatory-blind-delay-default-ablation`, `restart-latency-foreign-progress-draw`, `stale-incarnation-order-stratification`, `timeline-novelty-scalefree-rarity-restore`. **12 predate the variant column** and replay only on the fallback path: `aa-check`, `aa-drift-check`, `aa-drift-check-2`, `aa-runcap-freeze-1`, `aa-runcap-freeze-2`, `aa-timer-context-check`, `crash-placement-completion-span-draw`, `dry-fanout-bias`, `learned-run-cap-probe-p99`, `runcap-freeze-vs-merged`, `timer-admission-context-odds-probe`, `timer-refire-outcome-quantile`. Every paired baseline cache under `research/lite/baselines/` is present (9 files), so step 2 resolves for all of them.

---

## 9. Selftest

`cmdSelftest` (`grader.ts:824-881`) gains a new `selfTestInternalPrimary()` exported from `decide.ts` (beside `selfTestUnmeasured` at :798) plus live checks:

1. **Probe rule.** A synthetic cell table where the treated half exempts probes: the contrast with probes in the control must differ from the probe-free one, and `internalPrimary` must return the probe-free number. A table where probe coverage is proportional: the two must agree to within 0.5%.
2. **Matching.** A nested bit (treated ⊂ placed): the matched control must equal the placed-and-untreated population, `matchedOnMask` must equal the nesting bit, and the unmatched ratio must be rejected — asserted numerically against the recorded iteration-16 cells (1.1904 unmatched, 1.0497 matched), read from `state/crash-fanout-phase-anchored-release/`, skipped with a note if the directory is gone.
3. **Balance.** A fabricated table with a 6-point co-bit share gap must produce a `balance.faults` entry and `applies=false`; the recorded matched sessions must produce **no** faults (this is the assertion that the tolerances are not so tight they refuse real evidence).
4. **Overdispersion calibration.** Recompute `(sd(log per-chunk ratio) / meanSE)²` over every recorded session with ≥2 chunks and a declared-bit table; fail when the dof-weighted mean exceeds `INTERNAL_OVERDISPERSION` — the same shape as the existing `rungCv > 0.025` assertion at `sequential.ts:550-553`, so the constant cannot go stale. (Today: 1.26 against 1.3.)
5. **Share-shift guard.** The `crash-placement-fraction-0-9` cells must set `applies=false` with reason `treated share shifted`; `crash-placement-probe-exemption` must set `applies=true` and take the DiD branch.
6. **Rule/sampler agreement.** Extend `selfTestGateConsistency` (`sequential.ts:412`): a synthetic candidate whose internal contrast separates up must both `stop` in `decideSequential` and `merge` in `ruleVerdict`; one that separates down must `stop` and `close`; one inside the floor must not stop on the internal rail. Same contradiction argument as the existing cases at :463-474.
7. **Declaration hygiene.** Every bit in `VARIANT_BITS` (`decide.ts:42-54`) must appear as `pub const` in `spur/spur-core/src/simulator/run_variant.rs` with a matching value — a source read like the `loop.ts` greps at `decide.ts:925-935`. This catches a roster entry whose tag was never merged (bits 16–1024 are currently in that state, so the check must be a **warning** listing them, and an error only for bits a live session declares).
8. **Epoch file.** When `research/lite/epoch-baseline.json` exists: its identity must match the current `identityFor(...)`; `merges[].cumulative` must equal the running product of `ratio` to 1e-9; the cumulative must be within `EPOCH_DRIFT_WARN` of `medianRps(currentCache)/runsPerSec` or a warning is emitted; `layoutSource` must not predate `frozenAtIso`.

---

## 10. Risk flags and what does not change

**Unchanged.** No epoch bump — `Evaluation`, `LadderMetrics`, `VariantMetrics` (`schemas.ts:80-134`) and `CampaignMetrics` are untouched, so every recorded chunk stays comparable and poolable; `CAMPAIGN_EPOCH_FLOOR` (`decide.ts:247`) is not moved. Baselines under `research/lite/baselines/` and every corpus and oracle are untouched. `RATE_EXCLUDED_ARM_MODES` (:29), `nullBand` (:235), `rateVarianceOf` (:225), `primaryRungRegressed` (:411), the deep per-run guards (`DEEP_GUARD_RUNGS`, `DEEP_RUNG_MARGIN`), the violation prior, the firing check, the stratum-fault hard stops (:539-546), `classifyChunkTiming`, and the whole `perfGate` path all keep their behaviour. `variantContrasts` keeps its reporting role — only its probe branch changes.

**graderVersion and pooling.** `graderVersionOf` (`grader.ts:93-97`) is a *measurement* identity (traceanalyzer + porcupine commits) and must not change: nothing about how a chunk is measured changed, so old and new chunk records still pool, and the baseline caches stay valid. What changes is the *verdict* semantics, and that is marked separately: `RULE_VERSION = "internal-primary-v1"` is emitted on every `finish` and written into `decisions.jsonl` as `ruleVersion` alongside `primaryKind`. Records with neither field are v0 by absence — that is how `replay-lite.ts` knows a row was decided under the cross-binary primary, and it is the same convention `Evaluation.epoch` uses (`schemas.ts:308`).

**Risks, in the order I would worry about them:**

1. **The internal contrast measures a marginal effect under shared session state.** Crash placement reads 4.58 internally and 1.15 in total, because the placed and stock populations share the learners. Merging on the internal alone would license a mechanism whose marginal effect is positive and whose total effect is negative (a poisoned learner). Mitigations: the cross-binary per-second rung remains a two-sided blocker, so a total regression beyond the 5% floor still closes; and `finish` prints the implied total, `1 + f(r − 1)`, beside the measured cross-binary per-run ratio, so a gross disagreement is on the page. The `crash-placement-fraction-0-9` prediction was derived from exactly that identity and landed within 1%, so the coherence check has a precedent.
2. **Blindness to shared hot-path cost** (iteration 14: 23% throughput lost by *both* halves; treated wall 1.010x untreated). Handled only by the cross-binary throughput blocker and the new epoch-cumulative blocker. If someone later weakens either, this rule loses its cost read entirely — the selftest should carry a comment saying so.
3. **New gaming surface: pick a favourable sub-population and tag it.** Bounded by `TREATED_SHARE_MIN`, the co-bit matching, the arm-composition check, and the requirement that the bit be randomized by run id in `run_variant.rs` (a source-level review point the skill's "read the patch before merging" step already owns). It is not eliminated; a candidate that tags "runs where the mechanism happened to help" would pass. The `CRASH_HOLD_DRAWN` bit is precisely such an outcome-conditioned tag, which is why it is in `NON_DECLARABLE_BITS`.
4. **Two chunks give one degree of freedom** for the dispersion term, so `chunkVar` is inert at the usual sample size and the fixed 1.3 inflation carries the whole correction. If a future arm change re-inflates dispersion, selftest check 4 fires before a verdict does.
5. **The 2% floor refuses real small effects.** Deliberate: merges compound, and the loop has now recorded a +1.1% internal reading from a mechanism verified not to have changed what it claimed. The escape hatch is the one the skill already has — the operator may depart from the rule with a written reason, as they did for `probe-phase-grid-alias-fix`.
6. **`SeqState` grows** by the variant cells (a few kB). `SeqState.variants` must default to `[]` (`schemas.ts:369-401`) so states written before the change still parse, and `pooledFromSeq` must tolerate the empty array as "no internal primary" rather than as "no treated runs".

---

### Critical files for implementation

- `/home/benaepli/Rust/turnpike/research/orchestrator/src/decide.ts`
- `/home/benaepli/Rust/turnpike/research/orchestrator/src/sequential.ts`
- `/home/benaepli/Rust/turnpike/research/lite/grader.ts`
- `/home/benaepli/Rust/turnpike/research/orchestrator/src/stopper.ts`
- `/home/benaepli/Rust/turnpike/.claude/skills/research-loop-lite/SKILL.md`