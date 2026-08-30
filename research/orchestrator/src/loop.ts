// The iteration state machine. Deterministic control; agents only inside
// clearly fenced phases. Every phase is timed, journaled, and recoverable -
// an exception resets both repos to research/vr-loop and the loop continues.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  PROPOSAL_LENSES, ROOT, implementHypothesis, judgeHypotheses, proposeHypotheses,
  reflectOnOutcome, rejudgePool, runAudit, validateProposed,
} from "./agents.js";
import {
  CAMPAIGN_EPOCH_FLOOR, MERGE_Z, chunkStratum, classifyChangeRisk, compareToBaseline, finalGate,
  judgedByNonInferiority, objectiveCounts, perfGate, primaryDelta, stratumOf, unmeasurableReasons, type RatePrior,
} from "./decide.js";
import { collectProfile, runBench } from "./bench.js";
import { numericLeaves, runOneEvaluation, type EvalContext } from "./evaluate.js";
import { classifyChunkTiming, initialSeqState, loadSeqState, medianRps, pooledCountsOf, pooledFromSeq, runSequential, throughputRatioOf, type SeqKind } from "./sequential.js";
import {
  RESEARCH_BRANCH, SPUR, SUPER, SUPER_LANES, showFile, changedFiles, changedOnRef, checkout, checkoutPaths, commitHypothesisPair, commitPaths, createBranch, currentBranch, preservingOperatorTree, snapshotWork, rebaseOnto, resetBranchTo,
  currentCommit, deleteBranch, diffText, createPr, lintArmScope, lintArmSetGrowth, lintCampaignAllocation, lintInertConfigs, lintInertPolicyKeys, lintProtectedPaths, lintRulerSubject,
  lintVrNames, mergePrSquash, push, resetHard, tag, pushTag,
} from "./gitops.js";
import type { Policy } from "./policy.js";
import { POLICY_KEY_PATHS, loadPolicy } from "./policy.js";
import { CAMPAIGN_ONLY_KEYS, buildSpurCached, SPUR_BIN, cleanupDir, explore, materializeConfig, templateHasCampaign } from "./runners.js";
import { runRegression } from "./regression.js";
import { Evaluation, Hypothesis, type GateDecision, type SeqState } from "./schemas.js";
import { LoopState } from "./state.js";
import { appendObservation, baselineLadder, writeStatus } from "./render.js";
import { inactiveMechanisms, parseUtilization } from "./select.js";
import { z } from "zod";


export interface LoopDeps {
  state: LoopState;
  policy: Policy;
}

export function graderVersion(): string {
  const ta = execFileSync("git", ["log", "-1", "--format=%h", "--", "traceanalyzer"], { cwd: SUPER }).toString().trim();
  const porc = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: path.join(SUPER, "porcupine") }).toString().trim();
  return `ta:${ta}+porc:${porc}`;
}

const BaselineMeta = z.object({
  // Chunks gathered with the sequential protocol itself (chunk size, seed
  // family): the frontier rates depend on runs per config, so candidates
  // are only compared with a baseline measured the same way.
  sequential: z.array(Evaluation).default([]),
  runsPerSec: z.number(),
  // Thread count the baseline was measured at. Optional so a baseline
  // recorded before this field parses; absent means unknown, not equal.
  rayonThreads: z.number().int().positive().optional(),
});
export type BaselineMeta = z.infer<typeof BaselineMeta>;

export function loadReference(state: LoopState): BaselineMeta | null {
  const raw = state.getMeta("baseline0");
  if (!raw) return null;
  const p = BaselineMeta.safeParse(JSON.parse(raw));
  return p.success ? p.data : null;
}

// The archive violation rate a candidate's own violations are separated
// against. Violations arrive at about one per 4.5M runs, so four baseline
// chunks carry one roughly a fifth of the time and "the baseline saw none"
// decides on a coin flip. Not filtered by thread count: the per-run
// violation probability is a property of the corpus, not of the CPU mask.
// Read before the candidate's chunks are recorded, so a candidate never
// contributes to the rate it is judged against.
export function violationPrior(state: LoopState): RatePrior | null {
  let violations = 0;
  let runs = 0;
  let chunks = 0;
  for (const e of state.allEvaluations()) {
    if (e.fidelity !== "sequential" || !e.ok) continue;
    if ((e.epoch ?? 0) < CAMPAIGN_EPOCH_FLOOR) continue;
    violations += e.metrics.violations;
    runs += e.metrics.runs;
    chunks += 1;
  }
  return runs > 0 ? { violations, runs, chunks, sinceEpoch: CAMPAIGN_EPOCH_FLOOR } : null;
}

// Identity of the baseline a candidate's counts are comparable within: the
// superproject commit the chunks were measured at, and the arm set the rate
// stratum pools. Either moving makes the stored counts a different quantity.
export function baselineIdentity(evals: Evaluation[]): string {
  const s = stratumOf(evals);
  return `${evals[0]?.superCommit ?? ""}|${s === null ? "unstratified" : s.armIds.join(",")}`;
}

// The baseline holds at least as many chunks as any candidate can sample.
export function sequentialBaselineChunks(policy: Policy): number {
  return policy.sequential.maxChunks;
}

// Extend a set of sequential chunks to the baseline size using the seeds
// the candidate protocol would use next, so early candidate chunks pair
// with baseline chunks at the same seeds.
export async function topUpSequentialBaseline(ctx: EvalContext, existing: Evaluation[], target: number): Promise<Evaluation[]> {
  const p = ctx.policy.sequential;
  const evals = existing.filter((e) => e.ok && e.timingAnomaly === null);
  const used = new Set(evals.map((e) => e.seed));
  for (let seed = 1000; evals.length < target && seed < 1000 + 4 * target; seed++) {
    if (used.has(seed)) continue;
    const e = await runOneEvaluation(ctx, "baseline", "sequential", seed, {
      runsPerConfig: p.maxRunsPerConfig, exploreWallSec: p.exploreBudgetSec, exploreBudgetSec: p.exploreBudgetSec,
      gradeMaxRuns: 0, gradeBudgetMs: p.wallSecPerChunk * 1000,
    });
    if (!e.ok) continue;
    // A baseline chunk with no per-arm accounting cannot enter the pool: it
    // would poison the stratum every later candidate is compared against.
    if (chunkStratum(e) === null) {
      console.log(`baseline chunk seed ${seed} excluded: no per-arm accounting`);
      continue;
    }
    // The baseline has no candidate to be slow: a chunk far off its own
    // siblings' throughput is the host, and it must not set the rate the
    // candidates are held to.
    const anomaly = classifyChunkTiming(e, evals.length >= 2 ? medianRps(pooledCountsOf(evals)) : null, false);
    if (anomaly !== null) {
      console.log(`baseline chunk seed ${seed} excluded: ${anomaly}`);
      continue;
    }
    evals.push(e);
  }
  return evals;
}

// One baseline per thread count: the explorer shares a feedback map across
// the parallel run set, so a baseline is only a baseline for the count it
// was measured at, and a host that changes its CPU mask needs its own.
export function baselineKey(threads: number): string {
  return `baseline:${threads}`;
}

export function baselineEvidencePath(threads: number): string {
  return path.join(ROOT, "research/evaluations", `000-baseline-${threads}.json`);
}

function parseBaseline(raw: string | null): BaselineMeta | null {
  if (!raw) return null;
  const p = BaselineMeta.safeParse(JSON.parse(raw));
  return p.success ? p.data : null;
}

// A baseline stored before the keyed store existed lives under the bare key
// with its thread count inside; it is adopted under the keyed name the first
// time that count asks for it, and the bare key is not read again after.
export function loadBaseline(state: LoopState, threads: number): BaselineMeta | null {
  const keyed = parseBaseline(state.getMeta(baselineKey(threads)));
  if (keyed) return keyed;
  const legacyRaw = state.getMeta("baseline");
  const legacy = parseBaseline(legacyRaw);
  if (legacy && legacyRaw && legacy.rayonThreads === threads) {
    state.setMeta(baselineKey(threads), legacyRaw);
    return legacy;
  }
  return null;
}

// A baseline is current when the spur tree it was measured on is the tree
// at HEAD. Trees, not commits: a squash merge changes the commit and keeps
// the tree. An unknown answer means the recorded commit object is gone.
export type BaselineFreshness = "current" | "stale" | "unknown";
export function baselineFreshness(baseline: BaselineMeta): BaselineFreshness {
  const measured = baseline.sequential[0]?.spurCommit;
  if (!measured) return "unknown";
  const treeOf = (rev: string): string | null => {
    try { return execFileSync("git", ["rev-parse", "--verify", `${rev}^{tree}`], { cwd: SPUR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { return null; }
  };
  const a = treeOf(measured), b = treeOf("HEAD");
  if (a === null || b === null) return "unknown";
  return a === b ? "current" : "stale";
}

export interface BaselineListing { threads: number; spurCommit: string; chunks: number; freshness: BaselineFreshness; runsPerSec: number }
// Where the last k finished iterations spent their wall, what a sequential
// chunk costs, and what the iterations produced. One line for `cli status`
// and the operator's direction review; thresholds live in the skill.
export function iterationEconomy(state: LoopState, k = 20): string {
  const its = state.recentIterations(k * 3)
    .filter((i) => i.finishedAt !== null && Object.values(i.phaseTimings).reduce((a, b) => a + b, 0) >= 60)
    .slice(0, k);
  if (its.length === 0) return "iteration economy: no finished iterations recorded";
  const sum: Record<string, number> = {};
  for (const i of its) for (const [phase, sec] of Object.entries(i.phaseTimings)) sum[phase] = (sum[phase] ?? 0) + sec;
  const total = Object.values(sum).reduce((a, b) => a + b, 0);
  const min = (sec: number): string => (sec / its.length / 60).toFixed(1);
  const pct = (sec: number): string => `${Math.round((100 * sec) / total)}%`;
  const named = ["evaluate", "implement", "rejudge", "regression"];
  const other = Object.entries(sum).filter(([p]) => !named.includes(p)).reduce((a, [, s]) => a + s, 0);
  const phases = named.filter((p) => sum[p]).map((p) => `${p} ${min(sum[p] ?? 0)} (${pct(sum[p] ?? 0)})`).concat(other > 0 ? [`other ${min(other)}`] : []).join(", ");
  const chunks = state.allEvaluations().filter((e) => e.fidelity === "sequential" && e.ok).slice(-8);
  const chunk = chunks.length === 0 ? "no sequential chunk yet" : (() => {
    const explore = chunks.reduce((a, e) => a + e.exploreWallMs, 0) / chunks.length / 1000;
    const grade = chunks.reduce((a, e) => a + e.metrics.gradeWallMs, 0) / chunks.length / 1000;
    return `chunk ${Math.round(explore)} s explore + ${Math.round(grade)} s grade (${Math.round((100 * grade) / (explore + grade))}%)`;
  })();
  const since = its[its.length - 1]?.startedAt ?? new Date(0).toISOString();
  const decisions = state.decisionsSince(since);
  const merges = decisions.filter((d) => d.verdict === "auto_merge").length;
  return `iteration economy (last ${its.length}): ${(total / its.length / 60).toFixed(0)} min each - ${phases}; ${chunk}; ${decisions.length} decisions, ${merges} merges`;
}

export function listBaselines(state: LoopState): BaselineListing[] {
  const out: BaselineListing[] = [];
  for (const key of state.metaKeys("baseline:")) {
    const threads = Number(key.slice("baseline:".length));
    const b = parseBaseline(state.getMeta(key));
    if (!Number.isFinite(threads) || !b) continue;
    out.push({ threads, spurCommit: (b.sequential[0]?.spurCommit ?? "").slice(0, 7), chunks: b.sequential.length, freshness: baselineFreshness(b), runsPerSec: b.runsPerSec });
  }
  return out.sort((x, y) => x.threads - y.threads);
}

/** The keyed store keeps one baseline per thread count and adopts the bare
 *  key exactly once. */
export function selfTestBaselineKeys(): string[] {
  const f: string[] = [];
  const check = (c: boolean, m: string): void => { if (!c) f.push(m); };
  const dir = path.join(ROOT, "tmp", "loop", `selftest-state-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  const state = new LoopState(path.join(dir, "state.sqlite"));
  try {
    const meta = (threads: number, rps: number): string =>
      JSON.stringify({ sequential: [], runsPerSec: rps, rayonThreads: threads });
    state.setMeta(baselineKey(14), meta(14, 100));
    state.setMeta(baselineKey(30), meta(30, 600));
    check(loadBaseline(state, 14)?.runsPerSec === 100, "loadBaseline picks the 14-thread baseline");
    check(loadBaseline(state, 30)?.runsPerSec === 600, "loadBaseline picks the 30-thread baseline");
    check(loadBaseline(state, 6) === null, "an unmeasured thread count has no baseline");
    state.setMeta("baseline", meta(6, 50));
    check(loadBaseline(state, 8) === null, "a bare baseline for another count is not adopted");
    check(loadBaseline(state, 6)?.runsPerSec === 50, "a bare baseline for this count is adopted");
    check(state.getMeta(baselineKey(6)) !== null, "adoption writes the keyed entry");
    state.setMeta("baseline", meta(6, 51));
    check(loadBaseline(state, 6)?.runsPerSec === 50, "the bare key is not read once the keyed entry exists");
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return f;
}

export function journal(state: LoopState, iteration: number, event: string, data: unknown): void {
  state.appendJournal({ atIso: new Date().toISOString(), iteration, event, data });
}

const stopRequested = (): boolean => existsSync(path.join(ROOT, "research", "STOP"));

const DRAIN_PATH = path.join(ROOT, "research", "DRAIN");
const PARKED_PATH = path.join(ROOT, "research", "PARKED");
const POLICY_PATH = path.join(ROOT, "research", "policy.json");

// A hold nobody releases must not idle the loop indefinitely.
const DEFAULT_MAX_HOLD_SEC = 6 * 3600;

interface DrainRequest { owner?: string; reason?: string; maxHoldSec?: number }

// An empty `touch research/DRAIN` is a valid request; so is unparseable
// content, since refusing to park on a typo defeats the point of the hold.
const drainRequest = (): DrainRequest | null => {
  if (!existsSync(DRAIN_PATH)) return null;
  try {
    const raw = readFileSync(DRAIN_PATH, "utf8").trim();
    return raw.length === 0 ? {} : (JSON.parse(raw) as DrainRequest);
  } catch {
    return {};
  }
};

// A retriable implement hang requeues the hypothesis; this many in a row
// without a single model turn is treated as a sustained outage instead.
const MAX_CONSECUTIVE_IMPL_HANGS = 3;

// An inconclusive hypothesis is resumed only if a frontier rung still has at
// least this probability of reaching the separable minimum; below it, more
// data cannot change the verdict against the fixed baseline.
const RESUME_PMEI_MIN = 0.15;

// Graceful stop mid-iteration: keep whatever exists on the hypothesis branch
// (committed), park the hypothesis with a pointer to that branch, and return
// to the research branch WITHOUT deleting the work. Startup recovery requeues
// [stop]-parked hypotheses.
function parkForStop(state: LoopState, n: number, h: Hypothesis, branch: string, phase: string): void {
  try {
    commitHypothesisPair({ branch, spurMessage: `wip ${h.id} (stopped at ${phase})`, superMessage: `wip ${h.id} (stopped at ${phase})` });
  } catch { /* nothing to commit is fine */ }
  state.upsertHypothesis({ ...h, status: "parked", branch, notes: `[stop] parked at ${phase} in iteration ${n}; partial work on branch ${branch}` });
  journal(state, n, "stopped", { phase, branch });
  cleanupToResearchBranch(null);
}

// Observations live in a tracked file that the next preflight resets, so
// every append is committed on the research branch at once.
export const PROFILE_PATH = "research/observations/PROFILE.md";

// The explorer profile the proposer's perf lens and the judge read. Written
// only from a successful perf record, so a locked perf leaves the last good
// profile in place; the header dates it.
export function writeProfileObservation(policy: Policy, by: string, report: string): void {
  const header = [
    "# Explorer profile",
    "",
    `Generated ${new Date().toISOString()} at ${by}: perf record on the bench workload (${policy.perf.benchConfig}, ${policy.evaluation.rayonThreads} threads, spur ${currentCommit(SPUR).slice(0, 7)}), top symbols by self time, perf report --no-children --percent-limit 1.`,
    "",
    "A perf hypothesis names one of these symbols as its hotspot. Symbols that belong to the writer or the grader instrumentation are not candidates: the ladder and regression gates reject their removal.",
    "",
    "```",
  ].join("\n");
  writeFileSync(path.join(ROOT, PROFILE_PATH), `${header}\n${report.trimEnd()}\n\`\`\`\n`);
}

function persistObservations(n: number): void {
  try {
    if (currentBranch(SUPER) !== RESEARCH_BRANCH) return;
    if (commitPaths(SUPER, ["research/observations/OBSERVATIONS.md", PROFILE_PATH], `observations through iteration ${n}`)) push(SUPER, RESEARCH_BRANCH);
  } catch (err) {
    console.error(`observations not persisted: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readStatusMd(): string {
  const p = path.join(ROOT, "research/STATUS.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "(no status yet)";
}

function preflight(): void {
  // Any stray working-tree state (a killed implement, an operator slip) must
  // never leak into the next hypothesis's diff. Implementer edits only
  // survive via commitHypothesisPair onto the hyp/* branch within the same
  // iteration. spur is a lane in its entirety, so it still resets whole; the
  // superproject carries the operator's tree beside the loop's lanes, so its
  // reset is scoped and anything dirty outside the lanes is held aside.
  if (currentBranch(SPUR) !== RESEARCH_BRANCH) checkout(SPUR, RESEARCH_BRANCH);
  resetHard(SPUR, RESEARCH_BRANCH);
  run0("git", ["clean", "-fd", "--", "."], SPUR);
  preservingOperatorTree(SUPER, SUPER_LANES, () => {
    if (currentBranch(SUPER) !== RESEARCH_BRANCH) checkout(SUPER, RESEARCH_BRANCH);
    resetHard(SUPER, RESEARCH_BRANCH);
    run0("git", ["clean", "-fd", "--", ...SUPER_LANES], SUPER);
  });
}

// The stored utilization dump as sorted `path = value` lines. An agent that
// reads only the evaluation record sees a projection of the counters, so a
// mechanism whose counter was dropped there reads as unmeasurable and the
// reflection proposes instrumenting what already exists.
function counterLines(state: LoopState): string {
  const raw = state.getMeta("utilization");
  if (!raw) return "(no utilization snapshot)";
  try {
    const out: Record<string, number> = {};
    numericLeaves(JSON.parse(raw) as unknown, "", out);
    const keys = Object.keys(out).sort();
    return keys.length > 0 ? keys.map((k) => `${k} = ${out[k]}`).join("\n") : "(snapshot holds no counters)";
  } catch {
    return "(utilization snapshot unreadable)";
  }
}

// Everything the pool admits passes the judge, whatever produced it.
// Reflection supplies most candidates and its prompt carries one
// hypothesis's evidence with no view of the pool, so a child cannot know
// what already exists; routing only the proposer's output through the judge
// applied the deduplication rule to a small minority of entries.
async function admitCandidates(
  deps: LoopDeps, iteration: number, candidates: unknown[], source: string, parent?: string,
): Promise<void> {
  const { state, policy } = deps;
  if (candidates.length === 0) return;
  const poolSummaries = state.listHypotheses().map((h) => `${h.id} [${h.kind}/${h.status}]: ${h.title}`);
  const judged = await judgeHypotheses(policy, candidates, poolSummaries, calibrationTable(state), evaluationContext(state, policy));
  const kept = judged.value?.hypotheses ?? candidates;
  const { valid, rejected } = validateProposed(kept);
  const room = Math.max(0, policy.proposal.maxPoolSize - state.listHypotheses("proposed").length);
  let admitted = 0;
  for (const h of valid.slice(0, room)) {
    if (state.getHypothesis(h.id)) continue;
    state.upsertHypothesis(parent === undefined ? h : { ...h, parent: h.parent ?? parent });
    admitted++;
  }
  // Counted apart because they answer different questions: how selective the
  // judge was, and how much of its output failed to parse. One field for
  // both read as zero rejections while four in five candidates were dropped.
  journal(state, iteration, "judge", {
    source, seen: candidates.length, admitted,
    droppedByJudge: Math.max(0, candidates.length - kept.length),
    malformed: rejected.length, judgeCost: judged.costUsd,
  });
}

async function refillPool(deps: LoopDeps, iteration: number): Promise<void> {
  const { state, policy } = deps;
  const proposed = state.listHypotheses("proposed");
  if (proposed.length >= 6) return;
  const statusMd = readStatusMd();
  const existingIds = state.listHypotheses().map((h) => h.id);
  const lenses = PROPOSAL_LENSES.slice(0, policy.proposal.lenses);
  const evalContext = evaluationContext(state, policy);
  const results = await Promise.all(lenses.map((lens) => proposeHypotheses(policy, lens, statusMd, existingIds, evalContext)));
  const candidates = results.flatMap((r) => r.value?.hypotheses ?? []);
  const errors = results.map((r) => r.error).filter((e): e is string => Boolean(e));
  const cost = results.reduce((a, r) => a + r.costUsd, 0);
  journal(state, iteration, "propose", { lenses: lenses.length, candidates: candidates.length, cost });
  // Every lens failing without spending anything is an infrastructure fault
  // (expired credentials, no network), not a model that had nothing to say.
  // Raising it here routes it to the driver's backoff-and-exit path instead
  // of leaving the pool empty and the loop spinning.
  if (candidates.length === 0 && errors.length === lenses.length && cost === 0) {
    journal(state, iteration, "error", { stage: "propose", lenses: lenses.length, error: errors[0] });
    throw new Error(`all ${lenses.length} proposal lenses failed at zero cost: ${errors[0]}`);
  }
  if (candidates.length === 0) return;
  await admitCandidates(deps, iteration, candidates, "propose");
}

// What a candidate is measured on: the general config's mode settings and
// the mechanisms that record no activity under it.
export function evaluationContext(state: LoopState, policy: Policy): string {
  let modes = "(config unreadable)";
  try {
    const cfg = JSON.parse(readFileSync(path.join(ROOT, policy.evaluation.configTemplate), "utf8")) as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const k of Object.keys(cfg)) if (typeof cfg[k] !== "object" || k === "feedback") picked[k] = cfg[k];
    modes = JSON.stringify(picked);
  } catch { /* reported as unreadable */ }
  const inactive = inactiveMechanisms(parseUtilization(state.getMeta("utilization")));
  let campaign = "";
  if (templateHasCampaign(path.join(ROOT, policy.evaluation.configTemplate))) {
    try {
      const cfg = JSON.parse(readFileSync(path.join(ROOT, policy.evaluation.configTemplate), "utf8")) as { campaign: { allocation?: { kind?: string }; reward?: { kind?: string }; arms: Array<{ id: string; mode: string; overlay?: Record<string, unknown> }> } };
      const arms = cfg.campaign.arms.map((a) => `${a.id} (${a.mode}${a.overlay && Object.keys(a.overlay).length ? ", " + JSON.stringify(a.overlay) : ""})`).join("; ");
      campaign = `\nThe evaluation is a campaign: one session of ${policy.sequential.exploreBudgetSec} s split across arms by ${cfg.campaign.allocation?.kind ?? "round_robin"} allocation (reward ${cfg.campaign.reward?.kind ?? "termination_completed"}), each arm keeping its own feedback state. Arms: ${arms}. The ladder is the union of the arms; per-arm rung rates are recorded in every evaluation. An arm-kind hypothesis edits only the campaign block (add, drop or re-overlay a generic arm); a mechanism a hypothesis adds to spur is measured under every arm that enables it.`;
    } catch { /* reported without the arm list */ }
  }
  return `Primary objective: depth>=6 events per explore-second, the per-run rung probability times runs per second (GOAL.md rule 6); depth>=7 extends sampling and depth>=8 is recorded.\nExplorer: -e ${policy.evaluation.explorer} on ${policy.evaluation.configTemplate}; scalar settings ${modes}.${campaign}\nMechanisms with zero recorded activity under this config: ${inactive.length ? inactive.join(", ") : "(none)"}. A change whose effect is confined to one of these cannot be measured; it has to be an enabling hypothesis that switches the mechanism on in the general config, and buildsOn must name the mechanisms a change needs to be active.`;
}

// Number of top-level keys in the general evaluation config: the loop's
// visible parameter surface, recorded before and after every hypothesis.
function generalConfigParamCount(policy: Policy): number {
  try {
    const cfg = JSON.parse(readFileSync(path.join(ROOT, policy.evaluation.configTemplate), "utf8")) as Record<string, unknown>;
    return Object.keys(cfg).length;
  } catch {
    return -1;
  }
}

export function calibrationTable(state: LoopState): string {
  return state.recentDecisions(30).reverse()
    .map(({ hypothesis: x, decision: d }) => `${x.id} [${x.kind}]: predicted gain ${x.expectedGain}/cost ${x.expectedCost} -> ${d.verdict}, primary delta (relative) ${"primary" in d.objectiveDeltas ? (d.objectiveDeltas["primary"] as number).toFixed(4) : "not measured"}`)
    .join("\n");
}

// Where recent implement sessions spent wall time (model thinking vs tool
// categories) and how many builds/edits each ran, so the auditor can see
// over-building or thinking-dominated implements rather than only the
// phase-level total.
function implementActivityDigest(k: number): string {
  try {
    const lines = readFileSync(path.join(ROOT, "research/journal.jsonl"), "utf8").trim().split("\n");
    const acts: Array<{ modelMs: number; toolMs: Record<string, number>; toolCounts: Record<string, number> }> = [];
    for (let i = lines.length - 1; i >= 0 && acts.length < k; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        const e = JSON.parse(line) as { event?: string; data?: { activity?: { modelMs: number; toolMs: Record<string, number>; toolCounts: Record<string, number> } } };
        if (e.event === "implement" && e.data?.activity) acts.push(e.data.activity);
      } catch { /* skip malformed line */ }
    }
    if (acts.length === 0) return "implement activity: none recorded yet";
    const sum: Record<string, number> = {};
    let builds = 0;
    let edits = 0;
    for (const a of acts) {
      sum.model = (sum.model ?? 0) + a.modelMs;
      for (const [cat, ms] of Object.entries(a.toolMs)) sum[cat] = (sum[cat] ?? 0) + ms;
      builds += a.toolCounts.build ?? 0;
      edits += a.toolCounts.edit ?? 0;
    }
    const s = (key: string): number => Math.round((sum[key] ?? 0) / acts.length / 1000);
    return `implement activity (last ${acts.length}, mean s/iteration): model/think ${s("model")}, build ${s("build")}, smoke ${s("smoke")}, test ${s("test")}, edit ${s("edit")}, read ${s("read")}, shell ${s("shell")}; mean cargo builds ${(builds / acts.length).toFixed(1)}, edits ${(edits / acts.length).toFixed(1)} per iteration`;
  } catch {
    return "implement activity: digest unavailable";
  }
}

function recentEvidence(state: LoopState, limit: number): string {
  const cur = state.currentEpoch();
  // Newest decisions, rendered oldest-to-newest so the model reads a chronology.
  return state.recentDecisions(limit).reverse().map(({ hypothesis: x, decision: d }) => {
    const stale = (d.epoch ?? 1) !== cur ? " [SUPERSEDED regime: verdict may not hold under the current gate/protocol]" : "";
    const harness = d.harnessFailure ? " [harness failure, not evidence]" : "";
    return `${x.id} [${x.kind}] -> ${d.verdict}${stale}${harness}: ${d.reasons.join("; ")} | deltas (relative, violations absolute) ${JSON.stringify(d.objectiveDeltas)} | notes: ${x.notes.slice(0, 200)}`;
  }).join("\n");
}

export async function rejudge(state: LoopState, policy: Policy, n: number, trigger: string): Promise<void> {
  // Entries the re-judge itself parked are reconsidered too, so a blocker
  // that later clears (a merged enabler, a new measurement) can bring them
  // back. Operator- and stop-parked entries are left alone.
  const pool = [
    ...state.listHypotheses("proposed"),
    ...state.listHypotheses("parked").filter((h) => h.notes.startsWith("[rejudged")),
  ];
  if (pool.length === 0) return;
  const r = await rejudgePool(policy, pool, calibrationTable(state), recentEvidence(state, 12), state.getMeta("utilization") ?? "(no snapshot)");
  if (!r.value) { journal(state, n, "rejudge", { trigger, error: r.error }); return; }
  let parked = 0;
  let rescored = 0;
  for (const u of r.value.updates) {
    const h = state.getHypothesis(u.id);
    if (!h || (h.status !== "proposed" && h.status !== "parked")) continue;
    if (u.action === "keep" && h.status === "parked") {
      state.upsertHypothesis({ ...h, status: "proposed", expectedGain: u.expectedGain, expectedCost: u.expectedCost, notes: `[unparked ${trigger}] ${u.reason}`.slice(0, 400) });
      rescored++;
      continue;
    }
    if (u.action === "park") {
      state.upsertHypothesis({ ...h, status: "parked", notes: `[rejudged ${trigger}] ${u.reason}`.slice(0, 400) });
      parked++;
    } else if (u.expectedGain !== h.expectedGain || u.expectedCost !== h.expectedCost) {
      state.upsertHypothesis({ ...h, expectedGain: u.expectedGain, expectedCost: u.expectedCost, notes: `${h.notes} [rejudged ${trigger}: ${u.reason}]`.slice(0, 400) });
      rescored++;
    }
  }
  journal(state, n, "rejudge", { trigger, pool: pool.length, rescored, parked, cost: r.costUsd });
}

function evalJsonPath(iteration: number, id: string): string {
  return path.join(ROOT, "research/evaluations", `${String(iteration).padStart(3, "0")}-${id}.json`);
}

interface MergeOutcome { prUrls: string[]; merged: boolean; detail: string }

export function mergeFlow(iteration: number, h: Hypothesis, branch: string, evidence: unknown, autoMerge: boolean): MergeOutcome {
  const prUrls: string[] = [];
  // Persist the evidence file into the super branch before the PR.
  mkdirSync(path.dirname(evalJsonPath(iteration, h.id)), { recursive: true });
  writeFileSync(evalJsonPath(iteration, h.id), JSON.stringify(evidence, null, 2));
  commitHypothesisPair({
    branch,
    spurMessage: `${h.id}: ${h.title}\n\n${h.description.slice(0, 1200)}`,
    superMessage: `${h.id}: ${h.title} (evidence + pointer bump)`,
  });
  // The Rust work was committed earlier in the iteration; what matters is
  // whether spur's branch differs from the research branch at all.
  const spurCommit: string | null = changedFiles(SPUR, RESEARCH_BRANCH).length > 0 ? currentCommit(SPUR) : null;
  const body = `Hypothesis: ${h.id} (${h.kind})\n\n${h.description}\n\nEvidence: research/evaluations/${String(iteration).padStart(3, "0")}-${h.id}.json\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
  if (spurCommit) {
    push(SPUR, branch, { setUpstream: true });
    const url = createPr({ cwd: SPUR, base: RESEARCH_BRANCH, head: branch, title: `[loop] ${h.title}`, body, label: "auto-research" });
    prUrls.push(url);
    if (autoMerge) {
      if (!mergePrSquash(SPUR, url)) return { prUrls, merged: false, detail: "spur PR merge failed" };
      syncToOrigin(SPUR);
      // Re-point the super branch's submodule at the merged head.
      run0("git", ["add", "spur"], SUPER);
      run0("git", ["commit", "--allow-empty", "-m", `bump spur to merged ${h.id}\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>`], SUPER);
    }
  }
  push(SUPER, branch, { setUpstream: true });
  const superUrl = createPr({ cwd: SUPER, base: RESEARCH_BRANCH, head: branch, title: `[loop] ${h.title}`, body: body + (prUrls[0] ? `\n\nspur PR: ${prUrls[0]}` : ""), label: "auto-research" });
  prUrls.push(superUrl);
  if (!autoMerge) return { prUrls, merged: false, detail: "left open for human review" };
  if (!mergePrSquash(SUPER, superUrl)) return { prUrls, merged: false, detail: "super PR merge failed" };
  syncToOrigin(SUPER);
  tag(SUPER, `loop/${String(iteration).padStart(3, "0")}`);
  pushTag(SUPER, `loop/${String(iteration).padStart(3, "0")}`);
  return { prUrls, merged: true, detail: "merged" };
}

function run0(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8" });
}

// After a squash-merge, origin is the source of truth and local branch
// history may legitimately diverge - sync by reset, never by merge/pull.
function syncToOrigin(repo: string): void {
  const sync = (): void => {
    run0("git", ["fetch", "origin", RESEARCH_BRANCH], repo);
    run0("git", ["checkout", "--force", RESEARCH_BRANCH], repo);
    run0("git", ["reset", "--hard", `origin/${RESEARCH_BRANCH}`], repo);
  };
  if (repo === SPUR) sync();
  else preservingOperatorTree(SUPER, SUPER_LANES, sync);
}

// An underpowered but probable effect keeps its work: both branches are
// pushed (no PR) and the hypothesis becomes resumable.
function markInconclusive(state: LoopState, n: number, h: Hypothesis, branch: string, seq: SeqState, reason: string, spurChanged: boolean): void {
  try {
    if (spurChanged) push(SPUR, branch, { setUpstream: true });
    push(SUPER, branch, { setUpstream: true });
  } catch { /* the local branches still hold the work */ }
  const best = Math.max(seq.posteriors["depth>=4:pGreater"] ?? 0, seq.posteriors["depth>=5:pGreater"] ?? 0, seq.posteriors["depth>=6:pGreater"] ?? 0);
  state.setMeta(`seq:${h.id}`, JSON.stringify({ ...seq, lastIteration: n }));
  state.upsertHypothesis({ ...h, status: "inconclusive", branch, notes: `[inconclusive iteration ${n}] ${reason}; pGreater ${best.toFixed(3)} after ${seq.chunks} chunks / ${seq.runs} runs; resumes ${seq.resumes}` });
  journal(state, n, "inconclusive", { id: h.id, reason, chunks: seq.chunks, runs: seq.runs, posteriors: seq.posteriors, resumes: seq.resumes });
  cleanupToResearchBranch(null);
}

function cleanupToResearchBranch(branch: string | null): void {
  for (const repo of [SPUR, SUPER]) {
    const reset = (): void => {
      run0("git", ["checkout", "--force", RESEARCH_BRANCH], repo);
      resetHard(repo, RESEARCH_BRANCH);
      if (branch) { try { deleteBranch(repo, branch); } catch { /* branch may not exist here */ } }
    };
    try {
      if (repo === SPUR) reset();
      else preservingOperatorTree(SUPER, SUPER_LANES, reset);
    } catch { /* keep going; next preflight will surface persistent damage */ }
  }
}

async function collectUtilization(policy: Policy): Promise<string> {
  const outDir = path.join(ROOT, "tmp/loop/audit-util");
  try {
    const cfg = path.join(ROOT, "tmp/loop/audit-util-config.json");
    materializeConfig(path.join(ROOT, policy.evaluation.configTemplate), cfg, {
      runsPerConfig: 20, sessionSeed: 4242, extra: { stats: true }, dropKeys: CAMPAIGN_ONLY_KEYS,
    });
    const r = await explore({ binary: SPUR_BIN, configPath: cfg, spec: path.join(ROOT, policy.evaluation.spec), outputDir: outDir, wallSec: 90, rayonThreads: policy.evaluation.rayonThreads });
    void r;
    const util = path.join(outDir, "utilization.json");
    return existsSync(util) ? readFileSync(util, "utf8") : "(no utilization.json produced)";
  } catch (e) {
    return `(utilization collection failed: ${String(e)})`;
  } finally {
    try { cleanupDir(outDir); } catch { /* ignore */ }
  }
}

// Set when an iteration found nothing to work on. An idle iteration costs
// almost no wall time, so the driver must pace itself rather than spin.
export let lastIterationIdle = false;

function flattenPolicy(v: unknown, prefix: string, out: Record<string, string>): void {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, sub] of Object.entries(v as Record<string, unknown>)) flattenPolicy(sub, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  out[prefix] = JSON.stringify(v);
}

// research/policy.json is the one file the loop reads once at start rather
// than per prompt. A park is the operator taking the boundary, so it is also
// where a policy edit lands - never mid-iteration, where a change under
// sequential or evaluation would give one candidate chunks measured under
// two protocols. A malformed file keeps the policy in force; refusing to
// resume over a typo would be worse than ignoring it.
function reloadPolicy(deps: LoopDeps): Record<string, unknown> {
  let next: { policy: Policy; clamps: string[] };
  try {
    next = loadPolicy(POLICY_PATH);
  } catch (e) {
    return { policyReloadRefused: `unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  flattenPolicy(deps.policy, "", before);
  flattenPolicy(next.policy, "", after);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort();
  if (changed.length === 0) return {};
  if (next.policy.evaluation.rayonThreads !== deps.policy.evaluation.rayonThreads) {
    return { policyReloadRefused: "evaluation.rayonThreads keys the baseline", changed };
  }
  const measurement = changed.filter((k) => /^(sequential|evaluation)\./.test(k));
  const sampling = deps.state.listHypotheses("inconclusive").some((h) => loadSeqState(deps.state, h.id) !== null);
  if (sampling && measurement.length > 0) {
    return { policyReloadRefused: `sampling in flight; ${measurement.join(", ")} would change what a chunk means`, changed };
  }
  deps.policy = next.policy;
  return { policyReload: changed, clamps: next.clamps };
}

// DRAIN is the boundary hold, and it is read here and nowhere else: the
// iteration in flight keeps its decision, its merge and its reflection, and
// the loop stops between iterations with nothing in hand. STOP keeps its
// abort semantics for a wedged phase, and taken while parked it exits from a
// state that has nothing to lose. PARKED is what a second process waits on
// rather than sleeping and hoping.
async function parkForDrain(deps: LoopDeps): Promise<"ran" | "stop"> {
  let req = drainRequest();
  if (req === null) return "ran";
  const n = deps.state.currentIteration();
  const owner = req.owner ?? "operator";
  const maxHoldSec = typeof req.maxHoldSec === "number" && req.maxHoldSec > 0 ? req.maxHoldSec : DEFAULT_MAX_HOLD_SEC;
  const startedMs = Date.now();
  const parkedAtIso = new Date().toISOString();
  journal(deps.state, n, "parked", { owner, reason: req.reason ?? null, maxHoldSec });
  console.log(`DRAIN held by ${owner}; parked at the iteration boundary`);
  let expired = false;
  for (;;) {
    if (stopRequested()) { rmSync(PARKED_PATH, { force: true }); return "stop"; }
    const heldSec = Math.round((Date.now() - startedMs) / 1000);
    writeFileSync(PARKED_PATH, `${JSON.stringify({ iteration: n, owner, parkedAtIso, heldSec })}\n`);
    req = drainRequest();
    if (req === null) break;
    if (heldSec >= maxHoldSec) { expired = true; break; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  rmSync(PARKED_PATH, { force: true });
  const parkedSec = Math.round((Date.now() - startedMs) / 1000);
  if (expired) journal(deps.state, n, "park_expired", { owner, parkedSec, maxHoldSec });
  journal(deps.state, n, "resumed", { owner, parkedSec, ...reloadPolicy(deps) });
  return "ran";
}

export async function runIteration(deps: LoopDeps): Promise<void> {
  lastIterationIdle = false;
  const { state, policy } = deps;
  const n = state.beginIteration();
  const timings: Record<string, number> = {};
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now(); // monotonic: phase timings exclude suspend
    try { return await fn(); } finally { timings[name] = (timings[name] ?? 0) + (performance.now() - t0) / 1000; }
  };
  let branch: string | null = null;
  let notes = "";

  try {
    preflight();
    const baseline = loadBaseline(state, policy.evaluation.rayonThreads);
    if (!baseline) throw new Error(`no baseline recorded at ${policy.evaluation.rayonThreads} threads - run \`loop baseline\` first`);

    await timed("propose", () => refillPool(deps, n));
    const { selectNext } = await import("./select.js");
    // Pick and claim in one transaction so a concurrent operator edit cannot
    // land between the read and the status change.
    const h = state.transaction(() => {
      const picked = selectNext(state, policy);
      if (picked && picked.kind !== "grader") {
        state.upsertHypothesis({ ...picked, status: "selected" });
        const ring = JSON.parse(state.getMeta("recentSelections") ?? "[]") as string[];
        ring.push(picked.id);
        while (ring.length > 20) ring.shift();
        state.setMeta("recentSelections", JSON.stringify(ring));
      }
      return picked;
    });
    if (!h) { notes = "empty pool"; lastIterationIdle = true; journal(state, n, "select", { none: true }); return; }
    if (h.kind === "grader") {
      // Changes to the grader change what progress means; they are queued
      // for an operator decision instead of implemented by the loop.
      state.upsertHypothesis({ ...h, status: "parked", notes: `[grader-review] awaiting operator evaluation (iteration ${n})` });
      journal(state, n, "grader_review", { id: h.id, title: h.title, description: h.description, rationale: h.rationale, buildsOn: h.buildsOn, expectedGain: h.expectedGain, expectedCost: h.expectedCost });
      notes = `grader proposal ${h.id} queued for review`;
      return;
    }
    const resuming = h.status === "inconclusive" && h.branch !== null;
    const priorSeq = resuming ? loadSeqState(state, h.id) : null;
    journal(state, n, "select", { id: h.id, kind: h.kind, title: h.title, resuming });

    const paramsBefore = generalConfigParamCount(policy);
    let spurFiles: string[] = [];
    let superFiles: string[] = [];
    let implSummary = "";
    let superCommit: string;
    if (resuming && h.branch) {
      // The implementation already lives on the hypothesis branch. It must
      // contain everything the current baseline contains: the spur branch is
      // rebased, and the superproject branch is rebuilt on the research head
      // with the hypothesis's own files restored (a plain rebase would always
      // conflict on the submodule pointer). A file changed on both sides, or
      // a spur conflict, ends the hypothesis.
      branch = h.branch;
      checkout(SUPER, branch);
      let spurOnBranch = true;
      try { checkout(SPUR, branch); } catch { spurOnBranch = false; }
      const ownFiles = changedFiles(SUPER, RESEARCH_BRANCH).filter((f) => f !== "spur");
      const touchedOnResearch = new Set(changedOnRef(SUPER, RESEARCH_BRANCH));
      const overlap = ownFiles.filter((f) => touchedOnResearch.has(f));
      let rebased = overlap.length === 0 && (!spurOnBranch || rebaseOnto(SPUR, RESEARCH_BRANCH));
      if (rebased) {
        const oldHead = currentCommit(SUPER);
        resetBranchTo(SUPER, branch, RESEARCH_BRANCH);
        try { checkoutPaths(SUPER, oldHead, ownFiles); } catch { rebased = false; }
      }
      if (!rebased) {
        state.upsertHypothesis({ ...h, status: "closed", branch, notes: `[stale] branch no longer rebases onto ${RESEARCH_BRANCH}; ${h.notes}`.slice(0, 500) });
        journal(state, n, "stale_branch", { id: h.id, branch });
        cleanupToResearchBranch(branch);
        return;
      }
      const pair = commitHypothesisPair({ branch, spurMessage: `resume ${h.id}`, superMessage: `resume ${h.id}` });
      superCommit = pair.superCommit;
      spurFiles = spurOnBranch ? changedFiles(SPUR, RESEARCH_BRANCH) : [];
      superFiles = changedFiles(SUPER, RESEARCH_BRANCH).filter((f) => f !== "spur");
    } else {
      branch = `hyp/${String(n).padStart(3, "0")}-${h.id}`.slice(0, 60);
      createBranch(SPUR, branch);
      createBranch(SUPER, branch);

      const impl = await timed("implement", () => implementHypothesis(policy, h));
      implSummary = impl.summary;
      journal(state, n, "implement", { cost: impl.costUsd, turns: impl.turns, isError: impl.isError, aborted: impl.aborted, timedOut: impl.timedOut, activity: impl.activity, summary: impl.summary.slice(0, 2000) });
      if (impl.turns > 0) state.setMeta("consecutiveImplHangs", "0");
      if (impl.timedOut) {
        if (impl.turns === 0) {
          // The wall fired with no model turns produced: the call hung
          // (network, suspend, or outage), not a real overrun. Retry the
          // hypothesis unless hangs are piling up, which signals a sustained
          // outage the operator should see rather than spin on.
          const hangs = Number(state.getMeta("consecutiveImplHangs") ?? "0") + 1;
          state.setMeta("consecutiveImplHangs", String(hangs));
          journal(state, n, "impl_hang", { id: h.id, consecutive: hangs });
          if (hangs < MAX_CONSECUTIVE_IMPL_HANGS) {
            state.upsertHypothesis({ ...h, status: "proposed", branch: null, notes: `[requeued after implement hang ${hangs}] ${h.notes}`.slice(0, 300) });
            cleanupToResearchBranch(branch);
            return;
          }
          state.upsertHypothesis({ ...h, status: "blocked", branch, notes: `implement hung ${hangs}x in a row with no turns - likely a sustained API or network outage` });
          journal(state, n, "blocked", { reason: "persistent implement hang" });
          cleanupToResearchBranch(branch);
          return;
        }
        state.upsertHypothesis({ ...h, status: "blocked", branch, notes: `implement exceeded ${policy.budgets.maxImplementMinutes}-minute wall` });
        journal(state, n, "blocked", { reason: "implement wall exceeded" });
        cleanupToResearchBranch(branch);
        return;
      }
      if (impl.aborted || stopRequested()) { parkForStop(state, n, h, branch, "implement"); return; }

      const pair = commitHypothesisPair({
        branch,
        spurMessage: `wip ${h.id}: ${h.title}`,
        superMessage: `wip ${h.id}: ${h.title}`,
      });
      superCommit = pair.superCommit;
      spurFiles = pair.spurCommit ? changedFiles(SPUR, RESEARCH_BRANCH) : [];
      superFiles = changedFiles(SUPER, RESEARCH_BRANCH).filter((f) => f !== "spur");
    }
    // The observations log is written by the loop itself and by implementers
    // recording a finding, so a change confined to it is not a code change and
    // leaves nothing for a sequential evaluation to measure.
    const codeFiles = [...spurFiles, ...superFiles.filter((f) => f !== "research/observations/OBSERVATIONS.md")];
    if (codeFiles.length === 0) {
      // A meta hypothesis measures and edits nothing, so an empty diff is the
      // shape it is supposed to have. Its finding is the implement summary,
      // which is recorded and the hypothesis closed; every other kind was
      // asked for code and an empty diff means it failed to produce any.
      if (h.kind === "meta") {
        cleanupToResearchBranch(branch);
        if (implSummary) appendObservation(`**${h.id}** (measured): ${implSummary.slice(0, 4000)}`);
        persistObservations(n);
        state.upsertHypothesis({ ...h, status: "closed", branch: null, notes: "measurement recorded; no code change required" });
        journal(state, n, "measured", { id: h.id, summary: implSummary.slice(0, 2000) });
        return;
      }
      // A non-meta hypothesis was asked for code and produced none. Keep any
      // finding the implementer reached before disposing of it, since the
      // branch and its working tree are about to go away.
      cleanupToResearchBranch(branch);
      if (implSummary) {
        appendObservation(`**${h.id}** (no code produced): ${implSummary.slice(0, 4000)}`);
        persistObservations(n);
      }
      state.upsertHypothesis({ ...h, status: "blocked", branch: null, notes: "implementer produced no code change" });
      journal(state, n, "blocked", { reason: "no code change" });
      return;
    }

    const built = await timed("build", async () => {
      // The on-disk binary from the implementer's session is untrusted; the
      // binary is taken from the committed tree, rebuilt or reused from the
      // tree-keyed store (identical trees, e.g. config-only hypotheses, skip
      // the rebuild).
      return buildSpurCached(policy.budgets.maxBuildSeconds);
    });
    const build = built.result;
    journal(state, n, "build", { cached: built.cached, treeHash: built.treeHash.slice(0, 12), ok: build.ok, wallMs: build.wallMs });
    if (!build.ok) {
      state.upsertHypothesis({ ...h, status: "blocked", branch, notes: `build failed: ${build.stderr.slice(-1500)}` });
      journal(state, n, "blocked", { reason: "build failed" });
      return;
    }

    const unmeasurable = unmeasurableReasons(spurFiles, superFiles);
    const lintFailures = [
      ...lintProtectedPaths(h.kind === "meta" ? superFiles.filter((f) => f !== "research/policy.json") : superFiles),
      ...lintRulerSubject(h.kind, superFiles),
      ...lintVrNames(diffText(SPUR, RESEARCH_BRANCH) + diffText(SUPER, RESEARCH_BRANCH)),
      ...lintInertPolicyKeys(
        superFiles.includes("research/policy.json")
          ? readFileSync(path.join(ROOT, "research/policy.json"), "utf8")
          : null,
        POLICY_KEY_PATHS,
      ),
      ...lintInertConfigs(superFiles, [
        policy.evaluation.configTemplate,
        policy.regression.vrNoFaultConfig,
        policy.perf.benchConfig,
      ]),
      ...lintArmScope(
        h.kind, spurFiles, superFiles, policy.evaluation.configTemplate,
        superFiles.includes(policy.evaluation.configTemplate) ? showFile(SUPER, RESEARCH_BRANCH, policy.evaluation.configTemplate) : null,
        superFiles.includes(policy.evaluation.configTemplate) ? readFileSync(path.join(ROOT, policy.evaluation.configTemplate), "utf8") : null,
      ),
      ...lintArmSetGrowth(
        superFiles.includes(policy.evaluation.configTemplate) ? showFile(SUPER, RESEARCH_BRANCH, policy.evaluation.configTemplate) : null,
        superFiles.includes(policy.evaluation.configTemplate) ? readFileSync(path.join(ROOT, policy.evaluation.configTemplate), "utf8") : null,
      ),
      ...lintCampaignAllocation(
        readFileSync(path.join(ROOT, policy.evaluation.configTemplate), "utf8"),
        existsSync(path.join(ROOT, "research/observations/SURROGATE_VALIDATION.md"))
          ? readFileSync(path.join(ROOT, "research/observations/SURROGATE_VALIDATION.md"), "utf8")
          : null,
      ),
    ];

    const ctx: EvalContext = {
      policy, binary: SPUR_BIN, graderVersion: graderVersion(),
      spurCommit: currentCommit(SPUR), superCommit,
    };

    let decisionInputsReady = false;
    let confirmEvals: Evaluation[] = [];
    let throughputRatio: number | null = null;
    let regressionDetail: string | undefined;
    let regressionPassed = false;
    const allEvals: Record<string, Evaluation[]> = {};
    let perfDecision: GateDecision | null = null;
    let seqOutcome = "";
    let escalated = false;
    let escalateReason: string | null = null;
    let violationRate: RatePrior | null = null;

    const sampled = lintFailures.length === 0 && unmeasurable.length === 0;
    if (sampled && h.kind === "perf") {
      const baselineBin = path.join(ROOT, "tmp", "loop", "spur-baseline");
      const bench = await timed("bench", () => runBench(policy, SPUR_BIN, baselineBin));
      journal(state, n, "bench", bench);
      if (stopRequested()) { parkForStop(state, n, h, branch, "bench"); return; }
      if (bench.pass) {
        const regr = await timed("regression", () => runRegression(ctx, baseline.runsPerSec));
        regressionPassed = regr.passed;
        journal(state, n, "regression", regr);
        throughputRatio = 1 + bench.improvement;
        perfDecision = perfGate({ hypothesis: h, bench, regressionPassed, lintFailures });
      } else {
        perfDecision = {
          hypothesisId: h.id, verdict: "closed", reasons: [`bench: ${bench.detail}`],
          objectiveDeltas: { primary: bench.improvement, throughput: bench.improvement },
          regressionPassed: null, lintPassed: true,
        };
      }
    } else if (sampled) {
      const kind: SeqKind = judgedByNonInferiority(h.kind) ? "noninferiority" : "superiority";
      // A stop mid-sample continues where it left off; a deliberate resume
      // of an inconclusive result spends one of the allowed resumes. Counts
      // gathered against a superseded baseline are dropped.
      const baselineId = baselineIdentity(baseline.sequential);
      let prior: SeqState | null = null;
      if (priorSeq) {
        const resumes = priorSeq.lastVerdict === "inconclusive" ? priorSeq.resumes + 1 : priorSeq.resumes;
        // Counts written before the rate was stratified describe a different
        // quantity, so they reset with the same path a moved baseline takes.
        const stale = priorSeq.baselineKey !== baselineId || priorSeq.rateStratum === null;
        prior = stale
          ? { ...initialSeqState(h.id, baselineId), resumes, nextSeed: priorSeq.nextSeed, lastIteration: priorSeq.lastIteration }
          : { ...priorSeq, resumes };
        if (stale) journal(state, n, "seq_reset", { id: h.id, from: priorSeq.baselineKey, to: baselineId, reason: priorSeq.rateStratum === null ? "no rate stratum" : "baseline or arm set changed" });
      }
      // The candidate's own mechanism counters. Evaluation runs do not carry
      // them, so a mechanism that never fired is otherwise indistinguishable
      // from one that fired and did nothing, and both cost a full sample.
      try {
        const candUtil = await collectUtilization(policy);
        if (candUtil.trim().startsWith("{")) {
          state.setMeta(`util:${h.id}`, candUtil);
          journal(state, n, "utilization", { id: h.id, counters: JSON.parse(candUtil) });
        }
      } catch { /* advisory only; never blocks an evaluation */ }
      violationRate = violationPrior(state);
      const res = await timed("evaluate", () => runSequential({
        ctx, hypothesisId: h.id, kind, baseline: pooledCountsOf(baseline.sequential), prior,
        baselineKey: baselineId, violationPrior: violationRate,
        maxChunksTotal: policy.sequential.maxChunks * (policy.sequential.maxResumes + 1),
        onChunk: (seq, d) => journal(state, n, "seq_chunk", { chunk: seq.chunks, runs: seq.runs, exposureSec: Math.round(seq.exposureSec), rps: seq.rpsChunks.at(-1) ?? 0, depth4: seq.depth4, depth5: seq.depth5, depth6: seq.depth6plus, depth7: seq.depth7plus, depth8: seq.depth8plus, h2: seq.h2Count, violations: seq.violations, anomalies: seq.anomalies, verdict: d.verdict, reason: d.reason, posteriors: d.posteriors }),
        onAnomaly: (e, reason) => journal(state, n, "seq_chunk_anomaly", { seed: e.seed, reason, runs: e.metrics.runs, rps: e.metrics.runsPerSec, exposureMs: e.metrics.exposureMs, suspendedMs: e.suspendedMs, utilStats: e.utilStats }),
        stopRequested,
      }));
      allEvals["sequential"] = res.evals;
      for (const e of res.evals) state.addEvaluation(e);
      state.setMeta(`seq:${h.id}`, JSON.stringify({ ...res.seq, lastIteration: n }));
      journal(state, n, "sequential", { verdict: res.verdict, reason: res.reason, chunks: res.seq.chunks, runs: res.seq.runs, posteriors: res.seq.posteriors, resumes: res.seq.resumes });
      seqOutcome = `${res.verdict} after ${res.seq.chunks} chunks / ${res.seq.runs} runs: ${res.reason}`;
      if (res.verdict === "stopped") { parkForStop(state, n, h, branch, "sequential"); return; }
      if (res.verdict === "error") {
        const d: GateDecision = { hypothesisId: h.id, verdict: "blocked", rayonThreads: policy.evaluation.rayonThreads, reasons: [`sequential evaluation failed: ${res.reason}`], objectiveDeltas: {}, regressionPassed: null, lintPassed: true };
        state.setDecision(d);
        journal(state, n, "blocked", { reason: res.reason });
        state.upsertHypothesis({ ...h, status: "blocked", branch, notes: res.reason.slice(0, 300) });
        cleanupToResearchBranch(branch);
        return;
      }
      if (res.verdict === "inconclusive") {
        // Resume only when more sampling could still push a frontier rung to
        // the separable threshold. A precisely-measured sub-threshold effect
        // (low pMei) will never separate against the fixed-size baseline, so
        // it is closed rather than re-sampled every cooldown.
        const bestPMei = Math.max(res.seq.posteriors["depth>=4:pMei"] ?? 0, res.seq.posteriors["depth>=5:pMei"] ?? 0,
          res.seq.posteriors["depth>=6:pMei"] ?? 0, res.seq.posteriors["depth>=7:pMei"] ?? 0, res.seq.posteriors["depth>=8:pMei"] ?? 0);
        if (bestPMei >= RESUME_PMEI_MIN && res.seq.resumes < policy.sequential.maxResumes) {
          markInconclusive(state, n, h, branch, res.seq, res.reason, spurFiles.length > 0);
          return;
        }
        journal(state, n, "closed_inconclusive", { id: h.id, chunks: res.seq.chunks, resumes: res.seq.resumes, bestPMei: Math.round(bestPMei * 1000) / 1000, posteriors: res.seq.posteriors });
      }
      if (res.verdict === "escalate") {
        // Rare evidence that did not separate at the gate, or a per-second
        // gain whose deep rungs per run stayed unresolved: sampling was
        // extended to the hard cap, and the pooled evidence goes to a human
        // as a PR rather than being deleted.
        journal(state, n, "escalated", { id: h.id, reason: res.reason, chunks: res.seq.chunks });
        confirmEvals = res.evals.filter((e) => e.ok);
        const regr = await timed("regression", () => runRegression(ctx, baseline.runsPerSec));
        regressionPassed = regr.passed;
        journal(state, n, "regression", regr);
        escalated = true;
        escalateReason = res.reason;
        decisionInputsReady = true;
      }
      if (res.verdict === "advance") {
        // The pooled chunks are the merge evidence: same protocol and seeds
        // as the baseline chunks they are compared with.
        confirmEvals = res.evals.filter((e) => e.ok);
        // Like against like: runs per explore-second pooled over the
        // candidate's chunks against the baseline chunks of the same
        // protocol. The screen arm's rate is a different regime (shorter,
        // faster runs) and would read a level candidate as slower.
        throughputRatio = throughputRatioOf(pooledFromSeq(res.seq), pooledCountsOf(baseline.sequential));
        const regr = await timed("regression", () => runRegression(ctx, baseline.runsPerSec));
        regressionPassed = regr.passed;
        regressionDetail = regr.cases.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`).join("; ");
        journal(state, n, "regression", regr);
        decisionInputsReady = true;
      }
    }

    const decision = perfDecision ?? finalGate({
      hypothesis: h,
      confirmEvals,
      baselineEvals: baseline.sequential,
      regressionPassed: decisionInputsReady ? regressionPassed : false,
      regressionDetail,
      lintFailures,
      changedSpurFiles: spurFiles,
      throughputRatio,
      throughputFloor: 1 - policy.regression.throughputTolerance,
      violationPrior: violationRate,
      unmeasurable,
    });
    if (!perfDecision && !decisionInputsReady && sampled) {
      decision.verdict = "closed";
      decision.reasons = [`sequential evaluation ${seqOutcome}`];
      const ran = allEvals["sequential"] ?? [];
      const baseRan = baseline.sequential;
      if (ran.length > 0) {
        const cmp = compareToBaseline(objectiveCounts(ran), objectiveCounts(baseRan), MERGE_Z, violationRate);
        const h1 = (evs: Evaluation[]): number => { const ok = evs.filter((e) => e.ok); return ok.length ? ok.reduce((a, e) => a + e.metrics.h1Rate, 0) / ok.length : 0; };
        const h3 = (evs: Evaluation[]): number => { const ok = evs.filter((e) => e.ok); return ok.length ? ok.reduce((a, e) => a + e.metrics.h3Rate, 0) / ok.length : 0; };
        decision.objectiveDeltas = { ...cmp.deltas, h1: h1(ran) - h1(baseRan), h3: h3(ran) - h3(baseRan), primary: primaryDelta(cmp) };
      }
    }
    if (escalated && sampled) {
      decision.verdict = "needs_human";
      decision.reasons = [`${escalateReason ?? "rare evidence below gate separation"} - human review of the pooled evidence`];
    }
    const paramsAfter = generalConfigParamCount(policy);
    decision.objectiveDeltas["params"] = paramsAfter - paramsBefore;
    decision.rayonThreads = policy.evaluation.rayonThreads;
    state.setDecision(decision);
    journal(state, n, "decision", decision);

    const evidence = { hypothesis: h, decision, evaluations: allEvals, spurFiles, superFiles, touchesSemantics: classifyChangeRisk(spurFiles) === "semantics", graderVersion: ctx.graderVersion, generalConfigParams: { before: paramsBefore, after: paramsAfter } };

    if (decision.verdict === "auto_merge" || decision.verdict === "needs_human") {
      const outcome = await timed("publish", async () => mergeFlow(n, h, branch as string, evidence, decision.verdict === "auto_merge"));
      journal(state, n, "publish", outcome);
      const status = decision.verdict === "auto_merge" && outcome.merged ? "merged" : "needs_human";
      state.upsertHypothesis({ ...h, status, branch, prUrls: outcome.prUrls });
      if (status === "needs_human") cleanupToResearchBranch(null); // PR lives on the pushed remote branch
      if (status === "merged") {
        const seqTarget = sequentialBaselineChunks(policy);
        // Rungs are events per explore-second, so a merge that changes only
        // speed still moves every one of them. A perf candidate brings no
        // sequential chunks of its own, so the baseline is measured again
        // rather than carried across the change.
        const sequential = await timed("evaluate", () => topUpSequentialBaseline(ctx, allEvals["sequential"] ?? [], seqTarget));
        for (const e of sequential) if (!allEvals["sequential"]?.includes(e)) state.addEvaluation(e);
        journal(state, n, "baseline_sequential", { chunks: sequential.length, counts: pooledCountsOf(sequential) });
        const newBaseline: BaselineMeta = {
          sequential,
          runsPerSec: baseline.runsPerSec * (throughputRatio ?? 1),
          rayonThreads: policy.evaluation.rayonThreads,
        };
        state.setMeta(baselineKey(policy.evaluation.rayonThreads), JSON.stringify(newBaseline));
        // A merge can enable mechanisms; dependency gating must see that now,
        // not at the next audit.
        try {
          const util0 = await collectUtilization(policy);
          if (util0.trim().startsWith("{")) state.setMeta("utilization", util0);
        } catch { /* gating falls back to the previous snapshot */ }
        if (spurFiles.length > 0) {
          try { copyFileSync(SPUR_BIN, path.join(ROOT, "tmp", "loop", "spur-baseline")); } catch { /* non-fatal */ }
        }
        if (policy.rejudge.afterMerge) await timed("rejudge", () => rejudge(state, policy, n, `merge of ${h.id}`));
      }
    } else {
      state.upsertHypothesis({ ...h, status: decision.verdict === "blocked" ? "blocked" : "closed", branch });
      cleanupToResearchBranch(branch);
    }

    const refl = await timed("reflect", () => reflectOnOutcome(policy, h, JSON.stringify(evidence).slice(0, 20000), counterLines(state)));
    if (refl.value) {
      appendObservation(`**${h.id}** (${decision.verdict}): ${refl.value.whatWeLearned}`);
      persistObservations(n);
      await admitCandidates(deps, n, refl.value.suggestedChildren.slice(0, 2), `reflect:${h.id}`, h.id);
      for (const dep of refl.value.suggestedDeprioritize) {
        const target = state.getHypothesis(dep);
        if (target && target.status === "proposed") state.upsertHypothesis({ ...target, status: "parked", notes: `deprioritized after ${h.id}` });
      }
      journal(state, n, "reflect", { learned: refl.value.whatWeLearned, children: refl.value.suggestedChildren.length });
    }

    if (n % policy.rejudge.everyK === 0) await timed("rejudge", () => rejudge(state, policy, n, `iteration ${n}`));
    if (n % policy.audit.everyK === 0) {
      await timed("audit", async () => {
        const util0 = await collectUtilization(policy);
        if (util0.trim().startsWith("{")) state.setMeta("utilization", util0);
        const profile = await collectProfile(policy, SPUR_BIN);
        if (profile.ok) writeProfileObservation(policy, `iteration ${n}`, profile.text);
        const util = `${util0}\n\n## perf profile (top symbols)\n${profile.text}`;
        const ledger = JSON.stringify(state.countByStatus()) + "\n" + JSON.stringify(timings) + "\n" + implementActivityDigest(15);
        const evalConfig = readFileSync(path.join(ROOT, policy.evaluation.configTemplate), "utf8");
        const lastChunk = state.allEvaluations().filter((e) => e.fidelity === "sequential" && e.ok).at(-1);
        const chunkLine = lastChunk
          ? `One sequential chunk = a ${policy.sequential.exploreBudgetSec} s explore budget over the interleaved grid (${lastChunk.metrics.runs} runs at ${lastChunk.metrics.runsPerSec.toFixed(0)} runs/s in the last chunk); the objective is rung events per explore-second; ${policy.sequential.minChunks}-${policy.sequential.maxChunks} chunks per hypothesis; the baseline holds ${policy.sequential.maxChunks} chunks.`
          : "No sequential chunk recorded yet.";
        const audit = await runAudit(policy, n, readStatusMd(), ledger, `## Evaluation config (mechanisms not enabled here are expected to read zero)\n${evalConfig}\n\n${util}`, `${evaluationContext(state, policy)}\n${chunkLine}`);
        if (!audit.value) journal(state, n, "audit_error", { error: audit.error, cost: audit.costUsd });
        if (audit.value) {
          appendObservation(`### Audit @${n}\n${audit.value.budgetConcentration}\n\nGoodhart: ${audit.value.goodhartSignals.join("; ") || "none"}\n\nUtilization: ${audit.value.utilizationFindings.map((u) => `${u.mechanism}=${u.classification}`).join(", ")}\n\nPolicy suggestions: ${audit.value.recommendedPolicyChanges.join("; ") || "none"}`);
          persistObservations(n);
          journal(state, n, "audit", audit.value);
        }
      });
    }
  } catch (e) {
    notes = `iteration error: ${String(e)}`;
    journal(state, n, "error", { error: String(e) });
    // Preserve whatever the implementer produced before the reset wipes it.
    if (branch) {
      try {
        const snap = `# iteration ${n} (${branch}) - error: ${String(e).slice(0, 300)}\n\n## spur\n${snapshotWork(SPUR, RESEARCH_BRANCH)}\n\n## super\n${snapshotWork(SUPER, RESEARCH_BRANCH)}\n`;
        if (snap.length > 200) {
          mkdirSync(path.join(ROOT, "research", "logs"), { recursive: true });
          writeFileSync(path.join(ROOT, "research", "logs", `iter-${String(n).padStart(3, "0")}-${branch.replace(/^hyp\/\d+-/, "")}.diff`), snap);
        }
      } catch { /* snapshot is best-effort */ }
    }
    cleanupToResearchBranch(branch);
    // Never strand a hypothesis in a transient status on iteration failure.
    for (const hh of state.listHypotheses()) {
      if (hh.status === "selected" || hh.status === "implementing") {
        state.upsertHypothesis({ ...hh, status: "blocked", branch: null, notes: `${hh.notes} [iteration ${n} error: ${String(e).slice(0, 200)}]`.trim() });
      }
    }
  } finally {
    try {
      const baseline = loadBaseline(state, policy.evaluation.rayonThreads);
      writeStatus(state, policy, {
        baseline: baselineLadder(baseline),
        reference: baselineLadder(loadReference(state)),
        graderVersion: graderVersion(),
        openPrs: state.listHypotheses("needs_human").flatMap((x) => x.prUrls),
      });
    } catch { /* status rendering must never kill the loop */ }
    state.finishIteration(n, timings, notes);
  }
}


export async function runLoop(deps: LoopDeps): Promise<void> {
  // Runs share a feedback map across the parallel set, so the snapshot a run
  // sees depends on how many threads are running. A candidate measured at one
  // thread count cannot be compared with a baseline measured at another, so
  // the host's resolved count selects the baseline.
  const hostThreads = deps.policy.evaluation.rayonThreads;
  const startBaseline = loadBaseline(deps.state, hostThreads);
  if (!startBaseline || startBaseline.sequential.length === 0) {
    console.error(`no sequential baseline recorded at ${hostThreads} threads; run \`cli baseline\` and \`cli regression\` under this CPU mask before starting the loop`);
    return;
  }
  const freshness = baselineFreshness(startBaseline);
  if (freshness === "stale") {
    console.error(`baseline at ${hostThreads} threads was measured on spur ${startBaseline.sequential[0]?.spurCommit.slice(0, 7)}, whose tree differs from HEAD; run \`cli baseline\` under this CPU mask before starting.`);
    return;
  }
  if (stratumOf(startBaseline.sequential) === null) {
    console.error(`the ${hostThreads}-thread baseline chunks carry no per-arm accounting, or pool different arms across chunks; run \`cli baseline\` under this CPU mask before starting the loop`);
    return;
  }
  if (freshness === "unknown") {
    console.error(`WARNING: cannot tell whether the ${hostThreads}-thread baseline matches HEAD (its spur commit object is not available); run \`cli baseline\` if the binary changed since it was recorded.`);
  }
  const baselineThreads = startBaseline.rayonThreads;
  if (baselineThreads === undefined) {
    console.error(`WARNING: baseline predates thread-count recording; it may not have been measured at the current ${hostThreads} threads. Re-run \`loop baseline\` after moving hosts.`);
  } else if (baselineThreads !== hostThreads) {
    console.error(`baseline was measured at ${baselineThreads} threads, host resolves to ${hostThreads}; re-run \`loop baseline\` before evaluating.`);
    return;
  }
  // Crash recovery: requeue hypotheses stranded mid-iteration and clear
  // leftover evaluation corpora from a killed run.
  for (const h of deps.state.listHypotheses()) {
    const stopParked = h.status === "parked" && h.notes.startsWith("[stop]");
    if (stopParked && h.branch && loadSeqState(deps.state, h.id) !== null) {
      // Sampling that was interrupted by a stop resumes from its chunks.
      deps.state.upsertHypothesis({ ...h, status: "inconclusive", notes: `${h.notes} [resumable after restart]`.trim() });
    } else if (h.status === "selected" || h.status === "implementing" || stopParked) {
      deps.state.upsertHypothesis({ ...h, status: "proposed", branch: null, notes: `${h.notes} [requeued after restart]`.trim() });
    }
  }
  for (const d of readdirSync(path.join(ROOT, "tmp", "loop"))) {
    if (/^(eval-|bench-|regr-)/.test(d)) {
      rmSync(path.join(ROOT, "tmp", "loop", d), { recursive: true, force: true });
    }
  }
  let consecutiveFailures = 0;
  let idleStreak = 0;
  try {
    const util0 = await collectUtilization(deps.policy);
    if (util0.trim().startsWith("{")) deps.state.setMeta("utilization", util0);
  } catch { /* gating simply stays open without a snapshot */ }
  for (;;) {
    if (existsSync(path.join(ROOT, "research/STOP"))) {
      console.log("STOP sentinel found; exiting loop.");
      return;
    }
    if (await parkForDrain(deps) === "stop") {
      console.log("STOP taken while parked; exiting loop.");
      return;
    }
    try {
      await runIteration(deps);
      consecutiveFailures = 0;
      if (lastIterationIdle) {
        // Nothing to select. Back off up to 5 minutes so a pool that stays
        // empty costs a handful of log lines an hour, not thousands.
        idleStreak++;
        const waitMs = Math.min(300_000, 10_000 * idleStreak);
        console.log(`idle iteration (${idleStreak} consecutive); sleeping ${Math.round(waitMs / 1000)}s`);
        await new Promise((r) => setTimeout(r, waitMs));
      } else {
        idleStreak = 0;
      }
    } catch (e) {
      consecutiveFailures++;
      console.error(`iteration failed: ${String(e)} (${consecutiveFailures} consecutive)`);
      if (consecutiveFailures >= 5) {
        console.error("5 consecutive failures; exiting for safety.");
        return;
      }
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }
}
