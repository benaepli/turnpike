#!/usr/bin/env node
// Prefix depth against how long a run went without a delivery having an effect.
//
// A run's longest quiet stretch is the longest span of consecutive deliveries
// whose handler changed no node's state. If depth only ever appears below some
// quiet stretch, a run past that stretch is spending budget it will not turn
// into events and ending it early is worth something; if depth is flat in the
// stretch, or rises with it, ending a quiet run throws away the runs that were
// about to produce. Neither the ladder nor the termination counters answer
// this: they pool over the stretch.
//
// The simulator writes the stretch per run id (`utilization.json`,
// `quiet_stretch.per_run`, recorded when `quiet_stretch_telemetry` is on); the
// grader assigns the depth per run id. This joins the two.
//
// Reporting only. Runs the grader on a corpus, caches its JSON beside it, and
// writes a report. Changes no gate.
//
// Usage:
//   node research/observations/quiet_stretch_depth.mjs \
//        --corpus tmp/loop/quiet-probe \
//        [--oracle research/oracle/relax_minimal_general.json] \
//        [--out research/observations/QUIET_STRETCH_DEPTH.md]
//   node research/observations/quiet_stretch_depth.mjs --selftest
//
// The report file keeps everything above the marker line
// "<!-- generated below -->" and regenerates everything under it.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TA = path.join(ROOT, "traceanalyzer/main");
const MARKER = "<!-- generated below -->";
const DEPTHS = [4, 5, 6, 7, 8];
/// A cut is only reported as a candidate when this share of runs lies above it;
/// a cut that fires on a handful of runs reclaims no budget whatever it shows.
const MIN_SHARE_ABOVE = 0.05;
/// The conditional rate above a cut has to fall this far below the overall rate
/// for the cut to separate at all.
const SEPARATION_FACTOR = 5;

export function wilson(k, n, z = 1.96) {
  if (n === 0) return { p: 0, lo: 0, hi: 0 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, lo: (c - h) / d, hi: (c + h) / d };
}

/** The value at quantile `q` of an ascending-sortable sample. */
export function quantile(values, q) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
}

/** Log2 bucket of n: 0, 1, 2, 3-4, 5-8, ... matching the util_stats histogram. */
export function bucket(n) {
  if (n <= 2) return n;
  return 32 - Math.clz32(n - 1) + 1;
}

export const BUCKET_LABELS = ["0", "1", "2", "3-4", "5-8", "9-16", "17-32", "33-64", "65-128", "129-256", "257-512", "513-1024", "1025-2048", "2049-4096", "4097-8192", "8193+"];

function label(b) {
  return BUCKET_LABELS[Math.min(b, BUCKET_LABELS.length - 1)];
}

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

function readUtilization(dir) {
  for (const p of [path.join(dir, "utilization.json"), `${dir}.utilization.json`]) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  throw new Error(`no utilization.json for ${dir}`);
}

function load(dir, oracle) {
  const abs = path.resolve(ROOT, dir);
  const util = readUtilization(abs);
  const rows = util.quiet_stretch?.per_run ?? [];
  if (rows.length === 0) throw new Error("utilization.json carries no quiet_stretch rows: run the corpus with quiet_stretch_telemetry on");
  const grade = cached(`${abs}.quiet.grade.json`, () =>
    tool(TA, ["-input", abs, "-grade", "-dag-config", path.resolve(ROOT, oracle), "-grade-budget-ms", "0", "-grade-max-runs", "0", "-grade-run-depths", "-format", "json"], [0]));
  const depth = new Map((findKey(grade, "run_depths") ?? []).map(([id, d]) => [Number(id), Number(d)]));
  const joined = rows
    .filter((r) => depth.has(Number(r.run_id)))
    .map((r) => ({ stretch: r.longest_quiet_stretch, deliveries: r.deliveries, depth: depth.get(Number(r.run_id)) }));
  return { util, rows, joined, dropped: util.quiet_stretch.per_run_dropped ?? 0 };
}

function byBucketTable(joined) {
  const out = [];
  const groups = new Map();
  for (const r of joined) {
    const b = bucket(r.stretch);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(r);
  }
  out.push(`| longest quiet stretch | runs | ${DEPTHS.map((k) => `P(depth>=${k})`).join(" | ")} | mean deliveries |`);
  out.push(`|---|---|${DEPTHS.map(() => "---|").join("")}---|`);
  for (const b of [...groups.keys()].sort((a, b2) => a - b2)) {
    const g = groups.get(b);
    const cells = DEPTHS.map((k) => {
      const hit = g.filter((r) => r.depth >= k).length;
      const w = wilson(hit, g.length);
      return `${w.p.toFixed(4)} [${w.lo.toFixed(4)}, ${w.hi.toFixed(4)}] (${hit})`;
    });
    const meanDeliveries = g.reduce((s, r) => s + r.deliveries, 0) / g.length;
    out.push(`| ${label(b)} | ${g.length} | ${cells.join(" | ")} | ${meanDeliveries.toFixed(1)} |`);
  }
  return out;
}

/** For each quantile cut, the depth>=6 rate among the runs above it. */
export function cutScan(joined, k = 6) {
  const stretches = joined.map((r) => r.stretch);
  const overall = joined.filter((r) => r.depth >= k).length / Math.max(1, joined.length);
  const cuts = [];
  for (const q of [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99]) {
    const c = quantile(stretches, q);
    const above = joined.filter((r) => r.stretch > c);
    if (above.length === 0) continue;
    const hit = above.filter((r) => r.depth >= k).length;
    const w = wilson(hit, above.length);
    cuts.push({
      q,
      cut: c,
      above: above.length,
      share: above.length / joined.length,
      hit,
      rate: w.p,
      hi: w.hi,
      separates: above.length / joined.length >= MIN_SHARE_ABOVE && w.hi < overall / SEPARATION_FACTOR,
    });
  }
  return { overall, cuts };
}

function report(dir, oracle, data) {
  const { joined, rows, dropped } = data;
  const out = [];
  out.push("");
  out.push(`## \`${dir}\` graded against \`${oracle}\``);
  out.push("");
  out.push(`${rows.length} runs with a quiet-stretch row, ${joined.length} of them graded, ${dropped} rows dropped at the cap.`);
  out.push("");
  out.push(...byBucketTable(joined));
  out.push("");
  const scan = cutScan(joined);
  out.push(`### Cut scan, depth>=6 (overall ${scan.overall.toFixed(5)})`);
  out.push("");
  out.push("| quantile | stretch cut | runs above | share | depth>=6 above | rate | 95% hi | separates |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const c of scan.cuts) {
    out.push(`| ${c.q} | ${c.cut} | ${c.above} | ${c.share.toFixed(3)} | ${c.hit} | ${c.rate.toFixed(5)} | ${c.hi.toFixed(5)} | ${c.separates ? "yes" : "no"} |`);
  }
  out.push("");
  const any = scan.cuts.some((c) => c.separates);
  out.push(any
    ? "**A separating cut exists.** A run past it reaches depth>=6 at a rate the interval puts well under the corpus rate, over a share of runs large enough to reclaim budget from."
    : "**No separating cut.** Depth does not vanish above any quiet stretch that covers enough runs to matter, so ending a run because it has gone quiet discards runs that were still producing.");
  out.push("");
  out.push(`Generated by \`research/observations/quiet_stretch_depth.mjs\`.`);
  return out.join("\n");
}

function selftest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  };
  eq([0, 1, 2, 3, 4, 5, 6].map(bucket), [0, 1, 2, 3, 3, 4, 4], "log2 buckets match the histogram");
  eq(bucket(8), 4, "8 is the top of the 5-8 bucket");
  eq(bucket(9), 5, "9 opens the 9-16 bucket");
  eq(quantile([1, 2, 3, 4, 5], 0.5), 3, "median");
  eq(wilson(0, 100).p, 0, "no hits is a zero rate");
  const joined = [];
  for (let i = 0; i < 100; i++) joined.push({ stretch: i, deliveries: 10, depth: i < 50 ? 6 : 0 });
  const { overall, cuts } = cutScan(joined);
  eq(overall, 0.5, "half the runs are deep");
  eq(cuts.filter((c) => c.separates).length > 0, true, "a corpus whose depth is all below the median separates");
  console.log("ok");
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) return selftest();
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const corpus = arg("corpus");
  if (!corpus) throw new Error("--corpus <output dir> is required");
  const oracle = arg("oracle", "research/oracle/relax_minimal_general.json");
  const outPath = path.resolve(ROOT, arg("out", "research/observations/QUIET_STRETCH_DEPTH.md"));
  const body = report(corpus, oracle, load(corpus, oracle));
  const head = existsSync(outPath) ? readFileSync(outPath, "utf8").split(MARKER)[0] : `# Prefix depth by quiet stretch\n\n`;
  writeFileSync(outPath, `${head}${MARKER}\n${body}\n`);
  console.log(`wrote ${outPath}`);
}

main();
