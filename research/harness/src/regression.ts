// Regression suite: a known-clean spec must stay clean under the candidate
// binary. Throughput is judged by the graders against their own paired
// baselines, not here.
import * as fs from "node:fs";
import * as path from "node:path";
import type { EvalContext } from "./evaluate.js";
import { ROOT, cleanupDir, explore, exploreFailure, porcupine, resolveRoot } from "./runners.js";

export interface RegressionCase {
  name: string;
  passed: boolean;
  detail: string;
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
): Promise<CaseRun> {
  const exploreRes = await explore({
    binary: ctx.binary,
    configPath,
    spec,
    outputDir,
    wallSec: ctx.policy.regression.wallSecPerCase,
    rayonThreads: ctx.policy.evaluation.rayonThreads,
  });
  const executionError = exploreFailure(exploreRes);
  if (executionError !== null) throw new Error(executionError);
  // A timed-out explore still leaves a valid partial corpus; anything the
  // explorer wrote before the deadline is checked below.

  const porc = await porcupine({
    inputDir: outputDir,
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

export async function runRegression(ctx: EvalContext): Promise<{ passed: boolean; cases: RegressionCase[] }> {
  const reg = ctx.policy.regression;
  const cases: RegressionCase[] = [];

  // VR without faults must be clean.
  cases.push(
    await runCase("vr-nofault-clean", async () => {
      const name = "vr-nofault-clean";
      const outputDir = caseDir(name);
      prepDir(outputDir);
      const r = await exploreAndCheck(ctx, outputDir, resolveRoot(ctx.policy.evaluation.spec), resolveRoot(reg.vrNoFaultConfig));
      if (r.porcupineFailure !== null) return { name, passed: false, detail: r.porcupineFailure };
      return {
        name,
        passed: r.violations === 0,
        detail: `runs=${r.totalRuns} violations=${r.violations} unknown=${r.unknown} (expected violations == 0)`,
      };
    }),
  );

  return { passed: cases.every((c) => c.passed), cases };
}
