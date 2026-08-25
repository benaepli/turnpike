// Sequential evaluation: sample the candidate in chunks and stop as soon as
// the pooled evidence decides, instead of judging on a fixed sample. The
// decision rule is a pure function of pooled counts so it can be simulated
// offline with the same code that runs live.
import type { Policy } from "./policy.js";
import { runOneEvaluation, type EvalContext } from "./evaluate.js";
import type { LoopState } from "./state.js";
import { compareRates, type RateComparison } from "./stats.js";
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
  depth4: number;
  depth5: number;
  depth6plus: number;
  violations: number;
  h2Count: number;
}

export type SeqKind = "superiority" | "noninferiority";
export type SeqVerdict = "advance" | "reject" | "continue" | "inconclusive";

export interface SeqDecision {
  verdict: SeqVerdict;
  reason: string;
  posteriors: Record<string, number>;
}

export function emptyCounts(): PooledCounts {
  return { runs: 0, graded: 0, depth4: 0, depth5: 0, depth6plus: 0, violations: 0, h2Count: 0 };
}

export function pooledCountsOf(evals: Evaluation[]): PooledCounts {
  const c = emptyCounts();
  for (const e of evals) {
    if (!e.ok) continue;
    const d = e.metrics.depthAtLeast;
    c.runs += e.metrics.runs;
    c.graded += e.metrics.gradedRuns;
    c.depth4 += d[3] ?? 0;
    c.depth5 += d[4] ?? 0;
    c.depth6plus += d[5] ?? 0;
    c.violations += e.metrics.violations;
    c.h2Count += Math.round(e.metrics.h2Rate * e.metrics.runs);
  }
  return c;
}

export function addCounts(a: PooledCounts, b: PooledCounts): PooledCounts {
  return {
    runs: a.runs + b.runs, graded: a.graded + b.graded, depth4: a.depth4 + b.depth4,
    depth5: a.depth5 + b.depth5, depth6plus: a.depth6plus + b.depth6plus,
    violations: a.violations + b.violations, h2Count: a.h2Count + b.h2Count,
  };
}

type SeqPolicy = Policy["sequential"];

function decisionSeed(cand: PooledCounts, chunks: number): number {
  return (chunks * 1000003 + cand.depth4 * 7919 + cand.depth5 * 104729 + cand.h2Count) >>> 0;
}

// The stopping rule. Frontier rungs (depth>=4, depth>=5) can advance a
// hypothesis; h2 is supporting evidence only (it keeps sampling alive but
// never advances on its own). Violations and depth>=6 events with a zero
// baseline are decisive whenever they appear.
export function decideSequential(
  cand: PooledCounts, base: PooledCounts, chunks: number, kind: SeqKind, p: SeqPolicy,
): SeqDecision {
  const seed = decisionSeed(cand, chunks);
  const d4 = compareRates(cand.depth4, cand.graded, base.depth4, base.graded, p.mei.depth4, p.regressMargin, p.draws, seed);
  const d5 = compareRates(cand.depth5, cand.graded, base.depth5, base.graded, p.mei.depth5, p.regressMargin, p.draws, seed + 1);
  const h2 = compareRates(cand.h2Count, cand.runs, base.h2Count, base.runs, p.mei.h2, p.regressMargin, p.draws, seed + 2);
  const posteriors: Record<string, number> = {
    "depth>=4:pGreater": d4.pGreater, "depth>=4:pMei": d4.pAtLeastMei, "depth>=4:ratio": d4.meanRatio,
    "depth>=5:pGreater": d5.pGreater, "depth>=5:pMei": d5.pAtLeastMei, "depth>=5:ratio": d5.meanRatio,
    "h2:pGreater": h2.pGreater, "h2:pMei": h2.pAtLeastMei, "h2:ratio": h2.meanRatio,
    "depth>=4:pRegress": d4.pRegress, "h2:pRegress": h2.pRegress,
  };
  const out = (verdict: SeqVerdict, reason: string): SeqDecision => ({ verdict, reason, posteriors });

  if (cand.violations >= 1 && base.violations === 0) return out("advance", `violations appeared (${cand.violations})`);
  if (cand.depth6plus >= 3 && base.depth6plus === 0) return out("advance", `depth>=6 reached ${cand.depth6plus} times`);

  if (kind === "noninferiority") {
    const worst = Math.max(d4.pRegress, h2.pRegress);
    if (chunks >= p.minChunks && cand.violations <= base.violations && d4.pRegress <= 1 - p.niP && h2.pRegress <= 1 - p.niP) {
      return out("advance", "non-inferior on depth>=4 and h2");
    }
    if (worst >= p.niP) return out("reject", `regression: pRegress ${worst.toFixed(3)}`);
    if (chunks >= p.maxChunks) return out("inconclusive", "non-inferiority unresolved at cap");
    return out("continue", "non-inferiority undecided");
  }

  if (chunks >= p.minChunks) {
    if (d4.pRegress >= p.niP) return out("reject", `depth>=4 regressed (pRegress ${d4.pRegress.toFixed(3)})`);
    const adv = (c: RateComparison, mei: number, name: string): string | null =>
      c.pGreater >= p.advanceP && c.meanRatio >= 1 + mei / 2 ? `${name}: pGreater ${c.pGreater.toFixed(3)}, ratio ${c.meanRatio.toFixed(2)}` : null;
    const a = adv(d4, p.mei.depth4, "depth>=4") ?? adv(d5, p.mei.depth5, "depth>=5");
    if (a) return out("advance", a);
    // h2 keeps a hypothesis alive only for a bounded number of chunks: it can
    // never advance on its own, so past that point it must not block a
    // decision on the frontier rungs.
    const h2Blocks = chunks < p.h2SupportChunks && h2.pAtLeastMei >= p.rejectP;
    if (d4.pAtLeastMei < p.rejectP && d5.pAtLeastMei < p.rejectP && !h2Blocks) {
      const best = Math.max(d4.pGreater, d5.pGreater);
      // A probable but sub-MEI effect is kept for a later resume instead of
      // being discarded.
      if (best >= p.inconclusiveP) return out("inconclusive", `probable sub-minimum effect (pGreater ${best.toFixed(3)})`);
      return out("reject", `no objective plausibly reaches its minimum effect (pMei d4 ${d4.pAtLeastMei.toFixed(3)}, d5 ${d5.pAtLeastMei.toFixed(3)}, h2 ${h2.pAtLeastMei.toFixed(3)})`);
    }
  }
  if (chunks >= p.maxChunks) {
    const best = Math.max(d4.pGreater, d5.pGreater);
    return best >= p.inconclusiveP
      ? out("inconclusive", `cap reached with pGreater ${best.toFixed(3)}`)
      : out("reject", `cap reached with pGreater ${best.toFixed(3)}`);
  }
  return out("continue", "undecided");
}

export interface SeqRunResult {
  verdict: SeqVerdict | "stopped" | "error";
  reason: string;
  evals: Evaluation[];
  seq: SeqState;
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
  stopRequested: () => boolean;
}): Promise<SeqRunResult> {
  const p = opts.ctx.policy.sequential;
  const evals: Evaluation[] = [];
  let seq: SeqState = opts.prior ?? {
    hypothesisId: opts.hypothesisId, chunks: 0, runs: 0, graded: 0, depth4: 0, depth5: 0,
    depth6plus: 0, violations: 0, h2Count: 0, resumes: 0, nextSeed: 1000, posteriors: {}, lastVerdict: "", lastIteration: 0,
    baselineKey: opts.baselineKey,
  };
  let failures = 0;
  for (;;) {
    if (opts.stopRequested()) return { verdict: "stopped", reason: "STOP requested", evals, seq };
    const e = await runOneEvaluation(opts.ctx, opts.hypothesisId, "sequential", seq.nextSeed, {
      runsPerConfig: p.chunkRunsPerConfig, exploreWallSec: p.wallSecPerChunk, gradeMaxRuns: 0, gradeBudgetMs: 120_000,
    });
    evals.push(e);
    seq = { ...seq, nextSeed: seq.nextSeed + 1 };
    if (!e.ok) {
      failures++;
      if (failures >= 2) return { verdict: "error", reason: e.error ?? "evaluation failed", evals, seq };
      continue;
    }
    const c = pooledCountsOf([e]);
    seq = {
      ...seq, chunks: seq.chunks + 1, runs: seq.runs + c.runs, graded: seq.graded + c.graded,
      depth4: seq.depth4 + c.depth4, depth5: seq.depth5 + c.depth5, depth6plus: seq.depth6plus + c.depth6plus,
      violations: seq.violations + c.violations, h2Count: seq.h2Count + c.h2Count,
    };
    const pooled: PooledCounts = {
      runs: seq.runs, graded: seq.graded, depth4: seq.depth4, depth5: seq.depth5,
      depth6plus: seq.depth6plus, violations: seq.violations, h2Count: seq.h2Count,
    };
    const cap = Math.min(opts.maxChunksTotal, p.maxChunks * (seq.resumes + 1));
    const decision = decideSequential(pooled, opts.baseline, seq.chunks, opts.kind, { ...p, maxChunks: cap });
    seq = { ...seq, posteriors: decision.posteriors, lastVerdict: decision.verdict };
    opts.onChunk(seq, decision);
    if (decision.verdict !== "continue") return { verdict: decision.verdict, reason: decision.reason, evals, seq };
  }
}
