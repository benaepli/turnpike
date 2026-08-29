#!/usr/bin/env node
// Between-seed noise floor of the metrics the merge gate compares.
//
// The gate records an objectiveDelta per metric and separates on it. Each
// delta is a difference between two arms that differ in the binary and in the
// seeds their chunks ran at, so part of every delta is the seed. This script
// measures that part, in the same units the gate uses:
//
//   depth>=k    relative change in events per explore-second
//   h1..h3      absolute change in the per-run hazard rate
//   throughput  relative change in runs per second
//
// The result is a smallest-resolvable delta per metric. A recorded delta below
// it is inside the spread two seeds of one binary already produce, so the
// verdict that rests on it is a coin flip.
//
// Reporting only. Reads records, optionally runs unmodified sessions, writes a
// report; changes no gate and no simulator.
//
// Usage:
//   node research/observations/eval_noise_floor.mjs [--z 2.7] [--chunks 2]
//        [--all-families] [--out research/observations/EVAL_NOISE_FLOOR.md]
//   node research/observations/eval_noise_floor.mjs --run [--seeds 1000-1005]
//        [--budget-sec 300] [--runs-per-config 4000] [--threads 30]
//   node research/observations/eval_noise_floor.mjs --selftest

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, openSync, closeSync, readdirSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { loadRecords, groupBySeedFamily } from "./power_floor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RECORDS_DIR = path.join(ROOT, "research/evaluations");
const SEED_FILE = path.join(ROOT, "research/observations/eval_noise_floor_seeds.json");

// The z the merge gate separates at, and the number of chunks one arm of the
// sequential lane spends before a verdict is allowed.
const DEFAULT_Z = 2.7;
const DEFAULT_CHUNKS = 2;

// A family of one seed says nothing about seed-to-seed spread, and a variance
// over two seeds is itself noisy; both are kept, weighted by their degrees of
// freedom.
const MIN_FAMILY_SEEDS = 2;

// ---------------------------------------------------------------------------
// Metrics, in the units the gate compares them in
// ---------------------------------------------------------------------------

// Exposure is the explorer's own active time. Records written before the
// session account was stored carry it only through the throughput they
// reported, which reconstructs it exactly.
export function exposureSec(m) {
  if (typeof m.exposureMs === "number" && m.exposureMs > 0) return m.exposureMs / 1000;
  if (m.runsPerSec > 0 && m.runs > 0) return m.runs / m.runsPerSec;
  return 0;
}

function depthCount(m, k) {
  return m.depthAtLeast[k - 1] ?? 0;
}

// `unit` is how the gate writes this metric's delta: "relative" for a ratio
// minus one, "absolute" for a difference of rates. `events` is the count the
// metric is built from, which sets how much of its spread pure sampling can
// account for; a level with no underlying count reports none.
export const METRICS = [
  ...[4, 5, 6, 7, 8].map((k) => ({
    key: `depth>=${k}`,
    unit: "relative",
    value: (m) => (exposureSec(m) > 0 ? depthCount(m, k) / exposureSec(m) : 0),
    events: (m) => depthCount(m, k),
  })),
  { key: "h1", unit: "absolute", value: (m) => m.h1Rate, events: (m) => Math.round(m.h1Rate * m.runs) },
  { key: "h2", unit: "absolute", value: (m) => m.h2Rate, events: (m) => Math.round(m.h2Rate * m.runs) },
  { key: "h2b", unit: "absolute", value: (m) => m.h2bRate, events: (m) => Math.round(m.h2bRate * m.runs) },
  { key: "h3", unit: "absolute", value: (m) => m.h3Rate, events: (m) => Math.round(m.h3Rate * m.runs) },
  { key: "meanPrefixDepth", unit: "absolute", value: (m) => m.meanPrefixDepth, events: () => null },
  { key: "throughput", unit: "relative", value: (m) => m.runsPerSec, events: () => null },
];

// ---------------------------------------------------------------------------
// Spread
// ---------------------------------------------------------------------------

export function mean(xs) {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Unbiased sample variance, and its degrees of freedom. */
export function sampleVariance(xs) {
  if (xs.length < 2) return { variance: 0, df: 0 };
  const mu = mean(xs);
  const ss = xs.reduce((a, x) => a + (x - mu) ** 2, 0);
  return { variance: ss / (xs.length - 1), df: xs.length - 1 };
}

/**
 * Pooled per-seed spread of one metric over replicate families. Families sit
 * at different levels - a family is a different binary - so each contributes
 * its own coefficient of variation, and the levels are pooled separately.
 * Weighting by degrees of freedom lets a six-seed family count for five times
 * what a two-seed family does.
 */
export function pooledSpread(families, metric) {
  let weightedRelVar = 0;
  let weightedAbsVar = 0;
  let df = 0;
  let levelSum = 0;
  let levelWeight = 0;
  let seeds = 0;
  let used = 0;
  const swings = [];
  for (const g of families) {
    const xs = g.members.map((e) => metric.value(e.metrics)).filter((x) => Number.isFinite(x));
    if (xs.length < MIN_FAMILY_SEEDS) continue;
    const mu = mean(xs);
    if (mu <= 0) continue;
    const { variance, df: d } = sampleVariance(xs);
    weightedAbsVar += d * variance;
    weightedRelVar += d * (variance / (mu * mu));
    df += d;
    levelSum += xs.length * mu;
    levelWeight += xs.length;
    seeds += xs.length;
    used++;
    const lo = Math.min(...xs);
    if (lo > 0) swings.push(Math.max(...xs) / lo);
  }
  if (df === 0) return null;
  return {
    families: used,
    seeds,
    level: levelSum / levelWeight,
    sdAbsolute: Math.sqrt(weightedAbsVar / df),
    sdRelative: Math.sqrt(weightedRelVar / df),
    df,
    maxSwing: swings.length ? Math.max(...swings) : null,
  };
}

/**
 * Observed variance over the variance within-session sampling alone would
 * give. The gate charges sampling noise only, so a ratio above 1 is noise it
 * does not see, and below 1 is margin it cannot spend.
 */
export function dispersion(families, metric) {
  let ratioSum = 0;
  let n = 0;
  for (const g of families) {
    const xs = g.members.map((e) => metric.value(e.metrics));
    const counts = g.members.map((e) => metric.events(e.metrics));
    if (counts.some((c) => c === null || c < 5)) continue;
    const mu = mean(xs);
    if (mu <= 0) continue;
    const { variance } = sampleVariance(xs);
    // Relative variance a Poisson count of this size would give, carried onto
    // the metric's own scale.
    const poissonRelVar = mean(counts.map((c) => 1 / c));
    if (poissonRelVar <= 0) continue;
    ratioSum += (variance / (mu * mu)) / poissonRelVar;
    n++;
  }
  return n === 0 ? null : { ratio: ratioSum / n, families: n };
}

/**
 * The spread of a delta between two arms, each pooling `chunks` seeds. Pooling
 * m seeds divides the variance of an arm's rate by m, and a delta is a
 * difference of two independent arms, so the delta's spread is the per-seed
 * spread times sqrt(2/m) - which at two chunks per arm is the per-seed spread
 * itself.
 */
export function deltaSd(sdPerSeed, chunks) {
  return chunks > 0 ? sdPerSeed * Math.sqrt(2 / chunks) : Infinity;
}

// ---------------------------------------------------------------------------
// Re-grading archived decisions
// ---------------------------------------------------------------------------

// A decision the floors can speak to came from the sequential lane and carries
// the explorer's own exposure: without a sequential chunk the deltas are a
// bench result on a different scale, and without exposure they are the earlier
// per-run objective.
export function decidedOnSequentialRates(record) {
  const evals = [];
  collectEvals(record, evals);
  const seq = evals.filter((e) => e.fidelity === "sequential");
  return seq.length > 0 && seq.every((e) => typeof e?.metrics?.exposureMs === "number");
}

function collectEvals(node, sink) {
  if (Array.isArray(node)) {
    for (const c of node) collectEvals(c, sink);
    return;
  }
  if (node === null || typeof node !== "object") return;
  if (typeof node.seed === "number" && node.metrics && Array.isArray(node.metrics.depthAtLeast)) sink.push(node);
  for (const c of Object.values(node)) collectEvals(c, sink);
}

/** Deltas the floors can speak to, with a verdict of resolvable or not. */
export function regradeDecision(decision, floors) {
  const rows = [];
  for (const [key, delta] of Object.entries(decision.objectiveDeltas ?? {})) {
    const floor = floors.get(key);
    if (!floor || !Number.isFinite(delta)) continue;
    rows.push({ key, delta, floor: floor.mde, resolvable: Math.abs(delta) >= floor.mde });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Fresh sessions at the sequential fidelity
// ---------------------------------------------------------------------------

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function execFileAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: ROOT, maxBuffer: 512 * 1024 * 1024, encoding: "utf8", ...opts }, (err, stdout, stderr) => {
      resolve({ ok: err === null, stdout, stderr: stderr ?? "" });
    });
  });
}

function exploreOnce({ binary, configPath, spec, outputDir, budgetSec, threads, wallSec }) {
  const logPath = `${outputDir}.log`;
  const args = ["explore", "-e", "campaign", "--config", configPath, "-y", "--output-dir", outputDir,
    "--set", `campaign.wall_budget_sec=${budgetSec}`, spec];
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const fd = openSync(logPath, "w");
    const child = spawn(binary, args, {
      cwd: ROOT,
      env: { ...process.env, RAYON_NUM_THREADS: String(threads), RUST_LOG: "info" },
      stdio: ["ignore", fd, fd],
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, (wallSec + 60) * 1000);
    child.on("error", (e) => { clearTimeout(timer); closeSync(fd); reject(e); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      closeSync(fd);
      resolve({ ok: code === 0 && !timedOut, wallMs: Date.now() - started, timedOut });
    });
  });
}

function sessionExposureMs(outputDir, fallbackMs) {
  for (const p of [`${outputDir}.session.json`, path.join(outputDir, "session.json")]) {
    try {
      const s = readJson(p);
      if (typeof s.wall_ms === "number" && s.wall_ms > 0) return s.wall_ms;
    } catch { /* try the next location */ }
  }
  return fallbackMs;
}

/**
 * One unmodified session at one seed, on the config and fidelity the merge
 * gate uses, reduced to the metrics the gate compares. No simulator or config
 * change: the template is materialised exactly as the evaluator materialises
 * it, with only the session seed varying.
 */
export async function runOneSeed(opts) {
  const outputDir = path.join(ROOT, "tmp", "loop", `noise-floor-${opts.seed}`);
  if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const configPath = `${outputDir}.config.json`;
  const template = readJson(path.join(ROOT, opts.configTemplate));
  writeFileSync(configPath, JSON.stringify({
    ...template, num_runs_per_config: opts.runsPerConfig, session_seed: opts.seed,
  }, null, 2) + "\n");

  const ex = await exploreOnce({
    binary: path.join(ROOT, "spur/target/release/spur"),
    configPath, spec: path.join(ROOT, opts.spec), outputDir,
    budgetSec: opts.budgetSec, threads: opts.threads, wallSec: opts.budgetSec,
  });
  const exposure = sessionExposureMs(outputDir, ex.wallMs);

  const porc = await execFileAsync(path.join(ROOT, "porcupine/batch"),
    ["-input", outputDir, "-model", "kv", "-timeout", "3000"]);
  const gr = await execFileAsync(path.join(ROOT, "traceanalyzer/main"),
    ["-input", outputDir, "-grade", "-dag-config", opts.oracleDags.join(","),
      "-grade-max-runs", "0", "-grade-budget-ms", String(opts.gradeBudgetMs), "-format", "json"]);

  let p = null;
  let g = null;
  try { p = JSON.parse(porc.stdout); } catch { /* an unreadable checker report leaves the counts zero */ }
  try { g = JSON.parse(gr.stdout); } catch { /* likewise the grader */ }
  const grade = g?.grade ?? null;
  const hz = grade?.hazards ?? null;
  const dag = g?.grade_dags?.[0] ?? null;
  const runs = p ? Math.round(p.total_runs) : 0;
  const metrics = {
    runs,
    runsPerSec: exposure > 0 ? runs / (exposure / 1000) : 0,
    exposureMs: Math.round(exposure),
    h1Rate: hz?.h1_rate ?? 0,
    h2Rate: hz?.h2_rate ?? 0,
    h2bRate: hz?.h2b_rate ?? 0,
    h3Rate: hz?.h3_rate ?? 0,
    gradedRuns: dag ? Math.round(dag.graded_runs) : 0,
    meanPrefixDepth: dag?.mean_prefix_depth ?? 0,
    depthAtLeast: (dag?.depth_at_least ?? []).map((v) => Math.round(v)),
    violations: p ? Math.round(p.violations) : 0,
  };
  rmSync(outputDir, { recursive: true, force: true });
  for (const sibling of [".config.json", ".session.json", ".utilization.json", ".campaign.json"]) {
    rmSync(`${outputDir}${sibling}`, { force: true });
  }
  // A session killed at its wall still wrote a corpus, and the corpus is what
  // was graded, so only an empty or ungradeable one is a failure.
  return {
    seed: opts.seed, fidelity: "sequential", rayonThreads: opts.threads,
    ok: runs > 0 && metrics.gradedRuns > 0, timedOut: ex.timedOut, metrics,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function fmt(x) {
  if (x === null || !Number.isFinite(x)) return "-";
  const a = Math.abs(x);
  if (a === 0) return "0";
  if (a >= 100) return x.toFixed(1);
  if (a >= 1) return x.toFixed(3);
  if (a >= 1e-3) return x.toFixed(4);
  return x.toExponential(2);
}

function pct(x) {
  if (x === null || !Number.isFinite(x)) return "-";
  return `${(x * 100).toFixed(Math.abs(x) < 0.1 ? 2 : 1)}%`;
}

/** A family named by what distinguishes it: hypothesis, host mask, seeds. */
export function familyLabel(members) {
  const m0 = members[0] ?? {};
  const threads = members.map((e) => e.rayonThreads).find((t) => typeof t === "number");
  const seeds = members.map((e) => e.seed).sort((a, b) => a - b);
  return `${m0.hypothesisId ?? "?"}${threads ? ` @${threads}t` : ""} seeds ${seeds.join(",")}`;
}

/**
 * A family on the current objective has the explorer's own exposure on every
 * session; one without it was graded on per-run rates and its levels belong to
 * a different scale.
 */
export function familyOnCurrentObjective(members) {
  return members.every((e) => typeof e.metrics?.exposureMs === "number");
}

export function buildFloors(spreadRows, z, chunks) {
  const floors = new Map();
  for (const r of spreadRows) {
    if (r.spread === null) continue;
    const sdPerSeed = r.metric.unit === "relative" ? r.spread.sdRelative : r.spread.sdAbsolute;
    floors.set(r.metric.key, { mde: z * deltaSd(sdPerSeed, chunks), sdPerSeed, unit: r.metric.unit });
  }
  return floors;
}

// The metrics the per-family table breaks out; the pooled table carries them all.
const PER_FAMILY_METRICS = ["depth>=4", "depth>=5", "depth>=6", "depth>=7", "depth>=8", "throughput"];

export function perFamilyCvs(families) {
  return families.map((g) => ({
    label: familyLabel(g.members),
    seeds: g.members.length,
    cvs: PER_FAMILY_METRICS.map((key) => {
      const metric = METRICS.find((m) => m.key === key);
      const s = pooledSpread([g], metric);
      return s === null ? null : s.sdRelative;
    }),
  }));
}

function renderReport({ freshRows, archiveRows, perFamily, z, chunks, freshFamily, archiveFamilies, regrades, skippedRecords }) {
  const L = [];
  L.push("# Evaluation noise floor");
  L.push("");
  L.push("Per-seed spread of the metrics the merge gate compares, in the units the gate writes its objectiveDeltas in: a relative change for depth>=k (events per explore-second) and for throughput, an absolute rate difference for the hazards and the mean prefix depth.");
  L.push("");
  L.push(`- separation z: ${z}`);
  L.push(`- chunks per arm: ${chunks}`);
  L.push(`- fresh replicate seeds: ${freshFamily === null ? "none recorded" : `${freshFamily.seeds} (${freshFamily.note})`}`);
  L.push(`- archived replicate families: ${archiveFamilies}`);
  L.push("");
  const table = (rows, caption) => {
    L.push(caption);
    L.push("");
    L.push("| metric | gate unit | level | per-seed sd | per-seed cv | max seed swing | sampling share | smallest resolvable delta |");
    L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of rows) {
      if (r.spread === null) {
        L.push(`| ${r.metric.key} | ${r.metric.unit} | - | - | - | - | - | too few replicate seeds |`);
        continue;
      }
      const sdPerSeed = r.metric.unit === "relative" ? r.spread.sdRelative : r.spread.sdAbsolute;
      const mde = z * deltaSd(sdPerSeed, chunks);
      L.push(`| ${r.metric.key} | ${r.metric.unit} | ${fmt(r.spread.level)} | ${fmt(r.spread.sdAbsolute)} | ${pct(r.spread.sdRelative)} | ${r.spread.maxSwing === null ? "-" : `${r.spread.maxSwing.toFixed(2)}x`} | ${r.disp === null ? "-" : `${r.disp.ratio.toFixed(2)}x`} | ${r.metric.unit === "relative" ? pct(mde) : fmt(mde)} |`);
    }
    L.push("");
  };
  if (freshRows !== null) table(freshRows, "## Fresh sessions, current binary and config");
  table(archiveRows, "## Archived replicate families");
  if (perFamily.length > 0) {
    L.push("## Per family");
    L.push("");
    L.push("The pooled row hides how far families disagree, and a family is also a host mask, which is not part of what makes two sessions replicates.");
    L.push("");
    L.push(`| family | seeds | ${PER_FAMILY_METRICS.join(" | ")} |`);
    L.push(`| --- | --- | ${PER_FAMILY_METRICS.map(() => "---").join(" | ")} |`);
    for (const fam of perFamily) {
      L.push(`| ${fam.label} | ${fam.seeds} | ${fam.cvs.map((c) => (c === null ? "-" : pct(c))).join(" | ")} |`);
    }
    L.push("");
  }
  L.push("## Reading");
  L.push("");
  L.push("`per-seed sd` is the spread of one metric across sessions that differ only in the session seed, pooled over families by degrees of freedom. `sampling share` is the observed variance divided by the variance the metric's own event count would give if every run were an independent draw: above 1 is noise the gate does not charge for, below 1 means two seeds of one binary agree more closely than independent draws would.");
  L.push("");
  L.push("`smallest resolvable delta` is the per-seed spread carried through the pooling the sequential lane does. An arm pooling m chunks divides its variance by m, and a delta is a difference of two arms, so the delta's spread is the per-seed spread times sqrt(2/m). At two chunks per arm that factor is one: **the noise on an objectiveDelta is the per-seed spread of the metric itself**, and the smallest delta the gate can separate from a seed swap is z times it.");
  L.push("");
  L.push("A delta below its floor is not weak evidence of a small effect; it is the size of the difference two seeds of one unchanged binary produce, so its sign carries no information.");
  L.push("");
  if (regrades.length > 0) {
    L.push("## Archived verdicts against the floor");
    L.push("");
    L.push(`Decisions taken by the sequential lane on the current objective. ${skippedRecords} record(s) came from the earlier per-run objective or from a lane with no sequential chunk, and are not comparable.`);
    L.push("");
    L.push("| hypothesis | verdict | resolvable deltas | inside the floor |");
    L.push("| --- | --- | --- | --- |");
    for (const r of regrades) {
      const inside = r.rows.filter((x) => !x.resolvable).map((x) => `${x.key} ${fmt(x.delta)}`);
      const out = r.rows.filter((x) => x.resolvable).map((x) => `${x.key} ${fmt(x.delta)}`);
      L.push(`| ${r.id} | ${r.verdict} | ${out.length ? out.join(", ") : "none"} | ${inside.length ? inside.join(", ") : "none"} |`);
    }
    L.push("");
  }
  L.push("## Method");
  L.push("");
  L.push("A replicate family is a set of evaluations sharing hypothesis, fidelity, both commits, config, spec and grader version, and differing only in seed. Each family contributes its own coefficient of variation, weighted by its degrees of freedom, because families sit at different levels by construction. Level metrics with no underlying event count report no sampling share. Only families whose sessions carry the explorer's own exposure are included, since the rest were graded on the per-run objective and their rates are on a different scale; `--all-families` widens the set at the cost of mixing the two.");
  L.push("");
  L.push("`--run` adds a fresh family: sessions at consecutive seeds on the current binary and the config the evaluator loads, with no code or config change, materialised the way the evaluator materialises them. It is the homogeneous estimate; the archived families corroborate it across binaries.");
  L.push("");
  L.push("Regenerate with `node research/observations/eval_noise_floor.mjs`, and refresh the fresh family with `--run` when the binary or the session budget changes. The floor is a measurement to repeat, not a constant to memorise.");
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function selftest() {
  const f = [];
  const check = (c, m) => { if (!c) f.push(m); };

  const v = sampleVariance([1, 2, 3]);
  check(Math.abs(v.variance - 1) < 1e-12, `sample variance of 1,2,3 is 1, got ${v.variance}`);
  check(v.df === 2, `two degrees of freedom, got ${v.df}`);
  check(sampleVariance([5]).df === 0, "a single value has no degrees of freedom");

  // Two chunks per arm leave the delta's spread equal to the per-seed spread.
  check(Math.abs(deltaSd(0.1, 2) - 0.1) < 1e-12, `two chunks per arm keep the spread, got ${deltaSd(0.1, 2)}`);
  check(deltaSd(0.1, 8) < deltaSd(0.1, 2), "more chunks per arm must shrink the delta's spread");

  // A family with no scatter has no spread; one with scatter reports it on
  // both scales.
  const fam = (vals) => ({ members: vals.map((x) => ({ metrics: { h2Rate: x, runs: 1000 } })) });
  const flat = pooledSpread([fam([0.4, 0.4, 0.4])], METRICS.find((m) => m.key === "h2"));
  check(flat !== null && flat.sdAbsolute === 0, "identical seeds have zero spread");
  const spread = pooledSpread([fam([0.40, 0.42])], METRICS.find((m) => m.key === "h2"));
  check(spread !== null && Math.abs(spread.sdAbsolute - 0.02 / Math.SQRT2) < 1e-9,
    `two seeds 0.02 apart have sd 0.0141, got ${spread?.sdAbsolute}`);
  check(spread.maxSwing !== null && Math.abs(spread.maxSwing - 1.05) < 1e-9, "swing is the ratio of the extremes");

  // Exposure falls back to what the reported throughput implies.
  check(exposureSec({ exposureMs: 2000, runs: 10, runsPerSec: 1 }) === 2, "the session account wins when present");
  check(exposureSec({ runs: 100, runsPerSec: 50 }) === 2, "throughput reconstructs exposure otherwise");

  // A delta at exactly the floor resolves; anything smaller does not.
  const floors = new Map([["h2", { mde: 0.01, sdPerSeed: 0.004, unit: "absolute" }]]);
  const rows = regradeDecision({ objectiveDeltas: { h2: 0.02, "depth>=4": 0.5 } }, floors);
  check(rows.length === 1 && rows[0].resolvable === true, "a delta twice the floor resolves");
  check(regradeDecision({ objectiveDeltas: { h2: 0.001 } }, floors)[0].resolvable === false,
    "a delta a tenth of the floor does not resolve");

  check(familyOnCurrentObjective([{ metrics: { exposureMs: 1 } }, { metrics: { exposureMs: 2 } }]),
    "a family whose sessions carry exposure is on the current objective");
  check(!familyOnCurrentObjective([{ metrics: { exposureMs: 1 } }, { metrics: {} }]),
    "one session without exposure disqualifies the family");
  check(familyLabel([{ hypothesisId: "h", rayonThreads: 30, seed: 1001 }, { hypothesisId: "h", rayonThreads: 30, seed: 1000 }])
    === "h @30t seeds 1000,1001", "a family is labelled by hypothesis, host mask and seeds");

  const seqEval = (metrics) => ({ evaluations: { sequential: [{ seed: 1, fidelity: "sequential", metrics }] } });
  check(decidedOnSequentialRates(seqEval({ depthAtLeast: [1], exposureMs: 5 })),
    "a sequential record carrying exposure is on the current objective");
  check(!decidedOnSequentialRates(seqEval({ depthAtLeast: [1] })),
    "a sequential record without exposure is on the per-run objective");
  check(!decidedOnSequentialRates({ evaluations: { promote: [{ seed: 1, fidelity: "promote", metrics: { depthAtLeast: [1], exposureMs: 5 } }] } }),
    "a record with no sequential chunk was not decided by the sequential lane");

  if (f.length === 0) {
    console.log("eval_noise_floor selftest: ok");
    return 0;
  }
  for (const m of f) console.log(`FAIL ${m}`);
  return 1;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {
    z: DEFAULT_Z, chunks: DEFAULT_CHUNKS, out: path.join(ROOT, "research/observations/EVAL_NOISE_FLOOR.md"),
    run: false, seeds: [1000, 1001, 1002, 1003, 1004, 1005], budgetSec: 300, runsPerConfig: 4000,
    threads: 30, gradeBudgetMs: 1_800_000, selftest: false, allFamilies: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--selftest") o.selftest = true;
    else if (a === "--run") o.run = true;
    else if (a === "--all-families") o.allFamilies = true;
    else if (a === "--z") o.z = Number(next());
    else if (a === "--chunks") o.chunks = Math.round(Number(next()));
    else if (a === "--out") o.out = path.resolve(ROOT, next());
    else if (a === "--budget-sec") o.budgetSec = Number(next());
    else if (a === "--runs-per-config") o.runsPerConfig = Math.round(Number(next()));
    else if (a === "--threads") o.threads = Math.round(Number(next()));
    else if (a === "--grade-budget-ms") o.gradeBudgetMs = Math.round(Number(next()));
    else if (a === "--seeds") {
      const spec = next();
      const m = /^(\d+)-(\d+)$/.exec(spec);
      o.seeds = m
        ? Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, j) => Number(m[1]) + j)
        : spec.split(",").map((s) => Number(s.trim()));
    }
  }
  return o;
}

/** Every evaluation record, paired with its file name. */
function readJsonFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try { out.push({ name, value: readJson(path.join(dir, name)) }); } catch { /* unreadable records are skipped */ }
  }
  return out;
}

function loadSeedFile() {
  try {
    const raw = readJson(SEED_FILE);
    return Array.isArray(raw.seeds) ? raw : null;
  } catch {
    return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selftest) {
    process.exit(selftest());
  }

  if (opts.run) {
    const policy = readJson(path.join(ROOT, "research/policy.json"));
    const results = [];
    for (const seed of opts.seeds) {
      const started = Date.now();
      const r = await runOneSeed({
        seed,
        configTemplate: policy.evaluation.configTemplate,
        spec: policy.evaluation.spec,
        oracleDags: policy.evaluation.oracleDags.map((d) => path.join(ROOT, d)),
        budgetSec: opts.budgetSec,
        runsPerConfig: opts.runsPerConfig,
        threads: opts.threads,
        gradeBudgetMs: opts.gradeBudgetMs,
      });
      console.log(`seed ${seed}: ok=${r.ok} runs=${r.metrics.runs} graded=${r.metrics.gradedRuns} `
        + `meanDepth=${r.metrics.meanPrefixDepth.toFixed(3)} rps=${r.metrics.runsPerSec.toFixed(1)} `
        + `viol=${r.metrics.violations} wall=${Math.round((Date.now() - started) / 1000)}s`);
      results.push(r);
    }
    writeFileSync(SEED_FILE, JSON.stringify({
      configTemplate: policy.evaluation.configTemplate,
      spec: policy.evaluation.spec,
      budgetSec: opts.budgetSec,
      runsPerConfig: opts.runsPerConfig,
      threads: opts.threads,
      seeds: results,
    }, null, 2) + "\n");
    console.log(`wrote ${SEED_FILE}`);
  }

  const allFamilies = groupBySeedFamily(loadRecords(RECORDS_DIR, "sequential")).families;
  const archived = opts.allFamilies ? allFamilies : allFamilies.filter((g) => familyOnCurrentObjective(g.members));
  const archiveRows = METRICS.map((metric) => ({
    metric, spread: pooledSpread(archived, metric), disp: dispersion(archived, metric),
  }));

  const seedFile = loadSeedFile();
  const freshMembers = (seedFile?.seeds ?? []).filter((s) => s.ok);
  const freshFamilies = freshMembers.length >= MIN_FAMILY_SEEDS ? [{ members: freshMembers }] : [];
  const freshRows = freshFamilies.length
    ? METRICS.map((metric) => ({ metric, spread: pooledSpread(freshFamilies, metric), disp: dispersion(freshFamilies, metric) }))
    : null;

  const floors = buildFloors(freshRows ?? archiveRows, opts.z, opts.chunks);

  const regrades = [];
  let skippedRecords = 0;
  for (const file of readJsonFiles(RECORDS_DIR)) {
    const rec = file.value;
    const decision = rec?.decision;
    if (!decision || typeof decision !== "object" || !decision.objectiveDeltas) continue;
    if (!decidedOnSequentialRates(rec)) { skippedRecords++; continue; }
    regrades.push({
      id: decision.hypothesisId ?? file.name,
      verdict: decision.verdict ?? "?",
      rows: regradeDecision(decision, floors),
    });
  }

  const report = renderReport({
    freshRows, archiveRows, perFamily: perFamilyCvs(archived), z: opts.z, chunks: opts.chunks,
    freshFamily: freshMembers.length
      ? { seeds: freshMembers.length, note: `budget ${seedFile.budgetSec}s, ${seedFile.configTemplate}` }
      : null,
    archiveFamilies: archived.length, regrades, skippedRecords,
  });
  writeFileSync(opts.out, report);
  console.log(`wrote ${opts.out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
