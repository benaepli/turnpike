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

function assembleMetrics(
  porc: PorcupineJson | null,
  gr: TraceGradeJson | null,
  exploreWallMs: number,
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
    porcupineWallMs: porc !== null ? Math.round(porc.wall_ms) : 0,
    gradeWallMs: g !== null ? Math.round(g.wall_ms) : 0,
  };
}

/**
 * Run one evaluation per seed of the given fidelity rung. A timed-out explore
 * is NOT a failure: the explorer writes parquet incrementally, so the output
 * dir is a valid partial corpus. If the disk guard trips, a single ok=false
 * "disk guard" record is appended and the remaining seeds are skipped.
 * Every seed's output dir is removed in a finally.
 */
export async function runEvaluation(
  ctx: EvalContext,
  hypothesisId: string,
  fidelity: FidelityName,
): Promise<Evaluation[]> {
  const fid = ctx.policy.fidelities[fidelity];
  const spec = resolveRoot(ctx.specOverride ?? ctx.policy.evaluation.spec);
  const template = resolveRoot(ctx.configTemplateOverride ?? ctx.policy.evaluation.configTemplate);
  const evals: Evaluation[] = [];

  for (const seed of fid.seeds) {
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
        evals.push({ ...base, metrics: ZERO_METRICS, exploreWallMs: 0, ok: false, error: "disk guard" });
        return evals;
      }

      // The config must live OUTSIDE outputDir: `spur explore -y` clears the
      // output dir, which would delete the config before/while it is read.
      const configPath = `${outputDir}.config.json`;
      materializeConfig(template, configPath, { runsPerConfig: fid.runsPerConfig, sessionSeed: seed });

      console.log(`[${new Date().toISOString()}] ${hypothesisId}/${fidelity} seed ${seed}: exploring (wall ${fid.exploreWallSec}s) -> ${outputDir}`);
      const exploreRes = await explore({
        binary: ctx.binary,
        configPath,
        spec,
        outputDir,
        wallSec: fid.exploreWallSec,
        rayonThreads: ctx.policy.evaluation.rayonThreads,
      });

      const porc = await porcupine({
        inputDir: outputDir,
        model: "kv",
        timeoutMsPerRun: 3_000,
        timeoutMs: 900_000,
      });

      const gr = await grade({
        inputDir: outputDir,
        dagConfigs: ctx.policy.evaluation.oracleDags.map(resolveRoot),
        maxRuns: fid.gradeMaxRuns,
        budgetMs: fid.gradeBudgetMs,
        timeoutMs: fid.gradeBudgetMs + 120_000,
      });

      const metrics = assembleMetrics(porc.parsed, gr.parsed, exploreRes.wallMs);
      const ok = porc.parsed !== null;
      const error = ok
        ? null
        : `porcupine produced no parseable JSON (exit ${String(porc.cmd.exitCode)}${porc.cmd.timedOut ? ", timed out" : ""})`;
      evals.push({ ...base, metrics, exploreWallMs: exploreRes.wallMs, ok, error });
      console.log(`[${new Date().toISOString()}] ${hypothesisId}/${fidelity} seed ${seed}: done ok=${String(ok)} runs=${metrics.runs} viol=${metrics.violations} explore=${Math.round(exploreRes.wallMs / 1000)}s porc=${Math.round(metrics.porcupineWallMs / 1000)}s grade=${Math.round(metrics.gradeWallMs / 1000)}s`);
      if (!ok) {
        try {
          fs.mkdirSync(path.join(ROOT, "research", "logs"), { recursive: true });
          fs.copyFileSync(`${outputDir}.log`, path.join(ROOT, "research", "logs", `eval-${hypothesisId}-${fidelity}-${seed}.log`));
        } catch { /* log may not exist */ }
      }
    } finally {
      fs.rmSync(`${outputDir}.config.json`, { force: true });
      fs.rmSync(`${outputDir}.log`, { force: true });
      try {
        cleanupDir(outputDir);
      } catch {
        // Cleanup failure must not mask the evaluation result.
      }
    }
  }

  return evals;
}

/**
 * Pooled depth counts across evaluations: succ = graded runs whose prefix
 * depth is >= k (depthAtLeast[k-1]), n = graded runs.
 */
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
