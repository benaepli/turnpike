// Policy = the measurement knobs shared by the graders (research/policy.json,
// Zod-validated). HARD_LIMITS below are compiled in, and every loaded policy
// is clamped into them. A policy file that tries to exceed a limit loads
// clamped, with a warning recorded by the caller.
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
  budgets: z.object({
    minFreeDiskGb: z.number().positive(),
  }),
  sequential: z.object({
    // A chunk is a fixed explore budget, not a run count. The run cap is
    // only there so a session cannot outgrow the grid's storage; it binds
    // above roughly four times the baseline's throughput.
    exploreBudgetSec: z.number().int().positive(),
    maxRunsPerConfig: z.number().int().positive(),
    maxChunks: z.number().int().positive(),
    minChunks: z.number().int().positive(),
    inconclusiveP: z.number().min(0.5).max(1),
    niP: z.number().min(0.5).max(1),
    regressMargin: z.number().positive(),
    maxResumes: z.number().int().nonnegative(),
    resumeCooldown: z.number().int().nonnegative(),
    draws: z.number().int().min(200),
    wallSecPerChunk: z.number().int().positive(),
  }).default({
    exploreBudgetSec: 90, maxRunsPerConfig: 4000, maxChunks: 4, minChunks: 2,
    inconclusiveP: 0.9, niP: 0.95,
    regressMargin: 0.25, maxResumes: 2, resumeCooldown: 2, draws: 2000, wallSecPerChunk: 900,
  }),
  evaluation: z.object({
    spec: z.string(),
    configTemplate: z.string(),
    oracleDags: z.array(z.string()).min(1),
    rayonThreads: z.number().int().positive().default(defaultRayonThreads),
    // Search strategy for the evaluation lane. The regression case stays on
    // the standard explorer so it remains a fixed guardrail.
    explorer: z.enum(["standard", "genetic", "aos", "continuous", "campaign"]).default("standard"),
  }),
  regression: z.object({
    vrNoFaultConfig: z.string(),
    throughputTolerance: z.number().positive(),
    wallSecPerCase: z.number().int().positive(),
  }),
});
export type Policy = z.infer<typeof Policy>;

// Floors and ceilings every loaded policy is clamped into.
export const HARD_LIMITS = {
  minExploreBudgetSec: 30,
  maxExploreBudgetSec: 600,
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
  c.budgets.minFreeDiskGb = clampNum("budgets.minFreeDiskGb", c.budgets.minFreeDiskGb, HARD_LIMITS.minFreeDiskGbFloor, 1000);
  c.sequential.maxChunks = clampNum("sequential.maxChunks", c.sequential.maxChunks, 1, HARD_LIMITS.maxSequentialChunks);
  c.sequential.exploreBudgetSec = clampNum("sequential.exploreBudgetSec", c.sequential.exploreBudgetSec, HARD_LIMITS.minExploreBudgetSec, HARD_LIMITS.maxExploreBudgetSec);
  return { policy: c, clamps };
}

export function loadPolicy(path: string): { policy: Policy; clamps: string[] } {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return clampPolicy(Policy.parse(raw));
}
