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
import { runOneEvaluation, sumVariantCells, type EvalContext } from "./evaluate.js";
import type { LoopState } from "./state.js";
import { compareRatesPoisson, rateRatioSeparated, throughputCv, type RateComparison } from "./stats.js";
import {
  ADVANCE_RUNGS, CROSS_BINARY_NULL_FLOOR, DEEP_GUARD_RUNGS, DEEP_RUNG_MARGIN, INTERNAL_Z,
  MERGE_Z, PRIMARY_RUNG, PRIMARY_RUNG_MIN_EVENTS_PER_CHUNK, RATE_EXCLUDED_ARM_MODES, REPORTED_RUNGS, RULE_VERSION, addStratum, chunkStratum,
  compareToBaseline, deepRungPRegress, deepRungReading, emptyStratum, finalGate, internalAdvanceRungsFor, internalPrimaryCells, mergeCase,
  objectiveCounts, primaryDelta, primaryRungRegressed, rateVarianceOf, ruleVerdict, rungCv, stratumFault,
  type FinalGateInputs, type MergeVerdict, type RatePrior,
} from "./decide.js";
import { askStopper, buildStopperPayload, nullBand, type StopperRecord, type StopperRung } from "./stopper.js";
import { HARD_LIMITS } from "./policy.js";
import { CampaignMetrics, Evaluation, RateStratum, SeqState, type VariantMetrics } from "./schemas.js";

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
  // The pooled per-(arm, variant) cells the internal contrast is read off.
  // Empty means the chunks carry no run tags, which is no internal primary
  // rather than no treated runs.
  variants: VariantMetrics[];
}

// What the rule says about buying another chunk, and nothing else. `stop`
// means the sample in hand is all there will be, whatever it says; whether
// that resolves for or against the candidate is the merge gate's reading.
// `inconclusive` is the one sampling statement that is not a stop: another
// chunk could still separate this, so a resume is allowed to buy one.
export type SeqVerdict = "continue" | "inconclusive" | "stop";

export interface SeqDecision {
  verdict: SeqVerdict;
  reason: string;
  posteriors: Record<string, number>;
}

export function emptyCounts(): PooledCounts {
  return {
    runs: 0, graded: 0, chunks: 0, exposureSec: 0, depth4: 0, depth5: 0, depth6plus: 0,
    depth7plus: 0, depth8plus: 0, violations: 0, h2Count: 0, rpsChunks: [], rateStratum: emptyStratum(),
    variants: [],
  };
}

export function pooledCountsOf(evals: Evaluation[]): PooledCounts {
  const c = emptyCounts();
  const cells: VariantMetrics[][] = [];
  for (const e of evals) {
    if (!e.ok) continue;
    const modes = new Map((e.metrics.campaign?.arms ?? []).map((a) => [a.id, a.mode]));
    cells.push(e.metrics.variants.filter((v) => !RATE_EXCLUDED_ARM_MODES.includes(modes.get(v.arm) ?? "")));
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
  c.variants = sumVariantCells(cells);
  return c;
}

export function pooledFromSeq(seq: SeqState): PooledCounts {
  return {
    runs: seq.runs, graded: seq.graded, chunks: seq.chunks, exposureSec: seq.exposureSec,
    depth4: seq.depth4, depth5: seq.depth5, depth6plus: seq.depth6plus,
    depth7plus: seq.depth7plus, depth8plus: seq.depth8plus,
    violations: seq.violations, h2Count: seq.h2Count, rpsChunks: seq.rpsChunks,
    rateStratum: seq.rateStratum, variants: seq.variants,
  };
}

/** The pooled per-run count at a rung. The pooled record carries depth 4
 *  through 8 per run over every arm; a per-run guard on a deeper rung would
 *  need a field the record does not have, so asking for one is an error
 *  rather than a zero. */
export function pooledRung(c: PooledCounts, k: number): number {
  switch (k) {
    case 4: return c.depth4;
    case 5: return c.depth5;
    case 6: return c.depth6plus;
    case 7: return c.depth7plus;
    case 8: return c.depth8plus;
    default: throw new Error(`depth>=${k} is not carried per run in the pooled record`);
  }
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
  // The declared treatment bit and the frozen band on the per-run ratio of
  // treated to untreated runs. null is the fallback path, where the sample
  // is judged on the cross-binary rung alone.
  treatmentBit: number | null;
  perRunBand: { min: number; max: number } | null;
}

export function seqRuleOf(
  policy: Policy, violationPrior: RatePrior | null = null,
  treatment: { bit: number | null; band: { min: number; max: number } | null } = { bit: null, band: null },
): SeqRule {
  return {
    ...policy.sequential, throughputFloor: 1 - policy.regression.throughputTolerance, violationPrior,
    treatmentBit: treatment.bit, perRunBand: treatment.band,
  };
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

/** Posteriors as the state file can hold them. A rung with no baseline
 *  events has an infinite minimum effect, and JSON writes that as null,
 *  which the state schema then refuses; the sentinel keeps the comparison
 *  ("no effect clears it") while staying a number. */
export function storablePosteriors(p: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p)) {
    out[k] = Number.isFinite(v) ? v : Number.isNaN(v) ? 0 : v > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
  }
  return out;
}

// The stopping rule, and only the stopping rule. It says when the sample in
// hand is all there will be; what the figures mean is decided once, at the
// merge gate. Sampling stops when a rung's events per explore-second already
// pass the merge gate's separation test (the primary rung first, then the
// other advance rungs, each outside the build-layout floor)
// with the deep per-run guards held, when a guard resolves against the
// candidate, when throughput is below the floor, or at the cap. Violations
// separated against the archive rate stop it wherever they appear. Whether a
// sample the rule would carry on with is worth its next chunk is priced
// elsewhere (stopper.ts).
export function decideSequential(
  cand: PooledCounts, base: PooledCounts, chunks: number, p: SeqRule,
): SeqDecision {
  // A stratum that cannot be formed or compared is a unit problem: more
  // chunks cannot fix it, and the pooled evidence belongs in front of a
  // human rather than deleted as a negative result about the hypothesis.
  const fault = stratumFault(cand.rateStratum, base.rateStratum);
  if (fault !== null) {
    return { verdict: "stop", reason: `the rate stratum cannot be compared: ${fault.detail}`, posteriors: {} };
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
  // One per-second reading per reported rung: the smallest effect the cap
  // could separate, the posterior against it, and whether the merge gate's
  // separation test already passes. A rung deeper than the record's ladder
  // reads as zero events on both sides.
  const rungs = new Map<number, { mei: number; post: RateComparison; separated: boolean }>();
  for (const k of REPORTED_RUNGS) {
    const mei = minimumEffect(sd(bs, k), bs.exposureSec, capExposure, xv(k));
    rungs.set(k, {
      mei,
      post: compareRatesPoisson(sd(cs, k), cs.exposureSec, sd(bs, k), bs.exposureSec, mei, p.regressMargin, p.draws, seed + k, xv(k)),
      separated: rateRatioSeparated(sd(cs, k), cs.exposureSec, sd(bs, k), bs.exposureSec, MERGE_Z, xv(k)),
    });
  }
  const rungAt = (k: number): { mei: number; post: RateComparison; separated: boolean } => {
    const r = rungs.get(k);
    if (r === undefined) throw new Error(`depth>=${k} is not a reported rung`);
    return r;
  };
  const meiH2 = minimumEffect(base.h2Count, base.runs, capRuns);
  const g4 = compareRatesPoisson(cand.depth4, cand.graded, base.depth4, base.graded, 0, p.regressMargin, p.draws, seed + 3);
  // Per-run guards on the deep rungs: a candidate that buys events per
  // second by making runs shallower must not advance on the shallow rungs.
  // A guard that answered neither way has not held. It stops a stop from
  // being read as a clean gain without resolving against the candidate. The
  // posterior is the gate's own, so the rule and the gate cannot read the
  // same chunks differently.
  const deepRegressed: string[] = [];
  const deepUnresolved: string[] = [];
  const deepPRegress: Record<number, number> = {};
  for (const k of DEEP_GUARD_RUNGS) {
    const pr = deepRungPRegress(pooledRung(cand, k), cand.graded, pooledRung(base, k), base.graded, k);
    deepPRegress[k] = pr;
    const reading = deepRungReading(pr);
    if (reading === "regressed") deepRegressed.push(`depth>=${k} (pRegress ${pr.toFixed(3)})`);
    else if (reading === "unresolved") deepUnresolved.push(`depth>=${k} (pRegress ${pr.toFixed(3)})`);
  }
  const h2 = compareRatesPoisson(cand.h2Count, cand.runs, base.h2Count, base.runs, meiH2, p.regressMargin, p.draws, seed + 2);
  const throughputRatio = throughputRatioOf(cand, base);
  const ip = internalPrimaryCells(cand.variants, base.variants, p.treatmentBit, p.perRunBand, chunks, p.maxChunks, [], PRIMARY_RUNG, internalAdvanceRungsFor(RULE_VERSION));
  const posteriors: Record<string, number> = {
    "h2:pGreater": h2.pGreater, "h2:ratio": h2.meanRatio, "h2:mei": meiH2,
    "depth>=4:pRegress": g4.pRegress, "h2:pRegress": h2.pRegress,
    "throughput:ratio": throughputRatio, "throughput:cv": throughputCv(cand.rpsChunks),
    "stratum:chunks": cs.chunks, "stratum:exposureSec": cs.exposureSec,
    // Whether the internal primary applies is published for every session;
    // its figures only when it does, since the posteriors hold numbers and a
    // session with no declared bit has none to publish.
    "internal:applies": ip.applies ? 1 : 0,
    ...(ip.applies ? {
      "internal:ratio": ip.ratio, "internal:lo": ip.lo, "internal:hi": ip.hi,
      "internal:z": ip.z, "internal:mei": ip.meiAtCap, "internal:share": ip.treatedShare.candidate,
    } : {}),
  };
  // The same contrast on each advance rung deeper than the primary, so the
  // rung the gate may merge on is visible in the chunk line; `separated` is
  // 1 up, -1 down, 0 for neither.
  for (const a of ip.applies ? ip.advance : []) {
    posteriors[`internal:depth>=${a.rung}:ratio`] = a.ratio;
    posteriors[`internal:depth>=${a.rung}:lo`] = a.lo;
    posteriors[`internal:depth>=${a.rung}:hi`] = a.hi;
    posteriors[`internal:depth>=${a.rung}:z`] = a.z;
    posteriors[`internal:depth>=${a.rung}:separated`] = a.verdict === "separated up" ? 1 : a.verdict === "separated down" ? -1 : 0;
  }
  for (const [k, r] of rungs) {
    posteriors[`depth>=${k}:pGreater`] = r.post.pGreater;
    posteriors[`depth>=${k}:pMei`] = r.post.pAtLeastMei;
    posteriors[`depth>=${k}:ratio`] = r.post.meanRatio;
    posteriors[`depth>=${k}:mei`] = r.mei;
    // Which rungs cleared the merge gate's separation test, recorded for
    // every rung including those that cannot advance on it.
    posteriors[`depth>=${k}:separated`] = r.separated ? 1 : 0;
    // The dispersion each rung's interval is actually charged, so an arm
    // change that re-inflates it is visible in the chunk line rather than
    // only in a widened interval.
    posteriors[`depth>=${k}:cv`] = rungCv(cs, k);
  }
  for (const k of DEEP_GUARD_RUNGS) posteriors[`depth>=${k}:pRegress`] = deepPRegress[k] ?? 0;
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
      return out("stop", `violations separated against the archive rate (${cand.violations} in ${cand.runs} runs against 1 per ${Math.round(vp.runs / vp.violations)})`);
    }
  } else if (cand.violations >= 1 && base.violations === 0) {
    return out("stop", `violations appeared (${cand.violations})`);
  }
  const belowFloor = chunks >= p.minChunks && throughputRatio < p.throughputFloor;

  let separatedRung: string | null = null;
  if (chunks >= p.minChunks) {
    if (belowFloor) return out("stop", `throughput ${throughputRatio.toFixed(3)} below floor ${p.throughputFloor}`);
    if (deepRegressed.length > 0) return out("stop", `deep rungs regressed per run beyond the ${(DEEP_RUNG_MARGIN * 100).toFixed(0)}% margin: ${deepRegressed.join(", ")}`);
    // The randomized within-session contrast is the merge criterion where a
    // treatment bit was declared, so it is also what ends the sample: a
    // contrast that has separated in either direction has said all another
    // chunk could.
    if (ip.applies) {
      if (ip.separatedDown) return out("stop", `the internal per-run contrast separated below 1.0 (${ip.ratio.toFixed(4)})`);
      if (ip.bandReading === "refuted") return out("stop", `the frozen per-run band is excluded by [${ip.lo.toFixed(4)}, ${ip.hi.toFixed(4)}]`);
      if (ip.separatedUp) return out("stop", `the internal per-run contrast separated at z ${INTERNAL_Z} (${ip.ratio.toFixed(4)} [${ip.lo.toFixed(4)}, ${ip.hi.toFixed(4)}])`);
    }
    // A cross-binary separation inside the build-layout floor resolves
    // nothing - two builds of identical source read 0.951 on the primary
    // rung, and every rung's rate carries that shift - so stopping on it
    // would buy a stop that cannot become a verdict. The primary rung is
    // read first, then the other advance rungs in ladder order.
    for (const k of [PRIMARY_RUNG, ...ADVANCE_RUNGS.filter((r) => r !== PRIMARY_RUNG)]) {
      const r = rungAt(k);
      if (r.separated && Math.abs(r.post.meanRatio - 1) > CROSS_BINARY_NULL_FLOOR) {
        separatedRung = `depth>=${k} per second separated at z ${MERGE_Z} (ratio ${r.post.meanRatio.toFixed(2)})`;
        break;
      }
    }
    // A separated rung stops the sample only when the deep rungs per run are
    // known to hold; a gain with a guard unresolved keeps sampling, since a
    // further chunk can still resolve the guard.
    if (separatedRung !== null && deepUnresolved.length === 0) return out("stop", separatedRung);
  }
  if (chunks >= p.maxChunks) {
    if (separatedRung !== null) return out("stop", `${separatedRung}, deep rungs per run unresolved: ${deepUnresolved.join(", ")}`);
    // Only the rungs a gain can separate on. The other reported rungs are
    // recorded and reach the gate as evidence; they never buy another chunk.
    const best = Math.max(...ADVANCE_RUNGS.map((k) => rungAt(k).post.pGreater));
    return best >= p.inconclusiveP
      ? out("inconclusive", `cap reached with pGreater ${best.toFixed(3)}`)
      : out("stop", `cap reached with pGreater ${best.toFixed(3)}`);
  }
  return out("continue", "undecided");
}

// Whether any further chunk could still produce an advance. Impossibility is
// exposed rather than acted on: the rule has no branch that rejects for it.
// An advance needs a rung to separate, so the test is the projection of each
// rung's observed rate ratio to the chunk cap: if the ratio held and the
// sample grew to the cap, would the rung separate at the merge gate's z?
export function canStillAdvance(cand: PooledCounts, base: PooledCounts, chunks: number, p: SeqRule): boolean {
  // The internal contrast's own projection. Its standard error shrinks with
  // pooled events rather than with exposure, so a session whose cross-binary
  // rung can no longer separate may still resolve its declared bit.
  const ip = internalPrimaryCells(cand.variants, base.variants, p.treatmentBit, p.perRunBand, chunks, p.maxChunks);
  if (ip.applies && ip.ratio - 1 >= ip.meiAtCap) return true;
  const cs = cand.rateStratum;
  const bs = base.rateStratum;
  if (cs === null || bs === null || chunks <= 0 || cs.exposureSec <= 0 || bs.exposureSec <= 0) return true;
  const capExposure = (cs.exposureSec / chunks) * p.maxChunks;
  return (ADVANCE_RUNGS as readonly number[]).some((k) => {
    const projected = ((cs.depth[k - 1] ?? 0) / cs.exposureSec) * capExposure;
    return rateRatioSeparated(projected, capExposure, bs.depth[k - 1] ?? 0, bs.exposureSec, MERGE_Z, rateVarianceOf(cs, bs, k));
  });
}

// What a stop resolves to: the verdict the rule itself reaches with no
// further chunk to buy. Total and never "continue" - the cap is pulled to the
// sample in hand, which is the only branch a continue can come from once
// minChunks is met. The posteriors stay the ones the sample was judged on, so
// a stopped chunk is audited against the same numbers every other chunk
// records.
export function classifyPooled(
  ruled: SeqDecision, cand: PooledCounts, base: PooledCounts, chunks: number, p: SeqRule,
): SeqDecision {
  const atCap = decideSequential(cand, base, chunks, { ...p, maxChunks: Math.max(1, chunks) });
  return { verdict: atCap.verdict, reason: atCap.reason, posteriors: ruled.posteriors };
}

// The deterministic part of the stop decision, and the whole of it whenever a
// rail binds. Rails cost no tokens: a terminal verdict from the rule (the
// stratum fault and the throughput floor among them) passes straight
// through, a sample below minChunks is too small to judge, and the hard cap
// forces a stop before any call is made, so a stopper that always says
// continue still terminates. null means no rail binds and the model may be
// consulted.
export function railVerdict(
  ruled: SeqDecision, cand: PooledCounts, base: PooledCounts, chunks: number, p: SeqRule,
): SeqDecision | null {
  if (ruled.verdict !== "continue") return ruled;
  if (chunks < p.minChunks) return ruled;
  if (chunks >= HARD_LIMITS.maxSequentialChunks) return classifyPooled(ruled, cand, base, chunks, p);
  return null;
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
    rateStratum: emptyStratum(), variants: [],
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

// A 300 s general chunk on the 20-label oracle ladder, for the self-tests
// and simulations that run without a recorded baseline on the current
// ladder: the runs completed, the runs reaching each depth (union over the
// arms), and the second-hazard rate.
export const SYNTHETIC_CHUNK = {
  runs: 633_408,
  exposureMs: 300_000,
  h2Rate: 0.4,
  depthAtLeast: [341_354, 323_893, 122_821, 119_321, 18_406, 17_788, 17_462, 6_654, 984, 46, 15, 9, 0, 0, 0, 0, 0, 0, 0, 0],
};

/** Pooled union ladder over a body of chunks: entry i is the runs reaching
 *  depth i+1, summed. */
export function pooledLadder(evals: Evaluation[]): number[] {
  const out: number[] = [];
  for (const e of evals) {
    if (!e.ok) continue;
    e.metrics.depthAtLeast.forEach((v, i) => { out[i] = (out[i] ?? 0) + v; });
  }
  return out;
}

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
  variants?: VariantMetrics[];
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
      variants: m.variants ?? [],
    },
  };
}

// The sequential rule and the merge gate test the same pooled chunks; an
// advance the gate then refuses would delete a branch on a contradiction.
// Asserted here on synthetic chunks around the measured baseline counts.
export function selfTestGateConsistency(live?: { base: PooledCounts; rule: SeqRule; ladder: number[] }): string[] {
  const f: string[] = [];
  const rule: SeqRule = live?.rule ?? {
    exploreBudgetSec: 300, maxRunsPerConfig: 4000, maxChunks: 4, minChunks: 2, inconclusiveP: 0.9, niP: 0.95,
    regressMargin: 0.25, maxResumes: 2, resumeCooldown: 2, draws: 2000, wallSecPerChunk: 900, throughputFloor: 0.8,
    violationPrior: null, treatmentBit: null, perRunBand: null,
  };
  // The synthetic chunk has the recorded baseline's per-chunk shape when one
  // on the current ladder is available, so the cap check below follows the
  // live regime; a record whose ladder stops short of the reported rungs was
  // graded on another oracle and cannot stand in.
  const deepestRung = REPORTED_RUNGS[REPORTED_RUNGS.length - 1] ?? PRIMARY_RUNG;
  const usable = live !== undefined && live.ladder.length >= deepestRung ? live : undefined;
  const per = (v: number): number => (usable ? v / usable.base.chunks : v);
  const shape = usable
    ? { runs: per(usable.base.runs), exposureMs: per(usable.base.exposureSec) * 1000, ladder: usable.ladder.map(per), h2: usable.base.h2Count / Math.max(1, usable.base.runs) }
    : { runs: SYNTHETIC_CHUNK.runs, exposureMs: SYNTHETIC_CHUNK.exposureMs, ladder: SYNTHETIC_CHUNK.depthAtLeast, h2: SYNTHETIC_CHUNK.h2Rate };
  // The primary rung has to carry enough events a chunk to separate on; a
  // shape below the floor would make every assertion below vacuous.
  const primaryPerChunk = shape.ladder[PRIMARY_RUNG - 1] ?? 0;
  if (primaryPerChunk < PRIMARY_RUNG_MIN_EVENTS_PER_CHUNK) {
    f.push(`depth>=${PRIMARY_RUNG} carries ${Math.round(primaryPerChunk)} events a chunk in the ${usable ? "recorded" : "synthetic"} baseline, below the ${PRIMARY_RUNG_MIN_EVENTS_PER_CHUNK} the primary rung needs`);
  }
  // `dP` scales the primary rung and every rung below it on the ladder, so a
  // scaled chunk stays monotone in depth.
  const chunk = (seed: number, scale: { d4?: number; d5?: number; dP?: number; rps?: number; arms?: Record<string, number> }): Evaluation => {
    const rps = scale.rps ?? 1;
    const runs = Math.round(shape.runs * rps);
    const d = shape.ladder.map((v, i) => {
      const k = i + 1;
      const s = k === 4 ? scale.d4 ?? 1 : k === 5 ? scale.d5 ?? 1 : k >= PRIMARY_RUNG ? scale.dP ?? 1 : 1;
      return Math.round(v * rps * s);
    });
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
    { name: `+25% depth>=${PRIMARY_RUNG}`, cand: [2000, 2001].map((s) => chunk(s, { dP: 1.25 })) },
    { name: "+12% depth>=4 and +15% depth>=5", cand: [2000, 2001].map((s) => chunk(s, { d4: 1.12, d5: 1.15 })) },
    { name: "+40% throughput", cand: [2000, 2001].map((s) => chunk(s, { rps: 1.4 })) },
    { name: `+30% depth>=${PRIMARY_RUNG} at -10% throughput`, cand: [2000, 2001].map((s) => chunk(s, { dP: 1.3, rps: 0.9 })) },
    { name: `+40% throughput with -30% per-run depth>=${PRIMARY_RUNG}`, cand: [2000, 2001].map((s) => chunk(s, { rps: 1.4, dP: 0.7 })) },
    { name: "+200% on the aos arm only", cand: [2000, 2001].map((s) => chunk(s, { arms: { aos: 3 } })) },
    { name: "+25% on the grid arms only", cand: [2000, 2001].map((s) => chunk(s, { arms: gridScale(1.25) })) },
  ];
  // The gate on a set of synthetic chunks, and the rule's own reading of the
  // figures it produces. null means the case is settled in code before any
  // verdict is reached, which is itself the assertion for a faulted stratum.
  const gateOn = (cand: Evaluation[], bit: number | null = null): FinalGateInputs => ({
    hypothesis: { id: "synthetic", kind: "add" } as unknown as Parameters<typeof finalGate>[0]["hypothesis"],
    confirmEvals: cand, baselineEvals: base, regressionPassed: true, lintFailures: [],
    changedSpurFiles: [], changedSuperFiles: [], throughputRatio: 1, throughputFloor: rule.throughputFloor,
    unmeasurable: [], firing: { status: "not-claimed", detail: "" }, treatmentBit: bit, perRunBand: null,
  });
  const ruleOn = (cand: Evaluation[], bit: number | null = null): { verdict: MergeVerdict; reason: string } | null => {
    const c = mergeCase(gateOn(cand, bit));
    return "figures" in c ? ruleVerdict(c.figures) : null;
  };
  // Sampling stops on a separated rung; the gate then reads the same chunks.
  // A stop the gate refuses to merge is not a contradiction - the two answer
  // different questions - but a stop on a separated rung with every guard
  // held must reach a merge, or a rung separated for nothing.
  const stopsOn = (cand: Evaluation[], chunks: number): SeqDecision =>
    decideSequential(pooledCountsOf(cand), pooledCountsOf(base), chunks, rule);
  const plus = stopsOn(cases[1]!.cand, 2);
  if (plus.verdict !== "stop") f.push(`+25% depth>=${PRIMARY_RUNG} over two chunks must stop, got ${plus.verdict} (${plus.reason})`);
  if (ruleOn(cases[1]!.cand)?.verdict !== "merge") f.push(`+25% depth>=${PRIMARY_RUNG} must merge, got ${JSON.stringify(ruleOn(cases[1]!.cand))}`);
  const faster = stopsOn(cases[3]!.cand, 2);
  if (faster.verdict !== "stop") f.push(`+40% throughput at equal per-run rates must stop, got ${faster.verdict} (${faster.reason})`);
  if (ruleOn(cases[3]!.cand)?.verdict !== "merge") f.push(`+40% throughput at equal per-run rates must merge, got ${JSON.stringify(ruleOn(cases[3]!.cand))}`);
  const slowChunks = [2000, 2001].map((s) => chunk(s, { dP: 1.25, rps: 0.7 }));
  const slow = stopsOn(slowChunks, 2);
  if (slow.verdict !== "stop" || !slow.reason.startsWith("throughput")) f.push(`a candidate below the throughput floor must stop on the floor, got ${slow.verdict} (${slow.reason})`);
  const nul = stopsOn(cases[0]!.cand, 2);
  if (nul.verdict !== "continue") f.push(`a null candidate must keep sampling at two chunks, got ${nul.verdict} (${nul.reason})`);
  if (ruleOn(cases[0]!.cand)?.verdict === "merge") f.push("a null candidate must not merge");
  const hollow = ruleOn(cases[5]!.cand);
  if (hollow?.verdict !== "close") f.push(`a per-second gain bought with shallower deep runs must close, got ${JSON.stringify(hollow)}`);
  const hollowGate = compareToBaseline(objectiveCounts(cases[5]!.cand), objectiveCounts(base), MERGE_Z);
  if (!hollowGate.regressed.some((r) => r.startsWith(`depth>=${PRIMARY_RUNG}`))) f.push(`the gate must read -30% per-run depth>=${PRIMARY_RUNG} as a regression, got regressed=[${hollowGate.regressed}]`);
  // The finding the stratum exists for: a gain confined to the aos arm
  // lifts the pooled rate by a quarter, and neither the rule nor the gate
  // may read that as a gain.
  const aosOnly = [2000, 2001].map((s) => chunk(s, { arms: { aos: 3 } }));
  const aosCmp = compareToBaseline(objectiveCounts(aosOnly), objectiveCounts(base), MERGE_Z);
  if ((aosCmp.deltas[`depth>=${PRIMARY_RUNG}:pooled`] ?? 0) < 0.1) f.push("the aos-only case must lift the pooled rate, else it tests nothing");
  if (ruleOn(aosOnly)?.verdict === "merge") f.push("a gain confined to the aos arm must not merge");
  if (aosCmp.improved.length > 0) f.push(`a gain confined to the aos arm must not read as an improvement, got [${aosCmp.improved}]`);
  // ...and the stratum must not have taken the signal out with the noise.
  const gridOnly = [2000, 2001].map((s) => chunk(s, { arms: gridScale(1.25) }));
  const gridSeq = stopsOn(gridOnly, 2);
  if (gridSeq.verdict !== "stop") f.push(`+25% on the grid arms must stop, got ${gridSeq.verdict} (${gridSeq.reason})`);
  if (ruleOn(gridOnly)?.verdict !== "merge") f.push(`+25% on the grid arms must merge, got ${JSON.stringify(ruleOn(gridOnly))}`);

  // An arm set that moved is a unit change, not a result: nothing may be
  // compared, and no stratified delta may be published.
  const dropArm = (e: Evaluation): Evaluation => ({
    ...e,
    metrics: { ...e.metrics, campaign: e.metrics.campaign === null ? null : { ...e.metrics.campaign, arms: e.metrics.campaign.arms.slice(1) } },
  });
  const moved = [2000, 2001].map((s) => dropArm(chunk(s, {})));
  const movedSeq = stopsOn(moved, 2);
  if (movedSeq.verdict !== "stop") f.push(`a changed arm set must stop, got ${movedSeq.verdict} (${movedSeq.reason})`);
  if (ruleOn(moved) !== null) f.push("a changed arm set must be settled in code, so no verdict is reached on it");
  if (finalGate(gateOn(moved), { verdict: "merge", reason: "a decider said so" }).verdict !== "needs_human") f.push("a changed arm set must reach a human whatever verdict is supplied");
  const movedCmp = compareToBaseline(objectiveCounts(moved), objectiveCounts(base), MERGE_Z);
  if (movedCmp.stratumFault?.kind !== "arms") f.push("a changed arm set must be reported as an arms fault");
  if (movedCmp.deltas[`depth>=${PRIMARY_RUNG}`] !== undefined) f.push("a faulted stratum must not publish a stratified delta");

  // A chunk with no per-arm accounting must not decide on pooled counts,
  // however large the pooled gain.
  const blind = [2000, 2001].map((s) => syntheticEvaluation(s, {
    runs: Math.round(shape.runs), exposureMs: Math.round(shape.exposureMs) + s, h2Rate: shape.h2, noCampaign: true,
    depthAtLeast: shape.ladder.map((v, i) => Math.round(i + 1 >= PRIMARY_RUNG ? v * 3 : v)),
  }));
  if (ruleOn(blind) !== null) f.push("a chunk with no per-arm accounting must be settled in code, so no verdict is reached on it");
  if (finalGate(gateOn(blind), { verdict: "merge", reason: "a decider said so" }).verdict !== "blocked") f.push("a tripled pooled rate with no per-arm accounting must block, not merge");

  // The violation prior. A violation at the archive rate is what the corpus
  // produces anyway; one far above it is the candidate's.
  const nullPooled = pooledCountsOf(cases[0]!.cand);
  const atRate: RatePrior = { violations: 1, runs: Math.max(1, nullPooled.runs), chunks: 4, sinceEpoch: 7 };
  const rare: RatePrior = { violations: 1, runs: Math.max(1, nullPooled.runs) * 100, chunks: 400, sinceEpoch: 7 };
  const withViolations = (n: number, prior: RatePrior): SeqDecision =>
    decideSequential({ ...nullPooled, violations: n }, pooledCountsOf(base), 2, { ...rule, violationPrior: prior });
  if (withViolations(1, atRate).verdict !== "continue") f.push("a violation at the archive rate must not stop the sample");
  const violationStop = withViolations(6, rare);
  if (violationStop.verdict !== "stop" || !violationStop.reason.startsWith("violations separated")) {
    f.push(`violations far above the archive rate must stop the sample, got ${violationStop.verdict} (${violationStop.reason})`);
  }

  // The primary a decision records must stay on the depth scale whenever
  // violations are not the separated improvement. With a prior in force a
  // clean candidate has a small non-zero violations delta, and selecting on
  // "the delta is non-zero" would silently put 1e-7 where the rung belongs.
  const baseViolating = base.map((e, i) => (i === 0 ? { ...e, metrics: { ...e.metrics, violations: 1 } } : e));
  const cmpV = compareToBaseline(objectiveCounts(cases[1]!.cand), objectiveCounts(baseViolating), MERGE_Z, rare);
  if ((cmpV.deltas["violations"] ?? 0) === 0) f.push("the primary-selection case needs a non-zero violations delta to be a test");
  if (primaryDelta(cmpV) !== (cmpV.deltas[`depth>=${PRIMARY_RUNG}`] ?? 0)) f.push(`primary must be the depth>=${PRIMARY_RUNG} delta when violations did not improve, got ${primaryDelta(cmpV)}`);

  // The dispersion the variance model charges must still cover what the
  // recorded baseline shows. This is the assertion that would have caught
  // the pooled statistic: it fires again the moment an arm change or a
  // spur change re-inflates the primary rung's chunk-to-chunk scatter.
  const liveStratum = usable?.base.rateStratum;
  if (liveStratum && liveStratum.chunks >= 2) {
    const cvP = rungCv(liveStratum, PRIMARY_RUNG);
    if (cvP > 0.025) f.push(`the recorded baseline's stratified depth>=${PRIMARY_RUNG} chunk cv is ${(cvP * 100).toFixed(2)}%, above the 2.5% the variance model is calibrated for`);
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
    const primaryBase = baseStratum.depth[PRIMARY_RUNG - 1] ?? 0;
    const capExposure = (baseStratum.exposureSec / baseStratum.chunks) * rule.maxChunks;
    const atCap = minimumEffect(primaryBase, baseStratum.exposureSec, capExposure);
    const unbounded = MERGE_Z * Math.sqrt(1 / Math.max(1, primaryBase));
    if (!(atCap <= 1.5 * unbounded)) f.push(`depth>=${PRIMARY_RUNG} minimum effect at the cap (${(atCap * 100).toFixed(1)}%) exceeds 1.5x the unbounded floor (${(unbounded * 100).toFixed(1)}%)`);
  }
  // The primary rung, separated below the baseline, may not merge - by the
  // rule and against any supplied verdict. The fixture is a shape whose
  // per-second primary rate is down 8% on a 3% throughput gain: every
  // per-run guard holds on it, so only a primary-rung test can refuse it.
  const primaryDown = [2000, 2001].map((s) => chunk(s, { dP: 0.9485 / 1.0317, rps: 1.0317 }));
  if (!primaryRungRegressed(objectiveCounts(primaryDown), objectiveCounts(base))) {
    f.push(`the primary-down fixture must read as a depth>=${PRIMARY_RUNG} regression, else the assertions below test nothing`);
  }
  if (primaryRungRegressed(objectiveCounts(cases[0]!.cand), objectiveCounts(base))) {
    f.push("a true null must not read as a primary-rung regression");
  }
  for (const g of ["depth>=4:pRegress", ...DEEP_GUARD_RUNGS.map((k) => `depth>=${k}:pRegress`), "h2:pRegress"]) {
    const post = decideSequential(pooledCountsOf(primaryDown), pooledCountsOf(base), 2, rule).posteriors;
    if ((post[g] ?? 0) > 1 - rule.niP) f.push(`the primary-down case is refused by ${g} instead, so it tests the wrong guard`);
  }
  const downCase = mergeCase(gateOn(primaryDown));
  if (!("figures" in downCase)) {
    f.push("the primary-down fixture must reach a verdict, else no blocker is exercised");
  } else {
    if (!downCase.figures.primaryRungRegressed) f.push("the figures must carry the primary-rung regression");
    if (ruleVerdict(downCase.figures).verdict === "merge") f.push(`the rule must not merge a depth>=${PRIMARY_RUNG} separated below the baseline`);
  }
  const forced = finalGate(gateOn(primaryDown), { verdict: "merge", reason: "a decider said so" });
  if (forced.verdict === "auto_merge") f.push(`a supplied merge must not stand while depth>=${PRIMARY_RUNG} is separated below the baseline`);
  // The same regression with nothing else standing against it: the separated
  // improvement is a violation the baseline did not see, so no shallower-rung
  // reading and no empty-improved post-condition can hold the merge back, and
  // the primary-rung test is the only thing that refuses it.
  const primaryDownAlone = [2000, 2001]
    .map((s) => chunk(s, { dP: 0.94 }))
    .map((e, i) => (i === 0 ? { ...e, metrics: { ...e.metrics, violations: 1 } } : e));
  const aloneCase = mergeCase(gateOn(primaryDownAlone));
  if (!("figures" in aloneCase)) {
    f.push("the primary-rung-only fixture must reach a verdict, else no post-condition is exercised");
  } else {
    const g = aloneCase.figures;
    if (!g.primaryRungRegressed) f.push(`the primary-rung-only fixture must read as a depth>=${PRIMARY_RUNG} regression, else it tests nothing`);
    if (g.improved.join(",") !== "violations") f.push(`the primary-rung-only fixture must separate on violations alone, got [${g.improved}]`);
    if (g.regressed.length > 0 || g.deepRungsUnresolved.length > 0) {
      f.push(`the primary-rung-only fixture must leave every other guard clean, got regressed=[${g.regressed}] unresolved=[${g.deepRungsUnresolved}]`);
    }
    if (ruleVerdict(g).verdict !== "close") f.push(`a depth>=${PRIMARY_RUNG} separated below the baseline must close, got ${JSON.stringify(ruleVerdict(g))}`);
  }
  const forcedAlone = finalGate(gateOn(primaryDownAlone), { verdict: "merge", reason: "a decider said so" });
  if (forcedAlone.verdict === "auto_merge") f.push(`the depth>=${PRIMARY_RUNG} post-condition must refuse a supplied merge on its own`);
  const clean = finalGate(gateOn(cases[1]!.cand), { verdict: "merge", reason: "a decider said so" });
  if (clean.verdict !== "auto_merge") f.push(`a +25% primary rung with every post-condition met must merge, got ${clean.verdict} (${clean.reasons.join("; ")})`);

  // Throughput bought at the deep rungs' expense, at the margin where the
  // per-run guard answers neither way. Every rung's per-second rate is up,
  // the primary rung is not separated below the baseline, and nothing is
  // recorded as regressed - so only the unresolved guard stands between this
  // shape and an unattended merge.
  const unresolvedGuard = [2000, 2001].map((s) => chunk(s, { rps: 1.4, dP: 0.75 }));
  const guardCase = mergeCase(gateOn(unresolvedGuard));
  if (!("figures" in guardCase)) {
    f.push("the unresolved-guard fixture must reach a verdict, else no blocker is exercised");
  } else {
    const g = guardCase.figures;
    if (g.deepRungsUnresolved.length === 0) f.push(`a -25% per-run depth>=${PRIMARY_RUNG} at 1.4x throughput must leave a deep guard unresolved, got regressed=[${g.regressed}]`);
    if (g.primaryRungRegressed) f.push("the unresolved-guard fixture must not be refused by the primary-rung test instead, or it tests the wrong thing");
    if (g.improved.length === 0) f.push("the unresolved-guard fixture must carry a separated improvement, else it tests nothing");
    if (ruleVerdict(g).verdict !== "human") f.push(`an unresolved deep guard must reach a human, got ${JSON.stringify(ruleVerdict(g))}`);
  }
  const forcedGuard = finalGate(gateOn(unresolvedGuard), { verdict: "merge", reason: "a decider said so" });
  if (forcedGuard.verdict === "auto_merge") f.push("a supplied merge must not stand while a deep rung per run is unresolved");

  // The internal primary, in the sampler and in the gate. A contrast that
  // separated up must both end the sample and reach a merge; one that
  // separated down must end it and close; one inside the effect floor must
  // not end it at all. The same contradiction argument as the cases above:
  // a stop the gate then refuses on the same figures deletes a branch for
  // nothing.
  // Every run reaches the rungs above the primary; `events` reach the
  // primary itself.
  const cellLadder = (events: number): number[] => Array.from({ length: PRIMARY_RUNG }, (_, i) => (i === PRIMARY_RUNG - 1 ? events : 100_000));
  const tagged = (treatedEvents: number, controlEvents: number) => (e: Evaluation): Evaluation => ({
    ...e,
    metrics: {
      ...e.metrics,
      variants: [
        { arm: "grid", variant: 16, runs: 100_000, gradedRuns: 100_000, depthAtLeast: cellLadder(treatedEvents), violations: 0, wallUsSum: 1e8, stepsUsedSum: 1e7, planCompleteRuns: 100_000 },
        { arm: "grid", variant: 0, runs: 100_000, gradedRuns: 100_000, depthAtLeast: cellLadder(controlEvents), violations: 0, wallUsSum: 1e8, stepsUsedSum: 1e7, planCompleteRuns: 100_000 },
      ],
    },
  });
  const taggedRule: SeqRule = { ...rule, treatmentBit: 16 };
  for (const [name, treated, control, wantStop, wantVerdict] of [
    ["a separated internal gain", 25_000, 20_000, true, "merge"],
    ["a separated internal loss", 20_000, 25_000, true, "close"],
    ["an internal contrast inside the effect floor", 20_100, 20_000, false, "human"],
  ] as Array<[string, number, number, boolean, MergeVerdict]>) {
    const cand = cases[0]!.cand.map(tagged(treated, control));
    const seq = decideSequential(pooledCountsOf(cand), pooledCountsOf(base), 2, taggedRule);
    const stopped = seq.verdict === "stop" && seq.reason.startsWith("the internal per-run contrast");
    if (stopped !== wantStop) f.push(`${name}: the sampler must ${wantStop ? "" : "not "}stop on the internal rail, got ${seq.verdict} (${seq.reason})`);
    const got = ruleOn(cand, 16);
    if (got?.verdict !== wantVerdict) f.push(`${name}: the gate must read ${wantVerdict}, got ${JSON.stringify(got)}`);
  }
  // The mid-run stopper's rails and the band it reads with.
  //
  // A stop resolves through the rule, so it must always resolve: over every
  // case and every chunk count, classifyPooled is terminal.
  for (const c of [...cases, { name: "primary rung down", cand: primaryDown }, { name: "changed arm set", cand: moved }, { name: "no per-arm accounting", cand: blind }]) {
    const cp = pooledCountsOf(c.cand);
    for (let n = 1; n <= rule.maxChunks; n++) {
      const ruled = decideSequential(cp, pooledCountsOf(base), n, rule);
      const stopped = classifyPooled(ruled, cp, pooledCountsOf(base), n, rule);
      if (stopped.verdict === "continue") f.push(`${c.name}: a stop at chunk ${n} did not resolve (${stopped.reason})`);
      if (stopped.posteriors !== ruled.posteriors) f.push(`${c.name}: a stop must be audited against the posteriors the chunk was judged on`);
      // Chunk 1 is below minChunks, and the hard cap forces a stop: both
      // must be decided without a model call.
      if (n === 1 && railVerdict(ruled, cp, pooledCountsOf(base), n, rule) === null) f.push(`${c.name}: chunk 1 must not cost a stopper call`);
      if (railVerdict(ruled, cp, pooledCountsOf(base), HARD_LIMITS.maxSequentialChunks, rule) === null) f.push(`${c.name}: the hard cap must not cost a stopper call`);
    }
  }
  // The null band is the arithmetic its own event counts imply, not a
  // constant: at the primary rung's measured 2,000 events a chunk it is the
  // 3.1% the A/A pairs show, and it moves when the counts move.
  if (Math.abs(nullBand(2000, 2000) - Math.sqrt(2 / 2000)) > 1e-12) f.push("the null band must be sqrt(1/ec + 1/eb)");
  if (!(nullBand(2000, 8000) < nullBand(2000, 2000))) f.push("a larger baseline must narrow the null band");
  const payloadFor = (cand: Evaluation[]): ReturnType<typeof buildStopperPayload> => {
    const cp = pooledCountsOf(cand);
    const bp = pooledCountsOf(base);
    return buildStopperPayload({
      hypothesisId: "synthetic", prediction: "", ruled: decideSequential(cp, bp, cand.length, rule),
      cand: cp, base: bp, chunks: cand.length, rule, canStillAdvance: true, evalIds: [],
    });
  };
  const primaryOf = (pl: ReturnType<typeof buildStopperPayload>): StopperRung =>
    pl.rungs.find((r) => r.rung === `depth>=${PRIMARY_RUNG}`) as StopperRung;
  const nullPayload = primaryOf(payloadFor(cases[0]!.cand));
  if (!nullPayload.insideNullBand) f.push(`a null candidate's primary rung must sit inside the band (ratio ${nullPayload.ratio}, band ${nullPayload.nullBand})`);
  if (Math.abs(nullPayload.nullBand - nullBand(nullPayload.candEvents, nullPayload.baseEvents)) > 1e-12) f.push("the payload's band must be computed from the counts it reports");
  const gainPayload = primaryOf(payloadFor(cases[1]!.cand));
  if (gainPayload.insideNullBand) f.push(`a +25% primary rung must sit outside the band (ratio ${gainPayload.ratio}, band ${gainPayload.nullBand})`);
  // Impossibility is reported, never acted on: a null candidate cannot reach
  // a separated gain at the cap, and a real one can.
  if (canStillAdvance(pooledCountsOf(cases[0]!.cand), pooledCountsOf(base), 2, rule)) f.push("a null candidate cannot still advance at the cap");
  if (!canStillAdvance(pooledCountsOf(cases[1]!.cand), pooledCountsOf(base), 2, rule)) f.push("a +25% primary rung must still be able to advance");

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
  // What the hypothesis claims its change will do, for the mid-run stopper.
  prediction: string;
  baseline: PooledCounts;
  prior: SeqState | null;
  baselineKey: string;
  maxChunksTotal: number;
  violationPrior?: RatePrior | null | undefined;
  // The stopper's answer is handed over beside the decision it produced, so
  // the chunk record carries the posteriors it was given: a model answer is
  // not recomputable, and a rejection nobody can audit is a rejection nobody
  // can check.
  onChunk: (seq: SeqState, decision: SeqDecision, stopper: StopperRecord | null) => void;
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
      variants: sumVariantCells([seq.variants, c.variants]),
    };
    const active = { ...rule, maxChunks: Math.min(opts.maxChunksTotal, p.maxChunks * (seq.resumes + 1)) };
    const pooled = pooledFromSeq(seq);
    const ruled = decideSequential(pooled, opts.baseline, seq.chunks, active);
    let decision = railVerdict(ruled, pooled, opts.baseline, seq.chunks, active);
    let stopper: StopperRecord | null = null;
    if (decision === null) {
      stopper = await askStopper(opts.ctx.policy, {
        hypothesisId: opts.hypothesisId, prediction: opts.prediction, ruled,
        cand: pooled, base: opts.baseline, chunks: seq.chunks, rule: active,
        canStillAdvance: canStillAdvance(pooled, opts.baseline, seq.chunks, active),
        evalIds: evals.filter((e) => e.ok).map((e) => e.id),
      });
      decision = stopper.action === "stop"
        ? classifyPooled(ruled, pooled, opts.baseline, seq.chunks, active)
        : ruled;
    }
    seq = { ...seq, posteriors: storablePosteriors(decision.posteriors), lastVerdict: decision.verdict };
    opts.onChunk(seq, decision, stopper);
    if (decision.verdict !== "continue") return { verdict: decision.verdict, reason: decision.reason, evals, seq };
  }
}
