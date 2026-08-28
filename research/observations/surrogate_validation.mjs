#!/usr/bin/env node
// Does an in-process reward rank arms the way the graded outcome does?
//
// For every panel member whose calibration observed violations, and for the
// evaluation spec against its oracle, run the evaluation template's arms
// under a round-robin campaign at a few seeds, then compute per arm the rate
// of every reward kind (from campaign.json's per-arm counter deltas) and the
// rate of the graded outcome (violations per arm second; on the evaluation
// spec, depth>=6 events per arm second). Report the Spearman rank
// correlation across arms within each host, averaged over seeds. A reward
// kind is admissible for an adaptive allocation when the rule at the bottom
// holds; the report writes one `admissible: <kind>` line per admitted kind,
// which the harness lint reads.
//
// Usage: node research/observations/surrogate_validation.mjs [--wall 120]
//        [--vr-wall 600] [--seeds 3] [--out research/observations/SURROGATE_VALIDATION.md]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const WALL = Number(opt("wall", 120));
const VR_WALL = Number(opt("vr-wall", 600));
const SEEDS = Number(opt("seeds", 3));
const OUT = opt("out", join(ROOT, "research/observations/SURROGATE_VALIDATION.md"));
const RHO_GATE = 0.7;
const RHO_VR = 0.7;
const MIN_VIOLATIONS_TO_JUDGE = 5;

const REWARD_PATHS = {
  termination_completed: "termination.all.plan_complete",
  hazard_crossing: "crash_recovery.crossing_deliveries",
  absorption_acted: "delivery_effects.all.acted",
  timeline_novelty: "timeline_keys.cumulative_distinct_keys",
  steps_used: "termination.all.steps_used_sum",
  runs: "termination.all.runs",
};

const policy = JSON.parse(readFileSync(join(ROOT, "research/policy.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(ROOT, policy.regression.panelManifest), "utf8"));
const template = join(ROOT, policy.evaluation.configTemplate);
const SPUR = join(ROOT, "spur/target/release/spur");
const TA = join(ROOT, "traceanalyzer/main");
const PORC = join(ROOT, "porcupine/batch");
const SCRATCH = join(ROOT, "tmp/loop/surrogate");
mkdirSync(SCRATCH, { recursive: true });

function leaf(v, path) {
  let cur = v;
  for (const seg of path.split(".")) { if (cur === null || typeof cur !== "object" || !(seg in cur)) return 0; cur = cur[seg]; }
  return typeof cur === "number" ? cur : 0;
}

function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(n); let i = 0; while (i < n) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; } return r; };
  const rx = rank(xs), ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

function runJson(cmd, argv) {
  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  return r.stdout ? JSON.parse(r.stdout) : null;
}

// One campaign session: returns per-arm { rewards: {kind: rate}, violationsPerSec, depth6PerSec }.
function session(host, spec, extra, model, wall, seed, oracle) {
  const out = join(SCRATCH, `${host}-${seed}`);
  rmSync(out, { recursive: true, force: true });
  const cfg = JSON.parse(readFileSync(template, "utf8"));
  Object.assign(cfg, extra, { session_seed: seed });
  cfg.campaign.allocation = { kind: "round_robin", min_slice_sec: Math.max(1, Math.min(20, wall / (2 * cfg.campaign.arms.length))) };
  const cfgPath = `${out}.config.json`;
  writeFileSync(cfgPath, JSON.stringify(cfg));
  execFileSync(SPUR, ["explore", "-e", "campaign", "--config", cfgPath, "-y", "--output-dir", out, "--set", `campaign.wall_budget_sec=${wall}`, spec], { cwd: ROOT, stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, RAYON_NUM_THREADS: String(policy.evaluation.rayonThreads ?? 30) } });
  const report = JSON.parse(readFileSync(join(out, "campaign.json"), "utf8"));
  const porc = runJson(PORC, ["-input", out, "-model", model]) ?? { violating_run_ids: [] };
  const rows = runJson(TA, ["-input", out, "-runs"]) ?? [];
  let depths = new Map();
  if (oracle) {
    const g = runJson(TA, ["-input", out, "-grade", "-dag-config", oracle, "-grade-max-runs", "0", "-grade-budget-ms", "0", "-grade-run-depths", "-format", "json"]);
    for (const [id, d] of g?.grade_dags?.[0]?.run_depths ?? []) depths.set(id, d);
  }
  const viol = new Set(porc.violating_run_ids ?? []);
  const perArm = {};
  for (const a of report.arms) perArm[a.id] = { wallSec: a.wall_ms / 1000, violations: 0, depth6: 0, rewards: {} };
  for (const r of rows) { const a = perArm[r.arm]; if (!a) continue; if (viol.has(r.run_id)) a.violations++; if ((depths.get(r.run_id) ?? 0) >= 6) a.depth6++; }
  for (const a of report.arms) {
    const acc = perArm[a.id];
    for (const [kind, p] of Object.entries(REWARD_PATHS)) acc.rewards[kind] = acc.wallSec > 0 ? leaf(a.counters, p) / acc.wallSec : 0;
    acc.violationsPerSec = acc.wallSec > 0 ? acc.violations / acc.wallSec : 0;
    acc.depth6PerSec = acc.wallSec > 0 ? acc.depth6 / acc.wallSec : 0;
  }
  rmSync(out, { recursive: true, force: true });
  for (const f of [cfgPath, `${out}.session.json`, `${out}.utilization.json`, `${out}.campaign.json`]) rmSync(f, { force: true });
  return perArm;
}

const hosts = [];
for (const m of manifest.members) {
  if ((m.calibration.rateViolations ?? 0) <= 0) continue;
  hosts.push({ id: m.id, spec: m.spec, model: m.porcupineModel, role: m.role, wall: WALL, oracle: null,
    extra: { ...m.overlay, num_crashes: m.faults.numCrashes, max_iterations: m.maxIterations } });
}
hosts.push({ id: "vr-depth6", spec: policy.evaluation.spec, model: "kv", role: "target", wall: VR_WALL, oracle: join(ROOT, policy.evaluation.oracleDags[0]), extra: {} });

const lines = ["# Surrogate validation", "", `Generated ${new Date().toISOString()} by research/observations/surrogate_validation.mjs (wall ${WALL} s per member session, ${VR_WALL} s on the evaluation spec, ${SEEDS} seed(s)).`, "",
  "For each host, every arm of the evaluation template ran under a round-robin campaign; each reward kind's rate per arm second is rank-correlated (Spearman) with the graded outcome's rate per arm second across arms, then averaged over seeds. Violations per second is the outcome on panel members, depth>=6 events per second on the evaluation spec.", ""];
const table = [];
const rhoByKind = {};
for (const h of hosts) {
  const perSeed = [];
  for (let s = 0; s < SEEDS; s++) {
    process.stderr.write(`${h.id} seed ${s}...\n`);
    try { perSeed.push(session(h.id, h.spec, h.extra, h.model, h.wall, 5000 + s, h.oracle)); } catch (e) { process.stderr.write(`  failed: ${e}\n`); }
  }
  if (perSeed.length === 0) continue;
  const arms = Object.keys(perSeed[0]);
  const outcomeKey = h.oracle ? "depth6PerSec" : "violationsPerSec";
  const totalViol = perSeed.reduce((a, p) => a + arms.reduce((b, id) => b + p[id].violations, 0), 0);
  const totalOutcome = perSeed.reduce((a, p) => a + arms.reduce((b, id) => b + (h.oracle ? p[id].depth6 : p[id].violations), 0), 0);
  const row = { id: h.id, role: h.role, events: totalOutcome, violations: totalViol, rho: {} };
  for (const kind of Object.keys(REWARD_PATHS)) {
    const rs = perSeed.map((p) => spearman(arms.map((id) => p[id].rewards[kind]), arms.map((id) => p[id][outcomeKey]))).filter((r) => r !== null);
    row.rho[kind] = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
    (rhoByKind[kind] ??= []).push({ host: h, rho: row.rho[kind], events: totalOutcome });
  }
  table.push(row);
  lines.push(`## ${h.id} (${h.role}, ${totalOutcome} graded events over ${perSeed.length} seed(s))`, "", "| arm | " + Object.keys(REWARD_PATHS).map((k) => `${k}/s`).join(" | ") + ` | ${outcomeKey} |`, "| --- |" + Object.keys(REWARD_PATHS).map(() => " --- |").join("") + " --- |");
  for (const id of arms) {
    const avg = (f) => (perSeed.reduce((a, p) => a + f(p[id]), 0) / perSeed.length);
    lines.push(`| ${id} | ` + Object.keys(REWARD_PATHS).map((k) => avg((a) => a.rewards[k]).toFixed(2)).join(" | ") + ` | ${avg((a) => a[outcomeKey]).toFixed(4)} |`);
  }
  lines.push("", "Spearman rho across arms: " + Object.entries(row.rho).map(([k, r]) => `${k} ${r === null ? "n/a" : r.toFixed(2)}`).join(", "), "");
}

lines.push("## Admissibility", "", `A reward kind is admissible when rho >= ${RHO_GATE} on every gate member with at least ${MIN_VIOLATIONS_TO_JUDGE} violations, rho >= 0 on every other member with at least ${MIN_VIOLATIONS_TO_JUDGE} violations, and rho >= ${RHO_VR} on the evaluation spec's depth>=6 rate. A member with fewer events is not counted either way.`, "");
const admitted = [];
for (const [kind, rows] of Object.entries(rhoByKind)) {
  let ok = true;
  let judged = 0;
  for (const r of rows) {
    if (r.events < MIN_VIOLATIONS_TO_JUDGE || r.rho === null) continue;
    judged++;
    if (r.host.role === "gate" && r.rho < RHO_GATE) ok = false;
    if (r.host.role === "report" && r.rho < 0) ok = false;
    if (r.host.role === "target" && r.rho < RHO_VR) ok = false;
  }
  const targetJudged = rows.some((r) => r.host.role === "target" && r.events >= MIN_VIOLATIONS_TO_JUDGE && r.rho !== null);
  if (ok && judged > 0 && targetJudged) admitted.push(kind);
  lines.push(`- ${kind}: ${ok && judged > 0 && targetJudged ? "admissible" : "not admissible"} (${judged} host(s) judged${targetJudged ? "" : ", evaluation spec not judged"})`);
}
lines.push("");
for (const kind of admitted) lines.push(`admissible: ${kind}`);
if (admitted.length === 0) lines.push("(no reward kind admitted)");
lines.push("");
writeFileSync(OUT, lines.join("\n"));
process.stderr.write(`wrote ${OUT}\n`);
