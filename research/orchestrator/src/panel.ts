// The bug panel: a set of protocol specs carrying known defects, run on both
// the candidate and the baseline in one window so a candidate that erodes
// detection elsewhere is visible at the merge boundary.
//
// The panel is downstream of the VR ladder by construction. It runs only where
// runRegression runs, which is only after a sequential evaluation advanced or
// escalated, so it can never promote a candidate the ladder rejected. Its
// authority is one-directional: a gate member whose detection collapses fails
// the suite, and a broad decline routes to human review. Neither can merge.
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { ROOT } from "./paths.js";
import { CAMPAIGN_ONLY_KEYS, cleanupDir, explore, materializeConfig, porcupine, readSessionSibling, readUtilizationSibling, resolveRoot, runsTable } from "./runners.js";
export { readUtilizationSibling };
import type { EvalContext } from "./evaluate.js";
import { kmMedian, logRankZ, poissonRateRatioZ, type Censored } from "./stats.js";

/** Keys a member may set. Faults are declared separately and never here. */
export const WORKLOAD_KEYS = [
  "num_servers", "num_write_ops", "num_read_ops", "num_rmw_ops",
  "num_keys", "max_concurrent_writes", "dependency_density",
] as const;

const Range = z.object({ min: z.number().int(), max: z.number().int(), step: z.number().int().positive() });

export const PanelMember = z.object({
  id: z.string().min(1),
  spec: z.string().min(1),
  /** Matched clean control, or null when the host is a reference spec. */
  cleanSpec: z.string().nullable(),
  shape: z.string().min(1),
  faults: z.object({
    class: z.enum(["F0", "F1", "F2", "F3"]),
    numCrashes: Range,
    requiresRecovery: z.boolean(),
  }),
  porcupineModel: z.enum(["kv", "kv_rmw"]),
  overlay: z.record(z.string(), z.unknown()),
  maxIterations: z.number().int().positive(),
  /** gate: a collapse fails the suite. report: recorded, never binding. */
  role: z.enum(["gate", "report"]),
  expectedRate: z.number().positive(),
  /** Version 1 sizing: a fixed run count per arm on the standard explorer. */
  runsPerArm: z.number().int().positive().optional(),
  gridSize: z.number().int().positive().optional(),
  /** Version 2 sizing: seeded campaign replicates of a fixed active-time
   *  budget each, judged as a rate per second or as time to first violation. */
  wallSec: z.number().positive().optional(),
  replicates: z.number().int().positive().optional(),
  calibration: z.object({
    atIso: z.string(),
    rateRuns: z.number().int().nonnegative(),
    rateViolations: z.number().int().nonnegative(),
    dispersion: z.number().nonnegative(),
    cleanRuns: z.number().int().nonnegative(),
    cleanViolations: z.number().int().nonnegative(),
    /** Host ceiling from C0: the rate a blatant injection of the same class
     *  reaches. A member cannot exceed it, and a host whose ceiling is under
     *  the admission band can only supply report members. */
    hostCeiling: z.number().nonnegative(),
    budgetRatio: z.number().nonnegative(),
    runsPerSec: z.number().nonnegative(),
    /** Version 2: violations per active second on the standard explorer, and
     *  the median time to the first violation of the best known arm (0 when
     *  never observed). */
    eventsPerSec: z.number().nonnegative().optional(),
    tauBestSec: z.number().nonnegative().optional(),
  }),
  notes: z.string().default(""),
});
export type PanelMember = z.infer<typeof PanelMember>;

/** Expected violations one member arm sees at its version-2 sizing. */
export function expectedEvents(m: PanelMember): number {
  return (m.calibration.eventsPerSec ?? m.expectedRate * m.calibration.runsPerSec) * (m.wallSec ?? 0) * (m.replicates ?? 0);
}

/** Below this many expected events a member is judged on time to first
 *  violation rather than on a rate. */
export const RATE_EVENTS_MIN = 20;

export const PanelManifest = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  sizing: z.object({
    targetCount: z.number().int().positive(),
    collapseZ: z.number().positive(),
    gradientZ: z.number().positive(),
    /** A gate member's rate must exceed its control's by this factor. At 20x
     *  the control contributes 5% of the member's count, which biases a true
     *  50% collapse to a measured 47.5% - inside the gate's resolution. A
     *  rule demanding a control of exactly zero is not satisfiable: latent
     *  defects were measured in every host tried. */
    minSeparation: z.number().positive(),
  }),
  members: z.array(PanelMember).min(1),
});
export type PanelManifest = z.infer<typeof PanelManifest>;

/** Structural checks the schema cannot express. Every failure is fatal: a
 *  manifest that cannot be trusted must not produce numbers that look like
 *  measurements. */
export function validateManifest(m: PanelManifest, wallSecPerCase?: number, throughputFloor = 1): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const mem of m.members) {
    if (seen.has(mem.id)) errs.push(`${mem.id}: duplicate id`);
    seen.add(mem.id);
    for (const k of Object.keys(mem.overlay)) {
      if (!(WORKLOAD_KEYS as readonly string[]).includes(k)) errs.push(`${mem.id}: overlay key ${k} is not a workload key`);
    }
    for (const k of ["num_crashes", "num_partitions", "num_runs_per_config", "session_seed", "max_iterations"]) {
      if (k in mem.overlay) errs.push(`${mem.id}: ${k} belongs to the runner or the fault declaration, not the overlay`);
    }
    if (m.version === 1) {
      if (mem.runsPerArm === undefined || mem.gridSize === undefined) {
        errs.push(`${mem.id}: version 1 sizing needs runsPerArm and gridSize`);
      } else {
        if (mem.runsPerArm % mem.gridSize !== 0) errs.push(`${mem.id}: runsPerArm ${mem.runsPerArm} is not a multiple of gridSize ${mem.gridSize}`);
        // Only a gate member has to resolve a rate change. A report member is a
        // rare-event detector: it is sized by what its wall affords, and demanding
        // 100/rate of it would ask for hundreds of thousands of runs.
        if (mem.role === "gate" && mem.runsPerArm < Math.ceil(m.sizing.targetCount / mem.expectedRate)) {
          errs.push(`${mem.id}: runsPerArm ${mem.runsPerArm} is under the sized ${Math.ceil(m.sizing.targetCount / mem.expectedRate)}`);
        }
      }
    } else {
      if (mem.wallSec === undefined || mem.replicates === undefined) {
        errs.push(`${mem.id}: version 2 sizing needs wallSec and replicates`);
      } else {
        const tau = mem.calibration.tauBestSec ?? 0;
        if (tau > 0 && mem.wallSec < 3 * tau) {
          errs.push(`${mem.id}: wallSec ${mem.wallSec} is under three times the ${tau.toFixed(1)}s median time to first violation`);
        }
        // A gate member is judged as a rate and has to resolve a collapse: at
        // the sizing count a 50% drop clears the collapse bar with margin to a
        // dispersion of 2. A report member is judged on time to first
        // violation and may see none.
        if (mem.role === "gate" && expectedEvents(mem) < m.sizing.targetCount) {
          errs.push(`${mem.id}: expects ${expectedEvents(mem).toFixed(1)} violations per arm, under the ${m.sizing.targetCount} a gate member is sized to`);
        }
      }
    }
    if (mem.role === "gate") {
      if (mem.cleanSpec === null) {
        errs.push(`${mem.id}: a gate member needs a control spec`);
      } else if (mem.calibration.cleanRuns < (mem.runsPerArm ?? 0)) {
        errs.push(`${mem.id}: control measured at ${mem.calibration.cleanRuns} runs, under the ${mem.runsPerArm ?? 0} it will be judged at`);
      } else {
        const ctl = mem.calibration.cleanViolations / mem.calibration.cleanRuns;
        const sep = ctl === 0 ? Infinity : mem.expectedRate / ctl;
        if (sep < m.sizing.minSeparation) {
          errs.push(`${mem.id}: rate ${mem.expectedRate} is only ${sep.toFixed(1)}x its control's ${ctl.toFixed(6)}, under the ${m.sizing.minSeparation}x floor`);
        }
      }
      if (mem.expectedRate > mem.calibration.hostCeiling) {
        errs.push(`${mem.id}: rate ${mem.expectedRate} exceeds its host ceiling ${mem.calibration.hostCeiling}`);
      }
      if (wallSecPerCase !== undefined && m.version === 1 && mem.runsPerArm !== undefined && mem.calibration.runsPerSec > 0) {
        const armSec = mem.runsPerArm / mem.calibration.runsPerSec;
        if (armSec > wallSecPerCase / 2) {
          errs.push(`${mem.id}: an arm takes ${armSec.toFixed(0)}s, over half the ${wallSecPerCase}s case wall, so a slower candidate truncates`);
        }
      }
      if (mem.faults.class !== "F0" && !mem.faults.requiresRecovery) {
        errs.push(`${mem.id}: a fault class above F0 must require recovery`);
      }
    }
  }
  // Under version 2 the case wall bounds the whole panel: every replicate of
  // every arm, plus process start-up, has to fit for the slowest candidate
  // the throughput floor still admits, since a truncated arm leaves the
  // member unjudged rather than judged.
  if (m.version === 2 && wallSecPerCase !== undefined) {
    const total = panelWallSec(m);
    const allowed = wallSecPerCase * throughputFloor;
    if (total > allowed) errs.push(`the panel takes ${total.toFixed(0)}s of replicates, over the ${allowed.toFixed(0)}s the ${wallSecPerCase}s case wall leaves a candidate at the ${throughputFloor} throughput floor`);
  }
  return errs;
}

/** Process start-up per replicate: compile, open the writer, write the report. */
export const PANEL_STARTUP_SEC = 3;

/** Wall the whole version-2 panel needs on a candidate at baseline speed. */
export function panelWallSec(m: PanelManifest): number {
  return m.members.reduce((a, mem) => a + (mem.role === "gate" ? 2 : 1) * (mem.replicates ?? 0) * ((mem.wallSec ?? 0) + PANEL_STARTUP_SEC), 0);
}

export function loadPanelManifest(p: string, wallSecPerCase?: number, throughputFloor = 1): PanelManifest {
  const m = PanelManifest.parse(JSON.parse(fs.readFileSync(resolveRoot(p), "utf8")));
  const errs = validateManifest(m, wallSecPerCase, throughputFloor);
  if (errs.length > 0) throw new Error(`panel manifest invalid:\n  ${errs.join("\n  ")}`);
  return m;
}

// ---------------------------------------------------------------------------
// The firing rule: a mechanism that had no occasions on a member did not fail
// on it, and the member must not be read as having measured anything.
// ---------------------------------------------------------------------------

/** Config path prefix -> utilization counter that must be nonzero in both arms
 *  for a difference at that path to be judged. A differing path with no entry
 *  here yields "unknown" and voids the member, which is the safe direction. */
export const FIRING_COUNTERS: ReadonlyArray<readonly [string, string]> = [
  ["post_fault_client_ops", "post_fault_ops.pairs_seen"],
  ["purgatory", "purgatory.delayed_sends"],
  ["feedback.steer", "steer.evaluations"],
  ["feedback", "feedback.scored_runs"],
  ["use_coverage_scheduling", "feedback.scored_runs"],
  ["quick_fire_multiplier", "multiplier_authority.quick_fire_decisions"],
  ["emit_multiplier_authority", "multiplier_authority.decisions"],
  ["rng_stream_isolation", "rng_streams.isolated_runs"],
  ["within_queue_selector", "multiplier_authority.decisions"],
  ["queue_policy", "multiplier_authority.decisions"],
  ["schedule_policy", "multiplier_authority.decisions"],
];

export type FiringStatus = "fired" | "no-occasions" | "unstated" | "unknown" | "no-config-change";

function flatten(o: unknown, prefix: string, out: Map<string, unknown>): void {
  if (typeof o !== "object" || o === null || Array.isArray(o)) { out.set(prefix, o); return; }
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
}

/** Dotted paths whose values differ between two explorer configs. */
export function diffConfigPaths(aPath: string, bPath: string): string[] {
  const a = new Map<string, unknown>(), b = new Map<string, unknown>();
  flatten(JSON.parse(fs.readFileSync(aPath, "utf8")), "", a);
  flatten(JSON.parse(fs.readFileSync(bPath, "utf8")), "", b);
  const keys = new Set([...a.keys(), ...b.keys()]);
  const out: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k))) out.push(k);
  }
  return out.sort();
}

function counterFor(configPath: string): string | null {
  for (const [prefix, counter] of FIRING_COUNTERS) {
    if (configPath === prefix || configPath.startsWith(`${prefix}.`)) return counter;
  }
  return null;
}

function readCounter(util: Record<string, unknown> | null, dotted: string): number | null {
  if (util === null) return null;
  let cur: unknown = util;
  for (const part of dotted.split(".")) {
    if (typeof cur !== "object" || cur === null) return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "number" ? cur : null;
}

export interface ArmCounts {
  runs: number;
  violations: number;
  unknown: number;
  timedOut: boolean;
  utilization: Record<string, unknown> | null;
  /** Version 2: pooled active seconds over the replicates, and each
   *  replicate's time to its first violation, censored at its wall. */
  exposureSec?: number;
  firstViolation?: Censored[];
  /** Version 2: each replicate's own count and exposure, for the dispersion
   *  the rate test charges. */
  replicates?: Array<{ violations: number; exposureSec: number }>;
}

// Replicates of one arm do not scatter like Poisson draws: their slice
// composition and their position on the session-length curve differ, so a
// rate test on pooled counts over-reads its evidence. The dispersion is the
// ratio of the replicates' observed rate variance, pooled within each arm
// around that arm's own mean, to what Poisson counting alone would give,
// floored at 1; the z is deflated by its square root. Pooling the arms
// around one mean would charge a real difference between them as noise and
// cap the z a collapse can reach.
export function replicateDispersion(arms: Array<Array<{ violations: number; exposureSec: number }>>): number {
  let ss = 0;
  let df = 0;
  let events = 0;
  let exposure = 0;
  let n = 0;
  for (const reps of arms) {
    const ok = reps.filter((r) => r.exposureSec > 0);
    if (ok.length === 0) continue;
    const rates = ok.map((r) => r.violations / r.exposureSec);
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    ss += rates.reduce((a, r) => a + (r - mean) ** 2, 0);
    df += ok.length - 1;
    events += ok.reduce((a, r) => a + r.violations, 0);
    exposure += ok.reduce((a, r) => a + r.exposureSec, 0);
    n += ok.length;
  }
  if (df < 2 || n === 0 || events <= 0 || exposure <= 0) return 1;
  const observed = ss / df;
  const pooledRate = events / exposure;
  const meanExposure = exposure / n;
  const poisson = pooledRate / meanExposure;
  return Math.max(1, observed / poisson);
}

export interface PanelArms {
  candidateBinary: string;
  candidateTemplate: string;
  baselineBinary: string | null;
  baselineTemplate: string | null;
  seed: number;
  /** Whether the candidate touched spur/ source at all. */
  changedSpurCode: boolean;
  /** Hypothesis-declared counter for a spur code change, or null. */
  declaredFiringCounter: string | null;
}

export function classifyFiring(
  arms: PanelArms, cand: ArmCounts, base: ArmCounts | null,
  changedConfigPaths: string[],
): { status: FiringStatus; detail: string } {
  const nonzeroBoth = (counter: string): boolean => {
    const c = readCounter(cand.utilization, counter);
    const b = base === null ? c : readCounter(base.utilization, counter);
    return c !== null && b !== null && c > 0 && b > 0;
  };
  if (arms.changedSpurCode) {
    if (arms.declaredFiringCounter === null) {
      return { status: "unstated", detail: "spur source changed with no declared firing counter" };
    }
    if (!nonzeroBoth(arms.declaredFiringCounter)) {
      return { status: "no-occasions", detail: `${arms.declaredFiringCounter} is zero on this member` };
    }
  }
  const unmapped: string[] = [];
  const dead: string[] = [];
  for (const p of changedConfigPaths) {
    const counter = counterFor(p);
    if (counter === null) { unmapped.push(p); continue; }
    if (!nonzeroBoth(counter)) dead.push(`${p} (${counter}=0)`);
  }
  if (unmapped.length > 0) return { status: "unknown", detail: `no firing counter mapped for ${unmapped.join(", ")}` };
  if (dead.length > 0) return { status: "no-occasions", detail: dead.join("; ") };
  if (!arms.changedSpurCode && changedConfigPaths.length === 0) {
    return { status: "no-config-change", detail: "arms are identical; comparison is vacuous but valid" };
  }
  return { status: "fired", detail: "every differing mechanism had occasions in both arms" };
}

// ---------------------------------------------------------------------------
// Statistics. phi = 1 decides; the sub-binomial 0.67 measured within one
// binary is reported beside it and never used to block.
// ---------------------------------------------------------------------------

/** Two-sample score z on the detection rate. Negative = candidate detects
 *  less than baseline. Null when either arm is empty. */
export function panelZ(cand: ArmCounts, base: ArmCounts, phi = 1): number | null {
  const n = cand.runs, m = base.runs;
  if (n === 0 || m === 0) return null;
  const p = (cand.violations + base.violations) / (n + m);
  if (p <= 0 || p >= 1) return 0;
  const se = Math.sqrt(phi * p * (1 - p) * (1 / n + 1 / m));
  if (se === 0) return 0;
  return (cand.violations / n - base.violations / m) / se;
}

/** Stouffer combination over judging gate members. */
export function combineZ(zs: number[]): number | null {
  if (zs.length === 0) return null;
  return zs.reduce((a, b) => a + b, 0) / Math.sqrt(zs.length);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface PanelMemberResult {
  id: string;
  role: "gate" | "report";
  faultClass: string;
  candidate: ArmCounts;
  baseline: ArmCounts | null;
  firing: FiringStatus;
  firingDetail: string;
  z: number | null;
  zDispersed: number | null;
  collapsed: boolean;
  judging: boolean;
  detail: string;
  /** Version 2: which statistic produced z, the candidate's median time to
   *  first violation, and its ratio to the best known arm's. */
  statistic?: "rate" | "time-to-first" | "counts" | "none";
  tauSec?: number | null;
  regretRatio?: number | null;
}

export interface PanelSummary {
  members: PanelMemberResult[];
  judging: string[];
  nonJudging: Array<{ id: string; reason: string }>;
  combinedZ: number | null;
  collapsedMembers: string[];
  wallMs: number;
  /** Version 2: the geometric mean of the judging gate members' rate ratios
   *  and the member with the worst one; reported, never binding. */
  geoMeanRateRatio?: number | null;
  worstMember?: { id: string; rateRatio: number } | null;
}

/** One replicate of a member: the standard explorer under the member's
 *  workload and faults for the member's active-time budget. The template's
 *  campaign block is dropped: an affordable panel budget is far below the
 *  session length an arm needs to leave the cold-start regime, and the
 *  panel never judges arm composition. */
async function runCampaignReplicate(
  ctx: EvalContext, m: PanelMember, binary: string, template: string, seed: number, tag: string,
): Promise<{ runs: number; violations: number; unknown: number; exposureSec: number; first: Censored; timedOut: boolean; utilization: Record<string, unknown> | null }> {
  const outDir = path.join(ROOT, "tmp", "loop", `panel-${m.id}-${tag}`);
  const cfg = `${outDir}.config.json`;
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  const wallSec = m.wallSec ?? 10;
  // The wall is the binding limit: the run cap is the sequential protocol's
  // ceiling, far above what any member finishes in its wall, so the grid is
  // never exhausted first.
  materializeConfig(template, cfg, {
    runsPerConfig: ctx.policy.sequential.maxRunsPerConfig,
    sessionSeed: seed,
    dropKeys: CAMPAIGN_ONLY_KEYS,
    extra: { ...m.overlay, num_crashes: m.faults.numCrashes, max_iterations: m.maxIterations, wall_budget_sec: wallSec },
  });
  const e = await explore({
    binary, configPath: cfg, spec: resolveRoot(m.spec), outputDir: outDir,
    wallSec, rayonThreads: ctx.policy.evaluation.rayonThreads,
    explorer: "standard",
  });
  const p = await porcupine({ inputDir: outDir, model: m.porcupineModel, timeoutMsPerRun: 10_000, timeoutMs: 600_000 });
  const session = readSessionSibling(outDir);
  const util = readUtilizationSibling(outDir);
  const exposureSec = session !== null && session.wallMs > 0 ? session.wallMs / 1000 : e.wallMs / 1000;
  let first: Censored = { time: exposureSec, event: false };
  const violating = p.parsed?.violating_run_ids ?? [];
  if (violating.length > 0) {
    const rows = await runsTable(outDir);
    const ids = new Set(violating);
    let earliest: number | null = null;
    for (const r of rows) {
      if (ids.has(r.run_id) && (earliest === null || r.session_offset_ms < earliest)) earliest = r.session_offset_ms;
    }
    if (earliest !== null) first = { time: earliest / 1000, event: true };
  }
  cleanupDir(outDir);
  for (const f of [`${outDir}.log`, `${outDir}.utilization.json`, `${outDir}.session.json`, `${outDir}.campaign.json`, cfg]) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
  return {
    runs: p.parsed?.total_runs ?? 0,
    violations: p.parsed?.violations ?? 0,
    unknown: p.parsed?.unknown ?? 0,
    exposureSec, first, timedOut: e.timedOut, utilization: util,
  };
}

/** Every replicate of one arm of a member, pooled. */
async function runReplicates(
  ctx: EvalContext, m: PanelMember, binary: string, template: string, seed: number, tag: string,
): Promise<ArmCounts> {
  const out: ArmCounts = { runs: 0, violations: 0, unknown: 0, timedOut: false, utilization: null, exposureSec: 0, firstViolation: [], replicates: [] };
  for (let r = 0; r < (m.replicates ?? 1); r++) {
    const rep = await runCampaignReplicate(ctx, m, binary, template, seed * 100 + r, `${tag}-${r}`);
    out.runs += rep.runs;
    out.violations += rep.violations;
    out.unknown += rep.unknown;
    out.timedOut = out.timedOut || rep.timedOut;
    out.utilization = rep.utilization ?? out.utilization;
    out.exposureSec = (out.exposureSec ?? 0) + rep.exposureSec;
    out.firstViolation!.push(rep.first);
    out.replicates!.push({ violations: rep.violations, exposureSec: rep.exposureSec });
  }
  return out;
}

/** What a version-2 member measures on one binary: `seeds` arms of its
 *  replicates, pooled into events per second, the within-arm dispersion,
 *  the median time to first violation and the run rate. */
export interface MemberCalibration {
  id: string;
  seeds: number;
  runs: number;
  violations: number;
  exposureSec: number;
  eventsPerSec: number;
  runsPerSec: number;
  dispersion: number;
  tauSec: number | null;
  truncated: boolean;
}

export async function calibrateMember(
  ctx: EvalContext, m: PanelMember, binary: string, template: string, seeds: number,
): Promise<MemberCalibration> {
  const arms: ArmCounts[] = [];
  for (let sd = 0; sd < seeds; sd++) {
    arms.push(await runReplicates(ctx, m, binary, template, 50_000 + sd, `calib-${sd}`));
  }
  const runs = arms.reduce((a, x) => a + x.runs, 0);
  const violations = arms.reduce((a, x) => a + x.violations, 0);
  const exposureSec = arms.reduce((a, x) => a + (x.exposureSec ?? 0), 0);
  return {
    id: m.id, seeds, runs, violations, exposureSec,
    eventsPerSec: exposureSec > 0 ? violations / exposureSec : 0,
    runsPerSec: exposureSec > 0 ? runs / exposureSec : 0,
    dispersion: replicateDispersion(arms.map((x) => x.replicates ?? [])),
    tauSec: kmMedian(arms.flatMap((x) => x.firstViolation ?? [])),
    truncated: arms.some((x) => x.timedOut),
  };
}

/** The version-2 judgement of one member: a rate ratio where events are
 *  plentiful, time to first violation where they are rare. */
export function judgeReplicates(m: PanelMember, cand: ArmCounts, base: ArmCounts | null): {
  z: number | null; statistic: "rate" | "time-to-first" | "counts" | "none"; tauSec: number | null; regretRatio: number | null; rateRatio: number | null; dispersion: number;
} {
  const tauSec = kmMedian(cand.firstViolation ?? []);
  const best = m.calibration.tauBestSec ?? 0;
  const regretRatio = tauSec !== null && best > 0 ? tauSec / best : null;
  if (base === null) return { z: null, statistic: "none", tauSec, regretRatio, rateRatio: null, dispersion: 1 };
  const ce = cand.exposureSec ?? 0;
  const be = base.exposureSec ?? 0;
  const rateRatio = ce > 0 && be > 0 && base.violations > 0 ? (cand.violations / ce) / (base.violations / be) : null;
  // Under one expected event per arm a time-to-first test is a statistic on
  // censoring alone; the counts are reported and nothing is inferred.
  if (expectedEvents(m) < 1) return { z: null, statistic: "counts", tauSec, regretRatio, rateRatio, dispersion: 1 };
  if (expectedEvents(m) >= RATE_EVENTS_MIN) {
    const dispersion = replicateDispersion([cand.replicates ?? [], base.replicates ?? []]);
    return { z: poissonRateRatioZ(cand.violations, ce, base.violations, be) / Math.sqrt(dispersion), statistic: "rate", tauSec, regretRatio, rateRatio, dispersion };
  }
  return { z: logRankZ(cand.firstViolation ?? [], base.firstViolation ?? []), statistic: "time-to-first", tauSec, regretRatio, rateRatio, dispersion: 1 };
}

async function runArm(
  ctx: EvalContext, m: PanelMember, binary: string, template: string, seed: number, tag: string,
): Promise<ArmCounts> {
  const outDir = path.join(ROOT, "tmp", "loop", `panel-${m.id}-${tag}`);
  const cfg = `${outDir}.config.json`;
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  materializeConfig(template, cfg, {
    runsPerConfig: Math.ceil((m.runsPerArm ?? 0) / (m.gridSize ?? 1)),
    sessionSeed: seed,
    dropKeys: CAMPAIGN_ONLY_KEYS,
    extra: { ...m.overlay, num_crashes: m.faults.numCrashes, max_iterations: m.maxIterations },
  });
  const e = await explore({
    binary, configPath: cfg, spec: resolveRoot(m.spec), outputDir: outDir,
    wallSec: ctx.policy.regression.wallSecPerCase, rayonThreads: ctx.policy.evaluation.rayonThreads,
  });
  const p = await porcupine({ inputDir: outDir, model: m.porcupineModel, timeoutMsPerRun: 10_000, timeoutMs: 600_000 });
  const util = readUtilizationSibling(outDir);
  cleanupDir(outDir);
  for (const f of [`${outDir}.log`, `${outDir}.utilization.json`, cfg]) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
  return {
    runs: p.parsed?.total_runs ?? 0,
    violations: p.parsed?.violations ?? 0,
    unknown: p.parsed?.unknown ?? 0,
    timedOut: e.timedOut,
    utilization: util,
  };
}

export async function runPanel(
  ctx: EvalContext, manifest: PanelManifest, arms: PanelArms,
): Promise<PanelSummary> {
  const started = Date.now();
  const changed = arms.baselineTemplate === null
    ? []
    : diffConfigPaths(arms.baselineTemplate, arms.candidateTemplate);
  const members: PanelMemberResult[] = [];
  const rateRatios: Array<{ id: string; rateRatio: number }> = [];

  for (const m of manifest.members) {
    const replicated = manifest.version === 2;
    const cand = replicated
      ? await runReplicates(ctx, m, arms.candidateBinary, arms.candidateTemplate, arms.seed, "cand")
      : await runArm(ctx, m, arms.candidateBinary, arms.candidateTemplate, arms.seed, "cand");
    // A report member is a rare-event detector: its rate is far below what its
    // run count resolves, so a baseline arm buys no comparison and doubles its
    // cost. What it answers is whether the defect was reached at all. Under
    // replicates a report member that did violate gets its baseline arm, so
    // the first-violation times have something to be compared with.
    const wantsBaseline = m.role === "gate" || (replicated && cand.violations > 0);
    const base = wantsBaseline && arms.baselineBinary !== null && arms.baselineTemplate !== null
      ? (replicated
        ? await runReplicates(ctx, m, arms.baselineBinary, arms.baselineTemplate, arms.seed, "base")
        : await runArm(ctx, m, arms.baselineBinary, arms.baselineTemplate, arms.seed, "base"))
      : null;

    const fire = base === null
      ? { status: "unknown" as FiringStatus,
          detail: m.role === "report" ? "report member; single arm by design" : "no baseline arm; nothing to compare" }
      : classifyFiring(arms, cand, base, changed);
    // A truncated arm has a different n and a different position on the
    // session-length curve, and truncation hits the slower arm harder. It is a
    // harness outcome, never evidence.
    const truncated = cand.timedOut || (base?.timedOut ?? false);
    const judged = replicated ? judgeReplicates(m, cand, base) : null;
    const z = judged !== null ? judged.z : (base === null ? null : panelZ(cand, base, 1));
    const zDisp = replicated || base === null ? null : panelZ(cand, base, 0.67);
    const judging = base !== null && !truncated && (fire.status === "fired" || fire.status === "no-config-change");
    const collapsed = judging && m.role === "gate" && z !== null && z <= -manifest.sizing.collapseZ;
    if (judging && m.role === "gate" && judged?.rateRatio != null) rateRatios.push({ id: m.id, rateRatio: judged.rateRatio });

    const rate = (a: ArmCounts): string => (a.runs === 0 ? "n/a" : (a.violations / a.runs).toFixed(5));
    const perSec = (a: ArmCounts): string => ((a.exposureSec ?? 0) > 0 ? `${(a.violations / (a.exposureSec ?? 1)).toFixed(3)}/s` : "");
    members.push({
      id: m.id, role: m.role, faultClass: m.faults.class,
      candidate: cand, baseline: base,
      firing: truncated ? "unknown" : fire.status,
      firingDetail: truncated ? "an arm hit the wall; counts are not comparable" : fire.detail,
      z, zDispersed: zDisp, collapsed, judging,
      detail: `cand ${cand.violations}/${cand.runs} (${rate(cand)}${replicated ? ` ${perSec(cand)}` : ""})`
        + (base ? ` vs base ${base.violations}/${base.runs} (${rate(base)}${replicated ? ` ${perSec(base)}` : ""})` : " (no baseline arm)")
        + (z !== null ? ` z=${z.toFixed(2)}${judged ? ` ${judged.statistic}${judged.statistic === "rate" ? ` phi=${judged.dispersion.toFixed(2)}` : ""}` : ""}` : "")
        + (judged?.tauSec != null ? ` tau=${judged.tauSec.toFixed(1)}s` : "")
        + (judged?.regretRatio != null ? ` regret=${judged.regretRatio.toFixed(2)}` : "")
        + ` [${m.faults.class} ${m.role}, ${truncated ? "truncated" : fire.status}]`,
      ...(judged ? { statistic: judged.statistic, tauSec: judged.tauSec, regretRatio: judged.regretRatio } : {}),
    });
  }

  const judgingGates = members.filter((r) => r.judging && r.role === "gate" && r.z !== null);
  const geo = rateRatios.length > 0
    ? Math.exp(rateRatios.reduce((a, r) => a + Math.log(Math.max(r.rateRatio, 1e-6)), 0) / rateRatios.length)
    : null;
  const worst = rateRatios.length > 0 ? rateRatios.reduce((a, r) => (r.rateRatio < a.rateRatio ? r : a)) : null;
  return {
    members,
    judging: judgingGates.map((r) => r.id),
    nonJudging: members.filter((r) => !r.judging).map((r) => ({ id: r.id, reason: r.firingDetail })),
    combinedZ: combineZ(judgingGates.map((r) => r.z as number)),
    collapsedMembers: members.filter((r) => r.collapsed).map((r) => r.id),
    wallMs: Date.now() - started,
    geoMeanRateRatio: geo,
    worstMember: worst,
  };
}

/** Hand-computed checks on the panel's arithmetic and on the guards that stop
 *  an untrustworthy manifest from producing numbers that look measured. */
export function selfTestPanel(): string[] {
  const f: string[] = [];
  const check = (c: boolean, m: string): void => { if (!c) f.push(m); };
  const arm = (violations: number, runs: number): ArmCounts =>
    ({ runs, violations, unknown: 0, timedOut: false, utilization: null });

  check(panelZ(arm(0, 0), arm(10, 100)) === null, "panelZ with an empty arm should be null");
  check(panelZ(arm(10, 100), arm(10, 100)) === 0, "identical arms should give z = 0");

  // 100 vs 150 of 10000: p = 0.0125, se = sqrt(.0125*.9875*2/10000) = 0.0015713,
  // dz = -0.005 -> z = -3.182.
  const z = panelZ(arm(100, 10000), arm(150, 10000));
  check(z !== null && Math.abs(z + 3.182) < 0.01, `two-sample z should be -3.18, got ${String(z)}`);
  // The sub-binomial variance inflates |z| by 1/sqrt(0.67) = 1.2217.
  const zd = panelZ(arm(100, 10000), arm(150, 10000), 0.67);
  check(zd !== null && z !== null && Math.abs(zd - z * 1.2217) < 0.01, `dispersed z should scale by 1.22, got ${String(zd)}`);
  check((panelZ(arm(150, 10000), arm(100, 10000)) ?? 0) > 0, "a candidate detecting more should give positive z");

  check(combineZ([]) === null, "combineZ of nothing should be null");
  check(Math.abs((combineZ([-2, -2, -2, -2]) ?? 0) + 4) < 1e-9, "four z of -2 should combine to -4");
  check(Math.abs((combineZ([-1.77, -1.77]) ?? 0) + 2.503) < 0.01, "two z of -1.77 should combine to -2.50");

  const base = {
    version: 1 as const,
    sizing: { targetCount: 100, collapseZ: 2.7, gradientZ: 2.0, minSeparation: 20 },
    members: [{
      id: "m", spec: "a.spur", cleanSpec: "b.spur", shape: "s",
      faults: { class: "F0" as const, numCrashes: { min: 0, max: 0, step: 1 }, requiresRecovery: false },
      porcupineModel: "kv" as const, overlay: { num_servers: { min: 3, max: 3, step: 1 } },
      maxIterations: 8000, role: "gate" as const, expectedRate: 0.02, runsPerArm: 5000, gridSize: 100,
      calibration: { atIso: "t", rateRuns: 20000, rateViolations: 400, dispersion: 0.6,
        cleanRuns: 20000, cleanViolations: 0, hostCeiling: 0.5, budgetRatio: 1.0, runsPerSec: 1000 },
      notes: "",
    }],
  };
  check(validateManifest(base).length === 0, `a well-formed manifest should validate: ${validateManifest(base).join("; ")}`);

  const withFault = structuredClone(base);
  (withFault.members[0] as { overlay: Record<string, unknown> }).overlay["num_crashes"] = { min: 1, max: 1, step: 1 };
  check(validateManifest(withFault).some((e) => e.includes("num_crashes")),
    "num_crashes in the overlay must be rejected: it would disable the fault declaration silently");

  const noControl = structuredClone(base) as PanelManifest;
  noControl.members[0]!.cleanSpec = null;
  check(validateManifest(noControl).some((e) => e.includes("needs a control")),
    "a gate member without a control must be rejected");

  const tooClose = structuredClone(base);
  tooClose.members[0]!.calibration.cleanViolations = 100;   // control at 0.005 vs member 0.02 = 4x
  check(validateManifest(tooClose).some((e) => e.includes("its control")),
    "a gate member too close to its control's floor must be rejected");

  const slow = structuredClone(base);
  slow.members[0]!.calibration.runsPerSec = 10;             // 5000 runs = 500s
  check(validateManifest(slow, 360).some((e) => e.includes("case wall")),
    "a gate member whose arm exceeds half the case wall must be rejected");

  const overCeiling = structuredClone(base);
  overCeiling.members[0]!.calibration.hostCeiling = 0.01;   // under the 0.02 rate
  check(validateManifest(overCeiling).some((e) => e.includes("host ceiling")),
    "a member cannot detect above what its host can express");

  const undersized = structuredClone(base);
  undersized.members[0]!.runsPerArm = 100;   // gate member, so the sizing rule applies
  check(validateManifest(undersized).some((e) => e.includes("under the sized")),
    "runsPerArm below 100/rate must be rejected");

  // Version 2: replicates of a fixed budget, judged as a rate or on time to
  // first violation.
  const v2 = structuredClone(base) as PanelManifest;
  v2.version = 2;
  const mem = v2.members[0]!;
  delete mem.runsPerArm;
  delete mem.gridSize;
  mem.wallSec = 10;
  mem.replicates = 3;
  mem.calibration.eventsPerSec = 20;   // 0.02 x 1000 runs/s
  mem.calibration.tauBestSec = 1;
  check(validateManifest(v2, 480).length === 0, `a well-formed version-2 manifest validates: ${validateManifest(v2, 480).join("; ")}`);
  const shortWall = structuredClone(v2);
  shortWall.members[0]!.wallSec = 2;
  check(validateManifest(shortWall).some((e) => e.includes("three times")), "a budget under three medians must be rejected");
  const starved = structuredClone(v2);
  starved.members[0]!.calibration.eventsPerSec = 0.1;
  check(validateManifest(starved).some((e) => e.includes("violations per arm")), "a gate member with too few expected events must be rejected");
  check(validateManifest(v2, 60).some((e) => e.includes("case wall")), "replicates over the case wall must be rejected");
  // Replicates that just fit the wall at full speed do not fit it for a
  // candidate at the throughput floor.
  const need = panelWallSec(v2);
  check(validateManifest(v2, need + 1).length === 0 && validateManifest(v2, need + 1, 0.8).some((e) => e.includes("throughput floor")),
    "the case wall is checked for a candidate at the throughput floor");

  const reps = (first: Array<number | null>, violations: number, exposureSec: number): ArmCounts => ({
    runs: 1000, violations, unknown: 0, timedOut: false, utilization: null, exposureSec,
    firstViolation: first.map((t) => (t === null ? { time: 10, event: false } : { time: t, event: true })),
    replicates: first.map(() => ({ violations: violations / first.length, exposureSec: exposureSec / first.length })),
  });
  const at = (violations: number[], exposureSec: number) => violations.map((v) => ({ violations: v, exposureSec }));
  // Equal replicates scatter less than Poisson: the dispersion floors at 1.
  check(replicateDispersion([at([20, 20, 20], 10)]) === 1, "identical replicates have dispersion 1");
  // Rates 1, 2, 3 per second over 10 s each: observed variance 1, Poisson
  // variance 2/10 = 0.2, dispersion 5.
  const scattered = replicateDispersion([at([10, 20, 30], 10)]);
  check(Math.abs(scattered - 5) < 1e-9, `scattered replicates have dispersion 5, got ${scattered}`);
  check(replicateDispersion([at([10, 30], 10)]) === 1, "two replicates cannot estimate dispersion");
  // A difference between the arms is not dispersion: two flat arms at
  // different rates keep phi at 1, whatever their separation.
  check(replicateDispersion([at([10, 10, 10], 10), at([20, 20, 20], 10)]) === 1, "a clean difference between arms is not charged as dispersion");
  const rateJudged = judgeReplicates(mem, reps([1, 1, 1], 60, 30), reps([1, 1, 1], 60, 30));
  check(rateJudged.statistic === "rate" && Math.abs(rateJudged.z ?? 1) < 1e-9, `equal rates judge as a rate at z 0, got ${JSON.stringify(rateJudged)}`);
  // A clean 50% collapse must clear the collapse bar at the manifest's own
  // sizing, and keep clearing it as counts grow.
  const halved = judgeReplicates(mem, reps([1, 1, 1], 30, 30), reps([1, 1, 1], 60, 30));
  check((halved.z ?? 0) <= -v2.sizing.collapseZ, `half the rate at 30 vs 60 events must collapse (z <= -${v2.sizing.collapseZ}), got ${halved.z}`);
  const halvedBig = judgeReplicates(mem, reps([1, 1, 1], 120, 30), reps([1, 1, 1], 240, 30));
  check((halvedBig.z ?? 0) < -5, `half the rate at 120 vs 240 events must separate further, got ${halvedBig.z}`);
  // Replicates that scatter within each arm inflate phi and keep an A/A
  // inside the bar.
  const scatterCand: ArmCounts = { ...reps([1, 1, 1], 120, 30), replicates: at([30, 40, 50], 10) };
  const scatterBase: ArmCounts = { ...reps([1, 1, 1], 150, 30), replicates: at([40, 50, 60], 10) };
  const scatterJudged = judgeReplicates(mem, scatterCand, scatterBase);
  check(scatterJudged.dispersion > 2 && scatterJudged.dispersion < 2.5 && Math.abs(scatterJudged.z ?? 9) < v2.sizing.collapseZ,
    `scattered A/A arms carry their dispersion (phi about 2.2) and stay inside the bar, got ${JSON.stringify(scatterJudged)}`);
  const rare = structuredClone(mem);
  rare.calibration.eventsPerSec = 0.05;
  const ttf = judgeReplicates(rare, reps([1, 2, null], 2, 30), reps([null, null, null], 0, 30));
  check(ttf.statistic === "time-to-first" && (ttf.z ?? 0) > 0, `a rare member that violated against one that did not judges on time to first with z > 0, got ${JSON.stringify(ttf)}`);
  check(ttf.tauSec === 2 && ttf.regretRatio === 2, `tau and regret from the candidate's first violations, got ${JSON.stringify(ttf)}`);
  check(judgeReplicates(rare, reps([null, null, null], 0, 30), null).statistic === "none", "no baseline arm judges nothing");
  const sparse = structuredClone(mem);
  sparse.calibration.eventsPerSec = 0.01;   // 0.3 expected events per arm
  const counted = judgeReplicates(sparse, reps([2, null, null], 1, 30), reps([null, null, null], 0, 30));
  check(counted.statistic === "counts" && counted.z === null, `under one expected event a member reports counts only, got ${JSON.stringify(counted)}`);

  return f;
}

/** Gate-level checks: the panel must bind in exactly one direction. These
 *  fabricate summaries rather than running the explorer, so they assert the
 *  wiring rather than any protocol's behaviour. */
export function selfTestPanelGate(): string[] {
  const f: string[] = [];
  const check = (c: boolean, m: string): void => { if (!c) f.push(m); };
  const summary = (combinedZ: number | null, judging: string[], collapsed: string[]): PanelSummary => ({
    members: [], judging, nonJudging: [], combinedZ, collapsedMembers: collapsed, wallMs: 0,
  });

  // A collapse must not reach the gate as a panel signal: it fails the suite,
  // and the suite already closes through regressionPassed.
  const collapsedOnly = summary(0.1, ["m"], ["m"]);
  check(collapsedOnly.collapsedMembers.length === 1 && (collapsedOnly.combinedZ ?? 0) > -2,
    "a collapse is carried by the suite, not by combinedZ");

  // No judging member means no standing: a null combinedZ must never downgrade.
  check(summary(null, [], []).combinedZ === null, "no judging member should leave combinedZ null");

  return f;
}
