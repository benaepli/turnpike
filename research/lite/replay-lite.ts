// Offline replay of every recorded lite session through the live decision
// code. Nothing is re-measured: each session's chunk records and its paired
// baseline cache are read off disk and re-decided, so the question the run
// answers is which recorded decisions the rule makes differently and whether
// the ones the change was for come out as claimed.
//
// Run: cd research/orchestrator && npx tsx ../lite/replay-lite.ts [--assert]
//
// The sessions predate the declaration flags, so the bit and band each would
// have declared come from declarations.ts, which reads them off the written
// record. Every declared bit is asserted against the tag actually present in
// the cells, so a declaration cannot be invented here.
//
// Each session is re-decided under the rule version its decision row
// carries, so a record made on one primary rung is not re-read on another;
// a row with no version predates versioning and replays on the first
// internal-primary rules.
import * as fs from "node:fs";
import * as path from "node:path";

import {
  CROSS_BINARY_NULL_FLOOR, EPOCH_THROUGHPUT_FLOOR, MERGE_Z, RULE_VERSION, RULE_VERSION_V1, compareToBaseline,
  figuresOf, internalPrimary, mergeBlockers, objectiveCounts, primaryRungFor, ruleVerdict,
  type FinalGateInputs, type InternalPrimary, type MergeVerdict,
} from "../orchestrator/src/decide.js";
import { ROOT } from "../orchestrator/src/paths.js";
import { Evaluation } from "../orchestrator/src/schemas.js";
import { RECORDED_DECLARATIONS, declarationFor, recordedRuleVersionFor } from "./declarations.js";

// The table the assertion is made against: what each recorded session would
// have declared at `start`.
export const REPLAY_DECLARATIONS = RECORDED_DECLARATIONS;

const LITE_DIR = path.join(ROOT, "research", "lite");
const STATE_DIR = path.join(LITE_DIR, "state");
const DECISIONS = path.join(LITE_DIR, "decisions.jsonl");
const EPOCH_PATH = path.join(LITE_DIR, "epoch-baseline.json");
// The throughput floor the sessions were graded under, from policy.json's
// regression tolerance. Read rather than assumed so the replay grades on the
// same floor the live path does.
const POLICY_PATH = path.join(ROOT, "research", "policy.json");

// What each session must decide to, and why. A row named here that is
// absent from the replay is itself a failure: the record no longer holds
// what the claim was made about.
const EXPECTED: Record<string, { want: MergeVerdict; why: string }> = {
  "crash-placement-completion-span-draw": { want: "merge", why: "fallback: no tags on disk, cross-binary rung far outside the layout floor" },
  "learned-run-cap-probe-p99": { want: "merge", why: "fallback: no tags on disk, +16% on the rung" },
  "timer-admission-context-odds-probe": { want: "merge", why: "fallback: no tags on disk, +19% on the rung" },
  "crash-placement-probe-exemption": { want: "merge", why: "internal: the bit is on both sides, difference in differences 1.2269" },
  "crash-placement-fraction-0-9": { want: "merge", why: "the treated share moved 0.48 to 0.89, so the internal read is discarded and the fallback carries it" },
  "client-request-placement-span-draw": { want: "close", why: "the internal contrast is 0.9851 and its frozen 1.05 band is excluded" },
  "stale-incarnation-order-stratification": { want: "close", why: "the frozen 1.04 band is excluded by the interval" },
  "restart-latency-foreign-progress-draw": { want: "close", why: "the frozen 1.10 band is excluded by the interval" },
  "purgatory-blind-delay-default-ablation": { want: "merge", why: "config-only, no bit to declare; the fallback rung is +47%" },
  "timeline-novelty-scalefree-rarity-restore": { want: "close", why: "the cross-binary rung fell beyond the layout floor" },
  "partition-fault-class-restore-with-repair-hold": { want: "close", why: "the cross-binary rung fell beyond the layout floor" },
  "directed-link-speed-class-run-skew": { want: "close", why: "the cross-binary rung fell beyond the layout floor" },
  "activity-clock-crash-placement": { want: "close", why: "the internal contrast is 1.0109 and its frozen 1.04 band is excluded" },
  "crash-fanout-phase-anchored-release": { want: "merge", why: "the internal contrast is 1.1854 [1.1195, 1.2551], separated above 1.0 with an effect above the 5% floor" },
  "probe-phase-grid-alias-fix": { want: "human", why: "bit 2 names an instrument, so the fallback carries it and +3.2% is inside the layout floor" },
  "timer-refire-outcome-quantile": { want: "human", why: "no bit, and +3.6% is inside the layout floor" },
};

interface Session {
  name: string;
  cand: Evaluation[];
  base: Evaluation[];
  // The rule version the record was decided under; null predates versioning.
  ruleVersion: string | null;
  recorded: { verdict: string; reason: string; throughputRatio: number; regressionPassed: boolean | null } | null;
}

interface Row {
  name: string;
  old: string;
  next: MergeVerdict;
  reason: string;
  ruleVersion: string;
  primaryRung: number;
  primaryKind: string;
  internal: InternalPrimary | null;
  crossBinary: number;
  throughput: number;
  blockers: string[];
  declaredBit: number | null;
  chunks: number;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function recordedDecisions(): Map<string, Session["recorded"]> {
  const out = new Map<string, Session["recorded"]>();
  if (!fs.existsSync(DECISIONS)) return out;
  for (const line of fs.readFileSync(DECISIONS, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const d = JSON.parse(line) as { name?: string; verdict?: string; reason?: string; throughputRatio?: number; regressionPassed?: boolean | null };
    if (typeof d.name !== "string") continue;
    // The last row for a name is the decision that stood.
    out.set(d.name, {
      verdict: d.verdict ?? "", reason: d.reason ?? "", throughputRatio: d.throughputRatio ?? 1,
      regressionPassed: d.regressionPassed ?? null,
    });
  }
  return out;
}

function loadSessions(): Session[] {
  const decisions = recordedDecisions();
  const out: Session[] = [];
  for (const f of fs.readdirSync(STATE_DIR).filter((x) => x.endsWith(".json")).sort()) {
    const name = path.basename(f, ".json");
    const state = readJson<{ name: string; cacheFile: string; usedSeeds: number[] }>(path.join(STATE_DIR, f));
    if (state === null) continue;
    const cand: Evaluation[] = [];
    for (const seed of state.usedSeeds) {
      const p = path.join(STATE_DIR, name, `chunk-${seed}.cand.json`);
      if (!fs.existsSync(p)) continue;
      const parsed = Evaluation.safeParse(JSON.parse(fs.readFileSync(p, "utf8")));
      if (parsed.success) cand.push(parsed.data);
    }
    const cache = readJson<{ chunks: unknown[] }>(state.cacheFile);
    const base: Evaluation[] = [];
    for (const c of cache?.chunks ?? []) {
      const parsed = Evaluation.safeParse(c);
      if (parsed.success && state.usedSeeds.includes(parsed.data.seed)) base.push(parsed.data);
    }
    out.push({ name, cand, base, ruleVersion: recordedRuleVersionFor(name), recorded: decisions.get(name) ?? null });
  }
  return out;
}

function decide(s: Session, throughputFloor: number): Row | null {
  if (s.cand.length === 0 || s.base.length === 0) return null;
  const decl = declarationFor(s.name);
  const bit = decl?.bit ?? null;
  const band = decl?.band ?? null;
  const ruleVersion = s.ruleVersion ?? RULE_VERSION_V1;
  const primaryRung = primaryRungFor(ruleVersion);
  const cand = objectiveCounts(s.cand, ruleVersion);
  const base = objectiveCounts(s.base, ruleVersion);
  const cmp = compareToBaseline(cand, base, MERGE_Z, null, ruleVersion);
  const throughputRatio = cand.exposureSec > 0 && base.exposureSec > 0 && base.runs > 0
    ? (cand.runs / cand.exposureSec) / (base.runs / base.exposureSec)
    : 1;
  const epochFile = readJson<{ runsPerSec: number; layoutNullBand: number; merges: Array<{ cumulative: number }> }>(EPOCH_PATH);
  const cumulative = epochFile === null ? null : epochFile.merges.at(-1)?.cumulative ?? 1;
  const inputs: FinalGateInputs = {
    hypothesis: { id: `lite-${s.name}`, kind: "add", prediction: null } as unknown as FinalGateInputs["hypothesis"],
    confirmEvals: s.cand,
    baselineEvals: s.base,
    // The suite is recorded per session; where the record does not say, the
    // replay assumes it passes so the branches downstream of it are reached.
    regressionPassed: s.recorded?.regressionPassed ?? true,
    lintFailures: [],
    changedSpurFiles: [],
    changedSuperFiles: [],
    throughputRatio,
    throughputFloor,
    violationPrior: null,
    unmeasurable: [],
    firing: { status: "not-claimed", detail: "the record leaves the firing check to the operator" },
    treatmentBit: bit,
    perRunBand: band,
    epochThroughput: epochFile === null ? null : { frozenRps: epochFile.runsPerSec, cumulative, floor: EPOCH_THROUGHPUT_FLOOR },
    crossBinaryNullFloor: epochFile?.layoutNullBand ?? CROSS_BINARY_NULL_FLOOR,
  };
  const ip = internalPrimary(s.cand, s.base, bit, band, cand.chunks, primaryRung);
  const figures = figuresOf(inputs, cand, base, cmp, ip, ruleVersion);
  const verdict = ruleVerdict(figures);
  return {
    name: s.name,
    old: s.recorded?.verdict ?? "(none)",
    next: verdict.verdict,
    reason: verdict.reason,
    ruleVersion,
    primaryRung,
    primaryKind: ip.applies ? "internal" : "cross-binary",
    internal: ip,
    crossBinary: 1 + (cmp.deltas[`depth>=${primaryRung}`] ?? 0),
    throughput: throughputRatio,
    blockers: mergeBlockers(inputs, figures, cmp),
    declaredBit: bit,
    chunks: cand.chunks,
  };
}

/** A declared bit that no cell carries would be a claim about a population
 *  the session never ran. */
function declarationFaults(sessions: Session[]): string[] {
  const out: string[] = [];
  for (const d of REPLAY_DECLARATIONS) {
    const s = sessions.find((x) => x.name === d.name);
    if (s === undefined) { out.push(`${d.name} is declared but has no session on disk`); continue; }
    if (d.bit === null) continue;
    const tagged = s.cand.some((e) => e.metrics.variants.some((c) => (c.variant & d.bit!) !== 0));
    if (!tagged) out.push(`${d.name} declares bit ${d.bit}, which no chunk record carries`);
  }
  return out;
}

function fmt(x: number | null, digits = 4): string {
  return x === null || !Number.isFinite(x) ? "-" : x.toFixed(digits);
}

function main(): void {
  const assert = process.argv.slice(2).includes("--assert");
  const policy = readJson<{ regression?: { throughputTolerance?: number } }>(POLICY_PATH);
  const throughputFloor = 1 - (policy?.regression?.throughputTolerance ?? 0.2);
  const sessions = loadSessions();
  const rows: Row[] = [];
  const unreadable: string[] = [];
  for (const s of sessions) {
    const r = decide(s, throughputFloor);
    if (r === null) { unreadable.push(s.name); continue; }
    rows.push(r);
  }

  const byVersion = new Map<string, number>();
  for (const r of rows) byVersion.set(r.ruleVersion, (byVersion.get(r.ruleVersion) ?? 0) + 1);
  const versions = [...byVersion.entries()].map(([v, n]) => `${n} under ${v} (depth>=${primaryRungFor(v)})`).join(", ");
  console.log(`replayed ${rows.length} recorded lite sessions, each under the rule version its record carries: ${versions}; live rule ${RULE_VERSION} (depth>=${primaryRungFor(RULE_VERSION)}); throughput floor ${throughputFloor}\n`);
  const head = ["session", "old", "new", "rung", "primary", "internal r", "[lo", "hi]", "cross", "thr"];
  console.log(`${head[0]!.padEnd(48)}${head[1]!.padEnd(9)}${head[2]!.padEnd(7)}${head[3]!.padEnd(6)}${head[4]!.padEnd(14)}${head[5]!.padStart(10)}${head[6]!.padStart(10)}${head[7]!.padStart(10)}${head[8]!.padStart(9)}${head[9]!.padStart(9)}`);
  for (const r of rows.sort((a, b) => a.name.localeCompare(b.name))) {
    const ip = r.internal;
    console.log(
      `${r.name.padEnd(48)}${r.old.padEnd(9)}${r.next.padEnd(7)}${`d>=${r.primaryRung}`.padEnd(6)}${r.primaryKind.padEnd(14)}`
      + `${(ip === null || !ip.applies ? "-" : fmt(ip.ratio)).padStart(10)}`
      + `${(ip === null || !ip.applies ? "-" : fmt(ip.lo)).padStart(10)}`
      + `${(ip === null || !ip.applies ? "-" : fmt(ip.hi)).padStart(10)}`
      + `${fmt(r.crossBinary).padStart(9)}${fmt(r.throughput).padStart(9)}`,
    );
  }
  if (unreadable.length > 0) console.log(`\n${unreadable.length} sessions carry no readable pair: ${unreadable.join(", ")}`);

  console.log("\nreasons:");
  for (const r of rows) console.log(`  ${r.name.padEnd(48)} ${r.next.padEnd(6)} ${r.reason}`);

  console.log("\ninternal detail (declared sessions):");
  for (const r of rows) {
    const ip = r.internal;
    if (ip === null || r.declaredBit === null) continue;
    console.log(
      `  ${r.name.padEnd(48)} bit ${String(ip.bit).padStart(4)} ${ip.applies ? "applies " : "inapplic"}`
      + ` r ${fmt(ip.ratio)} [${fmt(ip.lo)}, ${fmt(ip.hi)}] z ${fmt(ip.z, 2)} seEff ${fmt(ip.seEff, 5)}`
      + ` share ${fmt(ip.treatedShare.candidate)}/${fmt(ip.treatedShare.baseline)} matched ${ip.matchedOnMask}`
      + ` band ${ip.bandReading ?? "-"}${ip.applies ? "" : ` (${ip.inapplicableReason ?? ""})`}`,
    );
  }

  const failures: string[] = [...declarationFaults(sessions)];
  console.log("\nacceptance:");
  for (const [name, e] of Object.entries(EXPECTED)) {
    const r = rows.find((x) => x.name === name);
    if (r === undefined) { failures.push(`${name} is not in the replay (${e.why})`); console.log(`  MISSING ${name}: ${e.why}`); continue; }
    const good = r.next === e.want;
    if (!good) failures.push(`${name}: expected ${e.want} (${e.why}); got ${r.next} (${r.reason})`);
    console.log(`  ${good ? "ok  " : "FAIL"} ${name.padEnd(48)} ${r.old.padEnd(8)} -> ${r.next.padEnd(6)} ${e.why}`);
  }
  const controls = rows.filter((r) => !(r.name in EXPECTED));
  if (controls.length > 0) console.log(`\n${controls.length} control sessions carry no expectation: ${controls.map((c) => `${c.name} -> ${c.next}`).join(", ")}`);

  if (failures.length > 0) {
    console.log(`\n${failures.length} acceptance failures:\n  ${failures.join("\n  ")}`);
    if (assert) process.exit(1);
  } else {
    console.log("\nall acceptance conditions met");
  }
}

main();
