// Sequential evaluation: sample the candidate in chunks and stop as soon as
// the pooled evidence decides, instead of judging on a fixed sample. The
// decision rule is a pure function of pooled counts so it can be simulated
// offline with the same code that runs live.
//
// A chunk is a fixed explore budget, and the objective is rung events per
// explore-second: a change that buys throughput raises every rung's rate,
// and one that slows the explorer has to raise the per-run rate by more than
// it costs. The per-run guards stay per run; their job is to catch runs
// getting shallower, and throughput has its own floor.
import type { Policy } from "./policy.js";
import { runOneEvaluation, type EvalContext } from "./evaluate.js";
import type { LoopState } from "./state.js";
import { compareRatesPoisson, rateRatioSeparated, throughputCv } from "./stats.js";
import { MERGE_Z, compareToBaseline, exposureVarianceOf, objectiveCounts } from "./decide.js";
import { HARD_LIMITS } from "./policy.js";
import { Evaluation, SeqState } from "./schemas.js";

export function loadSeqState(state: LoopState, id: string): SeqState | null {
  const raw = state.getMeta(`seq:${id}`);
  if (!raw) return null;
  const p = SeqState.safeParse(JSON.parse(raw));
  return p.success ? p.data : null;
}

export interface PooledCounts {
  runs: number;
  graded: number;
  chunks: number;
  exposureSec: number;
  depth4: number;
  depth5: number;
  depth6plus: number;
  depth7plus: number;
  depth8plus: number;
  violations: number;
  h2Count: number;
  rpsChunks: number[];
}

export type SeqKind = "superiority" | "noninferiority";
export type SeqVerdict = "advance" | "reject" | "continue" | "inconclusive" | "escalate";

export interface SeqDecision {
  verdict: SeqVerdict;
  reason: string;
  posteriors: Record<string, number>;
}

export function emptyCounts(): PooledCounts {
  return {
    runs: 0, graded: 0, chunks: 0, exposureSec: 0, depth4: 0, depth5: 0, depth6plus: 0,
    depth7plus: 0, depth8plus: 0, violations: 0, h2Count: 0, rpsChunks: [],
  };
}

export function pooledCountsOf(evals: Evaluation[]): PooledCounts {
  const c = emptyCounts();
  for (const e of evals) {
    if (!e.ok) continue;
    const d = e.metrics.depthAtLeast;
    c.runs += e.metrics.runs;
    c.graded += e.metrics.gradedRuns;
    c.chunks += 1;
    c.exposureSec += e.metrics.exposureMs / 1000;
    c.depth4 += d[3] ?? 0;
    c.depth5 += d[4] ?? 0;
    c.depth6plus += d[5] ?? 0;
    c.depth7plus += d[6] ?? 0;
    c.depth8plus += d[7] ?? 0;
    c.violations += e.metrics.violations;
    c.h2Count += Math.round(e.metrics.h2Rate * e.metrics.runs);
    c.rpsChunks.push(e.metrics.runsPerSec);
  }
  return c;
}

export function addCounts(a: PooledCounts, b: PooledCounts): PooledCounts {
  return {
    runs: a.runs + b.runs, graded: a.graded + b.graded, chunks: a.chunks + b.chunks,
    exposureSec: a.exposureSec + b.exposureSec,
    depth4: a.depth4 + b.depth4, depth5: a.depth5 + b.depth5, depth6plus: a.depth6plus + b.depth6plus,
    depth7plus: a.depth7plus + b.depth7plus, depth8plus: a.depth8plus + b.depth8plus,
    violations: a.violations + b.violations, h2Count: a.h2Count + b.h2Count,
    rpsChunks: [...a.rpsChunks, ...b.rpsChunks],
  };
}

export function pooledFromSeq(seq: SeqState): PooledCounts {
  return {
    runs: seq.runs, graded: seq.graded, chunks: seq.chunks, exposureSec: seq.exposureSec,
    depth4: seq.depth4, depth5: seq.depth5, depth6plus: seq.depth6plus,
    depth7plus: seq.depth7plus, depth8plus: seq.depth8plus,
    violations: seq.violations, h2Count: seq.h2Count, rpsChunks: seq.rpsChunks,
  };
}

// Variance the throughput jitter adds to the log ratio of two pooled rates,
// by the same definition the merge gate uses.
export function exposureVariance(cand: PooledCounts, base: PooledCounts): number {
  return exposureVarianceOf(
    { throughputCv: throughputCv(cand.rpsChunks), chunks: cand.chunks },
    { throughputCv: throughputCv(base.rpsChunks), chunks: base.chunks },
  );
}

export function throughputRatioOf(cand: PooledCounts, base: PooledCounts): number {
  if (cand.exposureSec <= 0 || base.exposureSec <= 0 || base.runs <= 0) return 1;
  return (cand.runs / cand.exposureSec) / (base.runs / base.exposureSec);
}

export type SeqPolicy = Policy["sequential"];
// The stopping rule's parameters: the sequential policy plus the throughput
// floor, which is the regression suite's tolerance so one knob bounds both.
export interface SeqRule extends SeqPolicy {
  throughputFloor: number;
}

export function seqRuleOf(policy: Policy): SeqRule {
  return { ...policy.sequential, throughputFloor: 1 - policy.regression.throughputTolerance };
}

function decisionSeed(cand: PooledCounts, chunks: number): number {
  return (chunks * 1000003 + cand.depth4 * 7919 + cand.depth5 * 104729 + cand.depth6plus * 31 + cand.h2Count) >>> 0;
}

// Smallest relative effect the merge gate could separate at the sample cap:
// z times the standard error of the log rate ratio with the candidate at
// capExposure and the baseline at its recorded size.
export function minimumEffect(baseCount: number, baseExposure: number, capExposure: number, extraVar = 0): number {
  if (baseCount <= 0 || baseExposure <= 0 || capExposure <= 0) return Infinity;
  const expectedCand = (baseCount / baseExposure) * capExposure;
  return MERGE_Z * Math.sqrt(1 / expectedCand + 1 / baseCount + Math.max(0, extraVar));
}

// The stopping rule. A candidate advances when the pooled sample already
// passes the merge gate's separation test on a rung's events per
// explore-second (depth>=6 first, then 5, then 4); it is rejected when a
// per-run guard (depth>=4, h2) regresses by the same test, when its
// throughput is below the floor, or when no rung can plausibly reach the
// effect the gate could separate at the cap. depth>=7 is too sparse to
// decide: a favourable posterior there suppresses futility and extends the
// cap, nothing more. depth>=8 is recorded only. Violations against a zero
// baseline are decisive when they appear.
export function decideSequential(
  cand: PooledCounts, base: PooledCounts, chunks: number, kind: SeqKind, p: SeqRule,
): SeqDecision {
  const seed = decisionSeed(cand, chunks);
  const capExposure = chunks > 0 ? (cand.exposureSec / chunks) * p.maxChunks : 0;
  const capRuns = chunks > 0 ? (cand.runs / chunks) * p.maxChunks : 0;
  const xv = exposureVariance(cand, base);
  const mei = {
    depth4: minimumEffect(base.depth4, base.exposureSec, capExposure, xv),
    depth5: minimumEffect(base.depth5, base.exposureSec, capExposure, xv),
    depth6: minimumEffect(base.depth6plus, base.exposureSec, capExposure, xv),
    depth7: minimumEffect(base.depth7plus, base.exposureSec, capExposure, xv),
    h2: minimumEffect(base.h2Count, base.runs, capRuns),
  };
  const perSec = (c: number, b: number, m: number, s: number) =>
    compareRatesPoisson(c, cand.exposureSec, b, base.exposureSec, m, p.regressMargin, p.draws, s, xv);
  const d4 = perSec(cand.depth4, base.depth4, mei.depth4, seed);
  const d5 = perSec(cand.depth5, base.depth5, mei.depth5, seed + 1);
  const d6 = perSec(cand.depth6plus, base.depth6plus, mei.depth6, seed + 3);
  const d7 = perSec(cand.depth7plus, base.depth7plus, mei.depth7, seed + 4);
  const g4 = compareRatesPoisson(cand.depth4, cand.graded, base.depth4, base.graded, 0, p.regressMargin, p.draws, seed + 5);
  const h2 = compareRatesPoisson(cand.h2Count, cand.runs, base.h2Count, base.runs, mei.h2, p.regressMargin, p.draws, seed + 2);
  const throughputRatio = throughputRatioOf(cand, base);
  const posteriors: Record<string, number> = {
    "depth>=4:pGreater": d4.pGreater, "depth>=4:pMei": d4.pAtLeastMei, "depth>=4:ratio": d4.meanRatio, "depth>=4:mei": mei.depth4,
    "depth>=5:pGreater": d5.pGreater, "depth>=5:pMei": d5.pAtLeastMei, "depth>=5:ratio": d5.meanRatio, "depth>=5:mei": mei.depth5,
    "depth>=6:pGreater": d6.pGreater, "depth>=6:pMei": d6.pAtLeastMei, "depth>=6:ratio": d6.meanRatio, "depth>=6:mei": mei.depth6,
    "depth>=7:pGreater": d7.pGreater, "depth>=7:pMei": d7.pAtLeastMei, "depth>=7:ratio": d7.meanRatio, "depth>=7:mei": mei.depth7,
    "h2:pGreater": h2.pGreater, "h2:ratio": h2.meanRatio, "h2:mei": mei.h2,
    "depth>=4:pRegress": g4.pRegress, "h2:pRegress": h2.pRegress,
    "throughput:ratio": throughputRatio, "throughput:cv": throughputCv(cand.rpsChunks),
  };
  const out = (verdict: SeqVerdict, reason: string): SeqDecision => ({ verdict, reason, posteriors });

  if (cand.violations >= 1 && base.violations === 0) return out("advance", `violations appeared (${cand.violations})`);
  // A depth the baseline never reaches is rare evidence, not a merge: it
  // extends sampling and, at the cap, routes to human review, never
  // short-circuits the gate (compareToBaseline needs the sample to separate,
  // which a handful of hits cannot do). Dormant while the baseline reaches
  // every rung; each rung the baseline reaches is an ordinary rung.
  const jackpot = (cand.depth6plus > 0 && base.depth6plus === 0)
    || (cand.depth7plus > 0 && base.depth7plus === 0)
    || (cand.depth8plus > 0 && base.depth8plus === 0);
  // A probable gain on depth>=7 cannot be a verdict at any affordable
  // sample, but it is a reason to keep sampling the rungs that can.
  const d7Hint = base.depth7plus > 0 && cand.depth7plus > 0 && d7.pGreater >= p.inconclusiveP;
  const extended = jackpot || d7Hint;
  const cap = extended ? Math.min(2 * p.maxChunks, HARD_LIMITS.maxSequentialChunks) : p.maxChunks;
  const belowFloor = chunks >= p.minChunks && throughputRatio < p.throughputFloor;

  if (kind === "noninferiority") {
    const worst = Math.max(g4.pRegress, h2.pRegress);
    if (chunks >= p.minChunks && cand.violations <= base.violations && g4.pRegress <= 1 - p.niP && h2.pRegress <= 1 - p.niP && !belowFloor) {
      return out("advance", "non-inferior on depth>=4 and h2");
    }
    if (worst >= p.niP) return out("reject", `regression: pRegress ${worst.toFixed(3)}`);
    if (belowFloor) return out("reject", `throughput ${throughputRatio.toFixed(3)} below floor ${p.throughputFloor}`);
    if (chunks >= p.maxChunks) return out("inconclusive", "non-inferiority unresolved at cap");
    return out("continue", "non-inferiority undecided");
  }

  // A decisive regression rejects at the first chunk: a guard rung
  // separated below baseline at the merge z is a real loss, not chunk noise,
  // so a second confirming chunk on a clear loser is wasted. Advancing (a
  // merge) and calling futility still need minChunks, since those decide on
  // the positive side where one lucky chunk must not be trusted.
  if (rateRatioSeparated(base.depth4, base.graded, cand.depth4, cand.graded, MERGE_Z)) return out("reject", `depth>=4 regressed per run (ratio ${g4.meanRatio.toFixed(2)})`);
  if (rateRatioSeparated(base.h2Count, base.runs, cand.h2Count, cand.runs, MERGE_Z)) return out("reject", `h2 regressed (ratio ${h2.meanRatio.toFixed(2)})`);

  if (chunks >= p.minChunks) {
    if (belowFloor) return out("reject", `throughput ${throughputRatio.toFixed(3)} below floor ${p.throughputFloor}`);
    const sep = (c: number, b: number): boolean => rateRatioSeparated(c, cand.exposureSec, b, base.exposureSec, MERGE_Z, xv);
    if (sep(cand.depth6plus, base.depth6plus)) return out("advance", `depth>=6 per second separated at z ${MERGE_Z} (ratio ${d6.meanRatio.toFixed(2)})`);
    if (sep(cand.depth5, base.depth5)) return out("advance", `depth>=5 per second separated at z ${MERGE_Z} (ratio ${d5.meanRatio.toFixed(2)})`);
    if (sep(cand.depth4, base.depth4)) return out("advance", `depth>=4 per second separated at z ${MERGE_Z} (ratio ${d4.meanRatio.toFixed(2)})`);
    if (!extended && d4.pAtLeastMei < p.rejectP && d5.pAtLeastMei < p.rejectP && d6.pAtLeastMei < p.rejectP) {
      return out("reject", `no rung can reach a separable effect (pMei d4 ${d4.pAtLeastMei.toFixed(3)} at +${(mei.depth4 * 100).toFixed(0)}%, d5 ${d5.pAtLeastMei.toFixed(3)} at +${(mei.depth5 * 100).toFixed(0)}%, d6 ${d6.pAtLeastMei.toFixed(3)} at +${(mei.depth6 * 100).toFixed(0)}%)`);
    }
  }
  if (chunks >= cap) {
    if (jackpot) return out("escalate", `a depth the baseline never reaches appeared (d6 ${cand.depth6plus}, d7 ${cand.depth7plus}, d8 ${cand.depth8plus}), below gate separation`);
    if (d7Hint) return out("inconclusive", `depth>=7 pGreater ${d7.pGreater.toFixed(3)} unresolved at the extended cap`);
    const best = Math.max(d4.pGreater, d5.pGreater, d6.pGreater);
    return best >= p.inconclusiveP
      ? out("inconclusive", `cap reached with pGreater ${best.toFixed(3)}`)
      : out("reject", `cap reached with pGreater ${best.toFixed(3)}`);
  }
  return out("continue", "undecided");
}

// A chunk is excluded for its timing, never for its content: a machine
// suspend, an explorer that never wrote its session account (killed), or a
// throughput far below the baseline's before the candidate is known to be
// slow. Fast chunks are never anomalies: the exposure is the explorer's own
// monotonic clock, which the environment cannot inflate.
export const SLOW_CHUNK_FACTOR = 1.5;
export function classifyChunkTiming(e: Evaluation, baselineMedianRps: number | null, slowConfirmed: boolean): string | null {
  if (e.suspendedMs > 0) return `suspended ${Math.round(e.suspendedMs / 1000)}s`;
  if (e.session === null) return "no session summary";
  if (baselineMedianRps !== null && baselineMedianRps > 0 && !slowConfirmed && e.metrics.runsPerSec < baselineMedianRps / SLOW_CHUNK_FACTOR) {
    return `slow: ${e.metrics.runsPerSec.toFixed(1)} runs/s against a baseline median of ${baselineMedianRps.toFixed(1)}`;
  }
  return null;
}

export function medianRps(c: PooledCounts): number | null {
  const xs = c.rpsChunks.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? (xs[mid] as number) : (((xs[mid - 1] as number) + (xs[mid] as number)) / 2);
}

export interface SeqRunResult {
  verdict: SeqVerdict | "stopped" | "error";
  reason: string;
  evals: Evaluation[];
  seq: SeqState;
}

export function initialSeqState(hypothesisId: string, baselineKey: string): SeqState {
  return {
    hypothesisId, chunks: 0, runs: 0, graded: 0, depth4: 0, depth5: 0, depth6plus: 0, depth7plus: 0, depth8plus: 0,
    violations: 0, h2Count: 0, exposureSec: 0, rpsChunks: [], anomalies: 0, slowConfirmed: false,
    resumes: 0, nextSeed: 1000, posteriors: {}, lastVerdict: "", lastIteration: 0, baselineKey,
  };
}

export const MAX_TIMING_ANOMALIES = 3;

// A synthetic chunk record for the offline simulations and self-tests.
export function syntheticEvaluation(seed: number, m: {
  runs: number; exposureMs: number; depthAtLeast: number[]; h2Rate: number; violations?: number; suspendedMs?: number; withSession?: boolean;
}): Evaluation {
  return {
    id: `synthetic-${seed}`, hypothesisId: "synthetic", fidelity: "sequential", graderVersion: "", spurCommit: "", superCommit: "",
    configPath: "", spec: "", seed, startedAtIso: "1970-01-01T00:00:00.000Z", ok: true, error: null,
    exploreWallMs: m.exposureMs, suspendedMs: m.suspendedMs ?? 0, timingAnomaly: null, utilStats: null,
    session: (m.withSession ?? true)
      ? { wallMs: m.exposureMs, runsCompleted: m.runs, runsFailed: 0, runsSkipped: 0, budgetSec: m.exposureMs / 1000, budgetHit: true, writerFlushMs: 0 }
      : null,
    metrics: {
      runs: m.runs, gradedRuns: m.runs, runsPerSec: m.exposureMs > 0 ? m.runs / (m.exposureMs / 1000) : 0, exposureMs: m.exposureMs,
      unpairedFraction: 0, h1Rate: 0, h2Rate: m.h2Rate, h2bRate: 0, h3Rate: 0, meanPrefixDepth: 0, maxPrefixDepth: 8,
      depthAtLeast: m.depthAtLeast, violations: m.violations ?? 0, unknown: 0, porcupineWallMs: 0, gradeWallMs: 0,
    },
  };
}

// The sequential rule and the merge gate test the same pooled chunks; an
// advance the gate then refuses would delete a branch on a contradiction.
// Asserted here on synthetic chunks around the measured baseline counts.
export function selfTestGateConsistency(): string[] {
  const f: string[] = [];
  const rule: SeqRule = {
    exploreBudgetSec: 90, maxRunsPerConfig: 4000, maxChunks: 4, minChunks: 2, rejectP: 0.05, inconclusiveP: 0.9, niP: 0.95,
    regressMargin: 0.25, maxResumes: 2, resumeCooldown: 2, draws: 2000, wallSecPerChunk: 900, throughputFloor: 0.8,
  };
  const chunk = (seed: number, scale: { d4?: number; d5?: number; d6?: number; rps?: number }): Evaluation => {
    const rps = scale.rps ?? 1;
    const runs = Math.round(54000 * rps);
    const d = [runs, runs, runs, Math.round(19731 * rps * (scale.d4 ?? 1)), Math.round(6033 * rps * (scale.d5 ?? 1)), Math.round(883 * rps * (scale.d6 ?? 1)), Math.round(110 * rps), Math.round(5 * rps)];
    return syntheticEvaluation(seed, { runs, exposureMs: 90_000 + seed, depthAtLeast: d, h2Rate: 0.416 });
  };
  const base = [1000, 1001, 1002, 1003].map((s) => chunk(s, {}));
  const cases: Array<{ name: string; cand: Evaluation[] }> = [
    { name: "null", cand: [2000, 2001].map((s) => chunk(s, {})) },
    { name: "+25% depth>=6", cand: [2000, 2001].map((s) => chunk(s, { d6: 1.25 })) },
    { name: "+12% depth>=4 and +15% depth>=5", cand: [2000, 2001].map((s) => chunk(s, { d4: 1.12, d5: 1.15 })) },
    { name: "+40% throughput", cand: [2000, 2001].map((s) => chunk(s, { rps: 1.4 })) },
    { name: "+30% depth>=6 at -10% throughput", cand: [2000, 2001].map((s) => chunk(s, { d6: 1.3, rps: 0.9 })) },
  ];
  for (const c of cases) {
    const seq = decideSequential(pooledCountsOf(c.cand), pooledCountsOf(base), c.cand.length, "superiority", rule);
    const cmp = compareToBaseline(objectiveCounts(c.cand), objectiveCounts(base), MERGE_Z);
    const gateAdvances = cmp.improved.length > 0 && cmp.regressed.length === 0;
    if (seq.verdict === "advance" && !gateAdvances) f.push(`${c.name}: sequential advanced (${seq.reason}) but the gate would refuse (improved=[${cmp.improved}], regressed=[${cmp.regressed}])`);
    if (seq.verdict !== "advance" && gateAdvances && seq.verdict !== "continue") f.push(`${c.name}: gate would advance but the sequential rule said ${seq.verdict} (${seq.reason})`);
  }
  const plus = decideSequential(pooledCountsOf(cases[1]!.cand), pooledCountsOf(base), 2, "superiority", rule);
  if (plus.verdict !== "advance") f.push(`+25% depth>=6 over two chunks must advance, got ${plus.verdict} (${plus.reason})`);
  const faster = decideSequential(pooledCountsOf(cases[3]!.cand), pooledCountsOf(base), 2, "superiority", rule);
  if (faster.verdict !== "advance") f.push(`+40% throughput at equal per-run rates must advance, got ${faster.verdict} (${faster.reason})`);
  const slow = decideSequential(pooledCountsOf([2000, 2001].map((s) => chunk(s, { d6: 1.25, rps: 0.7 }))), pooledCountsOf(base), 2, "superiority", rule);
  if (slow.verdict !== "reject") f.push(`a candidate below the throughput floor must be rejected, got ${slow.verdict} (${slow.reason})`);
  const nul = decideSequential(pooledCountsOf(cases[0]!.cand), pooledCountsOf(base), 2, "superiority", rule);
  if (nul.verdict === "advance") f.push(`a null candidate must not advance (${nul.reason})`);
  // The chunk cap is justified by what the last chunk buys: at the measured
  // primary-rung counts the minimum separable effect at the cap must be
  // within half again of what unbounded sampling could reach, else the cap
  // (or the baseline size it equals) needs re-deriving.
  const basePooled = pooledCountsOf(base);
  const capExposure = (basePooled.exposureSec / basePooled.chunks) * rule.maxChunks;
  const atCap = minimumEffect(basePooled.depth6plus, basePooled.exposureSec, capExposure);
  const unbounded = MERGE_Z * Math.sqrt(1 / basePooled.depth6plus);
  if (!(atCap <= 1.5 * unbounded)) f.push(`depth>=6 minimum effect at the cap (${(atCap * 100).toFixed(1)}%) exceeds 1.5x the unbounded floor (${(unbounded * 100).toFixed(1)}%)`);
  // The timing classifier: a suspend and a missing session are always
  // anomalies, a slow chunk only until the candidate is known to be slow.
  const ref = chunk(3000, {});
  if (classifyChunkTiming(ref, 600, false) !== null) f.push("a normal chunk is not an anomaly");
  if (classifyChunkTiming({ ...ref, suspendedMs: 5000 }, 600, false) === null) f.push("a suspended chunk is an anomaly");
  if (classifyChunkTiming({ ...ref, session: null }, 600, false) === null) f.push("a chunk without a session summary is an anomaly");
  const slowChunk = chunk(3001, { rps: 0.3 });
  if (classifyChunkTiming(slowChunk, 600, false) === null) f.push("a chunk at a third of the baseline throughput is an anomaly");
  if (classifyChunkTiming(slowChunk, 600, true) !== null) f.push("a slow chunk of a confirmed-slow candidate counts");
  if (classifyChunkTiming(chunk(3002, { rps: 1.6 }), 600, false) !== null) f.push("a fast chunk is never an anomaly");
  return f;
}

export async function runSequential(opts: {
  ctx: EvalContext;
  hypothesisId: string;
  kind: SeqKind;
  baseline: PooledCounts;
  prior: SeqState | null;
  baselineKey: string;
  maxChunksTotal: number;
  onChunk: (seq: SeqState, decision: SeqDecision) => void;
  onAnomaly?: (e: Evaluation, reason: string) => void;
  stopRequested: () => boolean;
}): Promise<SeqRunResult> {
  const p = opts.ctx.policy.sequential;
  const rule = seqRuleOf(opts.ctx.policy);
  const evals: Evaluation[] = [];
  let seq: SeqState = opts.prior ?? initialSeqState(opts.hypothesisId, opts.baselineKey);
  const baselineMedian = medianRps(opts.baseline);
  // A chunk that fails with zero usable runs is usually the environment (an
  // I/O storm slowing the explore past its wall, a checker that could not
  // read the corpus), not the candidate. Tolerate scattered failures by
  // retrying with the next seed; only a consecutive streak (a broken
  // candidate or a sustained outage) or a large total errors out.
  let consecutiveFailures = 0;
  let totalFailures = 0;
  let lastWasSlow = false;
  for (;;) {
    if (opts.stopRequested()) return { verdict: "stopped", reason: "STOP requested", evals, seq };
    const e = await runOneEvaluation(opts.ctx, opts.hypothesisId, "sequential", seq.nextSeed, {
      runsPerConfig: p.maxRunsPerConfig, exploreWallSec: p.exploreBudgetSec, exploreBudgetSec: p.exploreBudgetSec,
      gradeMaxRuns: 0, gradeBudgetMs: p.wallSecPerChunk * 1000,
    });
    seq = { ...seq, nextSeed: seq.nextSeed + 1 };
    if (!e.ok) {
      evals.push(e);
      // Zero runs written means the explorer produced nothing at all - a wall
      // timeout on a configuration that cannot complete a run. Further seeds
      // re-pay the same wall to learn the same thing, so stop here.
      if (e.metrics.runs === 0) {
        return {
          verdict: "error",
          reason: `explorer completed zero runs (${e.error ?? "wall timeout"}); further seeds cannot inform`,
          evals, seq,
        };
      }
      consecutiveFailures++;
      totalFailures++;
      if (consecutiveFailures >= 3) return { verdict: "error", reason: `${consecutiveFailures} chunks failed in a row: ${e.error ?? "evaluation failed"}`, evals, seq };
      if (totalFailures >= p.maxChunks) return { verdict: "error", reason: `${totalFailures} chunks failed: ${e.error ?? "evaluation failed"}`, evals, seq };
      continue;
    }
    consecutiveFailures = 0;
    const anomaly = classifyChunkTiming(e, baselineMedian, seq.slowConfirmed);
    if (anomaly !== null) {
      const slow = anomaly.startsWith("slow");
      if (slow && lastWasSlow) {
        // Two slow chunks in a row is the candidate, not the host: from here
        // its chunks count and the throughput floor decides.
        seq = { ...seq, slowConfirmed: true };
      } else {
        lastWasSlow = slow;
        const excluded: Evaluation = { ...e, ok: false, error: `timing anomaly: ${anomaly}`, timingAnomaly: anomaly };
        evals.push(excluded);
        seq = { ...seq, anomalies: seq.anomalies + 1 };
        opts.onAnomaly?.(excluded, anomaly);
        if (seq.anomalies >= MAX_TIMING_ANOMALIES) return { verdict: "error", reason: `${seq.anomalies} chunks excluded for timing: ${anomaly}`, evals, seq };
        continue;
      }
    } else {
      lastWasSlow = false;
    }
    evals.push(e);
    const c = pooledCountsOf([e]);
    seq = {
      ...seq, chunks: seq.chunks + 1, runs: seq.runs + c.runs, graded: seq.graded + c.graded,
      exposureSec: seq.exposureSec + c.exposureSec, rpsChunks: [...seq.rpsChunks, ...c.rpsChunks],
      depth4: seq.depth4 + c.depth4, depth5: seq.depth5 + c.depth5, depth6plus: seq.depth6plus + c.depth6plus,
      depth7plus: seq.depth7plus + c.depth7plus, depth8plus: seq.depth8plus + c.depth8plus,
      violations: seq.violations + c.violations, h2Count: seq.h2Count + c.h2Count,
    };
    const cap = Math.min(opts.maxChunksTotal, p.maxChunks * (seq.resumes + 1));
    const decision = decideSequential(pooledFromSeq(seq), opts.baseline, seq.chunks, opts.kind, { ...rule, maxChunks: cap });
    seq = { ...seq, posteriors: decision.posteriors, lastVerdict: decision.verdict };
    opts.onChunk(seq, decision);
    if (decision.verdict !== "continue") return { verdict: decision.verdict, reason: decision.reason, evals, seq };
  }
}
