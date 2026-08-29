// CLI entrypoints. Run from research/orchestrator with:
//   npx tsx src/cli.ts <command>
// Commands: baseline | once | start | status | regression | selftest
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { runEvaluation, selfTestRunIdentity, type EvalContext } from "./evaluate.js";
import { commitAll, currentCommit, ensureClean, SPUR, SUPER } from "./gitops.js";
import { baselineEvidencePath, baselineKey, graderVersion, loadBaseline, loadReference, selfTestBaselineKeys, rejudge, runIteration, runLoop, sequentialBaselineChunks, topUpSequentialBaseline, type BaselineMeta } from "./loop.js";
import { loadPolicy } from "./policy.js";
import { baselineLadder, renderPolicyMd, selfTestRender, writeStatus } from "./render.js";
import { buildSpur, ROOT, SPUR_BIN, resolveRoot } from "./runners.js";
import { runRegression } from "./regression.js";
import { selfTestStats, selfTestPosteriors, selfTestSurvival } from "./stats.js";
import { calibrateMember, keyedManifestPath, loadPanelManifest, selfTestPanel, selfTestPanelGate, validateManifest, type PanelArms } from "./panel.js";
import { selfTestPanelAuthority } from "./decide.js";
import { pooledCountsOf, selfTestGateConsistency, seqRuleOf } from "./sequential.js";
import { LoopState } from "./state.js";

const POLICY_PATH = path.join(ROOT, "research/policy.json");

async function cmdBaseline(state: LoopState): Promise<void> {
  const { policy, clamps } = loadPolicy(POLICY_PATH);
  ensureClean(SPUR);
  ensureClean(SUPER, true);
  console.log("building spur...");
  const b = await buildSpur(policy.budgets.maxBuildSeconds);
  if (!b.ok) throw new Error(`build failed: ${b.stderr.slice(-2000)}`);
  const ctx: EvalContext = {
    policy, binary: SPUR_BIN, graderVersion: graderVersion(),
    spurCommit: currentCommit(SPUR), superCommit: currentCommit(SUPER),
  };
  const out: Partial<BaselineMeta> = {};
  for (const f of ["screen", "promote"] as const) {
    console.log(`baseline ${f} evaluation...`);
    const evals = await runEvaluation(ctx, "baseline", f);
    for (const e of evals) {
      state.addEvaluation(e);
      console.log(`  seed ${e.seed}: ok=${e.ok} runs=${e.metrics.runs} viol=${e.metrics.violations} meanDepth=${e.metrics.meanPrefixDepth.toFixed(2)} rps=${e.metrics.runsPerSec.toFixed(1)}${e.error ? " err=" + e.error : ""}`);
    }
    out[f] = evals;
  }
  console.log("baseline sequential chunks...");
  const sequential = await topUpSequentialBaseline(ctx, [], sequentialBaselineChunks(policy));
  for (const e of sequential) state.addEvaluation(e);
  const screenOk = (out.screen ?? []).filter((e) => e.ok);
  const rps = screenOk.length ? screenOk.reduce((a, e) => a + e.metrics.runsPerSec, 0) / screenOk.length : 0;
  const baseline: BaselineMeta = {
    screen: out.screen ?? [], promote: out.promote ?? [], confirm: out.confirm ?? [], sequential, runsPerSec: rps,
    rayonThreads: policy.evaluation.rayonThreads,
  };
  const threads = policy.evaluation.rayonThreads;
  state.setMeta(baselineKey(threads), JSON.stringify(baseline));
  if (!state.getMeta("baseline0")) state.setMeta("baseline0", JSON.stringify(baseline));
  mkdirSync(path.join(ROOT, "research/evaluations"), { recursive: true });
  writeFileSync(baselineEvidencePath(threads), JSON.stringify({ graderVersion: ctx.graderVersion, spurCommit: ctx.spurCommit, superCommit: ctx.superCommit, baseline }, null, 2));
  writeStatus(state, policy, { baseline: baselineLadder(baseline), reference: baselineLadder(loadReference(state)), graderVersion: ctx.graderVersion, openPrs: [] });
  renderPolicyMd(policy, clamps, ["initial policy"]);
  // The perf lane compares against this file copy, and the explorer rejects
  // unknown top-level keys under strict_config_keys. Left stale, one merge
  // that adds a config key makes every later hypothesis fail its throughput
  // case, which the gate reports as a regression failure on hypotheses that
  // did nothing wrong.
  try {
    mkdirSync(path.join(ROOT, "tmp/loop"), { recursive: true });
    copyFileSync(path.join(ROOT, "spur/target/release/spur"), path.join(ROOT, "tmp/loop/spur-baseline"));
    console.log("perf-lane baseline binary refreshed");
  } catch (e) {
    console.log(`WARNING: could not refresh tmp/loop/spur-baseline: ${String(e)}`);
  }
  commitAll(SUPER, `baseline evaluation 000 at ${threads} threads (grader ${ctx.graderVersion})`);
  console.log(`baseline recorded at ${threads} threads: rps=${rps.toFixed(1)}, evidence in ${path.relative(ROOT, baselineEvidencePath(threads))}`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "status";
  const state = new LoopState();
  try {
    switch (cmd) {
      case "selftest": {
        const { policy, clamps } = loadPolicy(POLICY_PATH);
        const stored = loadBaseline(state, policy.evaluation.rayonThreads);
        const live = stored && stored.sequential.some((e) => e.ok) ? { base: pooledCountsOf(stored.sequential), rule: seqRuleOf(policy) } : undefined;
        const failures = [...selfTestStats(), ...selfTestPosteriors(), ...selfTestSurvival(), ...selfTestPanel(), ...selfTestPanelGate(), ...selfTestPanelAuthority(), ...selfTestGateConsistency(live), ...selfTestBaselineKeys(), ...selfTestRender(existsSync(baselineEvidencePath(policy.evaluation.rayonThreads)) ? baselineEvidencePath(policy.evaluation.rayonThreads) : undefined), ...selfTestRunIdentity()];
        if (failures.length) { console.error("selftest FAILED:", failures); process.exit(1); }
        console.log("stats + posterior + panel + gate-consistency selftest ok; policy loads ok; clamps:", clamps.length ? clamps : "(none)");
        console.log("models:", policy.models);
        console.log("SPUR_BIN exists:", existsSync(SPUR_BIN));
        console.log("grader version:", graderVersion());
        console.log("epoch:", state.currentEpoch(), "| pool:", JSON.stringify(state.countByStatus()));
        break;
      }
      case "seed": {
        // Seeds enter the pool through the same judge as agent proposals, so
        // an operator's hand-written prior does not outrank a scored one.
        const { validateProposed, judgeHypotheses } = await import("./agents.js");
        const { calibrationTable, evaluationContext } = await import("./loop.js");
        const fs = await import("node:fs");
        const flags = new Set(process.argv.slice(3));
        const dryRun = flags.has("--dry-run"), noJudge = flags.has("--no-judge"), rescore = flags.has("--rescore");
        const { policy } = loadPolicy(POLICY_PATH);
        const raw: unknown[] = JSON.parse(fs.readFileSync(path.join(ROOT, "research/seed_hypotheses.json"), "utf8"));
        const { valid, rejected } = validateProposed(raw);
        const fresh = valid.filter((h) => !state.getHypothesis(h.id));
        const existing = valid.filter((h) => state.getHypothesis(h.id));
        const toJudge = noJudge ? [] : [...fresh, ...(rescore ? existing.filter((h) => state.getHypothesis(h.id)?.status === "proposed") : [])];
        const fileScore = new Map(valid.map((h) => [h.id, `${h.expectedGain}/${h.expectedCost}`]));
        let judged = new Map<string, typeof valid[number]>();
        let judgeCost = 0;
        let judgeError: string | undefined;
        if (toJudge.length > 0) {
          const poolSummaries = state.listHypotheses().filter((h) => !toJudge.some((t) => t.id === h.id)).map((h) => `${h.id} [${h.kind}/${h.status}]: ${h.title}`);
          const r = await judgeHypotheses(policy, toJudge, poolSummaries, calibrationTable(state), evaluationContext(state, policy));
          judgeCost = r.costUsd;
          judgeError = r.error ?? undefined;
          judged = new Map(validateProposed(r.value?.hypotheses ?? []).valid.map((h) => [h.id, h]));
        }
        let added = 0, rescored = 0;
        for (const h of [...fresh, ...existing]) {
          const j = judged.get(h.id);
          const isFresh = !state.getHypothesis(h.id);
          if (!isFresh && !j) continue;
          const entry = j ? { ...h, expectedGain: j.expectedGain, expectedCost: j.expectedCost, notes: `${h.notes ?? ""} [judged at seed: ${(j.notes ?? "").slice(0, 200)}]`.trim() } : h;
          if (!dryRun) state.upsertHypothesis(entry);
          if (isFresh) added++; else rescored++;
        }
        const notScored = toJudge.filter((h) => !judged.has(h.id)).length;
        console.log(`${dryRun ? "dry run: " : ""}seeded ${added}, rescored ${rescored}, not scored by the judge ${notScored}, left as they were ${existing.length - rescored - notScored}, rejected ${rejected.length}${rejected.length ? ": " + rejected.join("; ") : ""}${judgeError ? "; judge error: " + judgeError : ""}${toJudge.length ? ` (judge cost $${judgeCost.toFixed(2)})` : ""}`);
        for (const h of valid) {
          const j = judged.get(h.id);
          const now = j ? `${j.expectedGain}/${j.expectedCost}` : fileScore.get(h.id);
          const mark = j && now !== fileScore.get(h.id) ? ` (file ${fileScore.get(h.id)})` : "";
          console.log(`  ${h.kind.padEnd(8)} ${String(now).padEnd(7)}${mark.padEnd(14)} ${h.id}: ${h.title.slice(0, 70)}${j?.notes ? "\n           judge: " + String(j.notes).slice(0, 220) : ""}`);
        }
        if (!dryRun) (await import("./loop.js")).journal(state, -1, "seed", { added, rescored, rejected: rejected.length, judgeCost });
        break;
      }
      case "rejudge": {
        const { policy } = loadPolicy(POLICY_PATH);
        await rejudge(state, policy, 0, "operator");
        for (const h of state.listHypotheses()) {
          if (h.notes.includes("[rejudged operator")) console.log(`${h.status.padEnd(8)} ${h.expectedGain}/${h.expectedCost} ${h.id}: ${h.notes.slice(h.notes.lastIndexOf("[rejudged"))}`);
        }
        console.log("pool:", JSON.stringify(state.countByStatus()));
        break;
      }
      case "grader-queue": {
        for (const h of state.listHypotheses("parked").filter((x) => x.notes.startsWith("[grader-review]"))) {
          console.log(`\n== ${h.id} (gain ${h.expectedGain} / cost ${h.expectedCost})\n${h.title}\n${h.description}\nRationale: ${h.rationale}\n${h.notes}`);
        }
        break;
      }
      case "epoch": {
        const sub = process.argv[3];
        if (sub === "bump") {
          const reason = process.argv.slice(4).join(" ") || "(no reason given)";
          const e = state.bumpEpoch();
          state.appendJournal({ atIso: new Date().toISOString(), iteration: -1, event: "epoch_bump", data: { epoch: e, reason } });
          console.log(`epoch -> ${e}: ${reason}. Results from earlier epochs stay in the record but no longer steer calibration, lineage scoring, or the re-judge.`);
        } else {
          console.log(`current epoch: ${state.currentEpoch()}`);
        }
        break;
      }
      case "baseline": await cmdBaseline(state); break;
      case "once": {
        const { policy } = loadPolicy(POLICY_PATH);
        await runIteration({ state, policy });
        break;
      }
      case "start": {
        const { policy } = loadPolicy(POLICY_PATH);
        console.log("starting loop; create research/STOP to stop gracefully.");
        await runLoop({ state, policy });
        break;
      }
      case "regression": {
        const { policy } = loadPolicy(POLICY_PATH);
        const b = await buildSpur(policy.budgets.maxBuildSeconds);
        if (!b.ok) throw new Error("build failed");
        const baseline = loadBaseline(state, policy.evaluation.rayonThreads);
        const ctx: EvalContext = { policy, binary: SPUR_BIN, graderVersion: graderVersion(), spurCommit: currentCommit(SPUR), superCommit: currentCommit(SUPER) };
        // A/A by default: both arms are HEAD, so every z should sit near zero
        // and nothing should collapse. Pass a seed to vary the session.
        const seed = Number(process.argv[3] ?? 20000);
        const template = resolveRoot(policy.evaluation.configTemplate);
        const arms: PanelArms = {
          candidateBinary: SPUR_BIN, candidateTemplate: template,
          baselineBinary: SPUR_BIN, baselineTemplate: template,
          seed, changedSpurCode: false, declaredFiringCounter: null,
        };
        const r = await runRegression(ctx, baseline?.runsPerSec ?? null, arms);
        for (const c of r.cases) console.log(`${c.passed ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
        if (r.panel) {
          console.log(`panel: judging=[${r.panel.judging.join(", ")}] combinedZ=${r.panel.combinedZ === null ? "null" : r.panel.combinedZ.toFixed(2)} wall=${(r.panel.wallMs / 1000).toFixed(0)}s`);
          for (const nj of r.panel.nonJudging) console.log(`  not judging ${nj.id}: ${nj.reason}`);
        }
        process.exitCode = r.passed ? 0 : 1;
        break;
      }
      case "panel-calibrate": {
        // Measures every member on HEAD at its manifest wall over N seeds of
        // replicates and writes eventsPerSec, dispersion, tauBestSec and
        // runsPerSec back into the manifest. The rates a member is admitted
        // on (expectedRate, controls, ceiling) are not touched here.
        const { policy } = loadPolicy(POLICY_PATH);
        const b = await buildSpur(policy.budgets.maxBuildSeconds);
        if (!b.ok) throw new Error("build failed");
        const seeds = Number(process.argv[3] ?? 4);
        // Calibration belongs to the thread count it was measured at, so it
        // is written to the manifest named for this count, seeded from the
        // bare manifest when no such file exists yet.
        const basePath = resolveRoot(policy.regression.panelManifest);
        const manifestPath = basePath.replace(/\.json$/, `.${policy.evaluation.rayonThreads}.json`);
        if (!existsSync(manifestPath)) copyFileSync(basePath, manifestPath);
        const manifest = loadPanelManifest(manifestPath);
        if (manifest.version !== 2) throw new Error("panel-calibrate applies to a version-2 manifest");
        const ctx: EvalContext = { policy, binary: SPUR_BIN, graderVersion: graderVersion(), spurCommit: currentCommit(SPUR), superCommit: currentCommit(SUPER) };
        const template = resolveRoot(policy.evaluation.configTemplate);
        const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as { members: Array<Record<string, unknown> & { id: string; calibration: Record<string, unknown> }> };
        console.log("id | seeds | runs | violations | exposure s | events/s | runs/s | dispersion | tau s | truncated");
        for (const m of manifest.members) {
          const c = await calibrateMember(ctx, m, SPUR_BIN, template, seeds);
          console.log(`${c.id} | ${c.seeds} | ${c.runs} | ${c.violations} | ${c.exposureSec.toFixed(1)} | ${c.eventsPerSec.toFixed(4)} | ${c.runsPerSec.toFixed(0)} | ${c.dispersion.toFixed(3)} | ${c.tauSec === null ? "-" : c.tauSec.toFixed(2)} | ${c.truncated}`);
          const entry = raw.members.find((x) => x.id === m.id);
          if (!entry) continue;
          entry.calibration = {
            ...entry.calibration,
            atIso: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            eventsPerSec: Number(c.eventsPerSec.toFixed(5)),
            tauBestSec: Number((c.tauSec ?? 0).toFixed(4)),
            dispersion: Number(c.dispersion.toFixed(3)),
            runsPerSec: Math.round(c.runsPerSec),
          };
          writeFileSync(manifestPath, JSON.stringify(raw, null, 2) + "\n");
        }
        const errs = validateManifest(loadPanelManifest(manifestPath), policy.regression.wallSecPerCase, 1 - policy.regression.throughputTolerance);
        if (errs.length) { console.error("manifest invalid after calibration:", errs); process.exitCode = 1; }
        else console.log(`manifest calibrated: ${manifestPath}`);
        break;
      }
      case "status": {
        const { policy } = loadPolicy(POLICY_PATH);
        const baseline = loadBaseline(state, policy.evaluation.rayonThreads);
        writeStatus(state, policy, { baseline: baselineLadder(baseline), reference: baselineLadder(loadReference(state)), graderVersion: graderVersion(), openPrs: state.listHypotheses("needs_human").flatMap((h) => h.prUrls) });
        console.log("STATUS.md rendered. Pool:", JSON.stringify(state.countByStatus()));
        const { listBaselines } = await import("./loop.js");
        const host = policy.evaluation.rayonThreads;
        const rows = listBaselines(state);
        console.log(rows.length === 0 ? "baselines: none" : "baselines: " + rows.map((b) => `${b.threads} threads: spur ${b.spurCommit}, ${b.chunks} chunks, ${Math.round(b.runsPerSec)} runs/s, ${b.freshness}${b.threads === host ? " (this mask)" : ""}`).join(" | "));
        if (!rows.some((b) => b.threads === host)) console.log(`no baseline for the ${host} threads this mask resolves to; run cli baseline under it before starting`);
        break;
      }
      default:
        console.error(`unknown command ${cmd}; use baseline|once|start|status|regression|selftest`);
        process.exitCode = 2;
    }
  } finally {
    state.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
