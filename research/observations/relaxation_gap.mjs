#!/usr/bin/env node
// Which orderings of a plan the bug needs: leave-one-out ablation of a plan's
// dependency edges, run through the plan runner and the checker.
//
// A plan is a partial order over a few named events; the runner holds each
// event until its predecessors have happened and lets everything else
// interleave freely. Removing one edge and counting violations therefore
// measures how much that ordering raises the probability of the failing
// interleaving, not whether two events must be adjacent. What has to happen
// between two anchored events is read off the failing runs themselves, which
// the script dumps at the end.
//
// Reporting only. Writes plan variants and corpora under tmp/loop/relaxgap,
// writes a report, changes no oracle and no gate.
//
// Usage:
//   node research/observations/relaxation_gap.mjs --plan research/oracle/tiers/relax_minimal.json
//        [--spec bin/spur/VR.spur] [--runs 20000] [--scale-runs 100000]
//        [--model kv] [--dump 3] [--threads 12]
//        [--out research/observations/RELAXATION_GAP.md]
//   node research/observations/relaxation_gap.mjs --selftest

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// The repository root; RELAXGAP_ROOT lets a copy of this script run from elsewhere.
const ROOT = process.env.RELAXGAP_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SPUR = path.join(ROOT, "spur/target/release/spur");
const CHECKER = path.join(ROOT, "porcupine/batch");
const WORK = path.join(ROOT, "tmp/loop/relaxgap");

// An edge whose removal leaves fewer than this fraction of the full plan's
// violations is re-measured at the larger run count before it is classified.
const SCALE_BELOW = 0.5;
// Lift bands for the classification, on the ratio full rate / variant rate.
const NECESSARY_LIFT = 5;
const CONTRIBUTES_LIFT = 1.5;

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt; };

function variantsOf(plan, runs) {
  const withRuns = (p) => ({ ...p, num_runs: runs });
  const out = [["full", withRuns(plan)]];
  plan.dependencies.forEach((edge, i) => {
    out.push([`-edge ${edge[0]}->${edge[1]}`, withRuns({ ...plan, dependencies: plan.dependencies.filter((_, j) => j !== i) })]);
  });
  for (const [name, spec] of Object.entries(plan.events)) {
    if (!("allow_timer" in spec)) continue;
    const events = Object.fromEntries(Object.entries(plan.events).filter(([k]) => k !== name));
    out.push([`-event ${name}`, withRuns({ ...plan, events, dependencies: plan.dependencies.filter((e) => !e.includes(name)) })]);
  }
  if (plan.strict_timers) out.push(["strict_timers=false", withRuns({ ...plan, strict_timers: false })]);
  out.push(["no dependencies", withRuns({ ...plan, dependencies: [] })]);
  return out;
}

function classify(fullRate, rate) {
  if (rate === 0) return "necessary";
  const lift = fullRate / rate;
  return lift >= NECESSARY_LIFT ? "necessary" : lift >= CONTRIBUTES_LIFT ? "contributes" : "slack";
}

const tagOf = (name) => name.replace(/[^a-z0-9]+/gi, "_");

function measure(name, plan, spec, model, threads, keep) {
  const tag = tagOf(name) + "_" + plan.num_runs;
  const planPath = path.join(WORK, `${tag}.json`), out = path.join(WORK, tag);
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");
  rmSync(out, { recursive: true, force: true });
  const started = Date.now();
  execFileSync(SPUR, ["run-plan", spec, "-p", planPath, "-o", out, "-y"], { cwd: ROOT, stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, RAYON_NUM_THREADS: String(threads) } });
  let json;
  try { json = JSON.parse(execFileSync(CHECKER, ["-input", out, "-model", model, "-timeout", "10000"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); }
  catch (e) { json = JSON.parse(e.stdout || "{}"); }
  if (!keep) rmSync(out, { recursive: true, force: true });
  return { name, runs: json.total_runs ?? 0, violations: json.violations ?? 0, ids: json.violating_run_ids ?? [], wallSec: (Date.now() - started) / 1000, dir: keep ? out : null };
}

// The execution rows and the handlers the plan names, in step order.
function skeleton(dir, runId, handlers) {
  const text = execFileSync(SPUR, ["debug", "combined", "--db", dir, "--run-id", String(runId)], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const keep = new RegExp(`Crash:|Recover:|Invocation:|Response:|TimerFired|(Dispatch|Enter) (${handlers.map((h) => h.replace(/[.]/g, "\\.")).join("|")})\\b`);
  return text.split("\n").filter((l) => !l.includes("[Log") && keep.test(l)).map((l) => l.replace(/\[(Trace|Execution)\s*\] /, "").replace(/\[sched=\d+\]\s*/, "").replace(/\s+/g, " ").trim());
}

function report(planPath, rows, scaled, dumps) {
  const full = rows.find((r) => r.name === "full");
  const fullRate = full.violations / full.runs;
  const lines = [`# Relaxation gap of ${path.relative(ROOT, planPath)}`, "",
    `Leave-one-out over ${rows.length - 1} variants of the plan, ${full.runs} runs each; ambiguous variants re-measured at ${scaled[0]?.runs ?? "-"} runs. Run ids are deterministic per plan, so variants at one run count are directly comparable.`, "",
    "An edge is a partial-order constraint. A variant with no violations means the free interleaving reaches the failing schedule too rarely to see at this count; the lift is a lower bound on how much the ordering raises that probability, not a claim that the two events are adjacent. What sits between them is read off the dumped runs below.", "",
    "| variant | runs | violations | rate | lift | class |", "|---|---|---|---|---|---|"];
  const merged = rows.map((r) => scaled.find((s) => s.name === r.name) ?? r);
  // A variant is compared with the full plan measured at the same run count:
  // run ids are deterministic per plan, so equal counts share their seeds.
  const fullByRuns = new Map();
  for (const r of [...rows, ...scaled]) if (r.name === "full") fullByRuns.set(r.runs, r.violations / r.runs);
  for (const r of merged) {
    const rate = r.violations / Math.max(1, r.runs);
    const fullHere = fullByRuns.get(r.runs) ?? fullRate;
    const lift = r.name === "full" ? "-" : rate === 0 ? `>=${(fullHere * r.runs).toFixed(0)}` : (fullHere / rate).toFixed(1) + "x";
    lines.push(`| ${r.name} | ${r.runs} | ${r.violations} | ${rate.toFixed(5)} | ${lift} | ${r.name === "full" ? "-" : classify(fullHere, rate)} |`);
  }
  lines.push("", `Full plan: ${[...fullByRuns].map(([n, p]) => `${Math.round(p * n)}/${n} (${p.toFixed(5)})`).join("; ")}. Lifts compare each variant with the full plan at its own run count.`, "");
  for (const [runId, rowsOf] of dumps) {
    lines.push(`## Failing run ${runId}`, "", "```", ...rowsOf, "```", "");
  }
  return lines.join("\n");
}

function selftest() {
  const plan = { num_runs: 1, strict_timers: true, events: { a: { write: [0, "x"] }, t: { allow_timer: [1, "l"] }, c: { crash: 1 } }, dependencies: [["a", "t"], ["t", "c"]] };
  const v = variantsOf(plan, 7);
  const names = v.map(([n]) => n);
  const checks = [
    [names.length === 1 + 2 + 1 + 1 + 1, `variant count ${names.length}`],
    [v.every(([, p]) => p.num_runs === 7), "run count applied"],
    [v.find(([n]) => n === "-event t")[1].dependencies.length === 0, "event removal drops its edges"],
    [v.find(([n]) => n === "-edge a->t")[1].dependencies.length === 1, "edge removal keeps the others"],
    [classify(0.001, 0) === "necessary" && classify(0.001, 0.0001) === "necessary" && classify(0.001, 0.0005) === "contributes" && classify(0.001, 0.0009) === "slack", "classification bands"],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, m]) => m);
  console.log(failed.length ? `selftest FAILED: ${failed.join("; ")}` : "selftest ok");
  process.exit(failed.length ? 1 : 0);
}

if (args.includes("--selftest")) selftest();
const planPath = path.resolve(ROOT, opt("plan", ""));
if (!planPath || !opt("plan", "")) { console.error("--plan is required"); process.exit(2); }
const spec = path.resolve(ROOT, opt("spec", "bin/spur/VR.spur"));
const runs = Number(opt("runs", 20000)), scaleRuns = Number(opt("scale-runs", 100000));
const model = opt("model", "kv"), dump = Number(opt("dump", 3)), threads = Number(opt("threads", 12));
const outPath = path.resolve(ROOT, opt("out", "research/observations/RELAXATION_GAP.md"));
mkdirSync(WORK, { recursive: true });
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const handlers = Object.values(plan.events).map((e) => e.deliver?.function).filter(Boolean);

const rows = [];
for (const [name, variant] of variantsOf(plan, runs)) {
  const r = measure(name, variant, spec, model, threads, name === "full");
  rows.push(r); console.log(`${name}: ${r.violations}/${r.runs} (${r.wallSec.toFixed(0)}s)`);
}
const full = rows.find((r) => r.name === "full");
const fullRate = full.violations / full.runs;
const ambiguous = rows.filter((r) => r.name !== "full" && r.violations > 0 && r.violations / r.runs < SCALE_BELOW * fullRate);
const scaled = [];
if (scaleRuns > runs && ambiguous.length) {
  for (const [name, variant] of variantsOf(plan, scaleRuns)) {
    if (name !== "full" && !ambiguous.some((a) => a.name === name)) continue;
    const r = measure(name, variant, spec, model, threads, false);
    scaled.push(r); console.log(`scaled ${name}: ${r.violations}/${r.runs} (${r.wallSec.toFixed(0)}s)`);
  }
}
const dumps = full.ids.slice(0, dump).map((id) => [id, skeleton(full.dir, id, handlers)]);
writeFileSync(outPath, report(planPath, rows, scaled, dumps) + "\n");
console.log(`wrote ${outPath}`);
