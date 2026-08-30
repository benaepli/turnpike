// Policy = agent-proposable knobs (research/policy.json, Zod-validated).
// HARD_LIMITS below are mechanism: compiled in, never agent-editable, and
// every loaded policy is clamped into them. A policy file that tries to
// exceed a limit loads clamped, with a warning recorded by the caller.
import { readFileSync } from "node:fs";
import * as os from "node:os";
import { z } from "zod";

// Two cores are left for the grader, the writer and the operator's shell.
// The explorer shares a feedback map across the parallel run set, so this
// count is not a pure throughput dial: it changes which snapshot a run sees.
export function defaultRayonThreads(): number {
  return Math.max(1, os.availableParallelism() - 2);
}

export const Policy = z.object({
  models: z.object({
    propose: z.string(),
    judge: z.string(),
    implement: z.string(),
    reflect: z.string(),
    audit: z.string(),
  }),
  bandit: z.object({
    explorationQuota: z.number().min(0).max(1),
  }),
  budgets: z.object({
    maxLineageDepth: z.number().int().positive(),
    maxImplementTurns: z.number().int().positive(),
    maxImplementMinutes: z.number().positive(),
    maxBuildSeconds: z.number().int().positive(),
    minFreeDiskGb: z.number().positive(),
  }),
  audit: z.object({ everyK: z.number().int().positive() }),
  sequential: z.object({
    // A chunk is a fixed explore budget, not a run count. The run cap is
    // only there so a session cannot outgrow the grid's storage; it binds
    // above roughly four times the baseline's throughput.
    exploreBudgetSec: z.number().int().positive(),
    maxRunsPerConfig: z.number().int().positive(),
    maxChunks: z.number().int().positive(),
    minChunks: z.number().int().positive(),
    rejectP: z.number().min(0).max(0.5),
    inconclusiveP: z.number().min(0.5).max(1),
    niP: z.number().min(0.5).max(1),
    regressMargin: z.number().positive(),
    maxResumes: z.number().int().nonnegative(),
    resumeCooldown: z.number().int().nonnegative(),
    draws: z.number().int().min(200),
    wallSecPerChunk: z.number().int().positive(),
  }).default({
    exploreBudgetSec: 90, maxRunsPerConfig: 4000, maxChunks: 4, minChunks: 2, rejectP: 0.05,
    inconclusiveP: 0.9, niP: 0.95,
    regressMargin: 0.25, maxResumes: 2, resumeCooldown: 2, draws: 2000, wallSecPerChunk: 900,
  }),
  rejudge: z.object({ everyK: z.number().int().positive(), afterMerge: z.boolean() }).default({ everyK: 5, afterMerge: true }),
  proposal: z.object({ lenses: z.number().int().min(1).max(8), maxPoolSize: z.number().int().positive() }),
  evaluation: z.object({
    spec: z.string(),
    configTemplate: z.string(),
    oracleDags: z.array(z.string()).min(1),
    rayonThreads: z.number().int().positive().default(defaultRayonThreads),
    // Search strategy for the evaluation lane. The regression and perf lanes
    // stay on the standard explorer so they remain fixed guardrails.
    explorer: z.enum(["standard", "genetic", "aos", "continuous", "campaign"]).default("standard"),
  }),
  regression: z.object({
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

/// Every key path the schema declares, dotted from the root. Zod strips
/// anything else on parse, so a path absent from this set never reaches the
/// running policy. Nested, because a nested inert key is stripped just as
/// silently as a top-level one.
export const POLICY_KEY_PATHS: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  const walk = (node: unknown, prefix: string): void => {
    const props = (node as { properties?: Record<string, unknown> } | null)?.properties;
    if (!props) return;
    for (const [k, v] of Object.entries(props)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      walk(v, p);
    }
  };
  walk(z.toJSONSchema(Policy, { io: "input" }), "");
  return out;
})();

// Mechanism-level floors/ceilings. The loop can propose policy changes only
// inside this box.
export const HARD_LIMITS = {
  minExplorationQuota: 0.2,
  maxImplementTurns: 120,
  maxExploreWallSec: 3600,
  minExploreBudgetSec: 30,
  maxExploreBudgetSec: 600,
  maxBuildSeconds: 900,
  minFreeDiskGbFloor: 25,
  maxSequentialChunks: 12,
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
  c.budgets.maxImplementTurns = clampNum("budgets.maxImplementTurns", c.budgets.maxImplementTurns, 5, HARD_LIMITS.maxImplementTurns);
  c.budgets.maxImplementMinutes = clampNum("budgets.maxImplementMinutes", c.budgets.maxImplementMinutes, 2, 60);
  c.budgets.maxBuildSeconds = clampNum("budgets.maxBuildSeconds", c.budgets.maxBuildSeconds, 60, HARD_LIMITS.maxBuildSeconds);
  c.budgets.minFreeDiskGb = clampNum("budgets.minFreeDiskGb", c.budgets.minFreeDiskGb, HARD_LIMITS.minFreeDiskGbFloor, 1000);
  c.sequential.maxChunks = clampNum("sequential.maxChunks", c.sequential.maxChunks, 1, HARD_LIMITS.maxSequentialChunks);
  c.sequential.exploreBudgetSec = clampNum("sequential.exploreBudgetSec", c.sequential.exploreBudgetSec, HARD_LIMITS.minExploreBudgetSec, HARD_LIMITS.maxExploreBudgetSec);
  return { policy: c, clamps };
}

export function loadPolicy(path: string): { policy: Policy; clamps: string[] } {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return clampPolicy(Policy.parse(raw));
}
