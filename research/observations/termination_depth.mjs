#!/usr/bin/env node
// Prefix depth and violations by the way a run ended, per corpus and per arm.
//
// A run ends because its plan completed, because it deadlocked, or because
// the step budget ran out. Whether the deep and the violating runs are the
// ones that complete decides whether steering a session toward termination
// is a lever or a distraction, and no ladder number answers that: the
// ladder pools over end reasons.
//
// Reporting only. Runs the runs-table reader, the grader and the checker
// on a corpus, caches their JSON beside it, and writes a report. Changes no
// gate.
//
// Usage:
//   node research/observations/termination_depth.mjs \
//        --corpus vr=tmp/loop/term-vr=research/oracle/relax_minimal_general.json \
//        --corpus plan=tmp/loop/term-plan=research/oracle/relax_minimal.json \
//        [--out research/observations/TERMINATION_DEPTH.md]
//   node research/observations/termination_depth.mjs --selftest
//
// The report file keeps everything above the marker line
// "<!-- generated below -->" and regenerates everything under it.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TA = path.join(ROOT, "traceanalyzer/main");
const PORC = path.join(ROOT, "porcupine/batch");
const MARKER = "<!-- generated below -->";
const Z_SEPARATION = 2.7;

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export function wilson(k, n, z = 1.96) {
  if (n === 0) return { p: 0, lo: 0, hi: 0 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, lo: (c - h) / d, hi: (c + h) / d };
}

/** Two-proportion z on pooled variance; NaN when a side is empty. */
export function zTwo(k1, n1, k2, n2) {
  if (n1 === 0 || n2 === 0) return NaN;
  const p = (k1 + k2) / (n1 + n2);
  if (p <= 0 || p >= 1) return k1 / n1 === k2 / n2 ? 0 : Infinity * Math.sign(k1 / n1 - k2 / n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return (k1 / n1 - k2 / n2) / se;
}

function quartiles(values) {
  if (values.length === 0) return [];
  const s = [...values].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
  return [at(0.25), at(0.5), at(0.75)];
}

// ---------------------------------------------------------------------------
// Corpus loading
// ---------------------------------------------------------------------------

function tool(cmd, argv, okCodes) {
  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  if (!okCodes.includes(r.status)) throw new Error(`${path.basename(cmd)} ${argv.join(" ")} exited ${r.status}: ${(r.stderr ?? "").slice(-500)}`);
  return r.stdout;
}

function cached(file, produce) {
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const text = produce();
  writeFileSync(file, text);
  return JSON.parse(text);
}

function findKey(o, key) {
  if (o && typeof o === "object") {
    if (!Array.isArray(o) && key in o) return o[key];
    for (const v of Object.values(o)) {
      const r = findKey(v, key);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

function loadCorpus(name, dir, oracle) {
  const abs = path.resolve(ROOT, dir);
  const runs = cached(`${abs}.termination.runs.json`, () => tool(TA, ["-input", abs, "-runs", "-format", "json"], [0]));
  const porc = cached(`${abs}.termination.porc.json`, () => tool(PORC, ["-input", abs, "-model", "kv", "-timeout", "10000"], [0, 2, 4]));
  const grade = cached(`${abs}.termination.grade.json`, () =>
    tool(TA, ["-input", abs, "-grade", "-dag-config", path.resolve(ROOT, oracle), "-grade-budget-ms", "0", "-grade-max-runs", "0", "-grade-run-depths", "-format", "json"], [0]));
  const rows = Array.isArray(runs) ? runs : (runs.rows ?? runs.runs ?? []);
  const depth = new Map((findKey(grade, "run_depths") ?? []).map(([id, d]) => [Number(id), Number(d)]));
  const violating = new Set((porc.violating_run_ids ?? []).map(Number));
  const joined = rows.filter((r) => depth.has(Number(r.run_id))).map((r) => ({ ...r, depth: depth.get(Number(r.run_id)), violated: violating.has(Number(r.run_id)) }));
  return { name, dir, oracle, rows: joined, total: rows.length, graded: depth.size, violations: violating.size, checkerTotal: porc.total_runs ?? null };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function table(rows, label, maxDepth) {
  const out = [];
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.end_reason)) by.set(r.end_reason, []);
    by.get(r.end_reason).push(r);
  }
  const reasons = [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  out.push(`### ${label}: ${rows.length} runs (${reasons.map(([k, v]) => `${k} ${v.length}`).join(", ")})`);
  out.push("");
  const ks = [];
  for (let k = 4; k <= maxDepth; k++) ks.push(k);
  out.push(`| end_reason | n | ${ks.map((k) => `P(depth>=${k})`).join(" | ")} | violations |`);
  out.push(`|---|---|${ks.map(() => "---").join("|")}|---|`);
  for (const [er, rs] of reasons) {
    const cells = ks.map((k) => {
      const c = rs.filter((r) => r.depth >= k).length;
      const w = wilson(c, rs.length);
      return `${w.p.toFixed(4)} [${w.lo.toFixed(4)}, ${w.hi.toFixed(4)}] (${c})`;
    });
    out.push(`| ${er} | ${rs.length} | ${cells.join(" | ")} | ${rs.filter((r) => r.violated).length} |`);
  }
  out.push("");
  const a = by.get("plan_complete") ?? [];
  const b = by.get("iterations_exhausted") ?? [];
  if (a.length && b.length) {
    const lines = [];
    for (let k = 5; k <= maxDepth; k++) {
      const ka = a.filter((r) => r.depth >= k).length;
      const kb = b.filter((r) => r.depth >= k).length;
      const z = zTwo(ka, a.length, kb, b.length);
      const ratio = kb > 0 ? (ka / a.length) / (kb / b.length) : NaN;
      lines.push(`depth>=${k}: z ${Number.isFinite(z) ? z.toFixed(1) : String(z)}, ratio ${Number.isFinite(ratio) ? ratio.toFixed(2) : "-"}`);
    }
    out.push(`Completed against budget-exhausted: ${lines.join("; ")}.`);
    out.push("");
  }
  const q = (rs) => quartiles(rs.map((r) => r.steps_used)).join("/");
  const deep = ks.filter((k) => k >= 6).map((k) => {
    const rs = rows.filter((r) => r.depth >= k);
    return rs.length >= 4 ? `depth>=${k} ${q(rs)}` : null;
  }).filter(Boolean);
  out.push(`steps_used quartiles (25/50/75): all ${q(rows)}; ${deep.join("; ")}.`);
  const viol = rows.filter((r) => r.violated);
  if (viol.length) {
    const cv = viol.filter((r) => r.end_reason === "plan_complete").length;
    const ca = rows.filter((r) => r.end_reason === "plan_complete").length;
    out.push("");
    out.push(`Violating runs: ${viol.length}; completed ${cv}/${viol.length} against ${(ca / rows.length).toFixed(3)} of all runs (z ${zTwo(cv, viol.length, ca, rows.length).toFixed(1)}); depths ${[...new Set(viol.map((r) => r.depth))].sort((x, y) => x - y).map((d) => `${d}:${viol.filter((r) => r.depth === d).length}`).join(", ")}; steps_used quartiles ${q(viol)}.`);
  }
  out.push("");
  return out;
}

function report(corpora) {
  const out = [MARKER, "", `Generated ${new Date().toISOString()} by \`research/observations/termination_depth.mjs\`.`, ""];
  for (const c of corpora) {
    const maxDepth = c.rows.reduce((m, r) => Math.max(m, r.depth), 4);
    out.push(`## ${c.name}: \`${c.dir}\` graded against \`${c.oracle}\``, "");
    out.push(`${c.total} runs, ${c.graded} graded, ${c.violations} violations (checker saw ${c.checkerTotal ?? "?"} runs).`, "");
    out.push(...table(c.rows, "pooled", maxDepth));
    const arms = [...new Set(c.rows.map((r) => r.arm))].sort();
    if (arms.length > 1) for (const a of arms) out.push(...table(c.rows.filter((r) => r.arm === a), `arm ${a}`, maxDepth));
  }
  return out.join("\n");
}

function selftest() {
  const w = wilson(50, 100);
  if (Math.abs(w.p - 0.5) > 1e-9 || w.lo > 0.41 || w.lo < 0.39 || w.hi < 0.59 || w.hi > 0.61) throw new Error(`wilson(50,100) ${JSON.stringify(w)}`);
  if (Math.abs(zTwo(50, 100, 50, 100)) > 1e-9) throw new Error("equal proportions must give z 0");
  if (zTwo(60, 100, 40, 100) < 2.8) throw new Error("60% against 40% at n 100 must separate");
  if (quartiles([1, 2, 3, 4, 5]).join("/") !== "2/3/4") throw new Error("quartiles");
  console.log("termination_depth selftest ok");
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) return selftest();
  const corpora = [];
  let out = path.join(ROOT, "research/observations/TERMINATION_DEPTH.md");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--corpus") {
      const [name, dir, oracle] = args[++i].split("=");
      if (!name || !dir || !oracle) throw new Error("--corpus takes name=dir=oracle");
      corpora.push(loadCorpus(name, dir, oracle));
    } else if (args[i] === "--out") out = path.resolve(ROOT, args[++i]);
    else throw new Error(`unknown argument ${args[i]}`);
  }
  if (corpora.length === 0) throw new Error("no --corpus given");
  const generated = report(corpora);
  let head = "";
  if (existsSync(out)) {
    const cur = readFileSync(out, "utf8");
    const i = cur.indexOf(MARKER);
    head = i >= 0 ? cur.slice(0, i) : cur + "\n";
  } else {
    head = "# Prefix depth by end reason\n\n";
  }
  writeFileSync(out, head + generated + "\n");
  console.log(`wrote ${out}`);
}

main();
