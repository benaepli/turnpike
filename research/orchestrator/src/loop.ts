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
import { loadSeqState, pooledCountsOf, runSequential, type SeqKind } from "./sequential.js";
import {
  RESEARCH_BRANCH, SPUR, SUPER, changedFiles, changedOnRef, checkout, checkoutPaths, commitHypothesisPair, commitPaths, createBranch, currentBranch, snapshotWork, rebaseOnto, resetBranchTo,
  currentCommit, deleteBranch, diffText, createPr, lintProtectedPaths, lintRulerSubject,
  lintVrNames, mergePrSquash, push, resetHard, tag, pushTag,
} from "./gitops.js";
import type { Policy } from "./policy.js";
import { buildSpur, SPUR_BIN, cleanupDir, explore, materializeConfig, run } from "./runners.js";
import { runRegression } from "./regression.js";
import { Evaluation, Hypothesis, type GateDecision, type SeqState } from "./schemas.js";
import type { LoopState } from "./state.js";
import { writeStatus, appendObservation } from "./render.js";
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
  const evals = existing.filter((e) => e.ok);
  const used = new Set(evals.map((e) => e.seed));
  for (let seed = 1000; evals.length < target && seed < 1000 + 4 * target; seed++) {
    if (used.has(seed)) continue;
    const e = await runOneEvaluation(ctx, "baseline", "sequential", seed, {
      runsPerConfig: p.chunkRunsPerConfig, exploreWallSec: p.wallSecPerChunk, gradeMaxRuns: 0, gradeBudgetMs: p.wallSecPerChunk * 1000,
    });
    if (e.ok) evals.push(e);
  }
  return evals;
}

export function loadBaseline(state: LoopState): BaselineMeta | null {
  const raw = state.getMeta("baseline");
  if (!raw) return null;
  const p = BaselineMeta.safeParse(JSON.parse(raw));
  return p.success ? p.data : null;
}

function journal(state: LoopState, iteration: number, event: string, data: unknown): void {
  state.appendJournal({ atIso: new Date().toISOString(), iteration, event, data });
}

const stopRequested = (): boolean => existsSync(path.join(ROOT, "research", "STOP"));

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
  journal(state, iteration, "propose", { lenses: lenses.length, candidates: candidates.length, cost: results.reduce((a, r) => a + r.costUsd, 0) });
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
function evaluationContext(state: LoopState, policy: Policy): string {
  let modes = "(config unreadable)";
  try {
    const cfg = JSON.parse(readFileSync(path.join(ROOT, policy.evaluation.configTemplate), "utf8")) as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const k of Object.keys(cfg)) if (typeof cfg[k] !== "object" || k === "feedback") picked[k] = cfg[k];
    modes = JSON.stringify(picked);
  } catch { /* reported as unreadable */ }
  const inactive = inactiveMechanisms(parseUtilization(state.getMeta("utilization")));
  return `Explorer: -e standard on ${policy.evaluation.configTemplate}; scalar settings ${modes}.\nMechanisms with zero recorded activity under this config: ${inactive.length ? inactive.join(", ") : "(none)"}. A change whose effect is confined to one of these cannot be measured; it has to be an enabling hypothesis that switches the mechanism on in the general config, and buildsOn must name the mechanisms a change needs to be active.`;
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

function calibrationTable(state: LoopState): string {
  return state.listHypotheses()
    .map((x) => ({ x, d: state.getDecision(x.id) }))
    .filter((p): p is { x: Hypothesis; d: NonNullable<ReturnType<typeof state.getDecision>> } => p.d !== null)
    .map(({ x, d }) => `${x.id} [${x.kind}]: predicted gain ${x.expectedGain}/cost ${x.expectedCost} -> ${d.verdict}, primary delta ${(d.objectiveDeltas["primary"] ?? 0).toFixed(4)}`)
    .slice(-30)
    .join("\n");
}

function recentEvidence(state: LoopState, limit: number): string {
  const cur = state.currentEpoch();
  const decided = state.listHypotheses()
    .map((x) => ({ x, d: state.getDecision(x.id) }))
    .filter((p): p is { x: Hypothesis; d: NonNullable<ReturnType<typeof state.getDecision>> } => p.d !== null)
    .slice(-limit);
  return decided.map(({ x, d }) => {
    const stale = (d.epoch ?? 1) !== cur ? " [SUPERSEDED regime: verdict may not hold under the current gate/protocol]" : "";
    const harness = d.harnessFailure ? " [harness failure, not evidence]" : "";
    return `${x.id} [${x.kind}] -> ${d.verdict}${stale}${harness}: ${d.reasons.join("; ")} | deltas ${JSON.stringify(d.objectiveDeltas)} | notes: ${x.notes.slice(0, 200)}`;
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
  const best = Math.max(seq.posteriors["depth>=4:pGreater"] ?? 0, seq.posteriors["depth>=5:pGreater"] ?? 0);
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
      runsPerConfig: 20, sessionSeed: 4242, extra: { stats: true },
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

export async function runIteration(deps: LoopDeps): Promise<void> {
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
    const baseline = loadBaseline(state);
    if (!baseline) throw new Error("no baseline recorded - run `loop baseline` first");

    await timed("propose", () => refillPool(deps, n));
    const h = (await import("./select.js")).selectNext(state, policy);
    if (!h) { notes = "empty pool"; journal(state, n, "select", { none: true }); return; }
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
    state.upsertHypothesis({ ...h, status: "selected" });
    journal(state, n, "select", { id: h.id, kind: h.kind, title: h.title, resuming });

    const paramsBefore = generalConfigParamCount(policy);
    let spurFiles: string[] = [];
    let superFiles: string[] = [];
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
      journal(state, n, "implement", { cost: impl.costUsd, turns: impl.turns, isError: impl.isError, aborted: impl.aborted, timedOut: impl.timedOut, summary: impl.summary.slice(0, 2000) });
      if (impl.timedOut) {
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
    if (spurFiles.length === 0 && superFiles.length === 0) {
      state.upsertHypothesis({ ...h, status: "blocked", branch, notes: "implementer produced no changes" });
      journal(state, n, "blocked", { reason: "no changes" });
      return;
    }

    const build = await timed("build", async () => {
      // Always rebuild: the implementer may have built arbitrary intermediate
      // states during its session, so the on-disk binary is untrusted until
      // rebuilt from the committed tree (cheap no-op when nothing changed).
      return buildSpur(policy.budgets.maxBuildSeconds);
    });
    if (!build.ok) {
      state.upsertHypothesis({ ...h, status: "blocked", branch, notes: `build failed: ${build.stderr.slice(-1500)}` });
      journal(state, n, "blocked", { reason: "build failed" });
      return;
    }

    const lintFailures = [
      ...lintProtectedPaths(h.kind === "meta" ? superFiles.filter((f) => f !== "research/policy.json") : superFiles),
      ...lintRulerSubject(h.kind, superFiles),
      ...lintVrNames(diffText(SPUR, RESEARCH_BRANCH) + diffText(SUPER, RESEARCH_BRANCH)),
    ];

    const ctx: EvalContext = {
      policy, binary: SPUR_BIN, graderVersion: graderVersion(),
      spurCommit: currentCommit(SPUR), superCommit,
    };

    let decisionInputsReady = false;
    let confirmEvals: Evaluation[] = [];
    let throughputRatio: number | null = null;
    let regressionPassed = false;
    const allEvals: Record<string, Evaluation[]> = {};
    let perfDecision: GateDecision | null = null;
    let seqOutcome = "";

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
          const regr = await timed("regression", () => runRegression(ctx, baseline.runsPerSec));
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
          : { ...priorSeq, resumes, chunks: 0, runs: 0, graded: 0, depth4: 0, depth5: 0, depth6plus: 0, violations: 0, h2Count: 0, posteriors: {}, lastVerdict: "", baselineKey };
        if (priorSeq.baselineKey !== baselineKey) journal(state, n, "seq_reset", { id: h.id, from: priorSeq.baselineKey, to: baselineKey });
      }
      const res = await timed("evaluate", () => runSequential({
        ctx, hypothesisId: h.id, kind, baseline: pooledCountsOf(baseline.sequential), prior, baselineKey,
        maxChunksTotal: policy.sequential.maxChunks * (policy.sequential.maxResumes + 1),
        onChunk: (seq, d) => journal(state, n, "seq_chunk", { chunk: seq.chunks, runs: seq.runs, depth4: seq.depth4, depth5: seq.depth5, h2: seq.h2Count, violations: seq.violations, verdict: d.verdict, reason: d.reason, posteriors: d.posteriors }),
        stopRequested,
      }));
      allEvals["sequential"] = res.evals;
      for (const e of res.evals) state.addEvaluation(e);
      state.setMeta(`seq:${h.id}`, JSON.stringify({ ...res.seq, lastIteration: n }));
      journal(state, n, "sequential", { verdict: res.verdict, reason: res.reason, chunks: res.seq.chunks, runs: res.seq.runs, posteriors: res.seq.posteriors, resumes: res.seq.resumes });
      seqOutcome = `${res.verdict} after ${res.seq.chunks} chunks / ${res.seq.runs} runs: ${res.reason}`;
      if (res.verdict === "stopped") { parkForStop(state, n, h, branch, "sequential"); return; }
      if (res.verdict === "error") {
        const d: GateDecision = { hypothesisId: h.id, verdict: "blocked", reasons: [`sequential evaluation failed: ${res.reason}`], objectiveDeltas: {}, regressionPassed: null, lintPassed: true };
        state.setDecision(d);
        journal(state, n, "blocked", { reason: res.reason });
        state.upsertHypothesis({ ...h, status: "blocked", branch, notes: res.reason.slice(0, 300) });
        cleanupToResearchBranch(branch);
        return;
      }
      if (res.verdict === "inconclusive") {
        if (res.seq.resumes < policy.sequential.maxResumes) {
          markInconclusive(state, n, h, branch, res.seq, res.reason, spurFiles.length > 0);
          return;
        }
        journal(state, n, "closed_after_resumes", { id: h.id, chunks: res.seq.chunks, posteriors: res.seq.posteriors });
      }
      if (res.verdict === "advance") {
        // The pooled chunks are the merge evidence: same protocol and seeds
        // as the baseline chunks they are compared with.
        confirmEvals = res.evals.filter((e) => e.ok);
        const seqRps = res.evals.filter((e) => e.ok).map((e) => e.metrics.runsPerSec);
        const meanRps = seqRps.length ? seqRps.reduce((a, b) => a + b, 0) / seqRps.length : 0;
        throughputRatio = baseline.runsPerSec > 0 ? meanRps / baseline.runsPerSec : null;
        const regr = await timed("regression", () => runRegression(ctx, baseline.runsPerSec));
        regressionPassed = regr.passed;
        journal(state, n, "regression", regr);
        decisionInputsReady = true;
      }
    }

    const decision = perfDecision ?? finalGate({
      hypothesis: h,
      confirmEvals,
      baselineEvals: baseline.sequential,
      regressionPassed: decisionInputsReady ? regressionPassed : false,
      lintFailures,
      changedSpurFiles: spurFiles,
      throughputRatio,
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
        decision.objectiveDeltas = { ...cmp.deltas, h1: h1(ran) - h1(baseRan), h3: h3(ran) - h3(baseRan), primary: cmp.deltas["violations"] !== 0 ? (cmp.deltas["violations"] ?? 0) : (cmp.deltas["depth>=5"] ?? 0) };
      }
    }
    state.setDecision(decision);
    journal(state, n, "decision", decision);

    const paramsAfter = generalConfigParamCount(policy);
    decision.objectiveDeltas["params"] = paramsAfter - paramsBefore;
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
        };
        state.setMeta("baseline", JSON.stringify(newBaseline));
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
        const ledger = JSON.stringify(state.countByStatus()) + "\n" + JSON.stringify(timings);
        const evalConfig = readFileSync(path.join(ROOT, policy.evaluation.configTemplate), "utf8");
        const lastChunk = state.allEvaluations().filter((e) => e.fidelity === "sequential" && e.ok).at(-1);
        const chunkLine = lastChunk
          ? `One sequential chunk = ${lastChunk.metrics.runs} runs (${policy.sequential.chunkRunsPerConfig} runs/config across the grid), explore ${Math.round(lastChunk.exploreWallMs / 1000)} s; ${policy.sequential.minChunks}-${policy.sequential.maxChunks} chunks per hypothesis; the baseline holds ${policy.sequential.maxChunks} chunks.`
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
      const baseline = loadBaseline(state);
      writeStatus(state, policy, {
        baseline: (baseline?.sequential[0] ?? baseline?.confirm[0])?.metrics ?? null,
        reference: loadReference(state)?.confirm[0]?.metrics ?? null,
        graderVersion: graderVersion(),
        openPrs: state.listHypotheses("needs_human").flatMap((x) => x.prUrls),
      });
    } catch { /* status rendering must never kill the loop */ }
    state.finishIteration(n, timings, notes);
  }
}

export async function runLoop(deps: LoopDeps): Promise<void> {
  const startBaseline = loadBaseline(deps.state);
  if (!startBaseline || startBaseline.sequential.length === 0) {
    console.error("no sequential baseline recorded; run `loop baseline` first");
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
  try {
    const util0 = await collectUtilization(deps.policy);
    if (util0.trim().startsWith("{")) deps.state.setMeta("utilization", util0);
  } catch { /* gating simply stays open without a snapshot */ }
  for (;;) {
    if (existsSync(path.join(ROOT, "research/STOP"))) {
      console.log("STOP sentinel found; exiting loop.");
      return;
    }
    const dailyUsed = deps.state.getDailyWallSeconds();
    if (dailyUsed > deps.policy.budgets.dailyWallHours * 3600) {
      console.log(`daily wall budget exhausted (${Math.round(dailyUsed / 60)} min); sleeping 30 min`);
      await new Promise((r) => setTimeout(r, 30 * 60 * 1000));
      continue;
    }
    const t0 = performance.now(); // daily budget counts active time only
    try {
      await runIteration(deps);
      consecutiveFailures = 0;
    } catch (e) {
      consecutiveFailures++;
      console.error(`iteration failed: ${String(e)} (${consecutiveFailures} consecutive)`);
      if (consecutiveFailures >= 5) {
        console.error("5 consecutive failures; exiting for safety.");
        return;
      }
      await new Promise((r) => setTimeout(r, 60_000));
    }
    deps.state.addDailyWallSeconds((performance.now() - t0) / 1000);
  }
}
