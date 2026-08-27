// Human-facing documents rendered from loop state. renderStatus is a pure
// string function; writeStatus / appendObservation / renderPolicyMd do the IO.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Evaluation, LadderMetrics } from "./schemas.js";
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

function ladderTable(
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
  rows.push(
    ["h1Rate", (m) => fmtNum(m.h1Rate)],
    ["h2Rate", (m) => fmtNum(m.h2Rate)],
    ["h2bRate", (m) => fmtNum(m.h2bRate)],
    ["h3Rate", (m) => fmtNum(m.h3Rate)],
    ["runsPerSec", (m) => m.runsPerSec.toFixed(1)],
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
    lines.push("| id | chunks | runs | P(depth>=4 up) | P(depth>=5 up) | resumes | last iteration |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const h of inconclusive) {
      const seq = loadSeqState(state, h.id);
      if (!seq) continue;
      const p4 = (seq.posteriors["depth>=4:pGreater"] ?? 0).toFixed(3);
      const p5 = (seq.posteriors["depth>=5:pGreater"] ?? 0).toFixed(3);
      lines.push(`| ${h.id} | ${seq.chunks} | ${seq.runs} | ${p4} | ${p5} | ${seq.resumes} | ${seq.lastIteration} |`);
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
    `- Sequential: ${sq.chunkRunsPerConfig} runs/config per chunk, ${sq.minChunks}-${sq.maxChunks} chunks, reject at P(effect>=separable)<${sq.rejectP}, inconclusive at cap with P(better)>=${sq.inconclusiveP}, resumes ${sq.maxResumes}`,
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
