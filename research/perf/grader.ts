// Round-based A/B grader for the perf research loop (research/perf). One
// invocation buys at most one round: a paired candidate/baseline measurement
// of the campaign workload. Whoever calls it decides between invocations
// whether to buy another, so stopping early is not calling `round` again.
//
// Run from research/orchestrator so its node_modules resolve:
//   cd research/orchestrator && npx tsx ../perf/grader.ts <command> [--flags]
//
// Commands:
//   start    --name <slug> --cand-bin <path> --base-bin <path>
//            --search neutral|affecting
//            --sharing private|shared
//            [--primary within-binary|counter|cross-binary]
//            [--treatment-bit <int>] [--band-min <frac> --band-max <frac>]
//            [--counter <dotted.path>] [--argument <text>]
//            [--cand-template <path>] [--base-template <path>]
//            [--base-spur <dir>] [--note <text>] [--force]
//   round    --name <slug>
//   status   --name <slug>
//   finish   --name <slug>
//   baseline --base-bin <path> --rounds <n> [--base-template <path>]
//            [--base-spur <dir>]
//   profile  [--binary <path>] [--wall-sec <n>] [--name <slug>]
//            [--spur <dir>] [--call-graph fp|none] [--force]
//   selftest
//
// Every ratio this grader prints is a speedup: above one means the candidate
// or the treated side is faster, or does less work per run. Stdout carries
// exactly one JSON object per invocation; progress goes to stderr. Exit code
// 0 means the command completed, whatever its verdict says.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { loadPolicy, type Policy } from "../orchestrator/src/policy.js";
import {
  ROOT, cleanupDir, explore, freeDiskGb, materializeConfig, readSessionSibling,
  readUtilizationSibling, resolveRoot, run, runsTable, templateHasCampaign,
} from "../orchestrator/src/runners.js";
import { SLOW_CHUNK_FACTOR } from "../orchestrator/src/sequential.js";
import {
  NON_DECLARABLE_BITS, VARIANT_BITS, complementCoBits, invariantCoBits, probeFreeScope, variantBitsMissingFromSource,
} from "../orchestrator/src/decide.js";
import type { RunRow, VariantMetrics } from "../orchestrator/src/schemas.js";

// The orchestrator modules narrate progress on stdout; this process promises
// its caller a single JSON object there, so their narration moves to stderr.
console.log = (...args: unknown[]): void => { console.error(...args); };

const PERF_DIR = path.join(ROOT, "research", "perf");
const STATE_DIR = path.join(PERF_DIR, "state");
const BASELINE_DIR = path.join(PERF_DIR, "baselines");
const PROFILE_DIR = path.join(PERF_DIR, "profiles");
const CONFIG_PATH = path.join(PERF_DIR, "perf.json");
const WORK_DIR = path.join(ROOT, "tmp", "loop", "perf");

type Workload = "campaign";
const WORKLOADS: Workload[] = ["campaign"];
type Side = "cand" | "base";
type Search = "neutral" | "affecting";
type Sharing = "private" | "shared";
type PrimaryKind = "within-binary" | "counter" | "cross-binary";

interface PerfConfig {
  goalFile: string;
  spec: string;
  campaignTemplate: string;
  branch: string;
  relevantFiles: string[];
  budgets: {
    campaignWallSec: number;
    minRounds: number;
    maxRounds: number;
    rayonThreads: number;
    profileWallSec: number;
  };
  floors: { layoutFloor: number; minEffect: number; spreadMultiple: number };
}

function perfConfig(): PerfConfig {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as PerfConfig;
}

// The orchestrator's policy file carries the free-disk floor every command
// honours.
function policyFor(): Policy {
  const { policy } = loadPolicy(path.join(ROOT, "research", "policy.json"));
  return policy;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString().trim();
}

// A dirty tree is a different program than its HEAD, so the marker keeps a
// dirty checkout from adopting or extending a clean tree's baseline cache.
function spurTreeOf(spurDir: string): string {
  const tree = gitOut(spurDir, ["rev-parse", "HEAD^{tree}"]);
  const dirty = gitOut(spurDir, ["status", "--porcelain"]) !== "";
  return dirty ? `${tree}+dirty` : tree;
}

function spurLabelOf(spurDir: string): string {
  try {
    const head = gitOut(spurDir, ["rev-parse", "--short", "HEAD"]);
    return gitOut(spurDir, ["status", "--porcelain"]) === "" ? head : `${head}-dirty`;
  } catch {
    return "unknown";
  }
}

// Cargo merges every .cargo/config.toml from the directory it runs in up to
// the filesystem root, and a spur checkout is built from its parent
// directory. Those files carry flags that change the binary without changing
// the source tree.
function buildConfigShaOf(spurDir: string): string {
  const found: string[] = [];
  for (let dir = path.dirname(path.resolve(spurDir)); ; dir = path.dirname(dir)) {
    for (const name of ["config.toml", "config"]) {
      const file = path.join(dir, ".cargo", name);
      if (fs.existsSync(file)) found.push(fs.readFileSync(file, "utf8"));
    }
    if (path.dirname(dir) === dir) break;
  }
  return sha256(found.join("\n"));
}

// What makes two baseline measurements the same quantity: the spur tree the
// binary was built from, the build configuration it was built under, the
// content of the campaign template, the spec, the thread count and the wall
// budget. A depth scale plays no part here, so there is no analyzer term.
interface BaselineIdentity {
  spurTree: string;
  buildConfigSha: string;
  campaignSha: string;
  specSha: string;
  rayonThreads: number;
  campaignWallSec: number;
}

function identityFor(baseSpurDir: string, campaignTemplate: string, cfg: PerfConfig): BaselineIdentity {
  return {
    spurTree: spurTreeOf(baseSpurDir),
    buildConfigSha: buildConfigShaOf(baseSpurDir),
    campaignSha: sha256(fs.readFileSync(campaignTemplate, "utf8")),
    specSha: sha256(fs.readFileSync(resolveRoot(cfg.spec), "utf8")),
    rayonThreads: cfg.budgets.rayonThreads,
    campaignWallSec: cfg.budgets.campaignWallSec,
  };
}

function identityKey(id: BaselineIdentity): string {
  return [
    id.spurTree.slice(0, 12), id.buildConfigSha.slice(0, 8), id.campaignSha.slice(0, 8), id.specSha.slice(0, 8),
    id.rayonThreads, id.campaignWallSec,
  ].join("|");
}

function cacheFileFor(id: BaselineIdentity): string {
  return path.join(BASELINE_DIR, `${id.spurTree.slice(0, 12)}-${id.rayonThreads}-${id.campaignSha.slice(0, 8)}-${id.campaignWallSec}-b${id.buildConfigSha.slice(0, 8)}.json`);
}

interface BaselineCache {
  identity: BaselineIdentity;
  rounds: Array<{ atIso: string; seed: number; measurements: Measurement[] }>;
}

function loadCache(file: string): BaselineCache | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as BaselineCache;
  } catch {
    return null;
  }
}

function saveCache(file: string, cache: BaselineCache): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 1));
}

/** One side of one workload in one round. */
interface Measurement {
  workload: Workload;
  side: Side;
  seed: number;
  wallMs: number;
  runs: number;
  rps: number;
  rows: number;
  usPerRun: number;
  stepsPerRun: number;
  endReasons: Record<string, number>;
  armRuns: Record<string, number>;
  cells: VariantMetrics[];
  counters: Record<string, number>;
}

interface Declaration {
  search: Search;
  sharing: Sharing;
  primary: PrimaryKind;
  treatment: { bit: number; name: string } | null;
  band: { min: number; max: number } | null;
  counter: string | null;
  argument: string;
}

interface SessionState {
  name: string;
  createdAtIso: string;
  note: string;
  declaration: Declaration;
  cand: { bin: string; template: string; spec: string; spurLabel: string };
  base: { bin: string; template: string; spurDir: string };
  identity: BaselineIdentity;
  cacheFile: string;
  limits: { campaignWallSec: number; minRounds: number; maxRounds: number; rayonThreads: number };
  rounds: Array<{ index: number; atIso: string; seed: number; wallSec: number; anomaly: string | null }>;
  finished: boolean;
}

function stateFileFor(name: string): string {
  return path.join(STATE_DIR, `${name}.json`);
}

function roundDirFor(name: string): string {
  return path.join(STATE_DIR, name);
}

function roundFileFor(name: string, index: number): string {
  return path.join(roundDirFor(name), `round-${index}.json`);
}

function loadState(name: string): SessionState {
  const file = stateFileFor(name);
  if (!fs.existsSync(file)) throw new Error(`no session named ${name} (expected ${file}); run start first`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as SessionState;
}

function saveState(state: SessionState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(stateFileFor(state.name), JSON.stringify(state, null, 1));
}

function loadRound(name: string, index: number): Measurement[] {
  const file = roundFileFor(name, index);
  if (!fs.existsSync(file)) return [];
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { measurements: Measurement[] }).measurements;
}

function refuseIfLoopActive(): void {
  let out = "";
  try {
    out = execFileSync("systemctl", ["--user", "is-active", "spur-research-loop"]).toString().trim();
  } catch {
    return;
  }
  if (out === "active") throw new Error("the autonomous loop (spur-research-loop) is active; the perf grader must not measure beside it");
}

function diskGuard(policy: Policy): void {
  const free = freeDiskGb(ROOT);
  if (free < policy.budgets.minFreeDiskGb) {
    throw new Error(`only ${free.toFixed(1)} GiB free, below the ${policy.budgets.minFreeDiskGb} GiB floor`);
  }
}

// Non-finite numbers (an open interval on a single round) have no JSON form;
// null is the honest reading a consumer can test for.
function sanitize(_key: string, value: unknown): unknown {
  return typeof value === "number" && !Number.isFinite(value) ? null : value;
}

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, sanitize, 1) + "\n");
}

// ---------------------------------------------------------------------------
// Instrument selection
// ---------------------------------------------------------------------------

/** Which reading is the merge criterion, from the two frozen declarations. A
 *  saving that travels between runs in one process makes the untreated half
 *  of a session faster too, so the within-binary contrast reads flat exactly
 *  when such a mechanism works: it is refused there rather than reported
 *  weakly. */
export function selectInstrument(d: {
  sharing: Sharing; requested: PrimaryKind | null; treatmentBit: number | null; counter: string | null;
}): { primary: PrimaryKind } | { refusal: string } {
  const requested = d.requested ?? (d.sharing === "private" ? "within-binary" : "counter");
  if (requested === "within-binary" && d.sharing === "shared") {
    return { refusal: "a saving declared shared cannot be read on the within-binary contrast: both cells of a session share the allocator, the caches and the thread pool, so a working mechanism reads flat there. Declare a per-run counter, or redeclare the sharing profile before any round is bought." };
  }
  if (requested === "within-binary" && d.treatmentBit === null) {
    return { refusal: "the within-binary contrast reads treated against untreated runs of one binary; this session declares no treatment bit. Draw one by run id, register it, and pass --treatment-bit, or run on another primary." };
  }
  if (requested === "counter" && d.counter === null) {
    return { refusal: "a saving declared shared is graded on a per-run counter the change names; pass --counter <dotted.path> naming a counter in the utilization dump, or pass --primary cross-binary to read wall time against the layout floor." };
  }
  return { primary: requested };
}

function declarationOf(flags: Map<string, string>): Declaration {
  const searchRaw = need(flags, "search");
  if (searchRaw !== "neutral" && searchRaw !== "affecting") {
    throw new Error(`--search must be neutral or affecting, got ${searchRaw}`);
  }
  const sharingRaw = need(flags, "sharing");
  if (sharingRaw !== "private" && sharingRaw !== "shared") {
    throw new Error(`--sharing must be private or shared (unsure is shared), got ${sharingRaw}`);
  }
  const primaryRaw = flags.get("primary");
  if (primaryRaw !== undefined && primaryRaw !== "within-binary" && primaryRaw !== "counter" && primaryRaw !== "cross-binary") {
    throw new Error(`--primary must be within-binary, counter or cross-binary, got ${primaryRaw}`);
  }
  const treatment = declaredTreatment(flags);
  const counter = flags.get("counter") ?? null;
  const chosen = selectInstrument({
    sharing: sharingRaw, requested: primaryRaw ?? null,
    treatmentBit: treatment?.bit ?? null, counter,
  });
  if ("refusal" in chosen) throw new Error(chosen.refusal);
  const argument = flags.get("argument") ?? "";
  if (searchRaw === "neutral" && argument.length < 20) {
    throw new Error("a change declared search-neutral owes a written argument that what it moves was never load-bearing for the search; pass it as --argument");
  }
  return {
    search: searchRaw, sharing: sharingRaw, primary: chosen.primary, treatment,
    band: bandOf(flags), counter, argument,
  };
}

/** The declared treatment bit, checked before a single round is bought. A bit
 *  that is not on the roster, or that names an instrument rather than a
 *  treatment randomized by run id, is a session that would grade nothing. */
function declaredTreatment(flags: Map<string, string>): { bit: number; name: string } | null {
  const raw = flags.get("treatment-bit");
  if (raw === undefined) return null;
  const bit = Number(raw);
  if (!Number.isInteger(bit) || bit <= 0 || (bit & (bit - 1)) !== 0) throw new Error(`--treatment-bit must be a power of two, got ${raw}`);
  const known = VARIANT_BITS.find((v) => v.bit === bit);
  if (known === undefined) {
    throw new Error(`bit ${bit} is not named in VARIANT_BITS (research/orchestrator/src/decide.ts); add it in the same commit that adds the tag to spur/spur-core/src/simulator/run_variant.rs`);
  }
  if (NON_DECLARABLE_BITS.includes(bit)) {
    throw new Error(`bit ${bit} (${known.name}) names an instrument or an outcome, not a treatment randomized by run id; it cannot be a session's primary`);
  }
  return { bit, name: known.name };
}

function bandOf(flags: Map<string, string>): { min: number; max: number } | null {
  const lo = flags.get("band-min");
  const hi = flags.get("band-max");
  if (lo === undefined && hi === undefined) return null;
  if (lo === undefined || hi === undefined) throw new Error("--band-min and --band-max are declared together or not at all");
  const min = Number(lo);
  const max = Number(hi);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new Error(`--band-min ${lo} and --band-max ${hi} must be ratios with min <= max`);
  return { min, max };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** Per-(arm, variant) sums, the table both the within-binary contrast and the
 *  per-run means are read from. Depth and violations play no part in this
 *  loop, so the ladder fields stay empty. */
export function cellsOf(rows: RunRow[]): VariantMetrics[] {
  const cells = new Map<string, VariantMetrics>();
  for (const r of rows) {
    const key = `${r.arm}\u0000${r.variant}`;
    let acc = cells.get(key);
    if (acc === undefined) {
      acc = { arm: r.arm, variant: r.variant, runs: 0, gradedRuns: 0, depthAtLeast: [], violations: 0, wallUsSum: 0, stepsUsedSum: 0, planCompleteRuns: 0 };
      cells.set(key, acc);
    }
    acc.runs++;
    acc.wallUsSum += r.wall_us;
    acc.stepsUsedSum += r.steps_used;
    if (r.end_reason === "plan_complete") acc.planCompleteRuns++;
  }
  return [...cells.values()].sort((a, b) => (a.arm === b.arm ? a.variant - b.variant : a.arm < b.arm ? -1 : 1));
}

/** Every scalar the utilization dump carries, under its dotted path. */
export function flatCounters(raw: Record<string, unknown> | null): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (node: unknown, prefix: string): void => {
    if (typeof node === "number") {
      if (prefix !== "") out[prefix] = node;
      return;
    }
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, prefix === "" ? k : `${prefix}.${k}`);
  };
  walk(raw, "");
  return out;
}

function workloadConfig(template: string, outPath: string, seed: number, wallSec: number): void {
  const raw = JSON.parse(fs.readFileSync(template, "utf8")) as Record<string, unknown>;
  const campaign = { ...(raw["campaign"] as Record<string, unknown>), wall_budget_sec: wallSec };
  materializeConfig(template, outPath, { sessionSeed: seed, extra: { campaign } });
}

async function measure(
  cfg: PerfConfig, name: string, workload: Workload, side: Side, binary: string, template: string, seed: number, index: number,
): Promise<{ measurement: Measurement | null; error: string | null }> {
  const dir = path.join(WORK_DIR, name, `${workload}-${side}-r${index}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const configPath = `${dir}.config.json`;
  const wallSec = cfg.budgets.campaignWallSec;
  workloadConfig(template, configPath, seed, wallSec);
  console.error(`[perf] round ${index}: ${side} on ${workload} (${wallSec}s cap)`);
  try {
    const r = await explore({
      binary, configPath, spec: resolveRoot(cfg.spec), outputDir: dir, wallSec,
      rayonThreads: cfg.budgets.rayonThreads,
      explorer: "campaign",
    });
    if (!r.ok && !r.timedOut) return { measurement: null, error: `${side} ${workload} round ${index} failed: ${r.stderr.slice(-400)}` };
    const session = readSessionSibling(dir);
    if (session === null) return { measurement: null, error: `${side} ${workload} round ${index} wrote no session summary` };
    const rows = await runsTable(dir);
    if (rows.length === 0) return { measurement: null, error: `${side} ${workload} round ${index} produced no runs table` };
    const endReasons: Record<string, number> = {};
    const armRuns: Record<string, number> = {};
    let us = 0;
    let steps = 0;
    for (const row of rows) {
      us += row.wall_us;
      steps += row.steps_used;
      endReasons[row.end_reason] = (endReasons[row.end_reason] ?? 0) + 1;
      armRuns[row.arm] = (armRuns[row.arm] ?? 0) + 1;
    }
    return {
      measurement: {
        workload, side, seed,
        wallMs: session.wallMs,
        runs: session.runsCompleted,
        rps: session.wallMs > 0 ? session.runsCompleted / (session.wallMs / 1000) : 0,
        rows: rows.length,
        usPerRun: us / rows.length,
        stepsPerRun: steps / rows.length,
        endReasons, armRuns,
        cells: cellsOf(rows),
        counters: flatCounters(readUtilizationSibling(dir)),
      },
      error: null,
    };
  } finally {
    try { cleanupDir(dir); } catch { /* the directory may never have been created */ }
    for (const sib of [".session.json", ".utilization.json", ".campaign.json", ".log", ".config.json"]) {
      fs.rmSync(`${dir}${sib}`, { force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

// Two-sided 95 percent Student-t quantiles by degrees of freedom; the normal
// quantile stands in above the table. Rounds are the unit of replication, so
// a reading on few rounds carries a wide interval rather than a tight one
// borrowed from the runs inside them.
const T95: number[] = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228];

function t95(df: number): number {
  if (df <= 0) return Infinity;
  return T95[df - 1] ?? 1.96;
}

export interface Ratio {
  perRound: number[];
  mean: number;
  sd: number;
  lo: number;
  hi: number;
  // Every round on the same side of one. Reported beside the interval, never
  // required by it: once two rounds straddle one no later round can restore
  // it, so requiring it would let each extra round only ever lose a verdict.
  dominant: boolean;
}

/** The mean of per-round ratios and its interval, taken in logs because a
 *  ratio is multiplicative. */
export function ratioOf(perRound: number[]): Ratio {
  const xs = perRound.filter((x) => Number.isFinite(x) && x > 0);
  if (xs.length === 0) return { perRound, mean: 0, sd: 0, lo: 0, hi: Infinity, dominant: false };
  const logs = xs.map((x) => Math.log(x));
  const m = logs.reduce((a, x) => a + x, 0) / logs.length;
  const sd = logs.length > 1 ? Math.sqrt(logs.reduce((a, x) => a + (x - m) ** 2, 0) / (logs.length - 1)) : 0;
  const half = logs.length > 1 ? t95(logs.length - 1) * (sd / Math.sqrt(logs.length)) : Infinity;
  return {
    perRound: xs,
    mean: Math.exp(m),
    sd,
    lo: Math.exp(m - half),
    hi: Math.exp(m + half),
    dominant: xs.every((x) => x > 1) || xs.every((x) => x < 1),
  };
}

function meanOf(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, x) => a + x, 0) / xs.length;
}

function sdOf(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = meanOf(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** A reading separates when the effect clears the floor the instrument owes
 *  and its interval excludes one. */
export function separates(r: Ratio, floor: number): boolean {
  return Math.abs(r.mean - 1) >= floor && (r.lo > 1 || r.hi < 1);
}

function bandReadingOf(r: Ratio, band: { min: number; max: number } | null): string | null {
  if (band === null) return null;
  if (r.hi < band.min) return "below";
  if (r.lo > band.max) return "above";
  return "inside";
}

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

interface SideSummary {
  runs: number;
  usPerRun: number;
  stepsPerRun: number;
  planCompleteShare: number;
}

function summaryOf(cells: VariantMetrics[]): SideSummary {
  let runs = 0;
  let us = 0;
  let steps = 0;
  let complete = 0;
  for (const c of cells) {
    runs += c.runs;
    us += c.wallUsSum;
    steps += c.stepsUsedSum;
    complete += c.planCompleteRuns;
  }
  return {
    runs,
    usPerRun: runs > 0 ? us / runs : 0,
    stepsPerRun: runs > 0 ? steps / runs : 0,
    planCompleteShare: runs > 0 ? complete / runs : 0,
  };
}

export interface WithinReading {
  applies: boolean;
  reason: string | null;
  treated: SideSummary;
  untreated: SideSummary;
  treatedShare: number;
  matchedOnMask: number;
  // Untreated microseconds per run over treated: above one means the treated
  // runs were cheaper.
  usRatio: number;
  stepsRatio: number;
}

/** Treated against untreated runs of one binary, matched the way the search
 *  loop matches them: probes out of scope, controls restricted to the co-bits
 *  every treated run carries and clear of the co-bits none of them does. */
export function withinBinary(cells: VariantMetrics[], bit: number): WithinReading {
  const scope = probeFreeScope(cells, bit);
  const treatedCells = scope.filter((c) => (c.variant & bit) !== 0);
  const inv = invariantCoBits(treatedCells, bit);
  const shared = scope.filter((c) => (c.variant & bit) === 0 && (c.variant & inv) === inv);
  const comp = complementCoBits(treatedCells, shared, bit);
  const untreatedCells = shared.filter((c) => (c.variant & comp) === 0);
  const treated = summaryOf(treatedCells);
  const untreated = summaryOf(untreatedCells);
  const total = treated.runs + untreated.runs;
  const empty = treated.runs === 0 || untreated.runs === 0;
  return {
    applies: !empty,
    reason: empty ? `bit ${bit} has ${treated.runs} treated and ${untreated.runs} matched untreated runs in scope` : null,
    treated, untreated,
    treatedShare: total > 0 ? treated.runs / total : 0,
    matchedOnMask: inv,
    usRatio: treated.usPerRun > 0 ? untreated.usPerRun / treated.usPerRun : 0,
    stepsRatio: treated.stepsPerRun > 0 ? untreated.stepsPerRun / treated.stepsPerRun : 0,
  };
}

interface WorkloadReading {
  workload: Workload;
  rounds: number;
  candRps: number[];
  baseRps: number[];
  rps: Ratio;
  // Baseline microseconds per run over the candidate's: a speedup, like
  // every other ratio here.
  usPerRun: Ratio;
  // The candidate's steps per run over the baseline's. Steps are a
  // denominator the change can move, so this one is read beside the wall
  // reading and never divided into it.
  stepsPerRun: Ratio;
  within: Ratio | null;
  withinDetail: WithinReading | null;
  candStepsPerRun: number;
  baseStepsPerRun: number;
  endReasonShares: { cand: Record<string, number>; base: Record<string, number> };
  armShares: { cand: Record<string, number>; base: Record<string, number> };
}

function sharesOf(counts: Record<string, number>): Record<string, number> {
  const total = Object.values(counts).reduce((a, x) => a + x, 0);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) out[k] = total > 0 ? v / total : 0;
  return out;
}

function poolCounts(ms: Measurement[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of ms) for (const [k, v] of Object.entries(m.endReasons)) out[k] = (out[k] ?? 0) + v;
  return out;
}

function poolArms(ms: Measurement[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of ms) for (const [k, v] of Object.entries(m.armRuns)) out[k] = (out[k] ?? 0) + v;
  return out;
}

function pairsOf(rounds: Measurement[][], workload: Workload): Array<{ cand: Measurement; base: Measurement }> {
  const out: Array<{ cand: Measurement; base: Measurement }> = [];
  for (const r of rounds) {
    const cand = r.find((m) => m.workload === workload && m.side === "cand");
    const base = r.find((m) => m.workload === workload && m.side === "base");
    if (cand !== undefined && base !== undefined) out.push({ cand, base });
  }
  return out;
}

function workloadReading(rounds: Measurement[][], workload: Workload, bit: number | null): WorkloadReading {
  const pairs = pairsOf(rounds, workload);
  const candMs = pairs.map((p) => p.cand);
  const baseMs = pairs.map((p) => p.base);
  const within = bit === null ? null : pairs.map((p) => withinBinary(p.cand.cells, bit));
  const withinRatio = within === null ? null : ratioOf(within.filter((w) => w.applies).map((w) => w.usRatio));
  return {
    workload,
    rounds: pairs.length,
    candRps: candMs.map((m) => Math.round(m.rps * 100) / 100),
    baseRps: baseMs.map((m) => Math.round(m.rps * 100) / 100),
    rps: ratioOf(pairs.map((p) => (p.base.rps > 0 ? p.cand.rps / p.base.rps : 0))),
    usPerRun: ratioOf(pairs.map((p) => (p.cand.usPerRun > 0 ? p.base.usPerRun / p.cand.usPerRun : 0))),
    stepsPerRun: ratioOf(pairs.map((p) => (p.base.stepsPerRun > 0 ? p.cand.stepsPerRun / p.base.stepsPerRun : 0))),
    within: withinRatio,
    // Pooled over the rounds: the cells only ever add, so the share and the
    // matched mask describe the whole sample and not its last round.
    withinDetail: bit === null ? null : withinBinary(candMs.flatMap((m) => m.cells), bit),
    candStepsPerRun: meanOf(candMs.map((m) => m.stepsPerRun)),
    baseStepsPerRun: meanOf(baseMs.map((m) => m.stepsPerRun)),
    endReasonShares: { cand: sharesOf(poolCounts(candMs)), base: sharesOf(poolCounts(baseMs)) },
    armShares: { cand: sharesOf(poolArms(candMs)), base: sharesOf(poolArms(baseMs)) },
  };
}

interface CounterReading {
  name: string;
  candPerRun: number;
  basePerRun: number;
  // Baseline count over the candidate's: above one means the candidate does
  // less of whatever the counter counts.
  ratio: Ratio;
  presentOnBothSides: boolean;
}

function counterReading(rounds: Measurement[][], workload: Workload, name: string): CounterReading {
  const pairs = pairsOf(rounds, workload);
  const perRun = (m: Measurement): number => (m.rows > 0 ? (m.counters[name] ?? NaN) / m.rows : NaN);
  const cand = pairs.map((p) => perRun(p.cand));
  const base = pairs.map((p) => perRun(p.base));
  const present = cand.every((x) => Number.isFinite(x)) && base.every((x) => Number.isFinite(x)) && pairs.length > 0;
  return {
    name,
    candPerRun: meanOf(cand.filter((x) => Number.isFinite(x))),
    basePerRun: meanOf(base.filter((x) => Number.isFinite(x))),
    ratio: ratioOf(pairs.map((_, i) => {
      const c = cand[i] ?? NaN;
      const b = base[i] ?? NaN;
      return Number.isFinite(c) && Number.isFinite(b) && c > 0 ? b / c : NaN;
    })),
    presentOnBothSides: present,
  };
}

/** A candidate observable against the baseline's own round-to-round spread.
 *  Read on high-count observables - steps per run, end reasons, per-arm
 *  counts - and never on rare events. */
interface SpreadCheck { name: string; cand: number; base: number; spread: number; allowed: number; within: boolean }

function spreadCheck(name: string, candValues: number[], baseValues: number[], multiple: number, floor: number): SpreadCheck {
  const cand = meanOf(candValues);
  const base = meanOf(baseValues);
  const spread = sdOf(baseValues);
  // With no measured spread the floor stands in, as a fraction of the
  // baseline's own level.
  const allowed = Math.max(multiple * spread, floor * Math.abs(base));
  return { name, cand, base, spread, allowed, within: Math.abs(cand - base) <= allowed };
}

function searchNeutralityChecks(rounds: Measurement[][], cfg: PerfConfig): SpreadCheck[] {
  const out: SpreadCheck[] = [];
  const mult = cfg.floors.spreadMultiple;
  const floor = cfg.floors.minEffect;
  for (const workload of WORKLOADS) {
    const pairs = pairsOf(rounds, workload);
    if (pairs.length === 0) continue;
    out.push(spreadCheck(`${workload} steps per run`, pairs.map((p) => p.cand.stepsPerRun), pairs.map((p) => p.base.stepsPerRun), mult, floor));
    const reasons = new Set<string>();
    for (const p of pairs) {
      for (const k of Object.keys(p.cand.endReasons)) reasons.add(k);
      for (const k of Object.keys(p.base.endReasons)) reasons.add(k);
    }
    for (const reason of [...reasons].sort()) {
      const share = (m: Measurement): number => (m.rows > 0 ? (m.endReasons[reason] ?? 0) / m.rows : 0);
      out.push(spreadCheck(`${workload} end reason ${reason}`, pairs.map((p) => share(p.cand)), pairs.map((p) => share(p.base)), mult, floor));
    }
    const arms = new Set<string>();
    for (const p of pairs) {
      for (const k of Object.keys(p.cand.armRuns)) arms.add(k);
      for (const k of Object.keys(p.base.armRuns)) arms.add(k);
    }
    for (const arm of [...arms].sort()) {
      const share = (m: Measurement): number => (m.rows > 0 ? (m.armRuns[arm] ?? 0) / m.rows : 0);
      out.push(spreadCheck(`${workload} arm share ${arm}`, pairs.map((p) => share(p.cand)), pairs.map((p) => share(p.base)), mult, floor));
    }
  }
  return out;
}

interface Reading {
  name: string;
  declaration: Declaration;
  rounds: number;
  minRounds: number;
  maxRounds: number;
  floors: { crossBinary: number; withinBinary: number; counter: number };
  workloads: WorkloadReading[];
  counter: CounterReading | null;
  searchNeutrality: SpreadCheck[];
  baselineSpread: Array<{ workload: Workload; rounds: number; meanRps: number; spread: number }>;
  primary: {
    kind: PrimaryKind;
    workload: Workload;
    ratio: Ratio;
    floor: number;
    separated: boolean;
    band: { min: number; max: number } | null;
    bandReading: string | null;
  } | null;
  blockers: string[];
  adviceVerdict: string;
  adviceReason: string;
}

/** The merge criterion the frozen declarations picked, read on the campaign
 *  workload. */
function primaryRatioOf(w: WorkloadReading, kind: PrimaryKind, counter: CounterReading | null): Ratio | null {
  if (kind === "within-binary") return w.within;
  if (kind === "counter") return counter === null ? null : counter.ratio;
  return w.rps;
}

function buildReading(state: SessionState, cfg: PerfConfig, rounds: Measurement[][]): Reading {
  const d = state.declaration;
  const bit = d.treatment?.bit ?? null;
  const workloads = WORKLOADS.map((w) => workloadReading(rounds, w, bit));
  const counter = d.counter === null ? null : counterReading(rounds, "campaign", d.counter);
  const floors = {
    crossBinary: Math.max(cfg.floors.layoutFloor, cfg.floors.minEffect),
    withinBinary: cfg.floors.minEffect,
    counter: cfg.floors.minEffect,
  };
  const floor = d.primary === "cross-binary" ? floors.crossBinary : d.primary === "within-binary" ? floors.withinBinary : floors.counter;
  const campaign = workloads[0] as WorkloadReading;
  const primaryRatio = primaryRatioOf(campaign, d.primary, counter);
  const searchNeutrality = searchNeutralityChecks(rounds, cfg);
  const cache = loadCache(state.cacheFile);
  const baselineSpread = WORKLOADS.map((w) => {
    const rps = (cache?.rounds ?? []).flatMap((r) => r.measurements.filter((m) => m.workload === w).map((m) => m.rps));
    return { workload: w, rounds: rps.length, meanRps: meanOf(rps), spread: meanOf(rps) > 0 ? sdOf(rps) / meanOf(rps) : 0 };
  });

  const blockers: string[] = [];
  const n = rounds.length;
  const moved = searchNeutrality.filter((c) => !c.within);
  if (d.search === "neutral") {
    if (moved.length > 0) blockers.push(`the candidate reads outside the baseline's own spread on: ${moved.map((c) => c.name).join(", ")}; the neutral declaration is refuted`);
    if (d.argument.length < 20) blockers.push("a change declared search-neutral owes a written argument that what it moves was never load-bearing for the search");
  } else {
    blockers.push("a change that alters the search owes the search loop's non-inferiority reading and its protocol panel; record both in the log, and clear this with a written reason");
  }
  if (d.sharing === "shared" && d.counter === null) {
    blockers.push("a saving declared shared names no per-run counter, so wall time is the only read and it is confirmation, not a primary");
  }
  if (counter !== null && !counter.presentOnBothSides) {
    blockers.push(`the declared counter ${counter.name} is missing from the utilization dump on at least one side; a mechanism that counts nothing cannot be told from one that never ran`);
  }
  if (counter !== null && counter.presentOnBothSides && Math.abs(counter.ratio.mean - 1) < cfg.floors.minEffect) {
    blockers.push(`the declared counter ${counter.name} did not move: the mechanism did not fire as predicted`);
  }
  for (const w of workloads) {
    if (w.rounds === 0) blockers.push(`the ${w.workload} workload has no paired rounds`);
  }
  if (d.primary === "within-binary" && campaign.withinDetail !== null && !campaign.withinDetail.applies) {
    blockers.push(`the within-binary contrast does not apply: ${campaign.withinDetail.reason ?? "no treated or untreated runs"}`);
  }

  const separated = primaryRatio !== null && separates(primaryRatio, floor);
  const bandReading = primaryRatio === null ? null : bandReadingOf(primaryRatio, d.band);
  // A counter is the primary a shared saving is read on; the campaign
  // workload's runs per second confirms it and can refuse it, and never
  // supplies a gain of its own.
  const secondary = d.primary === "counter" ? campaign.rps : null;
  if (separated && (primaryRatio?.mean ?? 1) > 1 && secondary !== null && separates(secondary, floors.crossBinary) && secondary.mean < 1) {
    blockers.push("the declared counter reads a gain the campaign workload contradicts: its runs per second separates downward while the counter reads up");
  }

  let verdict = "inconclusive";
  let reason = "";
  if (n < cfg.budgets.minRounds) {
    reason = `${n} of ${cfg.budgets.minRounds} rounds bought`;
  } else if (primaryRatio === null) {
    verdict = "no-reading";
    reason = "the declared primary produced no reading";
  } else if (bandReading === "below") {
    verdict = "refuted";
    reason = `the primary's interval lies below the frozen band [${d.band?.min ?? 0}, ${d.band?.max ?? 0}]`;
  } else if (separated && primaryRatio.mean > 1) {
    verdict = "gain";
    reason = `the primary reads ${primaryRatio.mean.toFixed(4)} over ${n} rounds, clear of the ${floor} floor`;
  } else if (separated && primaryRatio.mean < 1) {
    verdict = "regressed";
    reason = `the primary reads ${primaryRatio.mean.toFixed(4)} over ${n} rounds: the candidate is slower`;
  } else if (n >= cfg.budgets.maxRounds) {
    verdict = "no-gain";
    reason = `the primary did not separate from the ${floor} floor by the round cap`;
  } else {
    reason = `the primary reads ${primaryRatio.mean.toFixed(4)}, inside the ${floor} floor; another round could still separate it`;
  }
  if (blockers.length > 0 && verdict === "gain") reason = `${reason}; ${blockers.length} blocker(s) stand`;

  return {
    name: state.name,
    declaration: d,
    rounds: n,
    minRounds: cfg.budgets.minRounds,
    maxRounds: cfg.budgets.maxRounds,
    floors,
    workloads,
    counter,
    searchNeutrality,
    baselineSpread,
    primary: primaryRatio === null ? null : {
      kind: d.primary, workload: "campaign", ratio: primaryRatio, floor, separated,
      band: d.band, bandReading,
    },
    blockers,
    adviceVerdict: verdict,
    adviceReason: reason,
  };
}

function roundsOf(state: SessionState): Measurement[][] {
  return state.rounds.filter((r) => r.anomaly === null).map((r) => loadRound(state.name, r.index));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function need(flags: Map<string, string>, key: string): string {
  const v = flags.get(key);
  if (v === undefined) throw new Error(`--${key} is required`);
  return v;
}

function baseSpurDirOf(flags: Map<string, string>): string {
  const derived = flags.get("base-spur") ?? path.resolve(need(flags, "base-bin"), "..", "..", "..");
  if (!fs.existsSync(path.join(derived, "Cargo.toml"))) {
    throw new Error(`${derived} does not look like a spur checkout (no Cargo.toml); pass --base-spur <dir>`);
  }
  return derived;
}

async function cmdStart(flags: Map<string, string>): Promise<void> {
  const cfg = perfConfig();
  const policy = policyFor();
  refuseIfLoopActive();
  diskGuard(policy);
  const name = need(flags, "name");
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(name)) throw new Error(`session name must be a kebab-case slug, got ${name}`);
  const candBin = path.resolve(need(flags, "cand-bin"));
  const baseBin = path.resolve(need(flags, "base-bin"));
  const baseTemplate = path.resolve(flags.get("base-template") ?? path.join(ROOT, cfg.campaignTemplate));
  const candTemplate = path.resolve(flags.get("cand-template") ?? baseTemplate);
  for (const [label, p] of [["--cand-bin", candBin], ["--base-bin", baseBin], ["--base-template", baseTemplate], ["--cand-template", candTemplate]] as const) {
    if (!fs.existsSync(p)) throw new Error(`${label} ${p} does not exist`);
  }
  for (const t of [baseTemplate, candTemplate]) {
    if (!templateHasCampaign(t)) throw new Error(`${t} carries no campaign block; the objective is read on the campaign workload`);
  }
  const declaration = declarationOf(flags);
  const baseSpurDir = baseSpurDirOf(flags);
  const identity = identityFor(baseSpurDir, baseTemplate, cfg);
  const cacheFile = cacheFileFor(identity);
  if (fs.existsSync(stateFileFor(name)) && flags.get("force") !== "true") {
    throw new Error(`session ${name} already exists; pass --force to overwrite it`);
  }
  const state: SessionState = {
    name,
    createdAtIso: new Date().toISOString(),
    note: flags.get("note") ?? "",
    declaration,
    cand: { bin: candBin, template: candTemplate, spec: cfg.spec, spurLabel: `perf-cand:${name}` },
    base: { bin: baseBin, template: baseTemplate, spurDir: baseSpurDir },
    identity,
    cacheFile,
    limits: {
      campaignWallSec: cfg.budgets.campaignWallSec,
      minRounds: cfg.budgets.minRounds,
      maxRounds: cfg.budgets.maxRounds,
      rayonThreads: cfg.budgets.rayonThreads,
    },
    rounds: [],
    finished: false,
  };
  fs.mkdirSync(roundDirFor(name), { recursive: true });
  saveState(state);
  emit({
    phase: "started",
    name,
    declaration,
    identityKey: identityKey(identity),
    cacheFile: path.relative(ROOT, cacheFile),
    cachedBaselineRounds: loadCache(cacheFile)?.rounds.length ?? 0,
    limits: state.limits,
    floors: cfg.floors,
    files: { state: path.relative(ROOT, stateFileFor(name)), rounds: path.relative(ROOT, roundDirFor(name)) },
  });
}

async function cmdRound(flags: Map<string, string>): Promise<void> {
  const cfg = perfConfig();
  const policy = policyFor();
  const state = loadState(need(flags, "name"));
  refuseIfLoopActive();
  diskGuard(policy);
  if (state.rounds.length >= cfg.budgets.maxRounds) {
    throw new Error(`session ${state.name} already holds ${state.rounds.length} rounds, at the cap of ${cfg.budgets.maxRounds}`);
  }
  const index = state.rounds.length;
  const seed = 1000 + index;
  const startedAt = Date.now();
  const measurements: Measurement[] = [];
  let anomaly: string | null = null;
  for (const workload of WORKLOADS) {
    // Alternate which side goes first, so a drift across the session cancels
    // between rounds rather than favouring one side.
    const order: Array<[Side, string, string]> = index % 2 === 0
      ? [["base", state.base.bin, state.base.template], ["cand", state.cand.bin, state.cand.template]]
      : [["cand", state.cand.bin, state.cand.template], ["base", state.base.bin, state.base.template]];
    for (const [side, bin, template] of order) {
      const r = await measure(cfg, state.name, workload, side, bin, template, seed, index);
      if (r.measurement === null) { anomaly = r.error; break; }
      measurements.push(r.measurement);
    }
    if (anomaly !== null) break;
  }
  // A round is excluded for its timing, never for its content: a baseline
  // side far below the throughput the cache records is the host misbehaving,
  // not the candidate.
  if (anomaly === null) {
    const cache = loadCache(state.cacheFile);
    for (const workload of WORKLOADS) {
      const cached = (cache?.rounds ?? []).flatMap((r) => r.measurements.filter((m) => m.workload === workload).map((m) => m.rps));
      const base = measurements.find((m) => m.workload === workload && m.side === "base");
      const median = meanOf(cached);
      if (cached.length >= 2 && base !== undefined && median > 0 && base.rps < median / SLOW_CHUNK_FACTOR) {
        anomaly = `${workload} baseline side ran at ${base.rps.toFixed(1)} runs/s against a cached ${median.toFixed(1)}`;
      }
    }
  }
  const wallSec = Math.round((Date.now() - startedAt) / 1000);
  if (anomaly === null) {
    fs.mkdirSync(roundDirFor(state.name), { recursive: true });
    fs.writeFileSync(roundFileFor(state.name, index), JSON.stringify({ index, atIso: new Date().toISOString(), seed, measurements }, null, 1));
    const cache = loadCache(state.cacheFile) ?? { identity: state.identity, rounds: [] };
    cache.rounds.push({ atIso: new Date().toISOString(), seed, measurements: measurements.filter((m) => m.side === "base") });
    saveCache(state.cacheFile, cache);
  }
  state.rounds.push({ index, atIso: new Date().toISOString(), seed, wallSec, anomaly });
  saveState(state);
  const reading = buildReading(state, cfg, roundsOf(state));
  emit({ phase: "sampling", lastRound: { index, seed, wallSec, anomaly }, ...reading });
}

async function cmdStatus(flags: Map<string, string>): Promise<void> {
  const cfg = perfConfig();
  const state = loadState(need(flags, "name"));
  emit({ phase: state.finished ? "finished" : "sampling", ...buildReading(state, cfg, roundsOf(state)) });
}

async function cmdFinish(flags: Map<string, string>): Promise<void> {
  const cfg = perfConfig();
  const state = loadState(need(flags, "name"));
  const rounds = roundsOf(state);
  if (rounds.length === 0) throw new Error(`session ${state.name} folded no rounds; nothing to finish`);
  state.finished = true;
  saveState(state);
  emit({
    phase: "finished",
    ...buildReading(state, cfg, rounds),
    files: { state: path.relative(ROOT, stateFileFor(state.name)), rounds: path.relative(ROOT, roundDirFor(state.name)) },
  });
}

async function cmdBaseline(flags: Map<string, string>): Promise<void> {
  const cfg = perfConfig();
  const policy = policyFor();
  refuseIfLoopActive();
  diskGuard(policy);
  const target = Number(need(flags, "rounds"));
  if (!Number.isInteger(target) || target < 1 || target > cfg.budgets.maxRounds) {
    throw new Error(`--rounds must be an integer in [1, ${cfg.budgets.maxRounds}]`);
  }
  const baseBin = path.resolve(need(flags, "base-bin"));
  const baseTemplate = path.resolve(flags.get("base-template") ?? path.join(ROOT, cfg.campaignTemplate));
  if (!fs.existsSync(baseBin)) throw new Error(`--base-bin ${baseBin} does not exist`);
  const identity = identityFor(baseSpurDirOf(flags), baseTemplate, cfg);
  const cacheFile = cacheFileFor(identity);
  const cache = loadCache(cacheFile) ?? { identity, rounds: [] };
  const measuredThisCall: number[] = [];
  const dropped: Array<{ seed: number; reason: string }> = [];
  for (let index = cache.rounds.length; cache.rounds.length < target && index < 4 * target; index++) {
    const seed = 1000 + index;
    const measurements: Measurement[] = [];
    let failed: string | null = null;
    for (const workload of WORKLOADS) {
      const r = await measure(cfg, "baseline", workload, "base", baseBin, baseTemplate, seed, index);
      if (r.measurement === null) { failed = r.error; break; }
      measurements.push(r.measurement);
    }
    if (failed !== null) { dropped.push({ seed, reason: failed }); continue; }
    cache.rounds.push({ atIso: new Date().toISOString(), seed, measurements });
    measuredThisCall.push(seed);
    saveCache(cacheFile, cache);
  }
  saveCache(cacheFile, cache);
  emit({
    phase: cache.rounds.length >= target ? "finished" : "error",
    cacheFile: path.relative(ROOT, cacheFile),
    identityKey: identityKey(identity),
    roundsCached: cache.rounds.length,
    target,
    measuredThisCall,
    adopted: measuredThisCall.length === 0,
    dropped,
    workloads: WORKLOADS.map((w) => {
      const rps = cache.rounds.flatMap((r) => r.measurements.filter((m) => m.workload === w).map((m) => m.rps));
      return { workload: w, rounds: rps.length, meanRps: meanOf(rps), spread: meanOf(rps) > 0 ? sdOf(rps) / meanOf(rps) : 0 };
    }),
  });
  if (cache.rounds.length < target) process.exitCode = 1;
}

// Samples per second per thread. High enough to rank symbols over a short
// wall, low enough that the recorder is not itself the workload.
const PROFILE_HZ = 199;
// A profile is read for its shape, so its seed is fixed rather than drawn:
// two profiles of one tree are then comparable.
const PROFILE_SEED = 1000;
// Grace past the session's own wall budget for the recorder to finalize its
// output after the explorer exits.
const PROFILE_TAIL_MS = 120_000;
// The reporter's floor on a symbol's share, in percent.
const PROFILE_PERCENT_LIMIT = 1;

// Walking every sampled call stack for inclusive time takes far longer than
// ranking self time.
const PROFILE_REPORT_MS = 600_000;

interface ProfileSnapshot {
  ok: boolean;
  text: string;
  inclusive: string | null;
  largestInclusive: { percent: number; symbol: string } | null;
  demangled: boolean;
}

// perf does not demangle Rust v0 symbols; rustfilt does. Without it the
// report keeps mangled names, which is worse to read but still ranked.
function demangle(report: string): { text: string; demangled: boolean } {
  try {
    return { text: execFileSync("rustfilt", { input: report, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }), demangled: true };
  } catch {
    return { text: report, demangled: false };
  }
}

// The kernel refuses to record a user-space profile above this setting.
function paranoidLevel(): number | null {
  try {
    return Number.parseInt(fs.readFileSync("/proc/sys/kernel/perf_event_paranoid", "utf8").trim(), 10);
  } catch {
    return null;
  }
}

/** A report's symbol rows and column header, without the reporter's preamble. */
function reportLines(report: string): string {
  return report.split("\n").filter((l) => !l.startsWith("#") || l.includes("Overhead") || l.includes("Children")).join("\n");
}

/** The first row of a report sorted by inclusive share. Every whole stack
 *  passes through a thread's entry point, so this share is near total when
 *  the stacks resolved. */
function largestInclusiveOf(report: string): { percent: number; symbol: string } | null {
  for (const line of report.split("\n")) {
    const m = /^\s*([\d.]+)%\s+[\d.]+%\s+.*?\[[.k]\]\s+(.+)$/.exec(line);
    if (m !== null) return { percent: Number(m[1] ?? "0"), symbol: (m[2] ?? "").trim() };
  }
  return null;
}

/** A sampled profile of the workload rounds are measured on: self time
 *  always, inclusive time when call stacks are recorded. The configuration
 *  comes from the same builder `round` uses, so the profile and the
 *  measurement cannot name different work. Stacks are walked by frame
 *  pointer, which the build configuration keeps in every binary. */
async function recordProfile(cfg: PerfConfig, binary: string, wallSec: number, callGraph: boolean): Promise<ProfileSnapshot> {
  const dir = path.join(WORK_DIR, "profile");
  const configPath = `${dir}.config.json`;
  const perfData = `${dir}.perf.data`;
  const failed = (text: string, demangled = false): ProfileSnapshot => ({ ok: false, text, inclusive: null, largestInclusive: null, demangled });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  workloadConfig(resolveRoot(cfg.campaignTemplate), configPath, PROFILE_SEED, wallSec);
  try {
    // Plain cycles, not perf's default precise event: on this host the precise
    // event takes the call stack after the sampled instruction has moved on,
    // so inclusive shares and callers would describe whatever ran next.
    const rec = await run("perf", [
      "record", "-e", "cycles", "-F", String(PROFILE_HZ), ...(callGraph ? ["--call-graph", "fp"] : []), "-o", perfData, "--",
      binary, "explore", "-e", "campaign", "--config", configPath, "-y", "--output-dir", dir,
      resolveRoot(cfg.spec),
    ], {
      timeoutMs: wallSec * 1000 + PROFILE_TAIL_MS,
      cwd: ROOT,
      env: { ...process.env, RAYON_NUM_THREADS: String(cfg.budgets.rayonThreads), RUST_LOG: "warn" },
    });
    // A nonzero exit that still left samples behind is reportable; nothing
    // written is not, and a killed recorder is the usual way that happens.
    if (!fs.existsSync(perfData)) {
      return failed(`perf record wrote no samples${rec.timedOut ? " before the cap" : ""}: ${rec.stderr.slice(-400)}`);
    }
    const rep = await run("perf", [
      "report", "--stdio", "--percent-limit", String(PROFILE_PERCENT_LIMIT),
      "--no-children", "--no-inline", "-g", "none", "-i", perfData,
    ], { timeoutMs: PROFILE_REPORT_MS, cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
    if (!rep.ok) return failed(`perf report failed: ${rep.stderr.slice(-400)}`);
    const flat = demangle(rep.stdout);
    const text = reportLines(flat.text);
    if (text.split("\n").filter((l) => l.trim().length > 0 && !l.startsWith("#")).length === 0) {
      return failed("perf report carries no symbol above the cutoff", flat.demangled);
    }
    if (!callGraph) return { ok: true, text, inclusive: null, largestInclusive: null, demangled: flat.demangled };
    const inc = await run("perf", [
      "report", "--stdio", "--percent-limit", String(PROFILE_PERCENT_LIMIT),
      "--children", "--no-inline", "-g", "none", "-i", perfData,
    ], { timeoutMs: PROFILE_REPORT_MS, cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
    if (!inc.ok) return failed(`perf report of inclusive time failed: ${inc.stderr.slice(-400)}`, flat.demangled);
    const inclusive = reportLines(demangle(inc.stdout).text);
    return { ok: true, text, inclusive, largestInclusive: largestInclusiveOf(inclusive), demangled: flat.demangled };
  } finally {
    fs.rmSync(perfData, { force: true });
    fs.rmSync(configPath, { force: true });
    try { cleanupDir(dir); } catch { /* the directory may never have been created */ }
    for (const sib of [".session.json", ".utilization.json", ".campaign.json", ".log"]) fs.rmSync(`${dir}${sib}`, { force: true });
  }
}

// A profile is named after the checkout its binary was built in, so two
// binaries never share a file. A binary copied out of its checkout carries no
// such link and must be named; its tree label is then the main tree's, the
// commit a candidate is built on.
function profileLabelOf(binary: string, spurFlag: string | undefined, name: string | undefined): string {
  const checkout = path.resolve(spurFlag ?? path.join(binary, "..", "..", ".."));
  const isCheckout = fs.existsSync(path.join(checkout, "Cargo.toml"));
  if (spurFlag !== undefined && !isCheckout) throw new Error(`--spur ${checkout} does not look like a spur checkout (no Cargo.toml)`);
  if (!isCheckout && name === undefined) {
    throw new Error(`${binary} is not inside a spur checkout; pass --name <slug>, and --spur <dir> if it was not built on the main tree`);
  }
  const tree = spurLabelOf(isCheckout ? checkout : path.join(ROOT, "spur"));
  return name === undefined ? tree : `${tree}-${name}`;
}

async function cmdProfile(flags: Map<string, string>): Promise<void> {
  const cfg = perfConfig();
  refuseIfLoopActive();
  diskGuard(policyFor());
  const binary = path.resolve(flags.get("binary") ?? path.join(ROOT, "spur", "target", "release", "spur"));
  if (!fs.existsSync(binary)) throw new Error(`${binary} does not exist; build it first`);
  const wallSec = Number(flags.get("wall-sec") ?? cfg.budgets.profileWallSec);
  if (!Number.isFinite(wallSec) || wallSec <= 0) throw new Error(`--wall-sec must be a positive number of seconds, got ${flags.get("wall-sec")}`);
  const callGraphMode = flags.get("call-graph") ?? "fp";
  if (callGraphMode !== "fp" && callGraphMode !== "none") throw new Error(`--call-graph must be fp or none, got ${callGraphMode}`);
  const name = flags.get("name");
  if (name !== undefined && !/^[a-z0-9][a-z0-9-]{1,60}$/.test(name)) throw new Error(`--name must be a kebab-case slug, got ${name}`);
  const label = profileLabelOf(binary, flags.get("spur"), name);
  const file = path.join(PROFILE_DIR, `${label}.md`);
  if (fs.existsSync(file) && flags.get("force") !== "true") {
    throw new Error(`${path.relative(ROOT, file)} already exists; pass --name to label a different binary, or --force to replace it`);
  }
  const paranoid = paranoidLevel();
  if (paranoid !== null && paranoid > 2) {
    throw new Error(`kernel.perf_event_paranoid is ${paranoid}; perf record needs 2 or lower (sysctl -w kernel.perf_event_paranoid=1)`);
  }
  const snap = await recordProfile(cfg, binary, wallSec, callGraphMode === "fp");
  if (!snap.ok) {
    emit({ phase: "error", file: null, spur: label, ok: false, detail: snap.text });
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const largest = snap.largestInclusive;
  fs.writeFileSync(file, [
    `# Profile: spur ${label}`,
    "",
    `Binary: ${path.relative(ROOT, binary)}. Workload: ${cfg.campaignTemplate} under the campaign explorer on ${cfg.spec}, ${cfg.budgets.rayonThreads} threads, ${wallSec}s. Event: cycles.`,
    snap.demangled ? "" : "Symbols are mangled: rustfilt is not on PATH.",
    "",
    "## Self time",
    "",
    "Flat sampled profile, symbols above the reporter's cutoff.",
    "",
    "```",
    snap.text.trimEnd(),
    "```",
    "",
    ...(snap.inclusive === null ? [] : [
      "## Inclusive time",
      "",
      "Each symbol's share includes everything it calls, read from frame-pointer call stacks. An inlined callee has no frame of its own and is counted in its caller.",
      largest === null
        ? "No row carries an inclusive share, so the call stacks did not resolve."
        : `Largest inclusive share: ${largest.percent}% in ${largest.symbol}. A share well below total means broken stacks, and the rows under it are then unreliable.`,
      "",
      "```",
      snap.inclusive.trimEnd(),
      "```",
      "",
    ]),
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n"));
  emit({
    phase: "finished", file: path.relative(ROOT, file), spur: label, ok: true, binary: path.relative(ROOT, binary),
    wallSec, threads: cfg.budgets.rayonThreads, callGraph: callGraphMode, largestInclusive: largest,
    demangled: snap.demangled, lines: snap.text.split("\n").length,
  });
}

// ---------------------------------------------------------------------------
// Selftest
// ---------------------------------------------------------------------------

/** A cell table with a known treated/untreated split, for the fixtures. */
function fixtureCells(spec: Array<{ variant: number; runs: number; us: number; steps: number; arm?: string }>): VariantMetrics[] {
  return spec.map((s) => ({
    arm: s.arm ?? "grid", variant: s.variant, runs: s.runs, gradedRuns: 0, depthAtLeast: [], violations: 0,
    wallUsSum: s.us * s.runs, stepsUsedSum: s.steps * s.runs, planCompleteRuns: s.runs,
  }));
}

function fixtureMeasurement(
  workload: Workload, side: Side, seed: number, runs: number, wallMs: number, usPerRun: number, stepsPerRun: number,
  cells: VariantMetrics[], counters: Record<string, number>,
): Measurement {
  return {
    workload, side, seed, wallMs, runs, rps: runs / (wallMs / 1000), rows: runs, usPerRun, stepsPerRun,
    endReasons: { plan_complete: runs }, armRuns: { grid: runs }, cells, counters,
  };
}

async function cmdSelftest(): Promise<void> {
  const cfg = perfConfig();
  const failures: string[] = [];
  const warnings: string[] = [];
  const check = (c: boolean, m: string): void => { if (!c) failures.push(m); };

  // Instrument selection. Both refusals happen at start, before a round is
  // bought, because both would otherwise be discovered as a reading nobody
  // can interpret.
  const shared = selectInstrument({ sharing: "shared", requested: "within-binary", treatmentBit: 1, counter: "a.b" });
  check("refusal" in shared, "a session declared shared must be refused a within-binary primary");
  const noBit = selectInstrument({ sharing: "private", requested: null, treatmentBit: null, counter: null });
  check("refusal" in noBit, "a session declared private must be refused when it registers no treatment bit");
  const privateOk = selectInstrument({ sharing: "private", requested: null, treatmentBit: 1, counter: null });
  check("primary" in privateOk && privateOk.primary === "within-binary", "a private declaration with a bit reads on the within-binary contrast");
  const sharedOk = selectInstrument({ sharing: "shared", requested: null, treatmentBit: null, counter: "alloc.bytes" });
  check("primary" in sharedOk && sharedOk.primary === "counter", "a shared declaration with a named counter reads on that counter");
  const sharedNoCounter = selectInstrument({ sharing: "shared", requested: null, treatmentBit: null, counter: null });
  check("refusal" in sharedNoCounter, "a shared declaration with no named counter must be refused the counter primary");
  const fallback = selectInstrument({ sharing: "shared", requested: "cross-binary", treatmentBit: null, counter: null });
  check("primary" in fallback && fallback.primary === "cross-binary", "a shared declaration may fall back to the cross-binary read");

  // The ratio statistics, on known numbers.
  const flat = ratioOf([1, 1, 1]);
  check(Math.abs(flat.mean - 1) < 1e-12 && flat.lo === 1 && flat.hi === 1, `three unit ratios must read exactly one, got ${JSON.stringify(flat)}`);
  const doubling = ratioOf([2, 2, 2]);
  check(Math.abs(doubling.mean - 2) < 1e-12 && doubling.dominant, `three doublings must read two and be dominant, got ${doubling.mean}`);
  const mixed = ratioOf([0.9, 1.1, 1.0]);
  check(!mixed.dominant, "ratios straddling one are not dominant");
  check(separates(ratioOf([1.2, 1.25, 0.99, 1.22, 1.23, 1.21]), 0.05), "a clear move with one round across one separates on its interval");
  check(Math.abs(ratioOf([1, 4]).mean - 2) < 1e-12, "the mean of ratios is geometric");
  check(!separates(ratioOf([1.001, 1.002, 1.0015]), 0.01), "a move under the floor does not separate");
  check(separates(ratioOf([1.2, 1.22, 1.18]), 0.01), "an agreed move well clear of the floor separates");
  check(bandReadingOf(ratioOf([1.2, 1.21, 1.19]), { min: 1.05, max: 1.5 }) === "inside", "a reading inside the frozen band reads inside");
  check(bandReadingOf(ratioOf([1.001, 1.002, 1.0005]), { min: 1.05, max: 1.5 }) === "below", "a reading whose interval lies under the band reads below");

  // The within-binary contrast, on cells whose treated side costs a known
  // fraction of the untreated side's microseconds per run.
  const cells = fixtureCells([
    { variant: 1024, runs: 500, us: 800, steps: 100 },
    { variant: 0, runs: 500, us: 1000, steps: 100 },
  ]);
  const w = withinBinary(cells, 1024);
  check(w.applies && Math.abs(w.usRatio - 1.25) < 1e-12, `treated runs at four fifths of the cost must read 1.25, got ${JSON.stringify(w)}`);
  check(Math.abs(w.treatedShare - 0.5) < 1e-12, `an even split must read a treated share of a half, got ${w.treatedShare}`);
  check(Math.abs(w.stepsRatio - 1) < 1e-12, "equal steps per run must read one");
  const probed = withinBinary(fixtureCells([
    { variant: 1024, runs: 500, us: 800, steps: 100 },
    { variant: 1024 | 2, runs: 500, us: 10_000, steps: 100 },
    { variant: 0, runs: 500, us: 1000, steps: 100 },
  ]), 1024);
  check(Math.abs(probed.usRatio - 1.25) < 1e-12, `run-cap probes must leave the contrast, got ${probed.usRatio}`);
  const nested = withinBinary(fixtureCells([
    { variant: 1024 | 1, runs: 400, us: 800, steps: 100 },
    { variant: 1, runs: 400, us: 1000, steps: 100 },
    { variant: 0, runs: 400, us: 4000, steps: 100 },
  ]), 1024);
  check(nested.matchedOnMask === 1 && Math.abs(nested.usRatio - 1.25) < 1e-12, `a nested bit must match on its host co-bit, got mask ${nested.matchedOnMask} ratio ${nested.usRatio}`);
  const empty = withinBinary(fixtureCells([{ variant: 0, runs: 100, us: 1000, steps: 100 }]), 1024);
  check(!empty.applies, "a bit no run carries has no within-binary contrast");

  // A synthetic session: three rounds, the candidate a known tenth faster,
  // its treated runs a known fifth cheaper, and its declared counter down by
  // a known half.
  const synthRounds: Measurement[][] = [0, 1, 2].map((i) => [
    fixtureMeasurement("campaign", "base", 1000 + i, 1000, 100_000, 1000, 100, fixtureCells([{ variant: 0, runs: 1000, us: 1000, steps: 100 }]), { "alloc.count": 4000 }),
    fixtureMeasurement("campaign", "cand", 1000 + i, 1100, 100_000, 900, 100, cells, { "alloc.count": 2200 }),
  ]);
  const synthState: SessionState = {
    name: "selftest-synthetic", createdAtIso: new Date().toISOString(), note: "",
    declaration: { search: "neutral", sharing: "private", primary: "within-binary", treatment: { bit: 1024, name: "stallCap" }, band: { min: 1.1, max: 1.4 }, counter: "alloc.count", argument: "the cap is a per-run budget no random draw is consumed from" },
    cand: { bin: "", template: "", spec: cfg.spec, spurLabel: "" },
    base: { bin: "", template: "", spurDir: "" },
    identity: { spurTree: "t", buildConfigSha: "b", campaignSha: "c", specSha: "s", rayonThreads: 1, campaignWallSec: 1 },
    cacheFile: path.join(BASELINE_DIR, "selftest-absent.json"),
    limits: { campaignWallSec: 1, minRounds: cfg.budgets.minRounds, maxRounds: cfg.budgets.maxRounds, rayonThreads: 1 },
    rounds: [], finished: false,
  };
  const reading = buildReading(synthState, cfg, synthRounds);
  const campaign = reading.workloads[0];
  check(reading.workloads.length === 1, `a reading carries the campaign workload alone, got ${reading.workloads.length} workloads`);
  check(campaign !== undefined && Math.abs(campaign.rps.mean - 1.1) < 1e-9, `the campaign workload must read a tenth more runs per second, got ${campaign?.rps.mean}`);
  check(campaign !== undefined && Math.abs((campaign.usPerRun.mean) - 1000 / 900) < 1e-9, `microseconds per run must read the baseline over the candidate, got ${campaign?.usPerRun.mean}`);
  check(campaign !== undefined && Math.abs(campaign.stepsPerRun.mean - 1) < 1e-9, "steps per run must read one when neither side moved");
  check(reading.primary !== null && reading.primary.kind === "within-binary" && Math.abs(reading.primary.ratio.mean - 1.25) < 1e-9,
    `the primary must be the within-binary contrast at 1.25, got ${JSON.stringify(reading.primary?.ratio.mean)}`);
  check(reading.primary?.bandReading === "inside", `1.25 must read inside the frozen band [1.1, 1.4], got ${reading.primary?.bandReading}`);
  check(reading.counter !== null && Math.abs(reading.counter.ratio.mean - 2) < 1e-9, `the declared counter must read a halving as two, got ${reading.counter?.ratio.mean}`);
  check(reading.counter?.presentOnBothSides === true, "a counter present on both sides is not a blocker");
  check(reading.adviceVerdict === "gain", `the synthetic session must read a gain, got ${reading.adviceVerdict}: ${reading.adviceReason}`);
  check(reading.blockers.length === 0, `a neutral session whose observables held their distributions owes nothing, got ${JSON.stringify(reading.blockers)}`);

  // The same session read on a primary its declaration refuses to support.
  const noReading = buildReading({ ...synthState, declaration: { ...synthState.declaration, treatment: null, primary: "within-binary" } }, cfg, synthRounds);
  check(noReading.primary === null && noReading.adviceVerdict === "no-reading", `a within-binary primary with no bit produces no reading, got ${noReading.adviceVerdict}`);

  // Fewer rounds than the floor is inconclusive whatever the numbers say.
  const thin = buildReading(synthState, cfg, synthRounds.slice(0, 1));
  check(thin.adviceVerdict === "inconclusive", `one round must read inconclusive, got ${thin.adviceVerdict}`);

  // A slower candidate reads as a regression, not as a gain.
  const slowRounds: Measurement[][] = synthRounds.map((r) => r.map((m) => (m.side === "cand"
    ? { ...m, rps: m.rps / 1.3, usPerRun: m.usPerRun * 1.3, cells: fixtureCells([{ variant: 1024, runs: 500, us: 1300, steps: 100 }, { variant: 0, runs: 500, us: 1000, steps: 100 }]) }
    : m)));
  const slow = buildReading(synthState, cfg, slowRounds);
  check(slow.adviceVerdict === "refuted", `a slower candidate that declared a band must read refuted, got ${slow.adviceVerdict}`);
  check(slow.primary?.bandReading === "below", `a slower candidate must read below its frozen band, got ${slow.primary?.bandReading}`);
  const slowNoBand = buildReading({ ...synthState, declaration: { ...synthState.declaration, band: null } }, cfg, slowRounds);
  check(slowNoBand.adviceVerdict === "regressed", `a slower candidate with no frozen band must read regressed, got ${slowNoBand.adviceVerdict}`);

  // The spread check reads a moved observable against the baseline's own
  // round-to-round spread, and is silent when nothing moved.
  const steady = spreadCheck("steps per run", [100, 100, 100], [100.1, 99.9, 100.0], cfg.floors.spreadMultiple, cfg.floors.minEffect);
  check(steady.within, `an unmoved observable must sit inside the baseline spread, got ${JSON.stringify(steady)}`);
  const moved = spreadCheck("steps per run", [140, 140, 140], [100.1, 99.9, 100.0], cfg.floors.spreadMultiple, cfg.floors.minEffect);
  check(!moved.within, `an observable moved well past the baseline spread must read outside, got ${JSON.stringify(moved)}`);

  // The same check on a whole session: it blocks the candidate that declared
  // the search unchanged, and is reported without blocking the one that
  // admits the search moves.
  const movedRounds = synthRounds.map((r) => r.map((m) => (m.side === "cand" ? { ...m, stepsPerRun: m.stepsPerRun * 1.4 } : m)));
  const neutralMoved = buildReading(synthState, cfg, movedRounds);
  check(neutralMoved.blockers.some((b) => b.includes("campaign steps per run")), `a neutral candidate whose steps per run left the baseline spread must block, got ${JSON.stringify(neutralMoved.blockers)}`);
  const affectingMoved = buildReading({ ...synthState, declaration: { ...synthState.declaration, search: "affecting" } }, cfg, movedRounds);
  check(affectingMoved.searchNeutrality.some((c) => !c.within), "the spread check is computed whatever the declaration says");
  check(!affectingMoved.blockers.some((b) => b.includes("outside the baseline")), "a candidate that admits the search moves is not blocked by the spread check");
  check(affectingMoved.blockers.some((b) => b.includes("non-inferiority")), "a candidate that admits the search moves owes the search loop's reading");

  // The counter path: a counter the dump does not carry blocks, and one that
  // did not move blocks.
  const missing = buildReading(
    { ...synthState, declaration: { ...synthState.declaration, counter: "absent.counter" } },
    cfg,
    synthRounds,
  );
  check(missing.blockers.some((b) => b.includes("absent.counter")), "a counter absent from the dump must block");
  const flatCounter = buildReading(synthState, cfg, synthRounds.map((r) => r.map((m) => ({ ...m, counters: { "alloc.count": m.rows * 4 } }))));
  check(flatCounter.blockers.some((b) => b.includes("did not move")), "a counter that did not move must block");

  // The utilization dump is nested; the counter names the loop declares are
  // its dotted paths.
  const flatty = flatCounters({ termination: { runs: 5, nested: { deep: 2 } }, name: "ignored", list: [1, 2] });
  check(flatty["termination.runs"] === 5 && flatty["termination.nested.deep"] === 2 && Object.keys(flatty).length === 2,
    `the counter flattener must keep scalars under dotted paths, got ${JSON.stringify(flatty)}`);

  // The baseline cache identity: what makes two measurements the same
  // quantity, and nothing else.
  const idA: BaselineIdentity = { spurTree: "aaaaaaaaaaaa", buildConfigSha: "bbbbbbbb", campaignSha: "cccccccc", specSha: "ssssssss", rayonThreads: 30, campaignWallSec: 120 };
  check(identityKey(idA) === identityKey({ ...idA }), "an identity is its own key");
  check(identityKey(idA) !== identityKey({ ...idA, rayonThreads: 29 }), "a different thread count is a different quantity");
  check(identityKey(idA) !== identityKey({ ...idA, specSha: "tttttttt" }), "a different spec is a different quantity");
  check(cacheFileFor(idA) !== cacheFileFor({ ...idA, campaignWallSec: 240 }), "a different campaign wall budget writes a different cache file");
  check(identityKey(idA) !== identityKey({ ...idA, buildConfigSha: "ffffffff" }), "a different build configuration is a different quantity");
  check(cacheFileFor(idA) !== cacheFileFor({ ...idA, buildConfigSha: "ffffffff" }), "a different build configuration writes a different cache file");

  // Profile names: one file per binary, and a binary with no checkout of its
  // own is named by its caller.
  const mainBinary = path.join(ROOT, "spur", "target", "release", "spur");
  check(profileLabelOf(mainBinary, undefined, undefined) === spurLabelOf(path.join(ROOT, "spur")), "a binary inside the main checkout is named after that checkout");
  check(profileLabelOf(mainBinary, undefined, "cand-x").endsWith("-cand-x"), "a named profile carries its name");
  let unnamedRefused = false;
  try { profileLabelOf(path.join(WORK_DIR, "x", "cand-spur"), undefined, undefined); } catch { unnamedRefused = true; }
  check(unnamedRefused, "a binary outside any checkout must be named");
  const inclusiveFixture = ["# Children      Self  Command  Shared Object  Symbol", "    84.27%     0.00%  spur     spur           [.] main", "    10.00%    10.00%  spur     spur           [.] eval"].join("\n");
  check(largestInclusiveOf(inclusiveFixture)?.percent === 84.27, "the largest inclusive share is the first row of a children-sorted report");

  // Configuration and tools.
  for (const [label, p] of [
    ["goal file", cfg.goalFile], ["spec", cfg.spec], ["campaign template", cfg.campaignTemplate],
  ] as const) {
    if (!fs.existsSync(resolveRoot(p))) failures.push(`the configured ${label} ${p} is missing`);
  }
  if (fs.existsSync(resolveRoot(cfg.campaignTemplate)) && !templateHasCampaign(resolveRoot(cfg.campaignTemplate))) {
    failures.push(`the configured campaign template ${cfg.campaignTemplate} carries no campaign block`);
  }
  // The profile and a round are built by one function, so a profile cannot
  // name work the measurement does not do.
  if (fs.existsSync(resolveRoot(cfg.campaignTemplate))) {
    const probe = path.join(WORK_DIR, "selftest.config.json");
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    try {
      workloadConfig(resolveRoot(cfg.campaignTemplate), probe, PROFILE_SEED, cfg.budgets.profileWallSec);
      const built = JSON.parse(fs.readFileSync(probe, "utf8")) as Record<string, unknown>;
      const campaign = built["campaign"] as { wall_budget_sec?: number; arms?: unknown[] } | undefined;
      check(campaign?.wall_budget_sec === cfg.budgets.profileWallSec, "the profile's wall budget must reach the campaign block");
      check((campaign?.arms ?? []).length > 0, "the profile's configuration must keep the campaign arms");
    } finally {
      fs.rmSync(probe, { force: true });
    }
  }
  if (cfg.budgets.profileWallSec <= 0) failures.push("profileWallSec must be a positive number of seconds");

  const tool = path.join(ROOT, "traceanalyzer", "main");
  if (!fs.existsSync(tool)) failures.push(`${tool} is missing; build it with: cd traceanalyzer && go build -o main main.go`);
  if (cfg.budgets.minRounds < 2) failures.push("minRounds under two leaves no round-to-round spread to read an interval from");
  if (cfg.budgets.minRounds > cfg.budgets.maxRounds) failures.push("minRounds is above maxRounds");
  if (cfg.floors.layoutFloor < cfg.floors.minEffect) {
    warnings.push("the layout floor is under the minimum effect, so a cross-binary reading is held to the smaller of the two");
  }
  // Git does not carry an empty directory, so a fresh checkout has none of
  // these; they are created rather than reported.
  for (const dir of [STATE_DIR, BASELINE_DIR, PROFILE_DIR]) fs.mkdirSync(dir, { recursive: true });

  // A roster bit whose tag is not in the explorer's source names a
  // population no round can carry; a live session declaring one is an error.
  const missingBits = variantBitsMissingFromSource();
  if (missingBits.length > 0) warnings.push(`VARIANT_BITS entries with no tag in run_variant.rs: ${missingBits.join(", ")}`);
  if (fs.existsSync(STATE_DIR)) {
    for (const f of fs.readdirSync(STATE_DIR).filter((x) => x.endsWith(".json"))) {
      let st: SessionState;
      try { st = loadState(path.basename(f, ".json")); } catch { continue; }
      const bit = st.declaration?.treatment?.bit;
      if (bit === undefined || st.finished) continue;
      if (missingBits.some((m) => m.endsWith(`(${bit})`))) {
        failures.push(`live session ${st.name} declares bit ${bit}, whose tag is not in run_variant.rs`);
      }
    }
  }

  emit({
    phase: failures.length === 0 ? "finished" : "error",
    failures, warnings,
    floors: cfg.floors,
    budgets: cfg.budgets,
    profiles: fs.existsSync(PROFILE_DIR) ? fs.readdirSync(PROFILE_DIR).filter((f) => f.endsWith(".md")).length : 0,
    baselineCaches: fs.existsSync(BASELINE_DIR) ? fs.readdirSync(BASELINE_DIR).filter((f) => f.endsWith(".json")).length : 0,
  });
  if (failures.length > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "";
  const flags = new Map<string, string>();
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === "force") {
      flags.set(key, "true");
      continue;
    }
    const v = argv[++i];
    if (v === undefined) throw new Error(`--${key} needs a value`);
    flags.set(key, v);
  }
  switch (cmd) {
    case "start": await cmdStart(flags); break;
    case "round": await cmdRound(flags); break;
    case "status": await cmdStatus(flags); break;
    case "finish": await cmdFinish(flags); break;
    case "baseline": await cmdBaseline(flags); break;
    case "profile": await cmdProfile(flags); break;
    case "selftest": await cmdSelftest(); break;
    default:
      throw new Error(`unknown command ${cmd || "(none)"}; use start|round|status|finish|baseline|profile|selftest`);
  }
}

main().catch((err: unknown) => {
  emit({ phase: "error", verdict: "error", reason: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
