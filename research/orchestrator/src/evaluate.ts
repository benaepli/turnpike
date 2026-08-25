// One evaluation = one (hypothesis, fidelity, seed) explorer run, checked
// with porcupine and graded with traceanalyzer, assembled into an Evaluation
// record (schemas.ts).
import * as fs from "node:fs";
import * as path from "node:path";
import type { Evaluation, FidelityName, LadderMetrics, PorcupineJson, TraceGradeJson } from "./schemas.js";
import type { Policy } from "./policy.js";
import { ROOT, cleanupDir, explore, freeDiskGb, grade, materializeConfig, porcupine, resolveRoot } from "./runners.js";

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
  gradedRuns: 0,
  meanPrefixDepth: 0,
  maxPrefixDepth: 0,
  depthAtLeast: [],
  violations: 0,
  unknown: 0,
  porcupineWallMs: 0,
  gradeWallMs: 0,
};

// Tool wall times are the process times the runner measured, not the
// tools' self-reported figures, so the ledger reflects what an evaluation
// actually costs.
function assembleMetrics(
  porc: PorcupineJson | null,
  gr: TraceGradeJson | null,
  exploreWallMs: number,
  porcupineWallMs: number,
  gradeWallMs: number,
): LadderMetrics {
  const runs = porc !== null ? Math.round(porc.total_runs) : 0;
  const g = gr?.grade ?? null;
  const hazards = g?.hazards ?? null;
  const dag = gr?.grade_dags?.[0] ?? null;
  return {
    runs,
    runsPerSec: exploreWallMs > 0 ? runs / (exploreWallMs / 1000) : 0,
    unpairedFraction: g?.unpaired_fraction ?? 0,
    h1Rate: hazards?.h1_rate ?? 0,
    h2Rate: hazards?.h2_rate ?? 0,
    h2bRate: hazards?.h2b_rate ?? 0,
    h3Rate: hazards?.h3_rate ?? 0,
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
      return { ...base, metrics: ZERO_METRICS, exploreWallMs: 0, suspendedMs: 0, ok: false, error: "disk guard" };
    }
    const configPath = `${outputDir}.config.json`;
    materializeConfig(template, configPath, { runsPerConfig: opts.runsPerConfig, sessionSeed: seed });
    console.log(`[${new Date().toISOString()}] ${hypothesisId}/${fidelity} seed ${seed}: exploring (wall ${opts.exploreWallSec}s) -> ${outputDir}`);
    const exploreRes = await explore({
      binary: ctx.binary, configPath, spec, outputDir,
      wallSec: opts.exploreWallSec, rayonThreads: ctx.policy.evaluation.rayonThreads,
    });
    const porc = await porcupine({ inputDir: outputDir, model: "kv", timeoutMsPerRun: 3_000, timeoutMs: 900_000 });
    const gr = await grade({
      inputDir: outputDir,
      dagConfigs: ctx.policy.evaluation.oracleDags.map(resolveRoot),
      maxRuns: opts.gradeMaxRuns,
      budgetMs: opts.gradeBudgetMs,
      timeoutMs: opts.gradeBudgetMs + 120_000,
    });
    const metrics = assembleMetrics(porc.parsed, gr.parsed, exploreRes.wallMs, porc.cmd.wallMs, gr.cmd.wallMs);
    const gradeDegenerate = gr.parsed === null || (metrics.runs > 0 && metrics.gradedRuns === 0);
    const ok = porc.parsed !== null && !gradeDegenerate;
    const error = ok
      ? null
      : porc.parsed === null
        ? `porcupine produced no parseable JSON (exit ${String(porc.cmd.exitCode)}${porc.cmd.timedOut ? ", timed out" : ""})`
        : `degenerate grading: ${gr.parsed === null ? "grade output unparseable" : "zero graded runs"} (grade exit ${String(gr.cmd.exitCode)}${gr.cmd.timedOut ? ", timed out" : ""})`;
    console.log(`[${new Date().toISOString()}] ${hypothesisId}/${fidelity} seed ${seed}: done ok=${String(ok)} runs=${metrics.runs} viol=${metrics.violations} explore=${Math.round(exploreRes.wallMs / 1000)}s${(exploreRes.suspendedMs ?? 0) > 0 ? ` (suspended ${Math.round((exploreRes.suspendedMs ?? 0) / 1000)}s)` : ""} porc=${Math.round(metrics.porcupineWallMs / 1000)}s grade=${Math.round(metrics.gradeWallMs / 1000)}s`);
    if (!ok) {
      try {
        fs.mkdirSync(path.join(ROOT, "research", "logs"), { recursive: true });
        fs.copyFileSync(`${outputDir}.log`, path.join(ROOT, "research", "logs", `eval-${hypothesisId}-${fidelity}-${seed}.log`));
      } catch { /* log may not exist */ }
    }
    return { ...base, metrics, exploreWallMs: exploreRes.wallMs, suspendedMs: exploreRes.suspendedMs ?? 0, ok, error };
  } finally {
    fs.rmSync(`${outputDir}.config.json`, { force: true });
    fs.rmSync(`${outputDir}.log`, { force: true });
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
