// Operating characteristics of the sequential stopping rule, simulated with
// the live decision code on synthetic wall-budget chunks around the recorded
// baseline. Run: npx tsx src/selftest_sequential.ts [reps] [--assert]
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  SYNTHETIC_CHUNK, decideSequential, emptyCounts, pooledCountsOf, pooledLadder, seqRuleOf, syntheticEvaluation, throughputRatioOf,
  type PooledCounts, type SeqRule,
} from "./sequential.js";
import {
  MERGE_Z, PRIMARY_RUNG, REPORTED_RUNGS, compareToBaseline, figuresOf, ruleVerdict,
  type FinalGateInputs, type MergeVerdict, type ObjectiveCounts,
} from "./decide.js";
import { seededUniform, throughputCv } from "./stats.js";
import { loadPolicy } from "./policy.js";
import { ROOT } from "./paths.js";
import { Evaluation } from "./schemas.js";
import { z } from "zod";

// The rule under test is the committed policy, and the chunk shape is the
// recorded baseline, so the operating characteristics describe the regime
// the loop runs rather than a remembered one.
const livePolicy = loadPolicy(join(ROOT, "research/policy.json")).policy;
const rule: SeqRule = seqRuleOf(livePolicy);
const DEEPEST_RUNG = REPORTED_RUNGS[REPORTED_RUNGS.length - 1] ?? PRIMARY_RUNG;

// The pooled counts and the pooled union ladder (entry i = runs reaching
// depth i+1) of the baseline the simulation samples around. A recorded
// baseline whose ladder stops short of the reported rungs was graded on
// another oracle, so the synthetic chunk on the current ladder stands in.
function recordedBaseline(): { counts: PooledCounts; ladder: number[]; source: string } {
  const keyed = join(ROOT, "research/evaluations", `000-baseline-${livePolicy.evaluation.rayonThreads}.json`);
  const p = existsSync(keyed) ? keyed : join(ROOT, "research/evaluations/000-baseline.json");
  if (existsSync(p)) {
    const parsed = z.object({ baseline: z.object({ sequential: z.array(Evaluation).default([]) }) }).safeParse(JSON.parse(readFileSync(p, "utf8")));
    if (parsed.success && parsed.data.baseline.sequential.some((e) => e.ok)) {
      const ladder = pooledLadder(parsed.data.baseline.sequential);
      if (ladder.length >= DEEPEST_RUNG) return { counts: pooledCountsOf(parsed.data.baseline.sequential), ladder, source: p };
    }
  }
  const chunks = [1000, 1001, 1002, 1003].map((seed) => syntheticEvaluation(seed, {
    runs: SYNTHETIC_CHUNK.runs, exposureMs: SYNTHETIC_CHUNK.exposureMs + seed, depthAtLeast: SYNTHETIC_CHUNK.depthAtLeast, h2Rate: SYNTHETIC_CHUNK.h2Rate,
  }));
  return { counts: pooledCountsOf(chunks), ladder: pooledLadder(chunks), source: "synthetic chunk on the current ladder" };
}
const recorded = recordedBaseline();
const BASE: PooledCounts = recorded.counts;
const BASE_LADDER: number[] = recorded.ladder;
const T = rule.exploreBudgetSec;
const BASE_RPS = BASE.runs / BASE.exposureSec;
const P_H2 = BASE.h2Count / BASE.runs;
// The rule decides on the arms the rate is stratified on, so the simulated
// candidate has to carry a stratum with the baseline's own shape. The grid
// arms' share of runs, of wall and of each rung comes from the recorded
// baseline; within an arm the draw is binomial, so the aos over-dispersion
// this stratification exists to exclude is not simulated - it no longer
// reaches the decision.
const SB = BASE.rateStratum;
if (SB === null || SB.chunks === 0) {
  console.error("the recorded baseline carries no rate stratum; run `cli baseline` under this mask");
  process.exit(1);
}
const GRID_RUN_SHARE = SB.runs / BASE.runs;
const GRID_WALL_SHARE = SB.exposureSec / BASE.exposureSec;
const aosRuns0 = Math.max(1, BASE.graded - SB.graded);
// Per-run rung probabilities inside the stratum and outside it.
const PG = new Map<number, number>(REPORTED_RUNGS.map((k) => [k, (SB.depth[k - 1] ?? 0) / SB.graded]));
const PA = new Map<number, number>(REPORTED_RUNGS.map((k) => [k, Math.max(0, (BASE_LADDER[k - 1] ?? 0) - (SB.depth[k - 1] ?? 0)) / aosRuns0]));

function normal(u: () => number): number {
  let z = 0;
  for (let i = 0; i < 12; i++) z += u();
  return z - 6;
}

function binomial(n: number, prob: number, u: () => number): number {
  // Normal approximation with continuity correction is adequate at these n.
  const mean = n * prob;
  const sd = Math.sqrt(n * prob * (1 - prob));
  return Math.max(0, Math.round(mean + sd * normal(u)));
}

// The counts the gate reads, from a simulated sample. The same shape
// objectiveCounts builds from evaluations, so the figures below are the
// figures a live decision is made on rather than a second arithmetic.
function objectivesOf(c: PooledCounts, ladder: number[]): ObjectiveCounts {
  return {
    violations: { succ: c.violations, n: c.runs },
    depth: REPORTED_RUNGS.map((k) => ({ k, succ: ladder[k - 1] ?? 0, n: c.graded })),
    h2: { succ: c.h2Count, n: c.runs },
    runs: c.runs, chunks: c.chunks, exposureSec: c.exposureSec,
    throughputCv: throughputCv(c.rpsChunks), rateStratum: c.rateStratum,
  };
}

// What the gate makes of a stopped sample, with no decider and no diff. The
// hard stops upstream of it - lint, the suite, a faulted stratum, a mechanism
// that never fired - cannot arise in a simulation, so the verdict on the
// figures is the whole decision here.
const BASE_OBJECTIVES = objectivesOf(BASE, BASE_LADDER);
function gateVerdictOf(cand: PooledCounts, ladder: number[]): MergeVerdict {
  const co = objectivesOf(cand, ladder);
  const cmp = compareToBaseline(co, BASE_OBJECTIVES, MERGE_Z);
  const stub = {
    hypothesis: { id: "simulated", kind: "add", prediction: null },
    confirmEvals: [], baselineEvals: [], regressionPassed: true, lintFailures: [],
    changedSpurFiles: [], changedSuperFiles: [],
    throughputRatio: throughputRatioOf(cand, BASE), throughputFloor: rule.throughputFloor,
    unmeasurable: [], firing: { status: "not-claimed", detail: "" },
  } as unknown as FinalGateInputs;
  return ruleVerdict(figuresOf(stub, co, BASE_OBJECTIVES, cmp, null)).verdict;
}

// The rule decides only when to stop, so its own tally has two terminal
// outcomes. What the stopped sample means is the gate's reading, tallied
// beside it.
interface Expect {
  stopMin?: number; inconclusiveMin?: number; inconclusiveMax?: number;
  mergeMin?: number; mergeMax?: number; closeMin?: number; humanMin?: number;
  chunksMeanMin?: number; chunksMeanMax?: number;
}
// Relative per-run effects by rung; a rung not named is unchanged.
type Effects = Partial<Record<number, number>>;
interface Scenario { name: string; rps: number; e: Effects; eh2: number; expect: Expect }
const P = PRIMARY_RUNG;
const fromRung = (k: number, e: number): Effects => Object.fromEntries(REPORTED_RUNGS.filter((r) => r >= k).map((r) => [r, e]));
const beyondAdvance = REPORTED_RUNGS.filter((r) => r > P + 2);
const scenarios: Scenario[] = [
  // A sample that resolves nothing reaches a human. It is not a closure: a
  // null result about a change that predicted nothing is what the change
  // claimed, and only a person or a stated prediction can tell the two apart.
  { name: "null (A/A)", rps: 1, e: {}, eh2: 0, expect: { stopMin: 90, humanMin: 95, mergeMax: 0, chunksMeanMin: 3.9 } },
  { name: `+25% depth>=${P} and deeper`, rps: 1, e: fromRung(P, 0.25), eh2: 0, expect: { stopMin: 90, mergeMin: 95, chunksMeanMax: 2 } },
  { name: `+25% depth>=${P} at 0.7x throughput`, rps: 0.7, e: fromRung(P, 0.25), eh2: 0, expect: { stopMin: 100, closeMin: 95, mergeMax: 0, chunksMeanMax: 2 } },
  { name: "flat depth at 1.4x throughput", rps: 1.4, e: {}, eh2: 0, expect: { stopMin: 95, mergeMin: 95, chunksMeanMax: 2 } },
  // The shallow rungs cannot stop the sample, so this stops on the primary
  // rung's own +10%, which sits near the separable effect at two chunks and
  // occasionally buys a third.
  { name: "+12% d4, +15% d5, +10% depth>=6 on", rps: 1, e: { 4: 0.12, 5: 0.15, ...fromRung(6, 0.1) }, eh2: 0.03, expect: { stopMin: 90, mergeMin: 95, chunksMeanMax: 2.5 } },
  // A clear loser costs the minimum sample, not one chunk: the per-run
  // depth>=4 point comparison that used to reject at chunk 1 rejected on a
  // ratio while the objective is a rate, so it also killed candidates whose
  // rate was up. The measured price of removing it is one extra chunk here.
  { name: "harmful (-40% every rung per run)", rps: 1, e: fromRung(4, -0.4), eh2: -0.1, expect: { stopMin: 100, closeMin: 95, mergeMax: 0, chunksMeanMax: 2 } },
  // A rung beyond the advance set does not carry a gain the rule can stop
  // on, so a gain confined to it costs the full sample and is read at the gate.
  { name: `+40% beyond depth>=${P + 2} only`, rps: 1, e: Object.fromEntries(beyondAdvance.map((r) => [r, 0.4])), eh2: 0, expect: { stopMin: 90, humanMin: 95, mergeMax: 0, chunksMeanMin: 3.9 } },
  { name: "h2-only +10%", rps: 1, e: {}, eh2: 0.1, expect: { stopMin: 90, humanMin: 95, mergeMax: 0, chunksMeanMin: 3.9 } },
  // The deep-rung guard is a 25% relative margin: a decline inside it stops
  // on the separated rung and merges, one at the margin leaves the guard
  // unresolved and reaches a human, one beyond it closes.
  { name: `1.4x throughput, -15% per-run depth>=${P}`, rps: 1.4, e: fromRung(P, -0.15), eh2: 0, expect: { stopMin: 90, mergeMin: 95, chunksMeanMax: 2 } },
  // At the margin the per-second primary sits at +5%, on the build-layout
  // floor, so the sample runs to the cap and is as often resumable as
  // stopped; either way the gate reads it as a human's call.
  { name: `1.4x throughput, -25% per-run depth>=${P}`, rps: 1.4, e: fromRung(P, -0.25), eh2: 0, expect: { humanMin: 85, mergeMax: 10, chunksMeanMin: 3.5 } },
  { name: `-40% per-run depth>=${P} only`, rps: 1, e: fromRung(P, -0.4), eh2: 0, expect: { stopMin: 90, closeMin: 95, mergeMax: 0, chunksMeanMax: 2 } },
];
const args = process.argv.slice(2);
const assertMode = args.includes("--assert");
const REPS = Number(args.find((a) => !a.startsWith("--")) ?? 150);

const failures: string[] = [];
for (const sc of scenarios) {
  const tally: Record<string, number> = { stop: 0, inconclusive: 0, merge: 0, close: 0, human: 0 };
  let chunksTotal = 0;
  let chunksMin = 1e9;
  let chunksMax = 0;
  const eP = sc.e[P] ?? 0;
  for (let r = 0; r < REPS; r++) {
    const u = seededUniform(1234 + r * 7 + Math.round(eP * 1000) + Math.round(sc.rps * 100));
    const cand = emptyCounts();
    const ladder: number[] = [];
    let chunks = 0;
    let verdict = "continue";
    while (verdict === "continue") {
      chunks++;
      const rps = BASE_RPS * sc.rps * (1 + 0.01 * normal(u));
      const runs = Math.round(T * rps);
      cand.chunks += 1;
      cand.runs += runs; cand.graded += runs;
      cand.exposureSec += T + 0.3;
      cand.rpsChunks.push(runs / (T + 0.3));
      const gridRuns = Math.round(runs * GRID_RUN_SHARE);
      const aosRuns = runs - gridRuns;
      const gridExposure = (T + 0.3) * GRID_WALL_SHARE;
      const g = new Map<number, number>();
      const a = new Map<number, number>();
      for (const k of REPORTED_RUNGS) {
        const lift = 1 + (sc.e[k] ?? 0);
        g.set(k, binomial(gridRuns, Math.min(1, (PG.get(k) ?? 0) * lift), u));
        a.set(k, binomial(aosRuns, Math.min(1, (PA.get(k) ?? 0) * lift), u));
      }
      const union = (k: number): number => (g.get(k) ?? 0) + (a.get(k) ?? 0);
      cand.depth4 += union(4);
      cand.depth5 += union(5);
      cand.depth6plus += union(6);
      cand.depth7plus += union(7);
      cand.depth8plus += union(8);
      cand.h2Count += binomial(runs, P_H2 * (1 + sc.eh2), u);
      const chunkDepth: number[] = [];
      for (let k = 1; k <= DEEPEST_RUNG; k++) {
        chunkDepth[k - 1] = k < 4 ? gridRuns : (g.get(k) ?? 0);
        ladder[k - 1] = (ladder[k - 1] ?? 0) + (k < 4 ? runs : union(k));
      }
      const cs = cand.rateStratum;
      if (cs !== null) {
        cand.rateStratum = {
          ...cs, armIds: SB.armIds, chunks: cs.chunks + 1, runs: cs.runs + gridRuns, graded: cs.graded + gridRuns,
          exposureSec: cs.exposureSec + gridExposure,
          depth: chunkDepth.map((v, i) => (cs.depth[i] ?? 0) + v),
          perChunk: [...cs.perChunk, { exposureSec: gridExposure, depth: chunkDepth }],
        };
      }
      verdict = decideSequential(cand, BASE, chunks, rule).verdict;
    }
    tally[verdict] = (tally[verdict] ?? 0) + 1;
    const gate = gateVerdictOf(cand, ladder);
    tally[gate] = (tally[gate] ?? 0) + 1;
    chunksTotal += chunks; chunksMin = Math.min(chunksMin, chunks); chunksMax = Math.max(chunksMax, chunks);
  }
  const pctOf = (k: string): number => (100 * (tally[k] ?? 0)) / REPS;
  const pct = (k: string): string => pctOf(k).toFixed(0).padStart(3) + "%";
  const meanChunks = chunksTotal / REPS;
  console.log(`${sc.name.padEnd(40)} stop ${pct("stop")}  inconc ${pct("inconclusive")} | merge ${pct("merge")}  close ${pct("close")}  human ${pct("human")}  chunks mean ${meanChunks.toFixed(1)} [${chunksMin}-${chunksMax}]`);
  const e = sc.expect;
  if (e.stopMin !== undefined && pctOf("stop") < e.stopMin) failures.push(`${sc.name}: stop ${pctOf("stop").toFixed(0)}% < ${e.stopMin}%`);
  if (e.inconclusiveMin !== undefined && pctOf("inconclusive") < e.inconclusiveMin) failures.push(`${sc.name}: inconclusive ${pctOf("inconclusive").toFixed(0)}% < ${e.inconclusiveMin}%`);
  if (e.inconclusiveMax !== undefined && pctOf("inconclusive") > e.inconclusiveMax) failures.push(`${sc.name}: inconclusive ${pctOf("inconclusive").toFixed(0)}% > ${e.inconclusiveMax}%`);
  if (e.mergeMin !== undefined && pctOf("merge") < e.mergeMin) failures.push(`${sc.name}: merge ${pctOf("merge").toFixed(0)}% < ${e.mergeMin}%`);
  if (e.mergeMax !== undefined && pctOf("merge") > e.mergeMax) failures.push(`${sc.name}: merge ${pctOf("merge").toFixed(0)}% > ${e.mergeMax}%`);
  if (e.closeMin !== undefined && pctOf("close") < e.closeMin) failures.push(`${sc.name}: close ${pctOf("close").toFixed(0)}% < ${e.closeMin}%`);
  if (e.humanMin !== undefined && pctOf("human") < e.humanMin) failures.push(`${sc.name}: human ${pctOf("human").toFixed(0)}% < ${e.humanMin}%`);
  if (e.chunksMeanMin !== undefined && meanChunks < e.chunksMeanMin) failures.push(`${sc.name}: mean chunks ${meanChunks.toFixed(1)} < ${e.chunksMeanMin}`);
  if (e.chunksMeanMax !== undefined && meanChunks > e.chunksMeanMax) failures.push(`${sc.name}: mean chunks ${meanChunks.toFixed(1)} > ${e.chunksMeanMax}`);
}
console.log(`policy: chunk=${T}s explore budget, primary rung depth>=${P}, baseline ${BASE.chunks} chunks / ${BASE.runs} runs from ${recorded.source} (about ${Math.round(T * BASE_RPS)} runs at baseline throughput, ${Math.round((BASE_LADDER[P - 1] ?? 0) / BASE.chunks)} depth>=${P} events a chunk) maxChunks=${rule.maxChunks} minChunks=${rule.minChunks} inconclusiveP=${rule.inconclusiveP} throughputFloor=${rule.throughputFloor} (minimum effect derived from baseline counts and the cap)`);
if (failures.length > 0) {
  console.log(`expectations not met:\n  ${failures.join("\n  ")}`);
  if (assertMode) process.exit(1);
} else if (assertMode) {
  console.log("all expectations met");
}
