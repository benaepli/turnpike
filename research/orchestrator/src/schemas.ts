// Typed contracts for the research loop. Every record that crosses a process
// or agent boundary is validated against these schemas - agents produce JSON,
// the harness refuses anything that does not parse.
import { z } from "zod";

export const HypothesisKind = z.enum(["add", "ablate", "meta", "enabling", "grader", "perf"]);
export type HypothesisKind = z.infer<typeof HypothesisKind>;

export const HypothesisStatus = z.enum([
  "proposed",    // in the pool, never attempted
  "selected",    // picked by the bandit this iteration
  "implementing",
  "screened",    // implemented + screen fidelity done
  "promoted",    // passed screen, promote fidelity done
  "merged",      // auto-merged into research/vr-loop
  "needs_human", // PR open, waiting for human review
  "closed",      // evaluated, did not clear its gate
  "blocked",     // implementation failed (build errors etc.)
  "parked",      // deprioritized (stagnant lineage / salvage lost the race)
]);
export type HypothesisStatus = z.infer<typeof HypothesisStatus>;

export const Hypothesis = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,60}$/),
  parent: z.string().nullable().default(null),
  kind: HypothesisKind,
  title: z.string().min(8).max(120),
  description: z.string().min(40),
  category: z.enum(["scheduler", "config", "feedback", "tooling", "policy", "grader", "performance"]),
  buildsOn: z.array(z.string()).default([]),
  expectedGain: z.number().min(0).max(10),
  expectedCost: z.number().min(0.1).max(10),
  rationale: z.string().min(20),
  generalityArgument: z.string().min(20),
  status: HypothesisStatus.default("proposed"),
  branch: z.string().nullable().default(null),
  prUrls: z.array(z.string()).default([]),
  createdAtIso: z.string(),
  notes: z.string().default(""),
});
export type Hypothesis = z.infer<typeof Hypothesis>;

export const ProposedHypotheses = z.object({ hypotheses: z.array(Hypothesis.omit({ status: true, branch: true, prUrls: true })) });

export const FidelityName = z.enum(["screen", "promote", "confirm"]);
export type FidelityName = z.infer<typeof FidelityName>;

// One rung snapshot of the metric ladder, assembled from traceanalyzer -grade,
// porcupine_batch JSON, and harness wall clocks.
export const LadderMetrics = z.object({
  runs: z.number().int(),
  runsPerSec: z.number(),
  unpairedFraction: z.number(),
  h1Rate: z.number(),
  h2Rate: z.number(),
  h2bRate: z.number(),
  h3Rate: z.number(),
  gradedRuns: z.number().int(),
  meanPrefixDepth: z.number(),
  maxPrefixDepth: z.number().int(),
  depthAtLeast: z.array(z.number().int()), // [i] = graded runs with prefix_depth >= i+1
  violations: z.number().int(),
  unknown: z.number().int(),
  porcupineWallMs: z.number().int(),
  gradeWallMs: z.number().int(),
});
export type LadderMetrics = z.infer<typeof LadderMetrics>;

export const Evaluation = z.object({
  id: z.string(),
  hypothesisId: z.string(),
  fidelity: FidelityName,
  graderVersion: z.string(),
  spurCommit: z.string(),
  superCommit: z.string(),
  configPath: z.string(),
  spec: z.string(),
  seed: z.number().int(),
  metrics: LadderMetrics,
  exploreWallMs: z.number().int(),
  suspendedMs: z.number().int().default(0),
  startedAtIso: z.string(),
  ok: z.boolean(),
  error: z.string().nullable().default(null),
});
export type Evaluation = z.infer<typeof Evaluation>;

export const GateDecision = z.object({
  hypothesisId: z.string(),
  verdict: z.enum(["auto_merge", "needs_human", "closed", "blocked"]),
  reasons: z.array(z.string()),
  objectiveDeltas: z.record(z.string(), z.number()).default({}),
  regressionPassed: z.boolean().nullable().default(null),
  lintPassed: z.boolean().nullable().default(null),
});
export type GateDecision = z.infer<typeof GateDecision>;

export const Reflection = z.object({
  hypothesisId: z.string(),
  whatWeLearned: z.string().min(20),
  suggestedChildren: z.array(Hypothesis.omit({ status: true, branch: true, prUrls: true })).default([]),
  suggestedDeprioritize: z.array(z.string()).default([]),
});
export type Reflection = z.infer<typeof Reflection>;

export const AuditReport = z.object({
  atIteration: z.number().int(),
  timeBreakdown: z.record(z.string(), z.number()).default({}),
  budgetConcentration: z.string(),
  statisticalPowerNotes: z.string(),
  goodhartSignals: z.array(z.string()).default([]),
  utilizationFindings: z.array(z.object({
    mechanism: z.string(),
    classification: z.enum(["broken", "unexercised", "unrewarding", "scaffolding", "healthy"]),
    evidence: z.string(),
  })).default([]),
  recommendedPolicyChanges: z.array(z.string()).default([]),
});
export type AuditReport = z.infer<typeof AuditReport>;

// A single journal line (journal.jsonl). The journal is append-only.
export const JournalEntry = z.object({
  atIso: z.string(),
  iteration: z.number().int(),
  event: z.string(),
  data: z.unknown(),
});
export type JournalEntry = z.infer<typeof JournalEntry>;

// grade JSON produced by `traceanalyzer -grade -format json` (subset we consume)
export const TraceGradeJson = z.object({
  grade: z.object({
    total_runs: z.number(),
    invocations: z.number(),
    responses: z.number(),
    unpaired_fraction: z.number(),
    hazards: z.object({
      h1_rate: z.number(),
      h2_rate: z.number(),
      h2b_rate: z.number(),
      h3_rate: z.number(),
    }).nullable().optional(),
    wall_ms: z.number(),
  }).nullable().optional(),
  grade_dags: z.array(z.object({
    config_path: z.string(),
    graded_runs: z.number(),
    available_runs: z.number(),
    sampled: z.boolean(),
    budget_exhausted: z.boolean(),
    mean_prefix_depth: z.number(),
    max_prefix_depth: z.number(),
    p95_prefix_depth: z.number(),
    depth_at_least: z.array(z.number()).nullable().optional(),
  })).nullable().optional(),
});
export type TraceGradeJson = z.infer<typeof TraceGradeJson>;

// porcupine_batch JSON
export const PorcupineJson = z.object({
  total_runs: z.number(),
  ok: z.number(),
  violations: z.number(),
  unknown: z.number(),
  skipped_ops: z.number(),
  violating_run_ids: z.array(z.number()),
  wall_ms: z.number(),
});
export type PorcupineJson = z.infer<typeof PorcupineJson>;
