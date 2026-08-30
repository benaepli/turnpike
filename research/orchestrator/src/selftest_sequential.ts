// Operating characteristics of the sequential stopping rule, simulated with
// the live decision code on synthetic wall-budget chunks around the recorded
// baseline. Run: npx tsx src/selftest_sequential.ts [reps] [--assert]
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decideSequential, emptyCounts, pooledCountsOf, seqRuleOf, throughputRatioOf, type PooledCounts, type SeqRule } from "./sequential.js";
import {
  MERGE_Z, compareToBaseline, figuresOf, ruleVerdict,
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

function recordedBaseline(): PooledCounts {
  const keyed = join(ROOT, "research/evaluations", `000-baseline-${livePolicy.evaluation.rayonThreads}.json`);
  const p = existsSync(keyed) ? keyed : join(ROOT, "research/evaluations/000-baseline.json");
  if (existsSync(p)) {
    const parsed = z.object({ baseline: z.object({ sequential: z.array(Evaluation).default([]) }) }).safeParse(JSON.parse(readFileSync(p, "utf8")));
    if (parsed.success && parsed.data.baseline.sequential.some((e) => e.ok)) return pooledCountsOf(parsed.data.baseline.sequential);
  }
  const depth = [216000, 216000, 216000, 78925, 24131, 3533, 441, 20];
  const gridDepth = depth.map((v) => Math.round(v * 0.87));
  return {
    runs: 216000, graded: 216000, chunks: 4, exposureSec: 361, depth4: 78925, depth5: 24131, depth6plus: 3533,
    depth7plus: 441, depth8plus: 20, violations: 0, h2Count: 89940, rpsChunks: [603, 601, 600, 589],
    rateStratum: {
      armIds: ["grid", "grid-no-purgatory", "grid-post-fault-2", "grid-short"],
      chunks: 4, runs: 184464, graded: 184464, exposureSec: 288.8, depth: gridDepth,
      perChunk: [0, 1, 2, 3].map(() => ({ exposureSec: 72.2, depth: gridDepth.map((v) => Math.round(v / 4)) })),
    },
  };
}
const BASE: PooledCounts = recordedBaseline();
const T = rule.exploreBudgetSec;
const BASE_RPS = BASE.runs / BASE.exposureSec;
const P = {
  d4: BASE.depth4 / BASE.graded, d5: BASE.depth5 / BASE.graded, d6: BASE.depth6plus / BASE.graded,
  d7: BASE.depth7plus / BASE.graded, d8: BASE.depth8plus / BASE.graded, h2: BASE.h2Count / BASE.runs,
};
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
const PG = {
  d4: (SB.depth[3] ?? 0) / SB.graded, d5: (SB.depth[4] ?? 0) / SB.graded, d6: (SB.depth[5] ?? 0) / SB.graded,
  d7: (SB.depth[6] ?? 0) / SB.graded, d8: (SB.depth[7] ?? 0) / SB.graded,
};
const aosRuns0 = Math.max(1, BASE.graded - SB.graded);
const PA = {
  d4: (BASE.depth4 - (SB.depth[3] ?? 0)) / aosRuns0, d5: (BASE.depth5 - (SB.depth[4] ?? 0)) / aosRuns0,
  d6: (BASE.depth6plus - (SB.depth[5] ?? 0)) / aosRuns0, d7: (BASE.depth7plus - (SB.depth[6] ?? 0)) / aosRuns0,
  d8: (BASE.depth8plus - (SB.depth[7] ?? 0)) / aosRuns0,
};

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
function objectivesOf(c: PooledCounts): ObjectiveCounts {
  const rung = (k: number): number => [c.depth4, c.depth5, c.depth6plus, c.depth7plus, c.depth8plus][k - 4] ?? 0;
  return {
    violations: { succ: c.violations, n: c.runs },
    depth: [4, 5, 6, 7, 8].map((k) => ({ k, succ: rung(k), n: c.graded })),
    h2: { succ: c.h2Count, n: c.runs },
    runs: c.runs, chunks: c.chunks, exposureSec: c.exposureSec,
    throughputCv: throughputCv(c.rpsChunks), rateStratum: c.rateStratum,
  };
}

// What the gate makes of a stopped sample, with no decider and no diff. The
// hard stops upstream of it - lint, the suite, a faulted stratum, a mechanism
// that never fired - cannot arise in a simulation, so the verdict on the
// figures is the whole decision here.
const BASE_OBJECTIVES = objectivesOf(BASE);
function gateVerdictOf(cand: PooledCounts): MergeVerdict {
  const co = objectivesOf(cand);
  const cmp = compareToBaseline(co, BASE_OBJECTIVES, MERGE_Z);
  const stub = {
    hypothesis: { id: "simulated", kind: "add", prediction: null },
    confirmEvals: [], baselineEvals: [], regressionPassed: true, lintFailures: [],
    changedSpurFiles: [], changedSuperFiles: [],
    throughputRatio: throughputRatioOf(cand, BASE), throughputFloor: rule.throughputFloor,
    unmeasurable: [], firing: { status: "not-claimed", detail: "" },
  } as unknown as FinalGateInputs;
  return ruleVerdict(figuresOf(stub, co, BASE_OBJECTIVES, cmp)).verdict;
}

// The rule decides only when to stop, so its own tally has two terminal
// outcomes. What the stopped sample means is the gate's reading, tallied
// beside it.
interface Expect {
  stopMin?: number; inconclusiveMin?: number; inconclusiveMax?: number;
  mergeMin?: number; mergeMax?: number; closeMin?: number; humanMin?: number;
  chunksMeanMin?: number; chunksMeanMax?: number;
}
interface Scenario { name: string; rps: number; e4: number; e5: number; e6: number; e7: number; eh2: number; expect: Expect }
const scenarios: Scenario[] = [
  // A sample that resolves nothing reaches a human. It is not a closure: a
  // null result about a change that predicted nothing is what the change
  // claimed, and only a person or a stated prediction can tell the two apart.
  { name: "null (A/A)", rps: 1, e4: 0, e5: 0, e6: 0, e7: 0, eh2: 0, expect: { stopMin: 90, humanMin: 95, mergeMax: 0, chunksMeanMin: 3.9 } },
  { name: "+25% d6", rps: 1, e4: 0, e5: 0, e6: 0.25, e7: 0.25, eh2: 0, expect: { stopMin: 90, mergeMin: 95, chunksMeanMax: 2 } },
  { name: "+25% d6 at 0.7x throughput", rps: 0.7, e4: 0, e5: 0, e6: 0.25, e7: 0.25, eh2: 0, expect: { stopMin: 100, closeMin: 95, mergeMax: 0, chunksMeanMax: 2 } },
  { name: "flat depth at 1.4x throughput", rps: 1.4, e4: 0, e5: 0, e6: 0, e7: 0, eh2: 0, expect: { stopMin: 95, mergeMin: 95, chunksMeanMax: 2 } },
  { name: "+12% d4, +15% d5", rps: 1, e4: 0.12, e5: 0.15, e6: 0.1, e7: 0.1, eh2: 0.03, expect: { stopMin: 90, mergeMin: 95, chunksMeanMax: 2 } },
  // A clear loser costs the minimum sample, not one chunk: the per-run
  // depth>=4 point comparison that used to reject at chunk 1 rejected on a
  // ratio while the objective is a rate, so it also killed candidates whose
  // rate was up. The measured price of removing it is one extra chunk here.
  { name: "harmful (-40% d4 per run)", rps: 1, e4: -0.4, e5: -0.4, e6: -0.4, e7: -0.4, eh2: -0.1, expect: { stopMin: 100, closeMin: 95, mergeMax: 0, chunksMeanMax: 2 } },
  // depth>=7 does not carry a gain the rule can stop on, so a gain confined
  // to it costs the full sample and is read at the gate.
  { name: "d7-only +40%", rps: 1, e4: 0, e5: 0, e6: 0, e7: 0.4, eh2: 0, expect: { stopMin: 90, humanMin: 95, mergeMax: 0, chunksMeanMin: 3.9 } },
  { name: "h2-only +10%", rps: 1, e4: 0, e5: 0, e6: 0, e7: 0, eh2: 0.1, expect: { stopMin: 90, humanMin: 95, mergeMax: 0, chunksMeanMin: 3.9 } },
  // The deep-rung guard is a 25% relative margin: a decline inside it stops
  // on the separated rung and merges, one at the margin leaves the guard
  // unresolved and reaches a human, one beyond it closes.
  { name: "1.4x throughput, -15% per-run d6", rps: 1.4, e4: 0, e5: 0, e6: -0.15, e7: -0.15, eh2: 0, expect: { stopMin: 90, mergeMin: 95, chunksMeanMax: 2 } },
  { name: "1.4x throughput, -25% per-run d6", rps: 1.4, e4: 0, e5: 0, e6: -0.25, e7: -0.25, eh2: 0, expect: { stopMin: 90, humanMin: 85, mergeMax: 10, chunksMeanMin: 3.5 } },
  { name: "-40% per-run d6 only", rps: 1, e4: 0, e5: 0, e6: -0.4, e7: -0.4, eh2: 0, expect: { stopMin: 90, closeMin: 95, mergeMax: 0, chunksMeanMax: 2 } },
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
  for (let r = 0; r < REPS; r++) {
    const u = seededUniform(1234 + r * 7 + Math.round(sc.e6 * 1000) + Math.round(sc.rps * 100));
    const cand = emptyCounts();
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
      const g = [
        binomial(gridRuns, PG.d4 * (1 + sc.e4), u), binomial(gridRuns, PG.d5 * (1 + sc.e5), u),
        binomial(gridRuns, PG.d6 * (1 + sc.e6), u), binomial(gridRuns, PG.d7 * (1 + sc.e7), u),
        binomial(gridRuns, PG.d8 * (1 + sc.e7), u),
      ];
      const a = [
        binomial(aosRuns, PA.d4 * (1 + sc.e4), u), binomial(aosRuns, PA.d5 * (1 + sc.e5), u),
        binomial(aosRuns, PA.d6 * (1 + sc.e6), u), binomial(aosRuns, PA.d7 * (1 + sc.e7), u),
        binomial(aosRuns, PA.d8 * (1 + sc.e7), u),
      ];
      cand.depth4 += g[0]! + a[0]!;
      cand.depth5 += g[1]! + a[1]!;
      cand.depth6plus += g[2]! + a[2]!;
      cand.depth7plus += g[3]! + a[3]!;
      cand.depth8plus += g[4]! + a[4]!;
      cand.h2Count += binomial(runs, P.h2 * (1 + sc.eh2), u);
      const chunkDepth = [gridRuns, gridRuns, gridRuns, g[0]!, g[1]!, g[2]!, g[3]!, g[4]!];
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
    const gate = gateVerdictOf(cand);
    tally[gate] = (tally[gate] ?? 0) + 1;
    chunksTotal += chunks; chunksMin = Math.min(chunksMin, chunks); chunksMax = Math.max(chunksMax, chunks);
  }
  const pctOf = (k: string): number => (100 * (tally[k] ?? 0)) / REPS;
  const pct = (k: string): string => pctOf(k).toFixed(0).padStart(3) + "%";
  const meanChunks = chunksTotal / REPS;
  console.log(`${sc.name.padEnd(34)} stop ${pct("stop")}  inconc ${pct("inconclusive")} | merge ${pct("merge")}  close ${pct("close")}  human ${pct("human")}  chunks mean ${meanChunks.toFixed(1)} [${chunksMin}-${chunksMax}]`);
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
console.log(`policy: chunk=${T}s explore budget, baseline ${BASE.chunks} chunks / ${BASE.runs} runs (about ${Math.round(T * BASE_RPS)} runs at baseline throughput) maxChunks=${rule.maxChunks} minChunks=${rule.minChunks} inconclusiveP=${rule.inconclusiveP} throughputFloor=${rule.throughputFloor} (minimum effect derived from baseline counts and the cap)`);
if (failures.length > 0) {
  console.log(`expectations not met:\n  ${failures.join("\n  ")}`);
  if (assertMode) process.exit(1);
} else if (assertMode) {
  console.log("all expectations met");
}
