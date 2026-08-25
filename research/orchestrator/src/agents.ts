// Agent roles, all via the Claude Agent SDK. Agents produce judgment (text /
// JSON validated against schemas); the harness owns every side effect except
// the implementer's file edits, which are fenced by canUseTool below.
import { query, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { ROOT } from "./runners.js";
import { AuditReport, Hypothesis, ProposedHypotheses, Reflection, RejudgeResult } from "./schemas.js";
import type { Policy } from "./policy.js";

export { ROOT };

export const STOP_PATH = path.join(ROOT, "research", "STOP");

// An AbortController that fires when the STOP sentinel appears, so agent
// phases end within seconds of a stop request instead of running to
// completion. Partial implementer edits stay in the working tree.
export function stopController(): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const timer = setInterval(() => {
    if (existsSync(STOP_PATH)) controller.abort();
  }, 3000);
  return { controller, dispose: () => clearInterval(timer) };
}

export interface RoleResult<T> {
  value: T | null;
  rawText: string;
  costUsd: number;
  turns: number;
  error: string | null;
}

async function collect(gen: AsyncGenerator<SDKMessage, void>): Promise<{ text: string; costUsd: number; turns: number; isError: boolean; errText: string }> {
  let text = "";
  let costUsd = 0;
  let turns = 0;
  let isError = false;
  let errText = "";
  try {
    return await collectInner(gen, (t, c, n, e, et) => { text = t; costUsd = c; turns = n; isError = e; errText = et; });
  } catch (e) {
    // The SDK throws on some terminal results (e.g. max turns). Convert to a
    // clean error outcome so an iteration never aborts on an agent failure.
    return { text, costUsd, turns, isError: true, errText: String(e) };
  }
}

async function collectInner(
  gen: AsyncGenerator<SDKMessage, void>,
  save: (t: string, c: number, n: number, e: boolean, et: string) => void,
): Promise<{ text: string; costUsd: number; turns: number; isError: boolean; errText: string }> {
  let text = "";
  let costUsd = 0;
  let turns = 0;
  let isError = false;
  let errText = "";
  for await (const m of gen) {
    if (m.type === "result") {
      costUsd = m.total_cost_usd ?? 0;
      turns = m.num_turns ?? 0;
      if (m.subtype === "success") {
        text = m.result;
        isError = m.is_error;
        if (m.is_error) errText = m.result;
      } else {
        isError = true;
        errText = m.subtype;
      }
    }
    save(text, costUsd, turns, isError, errText);
  }
  return { text, costUsd, turns, isError, errText };
}

// Extract the first balanced top-level JSON object/array from model text.
export function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const source = fenced?.[1] ?? text;
  const start = source.search(/[[{]/);
  if (start < 0) return null;
  const open = source[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

async function textRole<T>(opts: {
  model: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTurns?: number;
  retries?: number;
}): Promise<RoleResult<T>> {
  let lastErr = "no attempts";
  let raw = "";
  let cost = 0;
  let turns = 0;
  for (let attempt = 0; attempt <= (opts.retries ?? 1); attempt++) {
    const prompt = attempt === 0
      ? opts.prompt
      : `${opts.prompt}\n\nYour previous reply did not validate: ${lastErr}\nReply with ONLY the corrected JSON.`;
    const sc = stopController();
    const r = await collect(query({
      prompt,
      options: {
        abortController: sc.controller,
        model: opts.model,
        systemPrompt: opts.system,
        maxTurns: opts.maxTurns ?? 3,
        allowedTools: [],
        disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent"],
        settingSources: [],
        cwd: ROOT,
      },
    }));
    sc.dispose();
    raw = r.text;
    cost += r.costUsd;
    turns += r.turns;
    if (r.isError) { lastErr = r.errText; if (sc.controller.signal.aborted) break; continue; }
    const json = extractJson(r.text);
    if (!json) { lastErr = "no JSON found in reply"; continue; }
    try {
      const parsed = opts.schema.safeParse(JSON.parse(json));
      if (parsed.success) return { value: parsed.data, rawText: raw, costUsd: cost, turns, error: null };
      lastErr = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    } catch (e) {
      lastErr = `JSON parse: ${String(e)}`;
    }
  }
  return { value: null, rawText: raw, costUsd: cost, turns, error: lastErr };
}

function readIfExists(p: string): string {
  try { return readFileSync(p, "utf8"); } catch { return "(missing)"; }
}

const HYPOTHESIS_JSON_GUIDE = `Reply with ONLY a JSON object: {"hypotheses": [...]}. Each hypothesis:
{"id": "kebab-case-slug", "parent": null or "existing-id", "kind": "add"|"ablate"|"meta"|"enabling"|"grader"|"perf",
 "title": "...", "description": "what to change, concretely, incl. which files/mechanisms and the config field that gates it",
 "category": "scheduler"|"config"|"feedback"|"tooling"|"policy"|"grader"|"performance",
 "buildsOn": ["mechanism names this depends on"], "expectedGain": 0-10, "expectedCost": 0.1-10,
 "rationale": "why this should move the ladder", "generalityArgument": "why this is protocol-agnostic (rule 1)",
 "createdAtIso": "<now>", "notes": ""}`;

export const PROPOSAL_LENSES = [
  "fault-injection literature: crash timing anchored to protocol activity (sends, deliveries, quorum events); recovery timing races",
  "message-delay and reordering: purgatory policies, orphaned in-flight messages, delivery of pre-crash messages after recovery",
  "feedback/novelty: what coverage signal would make the scheduler chase crash-recovery message races; incarnation-awareness",
  "ablation and salvage: mechanisms with zero utilization, dead or miswired knobs, unexercised code paths - remove, fix, or enable them",
  "scheduling theory: PCT priority change points, partial-order methods, queue-policy shapes that concentrate schedules near fault windows",
  "profile-guided performance (kind: perf): read the latest perf profile in observations; propose hotspot reductions that raise runs/sec without changing scheduling semantics or instrumentation the grader needs",
];

export async function proposeHypotheses(policy: Policy, lens: string, statusMd: string, existingIds: string[]): Promise<RoleResult<{ hypotheses: unknown[] }>> {
  const goal = readIfExists(path.join(ROOT, "research/GOAL.md"));
  const observations = readIfExists(path.join(ROOT, "research/observations/OBSERVATIONS.md")).slice(-8000);
  const r = await textRole({
    model: policy.models.propose,
    system: "You are a distributed-systems research scientist generating falsifiable, implementable hypotheses for improving a protocol-fuzzing scheduler. You never propose protocol-specific hacks.",
    prompt: `${goal}\n\n## Current status\n${statusMd.slice(0, 12000)}\n\n## Recent observations\n${observations}\n\n## Your lens for this round\n${lens}\n\n## Existing hypothesis ids (do not duplicate)\n${existingIds.join(", ") || "(none)"}\n\nPropose 2-4 hypotheses through your lens. Each must be implementable in <300 lines of Rust/config change, opt-in (config-gated, default off), and protocol-agnostic.\n${HYPOTHESIS_JSON_GUIDE}`,
    schema: z.object({ hypotheses: z.array(z.unknown()) }),
    retries: 1,
  });
  return r;
}

const JUDGE_RUBRIC = `## Scoring rubric (you assign expectedGain/expectedCost; proposer values are advisory only)
expectedCost anchors: config-only change 0.5 | <=50 lines Rust 2 | scheduler-core change 4 | new instrumentation/plumbing 6 | +2 if it touches execution semantics (core/exec.rs, history.rs - routes to needs-human).
expectedGain anchors: must name WHICH ladder rung's conditional probability it lifts (depth>=4, >=5, >=6, violations, h2) and the causal path to a specific crash/recovery/delivery event. Rung-specific causal story with a plausible >=1.5x effect: 6-8. Same but indirect/partial: 3-5. "More novelty/coverage in general": 1-2. Cannot state a falsifying screen result: 0-1.
Parameter surface: +1 expectedCost per new tunable (a config field or a constant in code, hidden defaults included); credit for each tunable removed or subsumed. A mechanism that needs a value a different protocol could not derive scores expectedGain <= 3 unless it also removes a tunable. Ask of every candidate: what value would another protocol need here, and how would anyone know?
Process: for EACH candidate first write the strongest argument that it will NOT move the ladder (red team), then score. Rank candidates against each other and the pool; two proposals promising the same mechanism cannot both score high. Output the falsification statement in the notes field.`;

export async function judgeHypotheses(policy: Policy, candidates: unknown[], poolSummaries: string[], calibration: string): Promise<RoleResult<{ hypotheses: unknown[] }>> {
  return textRole({
    model: policy.models.judge,
    system: "You are an adversarial research lead scoring proposals for a bandit that will spend real compute on them. Proposers are systematically optimistic; your job is to normalize their claims against the rubric and against what past hypotheses actually delivered. You reject duplicates, protocol-specific hacks, vague proposals, and anything that cannot be evaluated against the metric ladder.",
    prompt: `## Existing pool (summaries)\n${poolSummaries.join("\n") || "(empty)"}\n\n## Calibration: predicted vs realized for evaluated hypotheses\n${calibration || "(no completed evaluations yet)"}\n\n${JUDGE_RUBRIC}\n\n## Candidates\n${JSON.stringify(candidates, null, 2).slice(0, 30000)}\n\nReturn only the candidates worth keeping (deduplicated against pool and each other, rejecting rule-violating ones), with YOUR expectedGain/expectedCost. ${HYPOTHESIS_JSON_GUIDE}`,
    schema: z.object({ hypotheses: z.array(z.unknown()) }),
    retries: 1,
  });
}

// The implementer: an agentic session fenced to the hypothesis's lane.
const PERF_BASH = [
  /^perf (stat|record|report|script|annotate)\b[^;&|]*$/,
  /^hyperfine\b[^;&|]*$/,
  /^cargo bench\b[^;&|]*$/,
];

const SAFE_BASH = [
  /^cargo (build|check|test)\b[^;&|]*$/,
  /^go (build|test|vet)\b[^;&|]*$/,
  /^gofmt\b[^;&|]*$/,
  /^timeout \d+ \.\/spur\/target\/release\/spur (explore|run-plan)\b[^;&|]*--output-dir tmp\/loop\/[^;&|]*$/,
  /^\.\/traceanalyzer\/main\b[^;&|]*$/,
  /^\.\/porcupine\/batch\b[^;&|]*$/,
  /^(ls|cat|head|tail|wc|grep|rg|find|duckdb)\b[^;&|]*$/,
];

function editAllowed(kind: Hypothesis["kind"], relPath: string): boolean {
  const p = relPath.replace(/^\.\//, "");
  if (/^(bin\/spur|porcupine|research\/oracle|research\/corpus)\//.test(p)) return false;
  if (kind === "meta" && p === "research/policy.json") return true;
  if (/^research\/(?!observations\/)/.test(p)) return false;
  if (/^scheduler_configs\/(?!loop\/)/.test(p)) return false;
  if (kind === "grader") return /^traceanalyzer\//.test(p);
  return /^(spur\/|scheduler_configs\/loop\/|tmp\/loop\/)/.test(p);
}

export function makeImplementerGate(kind: Hypothesis["kind"]): (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult> {
  return async (toolName, input) => {
    if (toolName === "Bash") {
      const cmd = String(input["command"] ?? "").trim();
      if (/\b(git|gh|npm|npx|curl|wget|ssh|scp|pip)\b/.test(cmd)) {
        return { behavior: "deny", message: "git/gh/network/package commands are harness-owned; do not use them" };
      }
      if (SAFE_BASH.some((re) => re.test(cmd))) return { behavior: "allow", updatedInput: input };
      if (kind === "perf" && PERF_BASH.some((re) => re.test(cmd))) return { behavior: "allow", updatedInput: input };
      return { behavior: "deny", message: "command not in the implementer allowlist (cargo/go build+test, spur explore under timeout, traceanalyzer, porcupine batch, read-only shell)" };
    }
    if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
      const fp = String(input["file_path"] ?? "");
      const rel = path.isAbsolute(fp) ? path.relative(ROOT, fp) : fp;
      if (rel.startsWith("..")) return { behavior: "deny", message: "outside repository" };
      if (!editAllowed(kind, rel)) return { behavior: "deny", message: `protected path for kind=${kind}: ${rel}` };
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "allow", updatedInput: input };
  };
}

export async function implementHypothesis(policy: Policy, h: Hypothesis): Promise<{ summary: string; costUsd: number; turns: number; isError: boolean; aborted: boolean }> {
  const goal = readIfExists(path.join(ROOT, "research/GOAL.md"));
  const style = readIfExists(path.join(ROOT, "research/STYLE.md"));
  const sc = stopController();
  const r = await collect(query({
    prompt: `${goal}\n\n## Hypothesis to implement (id: ${h.id}, kind: ${h.kind})\n${h.title}\n\n${h.description}\n\nRationale: ${h.rationale}\n\n## Instructions\n- Implement exactly this hypothesis, minimally and idiomatically. Opt-in: new behavior behind a config field defaulting to today's semantics (except pure ablations/grader work as described).\n- Rust subject work lives in spur/spur-core; general configs in scheduler_configs/loop/. Grader work (only if kind=grader) lives in traceanalyzer/.\n- Build with cargo build --release --manifest-path spur/Cargo.toml --bin spur (or go build in traceanalyzer for grader work) and fix errors until it compiles. Run cargo test -p spur-core if you touched spur-core logic.\n- If the hypothesis needs the new mechanism enabled in the evaluation config, edit scheduler_configs/loop/general_vr.json to enable it (this is the config the evaluation runs).\n- Do NOT run git or gh. Do not create commits. Leave changes in the working tree.\n- The permission fence is final and there is NO human watching: if a Bash command is denied, do not stop to ask - accomplish the same thing with the Read/Edit/Write tools (all JSON/config/Rust edits go through Edit/Write, never shell text tools). Never end your turn with a question; end it with the work done or a clear statement of what blocked you after genuinely exhausting the allowed tools.\n- Keep verification minimal: compile, and at most ONE short smoke run of the changed path. Smoke runs MUST write to --output-dir tmp/loop/<name> (the fence rejects anything else; other locations contaminate the repo). The harness runs all real evaluations afterwards - re-verifying existing mechanisms or exploring old output directories is wasted budget. Target under 5 minutes of work for config-only changes.\n- End with a concise summary: what changed (files), the config field that gates it, and what you expect it to do to the ladder.\n\n## Code style (mandatory)\n${style}`,
    options: {
      abortController: sc.controller,
      model: policy.models.implement,
      maxTurns: policy.budgets.maxImplementTurns,
      cwd: ROOT,
      // In "default" mode every permission decision routes through
      // canUseTool, so the fence below is the only authority.
      permissionMode: "default",
      settingSources: [],
      disallowedTools: ["WebFetch", "WebSearch", "Task", "Agent", "Skill"],
      canUseTool: makeImplementerGate(h.kind),
      systemPrompt: "You are a careful systems engineer working inside a fenced research harness. You implement one hypothesis at a time, keep diffs minimal, and never touch protected paths (the permission gate enforces this - if a path is denied, work within the allowed lanes instead of fighting it).",
    },
  }));
  sc.dispose();
  return { summary: r.text, costUsd: r.costUsd, turns: r.turns, isError: r.isError, aborted: sc.controller.signal.aborted };
}

// Re-score the whole proposed pool against what has been learned since
// each entry was scored: merges move the baseline, negative results
// contradict neighbors, enabled mechanisms unlock dependents.
export async function rejudgePool(policy: Policy, pool: Hypothesis[], calibration: string, recentEvidence: string, utilization: string): Promise<RoleResult<RejudgeResult>> {
  return textRole({
    model: policy.models.judge,
    system: "You are an adversarial research lead re-scoring a hypothesis pool in light of new evidence. Proposals were scored before this evidence existed. Down-score what the evidence contradicts, up-score what it enables, park what is superseded or redundant, and keep the rubric's parameter-cost discipline.",
    prompt: `## Recent evidence (decisions, deltas, reflections)\n${recentEvidence.slice(0, 16000)}\n\n## Calibration: predicted vs realized\n${calibration || "(none)"}\n\n## Mechanism utilization in the evaluation config\n${utilization.slice(0, 4000)}\n\n${JUDGE_RUBRIC}\n\n## Pool to re-score\n${JSON.stringify(pool.map((h) => ({ id: h.id, kind: h.kind, title: h.title, description: h.description.slice(0, 600), buildsOn: h.buildsOn, expectedGain: h.expectedGain, expectedCost: h.expectedCost, parent: h.parent })), null, 1).slice(0, 40000)}\n\nReply with ONLY JSON: {"updates": [{"id": "...", "expectedGain": 0-10, "expectedCost": 0.1-10, "action": "keep"|"park", "reason": "one line"}]} covering EVERY pool id.`,
    schema: RejudgeResult,
    retries: 1,
  });
}

export async function reflectOnOutcome(policy: Policy, h: Hypothesis, evidence: string): Promise<RoleResult<Reflection>> {
  return textRole({
    model: policy.models.reflect,
    system: "You are a research scientist writing a terse, information-dense lab-notebook entry after an experiment.",
    prompt: `## Hypothesis\n${JSON.stringify(h, null, 2)}\n\n## Evidence (evaluations, decision, diff summary)\n${evidence.slice(0, 20000)}\n\nReply with ONLY JSON: {"hypothesisId": "${h.id}", "whatWeLearned": "...", "suggestedChildren": [...0-2 follow-up hypotheses, same shape as pool hypotheses...], "suggestedDeprioritize": ["hypothesis-ids"]}\nFor suggestedChildren use: ${HYPOTHESIS_JSON_GUIDE}`,
    schema: Reflection,
    retries: 1,
  });
}

export async function runAudit(policy: Policy, iteration: number, statusMd: string, ledger: string, utilization: string): Promise<RoleResult<AuditReport>> {
  return textRole({
    model: policy.models.audit,
    system: "You are an independent auditor of an autonomous research loop. You have no stake in any hypothesis. You look for waste, statistical weakness, metric gaming, and dead mechanisms. Be specific and quantitative.",
    prompt: `## Iteration\n${iteration}\n\n## Status\n${statusMd.slice(0, 12000)}\n\n## Time/budget ledger\n${ledger.slice(0, 8000)}\n\n## Mechanism utilization (latest utilization.json dumps)\n${utilization.slice(0, 6000)}\n\nReply with ONLY JSON matching: {"atIteration": ${iteration}, "timeBreakdown": {"phase": seconds}, "budgetConcentration": "...", "statisticalPowerNotes": "...", "goodhartSignals": ["..."], "utilizationFindings": [{"mechanism": "...", "classification": "broken"|"unexercised"|"unrewarding"|"scaffolding"|"healthy", "evidence": "..."}], "recommendedPolicyChanges": ["..."]}`,
    schema: AuditReport,
    retries: 1,
  });
}

export function validateProposed(raw: unknown[]): { valid: Hypothesis[]; rejected: string[] } {
  const valid: Hypothesis[] = [];
  const rejected: string[] = [];
  for (const c of raw) {
    const p = ProposedHypotheses.shape.hypotheses.element.safeParse(c);
    if (p.success) {
      valid.push(Hypothesis.parse({ ...p.data, status: "proposed", branch: null, prUrls: [] }));
    } else {
      rejected.push(p.error.issues[0]?.message ?? "invalid");
    }
  }
  return { valid, rejected };
}
