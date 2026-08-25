// Policy = agent-proposable knobs (research/policy.json, Zod-validated).
// HARD_LIMITS below are mechanism: compiled in, never agent-editable, and
// every loaded policy is clamped into them. A policy file that tries to
// exceed a limit loads clamped, with a warning recorded by the caller.
import { readFileSync } from "node:fs";
import { z } from "zod";

const Fidelity = z.object({
  exploreWallSec: z.number().int().positive(),
  runsPerConfig: z.number().int().positive(),
  gradeMaxRuns: z.number().int().nonnegative(),
  gradeBudgetMs: z.number().int().nonnegative(),
  seeds: z.array(z.number().int()).min(1),
});

export const Policy = z.object({
  models: z.object({
    propose: z.string(),
    judge: z.string(),
    implement: z.string(),
    diagnose: z.string(),
    reflect: z.string(),
    audit: z.string(),
  }),
  bandit: z.object({
    explorationQuota: z.number().min(0).max(1),
    ucbC: z.number().positive(),
  }),
  fidelities: z.object({ screen: Fidelity, promote: Fidelity, confirm: Fidelity }),
  budgets: z.object({
    maxWallMinutesPerHypothesis: z.number().positive(),
    maxLineageDepth: z.number().int().positive(),
    stagnationWindow: z.number().int().positive(),
    dailyWallHours: z.number().positive(),
    maxImplementTurns: z.number().int().positive(),
    maxBuildSeconds: z.number().int().positive(),
    minFreeDiskGb: z.number().positive(),
  }),
  audit: z.object({ everyK: z.number().int().positive() }),
  sequential: z.object({
    chunkRunsPerConfig: z.number().int().positive(),
    maxChunks: z.number().int().positive(),
    minChunks: z.number().int().positive(),
    advanceP: z.number().min(0.5).max(1),
    rejectP: z.number().min(0).max(0.5),
    inconclusiveP: z.number().min(0.5).max(1),
    niP: z.number().min(0.5).max(1),
    mei: z.object({ depth4: z.number().positive(), depth5: z.number().positive(), h2: z.number().positive() }),
    regressMargin: z.number().positive(),
    h2SupportChunks: z.number().int().nonnegative(),
    maxResumes: z.number().int().nonnegative(),
    resumeCooldown: z.number().int().nonnegative(),
    draws: z.number().int().min(200),
    wallSecPerChunk: z.number().int().positive(),
  }).default({
    chunkRunsPerConfig: 100, maxChunks: 18, minChunks: 2, advanceP: 0.99, rejectP: 0.05,
    inconclusiveP: 0.9, niP: 0.95, mei: { depth4: 0.25, depth5: 0.4, h2: 0.05 },
    regressMargin: 0.25, h2SupportChunks: 6, maxResumes: 2, resumeCooldown: 2, draws: 2000, wallSecPerChunk: 240,
  }),
  rejudge: z.object({ everyK: z.number().int().positive(), afterMerge: z.boolean() }).default({ everyK: 5, afterMerge: true }),
  proposal: z.object({ lenses: z.number().int().min(1).max(8), maxPoolSize: z.number().int().positive() }),
  evaluation: z.object({
    spec: z.string(),
    configTemplate: z.string(),
    oracleDags: z.array(z.string()).min(1),
    rayonThreads: z.number().int().positive(),
  }),
  regression: z.object({
    menciusBugSpec: z.string(),
    menciusBugConfig: z.string(),
    menciusFixedSpec: z.string(),
    vrNoFaultConfig: z.string(),
    throughputTolerance: z.number().positive(),
    wallSecPerCase: z.number().int().positive(),
  }),
  perf: z.object({
    benchConfig: z.string(),
    rounds: z.number().int().min(2).max(10),
    warmupRounds: z.number().int().min(0).max(3),
    minImprovement: z.number().positive(),
    roundWallSec: z.number().int().positive(),
  }),
});
export type Policy = z.infer<typeof Policy>;

// Mechanism-level floors/ceilings. The loop can propose policy changes only
// inside this box.
export const HARD_LIMITS = {
  minExplorationQuota: 0.2,
  maxWallMinutesPerHypothesis: 180,
  maxDailyWallHours: 22,
  maxImplementTurns: 120,
  maxExploreWallSec: 3600,
  maxBuildSeconds: 900,
  minFreeDiskGbFloor: 25,
  maxSequentialChunks: 60,
} as const;

export function clampPolicy(p: Policy): { policy: Policy; clamps: string[] } {
  const clamps: string[] = [];
  const c = structuredClone(p);
  const clampNum = (path: string, v: number, lo: number, hi: number): number => {
    const out = Math.min(Math.max(v, lo), hi);
    if (out !== v) clamps.push(`${path}: ${v} -> ${out}`);
    return out;
  };
  c.bandit.explorationQuota = clampNum("bandit.explorationQuota", c.bandit.explorationQuota, HARD_LIMITS.minExplorationQuota, 1);
  c.budgets.maxWallMinutesPerHypothesis = clampNum("budgets.maxWallMinutesPerHypothesis", c.budgets.maxWallMinutesPerHypothesis, 1, HARD_LIMITS.maxWallMinutesPerHypothesis);
  c.budgets.dailyWallHours = clampNum("budgets.dailyWallHours", c.budgets.dailyWallHours, 0.5, HARD_LIMITS.maxDailyWallHours);
  c.budgets.maxImplementTurns = clampNum("budgets.maxImplementTurns", c.budgets.maxImplementTurns, 5, HARD_LIMITS.maxImplementTurns);
  c.budgets.maxBuildSeconds = clampNum("budgets.maxBuildSeconds", c.budgets.maxBuildSeconds, 60, HARD_LIMITS.maxBuildSeconds);
  c.budgets.minFreeDiskGb = clampNum("budgets.minFreeDiskGb", c.budgets.minFreeDiskGb, HARD_LIMITS.minFreeDiskGbFloor, 1000);
  c.sequential.maxChunks = clampNum("sequential.maxChunks", c.sequential.maxChunks, 1, HARD_LIMITS.maxSequentialChunks);
  for (const f of ["screen", "promote", "confirm"] as const) {
    c.fidelities[f].exploreWallSec = clampNum(`fidelities.${f}.exploreWallSec`, c.fidelities[f].exploreWallSec, 10, HARD_LIMITS.maxExploreWallSec);
  }
  return { policy: c, clamps };
}

export function loadPolicy(path: string): { policy: Policy; clamps: string[] } {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return clampPolicy(Policy.parse(raw));
}
