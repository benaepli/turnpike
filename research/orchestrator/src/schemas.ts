// Typed contracts for the research loop. Every record that crosses a process
// or agent boundary is validated against these schemas - agents produce JSON,
// the harness refuses anything that does not parse.
import { z } from "zod";

// `arm` edits only the campaign block of the evaluation template: which
// generic strategies run, with which overlays, under which allocation.
export const HypothesisKind = z.enum(["add", "ablate", "meta", "enabling", "grader", "perf", "arm"]);
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
  "inconclusive", // positive but underpowered; branch kept, may be resumed
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
  // Dotted path into utilization.json that the hypothesis claims its
  // mechanism increments. The panel refuses to judge a member where the
  // counter is zero: no occasions is not a negative result.
  firingCounter: z.string().nullable().default(null),
  notes: z.string().default(""),
});
export type Hypothesis = z.infer<typeof Hypothesis>;

export const ProposedHypotheses = z.object({ hypotheses: z.array(Hypothesis.omit({ status: true, branch: true, prUrls: true })) });

export const FidelityName = z.enum(["screen", "promote", "confirm", "sequential"]);
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
  // Timer fired on a node with a message to it in flight; zero when the
  // corpus records no timer firings.
  h4Rate: z.number().default(0),
  gradedRuns: z.number().int(),
  meanPrefixDepth: z.number(),
  maxPrefixDepth: z.number().int(),
  depthAtLeast: z.array(z.number().int()), // [i] = graded runs with prefix_depth >= i+1
  violations: z.number().int(),
  unknown: z.number().int(),
  porcupineWallMs: z.number().int(),
  gradeWallMs: z.number().int(),
  // Active time the runs actually had, on the explorer's own monotonic clock
  // when it reported one (a suspend does not advance it); the exposure every
  // per-second rate divides by.
  exposureMs: z.number().int().default(0),
  // Per-arm accounting when the session was a campaign; the ladder above is
  // the union of the arms.
  campaign: z.lazy(() => CampaignMetrics).nullable().default(null),
});
export type LadderMetrics = z.infer<typeof LadderMetrics>;

export const CampaignArmMetrics = z.object({
  index: z.number().int(),
  id: z.string(),
  mode: z.string(),
  overlay: z.record(z.string(), z.unknown()).default({}),
  slices: z.number().int(),
  runs: z.number().int(),
  wallMs: z.number().int(),
  rewardRate: z.number(),
  epochs: z.number().int().default(0),
  droppedAtRound: z.number().int().nullable().default(null),
  // Graded per arm by joining the run depths and the checker's verdicts to
  // the runs table; the same shape as the session's depthAtLeast.
  depthAtLeast: z.array(z.number().int()),
  gradedRuns: z.number().int(),
  violations: z.number().int(),
  // Active time from the session's start to the end of the arm's first
  // violating run; null when the arm did not violate.
  firstViolationMs: z.number().int().nullable().default(null),
});
export type CampaignArmMetrics = z.infer<typeof CampaignArmMetrics>;

export const CampaignMetrics = z.object({
  wallSec: z.number(),
  allocation: z.string(),
  reward: z.string(),
  runsTotal: z.number().int(),
  sliceUnitSec: z.number(),
  cancelled: z.boolean().default(false),
  arms: z.array(CampaignArmMetrics),
});
export type CampaignMetrics = z.infer<typeof CampaignMetrics>;

// campaign.json as the explorer writes it (the fields the harness reads).
export const CampaignJson = z.object({
  wall_budget_sec: z.number(),
  elapsed_sec: z.number(),
  session_seed: z.number(),
  allocation: z.object({ kind: z.string() }).passthrough(),
  reward: z.object({ kind: z.string() }),
  batch_size: z.number(),
  slice_unit_sec: z.number(),
  runs_total: z.number(),
  cancelled: z.boolean(),
  arms: z.array(z.object({
    index: z.number(),
    id: z.string(),
    mode: z.string(),
    overlay: z.record(z.string(), z.unknown()).default({}),
    slices: z.number(),
    runs: z.number(),
    wall_ms: z.number(),
    reward: z.number(),
    reward_rate: z.number(),
    epochs: z.number().default(0),
    dropped_at_round: z.number().nullable().default(null),
    counters: z.unknown().optional(),
  })),
  history: z.array(z.object({
    slice: z.number(), arm: z.number(), round: z.number(), started_ms: z.number(), wall_ms: z.number(), runs: z.number(), reward: z.number(),
  })).default([]),
});
export type CampaignJson = z.infer<typeof CampaignJson>;

// One row of the explorer's runs table, as `traceanalyzer -runs` prints it.
export const RunRow = z.object({
  run_id: z.number(),
  arm: z.string(),
  arm_index: z.number(),
  config_index: z.number(),
  steps_used: z.number(),
  wall_us: z.number(),
  end_reason: z.string(),
  session_offset_ms: z.number(),
});
export type RunRow = z.infer<typeof RunRow>;

// The explorer's own account of a session (session.json).
export const SessionSummary = z.object({
  wallMs: z.number().int(),
  runsCompleted: z.number().int(),
  runsFailed: z.number().int().default(0),
  runsSkipped: z.number().int().default(0),
  budgetSec: z.number(),
  budgetHit: z.boolean(),
  writerFlushMs: z.number().int().default(0),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

// The subset of utilization.json an evaluation keeps: enough to tell whether
// runs finish, whether deliveries act, and whether the steer was let through.
const Acted = z.object({ deliveries: z.number(), acted: z.number() });
export const UtilStats = z.object({
  termination: z.object({
    runs: z.number(),
    planComplete: z.number(),
    planCompleteWithPendingWork: z.number(),
    iterationsExhausted: z.number(),
    deadlock: z.number(),
    stepsUsedSum: z.number(),
    stepBudgetSum: z.number(),
  }),
  deliveryEffects: z.object({
    all: Acted, biased: Acted, delayed: Acted, senderRestarted: Acted, receiverRestarted: Acted,
  }),
  steerAuthority: z.object({
    steps: z.number(),
    preferenceExpressed: z.number(),
    preferenceHonored: z.number(),
    honored: z.number(),
    blockedByTimerGate: z.number(),
  }),
});
export type UtilStats = z.infer<typeof UtilStats>;

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
  // Comparability epoch (protocol/gate regime) the result was produced in.
  epoch: z.number().int().optional(),
  session: SessionSummary.nullable().default(null),
  utilStats: UtilStats.nullable().default(null),
  // Set when the chunk was excluded from pooling for its timing rather than
  // its content: a missing session summary, or a throughput far below the
  // baseline's.
  timingAnomaly: z.string().nullable().default(null),
});
export type Evaluation = z.infer<typeof Evaluation>;

export const GateDecision = z.object({
  hypothesisId: z.string(),
  verdict: z.enum(["auto_merge", "needs_human", "closed", "blocked"]),
  reasons: z.array(z.string()),
  objectiveDeltas: z.record(z.string(), z.number()).default({}),
  regressionPassed: z.boolean().nullable().default(null),
  lintPassed: z.boolean().nullable().default(null),
  // Comparability epoch the verdict was made in.
  epoch: z.number().int().optional(),
  // True when the outcome is not evidence about the hypothesis (build/grader
  // failure, stop, wall timeout, stale branch): excluded from calibration.
  harnessFailure: z.boolean().optional(),
});
export type GateDecision = z.infer<typeof GateDecision>;

export const Reflection = z.object({
  hypothesisId: z.string(),
  whatWeLearned: z.string().min(20),
  suggestedChildren: z.array(Hypothesis.omit({ status: true, branch: true, prUrls: true })).default([]),
  suggestedDeprioritize: z.array(z.string()).default([]),
});
export type Reflection = z.infer<typeof Reflection>;

export const RejudgeResult = z.object({
  updates: z.array(z.object({
    id: z.string(),
    expectedGain: z.number().min(0).max(10),
    expectedCost: z.number().min(0.1).max(10),
    action: z.enum(["keep", "park"]),
    reason: z.string().min(5),
  })),
});
export type RejudgeResult = z.infer<typeof RejudgeResult>;

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

// Pooled state of a sequential evaluation, persisted so an inconclusive
// hypothesis can resume sampling later.
export const SeqState = z.object({
  hypothesisId: z.string(),
  chunks: z.number().int(),
  runs: z.number().int(),
  graded: z.number().int(),
  depth4: z.number().int(),
  depth5: z.number().int(),
  depth6plus: z.number().int(),
  depth7plus: z.number().int().default(0),
  depth8plus: z.number().int().default(0),
  violations: z.number().int(),
  h2Count: z.number().int(),
  // Explore seconds the pooled counts had, and each chunk's throughput.
  exposureSec: z.number().default(0),
  rpsChunks: z.array(z.number()).default([]),
  // Chunks excluded for their timing, and whether a slow candidate has been
  // confirmed slow (after which its chunks count and the floor decides).
  anomalies: z.number().int().default(0),
  slowConfirmed: z.boolean().default(false),
  resumes: z.number().int(),
  nextSeed: z.number().int(),
  posteriors: z.record(z.string(), z.number()).default({}),
  lastVerdict: z.string().default(""),
  lastIteration: z.number().int().default(0),
  // Identity of the baseline the counts were compared against; counts from
  // a superseded baseline are discarded on resume.
  baselineKey: z.string().default(""),
});
export type SeqState = z.infer<typeof SeqState>;

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
      h4_rate: z.number().optional(),
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
    run_depths: z.array(z.tuple([z.number(), z.number()])).nullable().optional(),
  })).nullable().optional(),
  runs_meta: z.object({
    present: z.boolean(),
    runs: z.number(),
    end_reasons: z.record(z.string(), z.number()).default({}),
    arms: z.record(z.string(), z.number()).default({}),
    mean_steps: z.number(),
    p50_wall_us: z.number(),
    last_offset_ms: z.number().default(0),
  }).nullable().optional(),
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
  first_violation_ordinal: z.number().optional(),
  first_violation_run_id: z.number().nullable().optional(),
  violation_signatures: z.array(z.object({ run_id: z.number(), ordinal: z.number(), signature: z.string() })).optional(),
});
export type PorcupineJson = z.infer<typeof PorcupineJson>;
