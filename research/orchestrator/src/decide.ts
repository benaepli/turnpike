// Deterministic acceptance gates. Every verdict is code, not model judgment.
// Objectives, in priority order:
//   1. violations (porcupine ground truth)
//   2. prefix-depth rung events per explore-second, depth>=6 first, then 5
//      and 4; depth>=7 and 8 are recorded, never decided on
//   3. H2 stale-incarnation rate, recorded
// One reading of the evidence, whatever the hypothesis claims: a separated
// improvement on at least one objective, no separated regression, and
// throughput at or above the floor. A sample that resolves nothing merges
// nothing, because a merge spends a merge and moves the baseline the next
// candidate is measured against.
import type { BenchResult } from "./bench.js";
import type { Evaluation, GateDecision, Hypothesis, HypothesisKind, Prediction, RateStratum, VariantMetrics } from "./schemas.js";
import { aggregateDepthCounts, aggregateViolations, sumVariantCells } from "./evaluate.js";
import { firingIsHarnessGap, firingPasses, type FiringResult } from "./firing.js";
import { compareRatesPoisson, rateSuperiorCI, rateRatioSeparated, throughputCv } from "./stats.js";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { ROOT } from "./paths.js";

// Arms whose events feed the rate the gate separates on. An aos arm refines
// a recorded tape, so one deep lineage compounds inside a session: on the
// recorded baseline its depth>=6 per-second chunk cv is 22.3% against 1.4%
// for the four grid arms, and pooling it put the pooled rate at 3.1% - five
// times the variance, so MERGE_Z 2.7 was separating like z 1.2. The arm
// keeps its wall, its violations, the per-run guards and the jackpot path;
// it leaves the rate estimator only. Selected by mode, so an aos arm added
// under another id is excluded with it.
export const RATE_EXCLUDED_ARM_MODES: readonly string[] = ["aos"];

// The run tag's bits, as `run_variant.rs` defines them. A mechanism that
// treats part of a session's runs makes the untreated remainder its own
// control: same host, same binary, same learner trajectory, randomized by
// run id. That contrast is immune to the between-process drift that a
// candidate-versus-baseline ratio carries, so where it exists it is the
// stronger evidence.
//
// It measures the marginal effect of treating one more run given the
// session's shared state, which equals the total effect only when the
// mechanism feeds no shared state. Where it does - a learner both
// populations write to - the cross-binary comparison is still the tool.
export const VARIANT_BITS: ReadonlyArray<{ bit: number; name: string }> = [
  { bit: 1, name: "crashPlaced" },
  { bit: 2, name: "runCapProbe" },
  { bit: 4, name: "timerSteerOff" },
  { bit: 8, name: "crashHoldDrawn" },
  { bit: 16, name: "staleOrder" },
  { bit: 32, name: "restartLatency" },
  { bit: 64, name: "noveltyOn" },
  { bit: 128, name: "partitioned" },
  { bit: 256, name: "linkSpeed" },
  { bit: 512, name: "crashPhase" },
  { bit: 1024, name: "entryClock" },
  { bit: 16384, name: "crashPhaseReaction" },
  { bit: 65536, name: "ghostPeerAnswer" },
  { bit: 524288, name: "ghostAbsorberRetarget" },
  { bit: 8388608, name: "ghostAbsorberRedraw" },
  { bit: 1048576, name: "replaySlot" },
  { bit: 2097152, name: "replayPrefix" },
  { bit: 33554432, name: "ghostPendingTimerHold" },
  { bit: 67108864, name: "ghostPendingTimerHoldLong" },
];

// The tag that marks a run-cap probe. Probes are about 3% of runs, are
// uncapped and are never placed, so they reach the deep rungs at a fraction
// of an ordinary run's rate.
export const PROBE_BIT = 2;
// The timer-steer probes, exempt from treatments the same way.
export const TIMER_PROBE_BIT = 4;
// Bits that name an instrument or an outcome, never a treatment. 2 and 4 are
// probe postures the loop already merged; 8 is downstream of the treatment
// rather than randomized by the run id, so a candidate could choose it after
// seeing which runs it helped.
export const NON_DECLARABLE_BITS: readonly number[] = [2, 4, 8];

// The internal contrast's own thresholds. The z is MERGE_Z, so the two paths
// are one confidence regime rather than two.
export const INTERNAL_Z = 2.7;
// Resolution floor on |r - 1|. Below it the contrast is not distinguishing a
// mechanism from harness residue: a reclocking verified not to have moved
// placement still read +1.1%, and arm composition and co-bit drift are worth
// a few tenths of a percent on their own.
export const INTERNAL_MIN_EFFECT = 0.02;
// The binomial log-ratio standard error is optimistic chunk to chunk. Over
// the recorded sessions the dof-weighted (sd/SE)^2 is 1.26; the selftest
// recomputes it, so an arm change that re-inflates dispersion is caught
// before a verdict is.
export const INTERNAL_OVERDISPERSION = 1.3;
// A treatment thinner than this cannot carry a session-level per-run claim:
// at 3% of runs the minimum separable effect at the chunk cap is near 4%.
export const TREATED_SHARE_MIN = 0.05;
// A bit whose treated share moved between candidate and baseline measures a
// dose, not a contrast, and the internal read is structurally blind to it.
export const TREATED_SHARE_SHIFT_MAX = 0.05;
// Balance tolerances on the matched control. After matching, the recorded
// sessions sit at 0.006 and 0.0066; unmatched, a nested bit shows 0.55.
export const COBIT_SHARE_MAX = 0.02;
export const ARM_COMPOSITION_MAX = 0.02;
// A gross tripwire only: legitimate mechanisms move steps per run by a few
// percent, and this does not catch the co-bit confound.
export const STEPS_PER_RUN_MAX = 0.25;
// Below this the interval is wider than the effect floor at any plausible
// ratio, so the contrast could not resolve the mechanism either way.
export const MATCHED_CONTROL_MIN_GRADED = 20_000;
// Two builds of identical source differ by their layout: the recorded
// build-layout control read depth>=6 per second at 0.951. A cross-binary
// ratio inside this band is a cost reading, not evidence of a gain.
export const CROSS_BINARY_NULL_FLOOR = 0.05;
// Cumulative throughput a merge may leave the epoch at, against the frozen
// epoch baseline, and the disagreement between ledger and measurement that
// is worth an advisory.
export const EPOCH_THROUGHPUT_FLOOR = 0.9;
export const EPOCH_DRIFT_WARN = 0.05;
// Verdict semantics, not measurement identity: a decision record carries the
// rule version it was decided under, and the rung table is keyed on it so a
// recorded decision replays on the rungs it was made on. Absence reads as
// the first internal-primary version, which decided on depth>=6.
export const RULE_VERSION_V1 = "internal-primary-v1";
export const RULE_VERSION_V2 = "internal-primary-v2";
export const RULE_VERSION = RULE_VERSION_V2;

/** The rungs a rule version decides on. `primary` names the objective.
 *  `advance` are the per-second rungs a separated gain may carry a merge on,
 *  the primary among them. `deepGuard` are the rungs whose per-run rate may
 *  not fall beyond the margin. `reported` are the rungs every readout and
 *  posterior covers; a rung deeper than the record's ladder reads as zero
 *  events. Under v2 the oracle ladder is 20 labels deep and depth>=8 is the
 *  first rung that carries a recovery-timing condition while still clearing
 *  the power floor (about 6,600 events a 300 s chunk against 984 at depth>=9
 *  and 46 at depth>=10); depth>=6 stays guarded because it is the rung every
 *  epoch is compared on. */
export interface RuleRungs {
  primary: number;
  advance: readonly number[];
  deepGuard: readonly number[];
  reported: readonly number[];
}
const RULE_RUNGS_V1: RuleRungs = { primary: 6, advance: [4, 5, 6], deepGuard: [5, 6], reported: [4, 5, 6, 7, 8] };
const RULE_RUNGS_V2: RuleRungs = { primary: 8, advance: [8, 9, 10], deepGuard: [6, 8], reported: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13] };
export function ruleRungsFor(ruleVersion: string | null | undefined): RuleRungs {
  if (ruleVersion === RULE_VERSION_V2) return RULE_RUNGS_V2;
  if (ruleVersion === RULE_VERSION_V1 || ruleVersion === null || ruleVersion === undefined) return RULE_RUNGS_V1;
  throw new Error(`unknown rule version ${ruleVersion}`);
}
export function primaryRungFor(ruleVersion: string | null | undefined): number {
  return ruleRungsFor(ruleVersion).primary;
}
// The live rule's rungs. Anything deciding a recorded session passes that
// record's version instead of reading these.
export const PRIMARY_RUNG = ruleRungsFor(RULE_VERSION).primary;
export const ADVANCE_RUNGS = ruleRungsFor(RULE_VERSION).advance;
export const DEEP_GUARD_RUNGS = ruleRungsFor(RULE_VERSION).deepGuard;
export const REPORTED_RUNGS = ruleRungsFor(RULE_VERSION).reported;
// Events per chunk the primary rung has to carry for a 10% effect to be
// separable at the chunk cap; a rung below it is recorded, never decided on.
export const PRIMARY_RUNG_MIN_EVENTS_PER_CHUNK = 1000;

export interface VariantSide {
  runs: number;
  gradedRuns: number;
  meanWallUs: number;
  meanStepsUsed: number;
  planCompleteShare: number;
}

export interface VariantContrast {
  bit: number;
  name: string;
  treated: VariantSide;
  control: VariantSide;
  // Per rung: the treated group's share of graded runs reaching the rung
  // over the control group's, with a 95% interval on the log ratio.
  rungs: Array<{ rung: string; treatedRate: number; controlRate: number; ratio: number; lo: number; hi: number }>;
}

function variantSide(cells: VariantMetrics[]): { side: VariantSide; depth: number[] } {
  const runs = cells.reduce((a, c) => a + c.runs, 0);
  const gradedRuns = cells.reduce((a, c) => a + c.gradedRuns, 0);
  const wall = cells.reduce((a, c) => a + c.wallUsSum, 0);
  const steps = cells.reduce((a, c) => a + c.stepsUsedSum, 0);
  const complete = cells.reduce((a, c) => a + c.planCompleteRuns, 0);
  const width = Math.max(0, ...cells.map((c) => c.depthAtLeast.length));
  const depth = Array.from({ length: width }, (_, i) => cells.reduce((a, c) => a + (c.depthAtLeast[i] ?? 0), 0));
  return {
    side: {
      runs,
      gradedRuns,
      meanWallUs: runs > 0 ? wall / runs : 0,
      meanStepsUsed: runs > 0 ? steps / runs : 0,
      planCompleteShare: runs > 0 ? complete / runs : 0,
    },
    depth,
  };
}

/** The cells of every chunk, pooled, with the arms the rate excludes dropped. */
export function pooledVariantCells(evals: Evaluation[]): VariantMetrics[] {
  const lists: VariantMetrics[][] = [];
  for (const e of evals) {
    const modes = new Map((e.metrics.campaign?.arms ?? []).map((a) => [a.id, a.mode]));
    lists.push(e.metrics.variants.filter((c) => !RATE_EXCLUDED_ARM_MODES.includes(modes.get(c.arm) ?? "")));
  }
  return sumVariantCells(lists);
}

/** Probes leave every contrast except the one about probes.
 *
 * A mechanism that exempts run-cap probes puts every probe in its control,
 * which at the session's probe rate roughly doubles their weight there, and
 * probes reach the deep rungs at a fraction of an ordinary run's rate. A
 * mechanism that covers them in proportion loses nothing by their removal:
 * over the recorded sessions the drop moves a proportionally covered
 * contrast by at most 0.16% and removes a 3-5% bias where coverage is
 * partial or absent. */
export function probeFreeScope(cells: VariantMetrics[], bit: number): VariantMetrics[] {
  // Both probe populations leave the scope: the run-cap probes and the
  // timer-steer probes. A treatment that exempts one of them would otherwise
  // face a control that still carries it, and every co-bit share would tilt.
  if (bit === PROBE_BIT) return cells;
  if (bit === TIMER_PROBE_BIT) return cells.filter((c) => (c.variant & PROBE_BIT) === 0);
  return cells.filter((c) => (c.variant & (PROBE_BIT | TIMER_PROBE_BIT)) === 0);
}

/** One contrast per tag bit that both populations of these chunks carry.
 *  Reporting: the survey a new bit is sanity-checked against. The control
 *  here is every untreated run, not the matched population the merge
 *  primary uses, so a nested bit reads its host population's rate. */
export function variantContrasts(evals: Evaluation[]): VariantContrast[] {
  const cells = pooledVariantCells(evals);
  const out: VariantContrast[] = [];
  for (const { bit, name } of VARIANT_BITS) {
    const scope = probeFreeScope(cells, bit);
    const t = variantSide(scope.filter((c) => (c.variant & bit) !== 0));
    const u = variantSide(scope.filter((c) => (c.variant & bit) === 0));
    if (t.side.gradedRuns === 0 || u.side.gradedRuns === 0) continue;
    const width = Math.max(t.depth.length, u.depth.length);
    const rungs: VariantContrast["rungs"] = [];
    for (let i = 0; i < width; i++) {
      const a = t.depth[i] ?? 0;
      const b = u.depth[i] ?? 0;
      if (a === 0 && b === 0) continue;
      const p1 = a / t.side.gradedRuns;
      const p2 = b / u.side.gradedRuns;
      const ratio = p2 > 0 ? p1 / p2 : 0;
      // Log-ratio standard error for two binomial proportions; undefined
      // when either count is zero, which is reported as an open interval
      // rather than a fabricated one.
      const se = a > 0 && b > 0 ? Math.sqrt((1 - p1) / a + (1 - p2) / b) : NaN;
      rungs.push({
        rung: `depth>=${i + 1}`, treatedRate: p1, controlRate: p2, ratio,
        lo: Number.isFinite(se) ? ratio * Math.exp(-1.96 * se) : 0,
        hi: Number.isFinite(se) ? ratio * Math.exp(1.96 * se) : Infinity,
      });
    }
    out.push({ bit, name, treated: t.side, control: u.side, rungs });
  }
  return out;
}

/** One side of the internal contrast at the rung the objective is named on. */
export interface InternalSide {
  runs: number;
  gradedRuns: number;
  events: number;
  rate: number;
  meanStepsUsed: number;
  meanWallUs: number;
  planCompleteShare: number;
}

/** The randomized within-session per-run contrast a declared treatment bit
 *  carries: treated runs against the untreated runs of the same session,
 *  probe-free and matched on the treated population's invariant co-bits.
 *  `applies` false means the session has no such contrast and the verdict
 *  falls back to the cross-binary rung. */
export interface InternalPrimary {
  bit: number;
  name: string;
  rung: string;
  applies: boolean;
  inapplicableReason: string | null;
  // The co-bits the control was matched on, as a mask.
  matchedOnMask: number;
  matchedOn: string[];
  // Treated share of all runs, probes included. null on the baseline side
  // means the baseline carries no run with the bit, so there is nothing to
  // difference against and the candidate-side ratio stands alone.
  treatedShare: { candidate: number; baseline: number | null };
  treated: InternalSide;
  control: InternalSide;
  ratio: number;
  seCount: number;
  seEff: number;
  lo: number;
  hi: number;
  z: number;
  separatedUp: boolean;
  separatedDown: boolean;
  differenceInDifferences: boolean;
  balance: {
    cobit: Array<{ bit: number; name: string; treated: number; control: number }>;
    armL1: number;
    stepsPerRunRatio: number | null;
    probeShare: { treated: number; control: number };
    faults: string[];
  };
  band: { min: number; max: number } | null;
  bandReading: "met" | "undecided" | "refuted" | null;
  meiAtCap: number;
  perChunkRatios: number[];
}

function bitNameOf(bit: number): string {
  return VARIANT_BITS.find((v) => v.bit === bit)?.name ?? `bit ${bit}`;
}

function sideAt(cells: VariantMetrics[], k: number): InternalSide {
  const { side, depth } = variantSide(cells);
  const events = depth[k - 1] ?? 0;
  return {
    runs: side.runs,
    gradedRuns: side.gradedRuns,
    events,
    rate: side.gradedRuns > 0 ? events / side.gradedRuns : 0,
    meanStepsUsed: side.meanStepsUsed,
    meanWallUs: side.meanWallUs,
    planCompleteShare: side.planCompleteShare,
  };
}

/** The tags every treated run carries beside the treatment. A bit that only
 *  exists on a sub-population - an anchor that only placed runs can have -
 *  makes its whole host population invariant, and a control drawn without it
 *  reports the host population's rate rather than the mechanism's. */
export function invariantCoBits(treated: VariantMetrics[], bit: number): number {
  let inv: number | null = null;
  for (const c of treated) {
    if (c.runs <= 0) continue;
    const m = c.variant & ~bit;
    inv = inv === null ? m : inv & m;
  }
  return inv ?? 0;
}

interface RawContrast {
  treated: InternalSide;
  control: InternalSide;
  ratio: number;
  se: number;
  inv: number;
  treatedCells: VariantMetrics[];
  controlCells: VariantMetrics[];
}

/** The matched contrast on one body of cells: probes dropped, the control
 *  restricted to the treated population's invariant co-bits. */
function matchedContrast(cells: VariantMetrics[], bit: number, k: number): RawContrast {
  const scope = probeFreeScope(cells, bit);
  const treatedCells = scope.filter((c) => (c.variant & bit) !== 0);
  const inv = invariantCoBits(treatedCells, bit);
  const controlCells = scope.filter((c) => (c.variant & bit) === 0 && (c.variant & inv) === inv);
  const treated = sideAt(treatedCells, k);
  const control = sideAt(controlCells, k);
  const p1 = treated.rate;
  const p2 = control.rate;
  const ratio = p2 > 0 ? p1 / p2 : NaN;
  const se = treated.events > 0 && control.events > 0
    ? Math.sqrt((1 - p1) / treated.events + (1 - p2) / control.events)
    : NaN;
  return { treated, control, ratio, se, inv, treatedCells, controlCells };
}

/** Share of a population's runs carrying a bit. */
function bitShare(cells: VariantMetrics[], bit: number): number {
  const runs = cells.reduce((a, c) => a + c.runs, 0);
  if (runs <= 0) return 0;
  return cells.filter((c) => (c.variant & bit) !== 0).reduce((a, c) => a + c.runs, 0) / runs;
}

/** Half the L1 distance between two populations' per-arm run shares. The
 *  arms span a range of per-run P(depth>=6), so a composition that drifted
 *  moves the contrast without any mechanism doing it. */
function armCompositionL1(a: VariantMetrics[], b: VariantMetrics[]): number {
  const shares = (cells: VariantMetrics[]): Map<string, number> => {
    const runs = cells.reduce((s, c) => s + c.runs, 0);
    const m = new Map<string, number>();
    for (const c of cells) m.set(c.arm, (m.get(c.arm) ?? 0) + (runs > 0 ? c.runs / runs : 0));
    return m;
  };
  const sa = shares(a);
  const sb = shares(b);
  let l1 = 0;
  for (const arm of new Set([...sa.keys(), ...sb.keys()])) l1 += Math.abs((sa.get(arm) ?? 0) - (sb.get(arm) ?? 0));
  return l1 / 2;
}

function emptySide(): InternalSide {
  return { runs: 0, gradedRuns: 0, events: 0, rate: 0, meanStepsUsed: 0, meanWallUs: 0, planCompleteShare: 0 };
}

/** The internal primary from pooled cells. `chunks` and `maxChunks` are the
 *  sample in hand and the cap it can grow to; `perChunkCells` supplies the
 *  chunk-to-chunk dispersion where the caller has the chunks separately, and
 *  an empty list charges the fixed over-dispersion alone. */
export function internalPrimaryCells(
  candCells: VariantMetrics[],
  baseCells: VariantMetrics[],
  bit: number | null,
  band: { min: number; max: number } | null,
  chunks: number,
  maxChunks: number,
  perChunkCells: VariantMetrics[][] = [],
  primaryRung: number = PRIMARY_RUNG,
): InternalPrimary {
  const k = primaryRung;
  const blank = (b: number, reason: string): InternalPrimary => ({
    bit: b, name: b > 0 ? bitNameOf(b) : "", rung: `depth>=${k}`,
    applies: false, inapplicableReason: reason,
    matchedOnMask: 0, matchedOn: [],
    treatedShare: { candidate: 0, baseline: null },
    treated: emptySide(), control: emptySide(),
    ratio: NaN, seCount: NaN, seEff: NaN, lo: NaN, hi: NaN, z: NaN,
    separatedUp: false, separatedDown: false, differenceInDifferences: false,
    balance: { cobit: [], armL1: 0, stepsPerRunRatio: null, probeShare: { treated: 0, control: 0 }, faults: [] },
    band, bandReading: null, meiAtCap: INTERNAL_MIN_EFFECT, perChunkRatios: [],
  });
  if (bit === null) return blank(0, "no treatment bit declared");
  if (!VARIANT_BITS.some((v) => v.bit === bit)) return blank(bit, `bit ${bit} is not on the roster in VARIANT_BITS`);
  if (NON_DECLARABLE_BITS.includes(bit)) return blank(bit, `bit ${bit} (${bitNameOf(bit)}) names an instrument or an outcome, not a treatment`);

  const c = matchedContrast(candCells, bit, k);
  const b = matchedContrast(baseCells, bit, k);
  const candRuns = candCells.reduce((a, x) => a + x.runs, 0);
  const baseRuns = baseCells.reduce((a, x) => a + x.runs, 0);
  const candShare = candRuns > 0 ? c.treated.runs / candRuns : 0;
  // Absent from the baseline is not a share of zero: there is nothing to
  // difference against, and the candidate-side contrast stands alone.
  const baseShare = b.treated.runs > 0 && baseRuns > 0 ? b.treated.runs / baseRuns : null;

  // Balance, on the matched populations. Reported whatever the verdict, so a
  // reader can see how far from balanced a refused contrast was.
  const cobit = VARIANT_BITS
    .filter((v) => v.bit !== bit)
    .map((v) => ({ bit: v.bit, name: v.name, treated: bitShare(c.treatedCells, v.bit), control: bitShare(c.controlCells, v.bit) }));
  const armL1 = armCompositionL1(c.treatedCells, c.controlCells);
  const stepsPerRunRatio = c.treated.meanStepsUsed > 0 && c.control.meanStepsUsed > 0
    ? c.treated.meanStepsUsed / c.control.meanStepsUsed
    : null;
  const preTreated = candCells.filter((x) => (x.variant & bit) !== 0);
  const preControl = candCells.filter((x) => (x.variant & bit) === 0);
  const balance = {
    cobit,
    armL1,
    stepsPerRunRatio,
    probeShare: { treated: bitShare(preTreated, PROBE_BIT), control: bitShare(preControl, PROBE_BIT) },
    faults: [] as string[],
  };
  // A confounder is a tag the two populations carry at different rates
  // despite the run id drawing both. Two kinds of co-bit are not that: a bit
  // naming an instrument or an outcome, which is downstream of the treatment
  // by construction, and a bit no untreated run carries at all, which the
  // treatment is what produces. Both are part of what the mechanism does,
  // and refusing them would refuse every mechanism that has an outcome bit.
  for (const x of cobit) {
    if (NON_DECLARABLE_BITS.includes(x.bit) || x.control === 0) continue;
    if (Math.abs(x.treated - x.control) > COBIT_SHARE_MAX) {
      balance.faults.push(`co-bit ${x.name} share ${x.treated.toFixed(4)} treated against ${x.control.toFixed(4)} control`);
    }
  }
  if (armL1 > ARM_COMPOSITION_MAX) balance.faults.push(`arm composition L1/2 ${armL1.toFixed(4)}`);
  if (stepsPerRunRatio !== null && Math.abs(stepsPerRunRatio - 1) > STEPS_PER_RUN_MAX) {
    balance.faults.push(`steps per run ${stepsPerRunRatio.toFixed(3)} treated to control`);
  }

  const matchedOn = VARIANT_BITS.filter((v) => (c.inv & v.bit) !== 0).map((v) => v.name);
  const perChunkRatios = perChunkCells
    .map((cells) => matchedContrast(cells, bit, k).ratio)
    .filter((r) => Number.isFinite(r) && r > 0);

  // The candidate-side reading, or the difference in differences where the
  // baseline carries the bit too: the same tag on an unchanged binary has its
  // own contrast, and only the change between them is the candidate's.
  const did = baseShare !== null && Number.isFinite(b.ratio) && b.ratio > 0 && Number.isFinite(c.ratio);
  const ratio = did ? c.ratio / b.ratio : c.ratio;
  const seCount = did ? Math.sqrt(c.se ** 2 + b.se ** 2) : c.se;
  const chunkVar = !did && perChunkRatios.length >= 3
    ? variance(perChunkRatios.map((r) => Math.log(r))) / perChunkRatios.length
    : 0;
  const seEff = Math.sqrt(Math.max(INTERNAL_OVERDISPERSION * seCount ** 2, chunkVar));
  const lo = ratio * Math.exp(-INTERNAL_Z * seEff);
  const hi = ratio * Math.exp(INTERNAL_Z * seEff);
  const z = Number.isFinite(seEff) && seEff > 0 ? Math.log(ratio) / seEff : NaN;
  const separatedUp = Number.isFinite(lo) && lo > 1 && ratio - 1 >= INTERNAL_MIN_EFFECT;
  const separatedDown = Number.isFinite(hi) && hi < 1 && 1 - ratio >= INTERNAL_MIN_EFFECT;
  const bandReading: InternalPrimary["bandReading"] = band === null
    ? null
    : !Number.isFinite(hi) ? "undecided"
      : hi < 1 + band.min ? "refuted"
        : ratio >= 1 + band.min && ratio <= 1 + band.max ? "met" : "undecided";
  const seAtCap = maxChunks > 0 && chunks > 0 ? seEff * Math.sqrt(chunks / maxChunks) : seEff;
  const meiAtCap = Number.isFinite(seAtCap) ? Math.max(INTERNAL_MIN_EFFECT, INTERNAL_Z * seAtCap) : Infinity;

  let reason: string | null = null;
  if (c.treated.gradedRuns === 0) reason = `bit ${bit} (${bitNameOf(bit)}) tags no graded run in this session`;
  else if (c.control.gradedRuns === 0) reason = "no untreated run matches the treated population's co-bits";
  else if (!Number.isFinite(ratio) || ratio <= 0) reason = "a side carries no events at the rung, so no ratio exists";
  else if (c.control.gradedRuns < MATCHED_CONTROL_MIN_GRADED) {
    reason = `the matched control carries ${c.control.gradedRuns} graded runs, below ${MATCHED_CONTROL_MIN_GRADED}`;
  } else if (candShare < TREATED_SHARE_MIN) reason = `treated share ${candShare.toFixed(4)} is below ${TREATED_SHARE_MIN}`;
  else if (baseShare !== null && Math.abs(candShare - baseShare) > TREATED_SHARE_SHIFT_MAX) {
    reason = `treated share shifted between candidate and baseline (${candShare.toFixed(4)} against ${baseShare.toFixed(4)}): the change is a dose, not a contrast`;
  } else if (balance.faults.length > 0) reason = `the declared bit's control population is unbalanced: ${balance.faults.join("; ")}`;

  return {
    bit, name: bitNameOf(bit), rung: `depth>=${k}`,
    applies: reason === null, inapplicableReason: reason,
    matchedOnMask: c.inv, matchedOn,
    treatedShare: { candidate: candShare, baseline: baseShare },
    treated: c.treated, control: c.control,
    ratio, seCount, seEff, lo, hi, z,
    separatedUp, separatedDown, differenceInDifferences: did,
    balance, band, bandReading, meiAtCap, perChunkRatios,
  };
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, x) => a + x, 0) / xs.length;
  return xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1);
}

/** The internal primary over a session's chunk records. */
export function internalPrimary(
  candEvals: Evaluation[], baseEvals: Evaluation[], bit: number | null,
  band: { min: number; max: number } | null, maxChunks: number, primaryRung: number = PRIMARY_RUNG,
): InternalPrimary {
  const ok = candEvals.filter((e) => e.ok);
  return internalPrimaryCells(
    pooledVariantCells(ok), pooledVariantCells(baseEvals.filter((e) => e.ok)), bit, band,
    ok.length, Math.max(maxChunks, ok.length), ok.map((e) => pooledVariantCells([e])), primaryRung,
  );
}

export function emptyStratum(): RateStratum {
  return { armIds: [], chunks: 0, runs: 0, graded: 0, exposureSec: 0, depth: [], perChunk: [] };
}

/** One chunk's stratum, or null when the chunk carries no per-arm accounting. */
export function chunkStratum(e: Evaluation): RateStratum | null {
  const c = e.metrics.campaign;
  if (c === null) return null;
  const arms = c.arms.filter((a) => !RATE_EXCLUDED_ARM_MODES.includes(a.mode));
  if (arms.length === 0) return null;
  const depth: number[] = [];
  for (const a of arms) a.depthAtLeast.forEach((v, i) => { depth[i] = (depth[i] ?? 0) + v; });
  const exposureSec = arms.reduce((s, a) => s + a.wallMs / 1000, 0);
  return {
    armIds: arms.map((a) => a.id).sort(),
    chunks: 1,
    runs: arms.reduce((s, a) => s + a.runs, 0),
    graded: arms.reduce((s, a) => s + a.gradedRuns, 0),
    exposureSec,
    depth,
    perChunk: [{ exposureSec, depth }],
  };
}

/** Fold a chunk in. A missing stratum or a different arm set poisons the
 *  accumulator to null, so "some chunks carried per-arm accounting" can
 *  never read as a whole stratum measured over fewer chunks than it claims. */
export function addStratum(acc: RateStratum | null, c: RateStratum | null): RateStratum | null {
  if (acc === null || c === null) return null;
  if (acc.chunks > 0 && acc.armIds.join(",") !== c.armIds.join(",")) return null;
  const depth = [...acc.depth];
  c.depth.forEach((v, i) => { depth[i] = (depth[i] ?? 0) + v; });
  return {
    armIds: c.armIds, chunks: acc.chunks + c.chunks, runs: acc.runs + c.runs,
    graded: acc.graded + c.graded, exposureSec: acc.exposureSec + c.exposureSec,
    depth, perChunk: [...acc.perChunk, ...c.perChunk],
  };
}

export function stratumOf(evals: Evaluation[]): RateStratum | null {
  let acc: RateStratum | null = emptyStratum();
  for (const e of evals) {
    if (!e.ok) continue;
    acc = addStratum(acc, chunkStratum(e));
  }
  return acc;
}

export type StratumFault = { kind: "missing" | "arms"; detail: string };

/** null when the two sides pool the same arms and both carry accounting.
 *  An empty side is not a fault: it has nothing to compare, not a gap. */
export function stratumFault(cand: RateStratum | null, base: RateStratum | null): StratumFault | null {
  if (cand === null || base === null) {
    return { kind: "missing", detail: `per-arm accounting missing or inconsistent across the ${cand === null ? "candidate" : "baseline"} chunks` };
  }
  if (cand.chunks === 0 || base.chunks === 0) return null;
  if (cand.armIds.join(",") !== base.armIds.join(",")) {
    return { kind: "arms", detail: `candidate pools [${cand.armIds.join(", ")}], baseline pools [${base.armIds.join(", ")}]` };
  }
  return null;
}

/** Chunk-to-chunk cv of the stratum's own rate at rung k, floored. */
export function rungCv(s: RateStratum, k: number): number {
  return throughputCv(s.perChunk.map((c) => (c.exposureSec > 0 ? (c.depth[k - 1] ?? 0) / c.exposureSec : 0)));
}

/** Extra log-ratio variance charged at rung k, taken from the rung's own
 *  chunk dispersion. The previous model charged throughput jitter, which is
 *  0.15% inside the stratum and could not see the arm over-dispersion that
 *  actually binds; measuring the rung means the next arm change that
 *  re-inflates it widens the interval instead of silently deflating z. */
export function rateVarianceOf(cand: RateStratum, base: RateStratum, k: number): number {
  return (cand.chunks > 0 ? rungCv(cand, k) ** 2 / cand.chunks : 0)
    + (base.chunks > 0 ? rungCv(base, k) ** 2 / base.chunks : 0);
}

/** The A/A spread two seeds of one unchanged binary produce at a rung, from
 *  the event counts alone: the counting floor sqrt(1/ec + 1/eb). Infinite
 *  when either side carries no events, which is the honest reading - nothing
 *  about that rung is measurable yet. Computed rather than looked up, so it
 *  follows the arm set and the budget instead of going stale. */
export function nullBand(candEvents: number, baseEvents: number): number {
  if (candEvents <= 0 || baseEvents <= 0) return Infinity;
  return Math.sqrt(1 / candEvents + 1 / baseEvents);
}

/** A rate estimated over a body of chunks, used where a four-chunk baseline
 *  count is a coin flip. Violations arrive at about one per 4.5M runs, so a
 *  baseline of four chunks is non-zero roughly one time in five. */
export interface RatePrior { violations: number; runs: number; chunks: number; sinceEpoch: number }

/** Epoch the campaign became the evaluation unit, so per-run violation rates
 *  became comparable. Not the current epoch: the prior spans 7 and later. */
export const CAMPAIGN_EPOCH_FLOOR = 7;

export interface ObjectiveCounts {
  violations: { succ: number; n: number };
  depth: Array<{ k: number; succ: number; n: number }>; // k over the rule's reported rungs, n = graded runs
  h2: { succ: number; n: number };
  runs: number;
  chunks: number;
  exposureSec: number;
  throughputCv: number;
  rateStratum: RateStratum | null;
}

export function objectiveCounts(evals: Evaluation[], ruleVersion: string = RULE_VERSION): ObjectiveCounts {
  const ok = evals.filter((e) => e.ok);
  const depth = ruleRungsFor(ruleVersion).reported.map((k) => ({ k, ...aggregateDepthCounts(ok, k) }));
  const h2succ = ok.reduce((a, e) => a + Math.round(e.metrics.h2Rate * e.metrics.runs), 0);
  const runs = ok.reduce((a, e) => a + e.metrics.runs, 0);
  return {
    violations: aggregateViolations(ok),
    depth,
    h2: { succ: h2succ, n: runs },
    runs,
    chunks: ok.length,
    exposureSec: ok.reduce((a, e) => a + e.metrics.exposureMs / 1000, 0),
    throughputCv: throughputCv(ok.map((e) => e.metrics.runsPerSec)),
    rateStratum: stratumOf(ok),
  };
}

export interface Comparison {
  improved: string[];
  regressed: string[];
  // Deep rungs per run whose posterior settled neither way: not known to have
  // fallen beyond the margin, not known to hold. A gain carrying one of these
  // is not a merge, because the guard it needs has not answered.
  unresolvedGuards: string[];
  deltas: Record<string, number>;
  stratumFault: StratumFault | null;
}

/** Violations when they are the separated improvement, otherwise the primary
 *  rung per second. The violations delta is an absolute rate difference and
 *  the depth deltas are relative ratios; a consumer must not mix the two
 *  scales. Selecting on `improved` rather than on a non-zero delta is
 *  load-bearing once violations are compared against a prior: a clean
 *  candidate then has a tiny non-zero violations delta, which would otherwise
 *  displace the rung in every recorded primary. */
export function primaryDelta(cmp: Comparison, primaryRung: number = PRIMARY_RUNG): number {
  return cmp.improved.includes("violations") ? (cmp.deltas["violations"] ?? 0) : (cmp.deltas[`depth>=${primaryRung}`] ?? 0);
}

// z defaults to 1.96 (promote: spends compute, not merges). The merge gate
// passes MERGE_Z = 2.7 - Bonferroni over the objectives tested, holding
// familywise false-positive near 5% per hypothesis.
export const MERGE_Z = 2.7;
// The relative margin the deep rungs per run may not fall beyond. It is wide
// because it exists to catch runs getting shallower while the per-second rate
// is bought with throughput, not to resolve small effects.
export const DEEP_RUNG_MARGIN = 0.25;
// The deep-rung guard is the same posterior test the sequential rule
// applies, with the same margin, so a rejection there is never contradicted
// here whatever the event counts.
const DEEP_RUNG_NIP = 0.95;
const DEEP_RUNG_DRAWS = 2000;
const DEEP_RUNG_SEED = 7;
/** Posterior that rung k's per-run rate fell beyond the margin. One
 *  definition, called by the stopping rule and by the gate, so the two cannot
 *  read the same chunks differently. */
export function deepRungPRegress(cSucc: number, cN: number, bSucc: number, bN: number, k: number): number {
  return compareRatesPoisson(cSucc, cN, bSucc, bN, 0, DEEP_RUNG_MARGIN, DEEP_RUNG_DRAWS, DEEP_RUNG_SEED + k).pRegress;
}

/** What that posterior says. `unresolved` is neither a hold nor a fall: the
 *  guard has not answered, and a gain alongside it is not a clean gain. */
export function deepRungReading(pRegress: number): "held" | "unresolved" | "regressed" {
  if (pRegress >= DEEP_RUNG_NIP) return "regressed";
  if (pRegress <= 1 - DEEP_RUNG_NIP) return "held";
  return "unresolved";
}
export function compareToBaseline(
  cand: ObjectiveCounts, base: ObjectiveCounts, z = 1.96, violationPrior: RatePrior | null = null,
  ruleVersion: string = RULE_VERSION,
): Comparison {
  const rungs = ruleRungsFor(ruleVersion);
  const improved: string[] = [];
  const regressed: string[] = [];
  const unresolvedGuards: string[] = [];
  const deltas: Record<string, number> = {};
  const rate = (c: { succ: number; n: number }): number => (c.n > 0 ? c.succ / c.n : 0);
  const perSec = (succ: number, exposureSec: number): number => (exposureSec > 0 ? succ / exposureSec : 0);
  const fault = stratumFault(cand.rateStratum, base.rateStratum);
  const cs = cand.rateStratum;
  const bs = base.rateStratum;
  deltas["stratified"] = fault === null ? 1 : 0;

  deltas["violations"] = rate(cand.violations) - rate(base.violations);
  // A violation belongs to whoever produced it only if it is more than the
  // corpus produces anyway. Against four baseline chunks that carry one
  // about a fifth of the time, "the baseline saw none" is a coin flip; the
  // archive rate over every campaign-epoch chunk is the honest comparator.
  const vp = violationPrior !== null && violationPrior.violations > 0 && violationPrior.runs > 0 ? violationPrior : null;
  const violationsUp = vp !== null
    ? rateRatioSeparated(cand.violations.succ, cand.violations.n, vp.violations, vp.runs, z)
    : (cand.violations.succ > 0 && base.violations.succ === 0)
      || rateSuperiorCI(cand.violations.succ, cand.violations.n, base.violations.succ, base.violations.n, z);
  if (violationsUp) improved.push("violations");
  if (rateSuperiorCI(base.violations.succ, base.violations.n, cand.violations.succ, cand.violations.n, z)) regressed.push("violations");

  // Depth rates are per explore-second over the rate stratum's arms; the
  // pooled rate is recorded beside them so the series stays readable, and
  // it is never what decides. The guard against shallower runs stays per
  // graded run over every arm: a run that got shallower in the aos arm is
  // still a shallower run, and the dispersion finding is about the rate.
  for (const d of cand.depth) {
    const b = base.depth.find((x) => x.k === d.k);
    if (!b) continue;
    const cr = perSec(d.succ, cand.exposureSec);
    const br = perSec(b.succ, base.exposureSec);
    deltas[`depth>=${d.k}:pooled`] = br > 0 ? cr / br - 1 : 0;
    if (fault === null && cs !== null && bs !== null) {
      const cSucc = cs.depth[d.k - 1] ?? 0;
      const bSucc = bs.depth[d.k - 1] ?? 0;
      const xv = rateVarianceOf(cs, bs, d.k);
      const csr = perSec(cSucc, cs.exposureSec);
      const bsr = perSec(bSucc, bs.exposureSec);
      deltas[`depth>=${d.k}`] = bsr > 0 ? csr / bsr - 1 : 0;
      if (rungs.advance.includes(d.k)
          && rateRatioSeparated(cSucc, cs.exposureSec, bSucc, bs.exposureSec, z, xv)) improved.push(`depth>=${d.k}`);
    }
    // The deep rungs per run may not fall beyond the margin: a per-second
    // gain bought by making runs shallower is depth traded for speed. A
    // posterior that settles neither way is recorded as unresolved, because a
    // guard that has not answered is not a guard that held.
    if (rungs.deepGuard.includes(d.k)) {
      const reading = deepRungReading(deepRungPRegress(d.succ, d.n, b.succ, b.n, d.k));
      if (reading === "regressed") regressed.push(`depth>=${d.k} per run`);
      else if (reading === "unresolved") unresolvedGuards.push(`depth>=${d.k} per run`);
    }
  }

  deltas["h2"] = rate(cand.h2) - rate(base.h2);
  deltas["throughput"] = cand.exposureSec > 0 && base.exposureSec > 0 && base.runs > 0
    ? (cand.runs / cand.exposureSec) / (base.runs / base.exposureSec) - 1
    : 0;

  return { improved, regressed, unresolvedGuards, deltas, stratumFault: fault };
}

/** True when the rung the objective is named on is separated BELOW the
 *  baseline at the merge z, on the same stratified per-second rate the
 *  superiority side separates gains on, with the arguments swapped. False
 *  when either side carries no stratum: a comparison that does not exist is
 *  not a regression, and stratumFault settles that case upstream. */
export function primaryRungRegressed(cand: ObjectiveCounts, base: ObjectiveCounts, primaryRung: number = PRIMARY_RUNG): boolean {
  const cs = cand.rateStratum;
  const bs = base.rateStratum;
  if (cs === null || bs === null) return false;
  const cSucc = cs.depth[primaryRung - 1] ?? 0;
  const bSucc = bs.depth[primaryRung - 1] ?? 0;
  return rateRatioSeparated(bSucc, bs.exposureSec, cSucc, cs.exposureSec, MERGE_Z, rateVarianceOf(cs, bs, primaryRung));
}

// Spur files whose edits change what an execution means rather than which
// executions are explored. Recorded on the evidence packet.
const SEMANTICS_FILES = [
  "spur-core/src/simulator/core/exec.rs",
  "spur-core/src/simulator/history.rs",
];
// The policy file is the loop's own rule book. A candidate that changes it
// cannot merge unattended whatever its evidence says.
export const POLICY_FILE = "research/policy.json";
export function classifyChangeRisk(changedSpurFiles: string[]): "opt_in" | "semantics" {
  for (const f of changedSpurFiles) {
    if (SEMANTICS_FILES.some((s) => f === s)) return "semantics";
  }
  return "opt_in";
}

/** Why a campaign could not have measured this diff. The binary a chunk runs
 *  is built from spur/, and the config it loads is materialized from a
 *  template under scheduler_configs/; a diff touching neither leaves the
 *  candidate and the baseline the same program on the same config, so the
 *  chunk samples the null band. Empty means the diff is measurable. */
export function unmeasurableReasons(spurFiles: string[], superFiles: string[]): string[] {
  if (spurFiles.length > 0) return [];
  if (superFiles.some((f) => f.startsWith("scheduler_configs/"))) return [];
  return ["no file under spur/ or scheduler_configs/ differs from the baseline, so a campaign would run the baseline binary on the baseline config and sample nothing"];
}

export interface FinalGateInputs {
  hypothesis: Hypothesis;
  confirmEvals: Evaluation[];
  baselineEvals: Evaluation[];
  // null when the suite has not run: it is the expensive half of a decision
  // and is bought only once the verdict could still be a merge.
  regressionPassed: boolean | null;
  /// Failing cases, "name: detail" joined. Carried so an environmental failure
  /// inside the suite is recognisable as one rather than counted as evidence.
  regressionDetail?: string | undefined;
  lintFailures: string[];
  changedSpurFiles: string[];
  throughputRatio: number | null; // cand runs per explore-second / baseline's
  // Below this ratio a gain cannot merge: the objective already credits
  // throughput, so a slower candidate has to have earned its rate. Required,
  // like unmeasurable: an optional input nobody supplies is a defect no
  // typecheck can see.
  throughputFloor: number;
  // The archive violation rate the candidate's violations are separated
  // against; null falls back to the baseline's own count.
  violationPrior?: RatePrior | null | undefined;
  // Required, not optional: an optional input nobody supplies is a defect no
  // typecheck can see. Non-empty means no sample was taken.
  unmeasurable: string[];
  // Whether the mechanism the hypothesis predicted had any occasions. A
  // sample of a mechanism that never fired is a sample about nothing,
  // whatever its rates did.
  firing: FiringResult;
  // Files outside spur/ the diff touched. Required for the same reason
  // unmeasurable is: a merge may not touch the loop's own rule book, and an
  // input nobody supplies is a defect no typecheck can see.
  changedSuperFiles: string[];
  // The variant bit the hypothesis declared its mechanism on, and the band it
  // froze for the per-run ratio of treated to untreated runs. Required, like
  // unmeasurable: a declaration nobody supplies is a candidate silently
  // graded on the fallback path. null means none was declared.
  treatmentBit: number | null;
  perRunBand: { min: number; max: number } | null;
  // The frozen epoch throughput baseline and the ledger of merges since, so
  // a merge cannot spend a few percent of throughput that no single session
  // is charged for. Absent leaves the blocker inert.
  epochThroughput?: { frozenRps: number | null; cumulative: number | null; floor: number } | null | undefined;
  // The build-layout band a cross-binary ratio has to clear. Absent uses the
  // constant; the epoch baseline carries a re-measured one, so re-measuring
  // it moves the rule without a code change.
  crossBinaryNullFloor?: number | undefined;
}

// The merge decision is made in three layers, in this order.
//
// 1. Hard stops in code. Three of them say no comparison exists - a stratum
//    that could not be formed, an arm set that moved, a mechanism with no
//    occasions - and two say the diff is defective. None is judgment, and no
//    model is asked about a case in this set.
// 2. A verdict on the figures: merge, close or human. "Keep sampling" is not
//    among them; decideSequential owns that on a principled basis and has
//    already stopped by the time the gate runs.
// 3. Post-conditions in code, which can only make a verdict safer: a merge
//    that has not passed every one of them becomes a human review.
export type MergeVerdict = "merge" | "close" | "human";

/** The figures a merge verdict is made on. Every number is computed here;
 *  whoever chooses the verdict adds none of its own. */
export interface MergeFigures {
  hypothesisId: string;
  kind: HypothesisKind;
  // The rule version the figures were computed under and the rung it names
  // as the objective. The verdict reads these rather than the live constants
  // so a recorded session is judged on the rungs its record was made on.
  ruleVersion: string;
  primaryRung: number;
  // The rule's own reading of the same figures, as evidence rather than as a
  // branch: a separated improvement with no separated regression.
  superior: boolean;
  improved: string[];
  regressed: string[];
  // The rung the objective is named on, separated below the baseline at the
  // merge z. Nothing carrying this may merge unattended.
  primaryRungRegressed: boolean;
  // Deep rungs per run whose guard answered neither way. A gain alongside one
  // of these is a finding for a person, not a merge.
  deepRungsUnresolved: string[];
  deltas: Record<string, number>;
  primary: number;
  // The A/A spread the primary rung's own event counts imply. A primary
  // delta inside it carries no information in either direction.
  primaryNullBand: number;
  primaryInsideNullBand: boolean;
  throughput: { ratio: number; floor: number };
  sample: { chunks: number; runs: number; exposureSec: number };
  // A violation belongs to the configuration that produced it, and they
  // arrive at about one per 1.7M runs, so a chunk carries one often enough
  // that the candidate running at the time is usually not the reason.
  violationsOnlyImprovement: boolean;
  firing: FiringResult;
  prediction: Prediction | null;
  // The delta on the rung the prediction named, and whether it landed in the
  // band claimed for it. null where the prediction named a rung whose delta
  // is an absolute rate difference rather than a relative one, so the band
  // and the delta are not on the same scale.
  predictedRungDelta: number | null;
  predictionInBand: boolean | null;
  touchesSemantics: boolean;
  touchesPolicy: boolean;
  // The merge criterion where a treatment bit was declared: the randomized
  // within-session per-run contrast. null where the session carries no
  // variant cells at all.
  internal: InternalPrimary | null;
  // The band a cross-binary ratio has to clear to be evidence rather than
  // build layout.
  crossBinaryNullFloor: number;
  epochThroughput: { frozenRps: number | null; cumulative: number | null; floor: number } | null;
}

function hardStop(i: FinalGateInputs, cmp: Comparison): { verdict: GateDecision["verdict"]; reason: string; harnessFailure: boolean } | null {
  if (i.lintFailures.length > 0) return { verdict: "closed", reason: `lint failures: ${i.lintFailures.join(", ")}`, harnessFailure: false };
  if (i.regressionPassed === false) {
    return { verdict: "closed", reason: i.regressionDetail ? `regression suite failed: ${i.regressionDetail}` : "regression suite failed", harnessFailure: false };
  }
  if (cmp.stratumFault?.kind === "missing") {
    // The per-second objective was not tested. Closing would record a
    // harness gap as a negative result about the hypothesis.
    return { verdict: "blocked", reason: `no per-arm accounting: ${cmp.stratumFault.detail}`, harnessFailure: true };
  }
  if (cmp.stratumFault?.kind === "arms") {
    return { verdict: "needs_human", reason: `the unit of comparison moved, so no per-second objective was tested: ${cmp.stratumFault.detail}`, harnessFailure: false };
  }
  if (firingIsHarnessGap(i.firing)) {
    // Nothing looked at the counters. That is the harness failing, not the
    // mechanism, and closing would record it as a negative result.
    return { verdict: "blocked", reason: `the firing check could not run: ${i.firing.detail}`, harnessFailure: true };
  }
  if (!firingPasses(i.firing)) {
    // A mechanism with no occasions cannot have moved a rate, so the deltas
    // this sample produced are the null band under another name. Read before
    // any rung, because no rung can answer it.
    return { verdict: "closed", reason: `the predicted mechanism did not fire (${i.firing.status}): ${i.firing.detail}`, harnessFailure: false };
  }
  return null;
}

/** The figures, from counts that are already pooled. Exported so an offline
 *  simulation reads the same figures the gate does rather than a second copy
 *  of the arithmetic; `i.confirmEvals` is not consulted here. */
export function figuresOf(
  i: FinalGateInputs, cand: ObjectiveCounts, base: ObjectiveCounts, cmp: Comparison,
  internal: InternalPrimary | null, ruleVersion: string = RULE_VERSION,
): MergeFigures {
  const primaryRung = primaryRungFor(ruleVersion);
  const cs = cand.rateStratum;
  const bs = base.rateStratum;
  const band = nullBand(cs?.depth[primaryRung - 1] ?? 0, bs?.depth[primaryRung - 1] ?? 0);
  const primary = primaryDelta(cmp, primaryRung);
  // Nullish, not null: a record written before predictions existed carries
  // no field at all rather than a null one.
  const p = i.hypothesis.prediction ?? null;
  // The depth rungs and throughput carry relative deltas, so a relative band
  // grades them; violations and h2 are absolute rate differences and are
  // reported without a verdict on the band.
  const relative = p !== null && (p.rung.startsWith("depth>=") || p.rung === "throughput");
  const predicted = p === null ? null : (cmp.deltas[p.rung] ?? null);
  return {
    hypothesisId: i.hypothesis.id,
    kind: i.hypothesis.kind,
    ruleVersion,
    primaryRung,
    superior: cmp.improved.length > 0 && cmp.regressed.length === 0,
    improved: cmp.improved,
    regressed: cmp.regressed,
    primaryRungRegressed: primaryRungRegressed(cand, base, primaryRung),
    deepRungsUnresolved: cmp.unresolvedGuards,
    deltas: cmp.deltas,
    primary,
    primaryNullBand: Number.isFinite(band) ? band : -1,
    primaryInsideNullBand: Math.abs(primary) <= band,
    throughput: { ratio: i.throughputRatio ?? 1, floor: i.throughputFloor },
    sample: { chunks: cand.chunks, runs: cand.runs, exposureSec: cand.exposureSec },
    violationsOnlyImprovement: cmp.improved.length === 1 && cmp.improved[0] === "violations",
    firing: i.firing,
    prediction: p,
    predictedRungDelta: predicted,
    predictionInBand: relative && predicted !== null ? predicted >= p.sizePct.min && predicted <= p.sizePct.max : null,
    touchesSemantics: classifyChangeRisk(i.changedSpurFiles) === "semantics",
    touchesPolicy: i.changedSuperFiles.includes(POLICY_FILE),
    internal,
    crossBinaryNullFloor: i.crossBinaryNullFloor ?? CROSS_BINARY_NULL_FLOOR,
    epochThroughput: i.epochThroughput ?? null,
  };
}

/** True when the separated gain is on a rung other than the primary one and
 *  the primary rung's own delta is below the spread its event counts imply.
 *  A shallow rung carries the session's run count as much as its depth, and
 *  a deep one carries few events, so a gain on either while the primary is
 *  down is depth traded for speed wearing the objective's name. A band that
 *  could not be computed - either side with no events at that rung - is not
 *  a reading, and a resolved fall is `regressed`'s business, not this one's. */
function primaryBelowBandWithOtherGain(f: MergeFigures): boolean {
  const primaryKey = `depth>=${f.primaryRung}`;
  const other = f.improved.some((k) => k.startsWith("depth>=") && k !== primaryKey);
  if (!other || f.improved.includes(primaryKey)) return false;
  if (!(f.primaryNullBand > 0)) return false;
  return (f.deltas[primaryKey] ?? 0) < -f.primaryNullBand;
}

/** The advance rungs other than the primary whose per-second rate separated
 *  above the baseline and outside the build-layout floor. A candidate whose
 *  primary is flat may still merge on one of these: the deeper rungs carry
 *  the conditions the objective is reaching for, and a separation there at
 *  the merge z is evidence whatever the primary did, as long as the primary
 *  is not below its own band. */
function separatedDeeperAdvances(f: MergeFigures): string[] {
  return ruleRungsFor(f.ruleVersion).advance
    .filter((k) => k > f.primaryRung)
    .map((k) => `depth>=${k}`)
    .filter((key) => f.improved.includes(key) && (f.deltas[key] ?? 0) > f.crossBinaryNullFloor);
}

/** The verdict the statistical rule reaches on the figures. It is the
 *  fallback whenever no other verdict is supplied, so an unavailable decider
 *  cannot stop the loop, and it is what the offline replay re-decides
 *  through. It is the only path to a terminal decision: the sampler says when
 *  to stop, and every stop is read here.
 *
 *  It closes only what the figures resolve against the candidate, and sends
 *  everything else it cannot merge to a human: a sample that resolves nothing
 *  is not a result about the hypothesis, and a human can still merge a branch
 *  a closure would have destroyed. */
export function ruleVerdict(f: MergeFigures): { verdict: MergeVerdict; reason: string } {
  // Cost first. The cross-binary rung is the honest read of what a candidate
  // costs the whole session, and it is two-sided: a fall beyond the layout
  // floor closes whatever the internal contrast says, because a mechanism
  // whose marginal effect is positive can still poison shared state.
  const primaryKey = `depth>=${f.primaryRung}`;
  const crossBinary = f.deltas[primaryKey] ?? 0;
  if (f.primaryRungRegressed && Math.abs(crossBinary) > f.crossBinaryNullFloor) {
    return {
      verdict: "close",
      reason: `${primaryKey} per second separated below the baseline at z ${MERGE_Z} by ${(crossBinary * 100).toFixed(2)}%, more than the ${(f.crossBinaryNullFloor * 100).toFixed(0)}% build-layout floor`,
    };
  }
  if (f.throughput.ratio < f.throughput.floor) {
    return { verdict: "close", reason: `throughput ratio ${f.throughput.ratio.toFixed(3)} below floor ${f.throughput.floor}` };
  }
  const epochProjected = projectedEpochThroughput(f);
  if (epochProjected !== null && epochProjected < (f.epochThroughput?.floor ?? EPOCH_THROUGHPUT_FLOOR)) {
    return {
      verdict: "close",
      reason: `merging would put cumulative throughput at ${epochProjected.toFixed(3)} of the frozen epoch baseline, below the ${(f.epochThroughput?.floor ?? EPOCH_THROUGHPUT_FLOOR).toFixed(2)} budget`,
    };
  }
  if (f.regressed.length > 0) {
    return { verdict: "close", reason: `the figures resolve against the candidate (regressed=[${f.regressed}])` };
  }

  // The primary, where a treatment bit was declared and its contrast is
  // measurable: the untreated runs of the same session are the control, so
  // between-process drift and build layout are differenced out.
  const ip = f.internal;
  if (ip !== null && ip.applies) {
    if (ip.separatedDown) {
      return { verdict: "close", reason: `the internal per-run contrast separated below 1.0 (${ip.ratio.toFixed(4)} [${ip.lo.toFixed(4)}, ${ip.hi.toFixed(4)}])` };
    }
    if (ip.bandReading === "refuted") {
      return { verdict: "close", reason: `the frozen per-run band ${(1 + (ip.band?.min ?? 0)).toFixed(2)} is excluded by [${ip.lo.toFixed(4)}, ${ip.hi.toFixed(4)}]` };
    }
    if (!ip.separatedUp) {
      return {
        verdict: "human",
        reason: `the internal contrast ${ip.ratio.toFixed(4)} [${ip.lo.toFixed(4)}, ${ip.hi.toFixed(4)}] resolves neither the mechanism nor its band`,
      };
    }
    if (f.deepRungsUnresolved.length > 0) {
      return { verdict: "human", reason: `a rung separated but the deep rungs per run are unresolved: ${f.deepRungsUnresolved.join(", ")}` };
    }
    return {
      verdict: "merge",
      reason: `internal per-run contrast on ${primaryKey}: ${ip.ratio.toFixed(4)} [${ip.lo.toFixed(4)}, ${ip.hi.toFixed(4)}] at z ${INTERNAL_Z}, effect at or above ${(INTERNAL_MIN_EFFECT * 100).toFixed(0)}%`,
    };
  }

  // The fallback, where no internal control was declared or its contrast is
  // not measurable. Two builds of identical source differ by their layout, so
  // nothing inside that band separates anything here - on the primary rung
  // or on a deeper advance rung, which carries the same layout shift.
  // Read on the rung's own relative delta, not on `primary`: primary carries
  // the violations rate where violations are the improvement, and that is an
  // absolute difference, on a different scale from a relative floor.
  const deeper = separatedDeeperAdvances(f);
  if (primaryBelowBandWithOtherGain(f)) {
    return {
      verdict: "human",
      reason: `the gain is on another rung (${f.improved.filter((k) => k.startsWith("depth>=")).join(", ")}) while ${primaryKey} is ${(crossBinary * 100).toFixed(2)}% against a ${(f.primaryNullBand * 100).toFixed(2)}% band`,
    };
  }
  if (crossBinary <= f.crossBinaryNullFloor && deeper.length === 0) {
    const why = ip === null || ip.inapplicableReason === null ? "no declared treatment bit" : ip.inapplicableReason;
    return {
      verdict: "human",
      reason: `cross-binary ${primaryKey}/s ${(crossBinary * 100).toFixed(2)}% is inside the ${(f.crossBinaryNullFloor * 100).toFixed(0)}% build-layout floor; with ${why} nothing here can separate`,
    };
  }
  const primaryUp = f.improved.includes(primaryKey) && crossBinary > f.crossBinaryNullFloor;
  if (!primaryUp && deeper.length === 0) {
    return { verdict: "human", reason: `no CI-separated improvement on ${primaryKey} or a deeper advance rung (improved=[${f.improved}], regressed=[${f.regressed}])` };
  }
  if (f.deepRungsUnresolved.length > 0) {
    return { verdict: "human", reason: `a rung separated but the deep rungs per run are unresolved: ${f.deepRungsUnresolved.join(", ")}` };
  }
  if (f.violationsOnlyImprovement) {
    return { verdict: "human", reason: "the only separated improvement is a violation; check its arm in violating_runs.json against the arms this change touches" };
  }
  if (!primaryUp) {
    const detail = deeper.map((k) => `${k}/s ${((f.deltas[k] ?? 0) * 100).toFixed(2)}%`).join(", ");
    return {
      verdict: "merge",
      reason: `cross-binary fallback on a deeper advance rung: ${detail} clears the ${(f.crossBinaryNullFloor * 100).toFixed(0)}% layout floor and separates at z ${MERGE_Z} with ${primaryKey}/s flat at ${(crossBinary * 100).toFixed(2)}% (no internal control declared)`,
    };
  }
  return {
    verdict: "merge",
    reason: `cross-binary fallback: ${primaryKey}/s ${(crossBinary * 100).toFixed(2)}% clears the ${(f.crossBinaryNullFloor * 100).toFixed(0)}% layout floor and separates at z ${MERGE_Z} (no internal control declared)`,
  };
}

/** What merging would leave cumulative throughput at, against the frozen
 *  epoch baseline. null when no epoch is frozen, which leaves the budget
 *  inert rather than assuming one. */
export function projectedEpochThroughput(f: MergeFigures): number | null {
  const e = f.epochThroughput;
  if (e === null || e.cumulative === null) return null;
  return e.cumulative * f.throughput.ratio;
}

/** Why a merge may not stand unattended. Empty means it may. */
export function mergeBlockers(i: FinalGateInputs, f: MergeFigures, cmp: Comparison): string[] {
  const out: string[] = [];
  if (i.regressionPassed !== true) out.push("the regression suite has not passed");
  if (i.lintFailures.length > 0) out.push("lint failures stand");
  if (cmp.stratumFault !== null) out.push("the rate stratum is faulted");
  if (!firingPasses(i.firing)) out.push("the predicted mechanism did not fire");
  // The rung the objective is named on, separated below the baseline at the
  // merge z. The sampler refuses to advance this shape, so reaching here means
  // the two disagree; a verdict is not the place to settle that.
  if (f.primaryRungRegressed) out.push(`depth>=${f.primaryRung} per second separated below the baseline at z ${MERGE_Z}`);
  if (f.throughput.ratio < f.throughput.floor) out.push(`throughput ratio ${f.throughput.ratio.toFixed(3)} below floor ${f.throughput.floor}`);
  // Throughput is spent a few percent at a time and the loss compounds, so
  // the budget is read against the frozen epoch baseline rather than against
  // the previous merge alone.
  const projected = projectedEpochThroughput(f);
  if (projected !== null && projected < (f.epochThroughput?.floor ?? EPOCH_THROUGHPUT_FLOOR)) {
    out.push(`merging would put cumulative throughput at ${projected.toFixed(3)} of the frozen epoch baseline, below the ${(f.epochThroughput?.floor ?? EPOCH_THROUGHPUT_FLOOR).toFixed(2)} budget`);
  }
  // A supplied merge may not bypass the balance check: an unbalanced control
  // is a contrast about the populations, not about the mechanism.
  if (f.internal !== null && f.internal.balance.faults.length > 0) {
    out.push(`the declared bit's control population is unbalanced: ${f.internal.balance.faults.join("; ")}`);
  }
  if (f.internal !== null && f.internal.applies && !f.internal.separatedUp) {
    out.push("the internal primary applies and did not separate");
  }
  if (f.deepRungsUnresolved.length > 0) out.push(`deep rungs per run unresolved: ${f.deepRungsUnresolved.join(", ")}`);
  if (primaryBelowBandWithOtherGain(f)) out.push(`depth>=${f.primaryRung} is below its band with the gain on another rung`);
  // A sample that separated nothing may still be a merge, but only where the
  // hypothesis said beforehand what it would produce, that claim was checked
  // and met, and the mechanism had occasions. Without all three there is
  // nothing to distinguish the result from a no-op.
  if (f.improved.length === 0
      && !(f.internal !== null && f.internal.applies && f.internal.separatedUp)
      && !(f.prediction !== null && f.predictionInBand === true && f.firing.status === "fired")) {
    out.push("nothing separated and no stated prediction was met");
  }
  // A change to what an execution means can move every rung without exploring
  // anything new, so its evidence cannot certify it; the loop's own rule book
  // is not something the loop merges into itself unattended.
  if (f.touchesSemantics) out.push("touches execution-semantics files");
  if (f.touchesPolicy) out.push(`touches ${POLICY_FILE}`);
  return out;
}

/** The figures a merge verdict is made on, or the decision itself where it is
 *  settled without judgment. One entry point, so the gate and its caller
 *  cannot disagree about which cases reach a verdict at all. */
export function mergeCase(i: FinalGateInputs): { stop: GateDecision } | { figures: MergeFigures } {
  const g = finalGateParts(i);
  return g.stop !== null ? { stop: g.stop } : { figures: g.figures as MergeFigures };
}

function finalGateParts(i: FinalGateInputs): { stop: GateDecision | null; figures: MergeFigures | null; cmp: Comparison | null; cand: ObjectiveCounts | null } {
  // A diff a campaign cannot read is not a negative result: it goes to a
  // human with its report and no measured delta. Tested after the lints so a
  // defective diff still closes rather than reaching the review queue, and
  // it returns rather than joining the verdict chain so that no delta from
  // an empty evaluation is recorded. regressionPassed is null because the
  // suite did not fail, it did not run.
  if (i.lintFailures.length === 0 && i.unmeasurable.length > 0) {
    return {
      stop: {
        hypothesisId: i.hypothesis.id, verdict: "needs_human", reasons: i.unmeasurable,
        objectiveDeltas: {}, regressionPassed: null, lintPassed: true,
      },
      figures: null, cmp: null, cand: null,
    };
  }
  const cand = objectiveCounts(i.confirmEvals);
  const base = objectiveCounts(i.baselineEvals);
  const cmp = compareToBaseline(cand, base, MERGE_Z, i.violationPrior ?? null);
  const hs = hardStop(i, cmp);
  if (hs !== null) {
    return {
      stop: {
        hypothesisId: i.hypothesis.id, verdict: hs.verdict, reasons: [hs.reason],
        objectiveDeltas: { ...cmp.deltas, primary: primaryDelta(cmp), throughput: (i.throughputRatio ?? 1) - 1 },
        regressionPassed: i.regressionPassed, lintPassed: i.lintFailures.length === 0,
        ...(hs.harnessFailure ? { harnessFailure: true } : {}),
      },
      figures: null, cmp, cand,
    };
  }
  // The internal primary is computed from the same chunk records the counts
  // came from: the cap is the sample in hand, because the gate runs once the
  // sampler has already stopped.
  const internal = i.confirmEvals.length === 0 && i.treatmentBit === null
    ? null
    : internalPrimary(i.confirmEvals, i.baselineEvals, i.treatmentBit, i.perRunBand, cand.chunks);
  return { stop: null, figures: figuresOf(i, cand, base, cmp, internal), cmp, cand };
}

export function finalGate(i: FinalGateInputs, chosen?: { verdict: MergeVerdict; reason: string }): GateDecision {
  const parts = finalGateParts(i);
  if (parts.stop !== null) return parts.stop;
  const f = parts.figures as MergeFigures;
  const cmp = parts.cmp as Comparison;
  const reasons: string[] = [];
  const picked = chosen ?? ruleVerdict(f);
  let verdict: GateDecision["verdict"];
  if (picked.verdict === "close") {
    verdict = "closed";
    reasons.push(picked.reason);
  } else if (picked.verdict === "human") {
    verdict = "needs_human";
    reasons.push(picked.reason);
  } else {
    const blockers = mergeBlockers(i, f, cmp);
    verdict = blockers.length === 0 ? "auto_merge" : "needs_human";
    reasons.push(blockers.length === 0 ? picked.reason : `${picked.reason} - held for review: ${blockers.join("; ")}`);
  }
  const primary = primaryDelta(cmp);
  // Run rate multiplies every rung, so it is inside the objective now; it is
  // still recorded on its own so erosion across merges stays visible as a
  // series.
  const throughput = (i.throughputRatio ?? 1) - 1;
  return {
    hypothesisId: i.hypothesis.id,
    verdict,
    reasons,
    objectiveDeltas: { ...cmp.deltas, primary, throughput },
    regressionPassed: i.regressionPassed,
    lintPassed: i.lintFailures.length === 0,
  };
}

// Gate for perf-kind hypotheses: A/B bench superiority is the objective and
// the regression suite is the semantic safety net.
export interface PerfGateInputs {
  hypothesis: Hypothesis;
  bench: BenchResult;
  regressionPassed: boolean;
  lintFailures: string[];
}

export function perfGate(i: PerfGateInputs): GateDecision {
  const reasons: string[] = [];
  let verdict: GateDecision["verdict"];
  if (i.lintFailures.length > 0) {
    verdict = "closed";
    reasons.push(`lint failures: ${i.lintFailures.join(", ")}`);
  } else if (!i.bench.pass) {
    verdict = "closed";
    reasons.push(`bench: ${i.bench.detail}`);
  } else if (!i.regressionPassed) {
    verdict = "closed";
    reasons.push("regression suite failed");
  } else {
    verdict = "auto_merge";
    reasons.push(`bench: ${i.bench.detail}`);
  }
  return {
    hypothesisId: i.hypothesis.id,
    verdict,
    reasons,
    objectiveDeltas: { primary: i.bench.improvement, throughput: i.bench.improvement },
    regressionPassed: i.regressionPassed,
    lintPassed: i.lintFailures.length === 0,
  };
}

/** The unmeasurable path. Its failure modes are a wrong argument order and a
 *  partially applied substitution, neither of which a typecheck can see, so
 *  two of these assertions read the source itself. */
export function selfTestUnmeasured(): string[] {
  const f: string[] = [];
  const check = (c: boolean, m: string): void => { if (!c) f.push(m); };
  const u = unmeasurableReasons;

  check(u(["spur-core/src/simulator/core/exec.rs"], []).length === 0, "a spur source change is measurable");
  check(u([], ["scheduler_configs/loop/general_vr.json"]).length === 0, "a scheduler config change is measurable");
  check(u([], ["research/observations/HAZARD_PREDICTIVENESS.md", "research/observations/hazard_predictiveness.mjs"]).length > 0,
    "an observations-only diff is not measurable");
  check(u([], ["research/policy.json"]).length > 0, "a policy change cannot be measured by its own campaign");
  check(u([], []).length > 0, "an empty diff is not measurable");
  // The gitlink is stripped before this runs; accepting it would make every
  // superproject-only diff read as measurable again.
  check(u([], ["spur"]).length > 0, "the spur gitlink is not a spur source change");
  // Prefix, not substring.
  check(u([], ["research/observations/scheduler_configs-audit.md"]).length > 0, "the config test is a path prefix");

  // A sample with no separated improvement merges only on a stated
  // prediction that fired and landed in its band, so the clean fixture
  // carries one: an empty evaluation set separates nothing.
  const stated: Prediction = {
    firingCounter: "mechanism.occasions", firingFloor: 1, rung: `depth>=${PRIMARY_RUNG}` as Prediction["rung"],
    sizePct: { min: -0.01, max: 0.01 },
    mechanism: "the change is inert on the rates by construction",
    independentObservable: "the counter it exports",
    falsifier: "the counter stays at zero across the sample",
  };
  const h = { id: "h", kind: "add", category: "scheduler", prediction: stated } as unknown as Hypothesis;
  const base: FinalGateInputs = {
    hypothesis: h, confirmEvals: [], baselineEvals: [], regressionPassed: true,
    lintFailures: [], changedSpurFiles: [], changedSuperFiles: [], throughputRatio: 1, throughputFloor: 0.8,
    unmeasurable: [], firing: { status: "fired", detail: "mechanism.occasions = 1" },
    treatmentBit: null, perRunBand: null,
  };
  const un = finalGate({ ...base, unmeasurable: ["u"] });
  check(un.verdict === "needs_human", `an unmeasurable diff reaches a human, got ${un.verdict}`);
  check(!("primary" in un.objectiveDeltas), "an unmeasured decision records no primary delta");
  check(un.regressionPassed === null, "the regression suite did not fail, it did not run");
  // A defective diff closes rather than reaching the review queue.
  const both = finalGate({ ...base, unmeasurable: ["u"], lintFailures: ["l"] });
  check(both.verdict === "closed" && (both.reasons[0] ?? "").startsWith("lint failures:"),
    `lint outranks unmeasurable, got ${both.verdict}`);
  // The reason must not read as a harness failure to the judge; state.ts
  // stamps that from the literal "no changes".
  check(!u([], []).some((r) => /no changes/.test(r)), "the reason must not trip the harness-failure test");
  // A mechanism with no occasions is a sample about nothing: it closes, and
  // it closes before any rung is read. An uncollected dump is the harness
  // failing to look, so it blocks instead.
  const quiet = finalGate({ ...base, firing: { status: "no-occasions", detail: "c = 0" } });
  check(quiet.verdict === "closed" && (quiet.reasons[0] ?? "").startsWith("the predicted mechanism did not fire"),
    `a mechanism with no occasions must close, got ${quiet.verdict}`);
  const blind = finalGate({ ...base, firing: { status: "uncollected", detail: "no dump" } });
  check(blind.verdict === "blocked" && blind.harnessFailure === true,
    `an uncollected utilization dump is a harness gap, got ${blind.verdict}`);
  check(!finalGate({ ...base, firing: { status: "fired", detail: "c = 1" } }).reasons.some((r) => r.startsWith("the predicted mechanism did not fire")),
    "a mechanism that fired is judged on its rates");

  // The three layers, in order. A hard stop is settled in code and no
  // supplied verdict can move it; a merge is only ever a proposal, held back
  // by any post-condition it has not met.
  const merge = { verdict: "merge" as MergeVerdict, reason: "r" };
  check("figures" in mergeCase(base), "a clean case reaches a verdict");
  for (const [name, over] of [
    ["lint failures", { lintFailures: ["l"] }],
    ["a failed suite", { regressionPassed: false }],
    ["a mechanism with no occasions", { firing: { status: "no-occasions" as const, detail: "c = 0" } }],
    ["an uncollected dump", { firing: { status: "uncollected" as const, detail: "none" } }],
  ] as Array<[string, Partial<FinalGateInputs>]>) {
    check("stop" in mergeCase({ ...base, ...over }), `${name} is settled in code, so nothing is asked about it`);
    check(finalGate({ ...base, ...over }, merge).verdict !== "auto_merge", `${name} must not be merged by a supplied verdict`);
  }
  check(finalGate(base, merge).verdict === "auto_merge", "a merge with every post-condition met stands");
  for (const [name, over] of [
    ["an unrun suite", { regressionPassed: null }],
    ["a policy change", { changedSuperFiles: [POLICY_FILE] }],
    ["an execution-semantics change", { changedSpurFiles: ["spur-core/src/simulator/core/exec.rs"] }],
    ["a candidate below the throughput floor", { throughputRatio: 0.5 }],
  ] as Array<[string, Partial<FinalGateInputs>]>) {
    const d = finalGate({ ...base, ...over }, merge);
    check(d.verdict === "needs_human" && (d.reasons[0] ?? "").includes("held for review"),
      `${name} must hold a merge for review, got ${d.verdict}`);
  }
  check(finalGate(base, { verdict: "close", reason: "because" }).verdict === "closed", "close closes");
  check(finalGate(base, { verdict: "human", reason: "because" }).verdict === "needs_human", "human reaches a human");

  // The verdict on the figures, and the post-conditions that hold a merge
  // back. Written on figures rather than on evaluations because the shapes
  // being tested - an unresolved guard, a shallow gain over a fallen primary
  // rung - are counts no empty evaluation set can carry.
  const cleanFigures: MergeFigures = {
    hypothesisId: "h", kind: "add", ruleVersion: RULE_VERSION, primaryRung: PRIMARY_RUNG,
    superior: true, improved: [`depth>=${PRIMARY_RUNG}`], regressed: [],
    primaryRungRegressed: false, deepRungsUnresolved: [], deltas: { [`depth>=${PRIMARY_RUNG}`]: 0.1 },
    primary: 0.1, primaryNullBand: 0.01, primaryInsideNullBand: false,
    throughput: { ratio: 1, floor: 0.8 }, sample: { chunks: 2, runs: 100, exposureSec: 100 },
    violationsOnlyImprovement: false, firing: { status: "fired", detail: "" }, prediction: null,
    predictedRungDelta: null, predictionInBand: null, touchesSemantics: false, touchesPolicy: false,
    internal: null, crossBinaryNullFloor: CROSS_BINARY_NULL_FLOOR, epochThroughput: null,
  };
  const cleanCmp: Comparison = { improved: cleanFigures.improved, regressed: [], unresolvedGuards: [], deltas: {}, stratumFault: null };
  const verdictOn = (over: Partial<MergeFigures>): MergeVerdict => ruleVerdict({ ...cleanFigures, ...over }).verdict;
  const blockersOn = (over: Partial<MergeFigures>): string[] => mergeBlockers(base, { ...cleanFigures, ...over }, cleanCmp);
  check(verdictOn({}) === "merge", `a separated gain with every guard held merges, got ${verdictOn({})}`);
  check(verdictOn({ regressed: ["depth>=5 per run"] }) === "close", "a resolved regression closes");
  check(verdictOn({ deepRungsUnresolved: ["depth>=5 per run"] }) === "human", "an unresolved deep guard reaches a human");
  check(blockersOn({ deepRungsUnresolved: ["depth>=5 per run"] }).length > 0, "an unresolved deep guard holds a supplied merge for review");
  // A gain on a shallower rung while the primary rung sits below the spread
  // its own counts imply. Inside the band it is not a reading and merges.
  const shallow = { improved: ["depth>=4"], deltas: { [`depth>=${PRIMARY_RUNG}`]: -0.02 }, primaryNullBand: 0.01 };
  check(verdictOn(shallow) === "human", `a shallow gain over a primary rung below its band reaches a human, got ${verdictOn(shallow)}`);
  check(blockersOn(shallow).length > 0, "a primary rung below its band holds a supplied merge for review");
  // A primary rung inside its band is not a reading, so the other-gain
  // branch does not fire; the gain is still on a rung that cannot advance,
  // and only the primary or a deeper advance rung carries the fallback path.
  check(verdictOn({ ...shallow, deltas: { [`depth>=${PRIMARY_RUNG}`]: -0.005 } }) === "human", "a gain on a shallower rung alone does not merge");
  check(verdictOn({ ...shallow, primaryNullBand: -1 }) === "human", "a band that could not be computed is not a reading");
  // A deeper advance rung separated outside the layout floor carries a merge
  // over a flat primary, and not over one below its band; a deeper rung
  // that is not an advance rung carries nothing.
  const deeperAdvance = ruleRungsFor(RULE_VERSION).advance.filter((k) => k !== PRIMARY_RUNG);
  const deepest = ruleRungsFor(RULE_VERSION).reported.filter((k) => !ruleRungsFor(RULE_VERSION).advance.includes(k) && k > PRIMARY_RUNG);
  for (const k of deeperAdvance) {
    const flatPrimary = { improved: [`depth>=${k}`], deltas: { [`depth>=${PRIMARY_RUNG}`]: 0.004, [`depth>=${k}`]: 0.3 }, primaryNullBand: 0.01 };
    check(verdictOn(flatPrimary) === "merge", `a separated depth>=${k} over a flat primary merges on the fallback path, got ${verdictOn(flatPrimary)}`);
    check(blockersOn(flatPrimary).length === 0, `a separated depth>=${k} over a flat primary leaves no blocker, got [${blockersOn(flatPrimary)}]`);
    const fallenPrimary = { ...flatPrimary, deltas: { [`depth>=${PRIMARY_RUNG}`]: -0.02, [`depth>=${k}`]: 0.3 } };
    check(verdictOn(fallenPrimary) === "human", `a separated depth>=${k} over a primary below its band reaches a human, got ${verdictOn(fallenPrimary)}`);
    const insideFloor = { ...flatPrimary, deltas: { [`depth>=${PRIMARY_RUNG}`]: 0.004, [`depth>=${k}`]: 0.03 } };
    check(verdictOn(insideFloor) === "human", `a depth>=${k} separation inside the layout floor does not merge, got ${verdictOn(insideFloor)}`);
  }
  for (const k of deepest) {
    const tail = { improved: [`depth>=${k}`], deltas: { [`depth>=${PRIMARY_RUNG}`]: 0.004, [`depth>=${k}`]: 0.5 }, primaryNullBand: 0.01 };
    check(verdictOn(tail) === "human", `a gain on depth>=${k}, which is not an advance rung, does not merge, got ${verdictOn(tail)}`);
  }
  // Nothing separated: a merge needs a stated prediction that fired and
  // landed in its band, which is the only thing distinguishing the result
  // from a no-op.
  const flat = { improved: [], superior: false };
  check(blockersOn(flat).some((b) => b.startsWith("nothing separated")), "a flat sample with no stated prediction cannot merge unattended");
  check(blockersOn({ ...flat, prediction: stated, predictionInBand: true }).length === 0, "a flat sample whose stated prediction fired and was met may merge");
  check(blockersOn({ ...flat, prediction: stated, predictionInBand: false }).some((b) => b.startsWith("nothing separated")), "a prediction the sample refuted does not carry a flat merge");
  check(blockersOn({ ...flat, prediction: stated, predictionInBand: true, firing: { status: "not-claimed", detail: "" } }).some((b) => b.startsWith("nothing separated")),
    "a prediction whose mechanism was never seen to fire does not carry a flat merge");
  // No supplied verdict falls back to the rule, so an unavailable decider
  // cannot stop the loop and the offline replay decides the same way.
  const clean = mergeCase(base);
  if ("figures" in clean) {
    check(finalGate(base).verdict === finalGate(base, ruleVerdict(clean.figures)).verdict,
      "no supplied verdict is the rule's verdict");
  }

  const loopSrc = path.join(ROOT, "research/orchestrator/src/loop.ts");
  if (existsSync(loopSrc)) {
    const t = readFileSync(loopSrc, "utf8");
    const calls = (t.match(/unmeasurableReasons\(spurFiles, superFiles\)/g) ?? []).length;
    check(calls === 1, `loop.ts must call unmeasurableReasons(spurFiles, superFiles) exactly once, found ${calls}`);
    const guards = (t.match(/lintFailures\.length === 0/g) ?? []).length;
    check(guards === 1, `loop.ts must test lintFailures.length === 0 only where sampled is defined, found ${guards}`);
    // Not \b on the left: a comment already says "re-sampled".
    const sampled = (t.match(/(?<![-\w])sampled\b/g) ?? []).length;
    check(sampled === 4, `loop.ts must use sampled once per branch plus its definition (4), found ${sampled}`);
  }
  return f;
}

/** Roster bits whose tag is not defined in the explorer's own source. A
 *  roster entry whose tag was never merged names a population no chunk can
 *  carry, so a session that declares it would be graded on cells that do not
 *  exist. Advisory here; the caller decides which of them are live. */
export function variantBitsMissingFromSource(): string[] {
  const src = path.join(ROOT, "spur/spur-core/src/simulator/run_variant.rs");
  if (!existsSync(src)) return [];
  const text = readFileSync(src, "utf8");
  const out: string[] = [];
  for (const { bit, name } of VARIANT_BITS) {
    const konst = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
    const m = new RegExp(`pub const ${konst}\\s*:\\s*i32\\s*=\\s*1\\s*<<\\s*(\\d+)`).exec(text);
    if (m === null || 1 << Number(m[1]) !== bit) out.push(`${name} (${bit})`);
  }
  return out;
}

/** The internal primary's own seams, on synthetic cells: the probe rule, the
 *  co-bit matching, the balance checks, and the declaration roster. The
 *  recorded-session checks are the lite grader's, because the sessions are
 *  its records.
 *
 *  The contrast is blind to a cost paid by both halves of a session - a
 *  shared hot-path slowdown reads 1.0 here - so the cross-binary throughput
 *  floor and the epoch throughput budget are the only cost read there is.
 *  Weakening either leaves this rule with none. */
export function selfTestInternalPrimary(): string[] {
  const f: string[] = [];
  const check = (c: boolean, m: string): void => { if (!c) f.push(m); };
  // Every run reaches the rungs above the primary; `events` reach the
  // primary itself.
  const cell = (variant: number, runs: number, events: number, arm = "grid", steps = 100): VariantMetrics => ({
    arm, variant, runs, gradedRuns: runs,
    depthAtLeast: Array.from({ length: PRIMARY_RUNG }, (_, i) => (i === PRIMARY_RUNG - 1 ? events : runs)),
    violations: 0, wallUsSum: runs * 1000, stepsUsedSum: runs * steps, planCompleteRuns: runs,
  });
  const band = { min: 0.05, max: 0.25 };
  const ip = (cells: VariantMetrics[], bit: number | null, b: { min: number; max: number } | null = null): InternalPrimary =>
    internalPrimaryCells(cells, [], bit, b, 2, 2);
  // The contrast a reader would get by leaving probes in the control.
  const withProbes = (cells: VariantMetrics[], bit: number): number => {
    const rate = (cs: VariantMetrics[]): number => {
      const g = cs.reduce((a, c) => a + c.gradedRuns, 0);
      return g > 0 ? cs.reduce((a, c) => a + (c.depthAtLeast[PRIMARY_RUNG - 1] ?? 0), 0) / g : 0;
    };
    return rate(cells.filter((c) => (c.variant & bit) !== 0)) / rate(cells.filter((c) => (c.variant & bit) === 0));
  };

  // 1. The probe rule. Where the mechanism exempts probes they sit entirely
  // in its control and drag it down; the reported number must be the
  // probe-free one. Where coverage is proportional the drop changes nothing.
  const exempting = [cell(16, 100_000, 25_000), cell(0, 100_000, 25_000), cell(2, 4_000, 200)];
  const exempt = ip(exempting, 16);
  check(Math.abs(withProbes(exempting, 16) - 1) > 0.005, "the exemption fixture must move the contrast when probes stay in the control, else it tests nothing");
  check(Math.abs(exempt.ratio - 1) < 1e-9, `the probe-free contrast must be 1.0 on the exemption fixture, got ${exempt.ratio}`);
  const proportional = [cell(16, 100_000, 26_000), cell(18, 4_000, 208), cell(0, 100_000, 25_000), cell(2, 4_000, 200)];
  const prop = ip(proportional, 16);
  check(Math.abs(prop.ratio / withProbes(proportional, 16) - 1) < 0.005,
    `proportional probe coverage must agree with and without the drop, got ${prop.ratio} against ${withProbes(proportional, 16)}`);

  // 2. Matching. A bit that only exists on placed runs must be compared with
  // placed untreated runs, not with the whole untreated population.
  const nested = [cell(513, 100_000, 25_000), cell(1, 100_000, 24_000), cell(0, 100_000, 5_000)];
  const nest = ip(nested, 512);
  check(nest.matchedOnMask === 1 && nest.matchedOn.includes("crashPlaced"), `a nested bit must match on its host population, got mask ${nest.matchedOnMask}`);
  check(Math.abs(nest.ratio - 25_000 / 24_000) < 1e-9, `the matched contrast must be the placed-against-placed ratio, got ${nest.ratio}`);
  check(withProbes(nested, 512) > 1.5, "the nesting fixture must show a large unmatched ratio, else the matching is not tested");
  check(nest.applies && nest.separatedUp, `a matched 4% gain on this sample must separate up, got applies ${nest.applies} lo ${nest.lo}`);
  check(internalPrimaryCells(nested, [], 512, { min: 0.1, max: 0.3 }, 2, 2).bandReading === "refuted",
    "a frozen band above the interval must read as refuted");

  // 3. Balance. A co-bit whose share differs between the matched populations
  // is a contrast about the populations, not about the mechanism.
  const skewed = [cell(16, 90_000, 22_500), cell(80, 10_000, 2_500), cell(0, 96_000, 24_000), cell(64, 4_000, 1_000)];
  const skew = ip(skewed, 16);
  check(skew.balance.faults.length > 0 && !skew.applies, `a 6-point co-bit gap must fault, got faults [${skew.balance.faults}] applies ${skew.applies}`);
  check(exempt.balance.faults.length === 0 && prop.balance.faults.length === 0 && nest.balance.faults.length === 0,
    "a balanced fixture must produce no balance faults, else the tolerances refuse real evidence");
  // Records written before the steps column carry zero, which is unavailable
  // rather than a ratio of zero.
  const noSteps = [cell(16, 100_000, 25_000, "grid", 0), cell(0, 100_000, 24_000, "grid", 0)];
  const bare = ip(noSteps, 16);
  check(bare.balance.stepsPerRunRatio === null && bare.balance.faults.length === 0,
    "a record with no steps column must report the ratio as unavailable, not fault on it");
  // Arm composition, on the same rates: only the mix moved.
  const mixed = [
    cell(16, 90_000, 22_500, "grid"), cell(16, 10_000, 2_500, "grid-short"),
    cell(0, 60_000, 15_000, "grid"), cell(0, 40_000, 10_000, "grid-short"),
  ];
  check(ip(mixed, 16).balance.faults.some((x) => x.startsWith("arm composition")), "a 30-point arm composition gap must fault");

  // 4. Declaration. A bit off the roster, an instrument bit, and no bit at
  // all are three different inapplicable readings, and none of them is a
  // contrast.
  for (const [bit, want] of [[null, "no treatment bit declared"], [2048, "not on the roster"], [2, "instrument"], [8, "instrument"]] as Array<[number | null, string]>) {
    const r = ip(exempting, bit);
    check(!r.applies && (r.inapplicableReason ?? "").includes(want), `bit ${bit} must be inapplicable for ${want}, got ${r.inapplicableReason}`);
  }
  // A treatment too thin to carry a session-level claim, and a control too
  // small to resolve one.
  check(!ip([cell(16, 2_000, 500), cell(0, 100_000, 25_000)], 16).applies, "a treated share below the floor must be inapplicable");
  check(!ip([cell(16, 100_000, 25_000), cell(0, 10_000, 2_500)], 16).applies, "a matched control below the graded floor must be inapplicable");

  // 5. The difference in differences, where the baseline carries the bit too,
  // and the share shift that makes the internal read meaningless.
  const candSide = [cell(1, 100_000, 25_000), cell(0, 100_000, 20_000)];
  const baseSide = [cell(1, 100_000, 22_000), cell(0, 100_000, 20_000)];
  const did = internalPrimaryCells(candSide, baseSide, 1, band, 2, 2);
  check(did.differenceInDifferences, "a bit present on both sides must be differenced");
  check(Math.abs(did.ratio - (25_000 / 20_000) / (22_000 / 20_000)) < 1e-9, `the difference in differences must divide the two contrasts, got ${did.ratio}`);
  const shifted = internalPrimaryCells([cell(1, 180_000, 45_000), cell(0, 20_000, 4_000)], baseSide, 1, band, 2, 2);
  check(!shifted.applies && (shifted.inapplicableReason ?? "").includes("treated share shifted"),
    `a treated share that moved between candidate and baseline must be inapplicable, got ${shifted.inapplicableReason}`);

  // 6. The verdict the figures reach. A separated internal contrast merges
  // where nothing cross-binary separated; one below 1.0 closes; one inside
  // the floor reaches a human rather than merging on the cross-binary rung.
  const figures = (over: Partial<MergeFigures>): MergeFigures => ({
    hypothesisId: "h", kind: "add", ruleVersion: RULE_VERSION, primaryRung: PRIMARY_RUNG,
    superior: false, improved: [], regressed: [],
    primaryRungRegressed: false, deepRungsUnresolved: [], deltas: { [`depth>=${PRIMARY_RUNG}`]: 0.01 },
    primary: 0.01, primaryNullBand: 0.005, primaryInsideNullBand: false,
    throughput: { ratio: 1, floor: 0.8 }, sample: { chunks: 2, runs: 100, exposureSec: 100 },
    violationsOnlyImprovement: false, firing: { status: "fired", detail: "" }, prediction: null,
    predictedRungDelta: null, predictionInBand: null, touchesSemantics: false, touchesPolicy: false,
    internal: null, crossBinaryNullFloor: CROSS_BINARY_NULL_FLOOR, epochThroughput: null,
    ...over,
  });
  check(ruleVerdict(figures({ internal: nest })).verdict === "merge",
    `a separated internal contrast must merge with the cross-binary rung inside its floor, got ${ruleVerdict(figures({ internal: nest })).reason}`);
  const down = internalPrimaryCells([cell(16, 100_000, 20_000), cell(0, 100_000, 25_000)], [], 16, null, 2, 2);
  check(down.separatedDown && ruleVerdict(figures({ internal: down })).verdict === "close", "an internal contrast below 1.0 must close");
  const flat = internalPrimaryCells([cell(16, 100_000, 25_000), cell(0, 100_000, 25_000)], [], 16, null, 2, 2);
  check(ruleVerdict(figures({ internal: flat })).verdict === "human", "an internal contrast that resolves neither way must reach a human");
  check(ruleVerdict(figures({ internal: null })).verdict === "human", "a cross-binary delta inside the layout floor must not merge on the fallback path");
  check(ruleVerdict(figures({ internal: null, primary: 0.3, deltas: { [`depth>=${PRIMARY_RUNG}`]: 0.3 }, improved: [`depth>=${PRIMARY_RUNG}`] })).verdict === "merge",
    "a cross-binary gain that clears the layout floor and separates must merge on the fallback path");
  // The epoch budget, and the two-sided cross-binary cost read.
  check(ruleVerdict(figures({ internal: nest, epochThroughput: { frozenRps: 1000, cumulative: 0.95, floor: EPOCH_THROUGHPUT_FLOOR }, throughput: { ratio: 0.9, floor: 0.8 } })).verdict === "close",
    "a merge that would spend the epoch's throughput budget must close");
  check(ruleVerdict(figures({ internal: nest, primaryRungRegressed: true, deltas: { [`depth>=${PRIMARY_RUNG}`]: -0.2 } })).verdict === "close",
    "a cross-binary fall beyond the layout floor closes whatever the internal contrast says");
  check(ruleVerdict(figures({ internal: nest, primaryRungRegressed: true, deltas: { [`depth>=${PRIMARY_RUNG}`]: -0.01 } })).verdict === "merge",
    "a cross-binary fall inside the layout floor is not a cost reading");
  return f;
}
