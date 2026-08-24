// Hypothesis selection: UCB-flavored bandit over the proposed pool, with a
// compiled exploration quota (fresh lineages get a guaranteed share) and
// lineage caps. Pure logic — no IO.
import type { Hypothesis } from "./schemas.js";
import type { Policy } from "./policy.js";
import type { LoopState } from "./state.js";

export interface SelectInputs {
  pool: Hypothesis[];              // status === "proposed"
  evaluatedCounts: Map<string, number>; // lineage-root id -> completed attempts
  recentSelections: string[];      // lineage-root ids of the last N selections
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

// selectNext picks the next hypothesis. Quota rule: if fewer than
// explorationQuota of the last 10 selections were fresh lineages (no parent),
// force the best parentless candidate when one exists.
export function selectNext(state: LoopState, policy: Policy): Hypothesis | null {
  const all = state.listHypotheses();
  const byId = new Map<string, Hypothesis>(all.map((h) => [h.id, h]));
  const pool = all.filter((h) => h.status === "proposed");
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
  for (const h of all) {
    const d = state.getDecision(h.id);
    if (!d) continue;
    const root = lineageRoot(h, byId);
    const primary = d.objectiveDeltas["primary"] ?? 0;
    measuredDelta.set(root, Math.max(measuredDelta.get(root) ?? -1, primary));
  }
  const recent = state
    .listHypotheses()
    .filter((h) => terminal.has(h.status) || h.status === "selected")
    .slice(-10);
  const freshShare = recent.length === 0 ? 1 : recent.filter((h) => h.parent === null).length / recent.length;

  const inputs: SelectInputs = {
    pool,
    evaluatedCounts,
    recentSelections: recent.map((h) => lineageRoot(h, byId)),
    measuredDelta,
  };

  const eligible = pool.filter((h) => lineageDepth(h, byId) <= policy.budgets.maxLineageDepth);
  if (eligible.length === 0) return null;

  const ranked = [...eligible].sort(
    (a, b) => scoreHypothesis(b, inputs, byId, policy.bandit.ucbC) - scoreHypothesis(a, inputs, byId, policy.bandit.ucbC),
  );
  if (freshShare < policy.bandit.explorationQuota) {
    const fresh = ranked.find((h) => h.parent === null);
    if (fresh) return fresh;
  }
  return ranked[0] ?? null;
}
