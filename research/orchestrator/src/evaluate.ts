// One evaluation = one (hypothesis, fidelity, seed) explorer run, checked
// with porcupine and graded with traceanalyzer, assembled into an Evaluation
// record (schemas.ts).
import * as fs from "node:fs";
import * as path from "node:path";
import type { Evaluation, FidelityName, LadderMetrics, PorcupineJson, TraceGradeJson, UtilStats } from "./schemas.js";
import type { Policy } from "./policy.js";
import { ROOT, cleanupDir, explore, freeDiskGb, grade, materializeConfig, porcupine, readSessionSibling, readUtilizationSibling, resolveRoot } from "./runners.js";

export interface EvalContext {
  policy: Policy;
  binary: string;
  graderVersion: string;
  spurCommit: string;
  superCommit: string;
  specOverride?: string;
  configTemplateOverride?: string;
}

const ZERO_METRICS: LadderMetrics = {
  runs: 0,
  runsPerSec: 0,
  unpairedFraction: 0,
  h1Rate: 0,
  h2Rate: 0,
  h2bRate: 0,
  h3Rate: 0,
  h4Rate: 0,
  gradedRuns: 0,
  meanPrefixDepth: 0,
  maxPrefixDepth: 0,
  depthAtLeast: [],
  violations: 0,
  unknown: 0,
  porcupineWallMs: 0,
  gradeWallMs: 0,
  exposureMs: 0,
};

// Tool wall times are the process times the runner measured, not the
// tools' self-reported figures, so the ledger reflects what an evaluation
// actually costs. The exposure is the explorer's own clock when it reported
// one: the time the runs had, which is what a per-second rate divides by.
function assembleMetrics(
  porc: PorcupineJson | null,
  gr: TraceGradeJson | null,
  exposureMs: number,
  porcupineWallMs: number,
  gradeWallMs: number,
): LadderMetrics {
  const runs = porc !== null ? Math.round(porc.total_runs) : 0;
  const g = gr?.grade ?? null;
  const hazards = g?.hazards ?? null;
  const dag = gr?.grade_dags?.[0] ?? null;
  return {
    runs,
    runsPerSec: exposureMs > 0 ? runs / (exposureMs / 1000) : 0,
    exposureMs: Math.round(exposureMs),
    unpairedFraction: g?.unpaired_fraction ?? 0,
    h1Rate: hazards?.h1_rate ?? 0,
    h2Rate: hazards?.h2_rate ?? 0,
    h2bRate: hazards?.h2b_rate ?? 0,
    h3Rate: hazards?.h3_rate ?? 0,
    h4Rate: hazards?.h4_rate ?? 0,
    gradedRuns: dag !== null ? Math.round(dag.graded_runs) : 0,
    meanPrefixDepth: dag?.mean_prefix_depth ?? 0,
    maxPrefixDepth: dag !== null ? Math.round(dag.max_prefix_depth) : 0,
    depthAtLeast: (dag?.depth_at_least ?? []).map((v) => Math.round(v)),
    violations: porc !== null ? Math.round(porc.violations) : 0,
    unknown: porc !== null ? Math.round(porc.unknown) : 0,
    porcupineWallMs: Math.round(porcupineWallMs),
    gradeWallMs: Math.round(gradeWallMs),
  };
}

export interface OneEvalOpts {
  runsPerConfig: number;
  exploreWallSec: number;
  gradeMaxRuns: number;
  gradeBudgetMs: number;
  // Explore budget handed to the explorer itself; absent, the grid alone
  // ends the session and exploreWallSec is only the kill deadline.
  exploreBudgetSec?: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

// The subset of the explorer's utilization dump an evaluation record keeps.
export function utilSubset(raw: Record<string, unknown> | null): UtilStats | null {
  if (raw === null) return null;
  const term = obj(obj(raw["termination"])["all"]);
  const eff = obj(raw["delivery_effects"]);
  const acted = (k: string): { deliveries: number; acted: number } => {
    const o = obj(eff[k]);
    return { deliveries: num(o["deliveries"]), acted: num(o["acted"]) };
  };
  const sa = obj(raw["steer_authority"]);
  return {
    termination: {
      runs: num(term["runs"]),
      planComplete: num(term["plan_complete"]),
      planCompleteWithPendingWork: num(term["plan_complete_with_pending_work"]),
      iterationsExhausted: num(term["iterations_exhausted"]),
      deadlock: num(term["deadlock"]),
      stepsUsedSum: num(term["steps_used_sum"]),
      stepBudgetSum: num(term["step_budget_sum"]),
    },
    deliveryEffects: {
      all: acted("all"), biased: acted("biased"), delayed: acted("delayed"),
      senderRestarted: acted("sender_restarted"), receiverRestarted: acted("receiver_restarted"),
    },
    steerAuthority: {
      steps: num(sa["steps"]),
      preferenceExpressed: num(sa["preference_expressed"]),
      preferenceHonored: num(sa["preference_honored"]),
      honored: num(sa["honored"]),
      blockedByTimerGate: num(sa["blocked_by_timer_gate"]),
    },
  };
}

// Run a single explore -> porcupine -> grade evaluation at one seed. A
// timed-out explore is not a failure by itself (the corpus written so far is
// graded); unparseable porcupine output or degenerate grading is. The output
// dir is always removed; the explore log is kept under research/logs on
// failure.
export async function runOneEvaluation(
  ctx: EvalContext,
  hypothesisId: string,
  fidelity: FidelityName,
  seed: number,
  opts: OneEvalOpts,
): Promise<Evaluation> {
  const spec = resolveRoot(ctx.specOverride ?? ctx.policy.evaluation.spec);
  const template = resolveRoot(ctx.configTemplateOverride ?? ctx.policy.evaluation.configTemplate);
  const outputDir = path.join(ROOT, "tmp", "loop", `eval-${hypothesisId}-${fidelity}-${seed}`);
  const base = {
    id: `${hypothesisId}-${fidelity}-${seed}-${Date.now()}`,
    hypothesisId,
    fidelity,
    graderVersion: ctx.graderVersion,
    spurCommit: ctx.spurCommit,
    superCommit: ctx.superCommit,
    configPath: template,
    spec,
    seed,
    startedAtIso: new Date().toISOString(),
  };
  try {
    if (fs.existsSync(outputDir)) cleanupDir(outputDir);
    fs.mkdirSync(outputDir, { recursive: true });
    if (freeDiskGb(ROOT) < ctx.policy.budgets.minFreeDiskGb) {
      return { ...base, metrics: ZERO_METRICS, exploreWallMs: 0, suspendedMs: 0, ok: false, error: "disk guard", session: null, utilStats: null, timingAnomaly: null };
    }
    const configPath = `${outputDir}.config.json`;
    const extra: Record<string, unknown> = {};
    if (opts.exploreBudgetSec !== undefined) extra["wall_budget_sec"] = opts.exploreBudgetSec;
    materializeConfig(template, configPath, { runsPerConfig: opts.runsPerConfig, sessionSeed: seed, extra });
    console.log(`[${new Date().toISOString()}] ${hypothesisId}/${fidelity} seed ${seed}: exploring (${opts.exploreBudgetSec !== undefined ? `budget ${opts.exploreBudgetSec}s, ` : ""}wall ${opts.exploreWallSec}s) -> ${outputDir}`);
    const exploreRes = await explore({
      binary: ctx.binary, configPath, spec, outputDir, explorer: ctx.policy.evaluation.explorer,
      wallSec: opts.exploreWallSec, rayonThreads: ctx.policy.evaluation.rayonThreads,
    });
    const session = readSessionSibling(outputDir);
    const utilStats = utilSubset(readUtilizationSibling(outputDir));
    const exposureMs = session !== null && session.wallMs > 0 ? session.wallMs : exploreRes.wallMs;
    const porc = await porcupine({ inputDir: outputDir, model: "kv", timeoutMsPerRun: 3_000, timeoutMs: 900_000 });
    const gr = await grade({
      inputDir: outputDir,
      dagConfigs: ctx.policy.evaluation.oracleDags.map(resolveRoot),
      maxRuns: opts.gradeMaxRuns,
      budgetMs: opts.gradeBudgetMs,
      timeoutMs: opts.gradeBudgetMs + 120_000,
    });
    const metrics = assembleMetrics(porc.parsed, gr.parsed, exposureMs, porc.cmd.wallMs, gr.cmd.wallMs);
    const gradeDegenerate = gr.parsed === null || (metrics.runs > 0 && metrics.gradedRuns === 0);
    const ok = porc.parsed !== null && !gradeDegenerate;
    const error = ok
      ? null
      : porc.parsed === null
        ? `porcupine produced no parseable JSON (exit ${String(porc.cmd.exitCode)}${porc.cmd.timedOut ? ", timed out" : ""})`
        : `degenerate grading: ${gr.parsed === null ? "grade output unparseable" : "zero graded runs"} (grade exit ${String(gr.cmd.exitCode)}${gr.cmd.timedOut ? ", timed out" : ""})`;
    console.log(`[${new Date().toISOString()}] ${hypothesisId}/${fidelity} seed ${seed}: done ok=${String(ok)} runs=${metrics.runs} viol=${metrics.violations} explore=${Math.round(exploreRes.wallMs / 1000)}s exposure=${Math.round(exposureMs / 1000)}s${session?.budgetHit ? " (budget hit)" : ""}${(exploreRes.suspendedMs ?? 0) > 0 ? ` (suspended ${Math.round((exploreRes.suspendedMs ?? 0) / 1000)}s)` : ""} porc=${Math.round(metrics.porcupineWallMs / 1000)}s grade=${Math.round(metrics.gradeWallMs / 1000)}s`);
    if (!ok) {
      try {
        fs.mkdirSync(path.join(ROOT, "research", "logs"), { recursive: true });
        fs.copyFileSync(`${outputDir}.log`, path.join(ROOT, "research", "logs", `eval-${hypothesisId}-${fidelity}-${seed}.log`));
      } catch { /* log may not exist */ }
    }
    return { ...base, metrics, exploreWallMs: exploreRes.wallMs, suspendedMs: exploreRes.suspendedMs ?? 0, ok, error, session, utilStats, timingAnomaly: null };
  } finally {
    fs.rmSync(`${outputDir}.config.json`, { force: true });
    fs.rmSync(`${outputDir}.log`, { force: true });
    fs.rmSync(`${outputDir}.session.json`, { force: true });
    fs.rmSync(`${outputDir}.utilization.json`, { force: true });
    try { cleanupDir(outputDir); } catch { /* cleanup failure must not mask the result */ }
  }
}

// Run the fixed-fidelity rung (every seed of the rung); used by the baseline
// and by the confirm stage.
export async function runEvaluation(
  ctx: EvalContext,
  hypothesisId: string,
  fidelity: Exclude<FidelityName, "sequential" | "confirm">,
): Promise<Evaluation[]> {
  const fid = ctx.policy.fidelities[fidelity];
  const evals: Evaluation[] = [];
  for (const seed of fid.seeds) {
    const e = await runOneEvaluation(ctx, hypothesisId, fidelity, seed, {
      runsPerConfig: fid.runsPerConfig, exploreWallSec: fid.exploreWallSec,
      gradeMaxRuns: fid.gradeMaxRuns, gradeBudgetMs: fid.gradeBudgetMs,
    });
    evals.push(e);
    if (e.error === "disk guard") break;
  }
  return evals;
}

export function aggregateDepthCounts(evals: Evaluation[], k: number): { succ: number; n: number } {
  let succ = 0;
  let n = 0;
  for (const e of evals) {
    succ += e.metrics.depthAtLeast[k - 1] ?? 0;
    n += e.metrics.gradedRuns;
  }
  return { succ, n };
}

/** Pooled linearizability violations over total runs. */
export function aggregateViolations(evals: Evaluation[]): { succ: number; n: number } {
  let succ = 0;
  let n = 0;
  for (const e of evals) {
    succ += e.metrics.violations;
    n += e.metrics.runs;
  }
  return { succ, n };
}
