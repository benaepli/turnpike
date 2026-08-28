// Hypothesis selection: UCB-flavored bandit over the proposed pool, with a
// compiled exploration quota (fresh lineages get a guaranteed share) and
// lineage caps. Pure logic - no IO.
import type { Hypothesis } from "./schemas.js";
import type { Policy } from "./policy.js";
import type { LoopState } from "./state.js";
import { loadSeqState } from "./sequential.js";

export interface SelectInputs {
  pool: Hypothesis[];              // status === "proposed"
  evaluatedCounts: Map<string, number>; // lineage-root id -> completed attempts
  measuredDelta: Map<string, number>; // lineage-root id -> best observed objective delta
}

export function lineageRoot(h: Hypothesis, byId: Map<string, Hypothesis>): string {
  let cur = h;
  const seen = new Set<string>();
  while (cur.parent && !seen.has(cur.parent)) {
    seen.add(cur.parent);
    const p = byId.get(cur.parent);
    if (!p) break;
    cur = p;
  }
  return cur.id;
}

export function lineageDepth(h: Hypothesis, byId: Map<string, Hypothesis>): number {
  let d = 0;
  let cur: Hypothesis | undefined = h;
  const seen = new Set<string>();
  while (cur?.parent && !seen.has(cur.parent)) {
    seen.add(cur.parent);
    cur = byId.get(cur.parent);
    d++;
  }
  return d;
}

export function scoreHypothesis(
  h: Hypothesis,
  inputs: SelectInputs,
  byId: Map<string, Hypothesis>,
  ucbC: number,
): number {
  const root = lineageRoot(h, byId);
  const prior = h.expectedGain / Math.max(h.expectedCost, 0.1); // 0..100
  const priorNorm = Math.min(prior / 10, 1);
  const measured = inputs.measuredDelta.get(root) ?? 0;
  const trials = inputs.evaluatedCounts.get(root) ?? 0;
  const total = [...inputs.evaluatedCounts.values()].reduce((a, b) => a + b, 0);
  const ucb = ucbC * Math.sqrt(Math.log(total + 2) / (trials + 1));
  return 0.5 * priorNorm + Math.max(-1, Math.min(measured, 1)) + ucb;
}

// Mechanism utilization (from utilization.json collected on the evaluation
// config). A hypothesis that builds on a mechanism recording zero activity
// cannot be evaluated meaningfully - its enabler must merge first.
export interface Utilization { [group: string]: { [counter: string]: number } }
export function parseUtilization(raw: string | null): Utilization | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as Utilization; } catch { return null; }
}
const MECHANISM_COUNTERS: Record<string, [string, string]> = {
  "purgatory": ["purgatory", "delayed_sends"],
  "timeline-feedback": ["feedback", "scored_runs"],
  "feedback": ["feedback", "scored_runs"],
  "steer": ["feedback", "scored_runs"],
  "aos": ["aos", "tape_wins"],
  "dedup": ["dedup", "checks"],
};
// Mechanisms whose activity counter is zero in the evaluation config: a
// change confined to one of them cannot be measured there.
export function inactiveMechanisms(util: Utilization | null): string[] {
  if (!util) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [name, [group, counter]] of Object.entries(MECHANISM_COUNTERS)) {
    const key = `${group}.${counter}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if ((util[group]?.[counter] ?? 0) <= 0) out.push(`${name} (${key} = 0)`);
  }
  return out;
}

export function buildsOnSatisfied(h: Hypothesis, util: Utilization | null): boolean {
  if (h.kind === "enabling" || !util) return true;
  for (const dep of h.buildsOn) {
    const key = MECHANISM_COUNTERS[dep.toLowerCase()];
    if (!key) continue;
    const v = util[key[0]]?.[key[1]] ?? 0;
    if (v <= 0) return false;
  }
  return true;
}

// selectNext picks the next hypothesis. Quota rule: if fewer than
// explorationQuota of the last 10 selections were fresh lineages (no parent),
// force the best parentless candidate when one exists.
// Empirical calibration factor: mean realized primary delta (a relative
// change, +10% counting as a full gain of 10 and larger moves capped there)
// over mean predicted gain, across evaluated hypotheses. Proposer optimism
// is discounted automatically as evidence accumulates. Floored so the prior
// never vanishes entirely.
export function calibrationFactor(state: LoopState): number {
  let predicted = 0;
  let realized = 0;
  let n = 0;
  const epoch = state.currentEpoch();
  for (const h of state.listHypotheses()) {
    const d = state.getDecision(h.id);
    if (!d) continue;
    if ((d.epoch ?? 1) !== epoch || d.harnessFailure) continue;
    n++;
    predicted += h.expectedGain;
    realized += Math.min(10, Math.max(0, (d.objectiveDeltas["primary"] ?? 0)) / 0.1 * 10);
  }
  if (n < 3 || predicted <= 0) return 1;
  return Math.max(0.15, Math.min(1, realized / predicted));
}

export function selectNext(state: LoopState, policy: Policy): Hypothesis | null {
  const all = state.listHypotheses();
  const byId = new Map<string, Hypothesis>(all.map((h) => [h.id, h]));
  // An inconclusive hypothesis is resumable once its cooldown has passed;
  // its posterior replaces the proposer's guess as the prior.
  const lastIteration = state.recentIterations(1)[0]?.n ?? 0;
  const resumable = all.filter((h) => {
    if (h.status !== "inconclusive" || h.branch === null) return false;
    const seq = loadSeqState(state, h.id);
    return seq !== null && lastIteration - seq.lastIteration >= policy.sequential.resumeCooldown;
  });
  const pool = [...all.filter((h) => h.status === "proposed"), ...resumable];
  if (pool.length === 0) return null;

  const terminal = new Set(["merged", "needs_human", "closed", "blocked", "parked"]);
  const evaluatedCounts = new Map<string, number>();
  for (const h of all) {
    if (terminal.has(h.status)) {
      const root = lineageRoot(h, byId);
      evaluatedCounts.set(root, (evaluatedCounts.get(root) ?? 0) + 1);
    }
  }
  const measuredDelta = new Map<string, number>();
  const curEpoch = state.currentEpoch();
  for (const h of all) {
    const d = state.getDecision(h.id);
    if (!d) continue;
    if ((d.epoch ?? 1) !== curEpoch || d.harnessFailure) continue;
    const root = lineageRoot(h, byId);
    const primary = d.objectiveDeltas["primary"] ?? 0;
    measuredDelta.set(root, Math.max(measuredDelta.get(root) ?? -1, primary));
  }
  // Fraction of the last selections that opened a fresh (parentless)
  // lineage, read from the selection ring buffer so it reflects what was
  // actually run, not hypothesis creation order. Absent on a fresh restart:
  // behave as today rather than force-exploring on empty state.
  const ringRaw = state.getMeta("recentSelections");
  let freshShare = 1;
  if (ringRaw) {
    const resolved = (JSON.parse(ringRaw) as string[]).slice(-10)
      .map((id) => byId.get(id))
      .filter((h): h is Hypothesis => h !== undefined);
    if (resolved.length > 0) freshShare = resolved.filter((h) => h.parent === null).length / resolved.length;
  }

  const inputs: SelectInputs = {
    pool,
    evaluatedCounts,
    measuredDelta,
  };

  const util = parseUtilization(state.getMeta("utilization"));
  const eligible = pool.filter((h) =>
    lineageDepth(h, byId) <= policy.budgets.maxLineageDepth && buildsOnSatisfied(h, util),
  );
  if (eligible.length === 0) return null;

  const calib = calibrationFactor(state);
  const score = (h: Hypothesis): number => {
    const seq = h.status === "inconclusive" ? loadSeqState(state, h.id) : null;
    if (seq && seq.lastVerdict === "inconclusive") {
      const best = Math.max(seq.posteriors["depth>=4:pGreater"] ?? 0, seq.posteriors["depth>=5:pGreater"] ?? 0, seq.posteriors["depth>=6:pGreater"] ?? 0);
      // Resuming costs only sampling time, so the evidence stands in for
      // the gain/cost prior; a probable effect outranks any fresh guess.
      return 0.5 * best + best;
    }
    // Sampling interrupted before a verdict ranks as the proposal did.
    const shrunk: Hypothesis = { ...h, expectedGain: h.expectedGain * calib };
    return scoreHypothesis(shrunk, inputs, byId, policy.bandit.ucbC);
  };
  const ranked = [...eligible].sort((a, b) => score(b) - score(a));
  if (freshShare < policy.bandit.explorationQuota) {
    const fresh = ranked.find((h) => h.parent === null);
    if (fresh) return fresh;
  }
  return ranked[0] ?? null;
}
