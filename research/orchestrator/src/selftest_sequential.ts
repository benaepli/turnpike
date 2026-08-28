// Operating characteristics of the sequential stopping rule, simulated with
// the live decision code on synthetic wall-budget chunks around the measured
// baseline rates. Run: npx tsx src/selftest_sequential.ts [reps] [--assert]
import { decideSequential, emptyCounts, type PooledCounts, type SeqRule } from "./sequential.js";
import { seededUniform } from "./stats.js";
import { Policy } from "./policy.js";

const policy = Policy.parse({
  models: { propose: "x", judge: "x", implement: "x", diagnose: "x", reflect: "x", audit: "x" },
  bandit: { explorationQuota: 0.3, ucbC: 1 },
  fidelities: { screen: { exploreWallSec: 1, runsPerConfig: 1, gradeMaxRuns: 0, gradeBudgetMs: 1, seeds: [1] }, promote: { exploreWallSec: 1, runsPerConfig: 1, gradeMaxRuns: 0, gradeBudgetMs: 1, seeds: [1] } },
  budgets: { maxWallMinutesPerHypothesis: 1, maxLineageDepth: 1, stagnationWindow: 1, maxImplementTurns: 5, maxImplementMinutes: 20, maxBuildSeconds: 60, minFreeDiskGb: 25 },
  audit: { everyK: 5 }, proposal: { lenses: 1, maxPoolSize: 1 },
  evaluation: { spec: "x", configTemplate: "x", oracleDags: ["x"], rayonThreads: 1 },
  regression: { panelManifest: "x", vrNoFaultConfig: "x", throughputTolerance: 0.2, wallSecPerCase: 1 },
  perf: { benchConfig: "x", rounds: 2, warmupRounds: 0, minImprovement: 0.05, roundWallSec: 1 },
});
const rule: SeqRule = { ...policy.sequential, throughputFloor: 1 - policy.regression.throughputTolerance };

// Measured: four 90 s chunks of the baseline binary (seeds
// 1000-1003), 54,000 runs each at about 600 runs/s.
const BASE: PooledCounts = {
  runs: 216000, graded: 216000, chunks: 4, exposureSec: 361, depth4: 78925, depth5: 24131, depth6plus: 3533,
  depth7plus: 441, depth8plus: 20, violations: 0, h2Count: 89940, rpsChunks: [603, 601, 600, 589],
};
const T = rule.exploreBudgetSec;
const BASE_RPS = BASE.runs / BASE.exposureSec;
const P = {
  d4: BASE.depth4 / BASE.graded, d5: BASE.depth5 / BASE.graded, d6: BASE.depth6plus / BASE.graded,
  d7: BASE.depth7plus / BASE.graded, d8: BASE.depth8plus / BASE.graded, h2: BASE.h2Count / BASE.runs,
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

interface Expect { advanceMin?: number; advanceMax?: number; rejectMin?: number; inconclusiveMin?: number; chunksMeanMin?: number; oneChunkReject?: boolean }
interface Scenario { name: string; rps: number; e4: number; e5: number; e6: number; e7: number; eh2: number; kind: "superiority" | "noninferiority"; expect: Expect }
const scenarios: Scenario[] = [
  { name: "null (A/A)", rps: 1, e4: 0, e5: 0, e6: 0, e7: 0, eh2: 0, kind: "superiority", expect: { advanceMax: 3 } },
  { name: "+25% d6", rps: 1, e4: 0, e5: 0, e6: 0.25, e7: 0.25, eh2: 0, kind: "superiority", expect: { advanceMin: 90 } },
  { name: "+25% d6 at 0.7x throughput", rps: 0.7, e4: 0, e5: 0, e6: 0.25, e7: 0.25, eh2: 0, kind: "superiority", expect: { rejectMin: 90, advanceMax: 0 } },
  { name: "flat depth at 1.4x throughput", rps: 1.4, e4: 0, e5: 0, e6: 0, e7: 0, eh2: 0, kind: "superiority", expect: { advanceMin: 95 } },
  { name: "+12% d4, +15% d5", rps: 1, e4: 0.12, e5: 0.15, e6: 0.1, e7: 0.1, eh2: 0.03, kind: "superiority", expect: { advanceMin: 90 } },
  { name: "harmful (-40% d4 per run)", rps: 1, e4: -0.4, e5: -0.4, e6: -0.4, e7: -0.4, eh2: -0.1, kind: "superiority", expect: { rejectMin: 100, oneChunkReject: true } },
  { name: "d7-only +40%", rps: 1, e4: 0, e5: 0, e6: 0, e7: 0.4, eh2: 0, kind: "superiority", expect: { advanceMax: 3, chunksMeanMin: rule.maxChunks + 0.5, inconclusiveMin: 50 } },
  { name: "h2-only +10%", rps: 1, e4: 0, e5: 0, e6: 0, e7: 0, eh2: 0.1, kind: "superiority", expect: { advanceMax: 3 } },
  { name: "NI kind, no effect", rps: 1, e4: 0, e5: 0, e6: 0, e7: 0, eh2: 0, kind: "noninferiority", expect: { advanceMin: 90 } },
  { name: "NI kind, -30% d4", rps: 1, e4: -0.3, e5: -0.3, e6: -0.3, e7: -0.3, eh2: -0.05, kind: "noninferiority", expect: { rejectMin: 90 } },
];
const args = process.argv.slice(2);
const assertMode = args.includes("--assert");
const REPS = Number(args.find((a) => !a.startsWith("--")) ?? 150);

const failures: string[] = [];
for (const sc of scenarios) {
  const tally: Record<string, number> = { advance: 0, reject: 0, inconclusive: 0, escalate: 0 };
  let chunksTotal = 0;
  let chunksMin = 1e9;
  let chunksMax = 0;
  let oneChunkRejects = 0;
  for (let r = 0; r < REPS; r++) {
    const u = seededUniform(1234 + r * 7 + Math.round(sc.e6 * 1000) + Math.round(sc.rps * 100) + (sc.kind === "noninferiority" ? 99 : 0));
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
      cand.depth4 += binomial(runs, P.d4 * (1 + sc.e4), u);
      cand.depth5 += binomial(runs, P.d5 * (1 + sc.e5), u);
      cand.depth6plus += binomial(runs, P.d6 * (1 + sc.e6), u);
      cand.depth7plus += binomial(runs, P.d7 * (1 + sc.e7), u);
      cand.depth8plus += binomial(runs, P.d8 * (1 + sc.e7), u);
      cand.h2Count += binomial(runs, P.h2 * (1 + sc.eh2), u);
      verdict = decideSequential(cand, BASE, chunks, sc.kind, rule).verdict;
    }
    tally[verdict] = (tally[verdict] ?? 0) + 1;
    if (verdict === "reject" && chunks === 1) oneChunkRejects++;
    chunksTotal += chunks; chunksMin = Math.min(chunksMin, chunks); chunksMax = Math.max(chunksMax, chunks);
  }
  const pctOf = (k: string): number => (100 * (tally[k] ?? 0)) / REPS;
  const pct = (k: string): string => pctOf(k).toFixed(0).padStart(3) + "%";
  const meanChunks = chunksTotal / REPS;
  console.log(`${sc.name.padEnd(32)} advance ${pct("advance")}  reject ${pct("reject")}  inconclusive ${pct("inconclusive")}  chunks mean ${meanChunks.toFixed(1)} [${chunksMin}-${chunksMax}]`);
  const e = sc.expect;
  if (e.advanceMin !== undefined && pctOf("advance") < e.advanceMin) failures.push(`${sc.name}: advance ${pctOf("advance").toFixed(0)}% < ${e.advanceMin}%`);
  if (e.advanceMax !== undefined && pctOf("advance") > e.advanceMax) failures.push(`${sc.name}: advance ${pctOf("advance").toFixed(0)}% > ${e.advanceMax}%`);
  if (e.rejectMin !== undefined && pctOf("reject") < e.rejectMin) failures.push(`${sc.name}: reject ${pctOf("reject").toFixed(0)}% < ${e.rejectMin}%`);
  if (e.inconclusiveMin !== undefined && pctOf("inconclusive") < e.inconclusiveMin) failures.push(`${sc.name}: inconclusive ${pctOf("inconclusive").toFixed(0)}% < ${e.inconclusiveMin}%`);
  if (e.chunksMeanMin !== undefined && meanChunks < e.chunksMeanMin) failures.push(`${sc.name}: mean chunks ${meanChunks.toFixed(1)} < ${e.chunksMeanMin}`);
  if (e.oneChunkReject && oneChunkRejects < REPS * 0.95) failures.push(`${sc.name}: only ${oneChunkRejects}/${REPS} rejected at the first chunk`);
}
console.log(`policy: chunk=${T}s explore budget (about ${Math.round(T * BASE_RPS)} runs at baseline throughput) maxChunks=${rule.maxChunks} minChunks=${rule.minChunks} rejectP=${rule.rejectP} inconclusiveP=${rule.inconclusiveP} throughputFloor=${rule.throughputFloor} (minimum effect derived from baseline counts and the cap)`);
if (failures.length > 0) {
  console.log(`expectations not met:\n  ${failures.join("\n  ")}`);
  if (assertMode) process.exit(1);
} else if (assertMode) {
  console.log("all expectations met");
}
