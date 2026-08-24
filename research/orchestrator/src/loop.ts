// The iteration state machine. Deterministic control; agents only inside
// clearly fenced phases. Every phase is timed, journaled, and recoverable —
// an exception resets both repos to research/vr-loop and the loop continues.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  PROPOSAL_LENSES, ROOT, implementHypothesis, judgeHypotheses, proposeHypotheses,
  reflectOnOutcome, runAudit, validateProposed,
} from "./agents.js";
import { classifyChangeRisk, compareToBaseline, finalGate, nonInferior, objectiveCounts, perfGate, screenAdvances } from "./decide.js";
import { collectProfile, runBench } from "./bench.js";
import { runEvaluation, type EvalContext } from "./evaluate.js";
import {
  SPUR, SUPER, changedFiles, checkout, commitHypothesisPair, createBranch, currentBranch,
  currentCommit, deleteBranch, diffText, createPr, lintProtectedPaths, lintRulerSubject,
  lintVrNames, mergePrSquash, push, resetHard, tag, pushTag,
} from "./gitops.js";
import type { Policy } from "./policy.js";
import { buildSpur, SPUR_BIN, cleanupDir, explore, materializeConfig, run } from "./runners.js";
import { runRegression } from "./regression.js";
import { Evaluation, Hypothesis, type GateDecision } from "./schemas.js";
import type { LoopState } from "./state.js";
import { writeStatus, appendObservation } from "./render.js";
import { z } from "zod";

const RESEARCH_BRANCH = "research/vr-loop";

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
  runsPerSec: z.number(),
});
export type BaselineMeta = z.infer<typeof BaselineMeta>;

export function loadBaseline(state: LoopState): BaselineMeta | null {
  const raw = state.getMeta("baseline");
  if (!raw) return null;
  const p = BaselineMeta.safeParse(JSON.parse(raw));
  return p.success ? p.data : null;
}

function journal(state: LoopState, iteration: number, event: string, data: unknown): void {
  state.appendJournal({ atIso: new Date().toISOString(), iteration, event, data });
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
  const results = await Promise.all(lenses.map((lens) => proposeHypotheses(policy, lens, statusMd, existingIds)));
  const candidates = results.flatMap((r) => r.value?.hypotheses ?? []);
  journal(state, iteration, "propose", { lenses: lenses.length, candidates: candidates.length, cost: results.reduce((a, r) => a + r.costUsd, 0) });
  if (candidates.length === 0) return;
  const poolSummaries = state.listHypotheses().map((h) => `${h.id} [${h.kind}/${h.status}]: ${h.title}`);
  const judged = await judgeHypotheses(policy, candidates, poolSummaries);
  const kept = judged.value?.hypotheses ?? candidates;
  const { valid, rejected } = validateProposed(kept);
  const room = Math.max(0, policy.proposal.maxPoolSize - state.listHypotheses("proposed").length);
  for (const h of valid.slice(0, room)) {
    if (!state.getHypothesis(h.id)) state.upsertHypothesis(h);
  }
  journal(state, iteration, "judge", { kept: valid.length, rejected: rejected.length, judgeCost: judged.costUsd });
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
  const { spurCommit } = commitHypothesisPair({
    branch,
    spurMessage: `${h.id}: ${h.title}\n\n${h.description.slice(0, 1200)}`,
    superMessage: `${h.id}: ${h.title} (evidence + pointer bump)`,
  });
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
// history may legitimately diverge — sync by reset, never by merge/pull.
function syncToOrigin(repo: string): void {
  run0("git", ["fetch", "origin", RESEARCH_BRANCH], repo);
  run0("git", ["checkout", "--force", RESEARCH_BRANCH], repo);
  run0("git", ["reset", "--hard", `origin/${RESEARCH_BRANCH}`], repo);
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
    const t0 = Date.now();
    try { return await fn(); } finally { timings[name] = (timings[name] ?? 0) + (Date.now() - t0) / 1000; }
  };
  let branch: string | null = null;
  let notes = "";

  try {
    preflight();
    const baseline = loadBaseline(state);
    if (!baseline) throw new Error("no baseline recorded — run `loop baseline` first");

    await timed("propose", () => refillPool(deps, n));
    const h = (await import("./select.js")).selectNext(state, policy);
    if (!h) { notes = "empty pool"; journal(state, n, "select", { none: true }); return; }
    state.upsertHypothesis({ ...h, status: "selected" });
    journal(state, n, "select", { id: h.id, kind: h.kind, title: h.title });

    branch = `hyp/${String(n).padStart(3, "0")}-${h.id}`.slice(0, 60);
    createBranch(SPUR, branch);
    createBranch(SUPER, branch);

    const impl = await timed("implement", () => implementHypothesis(policy, h));
    journal(state, n, "implement", { cost: impl.costUsd, turns: impl.turns, isError: impl.isError, summary: impl.summary.slice(0, 2000) });

    const { spurCommit, superCommit } = commitHypothesisPair({
      branch,
      spurMessage: `wip ${h.id}: ${h.title}`,
      superMessage: `wip ${h.id}: ${h.title}`,
    });
    const spurFiles = spurCommit ? changedFiles(SPUR, RESEARCH_BRANCH) : [];
    const superFiles = changedFiles(SUPER, RESEARCH_BRANCH).filter((f) => f !== "spur");
    if (spurFiles.length === 0 && superFiles.length === 0) {
      state.upsertHypothesis({ ...h, status: "blocked", branch, notes: "implementer produced no changes" });
      journal(state, n, "blocked", { reason: "no changes" });
      return;
    }

    const build = await timed("build", async () => {
      if (h.kind === "grader") return run("go", ["build", "-o", "main", "."], { timeoutMs: 120000, cwd: path.join(ROOT, "traceanalyzer") });
      if (spurFiles.length === 0) {
        return { ok: true, exitCode: 0, stdout: "", stderr: "build skipped (no spur changes)", wallMs: 0, timedOut: false };
      }
      return buildSpur(policy.budgets.maxBuildSeconds);
    });
    if (!build.ok) {
      state.upsertHypothesis({ ...h, status: "blocked", branch, notes: `build failed: ${build.stderr.slice(-1500)}` });
      journal(state, n, "blocked", { reason: "build failed" });
      return;
    }

    const lintFailures = [
      ...lintProtectedPaths(superFiles),
      ...lintRulerSubject(h.kind, superFiles),
      ...(h.kind === "grader" && spurFiles.length > 0 ? [`grader hypothesis touched spur: ${spurFiles.join(",")}`] : []),
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

    if (lintFailures.length === 0 && h.kind === "perf") {
      const baselineBin = path.join(ROOT, "tmp", "loop", "spur-baseline");
      const bench = await timed("bench", () => runBench(policy, SPUR_BIN, baselineBin));
      journal(state, n, "bench", bench);
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
      const screen = await timed("evaluate", () => runEvaluation(ctx, h.id, "screen"));
      allEvals["screen"] = screen;
      for (const e of screen) state.addEvaluation(e);
      const gate1 = screenAdvances(objectiveCounts(screen), objectiveCounts(baseline.screen));
      journal(state, n, "screen", { advance: gate1.advance, why: gate1.why });
      if (gate1.advance) {
        const promote = await timed("evaluate", () => runEvaluation(ctx, h.id, "promote"));
        allEvals["promote"] = promote;
        for (const e of promote) state.addEvaluation(e);
        const cmp = compareToBaseline(objectiveCounts(promote), objectiveCounts(baseline.promote));
        const promoteOk = cmp.improved.length > 0 && cmp.regressed.length === 0;
        const abl = h.kind === "ablate" || h.kind === "enabling" || h.kind === "grader" || h.kind === "meta";
        journal(state, n, "promote", { improved: cmp.improved, regressed: cmp.regressed, deltas: cmp.deltas });
        if (promoteOk || abl) {
          confirmEvals = await timed("evaluate", () => runEvaluation(ctx, h.id, "confirm"));
          allEvals["confirm"] = confirmEvals;
          for (const e of confirmEvals) state.addEvaluation(e);
          const screenRps = screen.filter((e) => e.ok).map((e) => e.metrics.runsPerSec);
          const meanRps = screenRps.length ? screenRps.reduce((a, b) => a + b, 0) / screenRps.length : 0;
          throughputRatio = baseline.runsPerSec > 0 ? meanRps / baseline.runsPerSec : null;
          const regr = await timed("regression", () => runRegression(ctx, baseline.runsPerSec));
          regressionPassed = regr.passed;
          journal(state, n, "regression", regr);
          decisionInputsReady = true;
        }
      }
    }

    const decision = perfDecision ?? finalGate({
      hypothesis: h,
      confirmEvals,
      baselineEvals: baseline.confirm,
      regressionPassed: decisionInputsReady ? regressionPassed : false,
      lintFailures,
      changedSpurFiles: spurFiles,
      throughputRatio,
    });
    if (!perfDecision && !decisionInputsReady && lintFailures.length === 0) {
      decision.verdict = "closed";
      decision.reasons = ["did not clear screen/promote gates"];
    }
    state.setDecision(decision);
    journal(state, n, "decision", decision);

    const evidence = { hypothesis: h, decision, evaluations: allEvals, spurFiles, superFiles, graderVersion: ctx.graderVersion };

    if (decision.verdict === "auto_merge" || decision.verdict === "needs_human") {
      const outcome = await timed("publish", async () => mergeFlow(n, h, branch as string, evidence, decision.verdict === "auto_merge"));
      journal(state, n, "publish", outcome);
      const status = decision.verdict === "auto_merge" && outcome.merged ? "merged" : "needs_human";
      state.upsertHypothesis({ ...h, status, branch, prUrls: outcome.prUrls });
      if (status === "needs_human") cleanupToResearchBranch(null); // PR lives on the pushed remote branch
      if (status === "merged") {
        const newBaseline: BaselineMeta = {
          screen: allEvals["screen"] ?? baseline.screen,
          promote: allEvals["promote"] ?? baseline.promote,
          confirm: confirmEvals.length ? confirmEvals : baseline.confirm,
          runsPerSec: baseline.runsPerSec * (throughputRatio ?? 1),
        };
        state.setMeta("baseline", JSON.stringify(newBaseline));
        if (spurFiles.length > 0) {
          try { copyFileSync(SPUR_BIN, path.join(ROOT, "tmp", "loop", "spur-baseline")); } catch { /* non-fatal */ }
        }
      }
    } else {
      state.upsertHypothesis({ ...h, status: decision.verdict === "blocked" ? "blocked" : "closed", branch });
      cleanupToResearchBranch(branch);
    }

    const refl = await timed("reflect", () => reflectOnOutcome(policy, h, JSON.stringify(evidence).slice(0, 20000)));
    if (refl.value) {
      appendObservation(`**${h.id}** (${decision.verdict}): ${refl.value.whatWeLearned}`);
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

    if (n % policy.audit.everyK === 0) {
      await timed("audit", async () => {
        const util0 = await collectUtilization(policy);
        const profile = await collectProfile(policy, SPUR_BIN);
        const util = `${util0}\n\n## perf profile (top symbols)\n${profile}`;
        const ledger = JSON.stringify(state.countByStatus()) + "\n" + JSON.stringify(timings);
        const audit = await runAudit(policy, n, readStatusMd(), ledger, util);
        if (audit.value) {
          appendObservation(`### Audit @${n}\n${audit.value.budgetConcentration}\n\nGoodhart: ${audit.value.goodhartSignals.join("; ") || "none"}\n\nUtilization: ${audit.value.utilizationFindings.map((u) => `${u.mechanism}=${u.classification}`).join(", ")}\n\nPolicy suggestions: ${audit.value.recommendedPolicyChanges.join("; ") || "none"}`);
          journal(state, n, "audit", audit.value);
        }
      });
    }
  } catch (e) {
    notes = `iteration error: ${String(e)}`;
    journal(state, n, "error", { error: String(e) });
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
        baseline: baseline?.confirm[0]?.metrics ?? null,
        graderVersion: graderVersion(),
        openPrs: state.listHypotheses("needs_human").flatMap((x) => x.prUrls),
      });
    } catch { /* status rendering must never kill the loop */ }
    state.finishIteration(n, timings, notes);
  }
}

export async function runLoop(deps: LoopDeps): Promise<void> {
  // Crash recovery: requeue hypotheses stranded mid-iteration and clear
  // leftover evaluation corpora from a killed run.
  for (const h of deps.state.listHypotheses()) {
    if (h.status === "selected" || h.status === "implementing") {
      deps.state.upsertHypothesis({ ...h, status: "proposed", branch: null, notes: `${h.notes} [requeued after restart]`.trim() });
    }
  }
  for (const d of readdirSync(path.join(ROOT, "tmp", "loop"))) {
    if (/^(eval-|bench-|regr-)/.test(d)) {
      rmSync(path.join(ROOT, "tmp", "loop", d), { recursive: true, force: true });
    }
  }
  let consecutiveFailures = 0;
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
    const t0 = Date.now();
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
    deps.state.addDailyWallSeconds((Date.now() - t0) / 1000);
  }
}
