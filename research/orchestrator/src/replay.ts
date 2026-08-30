// Offline replay of the recorded decisions through the live decision code.
// Every verdict is recomputed from the evaluations that were actually run, so
// it costs no explore time and answers one question: which historical
// decisions does today's gate make differently, and which of those were the
// ones the change was for.
//
// Run: npx tsx src/replay.ts [--assert] [--all]
//
// What it cannot do. The rule decides when to stop sampling, so a candidate
// the new rule would carry past the last chunk the record holds has no
// offline verdict: there is no chunk to give it. Those are reported as
// "unresolved", which is the honest answer and is also the interesting one -
// a chunk-1 rejection that becomes "keep sampling" is a rejection undone.
//
// The mid-run stopper is a model call and is not replayable at all, so this
// replays the rule alone and counts the chunks where no rail bound - the
// chunks the stopper would have been asked about, and the only ones whose
// outcome it could have changed.
import Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { ROOT } from "./paths.js";
import { loadPolicy } from "./policy.js";
import { CAMPAIGN_EPOCH_FLOOR, MERGE_Z, finalGate, judgedByNonInferiority, type RatePrior } from "./decide.js";
import { firingCheck } from "./firing.js";
import { decideSequential, pooledCountsOf, railVerdict, seqRuleOf, throughputRatioOf, type SeqKind } from "./sequential.js";
import { Evaluation, type Hypothesis } from "./schemas.js";

type Terminal = "merge" | "human" | "closed" | "blocked" | "unresolved";

interface Row { hypothesisId: string; createdAt: string; e: Evaluation }
interface Entry { atIso: string; iteration: number; event: string; data: Record<string, unknown> }

const DB_PATH = path.join(ROOT, "research/state.sqlite");
const JOURNAL_PATH = path.join(ROOT, "research/journal.jsonl");

function loadRows(): Row[] {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const raw = db
      .prepare<[], { hypothesis_id: string; created_at: string; json: string }>(
        "SELECT hypothesis_id, created_at, json FROM evaluations WHERE fidelity = 'sequential' ORDER BY created_at ASC, id ASC",
      )
      .all();
    const out: Row[] = [];
    for (const r of raw) {
      const p = Evaluation.safeParse(JSON.parse(r.json));
      if (p.success) out.push({ hypothesisId: r.hypothesis_id, createdAt: r.created_at, e: p.data });
    }
    return out;
  } finally { db.close(); }
}

function loadJournal(): Entry[] {
  const out: Entry[] = [];
  for (const line of readFileSync(JOURNAL_PATH, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const d = JSON.parse(line) as Entry;
      if (typeof d.atIso === "string" && typeof d.event === "string") out.push(d);
    } catch { /* a truncated tail line is not a record */ }
  }
  return out;
}

/** The baseline chunks a recorded baseline_sequential event pooled, found by
 *  matching its recorded counts against the evaluations written before it.
 *  Verified on runs and depth>=4, so a wrong window is a miss, not a guess. */
function baselineFor(counts: Record<string, number>, chunks: number, atIso: string, ok: Row[]): Evaluation[] | null {
  let end = 0;
  while (end < ok.length && (ok[end] as Row).createdAt <= atIso) end++;
  const runsOf = (r: Row): number => r.e.metrics.runs;
  const d4Of = (r: Row): number => r.e.metrics.depthAtLeast[3] ?? 0;
  for (let s = end - chunks; s >= 0; s--) {
    const w = ok.slice(s, s + chunks);
    const runs = w.reduce((a, r) => a + runsOf(r), 0);
    const d4 = w.reduce((a, r) => a + d4Of(r), 0);
    if (runs === counts["runs"] && d4 === counts["depth4"]) return w.map((r) => r.e);
  }
  return null;
}

/** The rayon thread count a set of chunks was measured at, or null when the
 *  record does not say or the set is mixed. Runs share a feedback map across
 *  the parallel set, so a candidate and a baseline at different counts are
 *  not comparable and the loop keys its baselines by it. */
function threadsOf(evals: Evaluation[]): number | null {
  const seen = new Set(evals.map((e) => e.rayonThreads).filter((t): t is number => t !== undefined));
  return seen.size === 1 ? ([...seen][0] as number) : null;
}

function priorAt(ok: Row[], atIso: string): RatePrior | null {
  let violations = 0, runs = 0, chunks = 0;
  for (const r of ok) {
    if (r.createdAt > atIso) break;
    if ((r.e.epoch ?? 0) < CAMPAIGN_EPOCH_FLOOR) continue;
    violations += r.e.metrics.violations;
    runs += r.e.metrics.runs;
    chunks += 1;
  }
  return runs > 0 ? { violations, runs, chunks, sinceEpoch: CAMPAIGN_EPOCH_FLOOR } : null;
}

function recordedTerminal(verdict: string): Terminal {
  if (verdict === "auto_merge") return "merge";
  if (verdict === "needs_human") return "human";
  if (verdict === "blocked") return "blocked";
  return "closed";
}

interface Case {
  iteration: number;
  id: string;
  kind: string;
  old: Terminal;
  oldReason: string;
  next: Terminal;
  nextReason: string;
  chunksRecorded: number;
  chunksUsed: number;
  suiteAssumed: boolean;
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  if (!existsSync(DB_PATH) || !existsSync(JOURNAL_PATH)) {
    console.log("no recorded state to replay; run the loop first");
    return;
  }
  const { policy } = loadPolicy(path.join(ROOT, "research/policy.json"));
  const rows = loadRows();
  const ok = rows.filter((r) => r.e.ok && r.e.timingAnomaly === null);
  const journal = loadJournal();

  // Baselines, newest last, each verified against its recorded counts. The
  // operator-run ones come from their evidence files: `cli baseline` writes
  // no journal entry, and the host changed thread count twice inside the
  // recorded window, so without them a 30-thread candidate is compared with
  // whatever 14-thread baseline came before it.
  const baselines: Array<{ atIso: string; evals: Evaluation[]; threads: number | null }> = [];
  for (const f of readdirSync(path.join(ROOT, "research/evaluations")).filter((x) => /^000-baseline.*\.json$/.test(x))) {
    try {
      const d = JSON.parse(readFileSync(path.join(ROOT, "research/evaluations", f), "utf8")) as { baseline?: { sequential?: unknown[] } };
      const evals = (d.baseline?.sequential ?? []).map((x) => Evaluation.safeParse(x)).flatMap((p) => (p.success ? [p.data] : []));
      if (evals.length === 0) continue;
      const atIso = evals.reduce((a, e) => (e.startedAtIso > a ? e.startedAtIso : a), "");
      baselines.push({ atIso, evals, threads: threadsOf(evals) });
    } catch { /* an unreadable evidence file is not a baseline */ }
  }
  let baselineMisses = 0;
  for (const j of journal) {
    if (j.event !== "baseline_sequential") continue;
    const d = j.data as { chunks: number; counts: Record<string, number> };
    const evals = baselineFor(d.counts, d.chunks, j.atIso, ok);
    if (evals === null) { baselineMisses++; continue; }
    baselines.push({ atIso: j.atIso, evals, threads: threadsOf(evals) });
  }
  baselines.sort((a, b) => a.atIso.localeCompare(b.atIso));

  // One record per iteration that sampled.
  const byIter = new Map<number, Partial<Record<string, Entry>>>();
  for (const j of journal) {
    const slot = byIter.get(j.iteration) ?? {};
    slot[j.event] = j;
    byIter.set(j.iteration, slot);
  }

  const cases: Case[] = [];
  const skipped: string[] = [];
  let stopperChunks = 0;
  for (const [iteration, slot] of [...byIter.entries()].sort((a, b) => a[0] - b[0])) {
    const sel = slot["select"], seq = slot["sequential"], dec = slot["decision"];
    if (!sel || !seq) continue;
    const id = String((sel.data as { id?: string }).id ?? "");
    const kind = String((sel.data as { kind?: string }).kind ?? "");
    const mine = rows.filter((r) => r.hypothesisId === id && r.createdAt >= sel.atIso && r.createdAt <= seq.atIso);
    if (mine.length === 0) continue;
    if ((mine[0] as Row).e.epoch !== undefined && ((mine[0] as Row).e.epoch ?? 0) < CAMPAIGN_EPOCH_FLOOR) continue;

    // Same thread count or no comparison. The host moved between 14 and 30
    // twice inside the recorded window, and a baseline from the other mask
    // reads a level candidate as a third slower.
    const candThreads = threadsOf(mine.map((r) => r.e));
    const earlier = [...baselines].reverse().filter((b) => b.atIso <= sel.atIso);
    const base = candThreads === null
      ? earlier[0]
      : earlier.find((b) => b.threads === candThreads) ?? earlier.find((b) => b.threads === null);
    if (base === undefined) { skipped.push(`${iteration}: no reconstructed baseline at ${candThreads ?? "an unrecorded"} threads precedes it`); continue; }
    const basePooled = pooledCountsOf(base.evals);
    const prior = priorAt(ok, sel.atIso);
    const rule = { ...seqRuleOf(policy, prior), maxChunks: Math.max(policy.sequential.maxChunks, mine.length) };
    const seqKind: SeqKind = judgedByNonInferiority(kind as Hypothesis["kind"]) ? "noninferiority" : "superiority";

    // Replay the stopping rule chunk by chunk over the chunks the record holds.
    let verdict = "continue";
    let reason = "the record ends before the rule decided";
    let used = 0;
    const taken: Evaluation[] = [];
    for (const r of mine) {
      if (!r.e.ok) continue;
      taken.push(r.e);
      used++;
      const d = decideSequential(pooledCountsOf(taken), basePooled, used, seqKind, rule);
      if (railVerdict(d, pooledCountsOf(taken), basePooled, used, seqKind, rule) === null) stopperChunks++;
      verdict = d.verdict;
      reason = d.reason;
      if (verdict !== "continue") break;
    }

    const oldVerdict: Terminal = dec === undefined ? "unresolved" : recordedTerminal(String((dec.data as { verdict?: string }).verdict ?? ""));
    let next: Terminal;
    let nextReason = reason;
    let suiteAssumed = false;
    if (verdict === "continue") {
      next = "unresolved";
    } else if (verdict === "reject" || verdict === "inconclusive") {
      next = "closed";
    } else {
      // advance or escalate: the merge gate decides, on the evidence the
      // sample produced. An escalate is a human review whatever the gate says.
      const recorded = (dec?.data ?? {}) as { regressionPassed?: boolean | null; lintPassed?: boolean };
      const regr = slot["regression"]?.data as { passed?: boolean } | undefined;
      const regressionPassed = regr?.passed ?? recorded.regressionPassed ?? true;
      suiteAssumed = regr === undefined && (recorded.regressionPassed === null || recorded.regressionPassed === undefined);
      const cand = taken.filter((e) => e.ok);
      const g = finalGate({
        hypothesis: { id, kind } as Hypothesis,
        confirmEvals: cand,
        baselineEvals: base.evals,
        regressionPassed,
        lintFailures: recorded.lintPassed === false ? ["(recorded lint failure)"] : [],
        changedSpurFiles: filesFor(iteration, id).spur,
        changedSuperFiles: filesFor(iteration, id).super,
        throughputRatio: throughputRatioOf(pooledCountsOf(cand), basePooled),
        throughputFloor: 1 - policy.regression.throughputTolerance,
        violationPrior: prior,
        unmeasurable: [],
        // Nothing in the record carries a prediction, so the firing check
        // has nothing to grade against and cannot change a replayed verdict.
        firing: firingCheck({ prediction: null, counters: {}, changedSpurFiles: [], configPaths: null }),
      });
      next = verdict === "escalate" ? "human" : recordedTerminal(g.verdict);
      nextReason = verdict === "escalate" ? reason : g.reasons.join("; ");
    }
    cases.push({
      iteration, id, kind, old: oldVerdict,
      oldReason: dec === undefined ? "(the record has no decision for this iteration)" : String(((dec.data as { reasons?: string[] }).reasons ?? []).join("; ")).slice(0, 90),
      next, nextReason: nextReason.slice(0, 90),
      chunksRecorded: mine.length, chunksUsed: used, suiteAssumed,
    });
  }

  report(cases, skipped, baselineMisses, stopperChunks, args.has("--all"), args.has("--assert"));
}

/** Files the hypothesis changed, from its evidence packet. Only merged and
 *  reviewed hypotheses have one; empty lists are the conservative reading,
 *  since that is what makes an ablation have to earn its throughput. */
function filesFor(iteration: number, id: string): { spur: string[]; super: string[] } {
  const p = path.join(ROOT, "research/evaluations", `${String(iteration).padStart(3, "0")}-${id}.json`);
  if (!existsSync(p)) return { spur: [], super: [] };
  try {
    const d = JSON.parse(readFileSync(p, "utf8")) as { spurFiles?: string[]; superFiles?: string[] };
    return { spur: d.spurFiles ?? [], super: d.superFiles ?? [] };
  } catch { return { spur: [], super: [] }; }
}

// The decisions this migration was built to change, and what each must do.
// A case named here that is absent from the replay is itself a failure: it
// means the record no longer contains what the claim was made about.
const EXPECTED: Array<{ iteration: number; want: (c: Case) => boolean; why: string }> = [
  // The depth>=4 decisive reject, deleted. Each of these was killed at chunk 1
  // on a per-run ratio while its per-second rate was up. None may still close.
  ...[5312, 5317, 5318, 5319, 5323, 5335, 5351, 5364].map((iteration) => ({
    iteration, want: (c: Case): boolean => c.next !== "closed",
    why: "killed at chunk 1 by the depth>=4 per-run guard",
  })),
  // The h2 decisive reject, deleted.
  ...[5327, 5362].map((iteration) => ({
    iteration, want: (c: Case): boolean => c.next !== "closed",
    why: "killed at chunk 1 by the h2 guard",
  })),
  // The advance the primary-rung test exists to stop.
  { iteration: 5369, want: (c: Case): boolean => c.next !== "merge", why: "depth>=6 pGreater 0.000 on the non-inferiority path" },
  // A real separated gain must survive every deletion above.
  { iteration: 5361, want: (c: Case): boolean => c.next === "merge", why: "depth>=6 per second separated at z 2.7" },
  // A candidate that found a violation must not be held to a stricter
  // standard for having found one.
  { iteration: 5328, want: (c: Case): boolean => c.next === "merge", why: "non-inferior with one violation the baseline did not have" },
];

function report(cases: Case[], skipped: string[], baselineMisses: number, stopperChunks: number, all: boolean, assert: boolean): void {
  const kinds: Terminal[] = ["merge", "human", "closed", "blocked", "unresolved"];
  const table = new Map<string, number>();
  for (const c of cases) table.set(`${c.old}|${c.next}`, (table.get(`${c.old}|${c.next}`) ?? 0) + 1);
  console.log(`replayed ${cases.length} recorded decisions from epoch ${CAMPAIGN_EPOCH_FLOOR} on, at MERGE_Z ${MERGE_Z}\n`);
  console.log(`old \\ new     ${kinds.map((k) => k.padStart(11)).join("")}`);
  for (const o of kinds) {
    const row = kinds.map((n) => String(table.get(`${o}|${n}`) ?? 0).padStart(11)).join("");
    console.log(`${o.padEnd(14)}${row}`);
  }
  const changed = cases.filter((c) => c.old !== c.next);
  console.log(`\n${changed.length} of ${cases.length} verdicts change.`);
  // Evidence gathered before the rate was stratified cannot be compared by a
  // rule that stratifies, so those rows say so rather than judging. They are
  // a property of the record's age, not of any change under test.
  const faulted = changed.filter((c) => c.nextReason.startsWith("the rate stratum cannot be compared"));
  if (faulted.length > 0) console.log(`${faulted.length} of those carry evidence from before the rate was stratified, so today's rule refuses to compare them: ${faulted.map((c) => c.iteration).join(", ")}.`);
  console.log(`${stopperChunks} chunk decisions had no rail bound, so the stopper would have been asked about them.`);
  const assumed = cases.filter((c) => c.suiteAssumed).length;
  if (assumed > 0) console.log(`${assumed} reached the gate on a regression suite that never ran in the record; those are replayed as if it passes.`);
  if (baselineMisses > 0) console.log(`${baselineMisses} recorded baselines could not be reconstructed from the evaluations table.`);
  if (skipped.length > 0) console.log(`${skipped.length} iterations skipped: ${skipped.slice(0, 3).join("; ")}${skipped.length > 3 ? " ..." : ""}`);

  const show = all ? cases : changed;
  if (show.length > 0) {
    console.log(`\n${all ? "every" : "changed"} decision:`);
    for (const c of show.sort((a, b) => a.iteration - b.iteration)) {
      console.log(`  ${String(c.iteration).padStart(5)} ${c.kind.padEnd(9)} ${c.old.padEnd(10)} -> ${c.next.padEnd(10)} ${c.chunksUsed}/${c.chunksRecorded} chunks | was: ${c.oldReason} | now: ${c.nextReason}`);
    }
  }

  const failures: string[] = [];
  console.log("\nacceptance:");
  for (const e of EXPECTED) {
    const c = cases.find((x) => x.iteration === e.iteration);
    if (c === undefined) { failures.push(`${e.iteration} is not in the replay (${e.why})`); console.log(`  MISSING ${e.iteration}: ${e.why}`); continue; }
    const good = e.want(c);
    if (!good) failures.push(`${e.iteration} ${c.id}: ${e.why}; got ${c.next} (${c.nextReason})`);
    console.log(`  ${good ? "ok  " : "FAIL"} ${String(e.iteration).padStart(5)} ${c.old} -> ${c.next.padEnd(10)} ${e.why}`);
  }
  // A merge the loop later re-measured and kept must not become a closure:
  // the migration is allowed to stop merging things, never to un-merge what
  // the record went on to confirm.
  for (const c of cases) {
    if (c.old === "merge" && c.next === "closed") failures.push(`${c.iteration} ${c.id}: a recorded merge now closes (${c.nextReason})`);
  }
  if (failures.length > 0) {
    console.log(`\n${failures.length} acceptance failures:\n  ${failures.join("\n  ")}`);
    if (assert) process.exit(1);
  } else {
    console.log("\nall acceptance conditions met");
  }
}

main();
