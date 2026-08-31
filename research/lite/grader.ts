// Chunked A/B grader for the lite research loop (research/lite). One
// invocation runs at most one paired candidate/baseline evaluation chunk;
// whoever calls it decides between invocations whether to buy another, so
// terminating a session early is simply not calling `chunk` again.
//
// Run from research/orchestrator so its node_modules resolve:
//   cd research/orchestrator && npx tsx ../lite/grader.ts <command> [--flags]
//
// Commands:
//   start    --name <slug> --cand-bin <path> --base-bin <path>
//            --base-template <path> [--cand-template <path>]
//            [--cand-spec <path>] [--base-spur <dir>] [--note <text>] [--force]
//   chunk    --name <slug>
//   status   --name <slug>
//   finish   --name <slug> [--regression]
//   baseline --base-bin <path> --base-template <path> --chunks <n>
//            [--base-spur <dir>]
//   selftest
//
// Stdout carries exactly one JSON object per invocation; every progress line
// goes to stderr. Exit code 0 means the command completed (whatever the
// verdict says); nonzero means it could not.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { HARD_LIMITS, loadPolicy, type Policy } from "../orchestrator/src/policy.js";
import { runOneEvaluation, selfTestRunIdentity, type EvalContext } from "../orchestrator/src/evaluate.js";
import {
  canStillAdvance, classifyChunkTiming, classifyPooled, decideSequential, initialSeqState, medianRps,
  pooledCountsOf, pooledFromSeq, selfTestGateConsistency, seqRuleOf, syntheticEvaluation,
  type PooledCounts, type SeqDecision, type SeqRule,
} from "../orchestrator/src/sequential.js";
import { buildStopperPayload, type StopperPayload } from "../orchestrator/src/stopper.js";
import {
  MERGE_Z, PRIMARY_RUNG, RATE_EXCLUDED_ARM_MODES, addStratum, chunkStratum, compareToBaseline,
  figuresOf, mergeBlockers, objectiveCounts, ruleVerdict, type FinalGateInputs, type RatePrior,
} from "../orchestrator/src/decide.js";
import { CAMPAIGN_ONLY_KEYS, ROOT, cleanupDir, explore, freeDiskGb, materializeConfig, porcupine, resolveRoot } from "../orchestrator/src/runners.js";
import { selfTestPosteriors, selfTestStats } from "../orchestrator/src/stats.js";
import { Evaluation, SeqState } from "../orchestrator/src/schemas.js";

// The orchestrator modules narrate progress on stdout; this process promises
// its caller a single JSON object there, so their narration moves to stderr.
console.log = (...args: unknown[]): void => { console.error(...args); };

const LITE_DIR = path.join(ROOT, "research", "lite");
const STATE_DIR = path.join(LITE_DIR, "state");
const BASELINE_DIR = path.join(LITE_DIR, "baselines");
const CONFIG_PATH = path.join(LITE_DIR, "lite.json");
// Path the recorded baseline's chunks were measured against, resolved at the
// record's own superproject commit when adoption is considered.
const RECORD_TEMPLATE_PATH = "scheduler_configs/loop/general_vr.json";

interface LiteConfig {
  goalFile: string;
  spec: string;
  configTemplate: string;
  branch: string;
  relevantFiles: string[];
  budgets: { chunkSec: number; maxChunks: number; minChunks: number; rayonThreads: number; maxBuildSeconds: number };
  porcupineModel: string;
  violationPrior: RatePrior | null;
  allowBigLoopBaselineRecord: boolean;
}

function liteConfig(): LiteConfig {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as LiteConfig;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

// The orchestrator's policy file supplies everything the evaluation runner
// and the decision rule need; only the knobs lite.json owns are overridden,
// clamped into the same hard limits the big loop obeys.
function policyFor(cfg: LiteConfig): Policy {
  const { policy } = loadPolicy(path.join(ROOT, "research", "policy.json"));
  policy.evaluation.rayonThreads = cfg.budgets.rayonThreads;
  policy.sequential.exploreBudgetSec = clamp(cfg.budgets.chunkSec, HARD_LIMITS.minExploreBudgetSec, HARD_LIMITS.maxExploreBudgetSec);
  policy.sequential.maxChunks = clamp(Math.round(cfg.budgets.maxChunks), 1, HARD_LIMITS.maxSequentialChunks);
  policy.sequential.minChunks = clamp(Math.round(cfg.budgets.minChunks), 1, policy.sequential.maxChunks);
  return policy;
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString().trim();
}

function graderVersionOf(): string {
  const ta = gitOut(ROOT, ["log", "-1", "--format=%h", "--", "traceanalyzer"]);
  const porc = gitOut(path.join(ROOT, "porcupine"), ["rev-parse", "--short", "HEAD"]);
  return `ta:${ta}+porc:${porc}`;
}

// A dirty tree is a different program than its HEAD, so the marker keeps a
// dirty checkout from adopting or extending a clean tree's baseline cache.
function spurTreeOf(spurDir: string): string {
  const tree = gitOut(spurDir, ["rev-parse", "HEAD^{tree}"]);
  const dirty = gitOut(spurDir, ["status", "--porcelain"]) !== "";
  return dirty ? `${tree}+dirty` : tree;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Arm ids the rate stratum will pool, read from the template's campaign
// block with the rate-excluded modes removed: the identity both sides of a
// comparison must share.
function templateArmIds(templatePath: string): string[] {
  const raw = JSON.parse(fs.readFileSync(templatePath, "utf8")) as { campaign?: { arms?: Array<{ id?: string; mode?: string }> } };
  const arms = raw.campaign?.arms ?? [];
  return arms.filter((a) => !RATE_EXCLUDED_ARM_MODES.includes(a.mode ?? "")).map((a) => a.id ?? "").sort();
}

// What determines whether two baseline measurements are the same quantity:
// the spur tree the binary was built from, the template content, the arm set
// the rate pools, the thread count (runs share a feedback map across the
// parallel set) and the chunk budget.
interface BaselineIdentity {
  spurTree: string;
  templateSha: string;
  armIds: string[];
  rayonThreads: number;
  chunkSec: number;
}

interface BaselineCache {
  identity: BaselineIdentity;
  source: "record" | "measured" | "mixed";
  chunks: Evaluation[];
}

function identityFor(baseSpurDir: string, baseTemplate: string, policy: Policy): BaselineIdentity {
  return {
    spurTree: spurTreeOf(baseSpurDir),
    templateSha: sha256(fs.readFileSync(baseTemplate, "utf8")),
    armIds: templateArmIds(baseTemplate),
    rayonThreads: policy.evaluation.rayonThreads,
    chunkSec: policy.sequential.exploreBudgetSec,
  };
}

function identityKey(id: BaselineIdentity): string {
  return `${id.spurTree.slice(0, 12)}|${id.armIds.join(",")}|${id.templateSha.slice(0, 8)}|${id.rayonThreads}|${id.chunkSec}`;
}

function cacheFileFor(id: BaselineIdentity): string {
  return path.join(BASELINE_DIR, `${id.spurTree.slice(0, 12)}-${id.rayonThreads}-${id.templateSha.slice(0, 8)}-${id.chunkSec}.json`);
}

function loadCache(file: string): BaselineCache | null {
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { identity: BaselineIdentity; source: BaselineCache["source"]; chunks: unknown[] };
  const chunks: Evaluation[] = [];
  for (const c of raw.chunks) {
    const p = Evaluation.safeParse(c);
    if (p.success) chunks.push(p.data);
  }
  return { identity: raw.identity, source: raw.source, chunks };
}

function saveCache(file: string, cache: BaselineCache): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 1));
}

// The big loop's recorded baseline is adopted only when it measured the same
// quantity: same spur tree, same template content at the record's own commit,
// same arm set and thread count, and chunk exposures within 10% of this
// session's budget. Anything short of that measures fresh instead.
function tryAdoptRecord(id: BaselineIdentity): { chunks: Evaluation[]; detail: string } | null {
  const recordPath = path.join(ROOT, "research", "evaluations", `000-baseline-${id.rayonThreads}.json`);
  if (!fs.existsSync(recordPath)) return null;
  let raw: { baseline?: { sequential?: unknown[]; rayonThreads?: number } };
  try {
    raw = JSON.parse(fs.readFileSync(recordPath, "utf8")) as typeof raw;
  } catch {
    return null;
  }
  if (raw.baseline?.rayonThreads !== id.rayonThreads) return null;
  const chunks: Evaluation[] = [];
  for (const c of raw.baseline?.sequential ?? []) {
    const p = Evaluation.safeParse(c);
    if (!p.success || !p.data.ok) return null;
    chunks.push(p.data);
  }
  const first = chunks[0];
  if (first === undefined) return null;
  for (const c of chunks) {
    const s = chunkStratum(c);
    if (s === null || s.armIds.join(",") !== id.armIds.join(",")) return null;
    if (Math.abs(c.metrics.exposureMs / 1000 - id.chunkSec) > 0.1 * id.chunkSec) return null;
  }
  let tree = "";
  try {
    tree = gitOut(path.join(ROOT, "spur"), ["rev-parse", `${first.spurCommit}^{tree}`]);
  } catch {
    return null;
  }
  if (tree !== id.spurTree) return null;
  let recTemplate = "";
  try {
    recTemplate = execFileSync("git", ["show", `${first.superCommit}:${RECORD_TEMPLATE_PATH}`], { cwd: ROOT }).toString();
  } catch {
    return null;
  }
  if (sha256(recTemplate) !== id.templateSha) return null;
  return { chunks, detail: `adopted ${chunks.length} chunks from ${path.basename(recordPath)}` };
}

interface SessionState {
  name: string;
  createdAtIso: string;
  note: string;
  cand: { bin: string; template: string; spec: string; spurLabel: string };
  base: { bin: string; template: string; spurDir: string };
  identity: BaselineIdentity;
  cacheFile: string;
  limits: { chunkSec: number; maxChunks: number; minChunks: number; rayonThreads: number };
  seq: SeqState;
  usedSeeds: number[];
  evalIds: string[];
  history: Array<{ atIso: string; seed: number; event: string; detail: string; wallSec: number }>;
  failures: { consecutive: number; total: number };
  lastWasSlow: boolean;
  finished: boolean;
}

function stateFileFor(name: string): string {
  return path.join(STATE_DIR, `${name}.json`);
}

function chunkDirFor(name: string): string {
  return path.join(STATE_DIR, name);
}

function loadState(name: string): SessionState {
  const file = stateFileFor(name);
  if (!fs.existsSync(file)) throw new Error(`no session named ${name} (expected ${file}); run start first`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as SessionState;
  const seq = SeqState.safeParse(raw.seq);
  if (!seq.success) throw new Error(`session ${name} carries an unreadable seq state: ${seq.error.message}`);
  raw.seq = seq.data;
  return raw;
}

function saveState(state: SessionState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(stateFileFor(state.name), JSON.stringify(state, null, 1));
}

function writeChunkFile(name: string, seed: number, kind: "cand" | "failed" | "excluded", e: Evaluation): void {
  fs.mkdirSync(chunkDirFor(name), { recursive: true });
  fs.writeFileSync(path.join(chunkDirFor(name), `chunk-${seed}.${kind}.json`), JSON.stringify(e, null, 1));
}

function refuseIfLoopActive(): void {
  let out = "";
  try {
    out = execFileSync("systemctl", ["--user", "is-active", "spur-research-loop"]).toString().trim();
  } catch {
    return;
  }
  if (out === "active") throw new Error("the autonomous loop (spur-research-loop) is active; the lite grader must not run beside it");
}

function diskGuard(policy: Policy): void {
  const free = freeDiskGb(ROOT);
  if (free < policy.budgets.minFreeDiskGb) {
    throw new Error(`only ${free.toFixed(1)} GiB free, below the ${policy.budgets.minFreeDiskGb} GiB floor`);
  }
}

function evalCtx(policy: Policy, bin: string, template: string, spec: string, spurLabel: string): EvalContext {
  return {
    policy,
    binary: bin,
    graderVersion: graderVersionOf(),
    spurCommit: spurLabel,
    superCommit: gitOut(ROOT, ["rev-parse", "--short", "HEAD"]),
    specOverride: spec,
    configTemplateOverride: template,
  };
}

function seqOptsOf(policy: Policy): { runsPerConfig: number; exploreWallSec: number; exploreBudgetSec: number; gradeMaxRuns: number; gradeBudgetMs: number } {
  const p = policy.sequential;
  return {
    runsPerConfig: p.maxRunsPerConfig,
    exploreWallSec: p.exploreBudgetSec,
    exploreBudgetSec: p.exploreBudgetSec,
    gradeMaxRuns: 0,
    gradeBudgetMs: p.wallSecPerChunk * 1000,
  };
}

// Baseline counts restricted to the seeds the candidate actually folded, so
// the two sides stay paired seed for seed and exposure for exposure.
function pairedBaseline(cache: BaselineCache, usedSeeds: number[]): PooledCounts {
  const used = new Set(usedSeeds);
  return pooledCountsOf(cache.chunks.filter((c) => used.has(c.seed)));
}

interface Assessment {
  cand: PooledCounts;
  base: PooledCounts;
  ruled: SeqDecision;
  resolvedIfStopped: SeqDecision | null;
  stopper: StopperPayload | null;
  csa: boolean;
  rule: SeqRule;
}

function assess(state: SessionState, cache: BaselineCache, policy: Policy, cfg: LiteConfig): Assessment {
  const rule = seqRuleOf(policy, cfg.violationPrior);
  const cand = pooledFromSeq(state.seq);
  const base = pairedBaseline(cache, state.usedSeeds);
  if (state.seq.chunks === 0 || base.chunks === 0) {
    return {
      cand, base, rule,
      ruled: { verdict: "continue", reason: "no paired chunks folded yet", posteriors: {} },
      resolvedIfStopped: null, stopper: null, csa: true,
    };
  }
  const ruled = decideSequential(cand, base, state.seq.chunks, rule);
  const csa = canStillAdvance(cand, base, state.seq.chunks, rule);
  return {
    cand, base, rule, ruled, csa,
    resolvedIfStopped: classifyPooled(ruled, cand, base, state.seq.chunks, rule),
    stopper: buildStopperPayload({
      hypothesisId: `lite-${state.name}`, prediction: state.note, ruled,
      cand, base, chunks: state.seq.chunks, rule, canStillAdvance: csa, evalIds: state.evalIds,
    }),
  };
}

function adviceOf(a: Assessment): string[] {
  const out: string[] = [];
  if (a.stopper === null) return out;
  const primary = a.stopper.rungs.find((r) => r.rung === `depth>=${PRIMARY_RUNG}`);
  if (primary !== undefined && primary.insideNullBand) {
    out.push(`primary rung ratio ${primary.ratio.toFixed(3)} sits inside its null band (${primary.nullBand.toFixed(3)}): no information either way yet`);
  }
  if (a.cand.violations > 0) {
    out.push(`candidate produced ${a.cand.violations} violation(s); evidence under research/logs/violations/<eval-id>/`);
  }
  if (a.stopper.throughput.ratio > 0 && a.stopper.throughput.ratio < a.rule.throughputFloor) {
    out.push(`throughput ratio ${a.stopper.throughput.ratio.toFixed(3)} is below the ${a.rule.throughputFloor} floor`);
  }
  if (!a.csa && a.cand.chunks >= a.rule.minChunks) {
    out.push("no remaining chunk can produce a separated advance at the cap (mechanism-dead for the advance rungs)");
  }
  if (a.stopper.exposure.lopsided) {
    out.push("exposure is lopsided between candidate and baseline; treat the ratios with care");
  }
  return out;
}

// Non-finite numbers (an infinite mei on an empty rung) have no JSON form;
// null is the honest reading a consumer can test for.
function sanitize(_key: string, value: unknown): unknown {
  return typeof value === "number" && !Number.isFinite(value) ? null : value;
}

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, sanitize, 1) + "\n");
}

interface StatusExtras {
  phase: "started" | "sampling" | "finished" | "error";
  reason?: string;
  advice?: string[];
  measuredBaselineThisCall?: boolean;
  lastChunkWallSec?: number;
}

function buildStatus(state: SessionState, cache: BaselineCache, policy: Policy, cfg: LiteConfig, x: StatusExtras): Record<string, unknown> {
  const a = assess(state, cache, policy, cfg);
  const lastWall = x.lastChunkWallSec ?? state.history.filter((h) => h.event === "chunk").at(-1)?.wallSec ?? null;
  return {
    name: state.name,
    phase: x.phase,
    chunk: state.seq.chunks,
    maxChunks: a.rule.maxChunks,
    minChunks: a.rule.minChunks,
    verdict: a.ruled.verdict,
    reason: x.reason ?? a.ruled.reason,
    resolvedIfStopped: a.resolvedIfStopped === null ? null : { verdict: a.resolvedIfStopped.verdict, reason: a.resolvedIfStopped.reason },
    canStillAdvance: a.csa,
    stopper: a.stopper,
    advice: [...(x.advice ?? []), ...adviceOf(a)],
    baseline: {
      source: cache.source,
      cacheFile: state.cacheFile,
      chunksCached: cache.chunks.length,
      measuredThisCall: x.measuredBaselineThisCall ?? false,
    },
    timing: {
      lastChunkWallSec: lastWall,
      candRps: state.seq.rpsChunks.at(-1) ?? null,
      baseMedianRps: medianRps(pooledCountsOf(cache.chunks)),
      slowConfirmed: state.seq.slowConfirmed,
      anomalies: state.seq.anomalies,
      failures: state.failures.total,
    },
    files: { state: stateFileFor(state.name), chunkDir: chunkDirFor(state.name) },
    budget: {
      freeDiskGb: Math.round(freeDiskGb(ROOT) * 10) / 10,
      estSecPerChunk: lastWall ?? a.rule.exploreBudgetSec + 120,
    },
  };
}

// One baseline chunk at one seed, held to the same guards the big loop's
// baseline top-up applies: per-arm accounting on the identity's arm set, and
// no timing anomaly against the cache's own median.
async function measureBaselineChunk(state: SessionState, cache: BaselineCache, policy: Policy, seed: number): Promise<string | null> {
  const ctx = evalCtx(policy, state.base.bin, state.base.template, state.cand.spec, `lite-base:${state.identity.spurTree.slice(0, 12)}`);
  console.error(`[lite] measuring baseline chunk at seed ${seed} (~${policy.sequential.exploreBudgetSec}s explore)`);
  const e = await runOneEvaluation(ctx, "lite-base", "sequential", seed, seqOptsOf(policy));
  if (!e.ok) return e.error ?? "evaluation failed";
  const s = chunkStratum(e);
  if (s === null) return "no per-arm accounting";
  if (s.armIds.join(",") !== state.identity.armIds.join(",")) {
    return `arm set [${s.armIds.join(", ")}] does not match the identity [${state.identity.armIds.join(", ")}]`;
  }
  const anomaly = classifyChunkTiming(e, cache.chunks.length >= 2 ? medianRps(pooledCountsOf(cache.chunks)) : null, false);
  if (anomaly !== null) return anomaly;
  cache.chunks.push(e);
  if (cache.source === "record") cache.source = "mixed";
  saveCache(state.cacheFile, cache);
  return null;
}

function need(flags: Map<string, string>, key: string): string {
  const v = flags.get(key);
  if (v === undefined) throw new Error(`--${key} is required`);
  return v;
}

function baseSpurDirOf(flags: Map<string, string>): string {
  const explicit = flags.get("base-spur");
  const derived = explicit ?? path.resolve(need(flags, "base-bin"), "..", "..", "..");
  if (!fs.existsSync(path.join(derived, "Cargo.toml"))) {
    throw new Error(`${derived} does not look like a spur checkout (no Cargo.toml); pass --base-spur <dir>`);
  }
  return derived;
}

async function cmdStart(flags: Map<string, string>): Promise<void> {
  const cfg = liteConfig();
  const policy = policyFor(cfg);
  refuseIfLoopActive();
  diskGuard(policy);
  const name = need(flags, "name");
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(name)) throw new Error(`session name must be a kebab-case slug, got ${name}`);
  const candBin = path.resolve(need(flags, "cand-bin"));
  const baseBin = path.resolve(need(flags, "base-bin"));
  const baseTemplate = path.resolve(need(flags, "base-template"));
  const candTemplate = path.resolve(flags.get("cand-template") ?? baseTemplate);
  const candSpec = flags.get("cand-spec") ?? cfg.spec;
  for (const [label, p] of [["--cand-bin", candBin], ["--base-bin", baseBin], ["--base-template", baseTemplate], ["--cand-template", candTemplate]] as const) {
    if (!fs.existsSync(p)) throw new Error(`${label} ${p} does not exist`);
  }
  const baseSpurDir = baseSpurDirOf(flags);
  const identity = identityFor(baseSpurDir, baseTemplate, policy);
  if (identity.armIds.length === 0) throw new Error(`${baseTemplate} carries no campaign block; the lite grader only measures campaign templates`);
  const candArms = templateArmIds(candTemplate);
  if (candArms.join(",") !== identity.armIds.join(",")) {
    throw new Error(`stratum would fault before any chunk: candidate template pools [${candArms.join(", ")}], baseline pools [${identity.armIds.join(", ")}]. An arm change moves the unit of comparison and cannot be graded here.`);
  }
  const cacheFile = cacheFileFor(identity);
  let cache = loadCache(cacheFile);
  if (cache !== null && identityKey(cache.identity) !== identityKey(identity)) {
    throw new Error(`baseline cache ${cacheFile} carries a different identity; move it aside`);
  }
  if (cache === null) {
    cache = { identity, source: "measured", chunks: [] };
    if (cfg.allowBigLoopBaselineRecord) {
      const adopted = tryAdoptRecord(identity);
      if (adopted !== null) {
        cache.chunks = adopted.chunks;
        cache.source = "record";
        console.error(`[lite] ${adopted.detail}`);
      }
    }
    saveCache(cacheFile, cache);
  }
  if (fs.existsSync(stateFileFor(name)) && flags.get("force") !== "true") {
    throw new Error(`session ${name} already exists; pass --force to overwrite it`);
  }
  const state: SessionState = {
    name,
    createdAtIso: new Date().toISOString(),
    note: flags.get("note") ?? "",
    cand: { bin: candBin, template: candTemplate, spec: candSpec, spurLabel: `lite-cand:${name}` },
    base: { bin: baseBin, template: baseTemplate, spurDir: baseSpurDir },
    identity,
    cacheFile,
    limits: {
      chunkSec: policy.sequential.exploreBudgetSec,
      maxChunks: policy.sequential.maxChunks,
      minChunks: policy.sequential.minChunks,
      rayonThreads: policy.evaluation.rayonThreads,
    },
    seq: initialSeqState(`lite-${name}`, identityKey(identity)),
    usedSeeds: [],
    evalIds: [],
    history: [],
    failures: { consecutive: 0, total: 0 },
    lastWasSlow: false,
    finished: false,
  };
  fs.mkdirSync(chunkDirFor(name), { recursive: true });
  saveState(state);
  emit(buildStatus(state, cache, policy, cfg, { phase: "started" }));
}

async function cmdChunk(flags: Map<string, string>): Promise<void> {
  const cfg = liteConfig();
  const policy = policyFor(cfg);
  const state = loadState(need(flags, "name"));
  if (state.finished) throw new Error(`session ${state.name} is finished`);
  refuseIfLoopActive();
  diskGuard(policy);
  const cache = loadCache(state.cacheFile);
  if (cache === null) throw new Error(`baseline cache ${state.cacheFile} is missing`);
  const rule = seqRuleOf(policy, cfg.violationPrior);
  if (state.seq.chunks >= rule.maxChunks) {
    emit(buildStatus(state, cache, policy, cfg, { phase: "sampling", advice: ["the chunk cap is reached; call finish"] }));
    return;
  }
  const seed = state.seq.nextSeed;
  const t0 = Date.now();
  const record = (event: string, detail: string): void => {
    state.history.push({ atIso: new Date().toISOString(), seed, event, detail, wallSec: Math.round((Date.now() - t0) / 1000) });
  };

  // Baseline half first: a candidate chunk is only worth running once the
  // seed it will pair with exists on the baseline side.
  let measuredBaseline = false;
  if (!cache.chunks.some((c) => c.seed === seed)) {
    measuredBaseline = true;
    const dropped = await measureBaselineChunk(state, cache, policy, seed);
    if (dropped !== null) {
      state.seq = { ...state.seq, nextSeed: seed + 1 };
      record("baseline-dropped", dropped);
      saveState(state);
      emit(buildStatus(state, cache, policy, cfg, {
        phase: "sampling", measuredBaselineThisCall: true,
        reason: `baseline chunk at seed ${seed} was dropped (${dropped}); the seed is skipped on both sides, call chunk again`,
      }));
      return;
    }
  }

  const ctx = evalCtx(policy, state.cand.bin, state.cand.template, state.cand.spec, state.cand.spurLabel);
  console.error(`[lite] measuring candidate chunk at seed ${seed} (~${policy.sequential.exploreBudgetSec}s explore)`);
  const e = await runOneEvaluation(ctx, `lite-${state.name}`, "sequential", seed, seqOptsOf(policy));
  state.seq = { ...state.seq, nextSeed: seed + 1 };

  if (!e.ok) {
    writeChunkFile(state.name, seed, "failed", e);
    if (e.metrics.runs === 0) {
      record("chunk-error", e.error ?? "explorer completed zero runs");
      saveState(state);
      emit(buildStatus(state, cache, policy, cfg, {
        phase: "error", measuredBaselineThisCall: measuredBaseline,
        reason: `explorer completed zero runs (${e.error ?? "wall timeout"}); further seeds cannot inform`,
      }));
      process.exitCode = 1;
      return;
    }
    state.failures = { consecutive: state.failures.consecutive + 1, total: state.failures.total + 1 };
    record("chunk-failed", e.error ?? "evaluation failed");
    saveState(state);
    if (state.failures.consecutive >= 3 || state.failures.total >= rule.maxChunks) {
      emit(buildStatus(state, cache, policy, cfg, {
        phase: "error", measuredBaselineThisCall: measuredBaseline,
        reason: `${state.failures.consecutive >= 3 ? `${state.failures.consecutive} chunks failed in a row` : `${state.failures.total} chunks failed`}: ${e.error ?? "evaluation failed"}`,
      }));
      process.exitCode = 1;
      return;
    }
    emit(buildStatus(state, cache, policy, cfg, {
      phase: "sampling", measuredBaselineThisCall: measuredBaseline,
      reason: `chunk at seed ${seed} failed (${e.error ?? "evaluation failed"}); the next call retries with a fresh seed`,
    }));
    return;
  }
  state.failures = { ...state.failures, consecutive: 0 };

  const anomaly = classifyChunkTiming(e, medianRps(pooledCountsOf(cache.chunks)), state.seq.slowConfirmed);
  if (anomaly !== null) {
    const slow = anomaly.startsWith("slow");
    if (slow && state.lastWasSlow) {
      // Two slow chunks in a row is the candidate, not the host: from here
      // its chunks count and the throughput floor decides.
      state.seq = { ...state.seq, slowConfirmed: true };
    } else {
      state.lastWasSlow = slow;
      state.seq = { ...state.seq, anomalies: state.seq.anomalies + 1 };
      writeChunkFile(state.name, seed, "excluded", { ...e, ok: false, error: `timing anomaly: ${anomaly}`, timingAnomaly: anomaly });
      record("chunk-excluded", anomaly);
      saveState(state);
      emit(buildStatus(state, cache, policy, cfg, {
        phase: "sampling", measuredBaselineThisCall: measuredBaseline,
        reason: `chunk at seed ${seed} was excluded for timing (${anomaly}); the next call uses a fresh seed`,
      }));
      return;
    }
  } else {
    state.lastWasSlow = false;
  }

  const c = pooledCountsOf([e]);
  state.seq = {
    ...state.seq,
    chunks: state.seq.chunks + 1,
    runs: state.seq.runs + c.runs,
    graded: state.seq.graded + c.graded,
    exposureSec: state.seq.exposureSec + c.exposureSec,
    rpsChunks: [...state.seq.rpsChunks, ...c.rpsChunks],
    depth4: state.seq.depth4 + c.depth4,
    depth5: state.seq.depth5 + c.depth5,
    depth6plus: state.seq.depth6plus + c.depth6plus,
    depth7plus: state.seq.depth7plus + c.depth7plus,
    depth8plus: state.seq.depth8plus + c.depth8plus,
    violations: state.seq.violations + c.violations,
    h2Count: state.seq.h2Count + c.h2Count,
    rateStratum: addStratum(state.seq.rateStratum, chunkStratum(e)),
  };
  state.usedSeeds.push(seed);
  state.evalIds.push(e.id);
  writeChunkFile(state.name, seed, "cand", e);

  const a = assess(state, cache, policy, cfg);
  state.seq = { ...state.seq, posteriors: a.ruled.posteriors, lastVerdict: a.ruled.verdict };
  record("chunk", `verdict ${a.ruled.verdict}: ${a.ruled.reason}`);
  saveState(state);
  emit(buildStatus(state, cache, policy, cfg, {
    phase: "sampling",
    measuredBaselineThisCall: measuredBaseline,
    lastChunkWallSec: Math.round((Date.now() - t0) / 1000),
  }));
}

async function cmdStatus(flags: Map<string, string>): Promise<void> {
  const cfg = liteConfig();
  const policy = policyFor(cfg);
  const state = loadState(need(flags, "name"));
  const cache = loadCache(state.cacheFile);
  if (cache === null) throw new Error(`baseline cache ${state.cacheFile} is missing`);
  emit(buildStatus(state, cache, policy, cfg, { phase: state.finished ? "finished" : state.seq.chunks > 0 ? "sampling" : "started" }));
}

async function cmdFinish(flags: Map<string, string>): Promise<void> {
  const cfg = liteConfig();
  const policy = policyFor(cfg);
  const state = loadState(need(flags, "name"));
  const cache = loadCache(state.cacheFile);
  if (cache === null) throw new Error(`baseline cache ${state.cacheFile} is missing`);
  const candEvals: Evaluation[] = [];
  for (const seed of state.usedSeeds) {
    const p = path.join(chunkDirFor(state.name), `chunk-${seed}.cand.json`);
    const parsed = Evaluation.safeParse(JSON.parse(fs.readFileSync(p, "utf8")));
    if (!parsed.success) throw new Error(`unreadable chunk record ${p}`);
    candEvals.push(parsed.data);
  }
  if (candEvals.length === 0) throw new Error(`session ${state.name} folded no chunks; nothing to finish`);
  const used = new Set(state.usedSeeds);
  const baseEvals = cache.chunks.filter((c) => used.has(c.seed));
  const candCounts = objectiveCounts(candEvals);
  const baseCounts = objectiveCounts(baseEvals);
  const cmp = compareToBaseline(candCounts, baseCounts, MERGE_Z, cfg.violationPrior);
  const throughputRatio = candCounts.exposureSec > 0 && baseCounts.exposureSec > 0 && baseCounts.runs > 0
    ? (candCounts.runs / candCounts.exposureSec) / (baseCounts.runs / baseCounts.exposureSec)
    : 1;

  let regression: { passed: boolean; cases: Array<{ name: string; passed: boolean; detail: string }> } | null = null;
  if (flags.get("regression") === "true") {
    refuseIfLoopActive();
    const { runRegression } = await import("../orchestrator/src/regression.js");
    const ctx = evalCtx(policy, state.cand.bin, state.cand.template, state.cand.spec, state.cand.spurLabel);
    console.error(`[lite] running the vr-nofault regression case (~${policy.regression.wallSecPerCase}s)`);
    regression = await runRegression(ctx, null);
  }

  // The gate machinery wants a hypothesis and a firing result; lite supplies
  // a neutral stand-in and leaves the firing question to whoever reads the
  // mechanism counters in the chunk records.
  const inputs: FinalGateInputs = {
    hypothesis: { id: `lite-${state.name}`, kind: "add", prediction: null } as unknown as FinalGateInputs["hypothesis"],
    confirmEvals: candEvals,
    baselineEvals: baseEvals,
    regressionPassed: regression === null ? null : regression.passed,
    lintFailures: [],
    changedSpurFiles: [],
    changedSuperFiles: [],
    throughputRatio,
    throughputFloor: 1 - policy.regression.throughputTolerance,
    violationPrior: cfg.violationPrior,
    unmeasurable: [],
    firing: { status: "not-claimed", detail: "lite leaves the firing check to the operator; read utilStats.counters in the chunk records" },
  };
  const figures = figuresOf(inputs, candCounts, baseCounts, cmp);
  const advice = ruleVerdict(figures);
  const blockers = mergeBlockers(inputs, figures, cmp);
  state.finished = true;
  saveState(state);
  emit({
    name: state.name,
    phase: "finished",
    comparison: {
      improved: cmp.improved,
      regressed: cmp.regressed,
      unresolvedGuards: cmp.unresolvedGuards,
      deltas: cmp.deltas,
      stratumFault: cmp.stratumFault,
      primaryRungRegressed: figures.primaryRungRegressed,
      primary: figures.primary,
      primaryNullBand: figures.primaryNullBand,
      primaryInsideNullBand: figures.primaryInsideNullBand,
      throughputRatio,
    },
    sample: figures.sample,
    violations: { candidate: candCounts.violations, baseline: baseCounts.violations },
    regression,
    adviceVerdict: advice.verdict,
    adviceReason: advice.reason,
    blockers,
    files: { state: stateFileFor(state.name), chunkDir: chunkDirFor(state.name) },
  });
}

async function cmdBaseline(flags: Map<string, string>): Promise<void> {
  const cfg = liteConfig();
  const policy = policyFor(cfg);
  refuseIfLoopActive();
  diskGuard(policy);
  const target = Number(need(flags, "chunks"));
  if (!Number.isInteger(target) || target < 1 || target > HARD_LIMITS.maxSequentialChunks) {
    throw new Error(`--chunks must be an integer in [1, ${HARD_LIMITS.maxSequentialChunks}]`);
  }
  const baseBin = path.resolve(need(flags, "base-bin"));
  const baseTemplate = path.resolve(need(flags, "base-template"));
  const baseSpurDir = baseSpurDirOf(flags);
  const identity = identityFor(baseSpurDir, baseTemplate, policy);
  const cacheFile = cacheFileFor(identity);
  let cache = loadCache(cacheFile);
  if (cache === null) {
    cache = { identity, source: "measured", chunks: [] };
    if (cfg.allowBigLoopBaselineRecord) {
      const adopted = tryAdoptRecord(identity);
      if (adopted !== null) {
        cache.chunks = adopted.chunks;
        cache.source = "record";
        console.error(`[lite] ${adopted.detail}`);
      }
    }
  }
  // A throwaway session shell so the shared measurement path can be reused.
  const shell: SessionState = {
    name: "baseline-warmup", createdAtIso: new Date().toISOString(), note: "",
    cand: { bin: baseBin, template: baseTemplate, spec: cfg.spec, spurLabel: "lite-base" },
    base: { bin: baseBin, template: baseTemplate, spurDir: baseSpurDir },
    identity, cacheFile,
    limits: { chunkSec: policy.sequential.exploreBudgetSec, maxChunks: policy.sequential.maxChunks, minChunks: policy.sequential.minChunks, rayonThreads: policy.evaluation.rayonThreads },
    seq: initialSeqState("lite-base", identityKey(identity)),
    usedSeeds: [], evalIds: [], history: [], failures: { consecutive: 0, total: 0 }, lastWasSlow: false, finished: false,
  };
  const dropped: Array<{ seed: number; reason: string }> = [];
  for (let seed = 1000; cache.chunks.length < target && seed < 1000 + 4 * target; seed++) {
    if (cache.chunks.some((c) => c.seed === seed)) continue;
    const reason = await measureBaselineChunk(shell, cache, policy, seed);
    if (reason !== null) dropped.push({ seed, reason });
  }
  saveCache(cacheFile, cache);
  emit({
    phase: cache.chunks.length >= target ? "finished" : "error",
    cacheFile,
    source: cache.source,
    chunksCached: cache.chunks.length,
    target,
    dropped,
    baseMedianRps: medianRps(pooledCountsOf(cache.chunks)),
  });
  if (cache.chunks.length < target) process.exitCode = 1;
}

async function cmdSelftest(): Promise<void> {
  const cfg = liteConfig();
  const policy = policyFor(cfg);
  const failures: string[] = [...selfTestStats(), ...selfTestPosteriors(), ...selfTestRunIdentity()];

  // The gate-consistency suite needs live baseline figures: under the 300 s
  // chunk policy its synthetic defaults sit in a regime the thresholds were
  // not derived for and it fails on them by design.
  let liveDetail = "(none: gate consistency ran on synthetic defaults)";
  let live: { base: PooledCounts; rule: SeqRule } | undefined;
  const candidates: Evaluation[][] = [];
  if (fs.existsSync(BASELINE_DIR)) {
    for (const f of fs.readdirSync(BASELINE_DIR)) {
      const c = loadCache(path.join(BASELINE_DIR, f));
      if (c !== null && c.chunks.length >= 2) candidates.push(c.chunks);
    }
  }
  if (candidates.length === 0) {
    const recordPath = path.join(ROOT, "research", "evaluations", `000-baseline-${policy.evaluation.rayonThreads}.json`);
    if (fs.existsSync(recordPath)) {
      const raw = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { baseline?: { sequential?: unknown[] } };
      const chunks: Evaluation[] = [];
      for (const c of raw.baseline?.sequential ?? []) {
        const p = Evaluation.safeParse(c);
        if (p.success && p.data.ok) chunks.push(p.data);
      }
      if (chunks.length >= 2) candidates.push(chunks);
    }
  }
  const liveChunks = candidates[0];
  if (liveChunks !== undefined) {
    live = { base: pooledCountsOf(liveChunks), rule: seqRuleOf(policy, null) };
    liveDetail = `pooled from ${liveChunks.length} recorded baseline chunks`;
  }
  failures.push(...selfTestGateConsistency(live));

  // Lite's own seams: state round-trips through the schema, the stratum
  // excludes the aos arm, the tools the evaluation shells out to exist, and
  // the configured template still carries a campaign block.
  const seq = initialSeqState("lite-selftest", "k");
  if (!SeqState.safeParse(JSON.parse(JSON.stringify(seq))).success) failures.push("initial seq state must round-trip through the SeqState schema");
  const synth = syntheticEvaluation(1, { runs: 1000, exposureMs: 60_000, depthAtLeast: [1000, 900, 800, 700, 600, 500, 50, 5], h2Rate: 0.4 });
  const stratum = chunkStratum(synth);
  if (stratum === null) failures.push("a synthetic campaign chunk must carry a stratum");
  else if (stratum.armIds.includes("aos")) failures.push("the rate stratum must exclude the aos arm");
  for (const [tool, build] of [
    [path.join(ROOT, "traceanalyzer", "main"), "cd traceanalyzer && go build -o main main.go"],
    [path.join(ROOT, "porcupine", "batch"), "cd porcupine && go build -o batch ./cmd/porcupine_batch"],
  ] as const) {
    if (!fs.existsSync(tool)) failures.push(`${tool} is missing; build it with: ${build}`);
  }
  const template = path.join(ROOT, cfg.configTemplate);
  if (!fs.existsSync(template)) failures.push(`configured template ${template} is missing`);
  else if (templateArmIds(template).length === 0) failures.push(`configured template ${template} carries no campaign arms`);

  emit({ phase: failures.length === 0 ? "finished" : "error", failures, gateConsistencyBaseline: liveDetail });
  if (failures.length > 0) process.exitCode = 1;
}


// The retired bug panel's manifest still describes each known-bug spec:
// workload overlay, fault declaration, porcupine model, calibrated rates.
interface PanelMember {
  id: string;
  spec: string;
  role: string;
  porcupineModel: string;
  overlay: Record<string, unknown>;
  faults: { numCrashes: unknown };
  maxIterations: number;
  wallSec: number;
  expectedRate: number;
  calibration: { eventsPerSec: number; runsPerSec: number };
}

// The members whose calibrated event rates can resolve inside a short wall;
// the rest are reachable via --members.
const DEFAULT_PANEL_MEMBERS = ["paxos-accept-stale-ballot", "mencius-opt1-2"];

function panelManifest(threads: number): { path: string; members: PanelMember[] } {
  const candidates = [
    path.join(ROOT, "research", "panel", `manifest.${threads}.json`),
    path.join(ROOT, "research", "panel", "manifest.json"),
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  if (found === undefined) throw new Error(`no panel manifest under research/panel/ (tried ${candidates.join(", ")})`);
  const raw = JSON.parse(fs.readFileSync(found, "utf8")) as { members: PanelMember[] };
  return { path: found, members: raw.members };
}

// Rate check of the merged lite tree on the known-bug panel specs. No verdict
// and no gate: one explore + porcupine per member, rates emitted next to the
// manifest calibration for the operator agent to read.
async function cmdPanel(flags: Map<string, string>): Promise<void> {
  const cfg = liteConfig();
  refuseIfLoopActive();
  const threads = cfg.budgets.rayonThreads;
  const manifest = panelManifest(threads);

  const sel = flags.get("members") ?? "";
  let members: PanelMember[];
  if (sel === "all") {
    members = manifest.members;
  } else {
    const ids = sel === "" ? DEFAULT_PANEL_MEMBERS : sel.split(",").map((x) => x.trim()).filter((x) => x !== "");
    members = ids.map((id) => {
      const m = manifest.members.find((x) => x.id === id);
      if (m === undefined) throw new Error(`panel member ${id} not in ${manifest.path} (have: ${manifest.members.map((x) => x.id).join(", ")})`);
      return m;
    });
  }

  const binary = flags.get("binary") ?? path.join(ROOT, "tmp", "lite", "base", "spur", "target", "release", "spur");
  const template = path.join(ROOT, "tmp", "lite", "base", "scheduler_configs", "loop", "general_vr.json");
  for (const [what, f] of [["binary", binary], ["config template", template]] as const) {
    if (!fs.existsSync(f)) throw new Error(`${what} missing: ${f} (is the tmp/lite/base worktree set up and built?)`);
  }
  const seed = Number(flags.get("seed") ?? "1000");
  const scale = Number(flags.get("scale") ?? "3");
  if (!Number.isFinite(seed) || !Number.isFinite(scale) || scale <= 0) throw new Error("--seed and --scale must be positive numbers");

  const rows: Record<string, unknown>[] = [];
  for (const m of members) {
    const dir = path.join(ROOT, "tmp", "loop", "lite", `panel-${m.id}`);
    if (fs.existsSync(dir)) cleanupDir(dir);
    fs.mkdirSync(dir, { recursive: true });
    const cfgPath = path.join(dir, "config.json");
    const wallSec = m.wallSec * scale;
    // wall_budget_sec makes the explorer cut the grid and flush its DB
    // itself; the explore() deadline is only the guard behind it.
    materializeConfig(template, cfgPath, {
      runsPerConfig: 4000,
      sessionSeed: seed,
      dropKeys: CAMPAIGN_ONLY_KEYS,
      extra: { ...m.overlay, num_crashes: m.faults.numCrashes, max_iterations: m.maxIterations, wall_budget_sec: wallSec },
    });
    const ex = await explore({
      binary, configPath: cfgPath, spec: resolveRoot(m.spec),
      outputDir: path.join(dir, "out"), wallSec, rayonThreads: threads,
    });
    // A killed explore leaves a valid partial corpus; the measured wall is
    // the rate denominator either way.
    const porc = await porcupine({
      inputDir: path.join(dir, "out"), model: m.porcupineModel === "kv_rmw" ? "kv_rmw" : "kv",
      timeoutMsPerRun: 10_000, timeoutMs: 900_000,
    });
    const exploreSec = ex.wallMs / 1000;
    rows.push({
      id: m.id,
      role: m.role,
      wallSecBudget: wallSec,
      exploreSec: Math.round(exploreSec * 10) / 10,
      exploreTimedOut: ex.timedOut,
      runs: porc.parsed?.total_runs ?? 0,
      violations: porc.parsed?.violations ?? 0,
      unknown: porc.parsed?.unknown ?? 0,
      violationsPerExploreSec: porc.parsed === null || exploreSec === 0 ? null : porc.parsed.violations / exploreSec,
      runsPerSec: porc.parsed === null || exploreSec === 0 ? null : porc.parsed.total_runs / exploreSec,
      calibration: { eventsPerSec: m.calibration.eventsPerSec, runsPerSec: m.calibration.runsPerSec, expectedRate: m.expectedRate },
      porcupineFailure: porc.parsed === null ? `no parseable porcupine JSON (exit ${String(porc.cmd.exitCode)}${porc.cmd.timedOut ? ", timed out" : ""})` : null,
    });
    cleanupDir(dir);
  }
  emit({ phase: "panel", manifest: manifest.path, binary, template, seed, scale, members: rows });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "";
  const flags = new Map<string, string>();
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === "force" || key === "regression") {
      flags.set(key, "true");
      continue;
    }
    const v = argv[++i];
    if (v === undefined) throw new Error(`--${key} needs a value`);
    flags.set(key, v);
  }
  switch (cmd) {
    case "start": await cmdStart(flags); break;
    case "chunk": await cmdChunk(flags); break;
    case "status": await cmdStatus(flags); break;
    case "finish": await cmdFinish(flags); break;
    case "baseline": await cmdBaseline(flags); break;
    case "selftest": await cmdSelftest(); break;
    case "panel": await cmdPanel(flags); break;
    default:
      throw new Error(`unknown command ${cmd || "(none)"}; use start|chunk|status|finish|baseline|selftest|panel`);
  }
}

main().catch((err: unknown) => {
  emit({ phase: "error", verdict: "error", reason: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
