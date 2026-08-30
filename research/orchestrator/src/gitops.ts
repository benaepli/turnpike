// Typed git/gh operations for the research loop. Every command goes through
// execFileSync with an argv array - no shell strings, no interpolation into a
// shell. Read-mostly helpers return parsed values; mutating helpers throw
// GitError on unexpected failure.
import { execFileSync } from "node:child_process";
import type { HypothesisKind } from "./schemas.js";

import { SUPER, SPUR } from "./paths.js";

export { SUPER, SPUR };

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
// Synchronous sleep (gitops is deliberately synchronous).
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// index.lock contention comes from concurrent git users (IDEs, other
// sessions) holding the lock for a moment; retry with backoff instead of
// failing the iteration.
const LOCK_BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
function isLockContention(stderr: string): boolean {
  return /index\.lock|Another git process/.test(stderr);
}

function must(bin: "git" | "gh", args: string[], cwd: string): string {
  let r = exec(bin, args, cwd);
  for (let attempt = 0; !r.ok && bin === "git" && isLockContention(r.stderr) && attempt < LOCK_BACKOFF_MS.length; attempt++) {
    sleepMs(LOCK_BACKOFF_MS[attempt] ?? 1000);
    r = exec(bin, args, cwd);
  }
  if (!r.ok) {
    throw new GitError(`${bin} ${args.join(" ")} (cwd=${cwd})`, r.stderr);
  }
  return r.stdout;
}

// Snapshot everything a hypothesis changed (committed on its branch or still
// in the working tree, tracked or untracked) so failed iterations leave a
// recoverable reference diff.
export function snapshotWork(repo: string, baseRef: string): string {
  const parts: string[] = [];
  const tracked = exec("git", ["diff", baseRef, "--"], repo);
  if (tracked.stdout.trim()) parts.push(tracked.stdout);
  const untracked = exec("git", ["ls-files", "--others", "--exclude-standard"], repo).stdout.split("\n").filter((f) => f.length > 0);
  for (const f of untracked.slice(0, 50)) {
    const shown = exec("git", ["diff", "--no-index", "--", "/dev/null", f], repo);
    if (shown.stdout.trim()) parts.push(shown.stdout);
  }
  return parts.join("\n");
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

export const RESEARCH_BRANCH = "research/auto-vr";

// The superproject paths the loop writes: the implementer's allowlist in
// agents.ts, the evidence and policy files an iteration renders, and the spur
// gitlink. Everything else in that tree is the operator's - orchestrator
// source, the grader, the runbooks - and no reset the loop performs may reach
// it, or a harness patch cannot be staged while the daemon runs. tmp/loop and
// research/logs are ignored, so nothing resets them and they need no entry.
export const SUPER_LANES = [
  "spur",
  "scheduler_configs/loop",
  "research/evaluations",
  "research/observations",
  "research/policy.json",
  "research/POLICY.md",
];

/** Tracked paths modified outside `lanes`. */
export function dirtyOutsideLanes(repo: string, lanes: string[]): string[] {
  const r = exec("git", ["status", "--porcelain", "-uno"], repo);
  if (!r.ok) return [];
  const inLane = (p: string): boolean => lanes.some((l) => p === l || p.startsWith(`${l}/`));
  return r.stdout
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter((p) => p.length > 0)
    .map((p) => { const i = p.indexOf(" -> "); return i < 0 ? p : p.slice(i + 4); })
    .filter((p) => !inLane(p));
}

/**
 * Run a reset that is destructive by design with the operator's tree held
 * aside: anything dirty outside the lanes is stashed by path and restored
 * after. A stash that no longer applies stays in the stash and is reported,
 * because losing it silently is the failure this exists to prevent.
 */
export function preservingOperatorTree(repo: string, lanes: string[], fn: () => void): void {
  const dirty = dirtyOutsideLanes(repo, lanes);
  if (dirty.length === 0) { fn(); return; }
  const pushed = exec("git", ["stash", "push", "-m", "loop: operator tree", "--", ...dirty], repo).ok;
  try {
    fn();
  } finally {
    if (pushed && !exec("git", ["stash", "pop"], repo).ok) {
      console.error(`operator tree kept in the stash; it no longer applies after the reset. Recover with \`git -C ${repo} stash pop\`. Files: ${dirty.join(", ")}`);
    }
  }
}

/** `git add` restricted to `lanes`, then commit whatever that staged. */
export function commitLanes(repo: string, lanes: string[], message: string): string {
  // Per path and non-throwing: a lane with nothing in it is not an error.
  for (const l of lanes) exec("git", ["add", "--", l], repo);
  if (exec("git", ["diff", "--cached", "--quiet"], repo).ok) {
    return currentCommit(repo);
  }
  const full = `${message}\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>`;
  must("git", ["commit", "-m", full], repo);
  return currentCommit(repo);
}

/** Contents of a tracked file at a ref. */
export function showFile(repo: string, ref: string, filePath: string): string {
  return must("git", ["show", `${ref}:${filePath}`], repo);
}

/** Files changed on `ref` since it diverged from the current HEAD. */
export function changedOnRef(repo: string, ref: string): string[] {
  return must("git", ["diff", "--name-only", `HEAD...${ref}`], repo).split("\n").filter((l) => l.length > 0);
}

/** Point `branch` at `ref` and check it out. */
export function resetBranchTo(repo: string, branch: string, ref: string): void {
  must("git", ["checkout", "-B", branch, ref], repo);
}

/** Restore the given paths from `ref` into the working tree and index. */
export function checkoutPaths(repo: string, ref: string, paths: string[]): void {
  if (paths.length === 0) return;
  must("git", ["checkout", ref, "--", ...paths], repo);
}

/** Rebase the current branch onto base; a conflicting rebase is aborted and reported as false. */
export function rebaseOnto(repo: string, base: string): boolean {
  if (exec("git", ["rebase", base], repo).ok) return true;
  exec("git", ["rebase", "--abort"], repo);
  return false;
}

/** Commit only the given paths; returns false when they hold no changes. */
export function commitPaths(repo: string, paths: string[], message: string): boolean {
  must("git", ["add", "--", ...paths], repo);
  if (exec("git", ["diff", "--cached", "--quiet", "--", ...paths], repo).ok) return false;
  const full = `${message}\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>`;
  must("git", ["commit", "-m", full, "--", ...paths], repo);
  return true;
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
  if (branch !== RESEARCH_BRANCH && !branch.startsWith("hyp/")) {
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
    // the research branch itself - otherwise changedFiles(SPUR, research)
    // compares the branch to itself and reports an empty diff.
    if (currentBranch(SPUR) !== opts.branch) {
      checkout(SPUR, opts.branch);
    }
    spurCommit = commitAll(SPUR, opts.spurMessage);
  }
  // The lanes include the spur gitlink, so the submodule pointer is staged
  // with the rest. Staging the whole tree here would sweep an operator edit
  // onto a hyp/* branch that cleanup then deletes.
  const superCommit = commitLanes(SUPER, SUPER_LANES, opts.superMessage);
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
 * not have it, gh fails - we retry once without the label.
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

// ---------------------------------------------------------------------------
// Protected paths + lint
// ---------------------------------------------------------------------------

/**
 * Regexes over SUPER-relative paths the loop must never edit. Note
 * `traceanalyzer/` is deliberately absent: grader edits are policed per
 * hypothesis kind by lintRulerSubject, not blanket-protected. SPUR-repo files
 * have no protected paths.
 */
// The regression suite and the bench workload gate merges; a hypothesis
// must not be able to edit its own gate.
export const GATE_CONFIGS = /^scheduler_configs\/loop\/(regression_[^/]+|bench)\.json$/;

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
  const gateHits = superFiles.filter((f) => GATE_CONFIGS.test(f));
  if (gateHits.length > 0) return [...gateHits, ...lintProtectedPathsInner(superFiles)];
  return lintProtectedPathsInner(superFiles);
}

function lintProtectedPathsInner(superFiles: string[]): string[] {
  return superFiles.filter((f) => PROTECTED.some((re) => re.test(f)));
}

/**
 * Config files under `scheduler_configs/loop/` that no runner loads. Every
 * evaluation explores `policy.evaluation.configTemplate`; regression and the
 * perf lane load their own named files. A config outside that set is dead
 * weight: the hypothesis that adds it is measured against the unmodified
 * template, so its delta is seed noise about a change that never ran. Config
 * work has to edit a loaded file in place.
 */
/**
 * Key paths in `research/policy.json` that the Policy schema does not declare,
 * at any depth. Zod strips unknown keys on parse, so such a key never reaches
 * the running policy and is read by nothing: the hypothesis that adds it
 * passes the gate having changed no behavior at all. Caught here rather than
 * by making the schema strict, so a bad key fails one hypothesis instead of
 * refusing to start the daemon.
 */
export function lintInertPolicyKeys(
  policyJsonText: string | null,
  schemaKeyPaths: ReadonlySet<string>,
): string[] {
  if (!policyJsonText) return [];
  let raw: unknown;
  try { raw = JSON.parse(policyJsonText); } catch { return ["policy.json is not valid JSON"]; }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["policy.json is not a JSON object"];
  const out: string[] = [];
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [k, v] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (!schemaKeyPaths.has(p)) { out.push(`inert policy key (schema drops it on parse): ${p}`); continue; }
      if (typeof v === "object" && v !== null && !Array.isArray(v)) walk(v as Record<string, unknown>, p);
    }
  };
  walk(raw as Record<string, unknown>, "");
  return out;
}

export function lintInertConfigs(
  superFiles: string[],
  loadable: readonly string[],
): string[] {
  const loaded = new Set(loadable);
  return superFiles
    .filter((f) => /^scheduler_configs\/loop\/[^/]+\.json$/.test(f))
    .filter((f) => !loaded.has(f))
    .map((f) => `inert config (no runner loads it): ${f}`);
}

/**
 * An arm hypothesis changes the campaign block of the evaluation template
 * and nothing else: no spur source, no other file, and no envelope field of
 * the template outside the block.
 */
export function lintArmScope(
  kind: HypothesisKind,
  spurFiles: string[],
  superFiles: string[],
  templatePath: string,
  templateBefore: string | null,
  templateAfter: string | null,
): string[] {
  if (kind !== "arm") return [];
  const out: string[] = [];
  if (spurFiles.length > 0) out.push(`arm hypothesis touches spur: ${spurFiles.join(", ")}`);
  for (const f of superFiles) {
    if (f !== templatePath) out.push(`arm hypothesis touches ${f}; only ${templatePath} may change`);
  }
  if (templateBefore !== null && templateAfter !== null) {
    const envelope = (text: string): string => {
      const o = JSON.parse(text) as Record<string, unknown>;
      delete o["campaign"];
      return JSON.stringify(o);
    };
    try {
      if (envelope(templateBefore) !== envelope(templateAfter)) out.push("arm hypothesis changed the template outside its campaign block");
    } catch {
      out.push("evaluation template is not valid JSON");
    }
  }
  return out;
}

/**
 * A hypothesis that compares parameter values tests one value; the next value
 * is a separate hypothesis. Several new arms at once is that sweep wearing a
 * different shape, and it also moves the arm set the rate stratum pools, so
 * the candidate cannot be compared with the baseline at all and spends a
 * chunk to learn only that. Not gated on kind: an add hypothesis that
 * restructures the campaign while changing spur reaches the same dead end.
 */
export function lintArmSetGrowth(templateBefore: string | null, templateAfter: string | null): string[] {
  if (templateBefore === null || templateAfter === null) return [];
  let added: string[];
  try {
    const armIds = (text: string): string[] => {
      const c = (JSON.parse(text) as { campaign?: { arms?: Array<{ id?: unknown }> } }).campaign;
      return (c?.arms ?? []).map((a) => String(a.id ?? ""));
    };
    const before = new Set(armIds(templateBefore));
    added = armIds(templateAfter).filter((id) => !before.has(id));
  } catch {
    return [];
  }
  return added.length > 1
    ? [`the campaign gains ${added.length} arms (${added.join(", ")}); one hypothesis tests one value, propose the others separately`]
    : [];
}

/** The arm-growth rule, asserted directly: a rubric clause asking for it was
 *  not enough, and the miss costs an implement and a chunk. */
export function selfTestArmSetGrowth(): string[] {
  const f: string[] = [];
  const check = (c: boolean, m: string): void => { if (!c) f.push(m); };
  const tpl = (ids: string[]): string =>
    JSON.stringify({ max_iterations: 6000, campaign: { arms: ids.map((id) => ({ id, mode: "grid", overlay: {} })) } });
  const base = ["grid", "grid-short", "grid-no-purgatory", "grid-post-fault-2"];
  const lint = (after: string[]): string[] => lintArmSetGrowth(tpl(base), tpl(after));

  check(lint(base).length === 0, "an unchanged arm set is clean");
  check(lint([...base, "grid-deep"]).length === 0, "one added arm is allowed");
  check(lint(base.slice(0, 3)).length === 0, "removing arms is not growth");
  check(lint(base.map((i) => (i === "grid-post-fault-2" ? "grid-post-fault-3" : i))).length === 0,
    "replacing one arm counts as one addition");
  // The shape that reached iteration 5365: one arm replaced by three.
  const sweep = ["grid", "grid-short", "grid-no-purgatory", "grid-post-fault-p25", "grid-post-fault-p50", "grid-post-fault-p75"];
  check(lint(sweep).some((e) => e.includes("gains 3 arms")), "a three-arm sweep is refused with its count named");
  check(lintArmSetGrowth(null, tpl(sweep)).length === 0, "a template the candidate did not change is not judged");
  check(lintArmSetGrowth("not json", tpl(sweep)).length === 0, "invalid JSON is reported by the envelope check, not here");
  return f;
}

/**
 * A halving or bandit allocation ranks arms by an in-process reward, which
 * is only allowed once the validation lane has shown that reward tracks the
 * graded outcome; the admitted reward is recorded as a line of the
 * validation report.
 */
export function lintCampaignAllocation(templateText: string | null, validationMd: string | null): string[] {
  if (!templateText) return [];
  let cfg: Record<string, unknown>;
  try { cfg = JSON.parse(templateText) as Record<string, unknown>; } catch { return ["evaluation template is not valid JSON"]; }
  const camp = cfg["campaign"];
  if (typeof camp !== "object" || camp === null) return [];
  const block = camp as { allocation?: { kind?: string }; reward?: { kind?: string } };
  const kind = block.allocation?.kind ?? "round_robin";
  if (kind !== "halving" && kind !== "bandit") return [];
  const reward = block.reward?.kind ?? "termination_completed";
  const admitted = (validationMd ?? "").split("\n").some((l) => l.trim() === `admissible: ${reward}`);
  return admitted
    ? []
    : [`campaign allocation ${kind} reads reward ${reward}, which research/observations/SURROGATE_VALIDATION.md has not admitted (no line "admissible: ${reward}")`];
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
 * containing StartViewChange also matches StartView - both are reported,
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
