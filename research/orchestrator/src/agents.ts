// Agent roles, all via the Claude Agent SDK. Agents produce judgment (text /
// JSON validated against schemas); the harness owns every side effect except
// the implementer's file edits, which are fenced by canUseTool below.
import { query, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { performance } from "node:perf_hooks";
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
export function stopController(deadlineMs?: number): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const start = performance.now();
  const timer = setInterval(() => {
    if (existsSync(STOP_PATH)) controller.abort();
    if (deadlineMs !== undefined && performance.now() - start >= deadlineMs) controller.abort();
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

// Where an agent session spent its wall time: model generation/thinking vs
// tool execution, split by tool category, with a call histogram. Tool time
// is measured from each tool_use to its matching tool_result; the remainder
// is model time.
export interface AgentActivity {
  totalMs: number;
  modelMs: number;
  toolMs: Record<string, number>;
  toolCounts: Record<string, number>;
}

function emptyActivity(): AgentActivity {
  return { totalMs: 0, modelMs: 0, toolMs: {}, toolCounts: {} };
}

function toolCategory(name: string, command: string | undefined): string {
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") return "edit";
  if (name === "Read" || name === "NotebookRead") return "read";
  if (name !== "Bash") return "other";
  const c = (command ?? "").trim();
  if (/\bcargo\s+(build|b|check)\b/.test(c)) return "build";
  if (/\bcargo\s+(test|t)\b/.test(c) || /\bgo\s+test\b/.test(c)) return "test";
  if (/\bexplore\b|\bspur\b.*\bexplore\b|--output-dir/.test(c)) return "smoke";
  if (/^(cat|grep|rg|ls|find|head|tail|wc|sed -n|awk)\b/.test(c)) return "read";
  return "shell";
}

interface StreamBlock { type: string; id?: string; name?: string; input?: { command?: string }; tool_use_id?: string }

async function collect(gen: AsyncGenerator<SDKMessage, void>): Promise<{ text: string; costUsd: number; turns: number; isError: boolean; errText: string; activity: AgentActivity }> {
  let text = "";
  let costUsd = 0;
  let turns = 0;
  let isError = false;
  let errText = "";
  let activity: AgentActivity = emptyActivity();
  try {
    return await collectInner(gen, (t, c, n, e, et, a) => { text = t; costUsd = c; turns = n; isError = e; errText = et; activity = a; });
  } catch (e) {
    // The SDK throws on some terminal results (e.g. max turns). Convert to a
    // clean error outcome so an iteration never aborts on an agent failure.
    return { text, costUsd, turns, isError: true, errText: String(e), activity };
  }
}

async function collectInner(
  gen: AsyncGenerator<SDKMessage, void>,
  save: (t: string, c: number, n: number, e: boolean, et: string, a: AgentActivity) => void,
): Promise<{ text: string; costUsd: number; turns: number; isError: boolean; errText: string; activity: AgentActivity }> {
  let text = "";
  let costUsd = 0;
  let turns = 0;
  let isError = false;
  let errText = "";
  const t0 = performance.now();
  const toolMs: Record<string, number> = {};
  const toolCounts: Record<string, number> = {};
  const pending = new Map<string, { cat: string; ts: number }>();
  const activity = (): AgentActivity => {
    const toolTotal = Object.values(toolMs).reduce((a, b) => a + b, 0);
    const totalMs = performance.now() - t0;
    return { totalMs: Math.round(totalMs), modelMs: Math.round(Math.max(0, totalMs - toolTotal)), toolMs: Object.fromEntries(Object.entries(toolMs).map(([k, v]) => [k, Math.round(v)])), toolCounts };
  };
  for await (const m of gen) {
    const now = performance.now();
    if (m.type === "assistant") {
      const blocks = ((m as { message?: { content?: StreamBlock[] } }).message?.content) ?? [];
      for (const b of blocks) {
        if (b.type === "tool_use" && b.id) {
          const cat = toolCategory(b.name ?? "", b.input?.command);
          pending.set(b.id, { cat, ts: now });
          toolCounts[cat] = (toolCounts[cat] ?? 0) + 1;
        }
      }
    } else if (m.type === "user") {
      const blocks = ((m as { message?: { content?: StreamBlock[] } }).message?.content) ?? [];
      for (const b of blocks) {
        if (b.type === "tool_result" && b.tool_use_id) {
          const p = pending.get(b.tool_use_id);
          if (p) { toolMs[p.cat] = (toolMs[p.cat] ?? 0) + (now - p.ts); pending.delete(b.tool_use_id); }
        }
      }
    }
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
    save(text, costUsd, turns, isError, errText, activity());
  }
  return { text, costUsd, turns, isError, errText, activity: activity() };
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
  // A short phase whose output must survive a stop request runs to
  // completion instead of aborting on the STOP sentinel.
  stoppable?: boolean;
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
    if (opts.stoppable === false) sc.dispose();
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
{"id": "kebab-case-slug", "parent": null or "existing-id", "kind": "add"|"ablate"|"meta"|"enabling"|"grader"|"perf"|"arm",
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
  "profile-guided performance (kind: perf): read the explorer profile section below; propose reductions of a named hotspot that raise runs/sec without changing scheduling semantics or instrumentation the grader needs. Without a profile, propose nothing through this lens.",
  "arm composition (kind: arm): edit only the campaign block of the evaluation template - add, drop or re-overlay a generic arm (a grid overlay on an existing config field, a curriculum or an aos arm) so that rung events per second rise for the campaign as a whole; each arm keeps its own feedback state, so an arm is a search, not a knob; never name a protocol handler, message or role",
  "premise check: is the current config/workload even capable of reaching the goal? The bug lives at a depth the general config may never supply enough events to reach. Propose config or plan-generation experiments (more client operations, more concurrent crashes, longer or richer plans, curriculum changes) and structural diagnostics that test whether the ceiling is a scheduler problem or an event-supply/config limit - not another scheduler knob. A single such experiment that reframes the search is worth more than ten mechanism tweaks against a hard cap.",
];

// The audit's last successful perf record, or a line saying there is none.
function latestProfile(): string {
  const text = readIfExists(path.join(ROOT, "research/observations/PROFILE.md")).trim();
  return text ? text.slice(0, 6000) : "(no profile recorded: perf record has not succeeded on this host)";
}

export async function proposeHypotheses(policy: Policy, lens: string, statusMd: string, existingIds: string[], evalContext: string): Promise<RoleResult<{ hypotheses: unknown[] }>> {
  const goal = readIfExists(path.join(ROOT, "research/GOAL.md"));
  const observations = readIfExists(path.join(ROOT, "research/observations/OBSERVATIONS.md")).slice(-8000);
  const profile = latestProfile();
  const r = await textRole({
    model: policy.models.propose,
    system: "You are a distributed-systems research scientist generating falsifiable, implementable hypotheses for improving a protocol-fuzzing scheduler. You never propose protocol-specific hacks.",
    prompt: `${goal}\n\n## Current status\n${statusMd.slice(0, 12000)}\n\n## What a candidate is measured on\n${evalContext}\n\n## Recent observations\n${observations}\n\n## Explorer profile (top symbols)\n${profile}\n\n## Your lens for this round\n${lens}\n\n## Existing hypothesis ids (do not duplicate)\n${existingIds.join(", ") || "(none)"}\n\nPropose 2-4 hypotheses through your lens. Each must be implementable in <300 lines of Rust/config change, opt-in (config-gated, default off), and protocol-agnostic. Change only the subject (spur, scheduler_configs/loop) or, for grader-kind, traceanalyzer. Never propose changing the evaluation harness, the orchestrator, the fixed evaluation config, or the sequential/gate protocol - those are fixed and operator-owned, and such a proposal will be rejected.\n${HYPOTHESIS_JSON_GUIDE}`,
    schema: z.object({ hypotheses: z.array(z.unknown()) }),
    retries: 1,
  });
  return r;
}

const JUDGE_RUBRIC = `## Scoring rubric (you assign expectedGain/expectedCost; proposer values are advisory only)
expectedCost anchors, in the same units as expectedGain: candidates are ranked on expectedGain minus expectedCost, so a cost is the gain a candidate must return to earn the iteration it takes. Evaluation holds about two thirds of every iteration whatever the candidate is, and implementation about eight minutes, so the honest spread is narrow: config-only change 0.2 | <=50 lines Rust 0.5 | scheduler-core change 1 | new instrumentation/plumbing 1.5 | +1 if it touches execution semantics (core/exec.rs, history.rs - routes to needs-human). Cost separates candidates whose gains are comparable; it does not outweigh a difference in gain.
The primary objective is depth>=6 events per explore-second (GOAL.md rule 6): a rung's rate is its per-run probability times runs per second, so a change that raises either factor without lowering the other moves the objective by the same relative amount.
expectedGain anchors, per-run factor: must name WHICH ladder rung's conditional probability it lifts (depth>=4, >=5, >=6, violations, h2) and the causal path to a specific crash/recovery/delivery event. Rung-specific causal story with a plausible >=1.5x effect: 6-8. Same but indirect/partial: 3-5. "More novelty/coverage in general": 1-2.
expectedGain anchors, per-second factor (kind perf): must name the measured hotspot and the expected runs/s delta on the bench, with per-run rung probabilities unchanged. >=30%: 7 | >=15%: 5 | >=5%: 3 | below the 5% bench gate: 0-1.
Cannot state a falsifying result (a screen result for the per-run factor, a bench result for the per-second factor): 0-1.
Parameter surface: +0.5 expectedCost per new tunable (a config field or a constant in code, hidden defaults included); credit for each tunable removed or subsumed. A mechanism that needs a value a different protocol could not derive scores expectedGain <= 3 unless it also removes a tunable. Ask of every candidate: what value would another protocol need here, and how would anyone know?
Campaign arms: a candidate is compared against the baseline campaign as a whole, so a proposal that adds or replaces arms in the campaign block changes the unit of comparison itself. Its rungs then measure the new arm mix rather than its own contrast, and the arms it drops - a short-iteration arm above all - move the per-second rates further than any mechanism it is testing. Score expectedGain 0 for a sweep, dose or factorial expressed as new campaign arms. A dose belongs inside one existing arm as an overlay, where the mix is unchanged, or in an offline study.
Out of bounds: reject (expectedGain 0) any proposal that changes the loop's own machinery - the evaluation runner or orchestrator (research/orchestrator), the fixed evaluation config, the sequential or gate protocol, or which config a hypothesis is graded against. Every hypothesis must be measured the same way for results to be comparable; changing that is the operator's decision, not the loop's. Enabling a mechanism in the subject (spur, scheduler_configs/loop) is fine; rewiring the harness that measures it is not.
Already-set: a candidate whose configuration equals the value already in scheduler_configs/loop/general_vr.json tests nothing, whatever its arms are called. Check the current value before scoring a dose or a default. Score expectedGain 0.
Already-answered: the observations log below records what past iterations established. REJECT (score expectedGain 0) any diagnostic or measurement whose question is already answered there, and any hypothesis a recorded finding already falsifies; name the observation you are relying on in the notes. Do not re-propose a family that is already closed with several attempts and zero merges unless the premise has changed.
Process: for EACH candidate first write the strongest argument that it will NOT move the ladder (red team), then score. Rank candidates against each other and the pool; two proposals promising the same mechanism cannot both score high. Output the falsification statement in the notes field.`;

export async function judgeHypotheses(policy: Policy, candidates: unknown[], poolSummaries: string[], calibration: string, evalContext: string): Promise<RoleResult<{ hypotheses: unknown[] }>> {
  return textRole({
    model: policy.models.judge,
    system: "You are an adversarial research lead scoring proposals for a bandit that will spend real compute on them. Proposers are systematically optimistic; your job is to normalize their claims against the rubric and against what past hypotheses actually delivered. You reject duplicates, protocol-specific hacks, vague proposals, and anything that cannot be evaluated against the metric ladder.",
    prompt: `## Existing pool (summaries)\n${poolSummaries.join("\n") || "(empty)"}\n\n## Findings already established (observations log)\n${readIfExists(path.join(ROOT, "research/observations/OBSERVATIONS.md")).slice(-9000)}\n\n## What a candidate is measured on\n${evalContext}\nReject any candidate whose effect is confined to a mechanism with zero activity unless it is an enabling hypothesis that switches that mechanism on; set buildsOn to the mechanisms the change needs to be active.\n\n## Calibration: predicted vs realized for evaluated hypotheses\n${calibration || "(no completed evaluations yet)"}\n\n## Explorer profile (top symbols)\n${latestProfile()}\n\n${JUDGE_RUBRIC}\n\n## Candidates\n${JSON.stringify(candidates, null, 2).slice(0, 30000)}\n\nReturn only the candidates worth keeping (deduplicated against pool and each other, rejecting rule-violating ones), with YOUR expectedGain/expectedCost. ${HYPOTHESIS_JSON_GUIDE}`,
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
  if (/^scheduler_configs\/loop\/(regression_[^/]+|bench)\.json$/.test(p)) return false;
  if (kind === "grader") return /^traceanalyzer\//.test(p);
  if (kind === "arm") return /^scheduler_configs\/loop\/[^/]+\.json$/.test(p);
  // research/observations/ is spared by the research/ rule above on purpose,
  // and was then missing from this allowlist, so it was denied by omission.
  // An analysis hypothesis with nowhere to put its finding spends a full
  // implement and reports that it could not land the artifact.
  return /^(spur\/|scheduler_configs\/loop\/|tmp\/loop\/|research\/observations\/)/.test(p);
}

// A smoke run only proves the changed path runs; measurement is the
// harness's job. The fence caps the smoke timeout and the count of
// measurement invocations, and pins explores to the harness thread budget.
const SMOKE_TIMEOUT_CAP_S = 180;
const MAX_MEASUREMENT_RUNS = 3;
const EXPLORE_RULE = /^timeout (\d+) \.\/spur\/target\/release\/spur (explore|run-plan)\b[^;&|]*--output-dir tmp\/loop\/[^;&|]*$/;

export function makeImplementerGate(kind: Hypothesis["kind"], rayonThreads: number): (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult> {
  let measurementRuns = 0;
  return async (toolName, input) => {
    if (toolName === "Bash") {
      const cmd = String(input["command"] ?? "").trim();
      if (/\b(git|gh|npm|npx|curl|wget|ssh|scp|pip)\b/.test(cmd)) {
        return { behavior: "deny", message: "git/gh/network/package commands are harness-owned; do not use them" };
      }
      const em = EXPLORE_RULE.exec(cmd);
      if (em) {
        if (Number(em[1]) > SMOKE_TIMEOUT_CAP_S) {
          return { behavior: "deny", message: `a smoke run is capped at ${SMOKE_TIMEOUT_CAP_S}s; it only needs to prove the path runs, not measure anything` };
        }
        if (++measurementRuns > MAX_MEASUREMENT_RUNS) {
          return { behavior: "deny", message: "measurement budget spent; the harness runs every real evaluation - conclude with your summary" };
        }
        return { behavior: "allow", updatedInput: { ...input, command: `RAYON_NUM_THREADS=${rayonThreads} ${cmd}` } };
      }
      if (/^\.\/(traceanalyzer\/main|porcupine\/batch)\b/.test(cmd)) {
        if (++measurementRuns > MAX_MEASUREMENT_RUNS) {
          return { behavior: "deny", message: "measurement budget spent; conclude with your summary" };
        }
        return { behavior: "allow", updatedInput: input };
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

export async function implementHypothesis(policy: Policy, h: Hypothesis): Promise<{ summary: string; costUsd: number; turns: number; isError: boolean; aborted: boolean; timedOut: boolean; activity: AgentActivity }> {
  // Implementation is a code edit plus at most one smoke run; a hypothesis
  // that turns implement into a measurement study is aborted at this wall.
  const deadlineMs = policy.budgets.maxImplementMinutes * 60_000;
  const goal = readIfExists(path.join(ROOT, "research/GOAL.md"));
  const style = readIfExists(path.join(ROOT, "research/STYLE.md"));
  const sc = stopController(deadlineMs);
  const r = await collect(query({
    prompt: `${goal}\n\n## Hypothesis to implement (id: ${h.id}, kind: ${h.kind})\n${h.title}\n\n${h.description}\n\nRationale: ${h.rationale}\n\n## Instructions\n- Implement exactly this hypothesis, minimally and idiomatically. Opt-in: new behavior behind a config field defaulting to today's semantics (except pure ablations/grader work as described).\n- Rust subject work lives in spur/spur-core; general configs in scheduler_configs/loop/. Grader work (only if kind=grader) lives in traceanalyzer/.\n- Build with cargo build --release --manifest-path spur/Cargo.toml --bin spur (or go build in traceanalyzer for grader work) and fix errors until it compiles. Run cargo test -p spur-core if you touched spur-core logic.\n- If the hypothesis needs the new mechanism enabled in the evaluation config, edit scheduler_configs/loop/general_vr.json to enable it (this is the config the evaluation runs).\n- Do NOT run git or gh. Do not create commits. Leave changes in the working tree.\n- The permission fence is final and there is NO human watching: if a Bash command is denied, do not stop to ask - accomplish the same thing with the Read/Edit/Write tools (all JSON/config/Rust edits go through Edit/Write, never shell text tools). Never end your turn with a question; end it with the work done or a clear statement of what blocked you after genuinely exhausting the allowed tools.\n- Measurement is the harness's job, not yours. Compile, and run AT MOST ONE short smoke run whose only purpose is to prove the changed path runs without crashing - a few hundred runs, one config, under two minutes. Any numbers it produces are discarded; the harness runs every real evaluation afterwards. Do NOT run comparative studies, multiple seeds, A/B baselines, or sweeps in this phase - that is measurement, it wastes the session's serial explore budget, and the wall clock will abort you. Smoke runs MUST write to --output-dir tmp/loop/<name> (the fence rejects anything else). Target under 2 minutes for config-only changes.\n- End with a concise summary: what changed (files), the config field that gates it, and what you expect it to do to the ladder.\n\n## Code style (mandatory)\n${style}`,
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
      canUseTool: makeImplementerGate(h.kind, policy.evaluation.rayonThreads),
      systemPrompt: "You are a careful systems engineer working inside a fenced research harness. You implement one hypothesis at a time, keep diffs minimal, and never touch protected paths (the permission gate enforces this - if a path is denied, work within the allowed lanes instead of fighting it).",
    },
  }));
  sc.dispose();
  // The abort was a stop only if the sentinel is present; otherwise it was
  // the implement wall, which blocks the hypothesis rather than parking it.
  const stopped = sc.controller.signal.aborted && existsSync(STOP_PATH);
  const timedOut = sc.controller.signal.aborted && !existsSync(STOP_PATH);
  return { summary: r.text, costUsd: r.costUsd, turns: r.turns, isError: r.isError, aborted: stopped, timedOut, activity: r.activity };
}

// Re-score the whole proposed pool against what has been learned since
// each entry was scored: merges move the baseline, negative results
// contradict neighbors, enabled mechanisms unlock dependents.
export async function rejudgePool(policy: Policy, pool: Hypothesis[], calibration: string, recentEvidence: string, utilization: string): Promise<RoleResult<RejudgeResult>> {
  return textRole({
    model: policy.models.judge,
    system: "You are an adversarial research lead re-scoring a hypothesis pool in light of new evidence. Proposals were scored before this evidence existed. Down-score what the evidence contradicts, up-score what it enables, park what is superseded or redundant, and keep the rubric's parameter-cost discipline.",
    prompt: `## Findings already established (observations log)\n${readIfExists(path.join(ROOT, "research/observations/OBSERVATIONS.md")).slice(-9000)}\n\n## Recent evidence (decisions, deltas, reflections)\n${recentEvidence.slice(0, 16000)}\n\n## Calibration: predicted vs realized\n${calibration || "(none)"}\n\n## Mechanism utilization in the evaluation config\n${utilization.slice(0, 4000)}\n\n${JUDGE_RUBRIC}\n\n## Pool to re-score\n${JSON.stringify(pool.map((h) => ({ id: h.id, kind: h.kind, title: h.title, description: h.description.slice(0, 600), buildsOn: h.buildsOn, expectedGain: h.expectedGain, expectedCost: h.expectedCost, parent: h.parent })), null, 1).slice(0, 40000)}\n\nRe-derive expectedGain and expectedCost from the rubric's anchors above rather than carrying a pool entry's existing numbers forward. The anchors change, and a score written against older ones does not mean what it says under these; a pool whose entries were scored against different anchors cannot be ranked against itself.\n\nReply with ONLY JSON: {"updates": [{"id": "...", "expectedGain": 0-10, "expectedCost": 0.1-10, "action": "keep"|"park", "reason": "one line"}]} covering EVERY pool id.`,
    schema: RejudgeResult,
    retries: 1,
  });
}

export async function reflectOnOutcome(policy: Policy, h: Hypothesis, evidence: string, counters: string): Promise<RoleResult<Reflection>> {
  return textRole({
    model: policy.models.reflect,
    system: "You are a research scientist writing a terse, information-dense lab-notebook entry after an experiment.",
    prompt: `## Hypothesis\n${JSON.stringify(h, null, 2)}\n\n## Evidence (evaluations, decision, diff summary)\n${evidence.slice(0, 20000)}\n\n## Mechanism counters, every counter the explorer emits\nA counter that reads zero here is off or unreached, not missing. Do not propose instrumenting a counter listed below.\n${counters.slice(0, 12000)}\n\nReply with ONLY JSON: {"hypothesisId": "${h.id}", "whatWeLearned": "...", "suggestedChildren": [...0-2 follow-up hypotheses, same shape as pool hypotheses...], "suggestedDeprioritize": ["hypothesis-ids"]}\nFor suggestedChildren use: ${HYPOTHESIS_JSON_GUIDE}`,
    schema: Reflection,
    retries: 1,
    stoppable: false,
  });
}

export async function runAudit(policy: Policy, iteration: number, statusMd: string, ledger: string, utilization: string, evalContext: string): Promise<RoleResult<AuditReport>> {
  return textRole({
    model: policy.models.audit,
    system: "You are an independent auditor of an autonomous research loop. You have no stake in any hypothesis. You look for waste, statistical weakness, metric gaming, and dead mechanisms. Be specific and quantitative.",
    prompt: `## Iteration\n${iteration}\n\n## Status\n${statusMd.slice(0, 12000)}\n\n## Evaluation protocol (use these sizes; runs per config multiply across the config grid)\n${evalContext}\n\n## Time/budget ledger\n${ledger.slice(0, 8000)}\n\n## Mechanism utilization (latest utilization.json dumps)\n${utilization.slice(0, 6000)}\n\nReply with ONLY JSON matching: {"atIteration": ${iteration}, "timeBreakdown": {"phase": seconds}, "budgetConcentration": "...", "statisticalPowerNotes": "...", "goodhartSignals": ["..."], "utilizationFindings": [{"mechanism": "...", "classification": "broken"|"unexercised"|"unrewarding"|"scaffolding"|"healthy", "evidence": "..."}], "recommendedPolicyChanges": ["..."]}`,
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
