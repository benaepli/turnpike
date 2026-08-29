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
import { classifyChangeRisk, compareToBaseline, finalGate, nonInferior, objectiveCounts, perfGate, screenAdvances } from "./decide.js";
import { collectProfile, runBench } from "./bench.js";
import { runEvaluation, runOneEvaluation, type EvalContext } from "./evaluate.js";
import { classifyChunkTiming, initialSeqState, loadSeqState, medianRps, pooledCountsOf, pooledFromSeq, runSequential, throughputRatioOf, type SeqKind } from "./sequential.js";
import {
  RESEARCH_BRANCH, SPUR, SUPER, showFile, changedFiles, changedOnRef, checkout, checkoutPaths, commitHypothesisPair, commitPaths, createBranch, currentBranch, snapshotWork, rebaseOnto, resetBranchTo,
  currentCommit, deleteBranch, diffText, createPr, lintArmScope, lintCampaignAllocation, lintInertConfigs, lintInertPolicyKeys, lintProtectedPaths, lintRulerSubject,
  lintVrNames, mergePrSquash, push, resetHard, tag, pushTag,
} from "./gitops.js";
import type { Policy } from "./policy.js";
import { POLICY_KEYS } from "./policy.js";
import { CAMPAIGN_ONLY_KEYS, buildSpurCached, SPUR_BIN, cleanupDir, explore, materializeConfig, resolveRoot, run, templateHasCampaign } from "./runners.js";
import { diffConfigPaths, type PanelArms } from "./panel.js";
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
  screen: z.array(Evaluation),
  promote: z.array(Evaluation),
  confirm: z.array(Evaluation),
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
      JSON.stringify({ screen: [], promote: [], confirm: [], sequential: [], runsPerSec: rps, rayonThreads: threads });
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
function persistObservations(n: number): void {
  try {
    if (currentBranch(SUPER) !== RESEARCH_BRANCH) return;
    if (commitPaths(SUPER, ["research/observations/OBSERVATIONS.md"], `observations through iteration ${n}`)) push(SUPER, RESEARCH_BRANCH);
  } catch (err) {
    console.error(`observations not persisted: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readStatusMd(): string {
  const p = path.join(ROOT, "research/STATUS.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "(no status yet)";
}

function preflight(): void {
  // Hard-reset both repos to the research branch: any stray working-tree
  // state (a killed implement, an operator slip) must never leak into the
  // next hypothesis's diff. Implementer edits only survive via
  // commitHypothesisPair onto the hyp/* branch within the same iteration.
  for (const repo of [SPUR, SUPER]) {
    if (currentBranch(repo) !== RESEARCH_BRANCH) checkout(repo, RESEARCH_BRANCH);
    resetHard(repo, RESEARCH_BRANCH);
    run0("git", ["clean", "-fd", "--", "."], repo);
  }
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
  const poolSummaries = state.listHypotheses().map((h) => `${h.id} [${h.kind}/${h.status}]: ${h.title}`);
  const calibration = calibrationTable(state);
  const judged = await judgeHypotheses(policy, candidates, poolSummaries, calibration, evalContext);
  const kept = judged.value?.hypotheses ?? candidates;
  const { valid, rejected } = validateProposed(kept);
  const room = Math.max(0, policy.proposal.maxPoolSize - state.listHypotheses("proposed").length);
  for (const h of valid.slice(0, room)) {
    if (!state.getHypothesis(h.id)) state.upsertHypothesis(h);
  }
  journal(state, iteration, "judge", { kept: valid.length, rejected: rejected.length, judgeCost: judged.costUsd });
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
  return `Explorer: -e ${policy.evaluation.explorer} on ${policy.evaluation.configTemplate}; scalar settings ${modes}.${campaign}\nMechanisms with zero recorded activity under this config: ${inactive.length ? inactive.join(", ") : "(none)"}. A change whose effect is confined to one of these cannot be measured; it has to be an enabling hypothesis that switches the mechanism on in the general config, and buildsOn must name the mechanisms a change needs to be active.`;
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
    .map(({ hypothesis: x, decision: d }) => `${x.id} [${x.kind}]: predicted gain ${x.expectedGain}/cost ${x.expectedCost} -> ${d.verdict}, primary delta (relative) ${(d.objectiveDeltas["primary"] ?? 0).toFixed(4)}`)
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
  run0("git", ["fetch", "origin", RESEARCH_BRANCH], repo);
  run0("git", ["checkout", "--force", RESEARCH_BRANCH], repo);
  run0("git", ["reset", "--hard", `origin/${RESEARCH_BRANCH}`], repo);
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
    try {
      run0("git", ["checkout", "--force", RESEARCH_BRANCH], repo);
      resetHard(repo, RESEARCH_BRANCH);
      if (branch) { try { deleteBranch(repo, branch); } catch { /* branch may not exist here */ } }
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

    const lintFailures = [
      ...lintProtectedPaths(h.kind === "meta" ? superFiles.filter((f) => f !== "research/policy.json") : superFiles),
      ...lintRulerSubject(h.kind, superFiles),
      ...lintVrNames(diffText(SPUR, RESEARCH_BRANCH) + diffText(SUPER, RESEARCH_BRANCH)),
      ...lintInertPolicyKeys(
        superFiles.includes("research/policy.json")
          ? readFileSync(path.join(ROOT, "research/policy.json"), "utf8")
          : null,
        POLICY_KEYS,
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

    if (lintFailures.length === 0 && h.kind === "perf") {
      const baselineBin = path.join(ROOT, "tmp", "loop", "spur-baseline");
      const bench = await timed("bench", () => runBench(policy, SPUR_BIN, baselineBin));
      journal(state, n, "bench", bench);
      if (stopRequested()) { parkForStop(state, n, h, branch, "bench"); return; }
      if (bench.pass) {
        const screen = await timed("evaluate", () => runEvaluation(ctx, h.id, "screen"));
        allEvals["screen"] = screen;
        for (const e of screen) state.addEvaluation(e);
        const screenNI = nonInferior(objectiveCounts(screen), objectiveCounts(baseline.screen));
        journal(state, n, "perf-screen-ni", screenNI);
        const panelArms = buildPanelArms(policy, n, h, spurFiles);
        const touchesSemantics = classifyChangeRisk(spurFiles) === "semantics";
        let promoteNI: boolean | null = null;
        if (screenNI.ok && touchesSemantics) {
          const promote = await timed("evaluate", () => runEvaluation(ctx, h.id, "promote"));
          allEvals["promote"] = promote;
          for (const e of promote) state.addEvaluation(e);
          promoteNI = nonInferior(objectiveCounts(promote), objectiveCounts(baseline.promote)).ok;
          journal(state, n, "perf-promote-ni", { ok: promoteNI });
        }
        if (screenNI.ok) {
          const regr = await timed("regression", () => runRegression(ctx, baseline.runsPerSec, buildPanelArms(policy, n, h, spurFiles)));
          regressionPassed = regr.passed;
          journal(state, n, "regression", regr);
        }
        throughputRatio = 1 + bench.improvement;
        perfDecision = perfGate({ hypothesis: h, bench, screenNI, promoteNI, touchesSemantics, regressionPassed, lintFailures });
      } else {
        perfDecision = {
          hypothesisId: h.id, verdict: "closed", reasons: [`bench: ${bench.detail}`],
          objectiveDeltas: { primary: bench.improvement, throughput: bench.improvement },
          regressionPassed: null, lintPassed: true,
        };
      }
    } else if (lintFailures.length === 0) {
      const kind: SeqKind = h.kind === "ablate" || h.kind === "enabling" || h.kind === "meta" ? "noninferiority" : "superiority";
      // A stop mid-sample continues where it left off; a deliberate resume
      // of an inconclusive result spends one of the allowed resumes. Counts
      // gathered against a superseded baseline are dropped.
      const baselineKey = baseline.sequential[0]?.superCommit ?? "";
      let prior: SeqState | null = null;
      if (priorSeq) {
        const resumes = priorSeq.lastVerdict === "inconclusive" ? priorSeq.resumes + 1 : priorSeq.resumes;
        prior = priorSeq.baselineKey === baselineKey
          ? { ...priorSeq, resumes }
          : { ...initialSeqState(h.id, baselineKey), resumes, nextSeed: priorSeq.nextSeed, lastIteration: priorSeq.lastIteration };
        if (priorSeq.baselineKey !== baselineKey) journal(state, n, "seq_reset", { id: h.id, from: priorSeq.baselineKey, to: baselineKey });
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
      const res = await timed("evaluate", () => runSequential({
        ctx, hypothesisId: h.id, kind, baseline: pooledCountsOf(baseline.sequential), prior, baselineKey,
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
        const bestPMei = Math.max(res.seq.posteriors["depth>=4:pMei"] ?? 0, res.seq.posteriors["depth>=5:pMei"] ?? 0, res.seq.posteriors["depth>=6:pMei"] ?? 0);
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
        const regr = await timed("regression", () => runRegression(ctx, baseline.runsPerSec, buildPanelArms(policy, n, h, spurFiles)));
        regressionPassed = regr.passed;
        journal(state, n, "regression", regr);
        escalated = true;
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
        const regr = await timed("regression", () => runRegression(ctx, baseline.runsPerSec, buildPanelArms(policy, n, h, spurFiles)));
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
    });
    if (!perfDecision && !decisionInputsReady && lintFailures.length === 0) {
      decision.verdict = "closed";
      decision.reasons = [`sequential evaluation ${seqOutcome}`];
      const ran = allEvals["sequential"] ?? [];
      const baseRan = baseline.sequential;
      if (ran.length > 0) {
        const cmp = compareToBaseline(objectiveCounts(ran), objectiveCounts(baseRan));
        const h1 = (evs: Evaluation[]): number => { const ok = evs.filter((e) => e.ok); return ok.length ? ok.reduce((a, e) => a + e.metrics.h1Rate, 0) / ok.length : 0; };
        const h3 = (evs: Evaluation[]): number => { const ok = evs.filter((e) => e.ok); return ok.length ? ok.reduce((a, e) => a + e.metrics.h3Rate, 0) / ok.length : 0; };
        decision.objectiveDeltas = { ...cmp.deltas, h1: h1(ran) - h1(baseRan), h3: h3(ran) - h3(baseRan), primary: cmp.deltas["violations"] !== 0 ? (cmp.deltas["violations"] ?? 0) : (cmp.deltas["depth>=6"] ?? 0) };
      }
    }
    if (escalated && lintFailures.length === 0) {
      decision.verdict = "needs_human";
      decision.reasons = ["a depth the baseline never reaches appeared, below gate separation - human review of the pooled evidence"];
    }
    const paramsAfter = generalConfigParamCount(policy);
    decision.objectiveDeltas["params"] = paramsAfter - paramsBefore;
    decision.rayonThreads = policy.evaluation.rayonThreads;
    state.setDecision(decision);
    journal(state, n, "decision", decision);

    const evidence = { hypothesis: h, decision, evaluations: allEvals, spurFiles, superFiles, graderVersion: ctx.graderVersion, generalConfigParams: { before: paramsBefore, after: paramsAfter } };

    if (decision.verdict === "auto_merge" || decision.verdict === "needs_human") {
      const outcome = await timed("publish", async () => mergeFlow(n, h, branch as string, evidence, decision.verdict === "auto_merge"));
      journal(state, n, "publish", outcome);
      const status = decision.verdict === "auto_merge" && outcome.merged ? "merged" : "needs_human";
      state.upsertHypothesis({ ...h, status, branch, prUrls: outcome.prUrls });
      if (status === "needs_human") cleanupToResearchBranch(null); // PR lives on the pushed remote branch
      if (status === "merged") {
        const seqTarget = sequentialBaselineChunks(policy);
        const sequential = h.kind === "perf" && !allEvals["sequential"]
          ? baseline.sequential
          : await timed("evaluate", () => topUpSequentialBaseline(ctx, allEvals["sequential"] ?? [], seqTarget));
        for (const e of sequential) if (!allEvals["sequential"]?.includes(e)) state.addEvaluation(e);
        journal(state, n, "baseline_sequential", { chunks: sequential.length, counts: pooledCountsOf(sequential) });
        const newBaseline: BaselineMeta = {
          screen: allEvals["screen"] ?? baseline.screen,
          promote: allEvals["promote"] ?? baseline.promote,
          confirm: baseline.confirm,
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

    const refl = await timed("reflect", () => reflectOnOutcome(policy, h, JSON.stringify(evidence).slice(0, 20000)));
    if (refl.value) {
      appendObservation(`**${h.id}** (${decision.verdict}): ${refl.value.whatWeLearned}`);
      persistObservations(n);
      const { valid } = validateProposed(refl.value.suggestedChildren);
      for (const child of valid.slice(0, 2)) {
        if (!state.getHypothesis(child.id)) state.upsertHypothesis({ ...child, parent: child.parent ?? h.id });
      }
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
        const util = `${util0}\n\n## perf profile (top symbols)\n${profile}`;
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


/** Paired arms for the panel: the candidate's binary and config template
 *  against the baseline's, measured in the same window on the same seed, so a
 *  session-length or seed effect cancels rather than being attributed. The
 *  seed rotates per iteration: the historical Mencius case ran at a fixed
 *  session_seed forever, which measured explorer nondeterminism rather than
 *  the seed space. */
const PANEL_SEED_BASE = 20000;

function buildPanelArms(policy: Policy, n: number, h: Hypothesis, spurFiles: string[]): PanelArms | null {
  const candidateTemplate = resolveRoot(policy.evaluation.configTemplate);
  const baselineBin = path.join(ROOT, "tmp", "loop", "spur-baseline");
  let baselineTemplate: string | null = null;
  if (existsSync(baselineBin)) {
    baselineTemplate = path.join(ROOT, "tmp", "loop", "panel.base.config.json");
    writeFileSync(baselineTemplate, showFile(SUPER, RESEARCH_BRANCH, policy.evaluation.configTemplate));
  }
  return {
    candidateBinary: SPUR_BIN,
    candidateTemplate,
    baselineBinary: existsSync(baselineBin) ? baselineBin : null,
    baselineTemplate,
    seed: PANEL_SEED_BASE + n,
    changedSpurCode: spurFiles.length > 0,
    declaredFiringCounter: h.firingCounter ?? null,
  };
}

export async function runLoop(deps: LoopDeps): Promise<void> {
  // Runs share a feedback map across the parallel set, so the snapshot a run
  // sees depends on how many threads are running. A candidate measured at one
  // thread count cannot be compared with a baseline measured at another, so
  // the host's resolved count selects the baseline and the panel manifest.
  const hostThreads = deps.policy.evaluation.rayonThreads;
  const startBaseline = loadBaseline(deps.state, hostThreads);
  if (!startBaseline || startBaseline.sequential.length === 0) {
    console.error(`no sequential baseline recorded at ${hostThreads} threads; run \`cli baseline\`, then \`cli panel-calibrate\` and \`cli regression\` under this CPU mask before starting the loop`);
    return;
  }
  const freshness = baselineFreshness(startBaseline);
  if (freshness === "stale") {
    console.error(`baseline at ${hostThreads} threads was measured on spur ${startBaseline.sequential[0]?.spurCommit.slice(0, 7)}, whose tree differs from HEAD; run \`cli baseline\` under this CPU mask before starting.`);
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
