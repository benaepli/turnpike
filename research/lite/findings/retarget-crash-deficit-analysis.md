# Ghost-absorber crash retarget: where do the "missing" crashes go?

Read-only analysis of spur @ 1c4d55f plus the two chunk records under
`research/lite/state/ghost-absorber-crash-retarget/` and the baseline cache
`research/lite/baselines/d31b6194001d-30-f9daa01b-300-g47b08ab8.json`.

## Headline

1. **The 6.5% crash deficit is a denominator artifact, not a lost-crash route.**
   The census that produced "crashes applied per run" splits by
   `state.retarget.enabled` (scheduler.rs:1086-1090, util_stats.rs:1628-1640),
   and `enabled` is `ghost_absorber::is_treated(run_id)` (path.rs:308,
   explorer.rs:1105), which is *false for run-cap probes* (ghost_absorber.rs:28-30).
   So `victim_swap.census.control.crashes` counts control **and probe** crashes,
   while the parent divided it by the control-only run count from the variant
   cells (probes carry bit 2). Reproducing the parent's numbers exactly:

   | quantity (both chunks) | value |
   |---|---|
   | treated crashes / treated runs | 909,155 / 486,997 = **1.86686** |
   | control-bucket crashes / control-only runs | 975,217 / 488,161 = **1.99774** (parent's figure, wrong denominator) |
   | control-bucket crashes / (control + probe runs) | 975,217 / 519,803 = **1.87613** |
   | ratio treated/control, corrected | **0.995** (0.999 if probes land ~2.0 crashes/run, which they should: unplaced, full budget) |
   | baseline cache, all runs, crash_recovery.crashes / runs | 1,923,189 / 1,030,260 = **1.8667** |

   The treated half lands 1.8669 crashes per run; the untreated baseline lands
   1.8667. There is no crash deficit to explain beyond ~0.5%, and that residual
   is consistent with route (c) below (crashes gated by density edges on client
   ops the retargeted crash stranded).

2. **The plan-completion deficit (0.269 vs 0.335, -6.6 points) and the 6.3%
   longer runs are real** (computed per half from `metrics.variants`, which
   split correctly on bit 19). They are an intrinsic consequence of landing
   crashes on active nodes in a spec whose clients never time out, and the
   same route is what raised the depth-6 rung. Not a bookkeeping defect.

3. One genuine mechanism-specific defect exists but is tiny (order 50
   crash-runs per 240k-run chunk, i.e. the "few dozen crashes held to the run
   cap" the follow-up measured): the remap can turn a plan dependency edge
   into a wait cycle. Details under (a)/(b).

## Per-half data (from `metrics.variants`; treated = bit 19, probe = bit 2)

chunk-1000 / chunk-1001:

| half | runs | steps/run | planComplete | depth>=6 per 1k runs |
|---|---|---|---|---|
| control | 239,133 / 249,028 | 2133.6 / 2035.2 | 0.3416 / 0.3291 | 14.0 / 13.7 |
| treated | 238,575 / 248,422 | 2267.6 / 2163.8 | 0.2765 / 0.2619 | 22.9 / 24.3 |
| probe | 15,492 / 16,150 | 3333 / 3427 | 0.278 / 0.271 | 0.7 / 0.9 |

Baseline cache (no retarget, 4 arms): non-probe planComplete 0.3455, steps/run
2054.7, depth>=6 13.6 per 1k. The control half of the treated session matches
the baseline; the treated half is the outlier.

Per arm the planComplete drop is nearly constant across step budgets:
grid-short (max_iterations 1500) -6.3 / -6.2 points; grid (6000) -5.2 / -5.4;
grid-no-purgatory -6.8 / -7.0; grid-post-fault-2 -7.8 / -7.5; aos -6.4 / -7.8.
A 4x larger budget does not recover the completions, so the runs that fail are
not slow-but-completing runs cut off by a cap: they are runs that can never
complete. Termination counters are unsplit per half, but deadlock is 161/166
per chunk (negligible), so every non-completing run ends at
`learned_cap_reached` or `iterations_exhausted` (path.rs:833-866).

## Hypotheses against the code

### (a) Later planned crash on d after a retarget v -> d

- The crash lands on `victim` (= d) but the plan bookkeeping completes the plan
  node keyed on `planned` (= v): path.rs:683 `pending_crash.remove(&planned.index)`
  then `victim_remap.insert(planned.index, node_id)` (path.rs:687). The plan's
  Recover(v) is redirected at issue time: path.rs:564
  `victim_remap.remove(&nid.index).unwrap_or(nid)` and keyed on the landing node
  at path.rs:569 `pending_recover.insert(target.index, ..)`, completed at
  path.rs:702 on the actual recovered node. The pair stays consistent.
- A later plan Crash(d) (different pair; the generator serializes only on the
  plan victim, generator.rs:160-167) is pushed into `local_queues[d]`
  (state.rs:884-890) while d is down, and held by the crashed-victim check
  (scheduler.rs:788-807). It is released when Recover(v)->d lands. Then it is
  itself retargeted (scheduler.rs:1083). Not skipped, not lost. Confirmed rare
  by the follow-up measurement (~50 crash-runs per chunk generate the 488k/466k
  `victim_crashed_holds` tests, one test per queue scan per step).
- A later plan Crash(v): v is live, nothing is keyed on v being down; it applies
  normally. Its placement hold / anchor slot (path.rs:541-556, keyed on
  `nid.index` = v) is overwritten by the new draw.
- No runnable is dropped by the retarget: `crash_node(d)` drops Crash/Recover
  runnables **of d** from d's local queue and the network queue
  (scheduler.rs:1409-1415, 1450-1451), but a node with `crash_pending > 0` is
  excluded from the candidate set (scheduler.rs:1376-1379), and a Recover for d
  can only exist while d is already down. `crash_pending` is kept exact by
  push/take (state.rs:884-890, 917-925).

**The one real defect (tiny):** the hold at scheduler.rs:788-807 assumes the
remapped Recover(v)->d will eventually be issued. Under `dependency_density
0.3` the generator adds arbitrary acyclic edges (generator.rs:253-269). An edge
`Crash(d) -> Recover(v)` is legal there (no path Recover(v) -> Crash(d) when
v != d). On a treated run where Crash(v) lands on d, Recover(v) now waits for
Crash(d), Crash(d) is held because d is down, and d is down until Recover(v)
lands: a wait cycle the plan DAG did not contain. The run sits at the cap with
one crash and one recover outstanding. Control has no such cycle (Crash(d)
lands on live d). The same shape arises when Recover(v) depends on a client op
the crash of d stranded. Both are what the "held until run cap" crashes are.
Fix options that keep the mechanism: (i) exclude from `choose()` any node that
still has an uncompleted plan CrashNode event (compute the per-node set of
outstanding plan crashes from the plan at run start, not just the released
ones; this also removes the need for the crashed-victim hold entirely, at the
cost of fewer eligible absorbers with 3 servers); (ii) release a held Crash(d)
by retargeting it immediately (treat d-down as "victim unavailable" and run
`choose()` with d excluded rather than holding); (iii) leave it, it is ~2 per
10k runs.

### (b) Plan DAG bookkeeping keyed on node vs plan node

`PlanEngine` is keyed purely on plan `NodeIndex` (plan.rs:104-124); the path
loop maps runnable outcomes to plan nodes through `pending_crash` (keyed on
planned victim index), `pending_recover` (keyed on the node the recover
targets), and `victim_remap` (planned -> landing). Each map key is unique at
any time: at most one released crash per plan victim (serialization,
generator.rs:160-164), at most one recover per down node (a crash needs a live
target). Verified transitions:

- v -> d, Recover(v) -> d: remap consumed at path.rs:564. OK.
- v -> d, then Crash(w) -> v (v live, not in mask since `pending_crash[v]` was
  removed and `pending_recover` is keyed on d): Recover(w) -> v, Recover(v) -> d.
  OK, two recovers on two nodes.
- Swap twice (v -> d, later Crash(d) -> v): remap[d] = v set only after
  Recover(v) -> d landed, so keys never collide. OK.
- `pending_pair_mask` is rebuilt every step after the ready events are pushed
  (path.rs:617-625) and read at apply time (scheduler.rs:1377), so a crash
  pushed this step is excluded this step. OK.

No node-keyed state strands a plan event. The only DAG-level problem is the
cycle in (a).

### (c) Client-op strand route (the judge's route) - this is the real one

VR.spur's client loops have no timeout: `ClientInterface.Write`/`Read`
(VR.spur:632-660) block on `<- current_target->Write(...)` and retry only on
a redirect *response*. A primary that has accepted a request (`NewEntry`
creates the promise in `pending_requests`, VR.spur:56, 560-580) and crashes
before replying loses the promise with its memory; the client's record waits
forever. The run cannot deadlock-terminate because `monitor_timeouts` timers
keep `all_queues_empty()` false (path.rs:428-431), so it runs to the cap with
the plan incomplete. This is why control completes only 33% of plans and
deadlock is ~0.03%.

Retargeting makes this strictly more frequent: the absorber is "the live node
that most recently took a delivery from a crashed/restarted sender, acted
marks first" (ghost_absorber.rs:76-112). In VR a backup's ghost messages
(PrepareOK) go to the primary, and processing a PrepareOK writes
`prepare_ok_counts` -> an acted mark on the primary. So after a backup crash the
next planned crash moves onto the primary; with 3 servers and both crashes
queued from step 0 the only candidate is the third node anyway
(`crash_pending > 0` excludes the other planned victim), so the retarget fires
exactly when that third node is the one holding ghost-derived state, which is
the primary in the backup-crash case. Control crashes the primary with
probability 1/2 in that situation; treated with probability ~1 when a mark
exists. Census agrees: treated victims had absorbed 31% vs 17% on control.

Downstream effects: (1) more stranded client ops -> fewer plan completions
(-6.6 points, budget-independent per arm as shown above); (2) more view changes
-> longer runs (1.063x); (3) plan crashes whose incoming density edges come
from stranded client ops are never released -> the ~0.5% residual crash
difference; (4) the recover for the crashed primary still lands (it depends
only on the crash), so `crash_recovery.recovers` is not what drops.

Nothing in the release path is keyed on node identity except the placement
hold and anchor slot, which are keyed on the *planned* victim (path.rs:541-556,
scheduler.rs:701-726) and gate the runnable in that victim's local queue -
identical on both halves.

### (d) Run cap

`effective_cap` is read once per run from the probe-learned table
(run_cap.rs:122-124, path.rs:310-315) and probes are never treated
(ghost_absorber.rs:29), so the cap is identical for both halves and learned from
untreated lengths. Treated runs are longer and so hit it more often, but the
per-arm evidence (grid-short at 1500 and grid at 6000 lose the same ~6 points)
says the cap is where stranded runs *end*, not why they fail. At the cap a run
counts `engine.outstanding_count()` (path.rs:838-841, 862-864) and no crash is
added or removed. `run_cap.over_cap_completions` = 12/11 shows the cap rarely
truncates completing *probes*; a treated-only version of that counter would be
needed to bound truncation of treated completions, and cannot be read from the
unsplit termination block.

### (e) Other findings

- **Measurement contamination on treated runs:** the crash-anchor, crash-census,
  term-acted and crash-phase apply counters read the ledger of the *planned*
  node before `retarget_crash` runs (scheduler.rs:1069-1082), so for the ~17%
  of treated crashes that moved, `delivery_effects.crash_census.*`,
  `crash_anchor.applied`, and `crash_phase.*.apply_*` attribute v's in-flight
  state to a crash that hit d. Only `record_victim_swap_census` (1086-1090) and
  `record_crash` inside `crash_node` see the real victim. Harmless to the
  contrast that matters, but any reading of the anchor/phase census on this
  branch must drop treated runs.
- **Anchor slot on v:** `crash_phase.arm_of(node_id.index)` reads the planned
  node; after the crash lands on d, v's slot stays `Released` and d never had
  one. Cosmetic for the same reason.
- **`skipped_pending_pair` fallback:** `choose()` continues down the ranking and
  returns `NoAbsorber` (crash stays on v) only when every marked node is
  excluded (ghost_absorber.rs:92-111). Correct.
- **Recover remap under a double swap:** covered in (b); keys never collide.
- **crash_node early return** ("already crashed", scheduler.rs:1397-1400) is
  unreachable on either half: the candidate filter takes only live nodes and
  the crashed-victim hold keeps the planned victim live.

## What would confirm each

1. Denominator artifact: add `victim_swap.census.probe.crashes` (split the
   control bucket by `run_cap::is_probe`) or record crashes per variant cell in
   `metrics.variants`. Expect treated/control-only ~= 0.995-1.0.
2. Strand route: per-variant termination reasons (planComplete /
   learnedCap / exhausted per cell) and a per-half counter "runs ending with a
   client op in progress". Expect the treated excess of cap-ended runs to equal
   the planComplete deficit and to be budget-independent. A direct probe: count
   crashes whose actual victim was `primary_of(view_number)` at crash time,
   per half.
3. DAG cycle: count, per half, runs ending at the cap with a `Runnable::Crash`
   still queued whose victim is in `currently_crashed` (or simply
   `victim_crashed_holds` per run rather than per test). Expect ~2 per 10k
   treated runs, 0 control.

## Classification

- Crash deficit: **not a deficit** - mis-normalized census (probes in the
  control bucket). Fixable by reporting the census per variant cell.
- planComplete -6.6 points and +6.3% steps: **(2) intrinsic** to landing crashes
  on the node that holds ghost-derived state, which in VR is usually the
  primary mid-request, with a client that never retries. The same fact is why
  depth-6 rose. **(3) run cap** is only the terminator, not the cause (same
  deficit at 1500 and 6000 steps).
- The crashed-victim hold-to-cap: **(1) a small bookkeeping/mechanism gap**
  (remap can create a Crash(d) -> Recover(v) -> d-live -> Crash(d) wait cycle
  under density edges), ~2 per 10k treated runs, fixable inside `choose()` by
  excluding nodes with any uncompleted plan crash.

## File references

- spur/spur-core/src/simulator/ghost_absorber.rs:28-30 (probes untreated), 76-112 (choose)
- spur/spur-core/src/simulator/core/scheduler.rs:701-726 (hold mask on planned victim), 783-807 (crashed-victim hold), 1069-1082 (pre-retarget census reads planned ledger), 1083-1095 (retarget + census by `retarget.enabled`), 1362-1393 (retarget_crash), 1396-1460 (crash_node)
- spur/spur-core/src/simulator/core/state.rs:875-893 (push_runnable), 917-925 (take_local), 1057-1071 (ghost marks)
- spur/spur-core/src/simulator/path.rs:308, 325-327, 396-420, 428-460, 530-570, 617-625, 671-705, 833-866
- spur/spur-core/src/simulator/path/plan.rs:104-124; path/generator.rs:156-167, 210-248, 253-269
- spur/spur-core/src/simulator/util_stats.rs:1628-1640, 3191-3253
- spur/spur-core/src/simulator/run_cap.rs:115-124; fault_timing.rs:72-75, 173-195
- bin/spur/VR.spur:56, 560-580 (NewEntry promise), 600-620 (server timers), 632-660 (client loops, no timeout)
