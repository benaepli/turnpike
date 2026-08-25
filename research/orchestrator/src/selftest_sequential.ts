// Operating characteristics of the sequential stopping rule, simulated with
// the live decision code on synthetic chunk streams around the measured
// baseline rates. Run: npx tsx src/selftest_sequential.ts
import { decideSequential, type PooledCounts } from "./sequential.js";
import { seededUniform } from "./stats.js";
import { Policy } from "./policy.js";

const policy = Policy.parse({
  models: { propose: "x", judge: "x", implement: "x", diagnose: "x", reflect: "x", audit: "x" },
  bandit: { explorationQuota: 0.3, ucbC: 1 },
  fidelities: { screen: { exploreWallSec: 1, runsPerConfig: 1, gradeMaxRuns: 0, gradeBudgetMs: 1, seeds: [1] }, promote: { exploreWallSec: 1, runsPerConfig: 1, gradeMaxRuns: 0, gradeBudgetMs: 1, seeds: [1] }, confirm: { exploreWallSec: 1, runsPerConfig: 1, gradeMaxRuns: 0, gradeBudgetMs: 1, seeds: [1] } },
  budgets: { maxWallMinutesPerHypothesis: 1, maxLineageDepth: 1, stagnationWindow: 1, dailyWallHours: 1, maxImplementTurns: 5, maxBuildSeconds: 60, minFreeDiskGb: 25 },
  audit: { everyK: 5 }, proposal: { lenses: 1, maxPoolSize: 1 },
  evaluation: { spec: "x", configTemplate: "x", oracleDags: ["x"], rayonThreads: 1 },
  regression: { menciusBugSpec: "x", menciusBugConfig: "x", menciusFixedSpec: "x", vrNoFaultConfig: "x", throughputTolerance: 0.2, wallSecPerCase: 1 },
  perf: { benchConfig: "x", rounds: 2, warmupRounds: 0, minImprovement: 0.05, roundWallSec: 1 },
});
const p = { ...policy.sequential };
if (process.argv[4]) p.inconclusiveP = Number(process.argv[4]);
if (process.argv[5]) p.minChunks = Number(process.argv[5]);

// Measured baseline (confirm, 64.8k runs).
const BASE: PooledCounts = { runs: 64800, graded: 64800, depth4: 3223, depth5: 228, depth6plus: 0, violations: 0, h2Count: 26011 };
const P4 = BASE.depth4 / BASE.graded;
const P5 = BASE.depth5 / BASE.graded;
const PH2 = BASE.h2Count / BASE.runs;
const CHUNK = Number(process.argv[3] ?? 5400);

function binomial(n: number, prob: number, u: () => number): number {
  // Normal approximation with continuity correction is adequate at these n.
  const mean = n * prob;
  const sd = Math.sqrt(n * prob * (1 - prob));
  let z = 0;
  for (let i = 0; i < 12; i++) z += u();
  z -= 6;
  return Math.max(0, Math.round(mean + sd * z));
}

interface Scenario { name: string; e5: number; e4: number; eh2: number; kind: "superiority" | "noninferiority" }
const scenarios: Scenario[] = [
  { name: "null (no effect)", e5: 0, e4: 0, eh2: 0, kind: "superiority" },
  { name: "half MEI (+20% d5, +12% d4)", e5: 0.2, e4: 0.12, eh2: 0.03, kind: "superiority" },
  { name: "MEI (+40% d5, +25% d4)", e5: 0.4, e4: 0.25, eh2: 0.05, kind: "superiority" },
  { name: "2x MEI (+80% d5, +50% d4)", e5: 0.8, e4: 0.5, eh2: 0.1, kind: "superiority" },
  { name: "harmful (-40% d4)", e5: -0.4, e4: -0.4, eh2: -0.1, kind: "superiority" },
  { name: "d5-only +40% (d4 flat)", e5: 0.4, e4: 0, eh2: 0, kind: "superiority" },
  { name: "d5-only +20% (d4 flat)", e5: 0.2, e4: 0, eh2: 0, kind: "superiority" },
  { name: "d5-only +80% (d4 flat)", e5: 0.8, e4: 0, eh2: 0, kind: "superiority" },
  { name: "d4-only +25% (d5 flat)", e5: 0, e4: 0.25, eh2: 0, kind: "superiority" },
  { name: "h2-only +10%", e5: 0, e4: 0, eh2: 0.1, kind: "superiority" },
  { name: "NI kind, no effect", e5: 0, e4: 0, eh2: 0, kind: "noninferiority" },
  { name: "NI kind, -30% d4", e5: -0.3, e4: -0.3, eh2: -0.05, kind: "noninferiority" },
];
const REPS = Number(process.argv[2] ?? 150);

for (const sc of scenarios) {
  const tally: Record<string, number> = { advance: 0, reject: 0, inconclusive: 0 };
  let chunksTotal = 0;
  let chunksMin = 1e9;
  let chunksMax = 0;
  for (let r = 0; r < REPS; r++) {
    const u = seededUniform(1234 + r * 7 + sc.e5 * 1000 + (sc.kind === "noninferiority" ? 99 : 0));
    const cand: PooledCounts = { runs: 0, graded: 0, depth4: 0, depth5: 0, depth6plus: 0, violations: 0, h2Count: 0 };
    let chunks = 0;
    let verdict = "continue";
    while (verdict === "continue") {
      chunks++;
      cand.runs += CHUNK; cand.graded += CHUNK;
      cand.depth4 += binomial(CHUNK, P4 * (1 + sc.e4), u);
      cand.depth5 += binomial(CHUNK, P5 * (1 + sc.e5), u);
      cand.h2Count += binomial(CHUNK, PH2 * (1 + sc.eh2), u);
      verdict = decideSequential(cand, BASE, chunks, sc.kind, p).verdict;
    }
    tally[verdict] = (tally[verdict] ?? 0) + 1;
    chunksTotal += chunks; chunksMin = Math.min(chunksMin, chunks); chunksMax = Math.max(chunksMax, chunks);
  }
  const pct = (k: string): string => ((100 * (tally[k] ?? 0)) / REPS).toFixed(0).padStart(3) + "%";
  console.log(`${sc.name.padEnd(30)} advance ${pct("advance")}  reject ${pct("reject")}  inconclusive ${pct("inconclusive")}  chunks mean ${(chunksTotal / REPS).toFixed(1)} [${chunksMin}-${chunksMax}]`);
}
console.log(`policy: chunk=${CHUNK} runs maxChunks=${p.maxChunks} minChunks=${p.minChunks} advanceP=${p.advanceP} rejectP=${p.rejectP} inconclusiveP=${p.inconclusiveP} mei=${JSON.stringify(p.mei)}`);
