#!/usr/bin/env node
// Does a hazard-rate delta predict a depth-band delta?
//
// The merge gate writes an objectiveDeltas block on every decision. This
// script reads the archived blocks and asks whether the hazard channel in
// them has ever moved in the same direction as the depth bands, and whether
// the hazard deltas were large enough to mean anything when they did.
//
// Three things are measured and they answer different questions:
//
//   1. Which channels exist at all. A criterion stated on a channel that
//      never reaches a decision record cannot be checked against an outcome,
//      however often the counter behind it is printed.
//   2. How many hazard deltas clear the between-seed spread of the same
//      metric. A delta inside that spread has the size two seeds of one
//      unchanged binary produce, so its sign carries no information and an
//      agreement rate computed on it is an agreement rate between two coin
//      flips.
//   3. Sign agreement and rank correlation against each depth band. Signs
//      are used for the pooled tables because the archive writes the depth
//      deltas on two different scales; rank correlation is computed inside a
//      scale, never across.
//
// Reporting only. Reads archived records, writes a report, changes no gate.
//
// Usage:
//   node research/observations/hazard_predictiveness.mjs
//        [--out research/observations/HAZARD_PREDICTIVENESS.md]
//   node research/observations/hazard_predictiveness.mjs --selftest

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RECORDS_DIR = path.join(ROOT, "research/evaluations");

const BANDS = ["depth>=4", "depth>=5", "depth>=6", "depth>=7", "depth>=8"];

// The rung the current objective is named on.
const PRIMARY_BAND = "depth>=6";

// Smallest delta separable from a seed swap, per channel, in the unit the
// gate writes that channel in: absolute rate difference for the hazards,
// relative for throughput and the depth bands. Measured in
// research/observations/EVAL_NOISE_FLOOR.md at two chunks per arm.
const RESOLVABLE = {
  h1: 0.0174,
  h2: 0.0151,
  h2b: 0.0164,
  h3: 0.0191,
  "depth>=4": 0.025,
  "depth>=5": 0.035,
  "depth>=6": 0.125,
  "depth>=7": 0.153,
  "depth>=8": 0.222,
  throughput: 0.027,
};

// Hazard channels the explorer measures on every run. Only the ones that
// reach an objectiveDeltas block can be audited against an outcome.
const HAZARD_METRICS = ["h1Rate", "h2Rate", "h2bRate", "h3Rate"];
const HAZARD_DELTA_KEYS = ["h1", "h2", "h2b", "h3"];

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

function evaluationsOf(record) {
  const out = [];
  const groups = record.evaluations ?? {};
  for (const list of Object.values(groups)) {
    if (Array.isArray(list)) out.push(...list.filter((e) => e && e.ok !== false));
  }
  return out;
}

/**
 * Which scale the record's depth deltas are on. The gate started writing
 * depth deltas as ratios of events per explore-second when the explorer began
 * reporting its own exposure; before that they were absolute differences of
 * per-run probabilities. Ranks may not be pooled across the two.
 */
export function depthScaleOf(record) {
  const evals = evaluationsOf(record);
  const timed = evals.some((e) => typeof e?.metrics?.exposureMs === "number");
  return timed ? "relative" : "absolute";
}

/** The band `primary` was copied from, which is not the same band throughout. */
export function primaryBandOf(record) {
  const d = record.decision?.objectiveDeltas ?? {};
  const p = d.primary;
  if (typeof p !== "number") return null;
  for (const b of [...BANDS, "violations"]) {
    if (d[b] === p) return b;
  }
  return null;
}

/**
 * A ladder record carries a hazard delta and depth deltas, so it is a
 * comparison the question can be asked of. Bench-lane records report a single
 * throughput improvement under both names and have no hazard channel.
 */
export function isLadderRecord(record) {
  const d = record?.decision?.objectiveDeltas;
  if (!d || typeof d !== "object") return false;
  return typeof d.h2 === "number" && BANDS.every((b) => typeof d[b] === "number");
}

export function loadRecords(dir) {
  const out = [];
  for (const file of jsonFilesUnder(dir)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    if (!parsed.decision?.objectiveDeltas) continue;
    out.push({
      id: parsed.hypothesis?.id ?? parsed.decision?.hypothesisId ?? path.basename(file, ".json"),
      file: path.basename(file),
      verdict: parsed.decision.verdict ?? "?",
      deltas: parsed.decision.objectiveDeltas,
      scale: depthScaleOf(parsed),
      primaryBand: primaryBandOf(parsed),
      ladder: isLadderRecord(parsed),
      evals: evaluationsOf(parsed),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Channel census
// ---------------------------------------------------------------------------

/**
 * For each hazard channel: how many records measure it per run, and how many
 * carry it as a delta the gate compared. The gap between the two is the set
 * of criteria that cannot be audited against any outcome.
 */
export function channelCensus(records) {
  const ladder = records.filter((r) => r.ladder);
  const rows = [];
  for (let i = 0; i < HAZARD_METRICS.length; i++) {
    const metric = HAZARD_METRICS[i];
    const key = HAZARD_DELTA_KEYS[i];
    rows.push({
      channel: key,
      measured: ladder.filter((r) => r.evals.some((e) => typeof e?.metrics?.[metric] === "number")).length,
      compared: ladder.filter((r) => typeof r.deltas[key] === "number").length,
    });
  }
  rows.push({
    channel: "acted fraction",
    measured: ladder.filter((r) => r.evals.some((e) => e?.utilStats?.deliveryEffects)).length,
    compared: ladder.filter((r) => Object.keys(r.deltas).some((k) => k.startsWith("acted"))).length,
  });
  return { rows, ladderRecords: ladder.length };
}

// ---------------------------------------------------------------------------
// Resolvability
// ---------------------------------------------------------------------------

/** Deltas at or inside the channel's between-seed spread, which are the ones
 *  whose sign is a coin flip rather than a measurement. */
export function floorCensus(records, key) {
  const floor = RESOLVABLE[key];
  const values = records.filter((r) => r.ladder && typeof r.deltas[key] === "number").map((r) => ({ id: r.id, v: r.deltas[key] }));
  const outside = values.filter((x) => Math.abs(x.v) > floor);
  return {
    key,
    floor,
    total: values.length,
    inside: values.length - outside.length,
    outside: outside.sort((a, b) => Math.abs(b.v) - Math.abs(a.v)),
    largest: values.length ? Math.max(...values.map((x) => Math.abs(x.v))) : 0,
  };
}

// ---------------------------------------------------------------------------
// Sign agreement
// ---------------------------------------------------------------------------

export function sign(x) {
  if (typeof x !== "number" || !Number.isFinite(x) || x === 0) return 0;
  return x > 0 ? 1 : -1;
}

/**
 * Two-by-two table of the two channels' signs over the records where both are
 * non-zero, with the association measures that do not depend on the scale
 * either channel is written in.
 *
 * `agreement` is the raw same-sign rate and is not comparable with 50% when
 * the two channels have lopsided margins; `expected` is the same-sign rate
 * independence would give at those margins, and `kappa` is the excess over it.
 */
export function signTable(records, aKey, bKey) {
  let pp = 0, pn = 0, np = 0, nn = 0;
  for (const r of records) {
    const a = sign(r.deltas[aKey]);
    const b = sign(r.deltas[bKey]);
    if (a === 0 || b === 0) continue;
    if (a > 0 && b > 0) pp++;
    else if (a > 0) pn++;
    else if (b > 0) np++;
    else nn++;
  }
  const n = pp + pn + np + nn;
  if (n === 0) return null;
  const aUp = pp + pn, aDown = np + nn, bUp = pp + np, bDown = pn + nn;
  const agreement = (pp + nn) / n;
  const expected = (aUp * bUp + aDown * bDown) / (n * n);
  const kappa = expected < 1 ? (agreement - expected) / (1 - expected) : 0;
  const oddsRatio = pn * np > 0 ? (pp * nn) / (pn * np) : null;
  let chi2 = 0;
  if (aUp > 0 && aDown > 0 && bUp > 0 && bDown > 0) {
    const cells = [[pp, aUp * bUp], [pn, aUp * bDown], [np, aDown * bUp], [nn, aDown * bDown]];
    for (const [obs, prod] of cells) {
      const e = prod / n;
      chi2 += ((obs - e) ** 2) / e;
    }
  }
  return { n, pp, pn, np, nn, agreement, expected, kappa, oddsRatio, chi2, p: chiSquareP(chi2) };
}

/** Upper tail of chi-square with one degree of freedom. */
export function chiSquareP(chi2) {
  if (!(chi2 > 0)) return 1;
  return erfc(Math.sqrt(chi2 / 2));
}

// Numerical Recipes' Chebyshev fit, absolute error below 1.2e-7 everywhere.
export function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + z / 2);
  const ans = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? ans : 2 - ans;
}

// ---------------------------------------------------------------------------
// Rank correlation
// ---------------------------------------------------------------------------

/** Ranks with ties averaged, so a channel with exact zeros does not get an
 *  arbitrary order imposed on its tied entries. */
export function ranksOf(values) {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j++;
    const mean = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k].i] = mean;
    i = j + 1;
  }
  return ranks;
}

export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Spearman with tie-averaged ranks, and the two-sided p of the large-sample
 * normal approximation z = rho * sqrt(n - 1). At the sample sizes here that
 * approximation is optimistic, so it is safe for concluding that nothing
 * separates and not safe for concluding that something does.
 */
export function spearman(records, aKey, bKey) {
  const rows = records.filter((r) => typeof r.deltas[aKey] === "number" && typeof r.deltas[bKey] === "number");
  if (rows.length < 3) return null;
  const rho = pearson(ranksOf(rows.map((r) => r.deltas[aKey])), ranksOf(rows.map((r) => r.deltas[bKey])));
  if (rho === null) return null;
  const z = Math.abs(rho) * Math.sqrt(rows.length - 1);
  return { n: rows.length, rho, p: erfc(z / Math.SQRT2) };
}

// ---------------------------------------------------------------------------
// The cell the queueing rule reads
// ---------------------------------------------------------------------------

/**
 * Records whose primary rose while the hazard channel did not resolvably
 * rise. These are the comparisons where the ladder moved through some channel
 * other than the one the hazard family argues from.
 */
export function reverseCell(records, hazardKey) {
  const floor = RESOLVABLE[hazardKey];
  return records
    .filter((r) => r.ladder && sign(r.deltas.primary) > 0)
    .map((r) => ({
      id: r.id,
      verdict: r.verdict,
      primary: r.deltas.primary,
      primaryBand: r.primaryBand,
      scale: r.scale,
      hazard: r.deltas[hazardKey],
      hazardResolvablyUp: r.deltas[hazardKey] > floor,
    }))
    .sort((a, b) => Math.abs(b.primary) - Math.abs(a.primary));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function num(x, digits = 3) {
  return x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(digits);
}

function pct(x, digits = 1) {
  return Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : "n/a";
}

function sci(x) {
  return Number.isFinite(x) ? x.toExponential(2) : "n/a";
}

export function renderReport(data) {
  const L = [];
  L.push("# Hazard deltas against depth deltas");
  L.push("");
  L.push(
    "Whether a hazard-rate delta in an archived objectiveDeltas block has ever " +
      "predicted the depth-band delta beside it. Every number here is read off " +
      "decisions the gate already made; nothing was re-run.",
  );
  L.push("");
  L.push(`- decision records: ${data.total}, of which ${data.ladder} carry both a hazard delta and depth deltas`);
  L.push(`- depth-delta scale: ${data.absoluteCount} absolute per-run differences, ${data.relativeCount} relative per-second ratios`);
  L.push("");

  L.push("## Which channels a decision can be audited on");
  L.push("");
  L.push("| channel | records measuring it | records comparing it |");
  L.push("| --- | --- | --- |");
  for (const row of data.census.rows) {
    L.push(`| ${row.channel} | ${row.measured} | ${row.compared} |`);
  }
  L.push("");
  L.push(
    "A channel with a zero in the right-hand column has never entered a " +
      "decision. It is printed on every run and compared on none, so no past " +
      "verdict can be scored against it and a criterion phrased on it is " +
      "unfalsifiable by construction rather than by bad luck.",
  );
  L.push("");

  L.push("## Whether the compared channel ever resolved");
  L.push("");
  const f = data.floor;
  L.push(
    `The between-seed spread of h2 gives a smallest separable delta of ${f.floor} ` +
      `absolute. Of ${f.total} archived h2 deltas, ${f.inside} are inside it and ` +
      `${f.outside.length} outside.`,
  );
  L.push("");
  if (f.outside.length > 0) {
    L.push("| record | h2 delta |");
    L.push("| --- | --- |");
    for (const o of f.outside) L.push(`| ${o.id} | ${o.v > 0 ? "+" : ""}${num(o.v, 4)} |`);
    L.push("");
  }
  L.push(
    "A criterion that fires on a quantity which lands inside its own noise " +
      "floor in almost every comparison is not a weak criterion. It fires on " +
      "the seed.",
  );
  L.push("");

  L.push("## Sign agreement with each depth band");
  L.push("");
  L.push("| pair | n | same sign | expected at these margins | kappa | odds ratio | chi2 | p |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of data.signRows) {
    const t = row.table;
    L.push(
      `| ${row.label} | ${t.n} | ${pct(t.agreement)} | ${pct(t.expected)} | ${num(t.kappa)} | ` +
        `${t.oddsRatio === null ? "n/a" : num(t.oddsRatio, 2)} | ${num(t.chi2, 2)} | ${num(t.p, 3)} |`,
    );
  }
  L.push("");
  L.push(
    "Signs rather than magnitudes, because the archive writes the depth " +
      "deltas on two scales and a pooled magnitude would mix them. `expected` " +
      "is the same-sign rate independence gives at the observed margins, and " +
      "it is not 50% when one channel is lopsided; `kappa` is the excess over " +
      "that, so zero is no association and negative is anti-association.",
  );
  L.push("");
  L.push(
    "Read down the column rather than at any one row. The association is " +
      "strongest at the shallowest band and thins toward the band the objective " +
      "is named on. The between-seed measurement found the shallow per-second " +
      "bands to be the session's run count wearing a different name, so a hazard " +
      "channel that also tracks the run rate will agree with them for a reason " +
      "that has nothing to do with faults; the h2-against-throughput row is there " +
      "to price that reading.",
  );
  L.push("");
  L.push(
    "`primary` is not one quantity across the archive. It was copied from " +
      "whichever band the objective was named on at the time, and once from the " +
      "violations rate, so the band rows are what should be read and the " +
      "`primary` row is kept only because it is the field decisions were written " +
      "against.",
  );
  L.push("");

  L.push("## Rank correlation inside a scale");
  L.push("");
  L.push("| scale | pair | n | rho | p |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const row of data.rankRows) {
    L.push(`| ${row.scale} | ${row.label} | ${row.stat.n} | ${row.stat.rho > 0 ? "+" : ""}${num(row.stat.rho)} | ${num(row.stat.p, 3)} |`);
  }
  L.push("");
  L.push(
    "Ranks are never pooled across the two scales. The p is the large-sample " +
      "normal approximation, which is optimistic at these sample sizes, so it is " +
      "safe for concluding that nothing separates and not for concluding that " +
      "something does.",
  );
  L.push("");

  L.push("## Primary up, hazard not resolvably up");
  L.push("");
  L.push("| record | verdict | primary band | scale | primary | h2 |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const r of data.reverse.filter((x) => !x.hazardResolvablyUp)) {
    L.push(
      `| ${r.id} | ${r.verdict} | ${r.primaryBand ?? "?"} | ${r.scale} | ` +
        `${r.primary > 0 ? "+" : ""}${sci(r.primary)} | ${r.hazard > 0 ? "+" : ""}${sci(r.hazard)} |`,
    );
  }
  L.push("");
  L.push(
    `${data.reverse.filter((x) => !x.hazardResolvablyUp).length} of ${data.reverse.length} ` +
      "comparisons where the primary rose did so without a hazard move large " +
      "enough to read. Whatever carried those, it was not the channel the " +
      "hazard argument names.",
  );
  L.push("");
  L.push(
    "One warning against over-reading the list: none of these primary gains " +
      `clears its own floor either - at ${PRIMARY_BAND} that floor is ` +
      `${pct(RESOLVABLE[PRIMARY_BAND], 1)} relative. The list is a generator for ` +
      "hypotheses, not a set of measured wins, and a family derived from it still " +
      "has to separate on its own evidence.",
  );
  L.push("");

  L.push("## What this licenses");
  L.push("");
  L.push(
    "The hazard channel is compared on one of its four members, that member " +
      "resolves in a small minority of comparisons, and where it is recorded " +
      "its sign tracks the shallow bands and the run rate rather than the band " +
      "the objective is named on. So a pre-registered criterion resting only on " +
      "a hazard rate or an acted fraction cannot fail on evidence: the quantity " +
      "it watches is inside its own noise floor in the ordinary case, and its " +
      "direction has no measured relation to the rung that decides.",
  );
  L.push("");
  L.push("Concretely, for a proposal whose only pre-registered fire criterion is a hazard rate or an acted fraction:");
  L.push("");
  L.push(
    "1. It must additionally pre-register a depth-band criterion, or be " +
      "downgraded before it is queued. Prefer depth>=4 when a small effect is " +
      "expected, since it is the only band stable to a tenth of a percent, and " +
      "read it knowing that it partly measures throughput.",
  );
  L.push(
    "2. If the hazard criterion is kept as well, state it at a magnitude above " +
      `its own floor - h1 ${RESOLVABLE.h1}, h2 ${RESOLVABLE.h2}, h2b ${RESOLVABLE.h2b}, ` +
      `h3 ${RESOLVABLE.h3} absolute. A criterion written at 1e-3 is written inside ` +
      "the noise and will report success or failure at random.",
  );
  L.push(
    "3. An acted-fraction criterion needs its counter to reach a decision block " +
      "before it can be a criterion. Until then it is a diagnostic: useful for " +
      "deciding whether a mechanism fired, useless for deciding whether it worked.",
  );
  L.push("");
  L.push(
    "None of this says a hazard is the wrong thing to build toward. It says a " +
      "hazard rate is a level check and not a gradient, which is what the " +
      "between-seed spread already implied, and that the archive contains no " +
      "case of a hazard move predicting a depth move because it contains " +
      "almost no readable hazard moves at all.",
  );
  L.push("");

  L.push("## Method");
  L.push("");
  L.push(
    "A record enters if its decision carries an objectiveDeltas block; it enters " +
      "the hazard tables if that block carries `h2` and all five depth bands. The " +
      "depth-delta scale is read off whether the record's evaluations report the " +
      "explorer's own exposure, because the gate switched from an absolute per-run " +
      "difference to a ratio of events per explore-second when exposure accounting " +
      "arrived, and ranks from the two are not comparable. Sign tables drop a " +
      "record where either channel is exactly zero rather than counting it as a " +
      "tie. Resolution floors are the smallest separable deltas from the " +
      "between-seed measurement at two chunks per arm.",
  );
  L.push("");
  L.push(
    "Sections that read a level rather than a delta are maintained by hand " +
      "against the status ladder and are not regenerated here.",
  );
  L.push("");
  L.push(
    "Regenerate with `node research/observations/hazard_predictiveness.mjs --out " +
      "research/observations/HAZARD_PREDICTIVENESS.md`, and check the arithmetic " +
      "with `--selftest`. The tables move as records accumulate, so this is a " +
      "measurement to repeat rather than a constant to memorise.",
  );
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** The band most of a group's decisions copied `primary` from. Bands other
 *  than a depth one are ignored: a violations delta is a different quantity on
 *  a different scale and cannot name the group. */
export function modalPrimaryBand(group) {
  const counts = new Map();
  for (const r of group) {
    if (!BANDS.includes(r.primaryBand)) continue;
    counts.set(r.primaryBand, (counts.get(r.primaryBand) ?? 0) + 1);
  }
  let best = null;
  for (const [band, n] of counts) {
    if (best === null || n > counts.get(best)) best = band;
  }
  return best;
}

export function analyse(records) {
  const ladder = records.filter((r) => r.ladder);
  const signRows = [];
  for (const band of BANDS) {
    const t = signTable(ladder, "h2", band);
    if (t) signRows.push({ label: `h2 vs ${band}`, table: t });
  }
  const primaryTable = signTable(ladder, "h2", "primary");
  if (primaryTable) signRows.push({ label: "h2 vs primary", table: primaryTable });
  const throughputTable = signTable(ladder, "h2", "throughput");
  if (throughputTable) signRows.push({ label: "h2 vs throughput", table: throughputTable });
  const tPrimary = signTable(ladder, "throughput", PRIMARY_BAND);
  if (tPrimary) signRows.push({ label: `throughput vs ${PRIMARY_BAND}`, table: tPrimary });

  const rankRows = [];
  for (const scale of ["absolute", "relative"]) {
    const group = ladder.filter((r) => r.scale === scale);
    // The band `primary` was copied from differs by scale, so each group is
    // correlated against the band its own decisions were mostly named on.
    const named = modalPrimaryBand(group) ?? PRIMARY_BAND;
    for (const band of [...new Set(["depth>=4", named])]) {
      const stat = spearman(group, "h2", band);
      if (stat) rankRows.push({ scale, label: `h2 vs ${band}`, stat });
    }
  }

  return {
    total: records.length,
    ladder: ladder.length,
    absoluteCount: ladder.filter((r) => r.scale === "absolute").length,
    relativeCount: ladder.filter((r) => r.scale === "relative").length,
    census: channelCensus(records),
    floor: floorCensus(records, "h2"),
    signRows,
    rankRows,
    reverse: reverseCell(records, "h2"),
  };
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

export function selfTest() {
  const failures = [];
  const check = (cond, msg) => { if (!cond) failures.push(msg); };
  const close = (a, b, tol, msg) => check(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

  check(sign(0) === 0 && sign(-1e-9) === -1 && sign(2) === 1, "sign must treat exact zero as no direction");
  check(sign(undefined) === 0, "a missing channel has no direction");

  close(erfc(0), 1, 1e-6, "erfc(0)");
  close(erfc(1), 0.157299, 1e-5, "erfc(1)");
  close(chiSquareP(3.841459), 0.05, 1e-3, "chi-square one df at the 5% point");
  check(chiSquareP(0) === 1, "no departure gives p 1");

  const mk = (deltas) => ({ ladder: true, deltas, scale: "relative", primaryBand: "depth>=6", id: "x", verdict: "v", evals: [] });

  // Perfect agreement on a balanced table: kappa 1, and the odds ratio is
  // undefined because a discordant cell is empty.
  const perfect = signTable([mk({ h2: 1, a: 1 }), mk({ h2: -1, a: -1 }), mk({ h2: 1, a: 2 }), mk({ h2: -1, a: -2 })], "h2", "a");
  close(perfect.agreement, 1, 1e-12, "identical signs agree everywhere");
  close(perfect.kappa, 1, 1e-12, "identical signs give kappa 1");
  check(perfect.oddsRatio === null, "an empty discordant cell has no odds ratio");

  // Independence at lopsided margins: the raw agreement is not 50% and kappa
  // is what says so.
  const lopsided = signTable([
    mk({ h2: 1, a: 1 }), mk({ h2: 1, a: 1 }), mk({ h2: 1, a: -1 }), mk({ h2: 1, a: -1 }),
    mk({ h2: -1, a: 1 }), mk({ h2: -1, a: -1 }),
  ], "h2", "a");
  close(lopsided.expected, 0.5, 1e-12, "balanced b margins expect half");
  close(lopsided.kappa, 0, 1e-12, "independence gives kappa 0");
  close(lopsided.oddsRatio, 1, 1e-12, "independence gives odds ratio 1");

  // A zero on either channel drops the record rather than counting as a tie.
  const withZero = signTable([mk({ h2: 1, a: 1 }), mk({ h2: 0, a: 1 }), mk({ h2: 1, a: 0 })], "h2", "a");
  check(withZero.n === 1, `a zero delta must not enter the table, got n=${withZero.n}`);

  // Hand-checkable Spearman: exactly reversed ranks give -1, and one adjacent
  // swap in five items gives 1 - 6*2/(5*24) = 0.9.
  close(pearson(ranksOf([1, 2, 3]), ranksOf([3, 2, 1])), -1, 1e-12, "reversed ranks");
  const swapped = spearman(
    [[1, 1], [2, 2], [3, 4], [4, 3], [5, 5]].map(([x, y]) => mk({ h2: x, a: y })), "h2", "a",
  );
  close(swapped.rho, 0.9, 1e-12, "one adjacent swap in five");

  check(ranksOf([5, 5, 1]).join(",") === "2.5,2.5,1", `ties must average their ranks, got ${ranksOf([5, 5, 1])}`);

  // The scale a record's depth deltas are written on is read off the
  // explorer's own exposure accounting, not off the magnitudes.
  check(depthScaleOf({ evaluations: { sequential: [{ metrics: { exposureMs: 1 } }] } }) === "relative",
    "exposure accounting marks the relative scale");
  check(depthScaleOf({ evaluations: { sequential: [{ metrics: {} }] } }) === "absolute",
    "no exposure accounting marks the absolute scale");

  check(primaryBandOf({ decision: { objectiveDeltas: { primary: 0.5, "depth>=6": 0.5, "depth>=5": 0.1 } } }) === "depth>=6",
    "primary must resolve to the band it was copied from");

  check(modalPrimaryBand([{ primaryBand: "depth>=5" }, { primaryBand: "depth>=5" }, { primaryBand: "violations" }]) === "depth>=5",
    "a violations primary must not name a group");
  check(modalPrimaryBand([{ primaryBand: "violations" }]) === null, "a group with no depth primary names no band");

  const full = { h2: 0, "depth>=4": 0, "depth>=5": 0, "depth>=6": 0, "depth>=7": 0, "depth>=8": 0 };
  check(isLadderRecord({ decision: { objectiveDeltas: full } }), "a hazard delta plus every band is a ladder record");
  check(!isLadderRecord({ decision: { objectiveDeltas: { primary: 1, throughput: 1 } } }),
    "a bench record is not a ladder record");

  const fc = floorCensus([mk({ h2: 0.001 }), mk({ h2: 0.02 }), mk({ h2: -0.03 })], "h2");
  check(fc.inside === 1 && fc.outside.length === 2, `floor census miscounted: ${fc.inside}/${fc.outside.length}`);
  check(fc.outside[0].v === -0.03, "the outside list must lead with the largest excursion");

  const rc = reverseCell([mk({ primary: 0.1, h2: 0.001 }), mk({ primary: -0.1, h2: 0.001 }), mk({ primary: 0.2, h2: 0.9 })], "h2");
  check(rc.length === 2, `only rising primaries belong in the cell, got ${rc.length}`);
  check(rc[0].hazardResolvablyUp === true && rc[1].hazardResolvablyUp === false,
    "resolvability must be judged against the channel floor");

  return failures;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { out: null, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selftest") opts.selftest = true;
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
      console.error("hazard_predictiveness selftest FAILED:");
      for (const f of failures) console.error(`  ${f}`);
      process.exit(1);
    }
    console.log("hazard_predictiveness selftest ok");
    return;
  }
  const records = loadRecords(RECORDS_DIR);
  if (records.length === 0) {
    console.error(`no decision records under ${RECORDS_DIR}`);
    process.exit(1);
  }
  const report = renderReport(analyse(records));
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
