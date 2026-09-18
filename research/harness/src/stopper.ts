// The stopper payload: a per-rung summary of the sample in hand, recorded
// beside a chunk's posteriors. It informs a decision to buy another chunk and
// never decides one; the sequential rule owns every terminal verdict.
//
// The null band above all: it is each rung's own counting floor,
// sqrt(1/ec + 1/eb) over the candidate and baseline event counts, so it
// follows the arm set and the chunk budget instead of going stale as a
// constant would. A ratio inside it is the spread two seeds of one unchanged
// binary produce.
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { PRIMARY_RUNG, REPORTED_RUNGS } from "./decide.js";
import { ROOT } from "./paths.js";
import type { PooledCounts, SeqDecision, SeqRule } from "./sequential.js";

// The rungs the payload reports. Every one the rule computes a posterior for.
const RUNGS = REPORTED_RUNGS;
// Violating runs are evidence, not a metric: enough of them to see whether an
// arm repeats, not the whole table.
const MAX_VIOLATING_RUNS = 20;

export interface StopperRung {
  rung: string;
  candEvents: number;
  baseEvents: number;
  candPerSec: number;
  basePerSec: number;
  ratio: number;
  nullBand: number;
  insideNullBand: boolean;
  pGreater: number;
  pRegress: number | null;
  mei: number;
  chunkCv: number | null;
  perChunkPerSec: number[];
}

export interface StopperPayload {
  hypothesis: string;
  prediction: string;
  chunk: number;
  chunksRemaining: number;
  exploreSecPerChunk: number;
  primaryRung: number;
  canStillAdvance: boolean;
  rungs: StopperRung[];
  throughput: { ratio: number; cv: number; floor: number };
  exposure: { candidateSec: number; baselineSec: number; ratio: number; lopsided: boolean };
  violations: {
    candidate: number;
    baseline: number;
    archiveOnePerRuns: number | null;
    runs: Array<{ runId: number; arm: string; configIndex: number }>;
  };
}

/** The A/A spread two seeds of one unchanged binary produce at a rung, from
 *  the event counts alone. Infinite when either side carries no events, which
 *  is the honest reading: nothing about that rung is measurable yet. */
export function nullBand(candEvents: number, baseEvents: number): number {
  if (candEvents <= 0 || baseEvents <= 0) return Infinity;
  return Math.sqrt(1 / candEvents + 1 / baseEvents);
}

/** The arm and config each violating run came from, out of the evidence the
 *  evaluation preserved. Advisory: a missing file costs the model context,
 *  never a verdict. */
function violatingRuns(evalIds: string[]): Array<{ runId: number; arm: string; configIndex: number }> {
  const out: Array<{ runId: number; arm: string; configIndex: number }> = [];
  for (const id of evalIds) {
    const p = path.join(ROOT, "research", "logs", "violations", id, "violating_runs.json");
    if (!existsSync(p)) continue;
    try {
      const rows = JSON.parse(readFileSync(p, "utf8")) as Array<Record<string, unknown>>;
      for (const r of rows) {
        out.push({ runId: Number(r["run_id"] ?? 0), arm: String(r["arm"] ?? ""), configIndex: Number(r["config_index"] ?? 0) });
        if (out.length >= MAX_VIOLATING_RUNS) return out;
      }
    } catch { /* an unreadable evidence file is not a violation record */ }
  }
  return out;
}

export interface StopperInputs {
  hypothesisId: string;
  prediction: string;
  ruled: SeqDecision;
  cand: PooledCounts;
  base: PooledCounts;
  chunks: number;
  rule: SeqRule;
  canStillAdvance: boolean;
  evalIds: string[];
}

export function buildStopperPayload(i: StopperInputs): StopperPayload {
  const post = i.ruled.posteriors;
  const cs = i.cand.rateStratum;
  const bs = i.base.rateStratum;
  const num = (k: string): number => post[k] ?? 0;
  const rungs: StopperRung[] = RUNGS.map((k) => {
    const ce = cs?.depth[k - 1] ?? 0;
    const be = bs?.depth[k - 1] ?? 0;
    const cx = cs?.exposureSec ?? 0;
    const bx = bs?.exposureSec ?? 0;
    const ratio = num(`depth>=${k}:ratio`);
    const band = nullBand(ce, be);
    return {
      rung: `depth>=${k}`,
      candEvents: ce,
      baseEvents: be,
      candPerSec: cx > 0 ? ce / cx : 0,
      basePerSec: bx > 0 ? be / bx : 0,
      ratio,
      nullBand: Number.isFinite(band) ? band : -1,
      insideNullBand: Math.abs(ratio - 1) <= band,
      pGreater: num(`depth>=${k}:pGreater`),
      pRegress: post[`depth>=${k}:pRegress`] ?? null,
      mei: num(`depth>=${k}:mei`),
      chunkCv: post[`depth>=${k}:cv`] ?? null,
      perChunkPerSec: (cs?.perChunk ?? []).map((c) => (c.exposureSec > 0 ? (c.depth[k - 1] ?? 0) / c.exposureSec : 0)),
    };
  });
  const cx = cs?.exposureSec ?? 0;
  const bx = bs?.exposureSec ?? 0;
  const exposureRatio = bx > 0 ? cx / bx : 0;
  const vp = i.rule.violationPrior;
  return {
    hypothesis: i.hypothesisId,
    prediction: i.prediction,
    chunk: i.chunks,
    chunksRemaining: Math.max(0, i.rule.maxChunks - i.chunks),
    exploreSecPerChunk: i.rule.exploreBudgetSec,
    primaryRung: PRIMARY_RUNG,
    canStillAdvance: i.canStillAdvance,
    rungs,
    throughput: { ratio: num("throughput:ratio"), cv: num("throughput:cv"), floor: i.rule.throughputFloor },
    exposure: {
      candidateSec: cx, baselineSec: bx, ratio: exposureRatio,
      lopsided: exposureRatio > 0 && Math.max(exposureRatio, 1 / exposureRatio) > 2,
    },
    violations: {
      candidate: i.cand.violations,
      baseline: i.base.violations,
      archiveOnePerRuns: vp !== null && vp.violations > 0 ? Math.round(vp.runs / vp.violations) : null,
      runs: i.cand.violations > 0 ? violatingRuns(i.evalIds) : [],
    },
  };
}
