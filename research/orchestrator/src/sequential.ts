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
import {
  MERGE_Z, PRIMARY_RUNG, addStratum, chunkStratum, compareToBaseline, emptyStratum,
  objectiveCounts, primaryDelta, rateVarianceOf, rungCv, stratumFault, type RatePrior,
} from "./decide.js";
import { HARD_LIMITS } from "./policy.js";
import { CampaignMetrics, Evaluation, RateStratum, SeqState } from "./schemas.js";

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
  // Counts restricted to the arms the rate is separated on. null means the
  // stratum could not be formed - a chunk without per-arm accounting, or an
  // arm set that changed mid-sample - and nothing downstream may treat that
  // as an ordinary comparison.
  rateStratum: RateStratum | null;
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
    depth7plus: 0, depth8plus: 0, violations: 0, h2Count: 0, rpsChunks: [], rateStratum: emptyStratum(),
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
    c.rateStratum = addStratum(c.rateStratum, chunkStratum(e));
  }
  return c;
}

export function pooledFromSeq(seq: SeqState): PooledCounts {
  return {
    runs: seq.runs, graded: seq.graded, chunks: seq.chunks, exposureSec: seq.exposureSec,
    depth4: seq.depth4, depth5: seq.depth5, depth6plus: seq.depth6plus,
    depth7plus: seq.depth7plus, depth8plus: seq.depth8plus,
    violations: seq.violations, h2Count: seq.h2Count, rpsChunks: seq.rpsChunks,
    rateStratum: seq.rateStratum,
  };
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
  // The archive violation rate a candidate's violations are separated
  // against; null falls back to the baseline's own count.
  violationPrior: RatePrior | null;
}

export function seqRuleOf(policy: Policy, violationPrior: RatePrior | null = null): SeqRule {
  return { ...policy.sequential, throughputFloor: 1 - policy.regression.throughputTolerance, violationPrior };
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
// effect the gate could separate at the cap. Every rung decides, depth>=7
// and depth>=8 included: they are where the plan corpora put their
// violations, and each is still held to the minimum effect its own event
// count can separate at the cap, which is large where the rung is sparse. A
// favourable posterior at depth>=7 also extends the cap, so a deep effect is
// sampled further before it is judged. Violations against a zero baseline
// are decisive when they appear.
export function decideSequential(
  cand: PooledCounts, base: PooledCounts, chunks: number, kind: SeqKind, p: SeqRule,
): SeqDecision {
  // A stratum that cannot be formed or compared is a unit problem: more
  // chunks cannot fix it, and the pooled evidence belongs in front of a
  // human rather than deleted as a negative result about the hypothesis.
  const fault = stratumFault(cand.rateStratum, base.rateStratum);
  if (fault !== null) {
    return { verdict: "escalate", reason: `the rate stratum cannot be compared: ${fault.detail}`, posteriors: {} };
  }
  const cs = cand.rateStratum ?? emptyStratum();
  const bs = base.rateStratum ?? emptyStratum();
  const sd = (s: RateStratum, k: number): number => s.depth[k - 1] ?? 0;
  const xv = (k: number): number => rateVarianceOf(cs, bs, k);
  const seed = decisionSeed(cand, chunks);
  // The cap is in stratum exposure - the grid arms are about 240 s of a
  // 300 s chunk - so it stays the wall the rate is actually measured over.
  const capExposure = chunks > 0 ? (cs.exposureSec / chunks) * p.maxChunks : 0;
  const capRuns = chunks > 0 ? (cand.runs / chunks) * p.maxChunks : 0;
  const mei = {
    depth4: minimumEffect(sd(bs, 4), bs.exposureSec, capExposure, xv(4)),
    depth5: minimumEffect(sd(bs, 5), bs.exposureSec, capExposure, xv(5)),
    depth6: minimumEffect(sd(bs, 6), bs.exposureSec, capExposure, xv(6)),
    depth7: minimumEffect(sd(bs, 7), bs.exposureSec, capExposure, xv(7)),
    depth8: minimumEffect(sd(bs, 8), bs.exposureSec, capExposure, xv(8)),
    h2: minimumEffect(base.h2Count, base.runs, capRuns),
  };
  const perSec = (k: number, m: number, s: number) =>
    compareRatesPoisson(sd(cs, k), cs.exposureSec, sd(bs, k), bs.exposureSec, m, p.regressMargin, p.draws, s, xv(k));
  const d4 = perSec(4, mei.depth4, seed);
  const d5 = perSec(5, mei.depth5, seed + 1);
  const d6 = perSec(6, mei.depth6, seed + 3);
  const d7 = perSec(7, mei.depth7, seed + 4);
  const d8 = perSec(8, mei.depth8, seed + 8);
  const g4 = compareRatesPoisson(cand.depth4, cand.graded, base.depth4, base.graded, 0, p.regressMargin, p.draws, seed + 5);
  // Per-run guards on the deep rungs: a candidate that buys events per
  // second by making runs shallower must not advance on the shallow rungs.
  const g5 = compareRatesPoisson(cand.depth5, cand.graded, base.depth5, base.graded, 0, p.regressMargin, p.draws, seed + 6);
  const g6 = compareRatesPoisson(cand.depth6plus, cand.graded, base.depth6plus, base.graded, 0, p.regressMargin, p.draws, seed + 7);
  const deepRegress = Math.max(g5.pRegress, g6.pRegress);
  const deepGuardOk = g5.pRegress <= 1 - p.niP && g6.pRegress <= 1 - p.niP;
  const h2 = compareRatesPoisson(cand.h2Count, cand.runs, base.h2Count, base.runs, mei.h2, p.regressMargin, p.draws, seed + 2);
  const throughputRatio = throughputRatioOf(cand, base);
  const posteriors: Record<string, number> = {
    "depth>=4:pGreater": d4.pGreater, "depth>=4:pMei": d4.pAtLeastMei, "depth>=4:ratio": d4.meanRatio, "depth>=4:mei": mei.depth4,
    "depth>=5:pGreater": d5.pGreater, "depth>=5:pMei": d5.pAtLeastMei, "depth>=5:ratio": d5.meanRatio, "depth>=5:mei": mei.depth5,
    "depth>=6:pGreater": d6.pGreater, "depth>=6:pMei": d6.pAtLeastMei, "depth>=6:ratio": d6.meanRatio, "depth>=6:mei": mei.depth6,
    "depth>=7:pGreater": d7.pGreater, "depth>=7:pMei": d7.pAtLeastMei, "depth>=7:ratio": d7.meanRatio, "depth>=7:mei": mei.depth7,
    "depth>=8:pGreater": d8.pGreater, "depth>=8:pMei": d8.pAtLeastMei, "depth>=8:ratio": d8.meanRatio, "depth>=8:mei": mei.depth8,
    "h2:pGreater": h2.pGreater, "h2:ratio": h2.meanRatio, "h2:mei": mei.h2,
    "depth>=4:pRegress": g4.pRegress, "depth>=5:pRegress": g5.pRegress, "depth>=6:pRegress": g6.pRegress, "h2:pRegress": h2.pRegress,
    "throughput:ratio": throughputRatio, "throughput:cv": throughputCv(cand.rpsChunks),
    // The dispersion each rung's interval is actually charged, so an arm
    // change that re-inflates it is visible in the chunk line rather than
    // only in a widened interval.
    "depth>=5:cv": rungCv(cs, 5), "depth>=6:cv": rungCv(cs, 6), "depth>=7:cv": rungCv(cs, 7),
    "stratum:chunks": cs.chunks, "stratum:exposureSec": cs.exposureSec,
  };
  const out = (verdict: SeqVerdict, reason: string): SeqDecision => ({ verdict, reason, posteriors });

  // A violation counts for the candidate only when it exceeds what the
  // corpus produces anyway. Four baseline chunks carry one about a fifth of
  // the time at 1 per 4.5M runs, so "the baseline saw none" was a coin flip;
  // the archive rate over every campaign-epoch chunk is the honest
  // comparator, and a violation that does not separate against it extends
  // sampling and reaches a human instead of merging.
  const vp = p.violationPrior !== null && p.violationPrior.violations > 0 && p.violationPrior.runs > 0 ? p.violationPrior : null;
  if (vp !== null) {
    if (rateRatioSeparated(cand.violations, cand.runs, vp.violations, vp.runs, MERGE_Z)) {
      return out("advance", `violations separated against the archive rate (${cand.violations} in ${cand.runs} runs against 1 per ${Math.round(vp.runs / vp.violations)})`);
    }
  } else if (cand.violations >= 1 && base.violations === 0) {
    return out("advance", `violations appeared (${cand.violations})`);
  }
  // A depth the baseline never reaches is rare evidence, not a merge: it
  // extends sampling and, at the cap, routes to human review, never
  // short-circuits the gate (compareToBaseline needs the sample to separate,
  // which a handful of hits cannot do). Dormant while the baseline reaches
  // every rung; each rung the baseline reaches is an ordinary rung.
  const jackpot = (vp !== null && cand.violations > 0)
    || (cand.depth6plus > 0 && base.depth6plus === 0)
    || (cand.depth7plus > 0 && base.depth7plus === 0)
    || (cand.depth8plus > 0 && base.depth8plus === 0);
  // A probable gain on depth>=7 cannot be a verdict at any affordable
  // sample, but it is a reason to keep sampling the rungs that can.
  const d7Hint = base.depth7plus > 0 && cand.depth7plus > 0 && d7.pGreater >= p.inconclusiveP;
  const extended = jackpot || d7Hint;
  const cap = extended ? Math.min(2 * p.maxChunks, HARD_LIMITS.maxSequentialChunks) : p.maxChunks;
  const belowFloor = chunks >= p.minChunks && throughputRatio < p.throughputFloor;

  if (kind === "noninferiority") {
    const worst = Math.max(g4.pRegress, h2.pRegress, deepRegress);
    if (chunks >= p.minChunks && cand.violations <= base.violations && g4.pRegress <= 1 - p.niP && h2.pRegress <= 1 - p.niP && deepGuardOk && !belowFloor) {
      return out("advance", "non-inferior on depth>=4, depth>=5, depth>=6 and h2");
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

  let separatedRung: string | null = null;
  let separatedK: number | null = null;
  if (chunks >= p.minChunks) {
    if (belowFloor) return out("reject", `throughput ${throughputRatio.toFixed(3)} below floor ${p.throughputFloor}`);
    if (deepRegress >= p.niP) return out("reject", `deep rungs regressed per run beyond the ${(p.regressMargin * 100).toFixed(0)}% margin (pRegress d5 ${g5.pRegress.toFixed(3)}, d6 ${g6.pRegress.toFixed(3)})`);
    const sep = (k: number): boolean => rateRatioSeparated(sd(cs, k), cs.exposureSec, sd(bs, k), bs.exposureSec, MERGE_Z, xv(k));
    if (sep(8)) { separatedK = 8; separatedRung = `depth>=8 per second separated at z ${MERGE_Z} (ratio ${d8.meanRatio.toFixed(2)})`; }
    else if (sep(7)) { separatedK = 7; separatedRung = `depth>=7 per second separated at z ${MERGE_Z} (ratio ${d7.meanRatio.toFixed(2)})`; }
    else if (sep(6)) { separatedK = 6; separatedRung = `depth>=6 per second separated at z ${MERGE_Z} (ratio ${d6.meanRatio.toFixed(2)})`; }
    else if (sep(5)) { separatedK = 5; separatedRung = `depth>=5 per second separated at z ${MERGE_Z} (ratio ${d5.meanRatio.toFixed(2)})`; }
    else if (sep(4)) { separatedK = 4; separatedRung = `depth>=4 per second separated at z ${MERGE_Z} (ratio ${d4.meanRatio.toFixed(2)})`; }
    // A rung shallower than the primary carries the session's run count as
    // much as its depth: the depth>=4 per-second rate tracks throughput at
    // 0.99 across seeds. A gain there while the primary rung is known to have
    // fallen is depth traded for speed wearing the objective's name. A
    // decline inside noise still advances; this asks only that the primary
    // not be confidently down, at the same confidence the rule calls a gain.
    if (separatedK !== null && separatedK < PRIMARY_RUNG && d6.pGreater < 1 - p.inconclusiveP) {
      return out("reject", `depth>=${separatedK} per second separated but depth>=${PRIMARY_RUNG} is down (pGreater ${d6.pGreater.toFixed(3)}, ratio ${d6.meanRatio.toFixed(3)})`);
    }
    // A separated rung advances only when the deep rungs per run are known
    // to hold; a gain with the guard unresolved keeps sampling and goes to a
    // human at the cap rather than being merged or discarded.
    if (separatedRung !== null && deepGuardOk) return out("advance", separatedRung);
    if (separatedRung === null && !extended && d4.pAtLeastMei < p.rejectP && d5.pAtLeastMei < p.rejectP
        && d6.pAtLeastMei < p.rejectP && d7.pAtLeastMei < p.rejectP && d8.pAtLeastMei < p.rejectP) {
      return out("reject", `no rung can reach a separable effect (pMei d4 ${d4.pAtLeastMei.toFixed(3)} at +${(mei.depth4 * 100).toFixed(0)}%, d5 ${d5.pAtLeastMei.toFixed(3)} at +${(mei.depth5 * 100).toFixed(0)}%, d6 ${d6.pAtLeastMei.toFixed(3)} at +${(mei.depth6 * 100).toFixed(0)}%, d7 ${d7.pAtLeastMei.toFixed(3)} at +${(mei.depth7 * 100).toFixed(0)}%, d8 ${d8.pAtLeastMei.toFixed(3)} at +${(mei.depth8 * 100).toFixed(0)}%)`);
    }
  }
  if (chunks >= cap) {
    if (jackpot) return out("escalate", `rare evidence below gate separation (violations ${cand.violations}, d6 ${cand.depth6plus}, d7 ${cand.depth7plus}, d8 ${cand.depth8plus})`);
    if (separatedRung !== null) return out("escalate", `${separatedRung} with shallower deep runs unresolved (pRegress d5 ${g5.pRegress.toFixed(3)}, d6 ${g6.pRegress.toFixed(3)})`);
    if (d7Hint) return out("inconclusive", `depth>=7 pGreater ${d7.pGreater.toFixed(3)} unresolved at the extended cap`);
    const best = Math.max(d4.pGreater, d5.pGreater, d6.pGreater, d7.pGreater, d8.pGreater);
    return best >= p.inconclusiveP
      ? out("inconclusive", `cap reached with pGreater ${best.toFixed(3)}`)
      : out("reject", `cap reached with pGreater ${best.toFixed(3)}`);
  }
  return out("continue", "undecided");
}

// A chunk is excluded for its timing, never for its content: an explorer
// that never wrote its session account (killed), or a throughput far below
// the baseline's before the candidate is known to be slow. Every duration
// is active time on a monotonic clock, so a machine suspend neither inflates
// an exposure nor excludes a chunk; fast chunks are never anomalies for the
// same reason.
export const SLOW_CHUNK_FACTOR = 1.5;
export function classifyChunkTiming(e: Evaluation, baselineMedianRps: number | null, slowConfirmed: boolean): string | null {
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
    rateStratum: emptyStratum(),
  };
}

// The measured five-arm split of a campaign chunk (live 14-thread baseline,
// 2026-08): equal wall, grid-short carrying most runs, aos carrying a deep
// tail on a fifth of the wall. The self-tests decide on the stratum, so a
// synthetic chunk has to carry one, and it has to have the shape the loop
// runs in or the tests exercise a regime that does not exist.
const SYNTHETIC_ARMS: Array<{ id: string; mode: string; runShare: number; depthShare: number }> = [
  { id: "grid", mode: "grid", runShare: 0.137, depthShare: 0.153 },
  { id: "grid-short", mode: "grid", runShare: 0.440, depthShare: 0.481 },
  { id: "grid-no-purgatory", mode: "grid", runShare: 0.133, depthShare: 0.088 },
  { id: "grid-post-fault-2", mode: "grid", runShare: 0.144, depthShare: 0.148 },
  { id: "aos", mode: "aos", runShare: 0.146, depthShare: 0.130 },
];

function syntheticCampaign(
  runs: number, exposureMs: number, depthAtLeast: number[], armScale: Record<string, number>,
): { campaign: CampaignMetrics; depthAtLeast: number[]; violations: number } {
  const arms = SYNTHETIC_ARMS.map((a, i) => {
    const scale = armScale[a.id] ?? 1;
    const armRuns = Math.round(runs * a.runShare);
    return {
      index: i, id: a.id, mode: a.mode, overlay: {}, slices: 1,
      runs: armRuns, wallMs: Math.round(exposureMs / SYNTHETIC_ARMS.length),
      rewardRate: 0, epochs: 0, droppedAtRound: null,
      depthAtLeast: depthAtLeast.map((v) => Math.round(v * a.depthShare * scale)),
      gradedRuns: armRuns, violations: 0, firstViolationMs: null,
    };
  });
  const union = depthAtLeast.map((_, k) => arms.reduce((s, a) => s + (a.depthAtLeast[k] ?? 0), 0));
  return {
    campaign: {
      wallSec: exposureMs / 1000, allocation: "grid", reward: "depth",
      runsTotal: arms.reduce((s, a) => s + a.runs, 0), sliceUnitSec: 1, cancelled: false, arms,
    },
    depthAtLeast: union,
    violations: 0,
  };
}

// A synthetic chunk record for the offline simulations and self-tests.
// armScale multiplies one arm's whole ladder, which is how a gain confined
// to a single arm is expressed.
export function syntheticEvaluation(seed: number, m: {
  runs: number; exposureMs: number; depthAtLeast: number[]; h2Rate: number; violations?: number;
  suspendedMs?: number; withSession?: boolean; armScale?: Record<string, number>; noCampaign?: boolean;
}): Evaluation {
  const camp = syntheticCampaign(m.runs, m.exposureMs, m.depthAtLeast, m.armScale ?? {});
  const useCampaign = !(m.noCampaign ?? false);
  return {
    id: `synthetic-${seed}`, hypothesisId: "synthetic", fidelity: "sequential", graderVersion: "", spurCommit: "", superCommit: "",
    configPath: "", spec: "", seed, startedAtIso: "1970-01-01T00:00:00.000Z", ok: true, error: null,
    exploreWallMs: m.exposureMs, suspendedMs: m.suspendedMs ?? 0, timingAnomaly: null, utilStats: null,
    session: (m.withSession ?? true)
      ? { wallMs: m.exposureMs, runsCompleted: m.runs, runsFailed: 0, runsSkipped: 0, budgetSec: m.exposureMs / 1000, budgetHit: true, writerFlushMs: 0 }
      : null,
    metrics: {
      runs: m.runs, gradedRuns: m.runs, runsPerSec: m.exposureMs > 0 ? m.runs / (m.exposureMs / 1000) : 0, exposureMs: m.exposureMs,
      unpairedFraction: 0, h1Rate: 0, h2Rate: m.h2Rate, h2bRate: 0, h3Rate: 0, h4Rate: 0, meanPrefixDepth: 0, maxPrefixDepth: 8,
      depthAtLeast: useCampaign ? camp.depthAtLeast : m.depthAtLeast,
      violations: m.violations ?? 0, unknown: 0, porcupineWallMs: 0, gradeWallMs: 0,
      campaign: useCampaign ? camp.campaign : null,
    },
  };
}

// The sequential rule and the merge gate test the same pooled chunks; an
// advance the gate then refuses would delete a branch on a contradiction.
// Asserted here on synthetic chunks around the measured baseline counts.
export function selfTestGateConsistency(live?: { base: PooledCounts; rule: SeqRule }): string[] {
  const f: string[] = [];
  const rule: SeqRule = live?.rule ?? {
    exploreBudgetSec: 90, maxRunsPerConfig: 4000, maxChunks: 4, minChunks: 2, rejectP: 0.05, inconclusiveP: 0.9, niP: 0.95,
    regressMargin: 0.25, maxResumes: 2, resumeCooldown: 2, draws: 2000, wallSecPerChunk: 900, throughputFloor: 0.8,
    violationPrior: null,
  };
  // The synthetic chunk has the recorded baseline's per-chunk shape when one
  // is available, so the cap check below follows the live regime.
  const per = (v: number): number => (live ? v / live.base.chunks : v);
  const shape = live
    ? { runs: per(live.base.runs), exposureMs: per(live.base.exposureSec) * 1000, d4: per(live.base.depth4), d5: per(live.base.depth5),
        d6: per(live.base.depth6plus), d7: per(live.base.depth7plus), d8: per(live.base.depth8plus), h2: live.base.h2Count / Math.max(1, live.base.runs) }
    : { runs: 54000, exposureMs: 90_000, d4: 19731, d5: 6033, d6: 883, d7: 110, d8: 5, h2: 0.416 };
  const chunk = (seed: number, scale: { d4?: number; d5?: number; d6?: number; rps?: number; arms?: Record<string, number> }): Evaluation => {
    const rps = scale.rps ?? 1;
    const runs = Math.round(shape.runs * rps);
    const d = [runs, runs, runs, Math.round(shape.d4 * rps * (scale.d4 ?? 1)), Math.round(shape.d5 * rps * (scale.d5 ?? 1)), Math.round(shape.d6 * rps * (scale.d6 ?? 1)), Math.round(shape.d7 * rps), Math.round(shape.d8 * rps)];
    return syntheticEvaluation(seed, {
      runs, exposureMs: Math.round(shape.exposureMs) + seed, depthAtLeast: d, h2Rate: shape.h2,
      ...(scale.arms ? { armScale: scale.arms } : {}),
    });
  };
  const gridScale = (factor: number): Record<string, number> => ({
    grid: factor, "grid-short": factor, "grid-no-purgatory": factor, "grid-post-fault-2": factor,
  });
  const medianRpsRef = shape.runs / (shape.exposureMs / 1000);
  const base = [1000, 1001, 1002, 1003].map((s) => chunk(s, {}));
  const cases: Array<{ name: string; cand: Evaluation[] }> = [
    { name: "null", cand: [2000, 2001].map((s) => chunk(s, {})) },
    { name: "+25% depth>=6", cand: [2000, 2001].map((s) => chunk(s, { d6: 1.25 })) },
    { name: "+12% depth>=4 and +15% depth>=5", cand: [2000, 2001].map((s) => chunk(s, { d4: 1.12, d5: 1.15 })) },
    { name: "+40% throughput", cand: [2000, 2001].map((s) => chunk(s, { rps: 1.4 })) },
    { name: "+30% depth>=6 at -10% throughput", cand: [2000, 2001].map((s) => chunk(s, { d6: 1.3, rps: 0.9 })) },
    { name: "+40% throughput with -30% per-run depth>=6", cand: [2000, 2001].map((s) => chunk(s, { rps: 1.4, d6: 0.7 })) },
    { name: "+200% on the aos arm only", cand: [2000, 2001].map((s) => chunk(s, { arms: { aos: 3 } })) },
    { name: "+25% on the grid arms only", cand: [2000, 2001].map((s) => chunk(s, { arms: gridScale(1.25) })) },
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
  const hollow = decideSequential(pooledCountsOf(cases[5]!.cand), pooledCountsOf(base), 2, "superiority", rule);
  if (hollow.verdict === "advance") f.push(`a per-second gain bought with shallower deep runs must not advance (${hollow.reason})`);
  const hollowGate = compareToBaseline(objectiveCounts(cases[5]!.cand), objectiveCounts(base), MERGE_Z);
  if (!hollowGate.regressed.some((r) => r.startsWith("depth>=6"))) f.push(`the gate must read -30% per-run depth>=6 as a regression, got regressed=[${hollowGate.regressed}]`);
  // The finding the stratum exists for: a gain confined to the aos arm
  // lifts the pooled rate by a quarter, and neither the rule nor the gate
  // may read that as a gain.
  const aosOnly = [2000, 2001].map((s) => chunk(s, { arms: { aos: 3 } }));
  const aosCmp = compareToBaseline(objectiveCounts(aosOnly), objectiveCounts(base), MERGE_Z);
  if ((aosCmp.deltas["depth>=6:pooled"] ?? 0) < 0.1) f.push("the aos-only case must lift the pooled rate, else it tests nothing");
  const aosSeq = decideSequential(pooledCountsOf(aosOnly), pooledCountsOf(base), 2, "superiority", rule);
  if (aosSeq.verdict === "advance") f.push(`a gain confined to the aos arm must not advance (${aosSeq.reason})`);
  if (aosCmp.improved.length > 0) f.push(`a gain confined to the aos arm must not read as an improvement, got [${aosCmp.improved}]`);
  // ...and the stratum must not have taken the signal out with the noise.
  const gridOnly = [2000, 2001].map((s) => chunk(s, { arms: gridScale(1.25) }));
  const gridSeq = decideSequential(pooledCountsOf(gridOnly), pooledCountsOf(base), 2, "superiority", rule);
  if (gridSeq.verdict !== "advance") f.push(`+25% on the grid arms must advance, got ${gridSeq.verdict} (${gridSeq.reason})`);

  // An arm set that moved is a unit change, not a result: nothing may be
  // compared, and no stratified delta may be published.
  const dropArm = (e: Evaluation): Evaluation => ({
    ...e,
    metrics: { ...e.metrics, campaign: e.metrics.campaign === null ? null : { ...e.metrics.campaign, arms: e.metrics.campaign.arms.slice(1) } },
  });
  const moved = [2000, 2001].map((s) => dropArm(chunk(s, {})));
  const movedSeq = decideSequential(pooledCountsOf(moved), pooledCountsOf(base), 2, "superiority", rule);
  if (movedSeq.verdict !== "escalate") f.push(`a changed arm set must escalate, got ${movedSeq.verdict} (${movedSeq.reason})`);
  const movedCmp = compareToBaseline(objectiveCounts(moved), objectiveCounts(base), MERGE_Z);
  if (movedCmp.stratumFault?.kind !== "arms") f.push("a changed arm set must be reported as an arms fault");
  if (movedCmp.deltas["depth>=6"] !== undefined) f.push("a faulted stratum must not publish a stratified delta");

  // A chunk with no per-arm accounting must not decide on pooled counts,
  // however large the pooled gain.
  const blind = [2000, 2001].map((s) => syntheticEvaluation(s, {
    runs: Math.round(shape.runs), exposureMs: Math.round(shape.exposureMs) + s, h2Rate: shape.h2, noCampaign: true,
    depthAtLeast: [shape.runs, shape.runs, shape.runs, shape.d4, shape.d5, shape.d6 * 3, shape.d7, shape.d8].map((v) => Math.round(v)),
  }));
  const blindSeq = decideSequential(pooledCountsOf(blind), pooledCountsOf(base), 2, "superiority", rule);
  if (blindSeq.verdict === "advance") f.push(`a tripled pooled rate with no per-arm accounting must not advance (${blindSeq.reason})`);

  // The violation prior. A violation at the archive rate is what the corpus
  // produces anyway; one far above it is the candidate's.
  const nullPooled = pooledCountsOf(cases[0]!.cand);
  const atRate: RatePrior = { violations: 1, runs: Math.max(1, nullPooled.runs), chunks: 4, sinceEpoch: 7 };
  const rare: RatePrior = { violations: 1, runs: Math.max(1, nullPooled.runs) * 100, chunks: 400, sinceEpoch: 7 };
  const withViolations = (n: number, prior: RatePrior): SeqDecision =>
    decideSequential({ ...nullPooled, violations: n }, pooledCountsOf(base), 2, "superiority", { ...rule, violationPrior: prior });
  if (withViolations(1, atRate).verdict === "advance") f.push("a violation at the archive rate must not advance");
  if (withViolations(6, rare).verdict !== "advance") f.push(`violations far above the archive rate must advance, got ${withViolations(6, rare).verdict}`);

  // The primary a decision records must stay on the depth scale whenever
  // violations are not the separated improvement. With a prior in force a
  // clean candidate has a small non-zero violations delta, and selecting on
  // "the delta is non-zero" would silently put 1e-7 where depth>=6 belongs.
  const baseViolating = base.map((e, i) => (i === 0 ? { ...e, metrics: { ...e.metrics, violations: 1 } } : e));
  const cmpV = compareToBaseline(objectiveCounts(cases[1]!.cand), objectiveCounts(baseViolating), MERGE_Z, rare);
  if ((cmpV.deltas["violations"] ?? 0) === 0) f.push("the primary-selection case needs a non-zero violations delta to be a test");
  if (primaryDelta(cmpV) !== (cmpV.deltas["depth>=6"] ?? 0)) f.push(`primary must be the depth>=6 delta when violations did not improve, got ${primaryDelta(cmpV)}`);

  // The dispersion the variance model charges must still cover what the
  // recorded baseline shows. This is the assertion that would have caught
  // the pooled statistic: it fires again the moment an arm change or a
  // spur change re-inflates the primary rung's chunk-to-chunk scatter.
  const liveStratum = live?.base.rateStratum;
  if (liveStratum && liveStratum.chunks >= 2) {
    const cv6 = rungCv(liveStratum, 6);
    if (cv6 > 0.025) f.push(`the recorded baseline's stratified depth>=6 chunk cv is ${(cv6 * 100).toFixed(2)}%, above the 2.5% the variance model is calibrated for`);
  }

  // The chunk cap is justified by what the last chunk buys: at the measured
  // primary-rung counts the minimum separable effect at the cap must be
  // within half again of what unbounded sampling could reach, else the cap
  // (or the baseline size it equals) needs re-deriving. Read on the
  // stratum, which is what the rule now samples against.
  const baseStratum = pooledCountsOf(base).rateStratum;
  if (baseStratum === null || baseStratum.chunks === 0) {
    f.push("the synthetic baseline must carry a rate stratum");
  } else {
    const d6Base = baseStratum.depth[5] ?? 0;
    const capExposure = (baseStratum.exposureSec / baseStratum.chunks) * rule.maxChunks;
    const atCap = minimumEffect(d6Base, baseStratum.exposureSec, capExposure);
    const unbounded = MERGE_Z * Math.sqrt(1 / Math.max(1, d6Base));
    if (!(atCap <= 1.5 * unbounded)) f.push(`depth>=6 minimum effect at the cap (${(atCap * 100).toFixed(1)}%) exceeds 1.5x the unbounded floor (${(unbounded * 100).toFixed(1)}%)`);
  }
  // The timing classifier: a missing session is always an anomaly, a slow
  // chunk only until the candidate is known to be slow, and a suspend is
  // not one because exposure is active time.
  const ref = chunk(3000, {});
  if (classifyChunkTiming(ref, medianRpsRef, false) !== null) f.push("a normal chunk is not an anomaly");
  if (classifyChunkTiming({ ...ref, suspendedMs: 5000 }, medianRpsRef, false) !== null) f.push("a chunk that straddled a suspend still counts");
  if (classifyChunkTiming({ ...ref, session: null }, medianRpsRef, false) === null) f.push("a chunk without a session summary is an anomaly");
  const slowChunk = chunk(3001, { rps: 0.3 });
  if (classifyChunkTiming(slowChunk, medianRpsRef, false) === null) f.push("a chunk at a third of the baseline throughput is an anomaly");
  if (classifyChunkTiming(slowChunk, medianRpsRef, true) !== null) f.push("a slow chunk of a confirmed-slow candidate counts");
  if (classifyChunkTiming(chunk(3002, { rps: 1.6 }), medianRpsRef, false) !== null) f.push("a fast chunk is never an anomaly");
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
  violationPrior?: RatePrior | null | undefined;
  onChunk: (seq: SeqState, decision: SeqDecision) => void;
  onAnomaly?: (e: Evaluation, reason: string) => void;
  stopRequested: () => boolean;
}): Promise<SeqRunResult> {
  const p = opts.ctx.policy.sequential;
  const rule = seqRuleOf(opts.ctx.policy, opts.violationPrior ?? null);
  const evals: Evaluation[] = [];
  let seq: SeqState = opts.prior ?? initialSeqState(opts.hypothesisId, opts.baselineKey);
  // Nothing the candidate can measure is comparable without a baseline
  // stratum, so learn it before spending the first chunk rather than after.
  if (opts.baseline.rateStratum === null) {
    return { verdict: "error", reason: "the baseline chunks carry no per-arm accounting; re-run `cli baseline` under this mask", evals, seq };
  }
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
      rateStratum: addStratum(seq.rateStratum, chunkStratum(e)),
    };
    const cap = Math.min(opts.maxChunksTotal, p.maxChunks * (seq.resumes + 1));
    const decision = decideSequential(pooledFromSeq(seq), opts.baseline, seq.chunks, opts.kind, { ...rule, maxChunks: cap });
    seq = { ...seq, posteriors: decision.posteriors, lastVerdict: decision.verdict };
    opts.onChunk(seq, decision);
    if (decision.verdict !== "continue") return { verdict: decision.verdict, reason: decision.reason, evals, seq };
  }
}
