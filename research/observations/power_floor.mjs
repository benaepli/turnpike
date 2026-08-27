#!/usr/bin/env node
// Between-seed dispersion of the prefix-depth buckets, measured on archived
// evaluation records.
//
// The acceptance gates model a bucket count as binomial in the number of
// graded runs, so the only noise they charge for is within-session sampling.
// Two sessions of the same binary and the same config differ by more than
// that: they differ by seed, and a seed changes which schedules are explored,
// not just which runs happen to land. This script measures the size of that
// extra spread per bucket and reports the deepest bucket whose spread is
// still smaller than the treatment effect a hypothesis is expected to have.
// Buckets below that line cannot distinguish a real effect from a seed swap,
// so a verdict resting on them is not evidence.
//
// Reporting only. Reads archived records, writes a report, changes no gate.
//
// Usage:
//   node research/observations/power_floor.mjs [--effect 0.5] [--z 2.7]
//        [--session N] [--fidelity sequential|any]
//        [--out research/observations/POWER_FLOOR.md]
//   node research/observations/power_floor.mjs --selftest

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RECORDS_DIR = path.join(ROOT, "research/evaluations");
const BUCKETS = [4, 5, 6, 7, 8];
const DEEPEST_BUCKET = BUCKETS[BUCKETS.length - 1];

// The z the merge gate separates at, and the relative effect a hypothesis is
// expected to produce when it works. Both are defaults, overridable on the
// command line, and neither is read by any gate.
const DEFAULT_Z = 2.7;
const DEFAULT_EFFECT = 0.5;

// Effects the floor is also reported at, so a reader can see how far the
// answer depends on how large an effect is held plausible.
const SENSITIVITY_EFFECTS = [0.25, 0.5, 1.0];

// Pearson's chi-square is only trustworthy when every cell has a few expected
// events; sparser families are counted and reported rather than folded in.
const MIN_EXPECTED_PER_SEED = 5;

// ---------------------------------------------------------------------------
// Record loading
// ---------------------------------------------------------------------------

function jsonFilesUnder(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsonFilesUnder(p));
    else if (name.endsWith(".json")) out.push(p);
  }
  return out.sort();
}

function isEvaluation(v) {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    typeof v.seed === "number" &&
    v.metrics !== null &&
    typeof v.metrics === "object" &&
    Array.isArray(v.metrics.depthAtLeast) &&
    typeof v.metrics.gradedRuns === "number"
  );
}

// Evaluations sit at different depths in different record shapes, so the whole
// tree is walked instead of naming the containers that hold them.
function collectEvaluations(node, sink) {
  if (Array.isArray(node)) {
    for (const child of node) collectEvaluations(child, sink);
    return;
  }
  if (node === null || typeof node !== "object") return;
  if (isEvaluation(node)) sink.push(node);
  for (const child of Object.values(node)) collectEvaluations(child, sink);
}

export function loadRecords(dir, fidelity) {
  const found = [];
  for (const file of jsonFilesUnder(dir)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    collectEvaluations(parsed, found);
  }
  const byId = new Map();
  const anonymous = [];
  for (const e of found) {
    if (typeof e.id === "string" && e.id.length > 0) byId.set(e.id, e);
    else anonymous.push(e);
  }
  return [...byId.values(), ...anonymous]
    .filter((e) => e.ok !== false && e.metrics.gradedRuns > 0)
    .filter((e) => fidelity === "any" || e.fidelity === fidelity);
}

// Replicates: same binary, same config, same grader, same fidelity - differing
// only in seed. Anything else in a family would confound the spread being
// measured with a real change.
export function familyKey(e) {
  return [
    e.hypothesisId ?? "?",
    e.fidelity ?? "?",
    e.spurCommit ?? "?",
    e.superCommit ?? "?",
    e.configPath ?? "?",
    e.spec ?? "?",
    e.graderVersion ?? "?",
  ].join("|");
}

/**
 * A ladder shorter than the bucket range was graded against a different oracle
 * graph, and its rates are on a different scale entirely - pooling them would
 * corrupt every rate in the table. A family qualifies when at least one of its
 * seeds reported the full range; within such a family a shorter array is
 * ordinary truncation at the deepest depth that run set reached, and the
 * missing entries are true zeros.
 */
export function familyCoversLadder(members) {
  return members.some((e) => e.metrics.depthAtLeast.length >= DEEPEST_BUCKET);
}

export function groupBySeedFamily(evals) {
  const families = new Map();
  for (const e of evals) {
    const k = familyKey(e);
    if (!families.has(k)) families.set(k, []);
    families.get(k).push(e);
  }
  const all = [...families.entries()]
    .map(([key, members]) => ({ key, members }))
    // A single-seed family carries no information about seed-to-seed spread.
    .filter((g) => g.members.length >= 2);
  return {
    families: all.filter((g) => familyCoversLadder(g.members)),
    shortLadder: all.filter((g) => !familyCoversLadder(g.members)),
  };
}

// ---------------------------------------------------------------------------
// Dispersion
// ---------------------------------------------------------------------------

export function bucketCount(metrics, k) {
  return metrics.depthAtLeast[k - 1] ?? 0;
}

/**
 * Pearson dispersion of one replicate family for one bucket: the observed
 * scatter of the per-seed rates divided by the scatter binomial sampling alone
 * would produce. 1 means the gates' noise model is right; above 1 means a seed
 * swap moves the bucket more than sampling does; below 1 means the seeds
 * resemble each other more than independent draws would.
 */
export function familyDispersion(counts, exposures) {
  const totalCount = counts.reduce((a, b) => a + b, 0);
  const totalExposure = exposures.reduce((a, b) => a + b, 0);
  if (totalExposure <= 0) return null;
  const p = totalCount / totalExposure;
  if (p <= 0 || p >= 1) return null;
  let chi2 = 0;
  for (let i = 0; i < counts.length; i++) {
    const expected = exposures[i] * p;
    if (expected < MIN_EXPECTED_PER_SEED) return null;
    chi2 += ((counts[i] - expected) ** 2) / (expected * (1 - p));
  }
  return { chi2, df: counts.length - 1, pooledRate: p, totalCount, totalExposure };
}

/** Largest ratio between two seeds in the same family (null when a seed is 0). */
export function familySwing(counts) {
  const lo = Math.min(...counts);
  const hi = Math.max(...counts);
  return lo > 0 ? hi / lo : null;
}

/**
 * Smallest relative effect a two-session comparison could separate at z, given
 * a bucket rate p over `session` graded runs and dispersion `phi`. Delta-method
 * standard error of a log rate, doubled for comparing two independent arms.
 */
export function minimumDetectableEffect(p, session, phi, z) {
  if (p <= 0 || p >= 1 || session <= 0) return Infinity;
  const relVariance = (phi * (1 - p)) / (p * session);
  return z * Math.sqrt(2 * relVariance);
}

function median(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Per-bucket summary over every replicate family. `session` is the run count a
 * single evaluation session spends, so the reported effects are the ones the
 * loop could actually resolve with one session per arm.
 */
export function bucketPower(families, opts) {
  const rows = [];
  for (const k of BUCKETS) {
    let chi2 = 0;
    let df = 0;
    let used = 0;
    let sparse = 0;
    let totalCount = 0;
    let totalExposure = 0;
    const swings = [];
    for (const g of families) {
      const counts = g.members.map((e) => bucketCount(e.metrics, k));
      const exposures = g.members.map((e) => e.metrics.gradedRuns);
      totalCount += counts.reduce((a, b) => a + b, 0);
      totalExposure += exposures.reduce((a, b) => a + b, 0);
      const swing = familySwing(counts);
      if (swing !== null) swings.push(swing);
      const d = familyDispersion(counts, exposures);
      if (d === null) {
        sparse++;
        continue;
      }
      chi2 += d.chi2;
      df += d.df;
      used++;
    }
    const pooledRate = totalExposure > 0 ? totalCount / totalExposure : 0;
    const dispersion = df > 0 ? chi2 / df : null;
    const mdrePoisson = minimumDetectableEffect(pooledRate, opts.session, 1, opts.z);
    // With no usable dispersion estimate the bucket is charged the gates' own
    // assumption, which is the most favourable reading it can get; a bucket
    // that fails even then fails for a reason more sampling does not fix.
    const mdreObserved = minimumDetectableEffect(pooledRate, opts.session, dispersion ?? 1, opts.z);
    // The gates build binomial intervals and cannot exploit seeds that agree
    // more closely than independent draws, so dispersion below 1 is margin
    // rather than power, and the binomial number stands as the floor.
    const mdre = Math.max(mdrePoisson, mdreObserved);
    rows.push({
      k,
      familiesUsed: used,
      familiesSparse: sparse,
      pooledRate,
      perSession: pooledRate * opts.session,
      dispersion,
      medianSwing: swings.length ? median(swings) : null,
      maxSwing: swings.length ? Math.max(...swings) : null,
      mdre,
      mdrePoisson,
      mdreObserved,
      // A bucket is powered when an effect of the size hypotheses are expected
      // to have would show above the spread two seeds already produce, and
      // when the dispersion behind that claim was measurable at all.
      powered: dispersion !== null && mdre <= opts.effect,
    });
  }
  return rows;
}

export function powerFloor(rows, effect) {
  let floor = null;
  for (const r of rows) {
    const powered = effect === undefined ? r.powered : r.dispersion !== null && r.mdre <= effect;
    if (powered) floor = r.k;
  }
  return floor;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function pct(x) {
  return Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "n/a";
}

function num(x, digits) {
  return x === null || !Number.isFinite(x) ? "n/a" : x.toFixed(digits);
}

export function renderReport(rows, meta) {
  const floor = powerFloor(rows);
  const lines = [];
  lines.push("# Depth-bucket power floor");
  lines.push("");
  lines.push(
    "Between-seed spread of each prefix-depth bucket, measured on archived " +
      "evaluation records. Replicates are evaluations that share hypothesis, " +
      "fidelity, both commits, config, spec and grader version, and differ " +
      "only in seed.",
  );
  lines.push("");
  lines.push(`- records: ${meta.records} evaluations in ${meta.families} same-arm seed families`);
  lines.push(`- fidelity: ${meta.fidelity}`);
  lines.push(`- session size: ${meta.session} graded runs per arm`);
  lines.push(`- separation z: ${meta.z}`);
  lines.push(`- treatment effect held plausible: +${pct(meta.effect)} relative`);
  lines.push(
    `- families dropped for a ladder shorter than depth>=${DEEPEST_BUCKET} ` +
      `(graded against a different oracle graph): ${meta.shortLadder}`,
  );
  lines.push("");
  lines.push(
    "| bucket | pooled rate | events/session | families | dispersion | median seed swing | max seed swing | resolvable effect | binomial-only | dispersion-charged | powered |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of rows) {
    lines.push(
      `| depth>=${r.k} | ${r.pooledRate.toExponential(2)} | ${r.perSession.toFixed(1)} | ` +
        `${r.familiesUsed} used, ${r.familiesSparse} too sparse | ${num(r.dispersion, 2)} | ` +
        `${num(r.medianSwing, 2)}x | ${num(r.maxSwing, 2)}x | ${pct(r.mdre)} | ` +
        `${pct(r.mdrePoisson)} | ${pct(r.mdreObserved)} | ${r.powered ? "yes" : "no"} |`,
    );
  }
  lines.push("");
  lines.push("## Reading");
  lines.push("");
  lines.push(
    "`dispersion` is observed between-seed variance over the variance binomial " +
      "sampling alone would give. 1 means a seed swap costs nothing beyond " +
      "sampling; above 1 means the gates understate the noise by that factor; " +
      "below 1 means two seeds of the same binary agree more closely than " +
      "independent draws would. `resolvable effect` is the smallest relative " +
      "change one session per arm could separate at the stated z, and it is the " +
      "larger of the two columns beside it: the gates compute binomial " +
      "intervals, so dispersion under 1 is margin they cannot spend, while " +
      "dispersion over 1 is noise they failed to charge. A bucket whose " +
      "families are all too sparse to score has no dispersion estimate, which " +
      "is itself the finding: its counts are single digits.",
  );
  lines.push("");
  lines.push("## Power floor");
  lines.push("");
  if (floor === null) {
    lines.push(
      "No bucket clears the bar at this session size. Either the records do " +
        "not yet contain enough same-arm seed families, or the effect held " +
        "plausible is smaller than the noise on every bucket.",
    );
  } else {
    lines.push(
      `**depth>=${floor} is the deepest bucket with power at ${meta.session} runs per arm, ` +
        `against a +${pct(meta.effect)} effect.**`,
    );
    lines.push("");
    lines.push(
      "Buckets deeper than that are worth recording - a rare event is still an " +
        "event - but a verdict must not rest on them. A difference there is " +
        "inside the range two seeds of the same binary already produce, so " +
        "accepting or rejecting on it decides by coin flip, and the decision is " +
        "unreproducible by construction.",
    );
  }
  lines.push("");
  lines.push("### Sensitivity to the effect held plausible");
  lines.push("");
  lines.push("| plausible effect | power floor |");
  lines.push("| --- | --- |");
  for (const e of SENSITIVITY_EFFECTS) {
    const f = powerFloor(rows, e);
    lines.push(`| +${pct(e)} | ${f === null ? "none" : `depth>=${f}`} |`);
  }
  lines.push("");
  lines.push("## Objective definition note");
  lines.push("");
  lines.push(
    "The objective is violations first, then P(prefix depth >= k), then the " +
      "stale-incarnation hazard rate. This measurement bounds the second term: " +
      `only buckets up to depth>=${floor ?? "?"} carry decision weight at the ` +
      "current session size and the effect held plausible. Deeper buckets stay " +
      "in the record, stay in the reported deltas, and stay as escalation " +
      "triggers when they fire against a baseline that never reaches them, but " +
      "they are not gradients, and a gain on one of them alone is not an " +
      "improvement.",
  );
  lines.push("");
  lines.push(
    "Regenerate with `node research/observations/power_floor.mjs --out " +
      "research/observations/POWER_FLOOR.md`. The floor moves when session size " +
      "or the archived record set changes, so it is a measurement to repeat, " +
      "not a constant to memorise.",
  );
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

export function selfTest() {
  const failures = [];
  const check = (cond, msg) => {
    if (!cond) failures.push(msg);
  };

  const identical = familyDispersion([100, 100], [10000, 10000]);
  check(identical !== null && Math.abs(identical.chi2) < 1e-9, "identical seeds should give chi2 0");
  check(identical !== null && identical.df === 1, "two seeds give one degree of freedom");

  // Counts placed d either side of the mean have a closed-form chi-square,
  // which pins the formula rather than only its sign.
  const n = 10000;
  const p = 0.01;
  const d = 20;
  const split = familyDispersion([p * n + d, p * n - d], [n, n]);
  const expected = (2 * d * d) / (n * p * (1 - p));
  check(split !== null && Math.abs(split.chi2 - expected) < 1e-6, `split chi2 ${split?.chi2} != ${expected}`);

  check(familyDispersion([1, 5], [10000, 10000]) === null, "sparse families must not be scored");
  check(familyDispersion([0, 0], [10000, 10000]) === null, "empty buckets have no rate");

  check(Math.abs(familySwing([1, 5]) - 5) < 1e-9, "swing of 1 vs 5 is 5x");
  check(familySwing([0, 5]) === null, "swing against a zero seed is undefined");

  const wide = minimumDetectableEffect(0.001, 54000, 1, 2.7);
  const narrow = minimumDetectableEffect(0.1, 54000, 1, 2.7);
  check(narrow < wide, "rarer buckets must need a larger effect");
  check(
    minimumDetectableEffect(0.01, 54000, 4, 2.7) > minimumDetectableEffect(0.01, 54000, 1, 2.7),
    "dispersion above 1 must widen the resolvable effect",
  );
  check(
    minimumDetectableEffect(0.01, 108000, 1, 2.7) < minimumDetectableEffect(0.01, 54000, 1, 2.7),
    "more runs must shrink the resolvable effect",
  );

  const rows = [
    { k: 4, powered: true, dispersion: 0.5, mdre: 0.02 },
    { k: 5, powered: true, dispersion: 0.6, mdre: 0.05 },
    { k: 6, powered: false, dispersion: 0.7, mdre: 0.4 },
    { k: 7, powered: false, dispersion: null, mdre: 0.4 },
    { k: 8, powered: false, dispersion: null, mdre: 2.1 },
  ];
  check(powerFloor(rows) === 5, "floor is the deepest powered bucket");
  check(powerFloor(rows, 0.5) === 6, "a larger plausible effect can lower the floor");
  check(powerFloor(rows, 0.01) === null, "no powered bucket gives no floor");
  check(powerFloor(rows, 3) === 6, "a bucket with no dispersion estimate is never powered");

  // Grouping must not pool arms that differ by anything but seed.
  const full = [10, 9, 8, 7, 6, 5, 4, 3];
  const base = {
    hypothesisId: "h", fidelity: "sequential", spurCommit: "a", superCommit: "b",
    configPath: "c", spec: "s", graderVersion: "g",
    metrics: { gradedRuns: 10, depthAtLeast: full },
  };
  const grouped = groupBySeedFamily([
    { ...base, id: "1", seed: 1000 },
    { ...base, id: "2", seed: 1001 },
    { ...base, id: "3", seed: 1000, spurCommit: "z" },
  ]);
  check(
    grouped.families.length === 1 && grouped.families[0].members.length === 2,
    "a differing commit must split the family",
  );
  check(bucketCount(base.metrics, 8) === 3, "bucket k reads index k-1");

  const short = { ...base, metrics: { gradedRuns: 10, depthAtLeast: [10, 9, 8, 7, 6] } };
  const mixed = groupBySeedFamily([
    { ...short, id: "4", seed: 1000 },
    { ...short, id: "5", seed: 1001 },
  ]);
  check(mixed.families.length === 0 && mixed.shortLadder.length === 1, "a short ladder must be dropped");
  check(
    familyCoversLadder([short, base]) && !familyCoversLadder([short, short]),
    "one seed reaching the deepest bucket qualifies the family",
  );
  check(bucketCount(short.metrics, 8) === 0, "a truncated ladder reads as zero inside a covered family");

  return failures;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    effect: DEFAULT_EFFECT, z: DEFAULT_Z, session: null, out: null,
    fidelity: "sequential", selftest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selftest") opts.selftest = true;
    else if (a === "--effect") opts.effect = Number(argv[++i]);
    else if (a === "--z") opts.z = Number(argv[++i]);
    else if (a === "--session") opts.session = Number(argv[++i]);
    else if (a === "--fidelity") opts.fidelity = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selftest) {
    const failures = selfTest();
    if (failures.length) {
      console.error("power_floor selftest FAILED:");
      for (const f of failures) console.error(`  ${f}`);
      process.exit(1);
    }
    console.log("power_floor selftest ok");
    return;
  }
  const evals = loadRecords(RECORDS_DIR, opts.fidelity);
  if (evals.length === 0) {
    console.error(`no evaluation records under ${RECORDS_DIR}`);
    process.exit(1);
  }
  const { families, shortLadder } = groupBySeedFamily(evals);
  const members = families.flatMap((g) => g.members);
  const session = opts.session ?? median(members.map((e) => e.metrics.gradedRuns));
  const rows = bucketPower(families, { z: opts.z, effect: opts.effect, session });
  const report = renderReport(rows, {
    records: members.length,
    families: families.length,
    shortLadder: shortLadder.length,
    fidelity: opts.fidelity,
    session,
    z: opts.z,
    effect: opts.effect,
  });
  if (opts.out) {
    const target = path.isAbsolute(opts.out) ? opts.out : path.join(ROOT, opts.out);
    writeFileSync(target, report);
    console.log(`wrote ${target}`);
  }
  console.log(report);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
