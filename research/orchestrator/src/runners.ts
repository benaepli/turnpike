// Typed process wrappers for the research loop. Every external tool is
// spawned via execFile (argv array, never a shell string) with a hard
// timeout that SIGKILLs. Nonzero exit is a *result*, not an exception -
// only spawn failures (ENOENT, EACCES, ...) throw.
import { execFile, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { TraceGradeJson, PorcupineJson } from "./schemas.js";

// This file lives at ROOT/research/orchestrator/{src,dist}/runners.*, so the
// repo root is three levels up in both the tsx (src) and compiled (dist) case.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const SPUR_BIN = path.join(ROOT, "spur", "target", "release", "spur");

// Resolve a repo-relative path (as used throughout research/policy.json)
// against ROOT; absolute paths pass through.
export function resolveRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024; // 64 MB

// Durations are measured with performance.now() (CLOCK_MONOTONIC: does not
// advance while the machine is suspended). suspendedMs = wall - active, so an
// evaluation that straddled a sleep is visible without corrupting its rates.
export interface CmdResult {
  suspendedMs?: number;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  wallMs: number;
  timedOut: boolean;
}

export interface RunOpts {
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

interface ExecFileError extends Error {
  code?: number | string | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

/**
 * Core helper: spawn `cmd` with `args`, hard-kill (SIGKILL) after
 * `opts.timeoutMs`. Resolves with a CmdResult for both success and failure
 * exits; rejects only when the process could not be spawned at all.
 */
export function run(cmd: string, args: string[], opts: RunOpts): Promise<CmdResult> {
  const startedAt = performance.now();
  const wallStartedAt = Date.now();
  return new Promise<CmdResult>((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd ?? ROOT,
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const wallMs = Math.round(performance.now() - startedAt);
        const suspendedMs = Math.max(0, (Date.now() - wallStartedAt) - wallMs);
        if (error === null) {
          resolve({ suspendedMs, ok: true, exitCode: 0, stdout, stderr, wallMs, timedOut: false });
          return;
        }
        const err = error as ExecFileError;
        // Timeout: node kills the child and reports killed + the kill signal.
        const timedOut = err.killed === true && err.signal === "SIGKILL" && err.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        if (timedOut) {
          resolve({ ok: false, exitCode: null, stdout, stderr, wallMs, timedOut: true });
          return;
        }
        // maxBuffer overflow: child was killed, but this is an output-size
        // failure, not a timeout.
        if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({ ok: false, exitCode: null, stdout, stderr, wallMs, timedOut: false });
          return;
        }
        // Spawn failure (ENOENT, EACCES, ...): errno-style string code with
        // no exit code. This is the only path that throws.
        if (typeof err.code === "string") {
          reject(err);
          return;
        }
        // Ordinary nonzero exit (numeric code) or death by external signal
        // (code null, signal set).
        const exitCode = typeof err.code === "number" ? err.code : null;
        resolve({ ok: false, exitCode, stdout, stderr, wallMs, timedOut: false });
      },
    );
  });
}

/** `cargo build --release` for the spur binary. On ok the binary is at SPUR_BIN. */
export function buildSpur(maxBuildSeconds: number): Promise<CmdResult> {
  return run(
    "cargo",
    ["build", "--release", "--manifest-path", "spur/Cargo.toml", "--bin", "spur"],
    { timeoutMs: maxBuildSeconds * 1000, cwd: ROOT },
  );
}

// Content hash of the committed spur tree; the build runs after the commit,
// so this keys a binary uniquely and safely (never the working tree).
export function spurTreeHash(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: path.join(ROOT, "spur"), encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function gcBinStore(store: string, keep: number): void {
  try {
    const entries = fs.readdirSync(store)
      .map((f) => ({ f, m: fs.statSync(path.join(store, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const e of entries.slice(keep)) { try { fs.rmSync(path.join(store, e.f)); } catch { /* best effort */ } }
  } catch { /* store may not exist yet */ }
}

// Build unless a binary for the committed spur tree is already stored; a
// hit copies it into place and skips the ~40s rebuild. The store keeps the
// most-recently-used few, which also serves as versioned rollback binaries.
export async function buildSpurCached(maxBuildSeconds: number): Promise<{ result: CmdResult; cached: boolean; treeHash: string }> {
  const treeHash = spurTreeHash();
  if (!treeHash) return { result: await buildSpur(maxBuildSeconds), cached: false, treeHash: "" };
  const store = path.join(ROOT, "tmp", "loop", "binstore");
  fs.mkdirSync(store, { recursive: true });
  const cachedBin = path.join(store, treeHash);
  if (fs.existsSync(cachedBin)) {
    fs.copyFileSync(cachedBin, SPUR_BIN);
    const now = new Date();
    try { fs.utimesSync(cachedBin, now, now); } catch { /* touch is advisory */ }
    return { result: { ok: true, exitCode: 0, stdout: "binary cache hit", stderr: "", wallMs: 0, timedOut: false }, cached: true, treeHash };
  }
  const result = await buildSpur(maxBuildSeconds);
  if (result.ok && fs.existsSync(SPUR_BIN)) {
    try { fs.copyFileSync(SPUR_BIN, cachedBin); gcBinStore(store, 6); } catch { /* cache is best effort */ }
  }
  return { result, cached: false, treeHash };
}

export interface ConfigOverrides {
  runsPerConfig?: number;
  sessionSeed?: number;
  extra?: Record<string, unknown>;
}

/**
 * Read a JSON explorer-config template, apply overrides
 * (`num_runs_per_config`, `session_seed`, then `extra` spread on top), and
 * write the result to `outPath`.
 */
export function materializeConfig(templatePath: string, outPath: string, overrides: ConfigOverrides): void {
  const raw: unknown = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`config template ${templatePath} is not a JSON object`);
  }
  const config: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (overrides.runsPerConfig !== undefined) config["num_runs_per_config"] = overrides.runsPerConfig;
  if (overrides.sessionSeed !== undefined) config["session_seed"] = overrides.sessionSeed;
  if (overrides.extra !== undefined) Object.assign(config, overrides.extra);
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n");
}

export interface ExploreOpts {
  binary: string;
  configPath: string;
  spec: string;
  outputDir: string;
  wallSec: number;
  rayonThreads: number;
}

/**
 * Run the explorer. NOTE for callers: a timedOut result is NOT a failure -
 * the explorer writes parquet incrementally, so a timed-out output dir is a
 * valid partial corpus and should still be graded/checked.
 */
export function explore(opts: ExploreOpts): Promise<CmdResult> {
  // Output streams to <outputDir>.log so a running explore can be watched
  // with tail -f.
  const logPath = `${opts.outputDir}.log`;
  const args = ["explore", "-e", "standard", "--config", opts.configPath, "-y", "--output-dir", opts.outputDir, opts.spec];
  const env = {
    ...process.env,
    RAYON_NUM_THREADS: String(opts.rayonThreads),
    RUST_LOG: "info",
  };
  return new Promise<CmdResult>((resolve, reject) => {
    const started = performance.now();
    const wallStarted = Date.now();
    let fd: number;
    try {
      fd = fs.openSync(logPath, "w");
    } catch (e) {
      reject(new Error(`cannot open explore log ${logPath}: ${String(e)}`));
      return;
    }
    const child = spawn(opts.binary, args, { cwd: ROOT, env, stdio: ["ignore", fd, fd] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.wallSec * 1000 + 30_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      fs.closeSync(fd);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      fs.closeSync(fd);
      let tailText = "";
      try {
        const full = fs.readFileSync(logPath, "utf8");
        tailText = full.slice(-8192);
      } catch { /* log unreadable - leave tail empty */ }
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        stdout: "",
        stderr: tailText,
        wallMs: Math.round(performance.now() - started),
        suspendedMs: Math.max(0, (Date.now() - wallStarted) - Math.round(performance.now() - started)),
        timedOut,
      });
    });
  });
}

export interface GradeOpts {
  inputDir: string;
  dagConfigs: string[];
  maxRuns: number;
  budgetMs: number;
  timeoutMs: number;
}

/** Run traceanalyzer in grade mode; parse stdout with the TraceGradeJson schema. */
export async function grade(opts: GradeOpts): Promise<{ cmd: CmdResult; parsed: TraceGradeJson | null }> {
  const cmd = await run(
    path.join(ROOT, "traceanalyzer", "main"),
    [
      "-input", opts.inputDir,
      "-grade",
      "-dag-config", opts.dagConfigs.join(","),
      "-grade-max-runs", String(opts.maxRuns),
      "-grade-budget-ms", String(opts.budgetMs),
      "-format", "json",
    ],
    { timeoutMs: opts.timeoutMs, cwd: ROOT },
  );
  return { cmd, parsed: parseJsonWith(TraceGradeJson, cmd.stdout) };
}

export interface PorcupineOpts {
  inputDir: string;
  model: "kv" | "kv_rmw";
  timeoutMsPerRun: number;
  timeoutMs: number;
}

/**
 * Run the porcupine batch checker. Exit codes 0 (all ok), 2 (violations) and
 * 4 (unknowns) all carry valid JSON on stdout; exit 3 means zero runs were
 * found and `parsed` is legitimately null.
 */
export async function porcupine(opts: PorcupineOpts): Promise<{ cmd: CmdResult; parsed: PorcupineJson | null }> {
  const cmd = await run(
    path.join(ROOT, "porcupine", "batch"),
    ["-input", opts.inputDir, "-model", opts.model, "-timeout", String(opts.timeoutMsPerRun)],
    { timeoutMs: opts.timeoutMs, cwd: ROOT },
  );
  return { cmd, parsed: parseJsonWith(PorcupineJson, cmd.stdout) };
}

function parseJsonWith<T>(schema: z.ZodType<T>, text: string): T | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

/** Free disk space at `p`, in GiB. */
export function freeDiskGb(p: string): number {
  const stat = fs.statfsSync(p);
  return (stat.bavail * stat.bsize) / (1024 ** 3);
}

const CLEANUP_ROOT = path.join(ROOT, "tmp", "loop");

/**
 * rm -rf `dir`, but refuse (throw) unless the resolved absolute path is
 * strictly under ROOT/tmp/loop/.
 */
export function cleanupDir(dir: string): void {
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(CLEANUP_ROOT + path.sep) || resolved === CLEANUP_ROOT) {
    throw new Error(`cleanupDir refused: ${resolved} is not under ${CLEANUP_ROOT}${path.sep}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
