#!/usr/bin/env node
// What separates a deep run from a shallow one, per run.
//
// Every scheduler hypothesis in the timer and crash families is drawn
// without a prior, because no measurement says which schedule features
// distinguish a run that reaches the top rungs from one that does not. The
// ladder pools over those features. This joins the per-run rows the runs
// table already emits to the per-run prefix depth the grader already emits,
// and reports each feature conditioned on the depth reached.
//
// Reporting only. Runs two read-only tools over a corpus, caches their JSON
// beside it, and writes a report. Changes no gate and no grader.
//
// Usage:
//   node research/observations/top_rung_events.mjs \
//        --corpus vr=tmp/loop/diag-vr=research/oracle/relax_minimal_general.json \
//        [--out research/observations/TOP_RUNG_EVENTS.md]
//   node research/observations/top_rung_events.mjs --selftest

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TA = path.join(ROOT, "traceanalyzer/main");
const MARKER = "<!-- generated below -->";

// Depth buckets. The top two are the ones no mechanism has moved.
export const BUCKETS = [
  { name: "<=3", lo: 0, hi: 3 },
  { name: "4-5", lo: 4, hi: 5 },
  { name: "6", lo: 6, hi: 6 },
  { name: ">=7", lo: 7, hi: Infinity },
];

export function bucketOf(depth) {
  return BUCKETS.find((b) => depth >= b.lo && depth <= b.hi)?.name ?? "<=3";
}

// Features available per run without touching the grader: the runs table
// carries them already.
export const FEATURES = [
  { key: "completed", of: (r) => (r.end_reason === "plan_complete" ? 1 : 0), kind: "rate" },
  { key: "deadlock", of: (r) => (r.end_reason === "deadlock" ? 1 : 0), kind: "rate" },
  { key: "steps_used", of: (r) => r.steps_used ?? 0, kind: "mean" },
  { key: "timers_fired", of: (r) => r.timers_fired ?? 0, kind: "mean" },
  { key: "timers_acted", of: (r) => r.timers_acted ?? 0, kind: "mean" },
  { key: "timer_act_ratio", of: (r) => ((r.timers_fired ?? 0) > 0 ? (r.timers_acted ?? 0) / r.timers_fired : 0), kind: "mean" },
  { key: "timers_inflight_fired", of: (r) => r.timers_inflight_fired ?? 0, kind: "mean" },
  { key: "timers_inflight_acted", of: (r) => r.timers_inflight_acted ?? 0, kind: "mean" },
  { key: "timers_idle_fired", of: (r) => r.timers_idle_fired ?? 0, kind: "mean" },
  { key: "max_inert_streak", of: (r) => r.max_inert_streak ?? 0, kind: "mean" },
];

export function summarize(rows) {
  const out = new Map();
  for (const b of BUCKETS) out.set(b.name, { n: 0, sums: new Map(), viol: 0 });
  for (const r of rows) {
    const g = out.get(bucketOf(r.depth));
    g.n += 1;
    if (r.violated) g.viol += 1;
    for (const f of FEATURES) g.sums.set(f.key, (g.sums.get(f.key) ?? 0) + f.of(r));
  }
  return out;
}

/** Two-proportion z on pooled variance; NaN when a side is empty. */
export function zTwo(k1, n1, k2, n2) {
  if (n1 === 0 || n2 === 0) return NaN;
  const p = (k1 + k2) / (n1 + n2);
  if (p <= 0 || p >= 1) return 0;
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se === 0 ? 0 : (k1 / n1 - k2 / n2) / se;
}

function tool(bin, args) {
  const r = spawnSync(bin, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(bin)} ${args.slice(0, 3).join(" ")} exited ${r.status}: ${(r.stderr || "").slice(0, 400)}`);
  const i = r.stdout.indexOf("[") >= 0 && (r.stdout.indexOf("[") < r.stdout.indexOf("{") || r.stdout.indexOf("{") < 0)
    ? r.stdout.indexOf("[") : r.stdout.indexOf("{");
  return JSON.parse(r.stdout.slice(i));
}

function cached(file, make) {
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const v = make();
  writeFileSync(file, JSON.stringify(v));
  return v;
}

function findKey(obj, key) {
  if (obj === null || typeof obj !== "object") return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const hit = findKey(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function load(name, dir, oracle) {
  const abs = path.resolve(ROOT, dir);
  const runs = cached(`${abs}.toprung.runs.json`, () => tool(TA, ["-input", abs, "-runs", "-format", "json"]));
  const grade = cached(`${abs}.toprung.grade.json`, () =>
    tool(TA, ["-input", abs, "-grade", "-dag-config", path.resolve(ROOT, oracle),
      "-grade-budget-ms", "0", "-grade-max-runs", "0", "-grade-run-depths", "-format", "json"]));
  const rows = Array.isArray(runs) ? runs : (runs.rows ?? runs.runs ?? []);
  const depth = new Map((findKey(grade, "run_depths") ?? []).map(([id, d]) => [Number(id), Number(d)]));
  const joined = rows.filter((r) => depth.has(Number(r.run_id)))
    .map((r) => ({ ...r, depth: depth.get(Number(r.run_id)), violated: false }));
  return { name, dir, rows: joined, total: rows.length, graded: depth.size };
}

function report(corpora) {
  const out = [MARKER, "", `Generated ${new Date().toISOString()} by \`research/observations/top_rung_events.mjs\`.`, ""];
  for (const c of corpora) {
    out.push(`## ${c.name}`, "", `${c.total} runs, ${c.graded} graded.`, "");
    const s = summarize(c.rows);
    out.push(`| feature | ${BUCKETS.map((b) => b.name).join(" | ")} | >=7 vs <=3 |`);
    out.push(`| --- | ${BUCKETS.map(() => "---").join(" | ")} | --- |`);
    out.push(`| n | ${BUCKETS.map((b) => s.get(b.name).n).join(" | ")} | |`);
    for (const f of FEATURES) {
      const cells = BUCKETS.map((b) => {
        const g = s.get(b.name);
        return g.n === 0 ? "-" : (g.sums.get(f.key) / g.n).toFixed(f.kind === "rate" ? 4 : 2);
      });
      let cmp = "";
      if (f.kind === "rate") {
        const hi = s.get(">=7"), lo = s.get("<=3");
        const z = zTwo(hi.sums.get(f.key), hi.n, lo.sums.get(f.key), lo.n);
        cmp = Number.isFinite(z) ? `z ${z.toFixed(1)}` : "-";
      }
      out.push(`| ${f.key} | ${cells.join(" | ")} | ${cmp} |`);
    }
    out.push("");
  }
  out.push("A feature that separates the buckets is a prior for the next scheduler",
    "hypothesis in that family. One that does not is a family drawn blind.", "");
  return out.join("\n");
}

function selftest() {
  const fail = [];
  if (bucketOf(0) !== "<=3" || bucketOf(3) !== "<=3") fail.push("low bucket");
  if (bucketOf(4) !== "4-5" || bucketOf(5) !== "4-5") fail.push("mid bucket");
  if (bucketOf(6) !== "6") fail.push("six bucket");
  if (bucketOf(7) !== ">=7" || bucketOf(99) !== ">=7") fail.push("top bucket");
  const rows = [
    { run_id: 1, depth: 8, end_reason: "plan_complete", steps_used: 100, timers_fired: 10, timers_acted: 5 },
    { run_id: 2, depth: 1, end_reason: "iterations_exhausted", steps_used: 10, timers_fired: 2, timers_acted: 0 },
  ];
  const s = summarize(rows);
  if (s.get(">=7").n !== 1 || s.get("<=3").n !== 1) fail.push("bucket counts");
  if (s.get(">=7").sums.get("completed") !== 1) fail.push("completed rate");
  if (s.get("<=3").sums.get("completed") !== 0) fail.push("completed rate low");
  if (Math.abs(s.get(">=7").sums.get("timer_act_ratio") - 0.5) > 1e-9) fail.push("timer act ratio");
  if (Number.isFinite(zTwo(1, 0, 0, 0))) fail.push("empty side is NaN");
  if (fail.length) { console.error("selftest FAILED: " + fail.join(", ")); process.exit(1); }
  console.log("top_rung_events selftest ok");
}

const args = process.argv.slice(2);
if (args.includes("--selftest")) { selftest(); process.exit(0); }
const specs = args.flatMap((a, i) => (a === "--corpus" ? [args[i + 1]] : []));
if (specs.length === 0) { console.error("need --corpus name=dir=oracle"); process.exit(2); }
const outPath = (() => { const i = args.indexOf("--out"); return i >= 0 ? args[i + 1] : path.join(ROOT, "research/observations/TOP_RUNG_EVENTS.md"); })();
const corpora = specs.map((s) => { const [name, dir, oracle] = s.split("="); return load(name, dir, oracle); });
const head = existsSync(outPath) ? readFileSync(outPath, "utf8").split(MARKER)[0] : "# What separates a deep run from a shallow one\n\n";
writeFileSync(outPath, head + report(corpora));
console.log(`wrote ${path.relative(ROOT, outPath)}`);
