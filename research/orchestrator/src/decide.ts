// Deterministic acceptance gates. Every verdict is code, not model judgment.
// Objectives, in priority order:
//   1. violations (porcupine ground truth)
//   2. P(prefix depth >= k) for k = 8 down to 4
//   3. H2 stale-incarnation rate (the hazard most causally tied to the bug)
// Superiority (add/enabling gains) = CI-separated improvement on >=1 objective
// with no CI-separated regression on violations or depth>=4.
// Non-inferiority (ablate/enabling base) = no objective worse than margin.
import type { BenchResult } from "./bench.js";
import type { Evaluation, GateDecision, Hypothesis, LadderMetrics } from "./schemas.js";
import { aggregateDepthCounts, aggregateViolations } from "./evaluate.js";
import { rateImprovesCI, rateNonInferior, wilson } from "./stats.js";

export interface ObjectiveCounts {
  violations: { succ: number; n: number };
  depth: Array<{ k: number; succ: number; n: number }>; // k = 4..8
  h2: { succ: number; n: number };
}

export function objectiveCounts(evals: Evaluation[]): ObjectiveCounts {
  const ok = evals.filter((e) => e.ok);
  const depth = [4, 5, 6, 7, 8].map((k) => ({ k, ...aggregateDepthCounts(ok, k) }));
  const graded = ok.reduce((a, e) => a + e.metrics.gradedRuns, 0);
  const h2succ = ok.reduce((a, e) => a + Math.round(e.metrics.h2Rate * e.metrics.runs), 0);
  const runs = ok.reduce((a, e) => a + e.metrics.runs, 0);
  void graded;
  return {
    violations: aggregateViolations(ok),
    depth,
    h2: { succ: h2succ, n: runs },
  };
}

export interface Comparison {
  improved: string[];
  regressed: string[];
  deltas: Record<string, number>;
}

// z defaults to 1.96 (promote: spends compute, not merges). The merge gate
// passes MERGE_Z = 2.7 — Bonferroni over the ~7 objectives tested, holding
// familywise false-positive near 5% per hypothesis.
export const MERGE_Z = 2.7;
export function compareToBaseline(cand: ObjectiveCounts, base: ObjectiveCounts, z = 1.96): Comparison {
  const improved: string[] = [];
  const regressed: string[] = [];
  const deltas: Record<string, number> = {};
  const rate = (c: { succ: number; n: number }): number => (c.n > 0 ? c.succ / c.n : 0);

  deltas["violations"] = rate(cand.violations) - rate(base.violations);
  if (cand.violations.succ > 0 && base.violations.succ === 0) improved.push("violations");
  else if (rateImprovesCI(cand.violations.succ, cand.violations.n, base.violations.succ, base.violations.n, z)) improved.push("violations");
  if (rateImprovesCI(base.violations.succ, base.violations.n, cand.violations.succ, cand.violations.n, z)) regressed.push("violations");

  for (const d of cand.depth) {
    const b = base.depth.find((x) => x.k === d.k);
    if (!b) continue;
    deltas[`depth>=${d.k}`] = rate(d) - rate(b);
    if (rateImprovesCI(d.succ, d.n, b.succ, b.n, z)) improved.push(`depth>=${d.k}`);
    if (d.k <= 4 && rateImprovesCI(b.succ, b.n, d.succ, d.n, z)) regressed.push(`depth>=${d.k}`);
  }

  deltas["h2"] = rate(cand.h2) - rate(base.h2);
  if (rateImprovesCI(cand.h2.succ, cand.h2.n, base.h2.succ, base.h2.n, z)) improved.push("h2");

  return { improved, regressed, deltas };
}

// Screen gate: 2-sigma Poisson exceedance. For each objective the candidate
// must show more successes than expected-under-baseline plus two standard
// deviations (sqrt of expectation), with an absolute floor of 5 successes so
// single-digit counts can never advance (derivation: research/PARAMETERS.md;
// the old "+15% point estimate" rule advanced on 4-vs-3.6 Poisson noise).
export function screenAdvances(cand: ObjectiveCounts, base: ObjectiveCounts): { advance: boolean; why: string } {
  const rate = (c: { succ: number; n: number }): number => (c.n > 0 ? c.succ / c.n : 0);
  if (cand.violations.succ > 0 && base.violations.succ === 0) return { advance: true, why: "violations appeared" };
  const exceeds2Sigma = (succ: number, n: number, baseRate: number): boolean => {
    const expected = baseRate * n;
    return succ >= 5 && succ > expected + 2 * Math.sqrt(Math.max(expected, 1));
  };
  for (const d of cand.depth) {
    const b = base.depth.find((x) => x.k === d.k);
    if (b && exceeds2Sigma(d.succ, d.n, rate(b))) {
      return { advance: true, why: `depth>=${d.k}: ${d.succ} successes vs ${(rate(b) * d.n).toFixed(1)} expected (+2sigma)` };
    }
  }
  if (exceeds2Sigma(cand.h2.succ, cand.h2.n, rate(base.h2))) return { advance: true, why: "h2 +2sigma" };
  return { advance: false, why: "no 2-sigma exceedance on any objective" };
}

// Non-inferiority for ablations/enabling: margins are RELATIVE (default 25%
// of the baseline rate per objective, floored at 0.2pp) so the tolerance
// scales with each rung — an absolute margin either swamps rare rungs or
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

export interface FinalGateInputs {
  hypothesis: Hypothesis;
  confirmEvals: Evaluation[];
  baselineEvals: Evaluation[];
  regressionPassed: boolean;
  lintFailures: string[];
  changedSpurFiles: string[];
  throughputRatio: number | null; // cand runsPerSec / baseline runsPerSec
}

export function finalGate(i: FinalGateInputs): GateDecision {
  const cand = objectiveCounts(i.confirmEvals);
  const base = objectiveCounts(i.baselineEvals);
  const cmp = compareToBaseline(cand, base, MERGE_Z);
  const reasons: string[] = [];
  let verdict: GateDecision["verdict"];

  if (i.lintFailures.length > 0) {
    verdict = "closed";
    reasons.push(`lint failures: ${i.lintFailures.join(", ")}`);
  } else if (!i.regressionPassed) {
    verdict = "closed";
    reasons.push("regression suite failed");
  } else {
    const kind = i.hypothesis.kind;
    if (kind === "add" || kind === "enabling") {
      const superior = cmp.improved.length > 0 && cmp.regressed.length === 0;
      const ni = nonInferior(cand, base);
      const pass = kind === "add" ? superior : superior || ni.ok;
      if (!pass) {
        verdict = "closed";
        reasons.push(kind === "add" ? `no CI-separated improvement (improved=[${cmp.improved}], regressed=[${cmp.regressed}])` : `neither superior nor non-inferior: ${ni.failures.join(",")}`);
      } else if (classifyChangeRisk(i.changedSpurFiles) === "semantics") {
        verdict = "needs_human";
        reasons.push("touches execution-semantics files");
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

  const rate = (c: { succ: number; n: number }): number => (c.n > 0 ? c.succ / c.n : 0);
  const primary = cmp.deltas["violations"] !== 0 ? (cmp.deltas["violations"] ?? 0) : (cmp.deltas["depth>=8"] ?? 0);
  return {
    hypothesisId: i.hypothesis.id,
    verdict,
    reasons,
    objectiveDeltas: { ...cmp.deltas, primary },
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
  return `runs=${m.runs} viol=${m.violations} unk=${m.unknown} ${p(4)} ${p(6)} ${p(8)} h2=${m.h2Rate.toFixed(3)} rps=${m.runsPerSec.toFixed(1)}`;
}

// Gate for perf-kind hypotheses: A/B bench superiority is the objective;
// ladder non-inferiority + regression are the semantic safety net. Perf work
// legitimately touches hot execution files, so the semantics-file rule is
// relaxed here — but only behind promote-fidelity non-inferiority.
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
