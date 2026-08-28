// CLI entrypoints. Run from research/orchestrator with:
//   npx tsx src/cli.ts <command>
// Commands: baseline | once | start | status | regression | selftest
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { runEvaluation, type EvalContext } from "./evaluate.js";
import { commitAll, currentCommit, ensureClean, SPUR, SUPER } from "./gitops.js";
import { graderVersion, loadBaseline, loadReference, rejudge, runIteration, runLoop, sequentialBaselineChunks, topUpSequentialBaseline, type BaselineMeta } from "./loop.js";
import { loadPolicy } from "./policy.js";
import { renderPolicyMd, writeStatus } from "./render.js";
import { buildSpur, ROOT, SPUR_BIN, resolveRoot } from "./runners.js";
import { runRegression } from "./regression.js";
import { selfTestStats, selfTestPosteriors } from "./stats.js";
import { selfTestPanel, selfTestPanelGate, type PanelArms } from "./panel.js";
import { selfTestPanelAuthority } from "./decide.js";
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
  state.setMeta("baseline", JSON.stringify(baseline));
  if (!state.getMeta("baseline0")) state.setMeta("baseline0", JSON.stringify(baseline));
  mkdirSync(path.join(ROOT, "research/evaluations"), { recursive: true });
  writeFileSync(path.join(ROOT, "research/evaluations/000-baseline.json"), JSON.stringify({ graderVersion: ctx.graderVersion, spurCommit: ctx.spurCommit, superCommit: ctx.superCommit, baseline }, null, 2));
  writeStatus(state, policy, { baseline: baseline.sequential[0]?.metrics ?? null, reference: loadReference(state)?.confirm[0]?.metrics ?? null, graderVersion: ctx.graderVersion, openPrs: [] });
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
  commitAll(SUPER, "baseline evaluation 000 (grader " + ctx.graderVersion + ")");
  console.log(`baseline recorded: rps=${rps.toFixed(1)}, evidence in research/evaluations/000-baseline.json`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "status";
  const state = new LoopState();
  try {
    switch (cmd) {
      case "selftest": {
        const failures = [...selfTestStats(), ...selfTestPosteriors(), ...selfTestPanel(), ...selfTestPanelGate(), ...selfTestPanelAuthority()];
        if (failures.length) { console.error("selftest FAILED:", failures); process.exit(1); }
        const { policy, clamps } = loadPolicy(POLICY_PATH);
        console.log("stats + posterior + panel selftest ok; policy loads ok; clamps:", clamps.length ? clamps : "(none)");
        console.log("models:", policy.models);
        console.log("SPUR_BIN exists:", existsSync(SPUR_BIN));
        console.log("grader version:", graderVersion());
        console.log("epoch:", state.currentEpoch(), "| pool:", JSON.stringify(state.countByStatus()));
        break;
      }
      case "seed": {
        const { validateProposed } = await import("./agents.js");
        const seedsPath = path.join(ROOT, "research/seed_hypotheses.json");
        const raw: unknown[] = JSON.parse((await import("node:fs")).readFileSync(seedsPath, "utf8"));
        const { valid, rejected } = validateProposed(raw);
        let added = 0;
        for (const h of valid) {
          if (!state.getHypothesis(h.id)) { state.upsertHypothesis(h); added++; }
        }
        console.log(`seeded ${added} hypotheses (${rejected.length} rejected: ${rejected.join("; ")})`);
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
        const baseline = loadBaseline(state);
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
      case "status": {
        const { policy } = loadPolicy(POLICY_PATH);
        const baseline = loadBaseline(state);
        writeStatus(state, policy, { baseline: baseline?.confirm[0]?.metrics ?? null, reference: loadReference(state)?.confirm[0]?.metrics ?? null, graderVersion: graderVersion(), openPrs: state.listHypotheses("needs_human").flatMap((h) => h.prUrls) });
        console.log("STATUS.md rendered. Pool:", JSON.stringify(state.countByStatus()));
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
