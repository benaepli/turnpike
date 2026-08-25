// A/B throughput benchmark for perf-kind hypotheses. Runs the candidate
// binary against the preserved baseline binary on a FIXED single-config
// workload, interleaved (ABBA...) to cancel thermal/cache drift, and demands
// strict dominance (min candidate > max baseline) plus a minimum relative
// improvement before it passes. Nothing here reads the ladder - semantic
// safety is the ladder-non-inferiority + regression gates, not this file.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Policy } from "./policy.js";
import { cleanupDir, explore, materializeConfig, porcupine, resolveRoot, ROOT } from "./runners.js";

export interface BenchResult {
  candidateRps: number[];
  baselineRps: number[];
  candMean: number;
  baseMean: number;
  improvement: number; // candMean / baseMean - 1
  strictDominance: boolean;
  totalRunsPerRound: number;
  pass: boolean;
  detail: string;
}

interface RangeJson { min: number; max: number; step?: number }

function countRange(r: RangeJson | undefined): number {
  if (!r) return 1;
  const step = r.step ?? 1;
  return Math.floor((r.max - r.min) / Math.max(step, 1)) + 1;
}

// Total runs an explore of this config performs: cartesian product of the
// expanded ranges times runs-per-config (mirrors the Rust producer loop).
export function totalRunsOf(config: Record<string, unknown>): number {
  const rangeFields = [
    "num_servers", "num_write_ops", "num_read_ops", "num_keys",
    "num_crashes", "num_partitions", "max_concurrent_writes", "num_rmw_ops",
  ];
  let combos = 1;
  for (const f of rangeFields) {
    const v = config[f];
    if (v && typeof v === "object" && "min" in (v as object)) combos *= countRange(v as RangeJson);
  }
  const density = config["dependency_density"];
  if (Array.isArray(density)) combos *= Math.max(density.length, 1);
  const rpc = typeof config["num_runs_per_config"] === "number" ? (config["num_runs_per_config"] as number) : 1;
  return combos * rpc;
}

// Throughput is runs actually written divided by explore wall time; the
// config's promised run count is not trusted because a binary that rejects
// or misreads the config exits early with nothing.
async function oneRound(
  policy: Policy, binary: string, side: string, round: number, configPath: string, expectedRuns: number,
): Promise<{ rps: number; err: string | null }> {
  const outputDir = path.join(ROOT, "tmp", "loop", `bench-${side}-${round}`);
  try {
    const r = await explore({
      binary, configPath,
      spec: resolveRoot(policy.evaluation.spec),
      outputDir,
      wallSec: policy.perf.roundWallSec,
      rayonThreads: policy.evaluation.rayonThreads,
    });
    if (r.timedOut) return { rps: 0, err: `${side} round ${round} hit the wall budget - bench config too big or binary too slow` };
    if (!r.ok) return { rps: 0, err: `${side} round ${round} failed: ${r.stderr.slice(-500)}` };
    const porc = await porcupine({ inputDir: outputDir, model: "kv", timeoutMsPerRun: 1_000, timeoutMs: 120_000 });
    const produced = porc.parsed?.total_runs ?? 0;
    if (produced < expectedRuns / 2) {
      return { rps: 0, err: `${side} round ${round} produced ${produced} of ${expectedRuns} runs: ${r.stderr.slice(-300)}` };
    }
    return { rps: produced / (r.wallMs / 1000), err: null };
  } finally {
    try { cleanupDir(outputDir); } catch { /* ignore */ }
  }
}

export interface BenchWorkload {
  templatePath: string;
  // The baseline binary runs its own template when the candidate changed
  // the config shape; defaults to the candidate's template.
  baselineTemplatePath?: string;
  runsPerConfig: number;
  rounds: number;
}

export async function runBench(policy: Policy, candidateBin: string, baselineBin: string, workload?: BenchWorkload): Promise<BenchResult> {
  const template = workload?.templatePath ?? resolveRoot(policy.perf.benchConfig);
  const baseTemplate = workload?.baselineTemplatePath ?? template;
  const overrides = workload ? { runsPerConfig: workload.runsPerConfig, sessionSeed: 999 } : {};
  const configPath = path.join(ROOT, "tmp", "loop", "bench.config.json");
  const baseConfigPath = path.join(ROOT, "tmp", "loop", "bench.base.config.json");
  materializeConfig(template, configPath, overrides);
  materializeConfig(baseTemplate, baseConfigPath, overrides);
  const totalRuns = totalRunsOf(JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>);

  const cand: number[] = [];
  const base: number[] = [];
  const fail = (detail: string): BenchResult => ({
    candidateRps: cand, baselineRps: base, candMean: 0, baseMean: 0,
    improvement: 0, strictDominance: false, totalRunsPerRound: totalRuns, pass: false, detail,
  });

  const rounds = policy.perf.warmupRounds + (workload?.rounds ?? policy.perf.rounds);
  for (let i = 0; i < rounds; i++) {
    // ABBA interleave: alternate which side goes first each round.
    const order: Array<["cand" | "base", string]> = i % 2 === 0
      ? [["base", baselineBin], ["cand", candidateBin]]
      : [["cand", candidateBin], ["base", baselineBin]];
    for (const [side, bin] of order) {
      const r = await oneRound(policy, bin, side, i, side === "base" ? baseConfigPath : configPath, totalRuns);
      if (r.err) return fail(r.err);
      if (i >= policy.perf.warmupRounds) (side === "cand" ? cand : base).push(r.rps);
    }
  }

  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const candMean = mean(cand);
  const baseMean = mean(base);
  const improvement = baseMean > 0 ? candMean / baseMean - 1 : 0;
  const strictDominance = Math.min(...cand) > Math.max(...base);
  const pass = improvement >= policy.perf.minImprovement && strictDominance;
  return {
    candidateRps: cand.map((x) => Math.round(x * 10) / 10),
    baselineRps: base.map((x) => Math.round(x * 10) / 10),
    candMean: Math.round(candMean * 10) / 10,
    baseMean: Math.round(baseMean * 10) / 10,
    improvement: Math.round(improvement * 1000) / 1000,
    strictDominance,
    totalRunsPerRound: totalRuns,
    pass,
    detail: pass
      ? `candidate ${candMean.toFixed(1)} rps vs baseline ${baseMean.toFixed(1)} rps (+${(improvement * 100).toFixed(1)}%, strict dominance)`
      : `improvement ${(improvement * 100).toFixed(1)}% (need >= ${(policy.perf.minImprovement * 100).toFixed(0)}%), dominance=${strictDominance}`,
  };
}

// Profile snapshot for the audit/proposer: 60s perf record on the bench
// workload, reported as top symbols. Requires perf_event_paranoid <= 2.
export async function collectProfile(policy: Policy, binary: string): Promise<string> {
  const { run } = await import("./runners.js");
  const outputDir = path.join(ROOT, "tmp", "loop", "profile-snap");
  const perfData = path.join(ROOT, "tmp", "loop", "profile-snap.perf.data");
  const configPath = path.join(ROOT, "tmp", "loop", "bench.config.json");
  try {
    materializeConfig(resolveRoot(policy.perf.benchConfig), configPath, {});
    const rec = await run("perf", [
      "record", "--call-graph", "dwarf,8192", "-F", "199", "-o", perfData, "--",
      binary, "explore", "-e", "standard", "--config", configPath, "-y", "--output-dir", outputDir,
      resolveRoot(policy.evaluation.spec),
    ], { timeoutMs: 180_000, cwd: ROOT, env: { ...process.env, RAYON_NUM_THREADS: String(policy.evaluation.rayonThreads), RUST_LOG: "warn" } });
    if (!rec.ok && !fs.existsSync(perfData)) return `(perf record failed: ${rec.stderr.slice(-400)})`;
    const rep = await run("perf", ["report", "--stdio", "--percent-limit", "1", "--no-children", "-i", perfData], { timeoutMs: 120_000, cwd: ROOT });
    const lines = rep.stdout.split("\n").filter((l) => !l.startsWith("#") || l.includes("Overhead")).slice(0, 45).join("\n");
    return rep.ok ? lines : `(perf report failed: ${rep.stderr.slice(-400)})`;
  } catch (e) {
    return `(profile collection error: ${String(e)})`;
  } finally {
    fs.rmSync(perfData, { force: true });
    try { cleanupDir(outputDir); } catch { /* ignore */ }
  }
}
