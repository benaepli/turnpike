// Human-facing documents rendered from loop state. renderStatus is a pure
// string function; writeStatus / appendObservation / renderPolicyMd do the IO.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Evaluation, type LadderMetrics } from "./schemas.js";
import { z } from "zod";
import type { Policy } from "./policy.js";
import type { LoopState } from "./state.js";
import { SUPER } from "./gitops.js";
import { loadSeqState } from "./sequential.js";

const STATUS_PATH = join(SUPER, "research", "STATUS.md");
const OBSERVATIONS_PATH = join(
  SUPER,
  "research",
  "observations",
  "OBSERVATIONS.md",
);
const POLICY_MD_PATH = join(SUPER, "research", "POLICY.md");

const POOL_ROW_CAP = 40;
const ITERATION_ROW_CAP = 15;

/** Collapse to a single markdown-table-safe line, truncated to maxLen. */
function oneLine(s: string, maxLen: number): string {
  const flat = s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen - 1)}...`;
}

function fmtNum(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

/** P(prefix_depth >= k): depthAtLeast[i] counts graded runs with depth >= i+1. */
function pDepthAtLeast(m: LadderMetrics, k: number): number {
  if (m.gradedRuns <= 0) return 0;
  return (m.depthAtLeast[k - 1] ?? 0) / m.gradedRuns;
}

interface StatusOpts {
  baseline: LadderMetrics | null;
  reference: LadderMetrics | null;
  graderVersion: string;
  openPrs: string[];
}

/** One ladder over several chunks of the same protocol: counts and exposure
 *  add, rates are weighted by the runs that produced them, and the campaign
 *  breakdown is the first chunk's. Null when no chunk succeeded. */
export function pooledLadder(evals: Evaluation[]): LadderMetrics | null {
  const ok = evals.filter((e) => e.ok && e.timingAnomaly === null);
  if (ok.length === 0) return null;
  const ms = ok.map((e) => e.metrics);
  const sum = (f: (m: LadderMetrics) => number): number => ms.reduce((a, m) => a + f(m), 0);
  const runs = sum((m) => m.runs);
  const graded = sum((m) => m.gradedRuns);
  const byRuns = (f: (m: LadderMetrics) => number): number => (runs > 0 ? sum((m) => f(m) * m.runs) / runs : 0);
  const depthLen = Math.max(...ms.map((m) => m.depthAtLeast.length));
  const depthAtLeast = Array.from({ length: depthLen }, (_, i) => sum((m) => m.depthAtLeast[i] ?? 0));
  const exposureMs = sum((m) => m.exposureMs);
  return {
    runs, gradedRuns: graded,
    runsPerSec: exposureMs > 0 ? runs / (exposureMs / 1000) : byRuns((m) => m.runsPerSec),
    unpairedFraction: byRuns((m) => m.unpairedFraction),
    h1Rate: byRuns((m) => m.h1Rate), h2Rate: byRuns((m) => m.h2Rate), h2bRate: byRuns((m) => m.h2bRate),
    h3Rate: byRuns((m) => m.h3Rate), h4Rate: byRuns((m) => m.h4Rate),
    meanPrefixDepth: graded > 0 ? sum((m) => m.meanPrefixDepth * m.gradedRuns) / graded : 0,
    maxPrefixDepth: Math.max(...ms.map((m) => m.maxPrefixDepth)),
    depthAtLeast,
    violations: sum((m) => m.violations), unknown: sum((m) => m.unknown),
    porcupineWallMs: sum((m) => m.porcupineWallMs), gradeWallMs: sum((m) => m.gradeWallMs),
    exposureMs,
    campaign: ms[0]!.campaign,
  };
}

/** The ladder a stored baseline is judged by: its sequential chunks pooled,
 *  or the confirm rung of a baseline recorded before the sequential protocol. */
export function baselineLadder(meta: { sequential: Evaluation[]; confirm: Evaluation[] } | null): LadderMetrics | null {
  if (meta === null) return null;
  return pooledLadder(meta.sequential) ?? meta.confirm[0]?.metrics ?? null;
}

export function ladderTable(
  reference: LadderMetrics | null,
  baseline: LadderMetrics | null,
  latest: Evaluation | null,
): string[] {
  const rows: Array<[string, (m: LadderMetrics) => string]> = [
    ["violations", (m) => String(m.violations)],
    ["meanPrefixDepth", (m) => m.meanPrefixDepth.toFixed(2)],
  ];
  for (let k = 4; k <= 8; k++) {
    rows.push([`P(depth>=${k})`, (m) => pDepthAtLeast(m, k).toFixed(3)]);
  }
  // Rung events per explore-second, the objective the gate decides on. Rungs
  // above 7 are too sparse to decide on and are left as probabilities.
  for (let k = 4; k <= 7; k++) {
    rows.push([`depth>=${k} /s`, (m) => (m.exposureMs > 0 ? ((m.depthAtLeast[k - 1] ?? 0) / (m.exposureMs / 1000)).toFixed(2) : "-")]);
  }
  rows.push(
    ["h1Rate", (m) => fmtNum(m.h1Rate)],
    ["h2Rate", (m) => fmtNum(m.h2Rate)],
    ["h2bRate", (m) => fmtNum(m.h2bRate)],
    ["h3Rate", (m) => fmtNum(m.h3Rate)],
    ["h4Rate", (m) => fmtNum(m.h4Rate)],
    ["runsPerSec", (m) => m.runsPerSec.toFixed(1)],
    ["exposure (s)", (m) => (m.exposureMs > 0 ? (m.exposureMs / 1000).toFixed(0) : "-")],
  );
  const latestLabel =
    latest === null
      ? "Latest merged"
      : `Latest merged (${oneLine(latest.hypothesisId, 30)})`;
  // Reference = the first recorded baseline, never replaced; Baseline =
  // what candidates are currently compared against (advances on merge).
  const out = [
    `| Metric | Reference (000) | Current baseline | ${latestLabel} |`,
    "| --- | --- | --- | --- |",
  ];
  for (const [label, fmt] of rows) {
    const r = reference === null ? "-" : fmt(reference);
    const b = baseline === null ? "-" : fmt(baseline);
    const l = latest === null ? "-" : fmt(latest.metrics);
    out.push(`| ${label} | ${r} | ${b} | ${l} |`);
  }
  return out;
}

/** Latest successful evaluation belonging to a merged hypothesis, if any. */
function latestMergedEvaluation(state: LoopState): Evaluation | null {
  const merged = new Set(state.listHypotheses("merged").map((h) => h.id));
  const candidates = state
    .allEvaluations()
    .filter((e) => e.ok && merged.has(e.hypothesisId))
    .sort((a, b) => a.startedAtIso.localeCompare(b.startedAtIso));
  return candidates.at(-1) ?? null;
}

/** Render STATUS.md as a bounded (< 300 line) markdown string. Pure. */
export function renderStatus(
  state: LoopState,
  policy: Policy,
  opts: StatusOpts,
): string {
  const lines: string[] = [];
  lines.push("# Research Loop Status");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Grader version: ${opts.graderVersion}`);
  lines.push("");

  lines.push("## Metric ladder");
  lines.push("");
  lines.push(...ladderTable(opts.reference, opts.baseline, latestMergedEvaluation(state)));
  lines.push("");

  const camp = opts.baseline?.campaign ?? null;
  if (camp !== null) {
    lines.push("## Campaign arms (current baseline, first chunk)");
    lines.push("");
    lines.push(`Budget ${camp.wallSec} s, allocation ${camp.allocation}, reward ${camp.reward}, ${camp.runsTotal} runs.`);
    lines.push("");
    lines.push("| arm | mode | overlay | slices | wall share | runs/s | depth>=5 /s | depth>=6 /s | violations | reward rate | dropped at round |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    const totalWall = camp.arms.reduce((a, x) => a + x.wallMs, 0);
    for (const a of camp.arms) {
      const sec = a.wallMs / 1000;
      const perSec = (k: number): string => (sec > 0 ? ((a.depthAtLeast[k - 1] ?? 0) / sec).toFixed(2) : "-");
      lines.push(`| ${a.id} | ${a.mode} | ${oneLine(JSON.stringify(a.overlay), 40)} | ${a.slices} | ${totalWall > 0 ? (100 * a.wallMs / totalWall).toFixed(0) : "-"}% | ${sec > 0 ? (a.runs / sec).toFixed(0) : "-"} | ${perSec(5)} | ${perSec(6)} | ${a.violations} | ${a.rewardRate.toFixed(1)} | ${a.droppedAtRound ?? "-"} |`);
    }
    lines.push("");
  }

  lines.push("## Hypothesis pool");
  lines.push("");
  const pool = state.listHypotheses(); // already most recent first
  const counts = state.countByStatus();
  const countSummary = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([s, n]) => `${s}: ${n}`)
    .join(", ");
  lines.push(`Total: ${pool.length}${countSummary ? ` (${countSummary})` : ""}`);
  lines.push("");
  lines.push("| id | kind | status | gain/cost | title |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const h of pool.slice(0, POOL_ROW_CAP)) {
    lines.push(
      `| ${h.id} | ${h.kind} | ${h.status} | ${fmtNum(h.expectedGain)}/${fmtNum(h.expectedCost)} | ${oneLine(h.title, 60)} |`,
    );
  }
  if (pool.length > POOL_ROW_CAP) {
    lines.push("");
    lines.push(`... ${pool.length - POOL_ROW_CAP} older hypotheses not shown.`);
  }
  lines.push("");

  const inconclusive = state.listHypotheses("inconclusive");
  if (inconclusive.length > 0) {
    lines.push("## Inconclusive (resumable)");
    lines.push("");
    lines.push("| id | chunks | runs | P(depth>=4 up) | P(depth>=5 up) | P(depth>=6 up) | resumes | last iteration |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const h of inconclusive) {
      const seq = loadSeqState(state, h.id);
      if (!seq) continue;
      const p4 = (seq.posteriors["depth>=4:pGreater"] ?? 0).toFixed(3);
      const p5 = (seq.posteriors["depth>=5:pGreater"] ?? 0).toFixed(3);
      const p6 = (seq.posteriors["depth>=6:pGreater"] ?? 0).toFixed(3);
      lines.push(`| ${h.id} | ${seq.chunks} | ${seq.runs} | ${p4} | ${p5} | ${p6} | ${seq.resumes} | ${seq.lastIteration} |`);
    }
    lines.push("");
  }

  lines.push(`## Last ${ITERATION_ROW_CAP} iterations`);
  lines.push("");
  const iterations = state.recentIterations(ITERATION_ROW_CAP);
  if (iterations.length === 0) {
    lines.push("No iterations recorded yet.");
  } else {
    lines.push("| n | started | finished | phase timings | notes |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const it of iterations) {
      const timings = Object.entries(it.phaseTimings)
        .map(([phase, v]) => `${phase}=${fmtNum(v)}`)
        .join(", ");
      lines.push(
        `| ${it.n} | ${it.startedAt} | ${it.finishedAt ?? "-"} | ${oneLine(timings || "-", 80)} | ${oneLine(it.notes || "-", 60)} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Open needs_human PRs");
  lines.push("");
  if (opts.openPrs.length === 0) {
    lines.push("None.");
  } else {
    for (const url of opts.openPrs) lines.push(`- ${url}`);
  }
  lines.push("");

  lines.push("## Policy snapshot");
  lines.push("");
  const m = policy.models;
  lines.push(
    `- Models: propose=${m.propose}, judge=${m.judge}, implement=${m.implement}, diagnose=${m.diagnose}, reflect=${m.reflect}, audit=${m.audit}`,
  );
  const b = policy.budgets;
  lines.push(
    `- Budgets: ${b.maxWallMinutesPerHypothesis} wall-min/hypothesis, ${b.maxImplementTurns} implement turns, ${b.maxBuildSeconds}s build, ${b.minFreeDiskGb}GB free disk floor`,
  );
  lines.push(
    `- Bandit: explorationQuota=${policy.bandit.explorationQuota}, ucbC=${policy.bandit.ucbC}`,
  );
  const f = policy.fidelities;
  lines.push(
    `- Fidelity explore wall (s): screen=${f.screen.exploreWallSec}, promote=${f.promote.exploreWallSec}`,
  );
  const sq = policy.sequential;
  lines.push(
    `- Sequential: ${sq.exploreBudgetSec} s explore budget per chunk (interleaved grid, at most ${sq.maxRunsPerConfig} runs/config), objective rung events per explore-second, ${sq.minChunks}-${sq.maxChunks} chunks, reject at P(effect>=separable)<${sq.rejectP}, inconclusive at cap with P(better)>=${sq.inconclusiveP}, throughput floor ${1 - policy.regression.throughputTolerance}, resumes ${sq.maxResumes}`,
  );
  lines.push(
    `- Evaluation: spec=${policy.evaluation.spec}, audit every ${policy.audit.everyK} iterations`,
  );
  lines.push("");

  return lines.join("\n");
}

/** Render + write ROOT/research/STATUS.md. */
export function writeStatus(
  state: LoopState,
  policy: Policy,
  opts: StatusOpts,
): void {
  mkdirSync(dirname(STATUS_PATH), { recursive: true });
  writeFileSync(STATUS_PATH, renderStatus(state, policy, opts) + "\n");
}

/** Append a dated section to research/observations/OBSERVATIONS.md. */
export function appendObservation(text: string): void {
  mkdirSync(dirname(OBSERVATIONS_PATH), { recursive: true });
  if (!existsSync(OBSERVATIONS_PATH)) {
    writeFileSync(
      OBSERVATIONS_PATH,
      "# Observations\n\nDated notes appended by the research loop.\n",
    );
  }
  appendFileSync(
    OBSERVATIONS_PATH,
    `\n## ${new Date().toISOString()}\n\n${text.trimEnd()}\n`,
  );
}

/** Write ROOT/research/POLICY.md: rendered policy + clamps + changelog. */
export function renderPolicyMd(
  policy: Policy,
  clamps: string[],
  changelog: string[],
): void {
  const lines: string[] = [];
  lines.push("# Loop Policy");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    "Active (clamped) policy values. Hard limits are compiled into src/policy.ts and are not agent-editable.",
  );
  lines.push("");

  lines.push("## Models");
  lines.push("");
  lines.push("| Phase | Model |");
  lines.push("| --- | --- |");
  for (const [phase, model] of Object.entries(policy.models)) {
    lines.push(`| ${phase} | ${model} |`);
  }
  lines.push("");

  lines.push("## Bandit");
  lines.push("");
  lines.push(`- explorationQuota: ${policy.bandit.explorationQuota}`);
  lines.push(`- ucbC: ${policy.bandit.ucbC}`);
  lines.push("");

  lines.push("## Fidelities");
  lines.push("");
  lines.push(
    "| Rung | exploreWallSec | runsPerConfig | gradeMaxRuns | gradeBudgetMs | seeds |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const rung of ["screen", "promote"] as const) {
    const fd = policy.fidelities[rung];
    lines.push(
      `| ${rung} | ${fd.exploreWallSec} | ${fd.runsPerConfig} | ${fd.gradeMaxRuns} | ${fd.gradeBudgetMs} | ${fd.seeds.join(", ")} |`,
    );
  }
  lines.push("");

  lines.push("## Sequential evaluation");
  lines.push("");
  for (const [key, value] of Object.entries(policy.sequential)) {
    lines.push(`- ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }
  lines.push("");

  lines.push("## Budgets");
  lines.push("");
  for (const [key, value] of Object.entries(policy.budgets)) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push("");

  lines.push("## Proposal / Audit");
  lines.push("");
  lines.push(`- proposal.lenses: ${policy.proposal.lenses}`);
  lines.push(`- proposal.maxPoolSize: ${policy.proposal.maxPoolSize}`);
  lines.push(`- audit.everyK: ${policy.audit.everyK}`);
  lines.push("");

  lines.push("## Evaluation");
  lines.push("");
  lines.push(`- spec: ${policy.evaluation.spec}`);
  lines.push(`- configTemplate: ${policy.evaluation.configTemplate}`);
  lines.push(`- oracleDags: ${policy.evaluation.oracleDags.join(", ")}`);
  lines.push(`- rayonThreads: ${policy.evaluation.rayonThreads}`);
  lines.push("");

  lines.push("## Regression");
  lines.push("");
  for (const [key, value] of Object.entries(policy.regression)) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push("");

  lines.push("## Clamps applied on load");
  lines.push("");
  if (clamps.length === 0) {
    lines.push("None - policy file was within hard limits.");
  } else {
    for (const c of clamps) lines.push(`- ${c}`);
  }
  lines.push("");

  lines.push("## Changelog");
  lines.push("");
  if (changelog.length === 0) {
    lines.push("(empty)");
  } else {
    for (const entry of changelog) lines.push(`- ${entry}`);
  }
  lines.push("");

  mkdirSync(dirname(POLICY_MD_PATH), { recursive: true });
  writeFileSync(POLICY_MD_PATH, lines.join("\n"));
}

/** The recorded baseline must render a complete ladder: a blank column is a
 *  wiring error, not a missing measurement. */
export function selfTestRender(): string[] {
  const f: string[] = [];
  const p = join(SUPER, "research", "evaluations", "000-baseline.json");
  if (!existsSync(p)) return f;
  const parsed = z.object({ baseline: z.object({ sequential: z.array(Evaluation).default([]), confirm: z.array(Evaluation).default([]) }) }).safeParse(JSON.parse(readFileSync(p, "utf8")));
  if (!parsed.success) { f.push(`000-baseline.json does not parse: ${parsed.error.message.slice(0, 200)}`); return f; }
  const ladder = baselineLadder(parsed.data.baseline);
  if (ladder === null) { f.push("the recorded baseline pools to no ladder"); return f; }
  for (const line of ladderTable(null, ladder, null).slice(2)) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells[3] === "-") f.push(`baseline column blank for ${cells[1]}`);
  }
  const chunks = parsed.data.baseline.sequential.filter((e) => e.ok);
  if (chunks.length > 1 && ladder.runs !== chunks.reduce((a, e) => a + e.metrics.runs, 0)) f.push("pooled runs do not add up");
  return f;
}

