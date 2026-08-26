// SQLite-backed loop state + append-only journal. Every record is validated
// through the Zod schemas on both write and read, so a corrupted row fails
// loudly instead of leaking malformed data into the loop.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import {
  Evaluation,
  GateDecision,
  Hypothesis,
  JournalEntry,
} from "./schemas.js";
import type { HypothesisStatus } from "./schemas.js";
import { SUPER } from "./gitops.js";

// A verdict that reflects a tooling problem rather than evidence about the
// hypothesis: it must not count toward calibration or lineage scoring.
function isHarnessFailure(d: GateDecision): boolean {
  if (d.verdict === "blocked") return true;
  const r = d.reasons.join(" ").toLowerCase();
  return /\bstale\b|\bstopped\b|no changes|degenerate|wall exceeded|evaluation failed|no parseable json|disk guard/.test(r);
}

const DEFAULT_DB_PATH = join(SUPER, "research", "state.sqlite");

const PhaseTimings = z.record(z.string(), z.number());

/** One row of the iterations table, decoded. Most recent first from queries. */
export interface IterationRecord {
  n: number;
  startedAt: string;
  finishedAt: string | null;
  phaseTimings: Record<string, number>;
  notes: string;
}

interface JsonRow {
  json: string;
}
interface StatusCountRow {
  status: string;
  count: number;
}
interface MetaRow {
  value: string;
}
interface MaxNRow {
  maxN: number | null;
}
interface IterationRow {
  n: number;
  started_at: string;
  finished_at: string | null;
  phase_timings_json: string | null;
  notes: string | null;
}

function todayWallKey(): string {
  return `wall-${new Date().toISOString().slice(0, 10)}`;
}

export class LoopState {
  private readonly db: Database.Database;
  /** Sibling of the DB file - ROOT/research/journal.jsonl for the default
   * path, and a test-local file when a test passes its own dbPath. */
  private readonly journalPath: string;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.journalPath = join(dirname(dbPath), "journal.jsonl");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    // Wait rather than fail when the daemon and an operator CLI reach the
    // database at the same time.
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hypotheses (
        id TEXT PRIMARY KEY,
        kind TEXT,
        status TEXT,
        parent TEXT,
        created_at TEXT,
        json TEXT
      );
      CREATE TABLE IF NOT EXISTS evaluations (
        id TEXT PRIMARY KEY,
        hypothesis_id TEXT,
        fidelity TEXT,
        created_at TEXT,
        json TEXT
      );
      CREATE TABLE IF NOT EXISTS decisions (
        hypothesis_id TEXT PRIMARY KEY,
        created_at TEXT,
        json TEXT
      );
      CREATE TABLE IF NOT EXISTS iterations (
        n INTEGER PRIMARY KEY,
        started_at TEXT,
        finished_at TEXT,
        phase_timings_json TEXT,
        notes TEXT
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  // -- hypotheses -----------------------------------------------------------

  upsertHypothesis(h: Hypothesis): void {
    const v = Hypothesis.parse(h);
    this.db
      .prepare<[string, string, string, string | null, string, string]>(
        `INSERT INTO hypotheses (id, kind, status, parent, created_at, json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           status = excluded.status,
           parent = excluded.parent,
           created_at = excluded.created_at,
           json = excluded.json`,
      )
      .run(v.id, v.kind, v.status, v.parent, v.createdAtIso, JSON.stringify(v));
  }

  getHypothesis(id: string): Hypothesis | null {
    const row = this.db
      .prepare<[string], JsonRow>("SELECT json FROM hypotheses WHERE id = ?")
      .get(id);
    if (row === undefined) return null;
    const raw: unknown = JSON.parse(row.json);
    return Hypothesis.parse(raw);
  }

  listHypotheses(status?: HypothesisStatus): Hypothesis[] {
    const rows =
      status === undefined
        ? this.db
            .prepare<[], JsonRow>(
              "SELECT json FROM hypotheses ORDER BY created_at DESC, id DESC",
            )
            .all()
        : this.db
            .prepare<[string], JsonRow>(
              "SELECT json FROM hypotheses WHERE status = ? ORDER BY created_at DESC, id DESC",
            )
            .all(status);
    return rows.map((r) => {
      const raw: unknown = JSON.parse(r.json);
      return Hypothesis.parse(raw);
    });
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare<[], StatusCountRow>(
        "SELECT status, COUNT(*) AS count FROM hypotheses GROUP BY status",
      )
      .all();
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r.count;
    return out;
  }

  // -- evaluations ----------------------------------------------------------

  addEvaluation(e: Evaluation): void {
    const v = Evaluation.parse({ ...e, epoch: e.epoch ?? this.currentEpoch() });
    this.db
      .prepare<[string, string, string, string, string]>(
        `INSERT INTO evaluations (id, hypothesis_id, fidelity, created_at, json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           hypothesis_id = excluded.hypothesis_id,
           fidelity = excluded.fidelity,
           created_at = excluded.created_at,
           json = excluded.json`,
      )
      .run(v.id, v.hypothesisId, v.fidelity, v.startedAtIso, JSON.stringify(v));
  }

  evaluationsFor(hypothesisId: string): Evaluation[] {
    const rows = this.db
      .prepare<[string], JsonRow>(
        "SELECT json FROM evaluations WHERE hypothesis_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(hypothesisId);
    return rows.map((r) => {
      const raw: unknown = JSON.parse(r.json);
      return Evaluation.parse(raw);
    });
  }

  allEvaluations(): Evaluation[] {
    const rows = this.db
      .prepare<[], JsonRow>(
        "SELECT json FROM evaluations ORDER BY created_at ASC, id ASC",
      )
      .all();
    return rows.map((r) => {
      const raw: unknown = JSON.parse(r.json);
      return Evaluation.parse(raw);
    });
  }

  // -- decisions ------------------------------------------------------------

  setDecision(d: GateDecision): void {
    const v = GateDecision.parse({
      ...d,
      epoch: d.epoch ?? this.currentEpoch(),
      harnessFailure: d.harnessFailure ?? isHarnessFailure(d),
    });
    this.db
      .prepare<[string, string, string]>(
        `INSERT INTO decisions (hypothesis_id, created_at, json)
         VALUES (?, ?, ?)
         ON CONFLICT(hypothesis_id) DO UPDATE SET
           created_at = excluded.created_at,
           json = excluded.json`,
      )
      .run(v.hypothesisId, new Date().toISOString(), JSON.stringify(v));
  }

  getDecision(hypothesisId: string): GateDecision | null {
    const row = this.db
      .prepare<[string], JsonRow>(
        "SELECT json FROM decisions WHERE hypothesis_id = ?",
      )
      .get(hypothesisId);
    if (row === undefined) return null;
    const raw: unknown = JSON.parse(row.json);
    return GateDecision.parse(raw);
  }

  // -- iterations -----------------------------------------------------------

  /** Allocate the next iteration number and record its start time. */
  // Run fn inside an IMMEDIATE transaction: the write lock is taken up front,
  // so a concurrent writer waits (up to busy_timeout) rather than racing.
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  beginIteration(): number {
    return this.transaction((): number => {
      const row = this.db
        .prepare<[], MaxNRow>("SELECT MAX(n) AS maxN FROM iterations")
        .get();
      const n = (row?.maxN ?? 0) + 1;
      this.db
        .prepare<[number, string]>(
          "INSERT INTO iterations (n, started_at) VALUES (?, ?)",
        )
        .run(n, new Date().toISOString());
      return n;
    });
  }

  finishIteration(
    n: number,
    timings: Record<string, number>,
    notes: string,
  ): void {
    this.db
      .prepare<[string, string, string, number]>(
        "UPDATE iterations SET finished_at = ?, phase_timings_json = ?, notes = ? WHERE n = ?",
      )
      .run(new Date().toISOString(), JSON.stringify(timings), notes, n);
  }

  /** Most recent iterations first. */
  recentIterations(limit = 15): IterationRecord[] {
    const rows = this.db
      .prepare<[number], IterationRow>(
        "SELECT n, started_at, finished_at, phase_timings_json, notes FROM iterations ORDER BY n DESC LIMIT ?",
      )
      .all(limit);
    return rows.map((r) => {
      let phaseTimings: Record<string, number> = {};
      if (r.phase_timings_json !== null) {
        const raw: unknown = JSON.parse(r.phase_timings_json);
        const parsed = PhaseTimings.safeParse(raw);
        if (parsed.success) phaseTimings = parsed.data;
      }
      return {
        n: r.n,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        phaseTimings,
        notes: r.notes ?? "",
      };
    });
  }

  // -- meta -----------------------------------------------------------------

  // Comparability epoch: results from a prior epoch (a protocol or gate
  // change) do not steer forward selection. Bumped by the operator when such
  // a change lands.
  currentEpoch(): number {
    return Number(this.getMeta("epoch") ?? "1");
  }

  bumpEpoch(): number {
    const e = this.currentEpoch() + 1;
    this.setMeta("epoch", String(e));
    return e;
  }

  getMeta(key: string): string | null {
    const row = this.db
      .prepare<[string], MetaRow>("SELECT value FROM meta WHERE key = ?")
      .get(key);
    return row === undefined ? null : row.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare<[string, string]>(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /** Add to today's wall-clock ledger (`wall-YYYY-MM-DD`, UTC); returns the
   * new total for today in seconds. */
  addDailyWallSeconds(seconds: number): number {
    const key = todayWallKey();
    const prevRaw = Number(this.getMeta(key) ?? "0");
    const prev = Number.isFinite(prevRaw) ? prevRaw : 0;
    const total = prev + seconds;
    this.setMeta(key, String(total));
    return total;
  }

  getDailyWallSeconds(): number {
    const raw = Number(this.getMeta(todayWallKey()) ?? "0");
    return Number.isFinite(raw) ? raw : 0;
  }

  // -- journal --------------------------------------------------------------

  /** Validate and append one JSON line to journal.jsonl (append-only). */
  appendJournal(entry: JournalEntry): void {
    const v = JournalEntry.parse(entry);
    const line = JSON.stringify(v) + "\n";
    // The append runs under the database write lock so the daemon and an
    // operator CLI cannot interleave partial lines (entries exceed the
    // filesystem's atomic-append bound).
    this.transaction(() => { appendFileSync(this.journalPath, line); });
  }

  close(): void {
    this.db.close();
  }
}
