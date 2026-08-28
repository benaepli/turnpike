// One evaluation = one (hypothesis, fidelity, seed) explorer run, checked
// with porcupine and graded with traceanalyzer, assembled into an Evaluation
// record (schemas.ts).
import * as fs from "node:fs";
import * as path from "node:path";
import type { CampaignJson, CampaignMetrics, Evaluation, FidelityName, LadderMetrics, PorcupineJson, RunRow, TraceGradeJson, UtilStats } from "./schemas.js";
import type { Policy } from "./policy.js";
import { ROOT, cleanupDir, explore, freeDiskGb, grade, materializeConfig, porcupine, readCampaignSibling, readSessionSibling, readUtilizationSibling, resolveRoot, run, runsTable, templateHasCampaign } from "./runners.js";

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
  campaign: null,
};

// Per-arm ladder counts: every graded run's depth and every verdict joined
// to the arm that issued the run. The session's own ladder is the union.
export function campaignMetrics(
  report: CampaignJson, rows: RunRow[], runDepths: Array<[number, number]>, violatingRunIds: number[],
): CampaignMetrics {
  const depthOf = new Map<number, number>();
  for (const [id, d] of runDepths) depthOf.set(id, d);
  const violating = new Set(violatingRunIds);
  const byArm = new Map<string, { depthAtLeast: number[]; graded: number; violations: number; first: number | null }>();
  for (const a of report.arms) byArm.set(a.id, { depthAtLeast: [], graded: 0, violations: 0, first: null });
  for (const r of rows) {
    const acc = byArm.get(r.arm);
    if (!acc) continue;
    const d = depthOf.get(r.run_id);
    if (d !== undefined) {
      acc.graded++;
      for (let k = 1; k <= d; k++) acc.depthAtLeast[k - 1] = (acc.depthAtLeast[k - 1] ?? 0) + 1;
    }
    if (violating.has(r.run_id)) {
      acc.violations++;
      const at = r.session_offset_ms;
      if (acc.first === null || at < acc.first) acc.first = at;
    }
  }
  const width = Math.max(0, ...[...byArm.values()].map((a) => a.depthAtLeast.length));
  return {
    wallSec: report.wall_budget_sec,
    allocation: report.allocation.kind,
    reward: report.reward.kind,
    runsTotal: Math.round(report.runs_total),
    sliceUnitSec: report.slice_unit_sec,
    cancelled: report.cancelled,
    arms: report.arms.map((a) => {
      const acc = byArm.get(a.id) ?? { depthAtLeast: [], graded: 0, violations: 0, first: null };
      const depthAtLeast = Array.from({ length: width }, (_, i) => acc.depthAtLeast[i] ?? 0);
      return {
        index: Math.round(a.index), id: a.id, mode: a.mode, overlay: a.overlay,
        slices: Math.round(a.slices), runs: Math.round(a.runs), wallMs: Math.round(a.wall_ms),
        rewardRate: a.reward_rate, epochs: Math.round(a.epochs), droppedAtRound: a.dropped_at_round === null ? null : Math.round(a.dropped_at_round),
        depthAtLeast, gradedRuns: acc.graded, violations: acc.violations, firstViolationMs: acc.first === null ? null : Math.round(acc.first),
      };
    }),
  };
}

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
    campaign: null,
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

// The number of violating runs whose full timelines are kept; a corpus that
// violates everywhere is a different kind of evidence and needs no dump.
const PRESERVED_VIOLATIONS_MAX = 20;

interface RunDump {
  run_id: number;
  executions: Array<{ SeqNum: number; UniqueID: number; ClientID: number; Kind: string; Action: string; Payload: string; Step: number }>;
  traces: Array<{ SeqNum: number; NodeID: number; Step: number; FunctionName: string; TraceKind: string; Payload: string; TraceID: number }>;
  logs: Array<{ seq_num: number; node_id: number; step: number; content: string }>;
}

// One run's three tables merged into a step-ordered text timeline.
export function combinedTimeline(d: RunDump): string {
  const lines: Array<{ step: number; order: number; seq: number; text: string }> = [];
  for (const e of d.executions) {
    lines.push({ step: e.Step, order: 0, seq: e.SeqNum, text: `[Step ${String(e.Step).padStart(5)}] [Execution] ${e.Kind.padEnd(10)} ${e.Action} client=${e.ClientID} uid=${e.UniqueID} ${e.Payload}` });
  }
  for (const t of d.traces) {
    lines.push({ step: t.Step, order: 1, seq: t.SeqNum, text: `[Step ${String(t.Step).padStart(5)}] [Trace    ] node=${t.NodeID} ${t.TraceKind.padEnd(8)} ${t.FunctionName} trace=${t.TraceID} ${t.Payload}` });
  }
  for (const l of d.logs) {
    lines.push({ step: l.step, order: 2, seq: l.seq_num, text: `[Step ${String(l.step).padStart(5)}] [Log      ] node=${l.node_id} ${l.content}` });
  }
  lines.sort((a, b) => a.step - b.step || a.order - b.order || a.seq - b.seq);
  return `Combined timeline for run ${d.run_id}: ${d.executions.length} executions, ${d.traces.length} traces, ${d.logs.length} logs\n${lines.map((l) => l.text).join("\n")}\n`;
}

// A violation is the ground truth the whole loop exists to produce, and the
// corpus it lives in is deleted with the evaluation, so its evidence is
// copied out first: the checker's report, the config, the campaign report,
// the runs-table rows of the violating runs, and each one's combined
// timeline from the simulator's own debugger.
async function preserveViolations(
  ctx: EvalContext, evalId: string, outputDir: string, configPath: string,
  violatingIds: number[], porc: PorcupineJson | null, rows: RunRow[],
): Promise<void> {
  const keep = path.join(ROOT, "research", "logs", "violations", evalId);
  try {
    fs.mkdirSync(keep, { recursive: true });
    fs.writeFileSync(path.join(keep, "porcupine.json"), JSON.stringify(porc, null, 2));
    for (const f of ["config.json", "campaign.json", "session.json", "utilization.json"]) {
      const src = f === "config.json" ? configPath : path.join(outputDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(keep, f));
    }
    const ids = new Set(violatingIds);
    fs.writeFileSync(path.join(keep, "violating_runs.json"), JSON.stringify(rows.filter((r) => ids.has(r.run_id)), null, 2));
    for (const id of violatingIds.slice(0, PRESERVED_VIOLATIONS_MAX)) {
      // The grader reads one run through a run_id predicate; a debugger that
      // materialises the corpus cannot be used on a session this size.
      const r = await run(path.join(ROOT, "traceanalyzer", "main"), ["-input", outputDir, "-dump-run", String(id)], { timeoutMs: 300_000, cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
      fs.writeFileSync(path.join(keep, `run_${id}.json`), r.stdout || r.stderr);
      try { fs.writeFileSync(path.join(keep, `run_${id}.combined.txt`), combinedTimeline(JSON.parse(r.stdout))); } catch { /* the JSON dump stands on its own */ }
    }
    // One line per evaluation in an index, so the violations a host has seen
    // can be listed without opening every directory.
    const byArm: Record<string, number> = {};
    for (const r of rows) if (ids.has(r.run_id)) byArm[r.arm] = (byArm[r.arm] ?? 0) + 1;
    fs.appendFileSync(path.join(ROOT, "research", "logs", "violations", "INDEX.jsonl"), JSON.stringify({
      atIso: new Date().toISOString(), evalId, spec: ctx.policy.evaluation.spec, violations: violatingIds.length,
      runIds: violatingIds.slice(0, PRESERVED_VIOLATIONS_MAX), byArm, signatures: porc?.violation_signatures?.map((s) => s.signature) ?? [], dir: keep,
    }) + "\n");
    console.log(`[${new Date().toISOString()}] ${evalId}: ${violatingIds.length} violating run(s); evidence kept under ${keep}`);
  } catch (e) {
    console.log(`[${new Date().toISOString()}] ${evalId}: could not preserve violation evidence: ${String(e)}`);
  }
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
    // A budgeted session on a template with a campaign block is a campaign:
    // the budget is the campaign's, passed as an override, and each arm is
    // graded on its own runs afterwards. A run-count session (the screen and
    // promote fidelities) stays on the standard explorer, whose grid bounds
    // it, so the campaign block is dropped from its config.
    const campaign = templateHasCampaign(template) && ctx.policy.evaluation.explorer === "campaign" && opts.exploreBudgetSec !== undefined;
    const extra: Record<string, unknown> = {};
    const sets: string[] = [];
    if (opts.exploreBudgetSec !== undefined) {
      if (campaign) sets.push(`campaign.wall_budget_sec=${opts.exploreBudgetSec}`);
      else extra["wall_budget_sec"] = opts.exploreBudgetSec;
    }
    materializeConfig(template, configPath, {
      runsPerConfig: opts.runsPerConfig, sessionSeed: seed, extra,
      dropKeys: campaign ? [] : ["campaign"],
    });
    console.log(`[${new Date().toISOString()}] ${hypothesisId}/${fidelity} seed ${seed}: exploring (${campaign ? "campaign, " : ""}${opts.exploreBudgetSec !== undefined ? `budget ${opts.exploreBudgetSec}s, ` : ""}wall ${opts.exploreWallSec}s) -> ${outputDir}`);
    const exploreRes = await explore({
      binary: ctx.binary, configPath, spec, outputDir, explorer: campaign ? "campaign" : (ctx.policy.evaluation.explorer === "campaign" ? "standard" : ctx.policy.evaluation.explorer),
      wallSec: opts.exploreWallSec, rayonThreads: ctx.policy.evaluation.rayonThreads, sets,
    });
    const session = readSessionSibling(outputDir);
    const utilStats = utilSubset(readUtilizationSibling(outputDir));
    const campaignReport = campaign ? readCampaignSibling(outputDir) : null;
    const exposureMs = session !== null && session.wallMs > 0 ? session.wallMs : exploreRes.wallMs;
    const porc = await porcupine({ inputDir: outputDir, model: "kv", timeoutMsPerRun: 3_000, timeoutMs: 900_000 });
    const gr = await grade({
      inputDir: outputDir,
      dagConfigs: ctx.policy.evaluation.oracleDags.map(resolveRoot),
      maxRuns: opts.gradeMaxRuns,
      budgetMs: opts.gradeBudgetMs,
      timeoutMs: opts.gradeBudgetMs + 120_000,
      runDepths: campaignReport !== null,
    });
    const metrics = assembleMetrics(porc.parsed, gr.parsed, exposureMs, porc.cmd.wallMs, gr.cmd.wallMs);
    const violatingIds = porc.parsed?.violating_run_ids ?? [];
    let rows: RunRow[] = [];
    if (campaignReport !== null || violatingIds.length > 0) rows = await runsTable(outputDir);
    if (campaignReport !== null) {
      const depths = (gr.parsed?.grade_dags?.[0]?.run_depths ?? []) as Array<[number, number]>;
      metrics.campaign = campaignMetrics(campaignReport, rows, depths, violatingIds);
    }
    if (violatingIds.length > 0) {
      await preserveViolations(ctx, base.id, outputDir, configPath, violatingIds, porc.parsed, rows);
    }
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
    fs.rmSync(`${outputDir}.campaign.json`, { force: true });
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
