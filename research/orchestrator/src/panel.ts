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
import { cleanupDir, explore, materializeConfig, porcupine, readUtilizationSibling, resolveRoot } from "./runners.js";
export { readUtilizationSibling };
import type { EvalContext } from "./evaluate.js";

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
  runsPerArm: z.number().int().positive(),
  gridSize: z.number().int().positive(),
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
  }),
  notes: z.string().default(""),
});
export type PanelMember = z.infer<typeof PanelMember>;

export const PanelManifest = z.object({
  version: z.literal(1),
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
export function validateManifest(m: PanelManifest, wallSecPerCase?: number): string[] {
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
    if (mem.runsPerArm % mem.gridSize !== 0) errs.push(`${mem.id}: runsPerArm ${mem.runsPerArm} is not a multiple of gridSize ${mem.gridSize}`);
    // Only a gate member has to resolve a rate change. A report member is a
    // rare-event detector: it is sized by what its wall affords, and demanding
    // 100/rate of it would ask for hundreds of thousands of runs.
    if (mem.role === "gate" && mem.runsPerArm < Math.ceil(m.sizing.targetCount / mem.expectedRate)) {
      errs.push(`${mem.id}: runsPerArm ${mem.runsPerArm} is under the sized ${Math.ceil(m.sizing.targetCount / mem.expectedRate)}`);
    }
    if (mem.role === "gate") {
      if (mem.cleanSpec === null) {
        errs.push(`${mem.id}: a gate member needs a control spec`);
      } else if (mem.calibration.cleanRuns < mem.runsPerArm) {
        errs.push(`${mem.id}: control measured at ${mem.calibration.cleanRuns} runs, under the ${mem.runsPerArm} it will be judged at`);
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
      if (wallSecPerCase !== undefined && mem.calibration.runsPerSec > 0) {
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
  return errs;
}

export function loadPanelManifest(p: string): PanelManifest {
  const m = PanelManifest.parse(JSON.parse(fs.readFileSync(resolveRoot(p), "utf8")));
  const errs = validateManifest(m);
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
}

export interface PanelSummary {
  members: PanelMemberResult[];
  judging: string[];
  nonJudging: Array<{ id: string; reason: string }>;
  combinedZ: number | null;
  collapsedMembers: string[];
  wallMs: number;
}

async function runArm(
  ctx: EvalContext, m: PanelMember, binary: string, template: string, seed: number, tag: string,
): Promise<ArmCounts> {
  const outDir = path.join(ROOT, "tmp", "loop", `panel-${m.id}-${tag}`);
  const cfg = `${outDir}.config.json`;
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  materializeConfig(template, cfg, {
    runsPerConfig: Math.ceil(m.runsPerArm / m.gridSize),
    sessionSeed: seed,
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

  for (const m of manifest.members) {
    const cand = await runArm(ctx, m, arms.candidateBinary, arms.candidateTemplate, arms.seed, "cand");
    // A report member is a rare-event detector: its rate is far below what its
    // run count resolves, so a baseline arm buys no comparison and doubles its
    // cost. What it answers is whether the defect was reached at all.
    const wantsBaseline = m.role === "gate";
    const base = wantsBaseline && arms.baselineBinary !== null && arms.baselineTemplate !== null
      ? await runArm(ctx, m, arms.baselineBinary, arms.baselineTemplate, arms.seed, "base")
      : null;

    const fire = base === null
      ? { status: "unknown" as FiringStatus,
          detail: m.role === "report" ? "report member; single arm by design" : "no baseline arm; nothing to compare" }
      : classifyFiring(arms, cand, base, changed);
    // A truncated arm has a different n and a different position on the
    // session-length curve, and truncation hits the slower arm harder. It is a
    // harness outcome, never evidence.
    const truncated = cand.timedOut || (base?.timedOut ?? false);
    const z = base === null ? null : panelZ(cand, base, 1);
    const zDisp = base === null ? null : panelZ(cand, base, 0.67);
    const judging = base !== null && !truncated && (fire.status === "fired" || fire.status === "no-config-change");
    const collapsed = judging && m.role === "gate" && z !== null && z <= -manifest.sizing.collapseZ;

    const rate = (a: ArmCounts): string => (a.runs === 0 ? "n/a" : (a.violations / a.runs).toFixed(5));
    members.push({
      id: m.id, role: m.role, faultClass: m.faults.class,
      candidate: cand, baseline: base,
      firing: truncated ? "unknown" : fire.status,
      firingDetail: truncated ? "an arm hit the wall; counts are not comparable" : fire.detail,
      z, zDispersed: zDisp, collapsed, judging,
      detail: `cand ${cand.violations}/${cand.runs} (${rate(cand)})`
        + (base ? ` vs base ${base.violations}/${base.runs} (${rate(base)})` : " (no baseline arm)")
        + (z !== null ? ` z=${z.toFixed(2)}` : "")
        + ` [${m.faults.class} ${m.role}, ${truncated ? "truncated" : fire.status}]`,
    });
  }

  const judgingGates = members.filter((r) => r.judging && r.role === "gate" && r.z !== null);
  return {
    members,
    judging: judgingGates.map((r) => r.id),
    nonJudging: members.filter((r) => !r.judging).map((r) => ({ id: r.id, reason: r.firingDetail })),
    combinedZ: combineZ(judgingGates.map((r) => r.z as number)),
    collapsedMembers: members.filter((r) => r.collapsed).map((r) => r.id),
    wallMs: Date.now() - started,
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
