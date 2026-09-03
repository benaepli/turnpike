// What each recorded session would have declared at `start`. The sessions
// predate the declaration flags, so the bit and the band are read off the
// written record: the tag from the cells the chunks carry, the band from the
// frozen prediction in research/lite/observations.md. Whoever consumes this
// asserts the bit against the cells, so an entry cannot be invented.
//
// A session with no entry declared nothing and is graded on the cross-binary
// rung. New sessions declare at `start` instead of here.
import * as fs from "node:fs";
import * as path from "node:path";

import { ROOT } from "../orchestrator/src/paths.js";

const DECISIONS_PATH = path.join(ROOT, "research", "lite", "decisions.jsonl");

/** The rule version a recorded session was decided under: the last decision
 *  row for the name that carries one. null where the record carries none,
 *  which reads as the first internal-primary version. A session is judged on
 *  the rungs its record was made on, whatever the live rule decides on. */
export function recordedRuleVersionFor(name: string): string | null {
  if (!fs.existsSync(DECISIONS_PATH)) return null;
  let version: string | null = null;
  for (const line of fs.readFileSync(DECISIONS_PATH, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line) as { name?: string; ruleVersion?: string };
    if (row.name === name && typeof row.ruleVersion === "string") version = row.ruleVersion;
  }
  return version;
}

export interface RecordedDeclaration {
  name: string;
  // null where the mechanism cannot be turned off for part of a session's
  // runs, or where the change is config-only.
  bit: number | null;
  band: { min: number; max: number } | null;
  // Where the band comes from, in the record's own words.
  source: string;
}

export const RECORDED_DECLARATIONS: readonly RecordedDeclaration[] = [
  { name: "crash-placement-probe-exemption", bit: 1, band: { min: 0.02, max: 0.15 }, source: "iteration 7, frozen band +2..15%" },
  { name: "crash-placement-fraction-0-9", bit: 1, band: { min: 0.35, max: 0.65 }, source: "iteration 7, frozen band +35..65%" },
  { name: "client-request-placement-span-draw", bit: 16, band: { min: 0.05, max: 0.4 }, source: "iteration 8, band lowered to 0.05..0.40" },
  { name: "stale-incarnation-order-stratification", bit: 16, band: { min: 0.04, max: 0.25 }, source: "iteration 9, frozen 1.04 bar; upper edge not recorded" },
  { name: "restart-latency-foreign-progress-draw", bit: 32, band: { min: 0.1, max: 0.4 }, source: "iteration 10, 1.10 bar; upper edge not recorded" },
  { name: "timeline-novelty-scalefree-rarity-restore", bit: 64, band: null, source: "iteration 12 records no per-run band" },
  { name: "partition-fault-class-restore-with-repair-hold", bit: 128, band: { min: 0.05, max: 0.25 }, source: "iteration 13, 1.05 bar; upper edge not recorded" },
  { name: "directed-link-speed-class-run-skew", bit: 256, band: { min: 0.05, max: 0.25 }, source: "iteration 14, 1.05 bar; upper edge not recorded" },
  { name: "activity-clock-crash-placement", bit: 1024, band: { min: 0.04, max: 0.25 }, source: "iteration 15, frozen 1.04 bar; upper edge not recorded" },
  { name: "crash-fanout-phase-anchored-release", bit: 512, band: { min: 0.05, max: 0.25 }, source: "iteration 16, frozen bar of 1.05" },
  // The run-cap probe posture is an instrument, not a treatment. Declared
  // here so the rule is seen to refuse it rather than never being asked.
  { name: "probe-phase-grid-alias-fix", bit: 2, band: { min: 0.03, max: 0.25 }, source: "iteration 6, frozen band +3..25%" },
  // Config-only: nothing is turned off for part of the runs, so bit 1 is
  // present but unrelated and declaring it would invent a contrast.
  { name: "purgatory-blind-delay-default-ablation", bit: null, band: null, source: "iteration 11, config-only ablation" },
];

export function declarationFor(name: string): RecordedDeclaration | null {
  return RECORDED_DECLARATIONS.find((d) => d.name === name) ?? null;
}
