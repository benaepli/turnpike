// Regression suite for the research loop: known-bug detection must keep
// working, known-clean specs must stay clean, and explorer throughput must
// not silently collapse.
import * as fs from "node:fs";
import * as path from "node:path";
import type { EvalContext } from "./evaluate.js";
import { ROOT, cleanupDir, explore, materializeConfig, porcupine, resolveRoot } from "./runners.js";
import { runBench } from "./bench.js";
import { RESEARCH_BRANCH, SUPER, showFile } from "./gitops.js";

export interface RegressionCase {
  name: string;
  passed: boolean;
  detail: string;
}

type Model = "kv" | "kv_rmw";

/** kv_rmw when the spec declares an RMW handler, kv otherwise. */
function modelForSpec(specPath: string): Model {
  const text = fs.readFileSync(specPath, "utf8");
  return text.includes("fn RMW") ? "kv_rmw" : "kv";
}

function caseDir(name: string): string {
  return path.join(ROOT, "tmp", "loop", `regr-${name}`);
}

/** Fresh, empty case directory (removes any leftover from a previous run). */
function prepDir(dir: string): void {
  if (fs.existsSync(dir)) cleanupDir(dir);
  fs.mkdirSync(dir, { recursive: true });
}

interface CaseRun {
  totalRuns: number;
  violations: number;
  unknown: number;
  exploreWallMs: number;
  exploreTimedOut: boolean;
  /** Non-null when porcupine produced no parseable JSON (e.g. exit 3 = zero runs). */
  porcupineFailure: string | null;
}

async function exploreAndCheck(
  ctx: EvalContext,
  outputDir: string,
  spec: string,
  configPath: string,
  model: Model,
): Promise<CaseRun> {
  const exploreRes = await explore({
    binary: ctx.binary,
    configPath,
    spec,
    outputDir,
    wallSec: ctx.policy.regression.wallSecPerCase,
    rayonThreads: ctx.policy.evaluation.rayonThreads,
  });
  // A timed-out explore still leaves a valid partial corpus; anything the
  // explorer wrote before the deadline is checked below.

  const porc = await porcupine({
    inputDir: outputDir,
    model,
    timeoutMsPerRun: 10_000,
    timeoutMs: 180_000,
  });

  if (porc.parsed === null) {
    return {
      totalRuns: 0,
      violations: 0,
      unknown: 0,
      exploreWallMs: exploreRes.wallMs,
      exploreTimedOut: exploreRes.timedOut,
      porcupineFailure: `porcupine produced no parseable JSON (exit ${String(porc.cmd.exitCode)}${porc.cmd.timedOut ? ", timed out" : ""}; exit 3 = zero runs)`,
    };
  }
  return {
    totalRuns: porc.parsed.total_runs,
    violations: porc.parsed.violations,
    unknown: porc.parsed.unknown,
    exploreWallMs: exploreRes.wallMs,
    exploreTimedOut: exploreRes.timedOut,
    porcupineFailure: null,
  };
}

/** Wrap one case: exceptions become a failed case; the case dir is always removed. */
async function runCase(name: string, body: () => Promise<RegressionCase>): Promise<RegressionCase> {
  try {
    return await body();
  } catch (err) {
    return { name, passed: false, detail: `exception: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try {
      cleanupDir(caseDir(name));
    } catch {
      // Cleanup failure must not mask the case result.
    }
  }
}

export async function runRegression(
  ctx: EvalContext,
  baselineRunsPerSec: number | null,
): Promise<{ passed: boolean; cases: RegressionCase[] }> {
  const reg = ctx.policy.regression;
  const cases: RegressionCase[] = [];

  // 1. The known-buggy Mencius spec must still produce a violation.
  cases.push(
    await runCase("mencius-bug-found", async () => {
      const name = "mencius-bug-found";
      const outputDir = caseDir(name);
      prepDir(outputDir);
      const model = modelForSpec(resolveRoot(reg.menciusBugSpec));
      const r = await exploreAndCheck(ctx, outputDir, resolveRoot(reg.menciusBugSpec), resolveRoot(reg.menciusBugConfig), model);
      if (r.porcupineFailure !== null) return { name, passed: false, detail: r.porcupineFailure };
      return {
        name,
        passed: r.violations > 0,
        detail: `model=${model} runs=${r.totalRuns} violations=${r.violations} unknown=${r.unknown} (expected violations > 0)`,
      };
    }),
  );

  // 2. The fixed Mencius spec must be clean (unknown runs allowed).
  cases.push(
    await runCase("mencius-fixed-clean", async () => {
      const name = "mencius-fixed-clean";
      const outputDir = caseDir(name);
      prepDir(outputDir);
      const model = modelForSpec(resolveRoot(reg.menciusFixedSpec));
      const r = await exploreAndCheck(ctx, outputDir, resolveRoot(reg.menciusFixedSpec), resolveRoot(reg.menciusBugConfig), model);
      if (r.porcupineFailure !== null) return { name, passed: false, detail: r.porcupineFailure };
      return {
        name,
        passed: r.violations === 0,
        detail: `model=${model} runs=${r.totalRuns} violations=${r.violations} unknown=${r.unknown} (expected violations == 0; unknown runs allowed)`,
      };
    }),
  );

  // 3. VR without faults must be clean.
  cases.push(
    await runCase("vr-nofault-clean", async () => {
      const name = "vr-nofault-clean";
      const outputDir = caseDir(name);
      prepDir(outputDir);
      const r = await exploreAndCheck(ctx, outputDir, resolveRoot(ctx.policy.evaluation.spec), resolveRoot(reg.vrNoFaultConfig), "kv");
      if (r.porcupineFailure !== null) return { name, passed: false, detail: r.porcupineFailure };
      return {
        name,
        passed: r.violations === 0,
        detail: `model=kv runs=${r.totalRuns} violations=${r.violations} unknown=${r.unknown} (expected violations == 0)`,
      };
    }),
  );

  // 4. Throughput: one screen-fidelity-style run of the general VR template.
  cases.push(
    await runCase("throughput", async () => {
      const name = "throughput";
      if (baselineRunsPerSec === null) {
        return { name, passed: true, detail: "no baseline yet" };
      }
      // Interleaved A/B against the preserved baseline binary on the
      // evaluation grid: both sides are measured in the same window, so
      // machine load affects them equally.
      const baselineBin = path.join(ROOT, "tmp", "loop", "spur-baseline");
      if (!fs.existsSync(baselineBin)) return { name, passed: true, detail: "no baseline binary snapshot; skipped" };
      const baseTemplate = path.join(ROOT, "tmp", "loop", "regr-throughput.base.template.json");
      fs.writeFileSync(baseTemplate, showFile(SUPER, RESEARCH_BRANCH, ctx.policy.evaluation.configTemplate));
      const b = await runBench(ctx.policy, ctx.binary, baselineBin, {
        templatePath: resolveRoot(ctx.policy.evaluation.configTemplate),
        baselineTemplatePath: baseTemplate,
        runsPerConfig: ctx.policy.fidelities.screen.runsPerConfig,
        rounds: 2,
      });
      if (b.baseMean <= 0) return { name, passed: false, detail: `bench failed: ${b.detail}` };
      const ratio = b.candMean / b.baseMean;
      const floor = 1 - ctx.policy.regression.throughputTolerance;
      return {
        name,
        passed: ratio >= floor,
        detail: `candidate ${b.candMean.toFixed(1)} rps vs baseline ${b.baseMean.toFixed(1)} rps in the same window (ratio ${ratio.toFixed(3)}, floor ${floor.toFixed(2)}); rounds cand=${JSON.stringify(b.candidateRps)} base=${JSON.stringify(b.baselineRps)}`,
      };
    }),
  );

  return { passed: cases.every((c) => c.passed), cases };
}
