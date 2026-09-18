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

import { ROOT } from "../harness/src/paths.js";

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
  // The co-bits, or "arm composition", the record's matched control is
  // unbalanced on. Absent where the record was decided on a balanced
  // control. The selftest reads these faults back and no others.
  unbalancedOn?: readonly string[];
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
  { name: "crash-fanout-reaction-triggered-arm", bit: 16384, band: { min: 0.02, max: 0.12 }, source: "iteration 17, epoch 13" },
  { name: "orphan-release-on-destination-answer", bit: 65536, band: { min: 0.03, max: 0.12 }, source: "iteration 18, epoch 13" },
  { name: "ghost-absorber-crash-retarget", bit: 524288, band: { min: 0.25, max: 2.0 }, source: "iteration 19, epoch 13" },
  { name: "ghost-absorber-retarget-redraw", bit: 8388608, band: { min: 0.02, max: 0.15 }, source: "iteration 20, epoch 13, nested in bit 524288" },
  { name: "ghost-prefix-replay-corpus", bit: 1048576, band: { min: 0.3, max: 3.0 }, source: "iteration 21, epoch 13" },
  { name: "ghost-pending-timer-hold", bit: 33554432, band: { min: 0.03, max: 0.3 }, source: "iteration 24, epoch 14 re-freeze on depth 8" },
  { name: "restart-before-stranded-drain-preempt", bit: 536870912, band: { min: 0.06, max: 0.3 }, source: "iteration 25, epoch 14" },
  { name: "fresh-first-same-pair-dispatch-tiebreak", bit: 16777216, band: { min: 0.12, max: 1.6 }, source: "iteration 26, epoch 14" },
  // Closed sessions whose control the record reads as unbalanced: children
  // inherit their parents' bits, so the treated population carries the
  // inheritance bit, crash placement and its phase at other rates than the
  // untreated runs, and the arm mix moves with them. A fault names a co-bit
  // by its current roster name, whatever the record's mechanism called the
  // same bit.
  {
    name: "replay-tier-answered-overtake-cut", bit: 8192, band: { min: 0.12, max: 1.2 },
    source: "iteration 27, epoch 14, nested in the slot half; closed with the inheritance bit (2048) at 0.243 treated against 0.221 control",
    unbalancedOn: ["newsBeforeReply"],
  },
  {
    name: "replay-prefix-inherit-parent-bits", bit: 2048, band: { min: 0.0, max: 0.35 },
    source: "iteration 28, epoch 14, nested in the prefix half; closed with crashPlaced at 0.996 treated against 0.917 control, a declared balance fault",
    unbalancedOn: ["crashPlaced", "crashPhase", "arm composition"],
  },
  { name: "pair-send-order-dispatch-fault-scoped", bit: 32768, band: { min: -0.02, max: 0.1 }, source: "iteration 29, epoch 14, depth-8 null" },
  { name: "pair-send-order-lean", bit: 32768, band: { min: -0.03, max: 0.08 }, source: "iteration 30, epoch 14, depth-8 null" },
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
