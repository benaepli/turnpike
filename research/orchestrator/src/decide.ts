// Deterministic acceptance gates. Every verdict is code, not model judgment.
// Objectives, in priority order:
//   1. violations (porcupine ground truth)
//   2. prefix-depth rung events per explore-second, depth>=6 first, then 5
//      and 4; depth>=7 and 8 are recorded, never decided on
//   3. H2 stale-incarnation rate, recorded
// Superiority (add/enabling gains) = separated improvement on >=1 objective
// with no separated regression on violations or per-run depth>=4, and
// throughput at or above the floor.
// Non-inferiority (ablate/enabling base) = no objective worse than margin.
import type { BenchResult } from "./bench.js";
import type { Evaluation, GateDecision, Hypothesis, HypothesisKind, Prediction, RateStratum } from "./schemas.js";
import { aggregateDepthCounts, aggregateViolations } from "./evaluate.js";
import { firingIsHarnessGap, firingPasses, type FiringResult } from "./firing.js";
import { compareRatesPoisson, rateSuperiorCI, rateNonInferior, rateRatioSeparated, throughputCv } from "./stats.js";
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
  depth: Array<{ k: number; succ: number; n: number }>; // k = 4..8, n = graded runs
  h2: { succ: number; n: number };
  runs: number;
  chunks: number;
  exposureSec: number;
  throughputCv: number;
  rateStratum: RateStratum | null;
}

export function objectiveCounts(evals: Evaluation[]): ObjectiveCounts {
  const ok = evals.filter((e) => e.ok);
  const depth = [4, 5, 6, 7, 8].map((k) => ({ k, ...aggregateDepthCounts(ok, k) }));
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

// The rungs a separated per-second gain can advance on. Deeper rungs carry
// too few events per session to decide (research/observations/POWER_FLOOR.md).
export const ADVANCE_RUNGS = [4, 5, 6, 7, 8] as const;
// The rung the objective is named on. A separated gain on a shallower rung
// does not carry a merge past a primary rung that is known to have fallen.
export const PRIMARY_RUNG = 6;

export interface Comparison {
  improved: string[];
  regressed: string[];
  deltas: Record<string, number>;
  stratumFault: StratumFault | null;
}

/** Violations when they are the separated improvement, otherwise depth>=6
 *  per second. The violations delta is an absolute rate difference and the
 *  depth deltas are relative ratios; a consumer must not mix the two scales.
 *  Selecting on `improved` rather than on a non-zero delta is load-bearing
 *  once violations are compared against a prior: a clean candidate then has
 *  a tiny non-zero violations delta, which would otherwise displace depth>=6
 *  in every recorded primary. */
export function primaryDelta(cmp: Comparison): number {
  return cmp.improved.includes("violations") ? (cmp.deltas["violations"] ?? 0) : (cmp.deltas["depth>=6"] ?? 0);
}

// z defaults to 1.96 (promote: spends compute, not merges). The merge gate
// passes MERGE_Z = 2.7 - Bonferroni over the objectives tested, holding
// familywise false-positive near 5% per hypothesis.
export const MERGE_Z = 2.7;
// The relative margin the deep rungs per run may not fall beyond; the same
// margin the non-inferiority kinds are held to.
export const DEEP_RUNG_MARGIN = 0.25;
// The deep-rung guard is the same posterior test the sequential rule
// applies, with the same margin, so a rejection there is never contradicted
// here whatever the event counts.
const DEEP_RUNG_NIP = 0.95;
const DEEP_RUNG_DRAWS = 2000;
const DEEP_RUNG_SEED = 7;
export function compareToBaseline(
  cand: ObjectiveCounts, base: ObjectiveCounts, z = 1.96, violationPrior: RatePrior | null = null,
): Comparison {
  const improved: string[] = [];
  const regressed: string[] = [];
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
      if ((ADVANCE_RUNGS as readonly number[]).includes(d.k)
          && rateRatioSeparated(cSucc, cs.exposureSec, bSucc, bs.exposureSec, z, xv)) improved.push(`depth>=${d.k}`);
    }
    // The deep rungs per run may not fall beyond the non-inferiority margin:
    // the sequential rule holds an advance until they are known to hold.
    if (d.k === 5 || d.k === 6) {
      const g = compareRatesPoisson(d.succ, d.n, b.succ, b.n, 0, DEEP_RUNG_MARGIN, DEEP_RUNG_DRAWS, DEEP_RUNG_SEED + d.k);
      if (g.pRegress >= DEEP_RUNG_NIP) regressed.push(`depth>=${d.k} per run`);
    }
  }

  deltas["h2"] = rate(cand.h2) - rate(base.h2);
  deltas["throughput"] = cand.exposureSec > 0 && base.exposureSec > 0 && base.runs > 0
    ? (cand.runs / cand.exposureSec) / (base.runs / base.exposureSec) - 1
    : 0;

  return { improved, regressed, deltas, stratumFault: fault };
}

// Non-inferiority for ablations/enabling: margins are RELATIVE (default 25%
// of the baseline rate per objective, floored at 0.2pp) so the tolerance
// scales with each rung - an absolute margin either swamps rare rungs or
// over-constrains common ones (derivation: research/PARAMETERS.md).
export function nonInferior(cand: ObjectiveCounts, base: ObjectiveCounts, relMargin = 0.25): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const marginFor = (b: { succ: number; n: number }): number =>
    Math.max(relMargin * (b.n > 0 ? b.succ / b.n : 0), 0.002);
  if (!rateNonInferior(cand.violations.succ, cand.violations.n, base.violations.succ, base.violations.n, marginFor(base.violations))) failures.push("violations");
  const c4 = cand.depth.find((d) => d.k === 4);
  const b4 = base.depth.find((d) => d.k === 4);
  if (c4 && b4 && !rateNonInferior(c4.succ, c4.n, b4.succ, b4.n, marginFor(b4))) failures.push("depth>=4");
  if (!rateNonInferior(cand.h2.succ, cand.h2.n, base.h2.succ, base.h2.n, marginFor(base.h2))) failures.push("h2");
  // The rung the objective is named on, on the stratified per-second rate the
  // superiority side separates improvements on, and by the same test with the
  // arguments swapped. Without it the per-run margins above are the whole of
  // non-inferiority and the primary rung is never read. Vacuous when either
  // side carries no stratum: a comparison that does not exist is not a
  // failure, and stratumFault decides that case upstream.
  const cs = cand.rateStratum;
  const bs = base.rateStratum;
  if (cs !== null && bs !== null) {
    const cSucc = cs.depth[PRIMARY_RUNG - 1] ?? 0;
    const bSucc = bs.depth[PRIMARY_RUNG - 1] ?? 0;
    if (rateRatioSeparated(bSucc, bs.exposureSec, cSucc, cs.exposureSec, MERGE_Z, rateVarianceOf(cs, bs, PRIMARY_RUNG))) {
      failures.push(`depth>=${PRIMARY_RUNG}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

// The kinds whose evidence is read as non-inferiority rather than as a
// separated gain. The sequential sampler picks its stopping rule from this
// same predicate, so the rule cannot advance a candidate the gate then
// closes for want of an improvement it was never asked for.
export function judgedByNonInferiority(kind: HypothesisKind): boolean {
  return kind === "ablate" || kind === "enabling" || kind === "meta";
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
  judgedByNonInferiority: boolean;
  // The rule's own reading of the same figures, as evidence rather than as a
  // branch: a separated improvement with no separated regression, and the
  // non-inferiority margins the ablate and enabling kinds are held to.
  superior: boolean;
  improved: string[];
  regressed: string[];
  nonInferiorFailures: string[];
  // True when the candidate is at least as fast, or brought a spur change to
  // pay for its cost. An ablation that is neither buys nothing.
  cheaper: boolean;
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

function figuresOf(i: FinalGateInputs, cand: ObjectiveCounts, base: ObjectiveCounts, cmp: Comparison): MergeFigures {
  const ni = nonInferior(cand, base);
  const cs = cand.rateStratum;
  const bs = base.rateStratum;
  const band = nullBand(cs?.depth[PRIMARY_RUNG - 1] ?? 0, bs?.depth[PRIMARY_RUNG - 1] ?? 0);
  const primary = primaryDelta(cmp);
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
    judgedByNonInferiority: judgedByNonInferiority(i.hypothesis.kind),
    superior: cmp.improved.length > 0 && cmp.regressed.length === 0,
    improved: cmp.improved,
    regressed: cmp.regressed,
    nonInferiorFailures: ni.failures,
    cheaper: (i.throughputRatio ?? 1) >= 1.0 || i.changedSpurFiles.length > 0,
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
  };
}

/** The verdict the statistical rule reaches on the figures. It is the
 *  fallback whenever no other verdict is supplied, so an unavailable decider
 *  cannot stop the loop, and it is what the offline replay re-decides
 *  through. */
export function ruleVerdict(f: MergeFigures): { verdict: MergeVerdict; reason: string } {
  if (f.kind === "ablate") {
    if (f.nonInferiorFailures.length > 0) return { verdict: "close", reason: `not non-inferior: ${f.nonInferiorFailures.join(", ")}` };
    if (!f.cheaper) return { verdict: "close", reason: "non-inferior but no cost improvement" };
    return { verdict: "merge", reason: "non-inferior ablation (flag-off stage)" };
  }
  if (f.throughput.ratio < f.throughput.floor) {
    return { verdict: "close", reason: `throughput ratio ${f.throughput.ratio.toFixed(3)} below floor ${f.throughput.floor}` };
  }
  if (!(f.superior || (f.judgedByNonInferiority && f.nonInferiorFailures.length === 0))) {
    return {
      verdict: "close",
      reason: f.judgedByNonInferiority
        ? `neither superior nor non-inferior: ${f.nonInferiorFailures.join(",")}`
        : `no CI-separated improvement (improved=[${f.improved}], regressed=[${f.regressed}])`,
    };
  }
  if (f.violationsOnlyImprovement) {
    return { verdict: "human", reason: "the only separated improvement is a violation; check its arm in violating_runs.json against the arms this change touches" };
  }
  return { verdict: "merge", reason: `improved: ${f.improved.join(", ") || "(non-inferior)"}` };
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
  if (f.nonInferiorFailures.length > 0) out.push(`separated below baseline on ${f.nonInferiorFailures.join(", ")}`);
  if (f.throughput.ratio < f.throughput.floor) out.push(`throughput ratio ${f.throughput.ratio.toFixed(3)} below floor ${f.throughput.floor}`);
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
  return { stop: null, figures: figuresOf(i, cand, base, cmp), cmp, cand };
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

  const h = { id: "h", kind: "add", category: "scheduler" } as unknown as Hypothesis;
  const base: FinalGateInputs = {
    hypothesis: h, confirmEvals: [], baselineEvals: [], regressionPassed: true,
    lintFailures: [], changedSpurFiles: [], changedSuperFiles: [], throughputRatio: 1, throughputFloor: 0.8,
    unmeasurable: [], firing: { status: "not-claimed", detail: "" },
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
    check(sampled === 5, `loop.ts must use sampled once per branch plus its definition (5), found ${sampled}`);
  }
  return f;
}
