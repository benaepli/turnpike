// Typed git/gh operations for the research loop. Every command goes through
// execFileSync with an argv array — no shell strings, no interpolation into a
// shell. Read-mostly helpers return parsed values; mutating helpers throw
// GitError on unexpected failure.
import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { HypothesisKind } from "./schemas.js";

/** Absolute path of the superproject (github.com/benaepli/jennLang). */
export const SUPER = "/home/benaepli/Research/alt/jennLang";
/** Absolute path of the spur submodule checkout (github.com/benaepli/spur). */
export const SPUR = SUPER + "/spur";

const MAX_BUFFER = 64 * 1024 * 1024;
const DIFF_CAP_BYTES = 400 * 1024;

export class GitError extends Error {
  constructor(
    readonly cmd: string,
    readonly stderr: string,
  ) {
    super(`command failed: ${cmd}\n${stderr}`);
    this.name = "GitError";
  }
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function toText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Buffer) return v.toString("utf8");
  return "";
}

/** Run git/gh with argv, never throwing; failures come back as { ok: false }. */
function exec(bin: "git" | "gh", args: string[], cwd: string): ExecResult {
  try {
    const stdout = execFileSync(bin, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return {
      ok: false,
      stdout: toText(e.stdout),
      stderr: toText(e.stderr) || toText(e.message),
    };
  }
}

/** Like exec, but a non-zero exit is unexpected: throws GitError. */
function must(bin: "git" | "gh", args: string[], cwd: string): string {
  const r = exec(bin, args, cwd);
  if (!r.ok) {
    throw new GitError(`${bin} ${args.join(" ")} (cwd=${cwd})`, r.stderr);
  }
  return r.stdout;
}

function statusLines(repo: string): string[] {
  return must("git", ["status", "--porcelain"], repo)
    .split("\n")
    .filter((l) => l.length > 0);
}

/**
 * Throw unless the working tree is clean. For SUPER, pass
 * allowSubmoduleDirty to ignore a dirty spur submodule pointer (the exact
 * porcelain line ` M spur`), which is expected mid-hypothesis.
 */
export function ensureClean(repo: string, allowSubmoduleDirty = false): void {
  let lines = statusLines(repo);
  if (allowSubmoduleDirty) {
    lines = lines.filter((l) => l !== " M spur");
  }
  if (lines.length > 0) {
    throw new GitError(
      `git status --porcelain (cwd=${repo})`,
      `working tree not clean:\n${lines.join("\n")}`,
    );
  }
}

export function currentCommit(repo: string): string {
  return must("git", ["rev-parse", "HEAD"], repo).trim();
}

export function currentBranch(repo: string): string {
  return must("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo).trim();
}

export function checkout(repo: string, ref: string): void {
  must("git", ["checkout", ref], repo);
}

/** Create a branch (without switching to it). `from` defaults to HEAD. */
export function createBranch(repo: string, name: string, from?: string): void {
  const args = from === undefined ? ["branch", name] : ["branch", name, from];
  must("git", args, repo);
}

export function deleteBranch(repo: string, name: string): void {
  must("git", ["branch", "-D", name], repo);
}

/**
 * `git add -A` + commit with the standard trailer. Returns the new commit
 * sha, or the current HEAD sha if there was nothing to commit.
 */
export function commitAll(repo: string, message: string): string {
  must("git", ["add", "-A"], repo);
  // `diff --cached --quiet` exits 0 iff nothing is staged.
  if (exec("git", ["diff", "--cached", "--quiet"], repo).ok) {
    return currentCommit(repo);
  }
  const full = `${message}\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>`;
  must("git", ["commit", "-m", full], repo);
  return currentCommit(repo);
}

export function resetHard(repo: string, ref: string): void {
  must("git", ["reset", "--hard", ref], repo);
}

/** Files changed on HEAD since it diverged from baseRef (three-dot diff). */
export function changedFiles(repo: string, baseRef: string): string[] {
  return must("git", ["diff", "--name-only", `${baseRef}...HEAD`], repo)
    .split("\n")
    .filter((l) => l.length > 0);
}

/** Full diff `baseRef...HEAD`, capped at 400KB with a truncation note. */
export function diffText(repo: string, baseRef: string): string {
  const out = must("git", ["diff", `${baseRef}...HEAD`], repo);
  if (Buffer.byteLength(out, "utf8") <= DIFF_CAP_BYTES) return out;
  const capped = Buffer.from(out, "utf8")
    .subarray(0, DIFF_CAP_BYTES)
    .toString("utf8");
  return `${capped}\n\n[diff truncated at ${DIFF_CAP_BYTES} bytes]\n`;
}

export function push(
  repo: string,
  branch: string,
  opts?: { setUpstream?: boolean },
): void {
  // The loop only publishes its own branches; refuse anything else.
  if (!/^(research\/vr-loop|hyp\/)/.test(branch)) {
    throw new GitError(`push refused: branch ${branch} is not loop-owned`, "policy");
  }
  const args =
    opts?.setUpstream === true
      ? ["push", "-u", "origin", branch]
      : ["push", "origin", branch];
  must("git", args, repo);
}

export function tag(repo: string, name: string): void {
  must("git", ["tag", name], repo);
}

export function pushTag(repo: string, name: string): void {
  must("git", ["push", "origin", `refs/tags/${name}`], repo);
}

/**
 * Commit a hypothesis' changes as a submodule/superproject pair:
 *   1. ensure SUPER is on opts.branch (the caller manages SPUR's branch);
 *   2. if SPUR is dirty, commit everything there (spurCommit; null if clean);
 *   3. in SUPER, stage the spur pointer plus all other changes and commit.
 */
export function commitHypothesisPair(opts: {
  branch: string;
  spurMessage: string;
  superMessage: string;
}): { spurCommit: string | null; superCommit: string } {
  if (currentBranch(SUPER) !== opts.branch) {
    checkout(SUPER, opts.branch);
  }
  let spurCommit: string | null = null;
  if (statusLines(SPUR).length > 0) {
    // Commit on the hypothesis branch (pre-created by createBranch), never on
    // the research branch itself — otherwise changedFiles(SPUR, research)
    // compares the branch to itself and reports an empty diff.
    if (currentBranch(SPUR) !== opts.branch) {
      checkout(SPUR, opts.branch);
    }
    spurCommit = commitAll(SPUR, opts.spurMessage);
  }
  // Stage the submodule pointer explicitly (no-op when spur is unchanged);
  // commitAll then adds the rest and commits (or no-ops if nothing changed).
  must("git", ["add", "spur"], SUPER);
  const superCommit = commitAll(SUPER, opts.superMessage);
  return { spurCommit, superCommit };
}

// ---------------------------------------------------------------------------
// gh helpers
// ---------------------------------------------------------------------------

function extractUrl(stdout: string): string {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const url = lines.find((l) => /^https?:\/\//.test(l)) ?? lines.at(-1);
  if (url === undefined) {
    throw new GitError("gh pr create", `no URL in output:\n${stdout}`);
  }
  return url;
}

/**
 * Create a PR and return its URL. If a label is requested but the repo does
 * not have it, gh fails — we retry once without the label.
 */
export function createPr(opts: {
  cwd: string;
  base: string;
  head: string;
  title: string;
  body: string;
  label?: string;
}): string {
  const baseArgs = [
    "pr",
    "create",
    "--base",
    opts.base,
    "--head",
    opts.head,
    "--title",
    opts.title,
    "--body",
    opts.body,
  ];
  if (opts.label !== undefined) {
    const r = exec("gh", [...baseArgs, "--label", opts.label], opts.cwd);
    if (r.ok) return extractUrl(r.stdout);
    if (!/label/i.test(r.stderr)) {
      throw new GitError(`gh pr create --label ${opts.label}`, r.stderr);
    }
    // Label-related failure (e.g. label missing in repo): fall through and
    // retry without the label.
  }
  return extractUrl(must("gh", baseArgs, opts.cwd));
}

/** Squash-merge a PR, keeping the branch. Returns false on any failure. */
export function mergePrSquash(cwd: string, url: string): boolean {
  return exec("gh", ["pr", "merge", "--squash", "--delete-branch=false", url], cwd)
    .ok;
}

const PrListJson = z.array(z.object({ url: z.string() }));

/** URL of an open PR whose head is `head`, or null if none exists. */
export function prExistsFor(cwd: string, head: string): string | null {
  const out = must("gh", ["pr", "list", "--head", head, "--json", "url"], cwd);
  const raw: unknown = JSON.parse(out);
  const parsed = PrListJson.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data[0]?.url ?? null;
}

// ---------------------------------------------------------------------------
// Protected paths + lint
// ---------------------------------------------------------------------------

/**
 * Regexes over SUPER-relative paths the loop must never edit. Note
 * `traceanalyzer/` is deliberately absent: grader edits are policed per
 * hypothesis kind by lintRulerSubject, not blanket-protected. SPUR-repo files
 * have no protected paths.
 */
export const PROTECTED: readonly RegExp[] = [
  /^bin\/spur\//,
  /^porcupine\//,
  /^research\/oracle\//,
  /^research\/corpus\//,
  /^scheduler_configs\/(?!loop\/)/,
  /^research\/(?!observations\/)(?!evaluations\/)/,
];

/** SUPER-relative paths that touch a protected area (empty = pass). */
export function lintProtectedPaths(superFiles: string[]): string[] {
  return superFiles.filter((f) => PROTECTED.some((re) => re.test(f)));
}

/**
 * Enforce that only grader-kind hypotheses touch the grader (traceanalyzer),
 * and that grader-kind hypotheses touch nothing else. Returns violations.
 */
export function lintRulerSubject(
  kind: HypothesisKind,
  superFiles: string[],
): string[] {
  const graderScoped = (f: string): boolean =>
    f.startsWith("traceanalyzer/") ||
    f.startsWith("research/observations/") ||
    f.startsWith("research/evaluations/");
  if (kind === "grader") {
    return superFiles.filter((f) => !graderScoped(f));
  }
  return superFiles.filter((f) => f.startsWith("traceanalyzer/"));
}

/**
 * Identifiers whose appearance in newly added code signals the change is
 * hard-coding knowledge of the VR view-change/recovery protocol rather than
 * a general mechanism. `"timeout"` is the quoted string literal (matching
 * e.g. special-casing on a "timeout" event name), not the bare word.
 *
 * "Recovery" alone is deliberately NOT banned: it shows up in legitimate,
 * protocol-agnostic contexts (RecoverInit, crash-recovery plumbing, comments
 * about simulator recovery semantics), so banning the bare word would drown
 * the lint in false positives. The specific message name RecoveryResponse is
 * banned instead.
 */
const BANNED_VR_IDENTIFIERS: readonly string[] = [
  "StartViewChange",
  "DoViewChange",
  "StartView",
  "RecoveryResponse",
  '"timeout"',
];

/**
 * Scan ADDED lines of a unified diff for banned VR-specific identifiers.
 * Returns one entry per (identifier, line) hit; empty = pass. A line
 * containing StartViewChange also matches StartView — both are reported,
 * which is fine since either alone fails the lint.
 */
// Only source-ish files are linted for VR names: generated artifacts
// (SVGs, parquet listings, HTML) legitimately contain handler names.
export const VR_LINT_FILES = /\.(rs|go|ts|json|toml|md)$/;
export function lintVrNames(diff: string): string[] {
  const hits: string[] = [];
  let fileLintable = true;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const fp = line.slice(4).replace(/^b\//, "");
      fileLintable = VR_LINT_FILES.test(fp) && !fp.startsWith("research/oracle/");
      continue;
    }
    if (!fileLintable || !line.startsWith("+")) continue;
    for (const banned of BANNED_VR_IDENTIFIERS) {
      if (line.includes(banned)) {
        hits.push(`${banned}: ${line.slice(1).trim().slice(0, 120)}`);
      }
    }
  }
  return hits;
}
