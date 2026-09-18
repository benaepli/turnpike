// Did the mechanism a hypothesis predicted actually fire?
//
// A mechanism with no occasions produced no evidence either way, so its rate
// deltas are the null band wearing the hypothesis's name. The answer is
// computed here, never asked of a model: from the counter the prediction
// declares, read out of the utilization dump the loop already collects under
// `util:<hypothesis id>`, or - when the change is config only and declares no
// counter - from the config paths it moved, mapped to the counters they gate.
// An unmapped path voids the check, which is the safe direction.
import { numericLeaves } from "./evaluate.js";
import { CAMPAIGN_ONLY_KEYS } from "./runners.js";
import type { Prediction } from "./schemas.js";

// Config path prefix -> the counter it gates. A path matches a prefix exactly
// or as a dotted extension of it, longest prefix first, so `feedback.steer`
// is not read as `feedback`.
const CONFIG_PATH_COUNTERS: ReadonlyArray<readonly [string, string]> = [
  ["post_fault_client_ops", "post_fault_ops.pairs_seen"],
  ["purgatory", "purgatory.delayed_sends"],
  ["feedback.steer", "steer.evaluations"],
  ["feedback", "feedback.scored_runs"],
  ["use_coverage_scheduling", "feedback.scored_runs"],
  ["quick_fire_multiplier", "multiplier_authority.quick_fire_decisions"],
  ["emit_multiplier_authority", "multiplier_authority.decisions"],
  ["rng_stream_isolation", "rng_streams.isolated_runs"],
  ["within_queue_selector", "multiplier_authority.decisions"],
  ["queue_policy", "multiplier_authority.decisions"],
  ["schedule_policy", "multiplier_authority.decisions"],
];

// Paths the runner overwrites or deletes before the explorer sees them. A
// difference on one of these is the harness's, not the candidate's: counting
// `campaign.arms` as an unmapped mechanism voided every arm-kind candidate on
// a key the config materializer deletes.
const RUNNER_OVERWRITTEN: readonly string[] = [
  ...CAMPAIGN_ONLY_KEYS,
  "num_runs_per_config", "session_seed", "num_crashes", "max_iterations", "wall_budget_sec",
];

function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`);
}

export type FiringStatus =
  | "fired"            // the mechanism had occasions
  | "no-occasions"     // the counter exists and stayed below its floor
  | "unknown"          // nothing in the record can answer the question
  | "no-config-change" // a config-only change that moved no path
  | "not-claimed"      // the hypothesis stated no prediction
  | "uncollected";     // no counters were collected at all: a harness gap

export interface FiringResult { status: FiringStatus; detail: string }

/** Whether the sample is evidence about the hypothesis. `not-claimed` passes
 *  so entries admitted before predictions were required are judged on their
 *  rates as before; everything else that is not `fired` is a sample about
 *  nothing. */
export function firingPasses(r: FiringResult): boolean {
  return r.status === "fired" || r.status === "not-claimed";
}

/** No counters at all is the harness failing to look, not the mechanism
 *  failing to fire, and must not be recorded as a negative result. */
export function firingIsHarnessGap(r: FiringResult): boolean {
  return r.status === "uncollected";
}

/** Every numeric counter in a utilization dump, under its dotted path. */
export function countersOf(raw: string | null): Record<string, number> {
  if (raw === null || !raw.trim().startsWith("{")) return {};
  try {
    const out: Record<string, number> = {};
    numericLeaves(JSON.parse(raw), "", out);
    return out;
  } catch { return {}; }
}

/** Dotted paths whose values differ between two config templates, with the
 *  runner-overwritten ones dropped. null when either side is missing or is
 *  not JSON, which voids the check rather than reading an empty diff as no
 *  change. */
export function changedConfigPaths(before: string | null, after: string | null): string[] | null {
  if (before === null || after === null) return null;
  const flatten = (text: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (v: unknown, prefix: string): void => {
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        for (const [k, sub] of Object.entries(v as Record<string, unknown>)) walk(sub, prefix ? `${prefix}.${k}` : k);
        return;
      }
      out[prefix] = JSON.stringify(v);
    };
    walk(JSON.parse(text) as unknown, "");
    return out;
  };
  let a: Record<string, string>;
  let b: Record<string, string>;
  try { a = flatten(before); b = flatten(after); } catch { return null; }
  const paths = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...paths]
    .filter((p) => a[p] !== b[p])
    .filter((p) => !RUNNER_OVERWRITTEN.some((r) => underPrefix(p, r)))
    .sort();
}

export interface FiringInputs {
  prediction: Prediction | null;
  counters: Record<string, number>;
  changedSpurFiles: string[];
  /** From `changedConfigPaths`; null voids the config route. */
  configPaths: string[] | null;
}

export function firingCheck(i: FiringInputs): FiringResult {
  if (i.prediction === null) return { status: "not-claimed", detail: "the hypothesis states no prediction" };
  if (Object.keys(i.counters).length === 0) {
    return { status: "uncollected", detail: "no utilization counters were collected for this candidate" };
  }
  const declared = i.prediction.firingCounter;
  if (declared !== null) {
    const v = i.counters[declared];
    if (v === undefined) return { status: "unknown", detail: `the declared counter ${declared} is not in the utilization dump` };
    return v >= i.prediction.firingFloor
      ? { status: "fired", detail: `${declared} = ${v} at or above its floor of ${i.prediction.firingFloor}` }
      : { status: "no-occasions", detail: `${declared} = ${v}, below its floor of ${i.prediction.firingFloor}` };
  }
  if (i.changedSpurFiles.length > 0) {
    return { status: "unknown", detail: "the change touches spur source and declares no firing counter" };
  }
  if (i.configPaths === null) return { status: "unknown", detail: "the config templates could not be compared" };
  if (i.configPaths.length === 0) return { status: "no-config-change", detail: "no config path the explorer reads differs from the baseline" };
  const unmapped: string[] = [];
  const quiet: string[] = [];
  const fired: string[] = [];
  const byLength = [...CONFIG_PATH_COUNTERS].sort((x, y) => y[0].length - x[0].length);
  for (const p of i.configPaths) {
    const hit = byLength.find(([prefix]) => underPrefix(p, prefix));
    if (hit === undefined) { unmapped.push(p); continue; }
    const v = i.counters[hit[1]] ?? 0;
    (v > 0 ? fired : quiet).push(`${p} -> ${hit[1]} = ${v}`);
  }
  if (unmapped.length > 0) return { status: "unknown", detail: `no counter is mapped for ${unmapped.join(", ")}` };
  if (quiet.length > 0) return { status: "no-occasions", detail: quiet.join("; ") };
  return { status: "fired", detail: fired.join("; ") };
}

export function selfTestFiring(): string[] {
  const f: string[] = [];
  const check = (c: boolean, m: string): void => { if (!c) f.push(m); };
  const counters = { "purgatory.delayed_sends": 175287, "feedback.scored_runs": 1080, "steer.evaluations": 2125405, "steer.divergent_picks": 0 };
  const pred = (over: Partial<Prediction>): Prediction => ({
    firingCounter: null, firingFloor: 1, rung: "depth>=6", sizePct: { min: 0.05, max: 0.2 },
    mechanism: "x".repeat(20), independentObservable: "y".repeat(10), falsifier: "z".repeat(20), ...over,
  });
  const run = (over: Partial<FiringInputs>): FiringResult =>
    firingCheck({ prediction: pred({}), counters, changedSpurFiles: [], configPaths: [], ...over });

  check(firingCheck({ prediction: null, counters, changedSpurFiles: [], configPaths: [] }).status === "not-claimed",
    "no prediction is not a firing failure");
  check(firingCheck({ prediction: pred({}), counters: {}, changedSpurFiles: [], configPaths: [] }).status === "uncollected",
    "no counters at all is a harness gap, not a negative result");
  check(run({ prediction: pred({ firingCounter: "purgatory.delayed_sends" }) }).status === "fired",
    "a declared counter above its floor fired");
  check(run({ prediction: pred({ firingCounter: "steer.divergent_picks" }) }).status === "no-occasions",
    "a declared counter at zero had no occasions");
  check(run({ prediction: pred({ firingCounter: "purgatory.delayed_sends", firingFloor: 1e9 }) }).status === "no-occasions",
    "the floor is the claim, not a constant");
  check(run({ prediction: pred({ firingCounter: "not.a.counter" }) }).status === "unknown",
    "a counter the dump does not carry cannot be checked");
  check(run({ changedSpurFiles: ["spur-core/src/lib.rs"] }).status === "unknown",
    "a spur change with no declared counter cannot be checked");
  check(run({ configPaths: null }).status === "unknown", "config templates that cannot be compared void the check");
  check(run({ configPaths: [] }).status === "no-config-change", "a config change that moved no path fired nothing");
  check(run({ configPaths: ["purgatory.delay_probability"] }).status === "fired", "a mapped config path reads its counter");
  const steer = run({ configPaths: ["feedback.steer.weight"] });
  check(steer.status === "fired" && steer.detail.includes("steer.evaluations"),
    `feedback.steer must read the steer counter, not feedback's, got ${steer.status} (${steer.detail})`);
  check(run({ configPaths: ["some_new_knob"] }).status === "unknown", "an unmapped path voids the check");

  // The runner overwrites these before the explorer sees them, so a
  // difference on one of them is not the candidate's mechanism.
  const before = JSON.stringify({ session_seed: 1, campaign: { arms: [{ id: "a" }] }, purgatory: { delay_probability: 0.1 }, num_crashes: 2 });
  const after = JSON.stringify({ session_seed: 2, campaign: { arms: [{ id: "b" }] }, purgatory: { delay_probability: 0.3 }, num_crashes: 3 });
  const moved = changedConfigPaths(before, after);
  check(moved?.join(",") === "purgatory.delay_probability", `only the mechanism path may count, got [${moved?.join(", ")}]`);
  check(changedConfigPaths(before, before)?.length === 0, "an unchanged template moves no path");
  check(changedConfigPaths(before, "{oops") === null, "an unparseable template voids the check");
  check(changedConfigPaths(null, after) === null, "a missing template voids the check");

  check(firingPasses({ status: "fired", detail: "" }) && firingPasses({ status: "not-claimed", detail: "" }),
    "fired and not-claimed are the passing statuses");
  for (const s of ["no-occasions", "unknown", "no-config-change", "uncollected"] as const) {
    check(!firingPasses({ status: s, detail: "" }), `${s} must not pass the firing check`);
  }
  check(firingIsHarnessGap({ status: "uncollected", detail: "" }) && !firingIsHarnessGap({ status: "no-occasions", detail: "" }),
    "only an uncollected dump is a harness gap");
  return f;
}
