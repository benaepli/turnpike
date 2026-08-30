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
import type { PanelSummary } from "./panel.js";
import type { Evaluation, GateDecision, Hypothesis, LadderMetrics, RateStratum } from "./schemas.js";
import { aggregateDepthCounts, aggregateViolations } from "./evaluate.js";
import { compareRatesPoisson, rateSuperiorCI, rateNonInferior, rateRatioSeparated, throughputCv, wilson } from "./stats.js";

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
    if (d.k === 4 && rateRatioSeparated(b.succ, b.n, d.succ, d.n, z)) regressed.push(`depth>=${d.k}`);
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
  return { ok: failures.length === 0, failures };
}

// Change-risk classification for the opt-in rule. Semantics-changing spur
// files route to needs_human even with green metrics.
const SEMANTICS_FILES = [
  "spur-core/src/simulator/core/exec.rs",
  "spur-core/src/simulator/history.rs",
];
export function classifyChangeRisk(changedSpurFiles: string[]): "opt_in" | "semantics" {
  for (const f of changedSpurFiles) {
    if (SEMANTICS_FILES.some((s) => f === s)) return "semantics";
  }
  return "opt_in";
}

/** A broad decline routes to review rather than blocking. Blocking is the
 *  collapse gate's job and it acts per member through the regression suite. */
export const PANEL_HUMAN_Z = 2.0;

export interface FinalGateInputs {
  hypothesis: Hypothesis;
  confirmEvals: Evaluation[];
  baselineEvals: Evaluation[];
  regressionPassed: boolean;
  /// Failing cases, "name: detail" joined. Carried so an environmental failure
  /// inside the suite is recognisable as one rather than counted as evidence.
  regressionDetail?: string | undefined;
  lintFailures: string[];
  changedSpurFiles: string[];
  throughputRatio: number | null; // cand runs per explore-second / baseline's
  // Below this ratio a gain cannot merge: the objective already credits
  // throughput, so a slower candidate has to have earned its rate. Defaults
  // to the regression suite's tolerance.
  throughputFloor?: number | undefined;
  // Required, not optional: an optional input nobody supplies is a defect no
  // typecheck can see, and this one disarmed the downgrade for every decision
  // the loop ever made.
  panel: PanelSummary | null;
  // The archive violation rate the candidate's violations are separated
  // against; null falls back to the baseline's own count.
  violationPrior?: RatePrior | null | undefined;
}

export const DEFAULT_THROUGHPUT_FLOOR = 0.8;

export function finalGate(i: FinalGateInputs): GateDecision {
  const cand = objectiveCounts(i.confirmEvals);
  const base = objectiveCounts(i.baselineEvals);
  const cmp = compareToBaseline(cand, base, MERGE_Z, i.violationPrior ?? null);
  const reasons: string[] = [];
  let verdict: GateDecision["verdict"];
  let harnessFailure = false;
  const floor = i.throughputFloor ?? DEFAULT_THROUGHPUT_FLOOR;

  if (i.lintFailures.length > 0) {
    verdict = "closed";
    reasons.push(`lint failures: ${i.lintFailures.join(", ")}`);
  } else if (!i.regressionPassed) {
    verdict = "closed";
    reasons.push(i.regressionDetail ? `regression suite failed: ${i.regressionDetail}` : "regression suite failed");
  } else if (cmp.stratumFault?.kind === "missing") {
    // The per-second objective was not tested. Closing would record a
    // harness gap as a negative result about the hypothesis.
    verdict = "blocked";
    harnessFailure = true;
    reasons.push(`no per-arm accounting: ${cmp.stratumFault.detail}`);
  } else if (cmp.stratumFault?.kind === "arms") {
    verdict = "needs_human";
    reasons.push(`the unit of comparison moved, so no per-second objective was tested: ${cmp.stratumFault.detail}`);
  } else {
    const kind = i.hypothesis.kind;
    if (kind === "add" || kind === "enabling") {
      const superior = cmp.improved.length > 0 && cmp.regressed.length === 0;
      const ni = nonInferior(cand, base);
      const pass = kind === "add" ? superior : superior || ni.ok;
      if ((i.throughputRatio ?? 1) < floor) {
        verdict = "closed";
        reasons.push(`throughput ratio ${(i.throughputRatio ?? 1).toFixed(3)} below floor ${floor}`);
      } else if (!pass) {
        verdict = "closed";
        reasons.push(kind === "add" ? `no CI-separated improvement (improved=[${cmp.improved}], regressed=[${cmp.regressed}])` : `neither superior nor non-inferior: ${ni.failures.join(",")}`);
      } else if (classifyChangeRisk(i.changedSpurFiles) === "semantics") {
        verdict = "needs_human";
        reasons.push("touches execution-semantics files");
      } else if (cmp.improved.length === 1 && cmp.improved[0] === "violations") {
        // A violation belongs to the configuration that produced it. They
        // arrive at about one per 1.7M runs, so a chunk carries one often
        // enough that the candidate running at the time is usually not the
        // reason. The arm it came from is recorded beside the evidence;
        // compare it with the arms the change touches.
        verdict = "needs_human";
        reasons.push("the only separated improvement is a violation; check its arm in violating_runs.json against the arms this change touches");
      } else {
        verdict = "auto_merge";
        reasons.push(`improved: ${cmp.improved.join(", ") || "(enabling, non-inferior)"}`);
      }
    } else if (kind === "ablate") {
      const ni = nonInferior(cand, base);
      const cheaper = (i.throughputRatio ?? 1) >= 1.0 || i.changedSpurFiles.length > 0;
      if (!ni.ok) {
        verdict = "closed";
        reasons.push(`not non-inferior: ${ni.failures.join(", ")}`);
      } else if (!cheaper) {
        verdict = "closed";
        reasons.push("non-inferior but no cost improvement");
      } else {
        verdict = "auto_merge";
        reasons.push("non-inferior ablation (flag-off stage)");
      }
    } else {
      // meta and grader kinds route to needs_human in v1: meta needs the
      // replay harness, grader needs the golden-corpus validator run by a
      // human-triggered command until it is fully wired.
      verdict = "needs_human";
      reasons.push(`${kind} changes require human review in v1`);
    }
  }

  // A broad decline across judging members routes to review. It never blocks:
  // blocking is the collapse gate, which acts per member through the
  // regression suite and reaches this function as regressionPassed.
  if (verdict === "auto_merge" && i.panel !== null && i.panel.combinedZ !== null
      && i.panel.combinedZ <= -PANEL_HUMAN_Z) {
    verdict = "needs_human";
    reasons.push(`panel detection down across ${i.panel.judging.length} judging member(s) (combined z ${i.panel.combinedZ.toFixed(2)})`);
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
    // Recorded only when a panel judged. Writing 0 for "no panel" made an
    // unsupplied panel indistinguishable from a neutral one, which is what
    // hid the wiring defect across 95 decisions.
    objectiveDeltas: {
      ...cmp.deltas, primary, throughput,
      ...(i.panel?.combinedZ != null ? { panelZ: i.panel.combinedZ } : {}),
    },
    regressionPassed: i.regressionPassed,
    lintPassed: i.lintFailures.length === 0,
    ...(harnessFailure ? { harnessFailure: true } : {}),
  };
}

export function summarizeLadder(m: LadderMetrics): string {
  const p = (k: number): string => {
    const c = m.depthAtLeast[k - 1] ?? 0;
    const [lo, hi] = wilson(c, m.gradedRuns);
    return `P(d>=${k})=${(m.gradedRuns ? c / m.gradedRuns : 0).toFixed(4)} [${lo.toFixed(4)},${hi.toFixed(4)}]`;
  };
  const perSec = (k: number): string => {
    const c = m.depthAtLeast[k - 1] ?? 0;
    return m.exposureMs > 0 ? `d>=${k}/s=${(c / (m.exposureMs / 1000)).toFixed(2)}` : `d>=${k}/s=-`;
  };
  return `runs=${m.runs} viol=${m.violations} unk=${m.unknown} ${p(4)} ${p(6)} ${p(8)} ${perSec(6)} h2=${m.h2Rate.toFixed(3)} rps=${m.runsPerSec.toFixed(1)} exposure=${Math.round(m.exposureMs / 1000)}s`;
}

// Gate for perf-kind hypotheses: A/B bench superiority is the objective;
// ladder non-inferiority + regression are the semantic safety net. Perf work
// legitimately touches hot execution files, so the semantics-file rule is
// relaxed here - but only behind promote-fidelity non-inferiority.
export interface PerfGateInputs {
  hypothesis: Hypothesis;
  bench: BenchResult;
  screenNI: { ok: boolean; failures: string[] };
  promoteNI: boolean | null; // null = not run
  touchesSemantics: boolean;
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
  } else if (!i.screenNI.ok) {
    verdict = "closed";
    reasons.push(`ladder not non-inferior at screen: ${i.screenNI.failures.join(", ")}`);
  } else if (!i.regressionPassed) {
    verdict = "closed";
    reasons.push("regression suite failed");
  } else if (i.touchesSemantics && i.promoteNI === false) {
    verdict = "closed";
    reasons.push("semantics files touched and promote-fidelity non-inferiority failed");
  } else if (i.touchesSemantics && i.promoteNI === null) {
    verdict = "needs_human";
    reasons.push("semantics files touched; promote-fidelity non-inferiority not available");
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

/** The panel's authority, asserted against finalGate itself. */
export function selfTestPanelAuthority(): string[] {
  const f: string[] = [];
  const check = (c: boolean, m: string): void => { if (!c) f.push(m); };
  const h = { id: "h", kind: "add", category: "scheduler" } as unknown as Hypothesis;
  const base: FinalGateInputs = {
    hypothesis: h, confirmEvals: [], baselineEvals: [], regressionPassed: true,
    lintFailures: [], changedSpurFiles: [], throughputRatio: 1, panel: null,
  };
  const panel = (combinedZ: number | null, judging: string[]): PanelSummary => ({
    members: [], judging, nonJudging: [], combinedZ, collapsedMembers: [], wallMs: 0,
  });

  const noPanel = finalGate(base);
  const neutral = finalGate({ ...base, panel: panel(0.05, ["a", "b"]) });
  check(noPanel.verdict === neutral.verdict,
    `a neutral panel must not change the verdict: ${noPanel.verdict} vs ${neutral.verdict}`);

  const declined = finalGate({ ...base, panel: panel(-2.5, ["a", "b"]) });
  check(declined.verdict === "needs_human" || noPanel.verdict !== "auto_merge",
    `a combined z of -2.5 must downgrade an auto_merge, got ${declined.verdict}`);
  check(noPanel.verdict === "closed" || declined.verdict !== "closed",
    "the panel must never turn a non-closed verdict into a closure");

  const improved = finalGate({ ...base, panel: panel(3.0, ["a", "b"]) });
  check(improved.verdict === noPanel.verdict,
    "a panel that improved must not promote anything the ladder did not");

  const noStanding = finalGate({ ...base, panel: panel(null, []) });
  check(noStanding.verdict === noPanel.verdict,
    "a panel with no judging member must not change the verdict");

  check((declined.objectiveDeltas["panelZ"] ?? 0) === -2.5, "panelZ must be recorded on the decision");
  check(!("panelZ" in noPanel.objectiveDeltas), "a decision made without a panel must not record a panelZ");
  return f;
}
