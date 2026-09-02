# Lite Loop Hypothesis Pool

Scored candidates awaiting implementation. One section per hypothesis: id,
kind, title, description, frozen prediction, expectedGain/expectedCost,
origin (proposer | operator-agent | user),
status (proposed | awaiting-approval | implemented | closed | merged | human).

## timer-refire-outcome-quantile

- kind: add | category: scheduler | origin: user | status: closed (2026-08-31, refuted net of A/A drift control)
- title: Cross-run learned refire budget: damp a timer class past the firing
  count that completed runs exhibit
- description: Session-global per-timer-class (resume vertex) firing-count
  histogram split by run outcome (Completed vs IterationsExhausted), merged
  at run end from TimerRunStats, decayed like GlobalTimeline. Derives a
  per-class refire budget (~p90 of completed-run firing counts,
  Laplace-smoothed, min 200 firings before deviating). In score_runnable a
  Runnable::Timer whose within-run count for that node passed its budget is
  score-multiplied by 0.25 (bounded, never zero). No config field. Counters:
  timer_refire_budget.damped / .classes_learned / .over_budget_firings.
- frozen prediction (admitted 2026-08-30): firingCounter
  timer_refire_budget.damped, floor 50000; rung depth>=6; sizePct 0.04-0.15;
  falsifier: damped >= 50000 yet depth>=6/s ratio < 1.03 at the sequential
  cap, or h2 drops > 2% relative. Independent observable:
  termination.all.iterations_exhausted share falls >= 3pp from ~72%, and
  timer_effects.inert_streak.long.fired per run falls >= 25% while
  timer_effects.all.acted per run stays within 5%.
- judge: expectedGain 6, expectedCost 0. All citations verified. Red team:
  count-conditioning may reduce to the falsified phase-of-budget gating;
  outcome labels are length-confounded (exhausted runs fire more of every
  class); score damping cannot shorten exhausted runs (no stall exit merged),
  so the runs/s story depends entirely on completion conversion.

## timer-class-completion-credit

- kind: add | category: feedback | origin: user | status: proposed
- title: Per-class completion-odds credit reweighting within the timer queue
- description: Session-global per-class (completed, exhausted) firing weights
  from TimerRunStats + RunOutcome, decayed; bounded multiplier [0.5, 2.0] =
  smoothed odds ratio vs session average, identity until 200 firings, applied
  in score_runnable. Two-sided (promotes and demotes). No config field.
  Counters: timer_outcome_credit.reweighted / .up / .down / .classes.
- frozen prediction (rewritten by judge before admission, per rubric): rung
  depth>=6, sizePct 0.02-0.10, firingCounter timer_outcome_credit.reweighted,
  floor 50000. Independent observable REWRITTEN: timer_steer.raised/lowered
  admission split shifts >= 5% relative and .up and .down each exceed 10% of
  .reweighted (the original timer_effects.by_key table is not in the exported
  eval record). Falsifier: reweighted >= 50000 with .up and .down nonzero,
  yet depth>=6/s ratio < 1.02 AND plan_complete share moves < 1pp.
- judge: expectedGain 4, expectedCost 0. Rides the same learning mechanism as
  timer-refire-outcome-quantile (dedupe: only one ranks high). Value: cheapest
  premise test for the family; a null discounts the siblings' learning half.

## timer-send-debt-brake

- kind: add | category: scheduler | origin: user | status: proposed
- title: Within-run message-debt brake: deprioritize a timer whose previous
  firings' sends are still undelivered
- description: Tag records enqueued in timer-woken segments with the waking
  timer's resume vertex; per-(node, vertex) debt = such records still
  undelivered; Runnable::Timer with debt d scores * max(0.25, 1/(1+d)).
  Counters: timer_debt.evaluated / .damped / .peak.
- frozen prediction: rung depth>=6, sizePct 0.03-0.12, firingCounter
  timer_debt.damped, floor 50000. Independent observable (2nd clause
  rewritten by judge): deliveryEffects deliveries per run falls >= 8% with
  acted_fraction rising, and termination.all.pending_work_at_exit_sum per
  completing run falls >= 15% from baseline ~29.6 (the cited ~9k backlog
  figure was unsupported). Falsifier: damped >= 50000 yet depth>=6/s < 1.03,
  or deliveries per run unchanged, or h2 regresses > 2% relative.
- judge: expectedGain 4, expectedCost 2 (hooks the record lifecycle — event
  accounting surface; a missed decrement path silently biases). Red team:
  against a never-draining frontier debt is almost always positive, so the
  brake likely collapses to the falsified uniform timer down-weight.

## learned-run-cap-probe-p99

- kind: add | category: scheduler | origin: user | status: merged (3bb90a1, 2026-08-31; prediction band missed low, see observations)
- title: Session-learned primary run cap at p99 x 1.5 of probe-completed
  lengths; config max_iterations demoted to backup terminator
- description: New run_cap.rs session-global learner keyed by post-arm-overlay
  max_iterations (backup budget). run_id % 32 == 0 runs are probes: always run
  to backup, sole feeders of the learner. Non-probe effective cap =
  min(backup, ceil(1.5 * p99 of scope's completed-probe lengths)), identity
  until 200 completed probe samples per scope. New termination class
  (RunEnd/RunOutcome LearnedCapReached, termination.all.learned_cap_reached).
  Learner exports run_cap.probes / .probe_completions / .over_cap_completions
  (would-have-been-killed completions - absorbs variant 3's safety
  measurement) / .scopes_learned / .current_cap_max_scope (diagnostic). Zero
  config fields; constants PROBE_PERIOD=32, QUANTILE=0.99, HEADROOM=1.5,
  MIN_COMPLETED_SAMPLES=200. Plan:
  research/lite/plans/learned-run-cap-probe-p99.md
- frozen prediction (freezes at user approval): firingCounter
  termination.all.learned_cap_reached, floor 1000; rung depth>=6
  events/explore-second; sizePct +0.30 to +1.20. Falsifier: per-run
  P(depth>=6) falls > 5% below same-seed baseline in any capped arm after an
  A/A drift control; or rate gain < +30% with the cap engaged; or
  learned_cap_reached stays 0 while the 6000 scope has >= 200 completed
  probe samples. Independent observables: iterations_exhausted share in
  6000-backup scopes collapses toward the ~1/32 probe share;
  run_cap.probes ~ runs/32; over_cap_completions reported (large values are
  the conservatism warning). Judge rewrite applied: "cap settles below 4000"
  demoted to reported diagnostic.
- judge: expectedGain 7, expectedCost 0. All citations and code anchors
  verified; effect arithmetic redone (gain +122% if cap lands ~1500, ~+45%
  at ~3200, ~+15% at ~4700; realized point hangs on unmeasured p99). Risks:
  depth preservation at short caps approximate (grid-short -3.1% pooled vs
  the 5% clause with ~2.5% chunk noise); gain is throughput-shaped
  (legitimate: violations are per-run events, so runs/s at flat per-run
  probability is violations/s).

## learned-run-cap-max-observed

- kind: add | category: scheduler | origin: user | status: closed (dominated: parent merged with per-run depth preserved; headroom question answered)
- title: Conservatism contrast: primary cap at running max of
  probe-completed lengths
- Held unbuilt per judge familyAdvice: activate only if
  learned-run-cap-probe-p99 trips its depth-preservation falsifier (then
  max-observed is the conservative frontier to price); close as dominated if
  the parent passes. expectedGain 4, expectedCost 0. Prediction as proposed
  (+8-30% d>=6/s, floor 100 on termination.learned_cap_reached) with judge
  rewrite pending if activated: "plan_complete unchanged" must exclude the
  pre-convergence warmup window.

## learned-cap-progress-conditioned

- kind: add | category: scheduler | origin: user | status: rejected-by-judge
- title: Progress-conditioned learned cap (terminate only quiescent runs
  past the learned length)
- Rejected on a checkable false claim: baseline prefix_extension counters
  show 100% of exhausted runs are budget_releasing, tail_without_release_sum
  22043/347880 runs (~0.06 steps/run) - the arming condition (release-free
  stretch >= max(cap/8, 64)) essentially never passes under the current
  purgatory dose; the proposal conflated no-history-growth quiescence with
  the release census. Its safety-measurement goal is folded into the
  parent's run_cap.over_cap_completions export.

## timer-admission-context-odds-probe

- kind: add | category: scheduler | origin: user | status: MERGED 2026-08-31
  (superproject ed21963, spur 249189d; d>=6/s pooled 1.190, per-run +30%)
- title: Steer effective p_timer at queue selection by learned
  per-context-cell timer acted odds
- Moderated lane, third user idea. Probe runs (run_id % 32 == 16, disjoint
  from run_cap's phase 0) learn per-cell timer acted rates from the existing
  per-firing state-token probe; steered runs multiply p_timer at the
  Probabilistic roll by clamp(cell_rate/global_rate, 0.25, 4.0), 200-firing
  floor per cell, 48 structural cells (pending-deliveries x in-flight x
  node-max inert streak x restart recency). No config field. Judge: gain 6,
  cost 0 - every checkable claim verified; baseline shows 2.5-60x acted-rate
  separation on two of four cell axes; but ~92% of firings are at
  uncontested steps, so the lever is promotion-only over ~8% of firing mass
  (band trimmed to +2..6% accordingly). Plan (with the judge's four
  admission conditions): research/lite/plans/timer-admission-context-odds-probe.md.
  Prediction freezes at user approval.

## timer-admission-two-arm-acted-contrast

- kind: add | category: scheduler | origin: user | status: not-admitted
  (judge gain 3, cost 0)
- title: Two-arm probe contrast - timer vs displaced delivery, per
  structural context
- Same lever and cells as timer-admission-context-odds-probe. Judge
  arithmetic kills it as written: global timer odds 0.138 vs delivery odds
  0.650 puts the unnormalized odds ratio (~0.21) below the 0.25 clamp floor,
  so nearly every cell saturates at x0.25 - the refuted uniform down-weight
  with extra machinery; delivery-draw cell attribution is also unspecified
  (counterfactual timer unidentified at delivery wins). Its stated
  starvation risk is empty (~555k timer-arm samples/chunk). Revisit only if
  the parent merges AND per-cell probe rates suggest delivery-conditioned
  contrast adds information - then with global-odds normalization and an
  attribution rule.

## timer-steer-coverage-holdout-governor

- kind: add | category: scheduler | origin: user | status: rejected-by-judge
  (gain 1)
- title: Context-odds timer bias governed by a randomized coverage holdout
- Governor statistic is degenerate under the current config:
  general_vr.json sets novelty_enabled false, and the baseline shows all
  347,880 runs novelty-ablated with 5 cumulative distinct timeline keys -
  novel-keys-per-run compares ~0 vs ~0, so the governor never governs. The
  holdout idea itself is already present in the parent (phase-16 probes).
  Revisit only if a novelty-enabled config lands via its own re-baselined
  iteration.

## run-cap-trajectory-variance-fix

- kind: change | category: scheduler | origin: operator-agent | status: MERGED 2026-08-31
  (c61d303, spur 46b9c5c; A/A 1.004-1.007 vs 1.10-1.14 disease; one proxy
  clause fired once, recorded;
  judge gain 7, cost 0 - ranked first over the four fault-timing proposals;
  plan research/lite/plans/run-cap-trajectory-variance-fix.md, amended at
  the hold per user objection to freeze-forever under future long
  non-stationary sessions - shape is now deterministic doubling-checkpoint
  recompute at completed counts 200, 400, 800, ...; constant between
  checkpoints, adaptive forever, zero new constants)
- title: Shrink the learned run cap's session-to-session trajectory variance
- Motivating fact (2026-08-31 A/A control): identical binary/config/seed drew
  cap 4283 vs 5975; cap trajectory alone moves runs/s and every per-second
  rung ~14% at chunk scale, so the grader's per-second null bands understate
  the true null. Candidate shapes (one per iteration, not together): freeze
  the cap after N probe completions instead of tracking a racing quantile;
  widen the probe stream or the histogram's sample floor so the p99 estimate
  stabilizes before the cap engages; or blend toward a longer-horizon
  quantile. Prediction to freeze at admission: A/A base-vs-base throughput
  ratio inside ~1.03 (vs today's 1.14) with the merged tree's depth
  rates preserved. Doubles as the quantile/headroom dose-contrast vehicle.

## crash-placement-completion-span-draw

- kind: add | category: scheduler | origin: proposer | status: MERGED 2026-09-01
  (cfdcdf6, spur 032ea69; d>=6/s 2.39, posture contrast 2.157x, panel
  paxos per-run violations +35%; band missed high)
- title: Crash placement drawn uniformly over the completed-run span instead
  of geometrically at readiness
- Crash timing is the census-named open axis (baseline: 3.70M crash-eligible
  steps vs 722.6k crashes taken - placement is geometric within ~5 eligible
  steps of readiness); actuator is the eligibility mask, which the census
  shows has authority. Posture split ((run_id >> 5) & 1): half of runs stay
  exactly stock, giving an internal placed-vs-stock contrast immune to
  residual measurement noise.
- FROZEN PREDICTION (admission rewrite applied 2026-09-01, judge conditions
  a-d folded in): rung depth>=6, sizePct +5..25% per second; firingCounter
  crash_place.holds, floor 50000 per chunk; diagnostics crash_place.draws,
  crash_place.capped_draws, crash_place.held_steps_sum exported beside it.
  Mechanism bounds per the rewrites: draw t ~ U[t_ready, min(L50,
  3*effective_cap/4)) - the quarter reserve is the recovery-tail margin;
  L50 learned only from stock-posture uncapped probes (run_id % 64 == 0)
  in a fault_timing.rs scope table with doubling-checkpoint recomputes
  (the run_cap pattern), 200-sample floor. Falsifier: with holds >= 50000
  per chunk, refuted if placed-posture pooled per-run P(depth>=6) <=
  stock-posture pooled per-run P(depth>=6) on the candidate side (primary,
  same seeds), or if candidate/baseline pooled per-run P(depth>=6) < 1.05
  net of a same-session A/A control; closed without a rate read if holds
  < 50000 or the L50 table never reaches its floor. Independent
  observables: held_steps_sum/holds >> 0 (crashes displaced right); placed
  runs' plan_complete share falls while stock runs' share is unchanged;
  cap gauge read on both sides each chunk (placed-posture probes lengthen,
  raising later checkpoints - a watched coupling, not a falsifier).

## recovery-drain-point-sampler

- kind: add | category: scheduler | origin: proposer | status: proposed
  (judge gain 5, cost 0; queued behind crash-placement's result)
- title: Recovery admission stratified uniformly over the victim's own
  in-flight send drain
- Snapshot k = victim's in_flight at crash, draw d ~ U{0..k}, withhold
  Recover via is_ineligible until in_flight <= d; d=k is stock, k=0 (59% of
  crashes) never held. senderRestarted-falls binding proof verified
  mechanically (incarnation bumps at recovery; 443k stale-sender deliveries
  per chunk, 19.0% acted vs 2.1% receiver-restarted). Judge caveats: drain
  is NOT monotone (a crashed receiver recovering re-enters the victim's
  message into flight); site carries seven closures plus a placebo warning;
  no internal control as drafted. Rewrites required: d=k runs as the
  randomized same-side null (primary clause), hold bound ~400 steps against
  the purgatory pin, A/A-netted bar.

## cascade-fault-window-admission

- kind: add | category: scheduler | origin: proposer | status: rejected-by-judge (gain 2)
- title: Later crashes held to land inside another node's crash or
  fresh-restart window
- Steers toward a recorded zero-violation stratum: overlapping crash windows
  0/91 violations vs 23.6% for disjoint (OBSERVATIONS.md:841-846) on a
  100%-3-node config where two down is quorum loss; and the hold has no
  reopening path once the first freshness window closes (the valve never
  fires on this rig), so late second crashes are held to run end. A
  fresh-window-only bounded-hold respecification may re-enter, but must
  answer OBSERVATIONS.md:841-869.

## crash-context-admission-odds-probe

- kind: add | category: scheduler | origin: proposer | status: parked
  (judge gain 4, cost 0)
- title: Learned per-context crash-admission odds replacing the fixed
  partial-fanout coin, probe-contrast
- Identity point verified (r=1 reproduces the 0.5 coin exactly); phase 8
  disjoint from 0/16; label plumbing feasible without touching accounting.
  Parked because the run-end label class (post-recovery window outcome) is
  the shape refuted in timer-refire-outcome-quantile and the dose (a coin
  moving crashes ~5 eligible steps) is the weakest of the round. Revisit
  only after crash-placement/recovery-drain shows the timing axis moves
  depth, and then with a decision-adjacent secondary label.

## client-request-placement-span-draw

- kind: add | category: scheduler | origin: proposer | status: CLOSED,
  refuted by its own falsifier | parent:
  crash-placement-completion-span-draw | plan:
  research/lite/plans/client-request-placement-span-draw.md
- Built and graded over 683k runs. Fired exactly as designed and bought
  nothing: probe-free internal contrast 0.9836, cross-binary 1.0097 against
  a 0.0039 null and a frozen bar of 1.05. Closes the invocation-timing axis
  alongside the ordering axis the post_fault_client_ops ablation closed, and
  with it the late-client-work family. Its lasting product is the instrument
  fix: the internal contrast was reporting the probe exemption rather than
  the mechanism.
- title: Client requests get the admission placement crashes already have -
  hold a released request until later in the run's own activity instead of
  invoking it the step it becomes ready
- Every checkable claim held. There is genuinely no admission control on
  client-op invocation anywhere in the simulator: crashes carry a Runnable
  priority plus an eligibility mask and `crash_hold_until`, while client
  requests are dispatched inline at `path.rs:458` in the step they become
  ready. The dead `PlanEngine::mark_as_ready` (`path/plan.rs:126-137`,
  `#[allow(dead_code)]`) has exactly the InProgress -> Ready signature the
  hold needs, because `get_ready_events` performs the forward transition
  itself. Reuses the actuator shape of this session's largest win on a
  per-run population four times larger (~9 client events against 2 crashes),
  with a band derived independently rather than borrowed.
- Cost 2 is real: deferring invocation moves when invocation records reach
  the history (the linearizability recording path) and reorders the
  deadlock/termination test in the run loop.
- Judge rewrote the prediction to add the run-length confound the original
  omitted: steps/run and plan_complete share must be reported per posture,
  and depth bought by lengthening runs (placed steps/run outside 15% of
  stock) is not a pass.
- Amended on the operator's instruction before approval. The hold now uses
  a local held map rather than re-offering through the plan engine, which
  would have left the ready list non-empty and permanently suppressed the
  deadlock test. And which requests are held is a blind coin rather than an
  exemption for the first request of each kind: the exemption was chosen by
  reading the oracle's root, and a rule that consults the scoring function
  cannot tell us whether the search improved. Band lowered to 0.05..0.40 and
  a shallow-rung gate added, since the coin holds early writes too.
- Standing red-team note to answer in review: the nearest recorded evidence
  is the post_fault_client_ops family, closed permanently at
  `OBSERVATIONS.md:3052` by a zero ablation. That null is about plan
  ORDERING; this candidate is about INVOCATION TIMING, which no log entry
  touches. The distinction is the hypothesis's load-bearing claim.

## post-fault-supply-census

- kind: add | category: tooling | origin: proposer | status: parked behind
  client-request-placement-span-draw (judge gain 5, cost 0)
- title: Per-run census of client work and in-flight traffic surviving the
  run's last fault cycle, tagged so the grader reads its depth contrast
- Read-only diagnostic; counters and the free variant bit 1<<4 verified.
  One claim FAILED: `State::flight_enter`/`flight_leave` do not track
  crash-relative in-flight traffic - `SendLedger` holds a per-origin current
  count whose floor resets at every handler entry (`state.rs:978-981`), so
  the census's headline quantity needs new per-runnable bookkeeping it
  budgets nothing for.
- Also correlational by construction: the bit is an outcome, not an
  assignment, and conditions on something mechanically tied to run length -
  the same composition confound that made runCapProbe read 1.068 before the
  alias fix. Run it only if the placement candidate comes back null, when
  knowing whether late client work is scarce or merely mis-ordered becomes
  the deciding measurement.

## purgatory-fault-boundary-anchored-release

- kind: add | category: scheduler | origin: proposer | status: CLOSED as
  dominated by stale-incarnation-order-stratification (built, closed)
- title: Release a withheld message one fault-cycle boundary later instead
  of after a step budget drawn independently of the run's fault schedule
- Sharpest quantitative observation of the round and every number checks
  out: the delay draw is log-uniform over [5,300] with median ~39 steps
  (`exec.rs:70-77`), while a placed crash now sits a mean 427 steps past
  readiness - the delay budget and the fault schedule are drawn on
  incomparable scales, so cross-fault survival is a coincidence no
  delay_probability can arrange.
- Discounted for three things: the acceptance-distance observable is not
  exported in the eval record and its predicted direction is probably
  backwards (the bucket indexes the receiver's handler entries since its own
  restart, so releasing at a recovery pushes deliveries NEAR, not far); the
  "run still has an uncompleted fault event" guard needs plan knowledge that
  `exec.rs` does not have and no owner is named; and it attacks the same
  pre-fault-traffic-survives-the-fault hazard as the pool incumbent
  recovery-drain-point-sampler, which does it at cost 0.

## fault-frontier-client-reservation

- kind: add | category: config | origin: proposer | status: blocked
  (judge gain 3, cost 0)
- title: Reserve client work after the whole fault frontier instead of after
  each fault independently, and prefer a state-mutating request
- The mechanism critique is accurate line by line (`generator.rs:210-248`:
  per-recover iteration, uniform choice over all client requests so a read
  ~2/3 of the time, one edge each), and the targeting axis genuinely was
  never swept. But the argument rebuts the weakest counter-evidence and is
  silent on the strongest: `OBSERVATIONS.md:3052` records a zero ablation
  closing the family permanently - with post_fault_client_ops = 0 every rung
  moved inside the A/A band. If deleting all reservation edges is a null,
  the effect available to retargeting the same edges is bounded by noise.
  Its cited sweep line (5312) does not exist; the sweep is at 2769.
- Blocked until the write-up states, in one sentence, why the zero ablation
  does not bound this effect. Same precedent as cascade-fault-window-
  admission, rejected for proposing into a stratum the log had already
  characterised without answering the citation.

## causal-chain-priority-inheritance-with-demotion-points

- kind: add | category: scheduler | origin: proposer | status: scored, not
  built (judge gain 6, cost 2, net 4) - best of the scheduling-theory round
- title: Priorities that belong to a causal chain rather than to an event,
  with a bounded number of per-run demotion points over the learned span
- The only proposal of the round whose central mechanism claim survived
  verification: there really is no priority persistence across hops - every
  created runnable draws a fresh Beta at `exec.rs:206/259/579` and
  `path.rs:196`. Inheritance supplies the persistent object that PCT-style
  demotion points need, and the points are sited from a measured fact (long
  inert-streak acted fraction 0.0092, frontier never drains) rather than
  from the step budget. Throughput plausibly positive: a field copy replaces
  a Beta sample.
- Ceiling to be clear-eyed about: it acts on within-queue SCORING, and this
  repo has merged three eligibility-mask mechanisms and refuted its one
  scoring mechanism. Authority there is measurably thin - 45% of steps
  contested, configured multiplier flips nothing, novelty ablated so the
  score is a constant plus 0.75*priority over a 0.30-wide band.
- Judge kept the prediction, adding one clause at admission: report the
  within-queue tie rate, since equal chain keys are the degenerate failure
  its own risk paragraph names and `live_chains_p90` does not detect. Also
  names a fourth Record creation site the description missed,
  `scheduler.rs:1538`.

## semi-markov-queue-class-bursts

- kind: add | category: scheduler | origin: proposer | status: scored, not
  built (judge gain 4, cost 0, net 4)
- title: Replace the memoryless queue-class roll with a heavy-tailed
  semi-Markov process preserving the class marginals exactly
- Best experimental design of the round - a four-arm within-session dose
  curve carrying its own byte-identical i.i.d. control - attached to a
  partly false story. Two checkable claims FAILED. "Stretches beyond about
  ten steps effectively never occur" is off by an order of magnitude: with
  the default p_network 0.17 a 10-step network-free stretch has probability
  0.155 and ~50-step stretches occur ~96,000 times per chunk. And "past
  parameter doses on p_local/p_timer moved nothing" is unsupported - grep
  finds zero hits in either log, and the nearest result is the opposite,
  timer-admission-context-odds-probe merging at 1.19.
- Its headline observable is also unmeetable as frozen: class shares cannot
  be "within 3% of configured" because `try_select` falls through on an
  empty class, which is why the realized timer share is ~21% against a
  configured 0.03. And a sojourn bypasses `select_timer_biased`, silently
  disabling a merged +19% mechanism on treated arms.
- Judge rewrote both: shares within 10% of the alpha=infinity arm's REALIZED
  shares, and treated arms must route through `select_timer_biased`.

## pos-conflict-resampled-priority-order

- kind: add | category: scheduler | origin: proposer | status: scored, not
  built (judge gain 3, cost 0, net 3)
- title: Partial-order sampling - one global priority frontier with keys
  resampled only on conflict
- Superb mechanical verification craft - it named all ~13 queue-mutation
  sites and an exhaustive grep found none missed - but its load-bearing
  causal claim is FALSE and inverts the argument. Priority is not "redrawn
  every step": it is stamped once at creation and never touched again
  (`Record::reset` does not reset it, `state.rs:293-296`; continuations
  re-push the same record, `exec.rs:639,649`). So a low-priority record
  already sits behind the frontier indefinitely, and conflict-resampling
  would make within-queue keys LESS persistent than today, not more.
- Deleting the class roll also removes the empty-queue fallthrough that
  lifts the realized timer share to ~21%; a marginal-preserving global order
  would cut timer admissions ~7x, an uncontrolled dose in the direction the
  falsifier only bounds from above. Same mechanism family as
  causal-chain-priority-inheritance; they cannot both score high and the
  tie-break went on verification, not preference.

## partial-order-class-restart-sampler

- kind: add | category: feedback | origin: proposer | status: scored, do not
  build in this form (judge gain 3, cost 2, net 1)
- title: Abandon a run whose prefix is partial-order-equivalent to prefixes
  already sampled, and spend the wall-clock on a fresh run
- Cannot attribute its own predicted gain. Early truncation is ALREADY a
  large measured win on this rig, and the judge measured it from the
  baseline in hand: the `grid-short` arm (cap 1500) produces 4,184 depth>=6
  runs in 60,056 ms against `grid`'s 1,956 in 60,097 ms - 2.14x the
  objective at a quarter of the cap - while per-run P(depth>=6) FALLS from
  3.89% to 2.91%. So abandoning a quarter of runs at quarter-cap raises the
  objective whether or not the fingerprint carries any information, and the
  whole predicted band 0.08..0.35 sits inside what a generic truncation dose
  delivers alone.
- Its motivating claim is also read off an ablated channel: timeline keys
  do read 5 distinct values at run 100, but `novelty_ablated_runs` is
  351,660 of 351,660 - the config sets `novelty_enabled: false`. The signal
  is off by configuration, not degenerate by nature. Same misreading that
  got timer-steer-coverage-holdout-governor rejected.
- Judge rewrote the design to need a third arm: treated / random-abandon-at-
  matched-rate / untreated, with a gain over untreated alone recorded as a
  truncation dose rather than evidence for the fingerprint.

## stale-incarnation-order-stratification

- kind: add | category: scheduler | origin: proposer | status: CLOSED,
  refuted by its primary falsifier (judge gain 7, cost 0) | record:
  research/lite/plans/stale-incarnation-order-stratification.md
- Built and graded over 706k runs. Fired far above floor with every safety
  clause clean, and the randomized internal contrast on depth>=6 read 0.9948
  [0.985,1.004] against a 1.04 bar. The arms separated at 1.267x - AHEAD
  acted 11.99%, BEHIND 9.46% - real and stable but inside the frozen
  undecided band. Finding kept: arrival order relative to the sender's
  fresh incarnation changes acted-ness by about a quarter and that change
  does not reach depth, so acted-ness of stale deliveries is not what the
  objective is short of.
- title: Stratify whether a message from a dead incarnation is delivered
  before or after its sender's post-restart traffic, and measure which acts
- Zero failed claims. The eligibility mask already excludes Records via
  reservations and FIFO blocking (`scheduler.rs:773-782`), and every
  queue-size computation already filters through the same closure, so a
  constraint on Records is the established pattern rather than a first - the
  proposer's own cost-2 self-assessment rested on a false "first constraint
  on Records" claim. Arming site verified at `scheduler.rs:1390`,
  `origin_incarnation` stamped at `exec.rs:210`, the 1e-19 free-scheduling
  survival figure verified at `OBSERVATIONS.md:893-895`.
- Decisive property: its primary result does not depend on this round's
  shared premise. It randomizes the exact binary the premise is about into
  two equal-mass arms inside one treated population and reports each arm's
  acted rate, so it is informative either way. It is also structurally immune
  to both measurement defects this repo has actually suffered - the arms come
  from the same population, so no composition confound, and it does not move
  the timestamps the arms are compared on.
- Judge kept the arm-separation primary verbatim and added three safety
  clauses: treated steps/run within 15% of untreated, treated plan_complete
  within 5 points, and the per-(origin,destination) constraint bounded by no
  more than the configured delay maximum - the AHEAD arm can otherwise block
  a node-pair stream for the full 300-step purgatory horizon and the
  empty-eligible-set valve will essentially never fire in a 3-node system.

## restart-latency-foreign-progress-draw

- kind: add | category: scheduler | origin: proposer | status: CLOSED, refuted
  by its primary falsifier (judge gain 6, cost 0) | record:
  research/lite/plans/restart-latency-foreign-progress-draw.md
- Built and graded over 720k runs. Internal depth>=6 0.9855 [0.976,0.995]
  against a 1.10 bar. Arms separated 2.63x: delaying the restart cuts the
  stale acted fraction from 0.11 to 0.044, forcing an immediate restart
  matches stock. With iteration 9 this closes the acted-stale-delivery
  reading from both sides: raising acting moved depth nowhere, cutting it
  sharply moved depth down 1.5%. The interval itself is a real general lever
  on acting, kept as a finding.
- title: Stratify how much of the rest of the system runs between a crash and
  the victim's restart, including a forced zero-progress arm
- `SendLedger::entries` verified monotone by construction (`state.rs:984`,
  saturating_add only, never reset), so the draw variable always terminates
  and has support on every crash. Crashes stranding the victim's own sends
  are now 71.1%, better than when the round was written.
- Three fixes required at admission. The salt is load-bearing: `run_phase.rs`
  is a single unsalted mixer and every mechanism reduces the SAME mixed
  value, so a new period alone gives a correlated posture, not an independent
  one - it needs `mix(run_id ^ SALT)`. The independent observable as frozen
  is not computable: `deliveryEffects` is a session-global atomic with no
  variant split, so per-posture counters must be budgeted. And the 8-rung
  ladder has mean 15.9 against a current crash-to-restart interval of mean
  5.4, so seven of eight rungs push the opposite way from the prediction -
  judge replaced it with a three-arm equal-mass draw {g=0, ladder, stock}
  and unfroze the direction.

## crash-fanout-position-draw

- kind: add | category: scheduler | origin: proposer | status: do not build
  in this form (judge gain 3, cost 0)
- Its load-bearing counter claim is FALSE. `SendLedger::recent` is not
  monotone within a segment: `flight_leave` decrements it (`state.rs:922`),
  because it counts the segment's sends STILL UNDELIVERED, not sends issued.
  A "hold until the segment has issued s further sends" condition built on it
  can be reached, un-reached, and never reached. Repairable - the monotone
  quantity is `issued - floor` - but not as written.
- Its premise has also reversed since the chunk it cites. Exactly-one
  in-flight was 12.7% against exactly-two 15.6%; it is now 15.4% against
  15.1%, so the "rare stratum" is the second-largest bucket and has grown 21%
  with no mechanism aimed at it. And the census buckets total undelivered
  records, not per-segment position, so the frozen observable is not the
  mechanism's own quantity.

## recovery-window-width-draw

- kind: add | category: scheduler | origin: proposer | status: parked behind
  restart-latency (judge gain 4, cost 0)
- Headline observable is tautological: the window closes when a foreign
  message enters a handler (`util_stats.rs:1382-1385`) and the mechanism
  withholds exactly those records, so p50 rising 3x is the definition of the
  mechanism having run, not evidence it worked.
- Its anti-overlap disclaimer is backwards. `crash_inside_recovery_window`
  fires whenever a crash lands while another node's window is open, so
  widening every window mechanically raises the overlap stratum the log
  records as zero-violation (0/91 against 23.6%, `OBSERVATIONS.md:845`).
- Its safety anchor is stale by half: unclosed windows were 12.2% at the
  cited chunk and are 6.2% now, so the frozen "no more than 5 points above
  12.2%" would permit an 80% relative rise in stalled recoveries and pass.

## recovery-drain-point-sampler

- STATUS CHANGE: closed as dominated by restart-latency-foreign-progress-draw
  at the same admission site. Its draw variable `in_flight` is non-monotone
  (`flight_leave` decrements at `state.rs:919`; a crashed destination's
  buffered records re-enter flight at its recovery), so the withhold
  condition is not guaranteed to be reached from above, and it cannot express
  a zero-foreign-progress restart at all - its d=0 is the LONGEST hold, not
  the shortest. Its recorded dead zone has also halved: inert on 28.9% of
  crashes now, not the 59% recorded when it was written. Its rewrites carry
  over to the successor unchanged.

## purgatory-blind-delay-default-ablation

- kind: ablate | category: scheduler | origin: proposer | status: MERGED (config-only
  step; judge gain 8, cost 0, net 8) - depth>=6/s 1.4651, panel paxos +28%,
  mencius 3.27x | plan: research/lite/plans/purgatory-blind-delay-default-ablation.md
- The only candidate whose central effect is measured on the current
  baseline rather than argued. Judge recomputed every cell: grid vs
  grid-no-purgatory per-run P(depth>=6) 0.056748 vs 0.071379 (seed 1000) and
  0.057789 vs 0.071241 (seed 1001); per explore-second 1.3218 and 1.3360.
  The -41% record at OBSERVATIONS.md:3001 is real and predates the
  fault-timing merges by a day; the sign flipped.
- Design defect the judge caught: with the base rate at 0.0 the
  grid-no-purgatory overlay is a no-op and the free null control vanishes,
  so the posture form must keep 0.15 and add a `posture_share` field.
  Graded as a pure ablation first, config-only, on the judge's advice.

## timeline-novelty-scalefree-rarity-restore

- kind: enabling | category: feedback | origin: proposer | status: CLOSED,
  refuted - typed rule and falsifier agree (judge gain 6, cost 0)
- Built and graded over 854k runs. Fired at 44.5M flips per chunk with the
  term varying on 56% of contested decisions - authority was never the
  problem - and read depth>=6/s 0.8065 (-19%), throughput 0.796, internal
  contrast 0.9801 with novelty-off runs ahead. The restored term changed
  what ran 44 million times a chunk, made per-run depth slightly worse, and
  cost 15% wall per treated run. Fourth scoring mechanism refuted; closes
  coverage-guided within-queue selection under this objective.
- Every quoted number reproduced exactly. Establishes a new reading of the
  authority census: `quick_fire` has no OFFERS (568,954 of 1.09e9 decisions,
  0.052%), not no authority, so its zero flip count says nothing about a
  term evaluated on every entry-point Record. Judge rewrote the prediction:
  the distinct-keys observable is entailed by flipping the flag, replaced
  with an offered-share floor of 5% of contested decisions, and a runs/sec
  floor of 0.95 added since the rung is per-second.

## partition-fault-class-restore-with-repair-hold

- kind: enabling | category: scheduler | origin: proposer | status: CLOSED,
  refuted by its primary falsifier (judge gain 7, cost 2)
- Built with a build-time amendment (shape filter also requires every client
  to reach a majority of servers, so only IsolateOne is admitted) and graded
  over 997k runs. Fired at 67x its floor with the heal hold engaged at 211
  steps and every safety clause clean. Probe-free internal contrast on
  depth>=6 0.7914 [0.785,0.798] against a 1.05 bar, while stale-incarnation
  deliveries per run rose 47%. The rung and the hazard ladder moved in
  opposite directions - the blind-spot finding made concrete from the other
  side. Latent bug found and reported, not fixed: MajoritiesRing is vacuous
  at every node count (reach = n/2 equals the maximum ring distance).
- Strongest evidence file of the round: partition.rs is 310 lines never
  executed under this config, and the judge redid both vacuity computations
  from the source - the ring shape is always vacuous at three nodes and
  exactly one bridge choice in three isolates nobody, so one draw in three
  is a no-op. Cost 2 for event accounting: activation pulls records out of
  flight and re-pushes them on heal. Held below 8 because the rung it must
  be graded on is the one it argues cannot see it.
- Judge rewrote the vacuity observable, which was tautological as written,
  to `vacuous_shapes_skipped / draws` in 0.28..0.40.

## adaptive-arm-allocation-bandit-salvage

- kind: enabling | category: scheduler | origin: proposer | status: REJECTED,
  out of bounds (judge score 0)
- The grader would not refuse it - baseline identity compares arm ids and
  modes only - but the implementer clause is categorical: never touch the
  campaign block. Independently: its pooled gain is composition, not search
  (grid-short wins on throughput, with per-run P(depth>=6) 0.0613 BELOW
  grid-no-purgatory's 0.0714), and the per-arm-invariance falsifier
  certifies that reading rather than excluding it. One checkable claim
  false: the rewardRate ordering matches depth>=6/s on seed 1000 only; on
  seed 1001 aos moves from second to fourth. The reward it proposes has no
  per-arm evidence, and UCB1 at ucb_c 1.0 would deliver about +20%, not the
  claimed +30..50%. If wanted, it is operator-lane budget policy, which is
  where OBSERVATIONS.md:2784 already filed it.

## directed-link-speed-class-run-skew

- kind: add | category: scheduler | origin: proposer | status: CLOSED,
  typed rule and falsifier agree (judge gain 7, cost 0)
- Built and graded over 813k runs. Fired at 0.87 withheld offers per step
  with the cap bucket at 7.3%; both hazard observables passed; internal
  depth>=6 0.9646 [0.956,0.973], cross-binary 0.7663, throughput 0.767.
  The throughput loss is shared by both halves (treated wall 1.010x
  untreated), so it is a hot-path code cost, not the mechanism's - and
  the internal contrast cannot see it. Fourth hazard-up-depth-down result.
- title: Per-run directed-link speed classes - a hard, run-persistent ordering
  class on each ordered node pair, so message order carries correlation
  across a run instead of independent per-message priorities
- Every checkable claim held: priority is drawn once at record creation
  (`exec.rs:206`) and never revised; `is_fifo_blocked` is the only pair-order
  constraint; `Stream::SendDelay` is genuinely idle (the draw is skipped, not
  zero-length); the queue-size computations and per-queue eligible builds all
  filter through `is_ineligible`, so a mask there applies to routing and
  selection alike; and within-queue selection is a stochastic tournament
  re-taken every step, so a record's effective order really is re-randomized
  per step and sustained one-sided skew really is exponentially rare.
- The judge accepts "mask, not score" on the merits: the refuted scoring
  mechanisms changed the rank inside one step's draw; this withholds a record
  across many steps so a delivery can be deferred past a crash or recovery -
  it changes what a run reaches, which is the operative criterion the three
  merged masks share.
- Judge added two clauses: at least 0.02 withheld offers per scheduler step,
  and a withhold-duration histogram with a falsifier if more than 25% of mass
  sits at the age cap (a degenerate partition rather than a speed class).
  Dedup condition: if the partition candidate merges, re-argue this before a
  second chunk is spent - if the age bound binds, a speed class IS a
  partition with a 300-step repair.
- Correction recorded for future proposals: the "released when it would empty
  the eligible set" valve does not exist in merged code; the crash masks are
  safe by expiry and re-roll. It must be built where a design relies on it.

## recovery-buffer-release-policy-draw

- kind: add | category: scheduler | origin: proposer | status: do not build
  (judge gain 3, cost 2)
- Plumbing claims all correct (`crash_node` never scans purgatory; the crash
  buffer releases as one block), but the evidential core is falsified against
  the current baseline: it quotes the sender_restarted acceptance-distance
  row while the mechanism moves receiver_restarted deliveries, and on that
  row bucket 0 is the BEST near bucket, so staging moves mass out of it; the
  "0-2 entries" cluster does not exist - 60% of released deliveries already
  land at five or more entries because the block competes in the network
  queue. The DOUBLE arm is metric-invalid: duplicated delivery is a fault
  model no panel spec is written against, supplies an extra oracle-matchable
  deliver event, double-counts in flight accounting, and leaves a residue in
  the caller's channel.

## pending-crash-outbound-send-withhold

- kind: add | category: scheduler | origin: proposer | status: parked, wait
  for an oracle that carries the incarnation condition (judge gain 4, cost 0)
- Sound and non-stalling, but its anchor is stale (victim_had_inflight_sends
  is 0.662 post-ablation, not 0.71) and its concentration claim is backwards:
  withholding all outbound records pushes in_flight away from 1, the value at
  which the partial-fanout coin stops withholding, so it concentrates at the
  fully-uninformed stratum and neutralizes the merged bias on treated runs.
  Its primary quantity is invisible to the rung by its own admission.

## activity-clock-crash-placement

- kind: add | category: scheduler | origin: proposer | status: admitted,
  building behind the link-speed grading (judge gain 6, cost 0, net 6)
- title: Crash targets drawn on a handler-entry clock instead of the step
  clock, with the span learned in the same units
- Half of placed runs draw the crash target over the learned median
  handler-entry count of completed probes and are withheld until the run's
  global entry counter reaches it; the other half keep the step-clock draw
  as the randomized control. Verified: `note_handler_entry` increments only
  on Delivery and Timer triggers; the placer's three learner call sites and
  discipline are as described; no learner records anything in entry units
  today. Tie with the fan-out anchor broken on decisiveness: this is the
  only candidate of the round whose effect and null are both readable on the
  graded rung.
- FAILED claim, and it is the safety claim: "the shared backstop means
  entry-clock runs cannot run longer" is backwards. `crash_place.capped_draws`
  is 0 over 1.58M draws, so L50 is below 3/4 of the cap in every draw and the
  3/4-cap backstop is looser than the step-clock bound. Judge rewrote the
  prediction: firing = draws that held at least one step (floor 200k);
  observable = p10/p50/p90 of entries elapsed and steps elapsed at crash
  application per half (entries quantiles separated, steps p50 within 15%),
  not a mean shift a monotone reparameterization does not entail; safety =
  p95 realized hold length on the entry half within 2x the step half's,
  backstop releases below 0.35 of draws, per-half plan_complete within 2
  points and crashes per run within 2%. Primary internal contrast >1.04 and
  band 0.05..0.25 kept; the judge reads the band as optimistic since an
  entry clock is a reparameterization of the step clock.

## crash-fanout-phase-anchored-release

- kind: add | category: scheduler | origin: proposer | status: queued as the
  immediate successor at the same site (judge gain 6, cost 0) | supersedes
  crash-fanout-position-draw, which it repairs per the review's instruction
- The placed crash releases at a drawn phase of the victim's fan-out (EARLY:
  segment issued >=1 send, none delivered; MID: >=2 issued, some delivered;
  STOCK) inside a W=96 window. Best-verified mechanics of the round: issued
  monotone, floor set only at handler entry, continuations do not reset the
  segment. Two corrections: the exactly-one in-flight bucket is 20.2% on the
  current baseline, not the quoted 15%, so the stratum is the largest after
  3plus rather than rare; and the `crash_anchor.*` counter namespace already
  exists, so firing renames to `crash_phase.armed`. The self-close clause
  must be read at the release decision, not at application, because the
  partial-fanout coin (verified at 0.4999) still re-rolls afterwards;
  expired/armed read per arm since MID selects only broadcast segments.
- Incidental verified fact: `crash_place.holds` equals `held_steps_sum`
  exactly in both chunks, proving the mask is the sole gate on a held crash.

## inbound-delivery-anchored-crash-release

- kind: add | category: scheduler | origin: proposer | status: do not build
  yet; collect the inbound base rate first (judge gain 4, cost 0)
- Plumbing correct and cheap (a `remote_dest` sibling on the two flight
  sites; crash-buffered messages are not in flight under the existing
  convention and the mirror inherits it). But the dose is unmeasured: no
  inbound census exists, the outbound analogue is 0.66 spread over two
  peers, so P(inbound >= 1 at hold expiry) is plausibly 0.5-0.7, in which
  case LOADED releases immediately on most crashes and is nearly STOCK.
  Gate added: if the STOCK-arm base rate exceeds 0.60, close without a
  chunk. Same actuator as the fan-out anchor; at most one per iteration.
