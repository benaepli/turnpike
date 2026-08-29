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
import type { Evaluation, GateDecision, Hypothesis, LadderMetrics } from "./schemas.js";
import { aggregateDepthCounts, aggregateViolations } from "./evaluate.js";
import { compareRatesPoisson, rateSuperiorCI, rateNonInferior, rateRatioSeparated, throughputCv, wilson } from "./stats.js";

export interface ObjectiveCounts {
  violations: { succ: number; n: number };
  depth: Array<{ k: number; succ: number; n: number }>; // k = 4..8, n = graded runs
  h2: { succ: number; n: number };
  runs: number;
  chunks: number;
  exposureSec: number;
  throughputCv: number;
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
  };
}

// Variance the throughput jitter adds to the log ratio of two pooled
// per-second rates. One definition, used by the sequential rule and the
// merge gate alike so the two cannot disagree on it.
export function exposureVarianceOf(
  cand: { throughputCv: number; chunks: number }, base: { throughputCv: number; chunks: number },
): number {
  return (cand.chunks > 0 ? (cand.throughputCv ** 2) / cand.chunks : 0)
    + (base.chunks > 0 ? (base.throughputCv ** 2) / base.chunks : 0);
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
export function compareToBaseline(cand: ObjectiveCounts, base: ObjectiveCounts, z = 1.96): Comparison {
  const improved: string[] = [];
  const regressed: string[] = [];
  const deltas: Record<string, number> = {};
  const rate = (c: { succ: number; n: number }): number => (c.n > 0 ? c.succ / c.n : 0);
  const perSec = (succ: number, exposureSec: number): number => (exposureSec > 0 ? succ / exposureSec : 0);
  const xv = exposureVarianceOf(cand, base);

  deltas["violations"] = rate(cand.violations) - rate(base.violations);
  if (cand.violations.succ > 0 && base.violations.succ === 0) improved.push("violations");
  else if (rateSuperiorCI(cand.violations.succ, cand.violations.n, base.violations.succ, base.violations.n, z)) improved.push("violations");
  if (rateSuperiorCI(base.violations.succ, base.violations.n, cand.violations.succ, cand.violations.n, z)) regressed.push("violations");

  // Depth deltas are relative rates per explore-second; the guard against
  // shallower runs is per graded run.
  for (const d of cand.depth) {
    const b = base.depth.find((x) => x.k === d.k);
    if (!b) continue;
    const cr = perSec(d.succ, cand.exposureSec);
    const br = perSec(b.succ, base.exposureSec);
    deltas[`depth>=${d.k}`] = br > 0 ? cr / br - 1 : 0;
    if ((ADVANCE_RUNGS as readonly number[]).includes(d.k)
        && rateRatioSeparated(d.succ, cand.exposureSec, b.succ, base.exposureSec, z, xv)) improved.push(`depth>=${d.k}`);
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

  return { improved, regressed, deltas };
}

// Screen gate: 2-sigma Poisson exceedance. For each objective the candidate
// must show more successes than expected-under-baseline plus two standard
// deviations (sqrt of expectation), with an absolute floor of 5 successes so
// single-digit counts can never advance. Sizing rationale: research/PARAMETERS.md.
export function screenAdvances(cand: ObjectiveCounts, base: ObjectiveCounts): { advance: boolean; why: string } {
  const rate = (c: { succ: number; n: number }): number => (c.n > 0 ? c.succ / c.n : 0);
  if (cand.violations.succ > 0 && base.violations.succ === 0) return { advance: true, why: "violations appeared" };
  // The expectation uses the baseline's Wilson upper bound: a rung with zero
  // observed successes in a small baseline sample is not evidence that its
  // rate is zero.
  const exceeds2Sigma = (succ: number, n: number, b: { succ: number; n: number }): { hit: boolean; expected: number } => {
    const [, upper] = wilson(b.succ, b.n);
    const expected = upper * n;
    return { hit: succ >= 5 && succ > expected + 2 * Math.sqrt(Math.max(expected, 1)), expected };
  };
  for (const d of cand.depth) {
    const b = base.depth.find((x) => x.k === d.k);
    if (!b) continue;
    const r = exceeds2Sigma(d.succ, d.n, b);
    if (r.hit) {
      return { advance: true, why: `depth>=${d.k}: ${d.succ} successes vs ${r.expected.toFixed(1)} expected (+2sigma over baseline CI)` };
    }
  }
  if (exceeds2Sigma(cand.h2.succ, cand.h2.n, base.h2).hit) return { advance: true, why: "h2 +2sigma" };
  return { advance: false, why: "no 2-sigma exceedance on any objective" };
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
  panel?: PanelSummary | undefined;
}

export const DEFAULT_THROUGHPUT_FLOOR = 0.8;

export function finalGate(i: FinalGateInputs): GateDecision {
  const cand = objectiveCounts(i.confirmEvals);
  const base = objectiveCounts(i.baselineEvals);
  const cmp = compareToBaseline(cand, base, MERGE_Z);
  const reasons: string[] = [];
  let verdict: GateDecision["verdict"];
  const floor = i.throughputFloor ?? DEFAULT_THROUGHPUT_FLOOR;

  if (i.lintFailures.length > 0) {
    verdict = "closed";
    reasons.push(`lint failures: ${i.lintFailures.join(", ")}`);
  } else if (!i.regressionPassed) {
    verdict = "closed";
    reasons.push(i.regressionDetail ? `regression suite failed: ${i.regressionDetail}` : "regression suite failed");
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
  if (verdict === "auto_merge" && i.panel !== undefined && i.panel.combinedZ !== null
      && i.panel.combinedZ <= -PANEL_HUMAN_Z) {
    verdict = "needs_human";
    reasons.push(`panel detection down across ${i.panel.judging.length} judging member(s) (combined z ${i.panel.combinedZ.toFixed(2)})`);
  }

  // Primary: violations when they move; otherwise depth>=6 per second - the
  // deepest rung with the power to decide (POWER_FLOOR.md). The violations
  // delta is an absolute rate difference and the depth deltas are relative
  // ratios; a consumer must not mix the two scales.
  const primary = cmp.deltas["violations"] !== 0 ? (cmp.deltas["violations"] ?? 0) : (cmp.deltas["depth>=6"] ?? 0);
  // Run rate multiplies every rung, so it is inside the objective now; it is
  // still recorded on its own so erosion across merges stays visible as a
  // series.
  const throughput = (i.throughputRatio ?? 1) - 1;
  return {
    hypothesisId: i.hypothesis.id,
    verdict,
    reasons,
    objectiveDeltas: { ...cmp.deltas, primary, throughput, panelZ: i.panel?.combinedZ ?? 0 },
    regressionPassed: i.regressionPassed,
    lintPassed: i.lintFailures.length === 0,
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
    lintFailures: [], changedSpurFiles: [], throughputRatio: 1,
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
  return f;
}
