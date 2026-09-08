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

- STATUS CHANGE at the iteration-15 review: CLOSED - score-adjacent; the scoring family was refuted at full strength in iteration 12.
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

- STATUS CHANGE at the iteration-15 review: CLOSED - the late-client-work family it was meant to diagnose closed in iteration 8.
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

- STATUS CHANGE at the iteration-15 review: CLOSED - superseded by crash-fanout-phase-anchored-release, which repairs its counter and bounds its hold.
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

- STATUS CHANGE at the iteration-15 review: CLOSED - its indirect route through the spread of receiver states is the hazard-up-depth-down pattern the record now shows four times.
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

- kind: add | category: scheduler | origin: proposer | status: CLOSED,
  frozen falsifier fired; typed merge advice departed from with reason
  (judge gain 6, cost 0)
- Graded over 1.11M runs. Fired at 410k entry holds per chunk with every
  safety clause clean, and the randomized internal contrast read 1.0156
  against a 1.04 bar. The typed rule said merge on cross-binary 1.0659 at
  throughput 1.05; a same-session build-vs-build control of identical
  source read 0.951 on the rung and 0.963 on throughput, so the separation
  is inside build-layout noise. The entry clock is a reparameterization of
  the step clock on this workload (entries per step 0.39, near constant),
  so the halves placed crashes at nearly the same points.
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

- kind: add | category: scheduler | origin: proposer | status: MERGED at
  7134f43 (spur 6f07962), the first epoch-13 decision: internal contrast
  1.1854 [1.1195, 1.2551] inside the frozen band [1.05, 1.40], firing 2.5x
  floor, throughput 1.0032, regression passed | patch: applied; the kept copy
  under research/lite/patches/ was removed at merge
- Epoch-12 result: internal contrast 1.0500 [1.0448, 1.0551] on a rung two
  thirds of whose deep runs never crashed the node whose message the chain
  says went stale; under the new grader rule the replay merges it. Re-graded
  under epoch 13 because the rung changed underneath it and its mechanism -
  anchoring the crash to the victim's fan-out - is exactly the depth 3 to 4
  transition the strict chain now requires. Frozen for epoch 13 (per-run
  template): declared bit 512 (crashPhase); band on the per-run depth>=6
  ratio, anchored half against the STOCK half of placed runs, [1.05, 1.40];
  firing crash_phase.armed >= 100,000 per chunk; falsifier: the 2.7-sigma
  interval entirely below 1.05, or release-time victim_had_inflight on
  condition-released crashes below 0.90; cost clause: cross-binary
  throughput >= 0.95 of the paired baseline.
- Graded over 2.06M runs across four seeds. Internal contrast on depth>=6
  1.0500 [1.0448, 1.0551] - real, and centred on its frozen bar. Fired at
  2.5x floor with every safety clause clean; condition-released crashes had
  sends in flight 100.0% of the time against 68.7% stock. Cross-binary
  1.0301 is inside the build-layout envelope and cannot separate. The only
  hazard-shaped mechanism of the session that moved depth, because it
  manufactures the oracle's own crash-then-deliver transition. Regression
  passed.
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

## crash-fanout-reaction-triggered-arm

- kind: add | category: scheduler | origin: proposer | status: CLOSED at
  iteration 17 - refuted by its falsifier: REACTION expired on 0.833 of
  armings (clause 0.60) and broadcast share of condition releases was 0.084
  (clause 0.35); depth>=6 per-run 1.0275 [0.9529, 1.1080] resolved neither
  way. Fault-caused wakeups inside the window are rare and single-send |
  parent: crash-fanout-phase-anchored-release
- Mechanism: a fourth arm, REACTION, for the placed-crash anchor. On a
  salted half of anchored runs (bit 1 << 14, crashPhaseReaction), a crash
  whose run has already had a fault (some node crashed, or some incarnation
  above 0 at the draw step) draws from a four-arm table {EARLY, MID, STOCK,
  REACTION}; REACTION releases only while the victim's current handler
  segment was woken by a fault-crossing delivery (origin currently crashed
  or restarted since sending, both computed at the dispatch site already),
  inside the existing 96-step window and cap reserve. A crash before any
  fault, and every untreated run, draws from the merged three-arm table with
  its own modulus, so the control is byte-identical to the merged behaviour.
- Why: the named event is both an oracle edge (deliver_svc_1_to_2 ->
  crash_2) and the target's own steps 3-4 - the initiating node crashes
  while its reaction sends are still delayed. The merged anchor lands
  crashes on fan-out in general; this arm lands them on fan-out that was
  itself caused by a fault. MID's exactly-one-in-flight bucket rose 5.7
  points against a predicted 10, so the anchor's phase draw is only half
  selective on the segment kind that matters.
- Frozen prediction (epoch 13, per-run template): treatment bit
  CRASH_PHASE_REACTION = 1 << 14 (crashPhaseReaction), salted half of
  anchored runs, drawn by run id, about 0.22 of runs; rung depth>=6 per-run
  ratio treated against untreated, probe-free, co-bit matched within
  crashPhase = 1, band [1.02, 1.12]; firing counter
  crash_phase.reaction.armed >= 15,000 per chunk, with
  crash_phase.reaction.{condition, expired, broadcast_releases,
  skipped_no_fault} exported; independent observable:
  reaction.broadcast_releases / reaction.condition >= 0.50, REACTION's
  expired/armed reported beside MID's 17.4%; falsifier: the depth>=6
  interval entirely below 1.02 (treated LOWER), or broadcast share below
  0.35, or reaction.expired / reaction.armed above 0.60, or treated steps
  per run above 1.10x untreated; cost clause: cross-binary throughput at or
  above 0.97 of the paired baseline.
- Implementation constraint from the judge: the untreated anchored draw
  keeps the three-arm table (do not append to CrashPhaseArm::ALL); a test
  must show identical arm sequences on untreated anchored runs before and
  after.

## stale-outbound-hold-until-restart-round-trip

- kind: add | category: scheduler | origin: proposer | status: CLOSED at
  iteration 18 with the family - the tighter destination-answer release read
  0.82 on depth>=6 and this looser release has nothing left to add (was KEPT,
  re-ranked to gain 3 as dominated by orphan-release-on-destination-answer: its "round trip" closes on any
  delivery-triggered entry after one fresh delivery, from any origin
  including a client; it arms at recovery so gap-consumed ghosts escape;
  its HOLD/STOCK draw halves the dose on the declared bit). Close as
  superseded if the destination-answer release merges; close with it if
  that release is refuted with a low control answered share | parent:
  stale-incarnation-order-stratification
- Mechanism: at recovery, a HOLD arm masks the node's stale-incarnation
  records in is_ineligible until its restart round trip closes (one fresh
  send delivered, then one delivery-triggered handler entry), bounded 96
  steps, inert when nothing stale remains. Aligned with the target's order
  (a view-changing peer does not answer Recovery, so the recovery must be
  answered before the stale message is consumed).
- Frozen prediction: bit STALE_ROUND_TRIP = 1 << 12 (staleRoundTrip),
  salted half of all runs; depth>=6 per-run band [1.02, 1.10]; firing
  stale_hold.armed >= 80,000 per chunk with stale_hold.{inert, stock,
  condition, expired, masked_offers}; independent observable: depth>=7
  per-run ratio >= 1.08; falsifier: depth>=6 interval entirely below 1.00
  (treated LOWER), or depth>=7 interval entirely below 1.08, or
  expired/armed above 0.50, or treated plan_complete more than 5 points
  below untreated; cost: throughput >= 0.97.
- Judge caveat: same actuator family as the closed stale-order
  stratification (its BEHIND arm read 0.9948); re-enters on the epoch
  argument only.

## recovery-stranded-drain-phase-anchored-release

- kind: add | category: scheduler | origin: proposer | status: KEPT at
  iteration 17 (judge gain 4, cost 0) | parent: recovery-drain-point-sampler
- Mechanism: the recovery-side mirror of the fan-out anchor - each placed
  crash snapshots the victim's stranded sends and a treated run draws
  {FIRST_DRAIN: hold recovery until one stranded send is delivered and one
  remains; PEER_REACTED: hold until a peer segment woken by a stranded send
  has issued a send; STOCK}, 96-step window plus cap reserve, monotone drain
  counter at the dispatch site.
- Frozen prediction: bit RECOVER_PHASE = 1 << 11 (recoverPhase), salted half
  of placed runs; depth>=6 per-run band [1.03, 1.18]; firing
  recover_phase.armed >= 100,000 per chunk; independent observable:
  crash_phase.release_trigger_crossing share on condition-released
  second-or-later crashes >= 1.3x treated over untreated; falsifier: depth>=6
  interval entirely below 1.03, crossing share not above untreated, treated
  steps per run above 1.10x, expired/armed above 0.60, plan_complete more
  than 5 points below or recoveries per run off by more than 2%; cost:
  throughput >= 0.97.
- Judge caveat: both arms put a peer's consumption of a stranded send before
  the recovery, which is the order the target forbids; third entry of a
  recovery-hold family whose one measured member read 0.9855.

## restart-buffer-fresh-first-release

- kind: add | category: scheduler | origin: proposer | status: KEPT, DO NOT
  BUILD IN THIS FORM (judge gain 2, cost 2, net 0) | parent:
  recovery-buffer-release-policy-draw
- Mechanism: hold the crash buffer released at recovery until the recovered
  node's first fresh send is delivered (FRESH_FIRST) or deliver it before any
  fresh inbound (BUFFERED_FIRST), plus STOCK.
- Why held back: receiver-restarted deliveries are 0.54% of deliveries, and
  a side-vector hold hides records from all_queues_empty(), so a drained
  queue could end the run with the block never delivered - event
  accounting, hence cost 2. Buildable only as a Record mask that keeps the
  records in the network queue. Band would be [1.02, 1.08], bit 1 << 13.

## orphan-release-on-destination-answer

- kind: add | category: scheduler | origin: proposer | status: CLOSED at
  iteration 18 - refuted and harmful: depth>=6 per-run 0.8219 [0.7746,
  0.8721] (z -8.9) against a band of [1.03, 1.12]; expired/armed 0.908
  (clause 0.45); answered-first share 0.264 -> 0.340, 1.29x (clause 1.5x).
  The hold is mostly a blind 96-step delay of the stale message | parent: none
  (family: stale-incarnation record mask; siblings
  orphan-hold-until-origin-restart-quiescence,
  orphan-delay-clocked-by-origin-restart-entries,
  stale-outbound-hold-until-restart-round-trip)
- Mechanism: a pair-scoped hold on a crashed node's orphaned sends,
  released by the destination's own reply. When a treated run crashes a
  node v with sends in flight, v is armed; while armed, a remote record
  from v to d whose incarnation is stale (or while v is crashed) is masked
  in is_ineligible until d has sent a remote record back to v's current
  incarnation from a handler segment that a fresh delivery from v woke.
  Each (v, d) pair releases on its own; bounded by armed_at + 96 steps or
  the run's step reserve; inert when no orphan to d remains. Records stay
  in the network queue. Bookkeeping: SendLedger gains woke_by (origin and
  freshness of the delivery that woke the current segment, stamped at the
  dispatch site) and answered (a bitmask over destinations, reset at the
  incarnation bump); the answer is detected at flight entry for remote
  records only, never the implicit return channel send. A census at the
  dispatch site records, for every sender-restarted delivery on BOTH
  halves, whether the destination had answered the origin's current
  incarnation before consuming the ghost.
- Why: the one ordering the target cannot do without is at the
  destination - it must answer the recovering node before it reacts to
  that node's ghost, since a peer that has reacted no longer answers and
  the recovery never closes. The closed BEHIND arm ordered the ghost after
  the destination merely received fresh traffic (necessary, not
  sufficient; 0.9948 on the old rung); the round-trip hold releases on the
  origin's first reply from anyone, which at three nodes is the other peer
  half the time. The destination's own reply is the minimal sufficient
  condition, so it holds shortest and expires least.
- Frozen prediction (epoch 13, per-run template): bit GHOST_PEER_ANSWER =
  1 << 16 (ghostPeerAnswer), salted half of all runs, drawn by run id, no
  probe exemption; rung depth>=6 per-run ratio treated against untreated,
  probe-free, co-bit matched, band [1.03, 1.12]; firing
  ghost_answer.armed >= 100,000 per chunk, with ghost_answer.{masked_offers,
  condition, expired, inert} and ghost_answer.census.{treated,control}.
  {answered, unanswered} exported; independent observable: treated answered
  share of stale-incarnation deliveries >= 1.5x the control share (treated
  HIGHER), and expired/armed <= 0.45; falsifier: the depth>=6 interval
  entirely below 1.03, or treated answered share below 1.5x control, or
  expired/armed above 0.45, or treated steps per run above 1.04x, or
  treated plan_complete more than 3 points below untreated, or
  stale-incarnation deliveries per treated run more than 10% below
  untreated, or crash_phase expired/armed on treated runs more than 3
  points above untreated; cost clause: cross-binary throughput >= 0.97.
  The 0.45/0.80 absolute levels in the proposal are ungrounded (no counter
  observes them today); the clause is relative for that reason.
- Liveness: a fresh record is never masked and the release is the
  destination's own fresh reply, so two armed nodes cannot wait on each
  other; a fully masked step is a blocked step, not a run end. The
  untreated half draws nothing, reads no config, and runs the merged
  crash_phase.rs unchanged.

## orphan-hold-until-origin-restart-quiescence

- kind: add | category: scheduler | origin: proposer | status: CLOSED at
  iteration 18 with the family - a longer hold than the one that read 0.82;
  the judge's own caveat (quiescence rare, degrades into the retired blind
  delay) is what the sibling's 0.908 expiry showed (was KEPT, gain 5) |
  parent: stale-outbound-hold-until-restart-round-trip
- Mechanism: arm at the crash (victim with sends in flight); mask its
  ghost records until the origin has restarted, taken at least one handler
  entry, has no fresh send outstanding, and no fresh record from a live
  origin is pending to it (masked ghosts excluded); 96-step/step-reserve
  expiry. Frozen: bit GHOST_QUIESCENCE = 1 << 15, half of all runs; band
  [1.03, 1.15]; firing ghost_hold.armed >= 100,000; observable: treated
  quiescent share of stale deliveries >= 1.8x control; falsifier as the
  sibling's plus expired/armed above 0.55 and steps above 1.05x; cost
  0.97. Census on both halves.
- Judge caveat: the pending-inbound clause counts client requests (mean
  5.14 client ops in flight at a crash), so quiescence is likely rare and
  the hold degrades into the retired ~96-step blind delay; read
  expired/armed at chunk 1 and stop early if expiries dominate.

## orphan-delay-clocked-by-origin-restart-entries

- kind: add | category: scheduler | origin: proposer | status: CLOSED at
  iteration 18 with the family - the question it would answer (does an
  activity-clocked delay of orphans help) is answered by the sibling's
  0.82: delaying the stale message costs depth within the cap (was KEPT,
  gain 4; diagnostic member of the family)
- Mechanism: for orphans only, replace purgatory's step budget by a
  protocol-activity clock - one k per run from {2, 4, 8, 16}; ghosts
  masked until the origin has taken k handler entries since its restart,
  or the window; per-arm release and stale-acted counters. Frozen: bits
  GHOST_ENTRY_CLOCK = 1 << 17 (half of all runs) and GHOST_ENTRY_CLOCK_HIGH
  = 1 << 18 (k in {8, 16}); band [1.02, 1.10] on bit 17; firing
  ghost_clock.armed >= 100,000; observable: k=2 stale acted rate >= 1.3x
  k=16, bit-18 depth <= 1.00 within treated; falsifier as the siblings'
  plus pooled expired/armed above 0.40; cost 0.97; draw k from a dedicated
  stream, not Stream::SendDelay.
- Judge caveat: the absolute per-arm acted levels the proposal named are
  below today's baseline sender_restarted.acted_fraction of 0.176 and were
  dropped; the ratio clause stands.

## ghost-absorber-crash-retarget

- kind: add | category: scheduler | origin: proposer | status: MERGED at
  fabf0ea (spur 1c4d55f) on the user's decision after a filing - depth>=6
  per-run 1.7093 [1.6242, 1.7989] (z 28), per second 1.347, throughput
  0.977, regression passed, grader rule merge; one guard clause of its own
  falsifier fired, plan_complete -6.6 points (clause 3), an intrinsic cost
  of crashing the active primary while VR.spur clients never time out. The
  crashes-per-run miss recorded at filing was a denominator error (probe
  crashes in the control bucket); corrected ratio 0.995, clause met. The
  crashed-victim hold governs ~2 crashes per 10,000 treated runs, so it
  explains neither. Follow-up ghost-absorber-retarget-redraw measures it |
  parent: none (extends the fault-placement family the fan-out anchor
  belongs to)
- Mechanism: fault target selection keyed on incarnation crossings. A
  detector on every run marks, at the dispatch site, each delivery whose
  origin is currently crashed or has restarted since sending, and records
  on the destination's ledger the step of its most recent such consumption
  and whether the handler acted. On the treated half (bit 1 << 19,
  ghostAbsorberRetarget, salted half of all runs, run-cap probes exempt),
  when a placed crash on plan victim v is applied, the crash lands instead
  on the live node d that most recently consumed a fault-crossing delivery
  (acted preferred), and the plan's paired recover is remapped from v to d
  so the mandatory crash-recover pair stays a pair. Placement timing and
  the fan-out anchor's hold are evaluated on v as today; only the identity
  of the node that dies changes. Judge rewrites: candidates exclude any
  node with an outstanding crash-recover pair (victim_swap.skipped_pending_
  pair); a planned crash whose victim is already crashed at release is held
  in the crash mask until it recovers (victim_swap.victim_crashed_holds); no
  extra crash_pending decrement (take_local already does it); campaign
  runs only - the run-plan path that regenerates the corpus keeps plan
  victims; two both-halves diagnostics, crash_census victim_had_inflight
  per half and ghost_signal.fired_runs.
- Why: the ladder loses 91% of runs between depth 4 and 5: 79,114 runs per
  chunk reach depth 4 (the null recover or the ghost delivery) and 7,257
  reach depth 5, the absorber's crash after it. Under a uniform victim draw
  the second crash names the node that absorbed the ghost one time in
  three; retargeting replaces that third with the probability that the
  most recent absorber is the right node, about a half or more, so the
  channel ratio is 1.5 to 2.25. The crash census in the merged code
  compares the plan's victim to itself, so which node dies has never been
  measured. It acts on WHICH node a fault hits, not on message timing,
  which the record says costs depth.
- Frozen prediction (epoch 13, per-run template): bit
  GHOST_ABSORBER_RETARGET = 1 << 19 (ghostAbsorberRetarget), salted half of
  all runs by run id, probes exempt; rung depth>=6 per-run ratio treated
  against untreated, probe-free, co-bit matched, band [1.25, 3.00]; firing
  victim_swap.applied >= 60,000 per chunk, with victim_swap.{no_absorber,
  same_victim, acted_absorber, skipped_pending_pair, victim_crashed_holds}
  and victim_swap.census.{treated,control}.{crashes, victim_had_absorbed}
  exported; independent observable: treated absorbed-victim share >= 1.5x
  control (treated HIGHER), crashes applied per treated run within 1% of
  untreated; falsifier: the depth>=6 interval entirely below 1.25, or
  absorbed-victim share below 1.5x control, or crashes per run off by more
  than 1%, or treated steps per run above 1.10x, or treated plan_complete
  more than 3 points below untreated; cost clause: cross-binary throughput
  >= 0.97 of the paired baseline. Band arithmetic: misses below 1.25 if the
  most recent absorber is the right node less than 42% of the time.
- Measurement validity: the bit turns off only the retarget; the detector
  and census run on every run and draw no randomness; no session-global
  learner is touched, so the untreated half is byte-identical to the merged
  behaviour and the contrast measures the whole per-run effect.

## ghost-prefix-replay-corpus

- kind: add | category: feedback | origin: proposer | status: MERGED at
  919f12c (spur c5e49c2) - depth>=6 per-run slots/fresh 2.1907 [2.1049,
  2.2800] (z 53), per second 1.68, throughput 1.063, regression passed;
  fidelity clause fired (0.436 vs 0.5) and PREFIX/PLAN-ONLY read 1.124:
  the gain is mostly plan re-sampling of signal-firing runs. Slot runs
  complete plans at 0.078 vs 0.306. Follow-ups: children inherit the
  parent's mechanism bits; a plan-only variant without tapes
- Mechanism: grid arms record every run's RNG tape as the aos arm does; a
  run whose first fault-crossing delivery enters a node with a crash
  pending is admitted to a per-arm corpus (64 parents, up to 8 children
  each) with the tape position at that step. Half the slots by run id run a
  child: PREFIX replays the parent's tape to the cut with a fresh suffix,
  PLAN-ONLY reruns only the parent's plan; probes never become children.
  Bits 1 << 20 (slot) and 1 << 21 (PREFIX vs PLAN-ONLY). Band [1.30, 4.00];
  firing replay.children >= 100,000; observables: prefix fidelity >= 0.5,
  PREFIX >= 1.3x PLAN-ONLY, depth>=8 per treated run >= 0.9x control; cost
  0.92 (tape recording is a shared hot-path cost the contrast cannot see).
- Judge caveats: P(signal) and fidelity are unmeasured and the lower edge
  hinges on both; children of one parent are correlated (inflate seEff
  about 2x at 8 per parent); the existing aos replay corpus reads below
  grid per run (1.12% vs 1.30%).

## hazard-thompson-config-walk

- kind: add | category: feedback | origin: proposer | status: KEPT at
  iteration 19 (judge gain 4, cost 0; dedupe discount - it is the PLAN-ONLY
  arm of ghost-prefix-replay-corpus)
- Mechanism: per-arm Beta posteriors over config_index rewarded by the
  ghost-with-crash-pending signal; treated non-probe slots draw their config
  by Thompson sampling, untreated slots keep the round-robin cursor. Bit
  1 << 22. Band [1.15, 1.80]; firing config_walk.thompson_draws >= 150,000;
  observable: treated hazard rate >= 1.3x control; steps clause 1.15x; cost
  0.90 with a panel blocker at 0.85x the anchors.
- Judge corrections: the "two-fold density difference" is 1.45x on the
  epoch-12 rung; the dead-third claim (one-crash configs cannot reach depth
  5) holds.

## ghost-absorber-retarget-redraw

- kind: add | category: scheduler | origin: operator-agent | status: CLOSED
  at iteration 20 on its firing floor - 257 and 270 victim-down landings per
  chunk against 2,000; the hold governs ~20 crashes per 10,000 treated runs
  and is bounded harmless by population; redraw/hold depth>=6 0.9998
  [0.9415, 1.0617] | parent: ghost-absorber-crash-retarget (merged fabf0ea)
- Mechanism: the merged retarget's crashed-victim hold turned off on a
  nested half. On a salted half of the retarget-treated runs (bit 1 << 23,
  ghostAbsorberRedraw, own salt, probes exempt by inheritance, about 0.24
  of all runs), a placed crash whose planned victim is already down is not
  held: it lands on the best live absorber if one exists, otherwise on a
  live node without an outstanding crash-recover pair drawn from a
  dedicated RNG stream (Stream::Retarget, so the run's other draws match
  its hold twin), and the paired recover is remapped as in the parent. If
  no such node exists the crash falls back to the merged hold
  (victim_swap.redraw_fallback_holds). Untreated retarget runs keep the
  hold byte for byte; the census gains a third cell {control, hold, redraw}.
- Why: the parent read 1.709 on depth>=6 per run with two guard clauses
  fired - 6.5% fewer crashes landed and 6.6 points fewer plans completed on
  treated runs. Whether the hold is a rail cost, a hidden contributor to the
  gain (a held crash lands on the recovered node's ghost absorber at the
  step it comes back, the oracle's step-4 shape), or innocent of both is
  what this decides in one session; the parent's cross-session form could
  not.
- Frozen prediction (epoch 13, nested per-run template): bit
  GHOST_ABSORBER_REDRAW = 1 << 23 (ghostAbsorberRedraw); rung depth>=6
  per-run ratio of redraw runs to hold runs (bit 23 within bit 19,
  probe-free, co-bit matched), band [1.02, 1.15]; firing
  victim_swap.victim_down_landings (redraw quarter) >= 2,000 per chunk with
  victim_swap.victim_down_holds (hold quarter, per crash) expected within
  15% of it as randomized twins - below the floor the hold governed under
  1% of treated runs and the round closes with the hold bounded harmless
  and the parent's misses attributed to the retarget itself;
  victim_swap.{applied, no_absorber, same_victim, acted_absorber,
  skipped_pending_pair, redrawn, redraw_fallback_holds,
  victim_crashed_holds} and the three-cell census exported. Independent
  observables: redraw crashes applied per run >= 1.03x hold runs (HIGHER);
  redraw plan_complete >= hold + 3 points (HIGHER); redraw absorbed-victim
  share >= 0.9x hold share and both >= 1.5x untreated. Falsifier: the
  depth>=6 interval entirely below 1.00 (redraw LOWER - the hold
  contributed; keep the hold); or redraw crashes per run below 1.02x hold;
  or redraw plan_complete not above hold's; or redraw steps per run above
  1.02x hold; or absorbed share below 0.9x hold. Cost clause: cross-binary
  throughput >= 0.97; secondary within-session reading redraw wall per run
  <= 1.00x hold wall per run. Verdict rule: band met and rails clean ->
  merge; interval containing 1.00 with rails clean -> merge on the rails,
  depth recorded neutral; any falsifier -> close with the named reading.
- Judge arithmetic worth keeping: the hold cannot explain the parent's
  whole crash deficit (488k hold tests at 3+ tests per step is at most
  ~160k held steps against ~31k lost crashes per chunk-half), so a route
  that survives hold removal - a plan crash gated on a client op stuck
  behind the stall the retarget provokes - is live, and the crashes clause
  is the decisive rail.

## retarget-census-after-landing-fix

- kind: ablate | category: scheduler | origin: operator-agent | status:
  MERGED at 919f12c inside ghost-prefix-replay-corpus, counter half only
  (judge gain 5, cost 0): exact identities held on both chunks, early/mid
  apply shares 0.834/0.838 and stock 0.738 inside their predicted bands; the hold half is STRUCK (its retarget-instead-
  of-hold form is byte for byte the redraw under grading; its exclusion form
  is unbounded). Judge corrections: the wrong-node rows are 19.4-19.8% of
  treated crash rows (9.4% of all), and the hold governs about 20 per
  10,000 treated runs, not 2 | parent: ghost-absorber-crash-retarget
- Mechanism: two implementation gaps in the merged retarget, from
  research/lite/findings/retarget-crash-deficit-analysis.md. (1) The
  crash-anchor, crash census and crash_phase apply counters read the
  planned victim's ledger before retarget_crash runs, so on treated runs
  about 17% of those rows describe a node that did not crash; move the
  reads after the landing is known. (2) With density edges a plan can carry
  Crash(d) -> Recover(v); after Crash(v) lands on d, Recover(v) waits on
  Crash(d), which the crashed-victim hold withholds until d recovers - a
  wait cycle absent on control that holds a crash to the cap. Exclude
  nodes with an uncompleted plan crash from choose(), or retarget instead
  of holding.
- Why: (1) is measurement validity for every census the loop reads about
  crashes; (2) is the entire population the redraw follow-up measures and
  is fixable inside the merged rule. Neither should move depth; the frozen
  prediction is a null band with the counters as the claim.
- Frozen prediction: no new bit (a fix to the merged mechanism's shared
  path; the treated half is bit 19 as today); rung depth>=6 per-run ratio
  on bit 19 within [1.60, 1.85] (the merged read was 1.709 - the fix must
  not move it); cross-binary throughput >= 0.98; census rows on treated
  runs whose victim differs from the crash-anchor row fall to 0 (new
  counter victim_swap.census_mismatch, expected 0 against ~17% today);
  victim_swap.victim_crashed_holds per run within 0.5x of today on treated
  runs; falsifier: the bit-19 interval entirely outside [1.60, 1.85], or
  census_mismatch above 0.5%, or throughput below 0.98.

## trace-print-format-pipeline-direct-write

- kind: perf | category: performance | origin: proposer | status: MERGED at
  f72f3ff (spur e513cac) on the user's decision after a filing - throughput
  1.0924 (band [1.08, 1.12] met), wall per step 0.93/0.92, depth>=6 per
  second 1.084, acceptance byte-identical single-threaded, allocations
  -28.9%, regression passed
- Hotspot: the trace and print formatting pipeline - core::fmt::write
  3.69% self on the fresh profile, String::write_str 2.43%, Value::fmt
  1.06%, serde_json serialize_str 2.27% - on every delivery of every run:
  each @trace handler produces three rows whose parameters are formatted
  with to_string into a Vec<String>, each println builds its string through
  Plus concatenations and IntToString via fmt, and serialize_traces re-walks
  every row into Vec<JsonValue> inside a nested par_iter, cloning payloads
  and names. The traces table is grader instrumentation and must stay byte
  for byte identical; the change alters no byte.
- Change: Value::write_to appending exactly the Display bytes (Display
  delegates to it); trace parameters formatted into one reusable scratch
  string with the JSON payload written once per item through
  serde_json::to_writer; TraceEntry carries the pre-serialized payload and
  an Arc<str> name; serialize_traces and serialize_logs move rows into the
  writer sequentially with no JsonValue and no clone; Print builds its
  content through write_to; string Plus and IntToString allocate once.
- Frozen prediction: kind perf, rung throughput - cross-binary runs per
  explore-second on general_vr.json in [+8%, +12%] (point +9%);
  independent observable: per-run allocation count under a counting
  allocator on bench.json with VR.spur falls by at least 20% (negative
  sign) with traces rows per run unchanged; paired wall per step per shared
  run id falls by the rung's ratio; cost clause: depth>=6 per run on the
  crashPhase (512) internal contrast unchanged, and identical per shared
  run id since no schedule moves; steps per run per arm identical.
  Falsifier: the throughput interval entirely below +8%; any shared run id
  differing in executions rows, steps_used, or utilStats counters; any
  byte of the traces or logs parquet differing on the golden set; or the
  allocation count not falling. The judge's arithmetic puts the honest
  point at +8-9%, on the floor: serialize_str is kept per item.
- Acceptance test (implementer): fixed-seed standard runs of VR, Paxos,
  Raft and the six fixtures before and after; equal digests of executions
  (run_id, seq_num, kind, action, payload, step), runs (workload_seed,
  schedule_seed, steps_used, end_reason) and every utilStats counter
  including tape_words_sum; equal hashes of all traces and logs rows
  ordered by (run_id, seq_num); property tests that write_to equals Display
  on nested and edge-case values and that inline payload bytes equal
  serde_json::to_string of the same items.

## handler-invocation-fixed-overhead-take-env

- kind: perf | category: performance | origin: proposer | status: HELD at
  iteration 22 (judge gain 3, cost 2) until a debug counter reads the
  node-environment copy fraction; never in the same binary as the
  formatting rewrite
- Hotspot: execute_common_label 4.90% and exec 2.09% with make_unique
  1.92%, make_local_env 1.60% and SipHasher 2.15% beneath them; the
  proposal's mem::take of the node environment with write-back, compile-
  time call-target resolution and a single-allocation frame. Judge: the
  local environment is shared at every entry and TraceEnter writes a local
  slot first, so make_unique fires on every traced entry regardless; the
  node-env copy fires only when a node variable is written, measured at
  40.9% of ordinary deliveries; corrected gain about +6%, inside the layout
  band. Hazards traced and found safe (two mid-exec readers of the node
  env; complete exit paths; no crash interleaves exec).

## general-chain-funnel-census

- kind: diagnostic | origin: proposer | status: DONE at iteration 23
  (judge gain 7, cost 0) | tool: research/lite/tools/ghost_census.py |
  report: research/lite/findings/chain-precision-census.md. Readings:
  R1->R2 is the largest drop (47/54 lost at depth 9, 516/672 at depth 8;
  the ghost's round is stale at the receiver in 54-62% of failures); R4 is
  0 of 2,265 general runs (node 2's reactions reach node 1 only while it is
  still recovering, or never); view churn median 22 views at depth 9 in
  general against 2 in the corpus
- Survival funnel over general depth>=7 runs against the corpus: R1 the
  matched StartViewChange 1->2 is a ghost (sender crashed between dispatch
  and delivery) -> R2 acted on -> R3 node 2 crashed before its reactions
  landed -> R4 the reaction ghost acted on by a recovered node 1 -> R5
  ghost-built fan-out -> R6 commit window -> R7 violation. Judge pre-check
  on the general session: R1 54/74 depth-9 and 672/801 depth-8, R2 7 and
  156, R3 1 and 57, R4 0 and 0 - the largest drop is R1 -> R2, a rung the
  proposal had no row for: the ghost is not acted on because node 2's view
  is already stale (29 of 47) or already completed (12 of 47); general runs
  churn through 15-64 views.

## ghost-quorum-epoch-formation-census

- kind: diagnostic | origin: proposer | status: DONE at iteration 23
  (judge gain 7, cost 0). Readings: 11/11 vs 0/81 vs 0/53 on the corpus;
  16-23% of general runs at every depth (412 of 2,265) with zero
  violations - never a label alone
- The fan-out's quorum window (from the receiver's "entering view change"
  log row to the fan-out dispatch) contains a ghost from a restarted
  sender. Judge pre-check with the exact window: 11/11 violating, 0/81
  corpus non-violating depth-9, 0/53 depth-8; general 17/74 depth-9 and
  150/801 depth-8 with zero violations, so a ghost-built quorum alone has
  near-zero precision on general runs. The generic window as proposed was
  broken (it excluded the quorum-completing ghost; it counted dropped
  ghosts) and is corrected in the tool.

## old-epoch-commit-window-census

- kind: diagnostic | origin: proposer | status: DONE at iteration 23
  (judge gain 6, cost 0). Readings: the old-view commit whose uid is absent
  from the new log is 1.000/1.000 on the corpus and 0 everywhere in
  general; the ghost sender's recovery into the OLD view is 11/11 vs 0 of
  412 general ghost-built fan-outs (65 recover into the new view, 347 never
  complete); its recovery request answered before the fan-out node left
  the old view is 11/11 vs 0/875
- A client write commits at a node in the old view after the fan-out was
  sent and before that node enters the new view. Redefined by the judge as
  an acted old-view PrepareOK for the write, joined through
  CausalOperationID. Pre-check: 11/11, 0/81, 1/74, 24/801; the conjunction
  with the ghost-quorum window reads 0/74 and 3/801 on general runs, and in
  all three hits the ghost DoViewChange's sender never completed recovery
  or recovered into the new view - bug.md step 4 is the unmet condition.
  The corpus cannot test this one independently: its plan gates w2 after
  the DoViewChange delivery, so the quorum predicate implies it there.

## ghost-pair-acted-census

- kind: diagnostic | origin: proposer | status: DONE at iteration 23
  (judge gain 5, cost 0; the ordering clause separates 11/11 vs 0/81 and
  coincides with the quorum-window set)
- Two acted-on ghost deliveries from restarted senders. Pre-check: the
  generic form leaks (51/81 non-violating), fired by double-crash Recovery
  replies; the ordering clause - the ghost StartViewChange acted on at a
  recovered node 1 before the ghost DoViewChange - separates 11/11 vs 0/81
  (all 22 failures: DoViewChange landed first and was dropped) but is the
  same eleven runs as the quorum window.

## ghost-pending-timer-hold

- kind: add | category: scheduler | origin: proposer | status: CLOSED at
  iteration 24 under epoch 14 - bound (timer firings with a ghost pending
  0.614x) but acted-on-ghost share only 1.130x and depth>=8 per run 1.005:
  peers' messages advance the round, so holding the receiver's timer alone
  does not keep it in the ghost's round | steered by the chain-precision
  census
- Mechanism: timer admission, not a message hold. On a salted half of runs
  (bit 1 << 25, ghostPendingTimerHold; probes exempt), a node's timer
  firings are ineligible while a remote record to that node from an origin
  that is crashed or has changed incarnation is still undelivered - the
  dispatch site's existing fault_crossing test. An episode opens at the
  first masked offer and closes when the ghost lands or at 32 steps (128 on
  a nested salted half, bit 1 << 26), after which the node stays unmasked
  until no ghost is pending once. A liveness lift drops the mask for the
  step whenever no other runnable would be eligible, so a held timer never
  makes a blocked step. No record is masked or reordered. A both-halves
  census counts timer firings with a ghost pending, ghost deliveries, ghost
  acted (state token changed) and ghost sent (issued delta), gated on
  net_stale_records > 0 or any node crashed so quiet stretches pay one
  branch.
- Why: the census found the general chain dies first where the crashed
  sender's StartViewChange lands on a round the receiver has already left
  (47 of 54 depth-9 runs); general runs churn through a median of 22 views
  because timers free-run. A broadcast from a crashed sender puts a ghost in
  front of every live peer's timer at once, so holding timers while a ghost
  is pending leaves no free clock to advance the round - the corpus's
  construction stated as a rule. Its natural length is the flight time of a
  message, a few steps, not the 96-step budget on which the message-hold
  family expired.
- Frozen prediction (epoch 13, per-run template): bits 1 << 25
  (ghostPendingTimerHold) and nested 1 << 26 (ghostPendingTimerHoldLong);
  treated share about 0.47; rung depth>=6 per-run ratio treated against
  untreated, probe-free, co-bit matched, band [-3%, +12%] (a null is
  allowed; the claim is carried by the observables); firing
  ghost_timer_hold.episodes >= 400,000 per chunk with masked_offers,
  released_by_landing, expired, lifted_for_liveness, long_bound_runs and
  the census exported; independent observables: (a) treated ghost acted
  share >= 1.20x control (control 0.161), (b) treated share of timer
  firings with a ghost pending <= 0.50x control, (c) treated ghost sent
  share >= 1.30x control, (d) post-session census on a kept explore:
  treated R2 >= 1.3x control at depth>=8 (control 19.5%), (e) nested: the
  long bound expires less and acts at least as often; falsifier: the
  depth>=6 interval entirely below 0.97, or (a) below 1.10x, or (b) above
  0.70x, or treated steps per run above 1.05x control (baseline 2,384), or
  treated plan_complete more than 3 points below control (baseline 23.05%),
  or crashes or recovers per treated run outside 1% of control (2.062 and
  1.876); cost clause: throughput >= 0.97, regression passes. Verdict map:
  observables met and depth flat in [0.97, 1.02] -> file for the user (a
  precision result the rung cannot price); observables met and depth up ->
  merge; (a) or (b) missed -> close.
- Epoch-14 re-freeze (before the session): primary depth>=8 per-run ratio
  treated against untreated in [1.03, 1.30]; the depth>=6 band above stays
  the admission claim and is read from the same session.

## restart-opening-timer-hold

- kind: add | category: scheduler | origin: proposer | status: KEPT at
  iteration 24 (judge gain 4, cost 0), sequenced behind
  ghost-pending-timer-hold: on the target chain every recovery request
  travels beside a ghost from the same origin, so the ghost hold already
  holds those timers, and its own rung is lost to a Recovery-versus-ghost
  race at one destination that no timer hold touches. Bit 1 << 27; hold a
  node's timers while an undelivered record to it comes from a restarted
  origin's opening segment; 64-step bound.

## clock-debt-timer-hold

- kind: add | category: scheduler | origin: proposer | status: HELD at
  iteration 24 (judge gain 3, cost 0) until its control-half refire census
  exists: the debt clears on any delivery and timer-driven churn is
  delivery-interleaved by construction, so it binds only for a node whose
  peers are all down. Bit 1 << 28.

## oracle-v2-recovery-answer-chain

- kind: grader/oracle | origin: operator-agent (from the iteration-23
  census) | status: LANDED as epoch 14 at 5bba601 (policy pointer) - see
  research/lite/plans/oracle-v2-epoch14.md and the observations entry
  "Epoch 14". Follow-up deferred: the dispatched-before matcher field
  (ghost = dispatched before the sender's crash) that would take the
  general tail from 984/46/15/9 at depths 9-12 to about 595/10/1/0.

## restart-before-stranded-drain-preempt

- kind: add | category: scheduler | origin: proposer | status: CLOSED at
  iteration 25 on its falsifier - overtake share 0.988x control (clause
  1.10x); the mechanism fired (0.975 of eligible recoveries
  preempted) but the stock explorer already restarts before the drain
  0.885 of the time, so there was no headroom;
  depth>=8 1.0341. The dispatch choice between the Recovery request
  and the ghost decides depth 8 | parent:
  recovery-stranded-drain-phase-anchored-release
- Mechanism: recovery timing keyed on the victim's own stranded fan-out,
  in the one direction the closed family never read on a rung that sees
  it: BEFORE the first consumption. On a salted half of runs (bit 1 << 29,
  recoverPreempt; probes exempt) a plan-released Recover(v) offered while v
  crashed with remote sends in flight and none of them has yet entered a
  handler is taken at that step ahead of every other eligible runnable - a
  preemption before the queue selector, after the crash hold mask. No record
  is masked, held or reordered; only the one fault event is displaced, as a
  released crash displaces a delivery today. Once any stranded send is
  consumed the rule lapses for that pair. Nothing is drawn; the untreated
  half is byte-identical. Judge correction: restart-latency's forced-
  immediate arm was this direction, read on depth>=6 where it matched
  stock; epoch 14's depth 8 is exactly "ghost SVC 2->1 still undelivered
  when Recovery 2->1 lands" (baseline P(8|7) 0.384/0.372), which caps the
  gain at 6 and makes the re-read admissible.
- Frozen prediction (epoch 14): bit RECOVER_PREEMPT = 1 << 29
  (536870912, recoverPreempt); treated share about 0.47; primary depth>=8
  per-run ratio treated against untreated in [1.06, 1.30]; depth>=6 in
  [0.99, 1.04]; firing recover_preempt.preempted >= 200,000 per chunk (half
  of the 370-380k eligible recoveries the treated half inherits from
  recoveries_with_own_prior_sends_inflight 810k/786k); counters
  recover_preempt.{eligible, preempted, lapsed_before_queued (only when
  the plan holds a RecoverNode for v), stock_before_drain (both halves),
  ghost_entries_from_restarted_origin (both halves), overtaken (both
  halves)}, stranded and consumed both defined on remote records;
  observables: (a) preempted/eligible >= 0.85 treated, control's
  stock_before_drain/eligible reported (expected 0.5-0.8); (b)
  overtaken/ghost_entries_from_restarted_origin treated >= 1.30x control;
  (c) depth>=9 per run >= 1.05 and depth>=11 events per chunk >= 1.3x
  control on the treated half; falsifier: depth>=8 interval entirely below
  1.03, or (a) below 0.70 (report lapsed_before_queued/eligible; above 0.30
  names the plan edge), or (b) below 1.10x, or treated steps per run above
  1.05x control (baseline probe-free 2,113 and 2,174 per chunk), or treated
  plan_complete more than 3 points below control (probe-free 21.4% and
  20.6%), or crashes or recovers per treated run outside 1% of control
  (2.085/2.126 and 1.894/1.923); cost: throughput >= 0.97 of 2041.85, the
  preempt scan gated on some node crashed with stranded > 0 and consumed
  == 0, regression passes. Verdict map: (a) and (b) met and depth>=8 up ->
  merge; observables met and depth>=8 in [0.97, 1.03] -> file with the
  depth>=11 count; (a) or (b) missed -> close, recording
  lapsed_before_queued (which decides whether Recover events exempt from
  density edges are worth a round).

## crash-hold-while-peer-restart-unsettled

- kind: add | category: scheduler | origin: proposer | status: HELD at
  iteration 25 (judge gain 3, cost 0): in general runs 81% of the
  receiver-recovering failures have node 1 waiting on the victim itself, so
  a hold on a peer's recovery progress expires by construction on the
  rung's chain; the "settled" predicate over-approximates (a recovering node
  that drops a ghost still "heard" from it). Admissible again with a
  readiness predicate a recovering node cannot satisfy by dropping a
  message.

## restart-release-on-ghost-destination-settled

- kind: add | category: scheduler | origin: proposer | status: HELD at
  iteration 25 (judge gain 2): collapses to its parent on one run shape and
  delays the restart into the drain on the other; not to be built in this
  form.

## fresh-first-same-pair-dispatch-tiebreak

- kind: add | category: scheduler | origin: proposer | status: MERGED at
  e10f046 - depth>=8 per run 1.1205 [1.0612, 1.1832], depth>=9 1.233,
  overtake share 1.41x, census P4_2 5 vs 0 on depth-8 runs, throughput 1.079,
  regression passed; depth>=6/7 read 0.967 (expectation [0.98, 1.03]
  missed, recorded)
- Mechanism: a same-step dispatch preference, not a hold. In the network
  branch of schedule_runnable, after the stock tournament has drawn a record
  and spent its RNG draws: on a treated run (bit 1 << 24, freshFirstPair,
  salted half by run id, probes exempt), if the drawn record is from a
  dead incarnation of its origin and an eligible record from that origin's
  current incarnation to the same destination exists, take that fresh record
  instead. The ghost stays eligible every step, no step goes unfilled, no
  expiry, no draw consumed; the scan is gated on the origin's ledger having
  both fresh and stale records in flight. Channel sends are neutral.
- Why: iteration 25 established that the Recovery request and the ghost
  StartViewChange are both in flight to the peer at once and the dispatch
  choice decides depth 8; the control's overtake share of 0.37 says the stock
  tournament takes the ghost first about 60% of the time. Under a same-pair
  fresh-first rule the swap fires once per restart episode (the fresh
  backlog is the one Recovery record) and the overtake share should rise to
  0.8-0.9.
- Frozen prediction (epoch 14): bit FRESH_FIRST_PAIR = 1 << 24 (16777216);
  primary depth>=8 per-run ratio treated against untreated in [1.12, 2.60]
  (expected 1.5-2.4); depth>=6 in [0.98, 1.03]; depth>=7 in [0.99, 1.05];
  depth>=9 and 11 reported; firing fresh_first.swaps >= 100,000 per chunk
  and fresh_first.contested_dispatches >= 300,000 per chunk (both halves);
  independent observable: treated overtake share >= 1.30x control (control
  about 0.37); reported: control stale_drawn/contested (the coin),
  repeat_swaps/swaps <= 0.25 with a swap-count histogram, contested_down,
  and a post-session census of P4_2 and R4 on treated versus control
  depth>=8 runs; falsifier: depth>=8 interval entirely below 1.03, or
  overtake below 1.10x, or repeat_swaps/swaps above 0.25, or any treated
  contested dispatch that delivered the stale record while a fresh same-pair
  record was eligible, or treated steps per run above 1.05x control
  (probe-free 2,102 and 2,163), or plan_complete more than 3 points below
  control (21.9% and 21.1%), or crashes or recovers per treated run outside
  1% of control; cost: throughput >= 0.97 of 2041.85, regression passes.
  Verdict map: depth>=8 up, overtake met, treated P4_2 share not below
  control -> merge; depth>=8 up and overtake met but P4_2 below control ->
  file for the user (the swap forbids the RecoveryResponse-before-Recovery
  order node 1 needs to finish its own recovery); observable met and depth 8
  flat -> file with depth 9 and 11; observable missed -> close.
- Judge corrections: the proposal's depth-9 mechanism does not exist for
  this chain (node 2's RecoveryResponse to node 1 is sent before crash_2 and
  is itself stale); the three-way class's automated read would be polluted
  by its own stale-first arm (co-bit matching matches only bits set on every
  treated cell).

## fresh-first-destination-wide-restart-episode

- kind: add | category: scheduler | origin: proposer | status: HELD at
  iteration 26 (judge gain 4) for the round after the same-pair read;
  bit 1 << 30 in its own session; amplifies the RecoveryResponse
  displacement hazard.

## pair-order-drawn-class-fresh-stale-stock

- kind: add | category: scheduler | origin: proposer | status: HELD at
  iteration 26 (judge gain 3): its stale-first arm pollutes the automated
  contrast; if the same-pair read is flat, run stale-first alone as a
  half-of-runs session on bit 1 << 12 with a negative band.

## restart-opening-send-first-at-every-peer

- kind: add | category: scheduler | origin: proposer | status: HELD at
  iteration 26 (judge gain 4, cost 2 as proposed - an exec.rs stamp; cost 0
  if "opening" is derived from a send-ordinal range on the ledger); bit
  1 << 17 when built.

## replay-tier-answered-overtake-cut

- kind: add | category: feedback | origin: proposer | status: CLOSED at
  iteration 27 - band refuted: depth>=8 0.6453 [0.5986, 0.6956], depth 6
  0.595, depth 9 0.644; deep children fired their signal 0.617 against tier-1's
  0.768 (clause 1.5x). The deep cut lands late, so children replay to a
  finished state (0.803 of control steps, +25.6 points of plan completion)
  instead of searching | parent: ghost-prefix-replay-corpus
- Mechanism: two deeper corpus tiers beside the merged one. Tier 2 admits
  a parent at the first ghost entry into a node that had already heard AND
  replied to the origin's current incarnation (a per-pair answered flag
  written at network entry; the protocol-free reading of "receiver not
  recovering"), with the cut at that step; tier 3 at the second ghost from
  the same dead incarnation into that peer (the depth-9 shape). Treated
  slots (bit 1 << 13, replayTierDeep, a salted half of slot ids) serve the
  deepest non-empty tier; control slots serve tier 1 as today. The corpus
  is oversupplied at the depth-4 signal (65,620 parents against 221,689
  children per chunk, 8 children each), so selectivity is free until the
  signal rate falls below about 42% of today's. The heard table's update
  moves out of the util_stats gate.
- Frozen prediction (epoch 14): bit REPLAY_TIER_DEEP = 1 << 13 (8192);
  treated share 0.19; depth>=8 per run treated slots against control
  slots, co-bit matched, band [1.12, 2.20] on the SE-inflated interval
  (multiply seEff by sqrt(1 + (m - 1) * 0.5), m = children per parent on
  the thinner side); depth 6 in [0.95, 1.25]; depth>=9 ratio at least the
  depth>=8 ratio, expected [1.15, 3.0]; firing per chunk: tier-2 plus
  tier-3 children >= 40,000, tier-2 parents >= 5,000, deep_signal.tier2_
  fired_runs >= 60,000 (ghost_signal.fired_runs 253,917 on the cache);
  independent observables: tier-2/3 children fire the deep signal at >=
  1.5x the tier-1 children's own-signal share (0.733), mean cut step tier 2
  above tier 1, tier fallback share reported, post-session census P4_2 and
  R4 on treated versus control depth-8 runs; falsifier: deep-signal ratio
  below 1.2x, or tier-2 parents below 5,000, or the inflated depth>=8
  interval entirely below 1.03; cost: throughput >= 0.97 of the fresh
  cache (2139.37), steps per run <= 1.05x control slots, plan_complete
  within 3 points of control slots.

## replay-prefix-inherit-parent-bits

- kind: enabling | category: feedback | origin: proposer | status: READ at
  iteration 27, ADMITTED for its own session: fidelity 1.029 against 0.313
  for own-id children, and 0.974 for own-id children whose bits happened to
  match - the run-id-keyed mechanism draws were the whole fidelity gap.
  CLOSED at iteration 28 on its cost clause: fidelity 1.056 against 0.322
  (bits-equal control 0.987) confirms the finding, but the depth>=8 read
  1.3461 is confounded by the parents' crash-placed bits (0.996 vs 0.917)
  and is 1.080 stratified over 32 matched strata, the same as depth 6
  (1.103); the session's depth>=8 events per second read 0.944 at throughput
  0.977 against a 0.98 clause, because inherited children are heavier runs.
  Was admitted as its own candidate with the tiers stripped out:
  bit 1 << 11 declared, PREFIX children only, the answered table and the
  deep signals removed. Frozen: fidelity of inherited children >= 0.65
  (measured 1.03 in the bundled session against 0.31 own-id) with no
  inherited child tagged as a probe; depth>=8 per run inherited against
  own-id prefix children in [1.00, 1.35], decided only if the interval,
  inflated by sqrt(1 + (m - 1) / 2) for children per parent, clears 1.00;
  depth 6 in [0.98, 1.15]; firing inherited children >= 40,000 per chunk;
  PREFIX over PLAN-ONLY reported against 1.12; falsifier: fidelity below
  0.65, any probe tag, or the inflated depth>=8 interval entirely below
  1.00; cost throughput >= 0.98, steps <= 1.05x, plan_complete within 3
  points |
  parent: ghost-prefix-replay-corpus
- Mechanism: on a salted half of PREFIX children (bit 1 << 11,
  replayInheritBits), every run-id-keyed mechanism draw (crash placement,
  crash phase, retarget, fresh-first, slot and prefix bits) is taken under
  the PARENT's run id, so the replayed tape pins the prefix; the child keeps
  its own DB id, slot bits and suffix seed; children of probe parents are
  not inherited from (counted). The runs-table variant carries
  from_run_id(mechanism_id) plus the child's grid-arm bits and the inherit
  bit.
- Frozen prediction: primary observable inherited-children fidelity >=
  0.65 (against control prefix fidelity about 0.437), bits_differed share
  >= 0.6; consistency check: own-id children whose bits happen to equal
  the parent's read fidelity within 5 points of inherited children; firing:
  inherited children >= 40,000 per chunk; depth>=8 per run inherited
  against own-id prefix children read on the co-bit-stratified cells (a
  balance fault on crashPlaced/crashPhase is expected), band [1.00, 1.35]
  reported, decided only if the inflated interval clears 1.00; depth 6 in
  [0.98, 1.15]; falsifier: fidelity below 0.65 (the divergence is shared
  learned state - file that finding), or any inherited child tagged as a
  probe, or the stratified depth>=8 read entirely below 1.00; cost:
  throughput >= 0.98, steps <= 1.05x, plan_complete within 3 points.

## replay-cut-at-last-signal

- kind: add | category: feedback | origin: proposer | status: HELD at
  iteration 27 (judge gain 3): the seed truncates the tape at the first cut
  today, so both cuts must be kept; direction uncertain after iteration 25;
  bit 1 << 15 when built, after the inheritance read.

## replay-key-stratified-serving

- kind: add | category: feedback | origin: proposer | status: HELD at
  iteration 27 (judge gain 3): the target's first-cut key is the modal one
  and half the signature keys are unreachable; bit 1 << 18 when built, after
  the tier counters show which stratum carries depth-8 children.

## pair-send-order-dispatch-fault-scoped

- kind: add | category: scheduler | origin: proposer | status: CLOSED at
  iteration 29 on its cost clause (throughput 0.892; the both-halves census
  scans the queue per entry) with the band missed: depth 9 per run 1.151
  [1.011, 1.311] against [1.30, 2.00], depth 8 0.985 (null held), treated
  inversions 0 against 0.384 control. Lean follow-up admitted below |
  parent: fresh-first-same-pair-dispatch-tiebreak

## pair-send-order-lean

- kind: add | category: scheduler | origin: operator-agent | status: MERGED
  at 1921761 (spur f28f1b5) by operator decision - depth>=9 per run 1.098
  [0.995, 1.211] at z 2.57 over four chunks (rule 2.7; grader read human),
  pooled with the parent about 1.12 clearing 1.02; depth 8 flat; cost
  clean; treated inversions 0 against 0.374 | parent:
  pair-send-order-dispatch-fault-scoped
- Mechanism: the same same-step preference on the same bit (1 << 15),
  with the census taken only on a salted 1/16 of runs (both halves) and the
  contest counters kept O(1) at the preference site; no queue scan on
  entries outside the sample. The preference itself scans only the
  eligible set at a step where the pick's origin has crashed and holds two
  or more records.
- Frozen prediction (epoch 14): depth>=8 per run in [0.97, 1.08] (null);
  depth>=9 per run in [1.08, 1.30] (the parent read 1.151 [1.011, 1.311]);
  depth 6 in [0.98, 1.08]; firing pair_order.corrected >= 60,000 per
  chunk; census on the sample: treated inversions <= 0.02, control in
  [0.25, 0.60]; falsifier: depth-9 interval entirely below 1.03, treated
  inversions above 0.05, steps above 1.05x, plan_complete more than 3
  points below, crashes or recovers off 1%; cost: cross-binary throughput
  >= 0.97 of 2139.37 AND wall per run treated/untreated within 1%. Verdict
  map: depth 9 separated above 1.0 with depth 8 not below its band and
  cost met -> merge on the advance rung; cost missed again -> close and
  record the census cost as the loop's lesson.
- Mechanism: a same-step preference after the tournament draw and the
  merged fresh-first swap, on a salted half of runs (bit 1 << 15,
  pairSendOrder; probes exempt). If the record about to be taken is a
  remote record whose origin has crashed at least once in the run, and an
  eligible record with the same origin, destination and origin incarnation
  has a lower send ordinal, take that one instead. The order inside the
  incarnation class fresh-first picked becomes send order; nothing is
  masked or delayed; no draw is consumed; the scan is gated on the origin's
  ledger holding two or more records in the queue. Unlike FifoLink (a spec
  opt-in and a hard eligibility constraint that can empty a step), this
  only orders among co-eligible records.
- Why: at n=3 the first StartViewChange of a new view meets quorum at once,
  so the DoViewChange leaves the same handler right after the SVC broadcast
  with the next send ordinal, and each record's priority is drawn once at
  creation under novelty ablation - the tournament orders the two siblings
  by a fair coin, fixed per pair. Depth 9 needs SVC before DVC at node 1;
  P(9|8) reads 0.16 on the merged tree, so a perfect fix has a ceiling of
  about 2.0x. Judge correction: the corpus plan does NOT order svc before
  dvc; only the v2 oracle does.
- Frozen prediction (epoch 14): bit PAIR_SEND_ORDER = 1 << 15 (32768);
  treated share about 0.47; primary depth>=8 per-run ratio in [0.98, 1.10]
  (a stated null); depth>=9 per-run in [1.30, 2.00]; depth>=6 in [0.98,
  1.03]; depth>=11 events on the treated half >= 1.5x control reported;
  firing: pair_order.contests >= 300,000 per chunk on both halves,
  pair_order.corrected >= 60,000 per chunk, control inorder_draws/contests
  in [0.35, 0.65]; independent observable: census inversions/pair_entries
  control in [0.25, 0.60], treated <= 0.02; post-session census on a kept
  explore: treated depth-8 runs' "DVC before SVC at a recovered node 1"
  class = 0 and R4 >= 2x control; falsifier: depth>=9 interval entirely
  below 1.10, or treated inversions above 0.05, or control inversions below
  0.25 (no coin to fix), or corrected below floor, or steps > 1.05x, or
  plan_complete more than 3 points below, or crashes/recovers off 1%; a
  depth>=8 interval entirely below 0.97 closes regardless; cost: throughput
  >= 0.97 of 2139.37, regression passes. Verdict map: depth 9 up and
  inversions ~0 -> merge; depth 9 flat with inversions ~0 -> file with
  P(DVC exists | depth 8); inversions not removed -> close.

## recovering-receiver-reply-first-deferral

- kind: add | category: scheduler | origin: proposer | status: SUPERSEDED at
  iteration 34 by reply-first-at-unsettled-restarted-receiver (the same-step,
  no-hold form); previously HELD at iteration 29 (judge gain 5; cost 2 as proposed via a Record field in
  exec.rs, 0 with a side map keyed on (origin, send_ordinal)): a no-expiry
  hold in effect, but the first design meeting the pool's condition for
  the receiver-recovering class - a readiness predicate (acted on replies
  from more than half the peers its opening sends addressed) a recovering
  node cannot satisfy by dropping a message. Bit 1 << 22 when built, after
  the send-order read.

## pct-fault-change-point-stream-dominance

- kind: add | category: scheduler | origin: proposer | status: HELD at
  iteration 29 (judge gain 3): a dominated stream is held for the whole
  fault window whenever the dominant one has an eligible record, and the
  placebo arm needs a second bit. Not to be built in this form.

## restarted-sender-ghost-block-dispatch

- kind: add | category: scheduler | origin: proposer | status: CLOSED at
  admission, iteration 29 (judge gain 2): the block opens at the first
  member's stock draw and only pulls the others earlier, so it converts
  mixed outcomes into all-before - the wrong direction for the
  receiver-recovering class; its remaining content is the send-order rule.

## client-release-into-ghost-consumer-fanout-window

- kind: add | category: scheduler | origin: proposer | status: MERGED at
  5ded656 (spur f769929) on the v3 advance rung after four chunks - depth 9
  1.124 [1.013, 1.247], depth 10 2.52 [1.58, 4.03], depth 11 55 vs 17,
  depth 8 flat, throughput 0.994; the anchor's own clauses read inert (92%
  of holds expire), so the 32-step deferral of post-fault requests carries
  most of the effect - see post-fault-request-deferral-ablation | parent:
  client-request-placement-span-draw
- Mechanism: workload timing anchored to protocol activity. A post-fault
  request - a planned client request that becomes ready after the run's
  first executed crash (about 1.5 per run; step-0 requests are never
  touched) - is held on the treated half (bit 1 << 18) and released, one
  per firing, at the step a node's ledger shows it just consumed an acted
  fault-crossing entry and answered with a full fan-out none of which has
  landed: the census's ghost-built round read live. The request is invoked
  the following step, inside the window between the fan-out and its first
  delivery; expiry at ready + 32 steps. A held request is a plan event that
  has no record yet, so nothing in flight is delayed - the same kind of
  choice the plan's own post-fault edge makes today.
- Why: depth 10 needs w2 issued after the ghost DoViewChange landed (in the
  violating run, the very next step) and depth 11 needs it to commit in the
  old view inside that window; today all requests are invoked the step they
  become ready, so whether one is pending at depth 9 is chance, and P(10|9)
  reads about 0.04. Judge caveats: on the chain shape the first firing is
  the depth-8 fan-out, so the depth-10 gain lives in second-or-later
  releases; "by construction" and "no draw consumed" struck (the client
  op's priority is drawn at invocation).
- Frozen prediction (epoch 14): bit 262144 (1 << 18, clientFanoutRelease),
  treated share about 0.485; firing per chunk: client_anchor.held >=
  400,000, fanout_windows >= 100,000 on both halves, released.anchor >=
  40,000, released.anchor.second_or_later >= 10,000, with released split by
  firing ordinal and request kind and a histogram of held count at the
  first firing; primary depth>=10 per-run treated/control in [1.3, 3.5]
  read at four chunks - pass if the lower edge clears 1.0 with the point
  >= 1.3, extend to eight chunks if the interval straddles 1.3 with the
  point in [1.0, 1.3); depth>=8 in [0.95, 1.05]; depth>=9 in [0.95, 1.10];
  independent observable: treated share of post-fault invocations inside a
  ghost-consumer fan-out window >= 0.30 against control <= 0.05, and the
  census's P3_issued_after > 0 among treated depth>=9 runs on a kept
  explore; falsifier: with the firing floors met and the in-window share
  >= 4x control, the depth>=10 interval's upper edge below 1.3; inert if
  expiry/held > 0.8 or the in-window share < 4x; depth>=8 below 0.95 or
  depth>=9 below 0.90 refutes on the primary; plan_complete more than 3
  points below control, outstanding planned events per run treated minus
  control > 0.15, or held_at_exit > 1% of held refutes on completion;
  cost: throughput >= 0.97 of 2139.37, steps <= 1.05x, expiry share
  reported. Follow-up if the first firing eats the releases: a second-
  acted-ghost-at-the-same-node anchor.

## client-release-on-recovery-return / fault-paced-post-fault-workload / client-release-on-acted-ghost-entry

- kind: add | origin: proposer | status: HELD at iteration 31 (judge gains
  3, 3, 2): the recovery-return anchor rarely exists on the priced runs
  (the ghost sender completes recovery in 65 of 412 general fan-outs); the
  paced workload diffuses four anchors over one bit; releasing all held
  requests at the first acted ghost fires on the depth-8 SVC and lands w2
  before the DVC.

## restart-release-after-peer-settles

- kind: add | category: scheduler | origin: proposer | status: CLOSED at
  iteration 32 (refuted: depth>=8 per run 0.450 [0.436, 0.465]; the hold
  puts the ghost before the Recover, which is the opposite of label 8;
  depth>=11 and 12 about 1.8-2.2x with lower edges above 1.0, filed as a
  finding, not credited) | parent:
  recovering-receiver-reply-first-deferral (held) and the closed restart
  preemption
- Mechanism: a fault-side release rule on the RECOVER of the second fault
  pair, keyed on a peer's recovery progress. Per node a RestartState: open,
  opening peers (the distinct remote destinations of the RecoverInit
  segment's sends), replied peers (opening peers from which a delivery-
  triggered entry ACTED since the restart), settled when a majority of the
  opening peers have replied and acted (or there were none); cleared at
  crash. On the treated half (bit 1 << 30, restartAfterPeerSettle; probes
  exempt), a plan-released Recover(v) is withheld through a recover mask
  (sibling of the crash hold mask) while some live peer q has an open,
  unsettled RestartState AND v's dead incarnation still has an undelivered
  remote record to q (a side map keyed (origin, dest, incarnation) kept in
  the two in-flight hooks). The hold ends at the first of: q settles; that
  count reaches zero; 96 steps. No record is masked; the restart is what
  waits. Deadlock-free: records from a crashed node stay in the queue, so
  q's wait on v's reply resolves without v's restart; acted-only replies
  cannot be satisfied by dropping.
- Why: fresh-first made the restarted node's request always beat its dead
  incarnation's reply to node 1 (treated overtaken 1,324,046 of 1,324,046
  ghost entries), so node 1 completes recovery on the wrong message order
  and drops what follows; the census's P4_2 (the recovered node's request
  answered in the old round) reads 5/3,720 on general depth-8 runs. Judge
  corrections: settled is necessary, not sufficient, for the spec's
  recovery-complete line; the hold does not order SVC/DVC against node 1's
  replies, so depth 9 is reported, not gated; a release race on depth 8
  (a ghost of v to q dispatched between the release and the Recover's
  dispatch) widens the primary band.
- Frozen prediction (epoch 14): bit 1073741824 (1 << 30); treated share
  about 0.485; firing per chunk: restart_settle.held >= 30,000 treated,
  restart_settle.eligible within 5% on both halves, released.peer_settled
  / held >= 0.30, released.expired / held <= 0.50, held_at_exit / held <=
  0.01, held steps per held in [4, 60]; primary depth>=8 per run in
  [0.92, 1.06]; the race counter released.ghost_dispatched_before_recover
  reported (expected <= 0.35 of released); depth>=9 in [0.97, 1.15]
  reported; the advance read: depth>=11 events on the treated half >= 2.0x
  control pooled over four chunks with at least 24 treated events (baseline
  13 and 11 per chunk), depth>=10 reported; depth>=6 in [0.98, 1.03];
  observables: settled_receiver.fresh_request_acted share treated >= 1.20x
  control; ghost_entry_receiver.settled share treated >= 1.15x control;
  census P4_2 among treated depth>=8 runs >= 3x control's on a kept
  explore; completion: plan_complete within 3 points, crashes and recovers
  per run within 1%; steps <= 1.05x; cost: throughput >= 0.97 of the
  current cache (2132.3), wall per step equal within 1%. Verdict map:
  observables met and depth>=11 up with depth>=8 >= 0.95 -> merge on the
  advance rung or file (operator call, small counts); depth>=8 in [0.92,
  0.95) -> file with the race counter; depth>=11 flat -> file; observables
  missed -> close and retire the restart-timing branch.

## crash-arm-skips-reply-to-recovering-peer

- kind: add | category: scheduler | origin: proposer | status: CLOSED at iteration 35 (direction review: kept two stretches without a build; the receiver-recovering class is now understood as an arrival gap, and a reply-side rewrite in that class has no new argument; reopen only if a proposer re-argues it) | previously KEPT at
  iteration 32 (judge gain 5, cost 0) for the following session with a
  required rewrite: the skip must key on a FRESH-incarnation waking
  delivery (as written it also fires on the ghost fan-out itself), proven
  by a both-halves ghost_woken_not_skipped counter. Bit 1 << 12.

## crash-arm-peer-settled-release

- kind: add | category: scheduler | origin: proposer | status: HELD at
  iteration 32 (judge gain 2): its release provision lands exactly on the
  answer segment, confounding the predicted null with the sibling's chain-
  killer. Bit 1 << 17 if ever built.

## post-fault-request-deferral-ablation

- kind: ablate | category: scheduler | origin: operator-agent | status:
  DECIDED at iteration 33 - the window is ornament, simplify to the
  deferral (depth>=10 deferral-only over anchored 1.28 [0.85, 1.93], lower
  edge above the map's 0.70; deferral-only over control 2.95 [2.02, 4.29]
  passes the merged rule's own criterion; anchored over control 2.30
  replicates iteration 31) | previously ADMITTED at iteration 33 (judge gain 6, cost 0; rewritten - the
  containment band [0.70, 1.10] is unattainable at four chunks, so the
  decisive read is the deferral-only quarter against the bit-18-clear
  control on depth 10 under the merged rule's own criterion, with the
  quarter-versus-quarter interval reported and extendable to eight chunks)
  | parent: client-release-into-ghost-consumer-fanout-window (merged)
- Frozen prediction (rewritten): bit 134217728 (1 << 27, clientDeferralOnly),
  set only when bit 18 is set, own salt (about 0.24 of runs per quarter);
  expiry 32 and dry-queue release identical on both quarters; windows
  evaluated and counted on all runs. Firing per chunk: deferral quarter
  held >= 350,000, released.anchor == 0, (expiry + dry_queue)/held >=
  0.99, hold steps per released in [32, 34]; anchored quarter anchor/held
  in [0.06, 0.10], expiry/held in [0.88, 0.94]; fanout_windows per run
  per quarter within 5%; held_at_exit <= 1% on both. Grader primary
  (declared bit 27, depth>=8): band [-0.05, +0.05], null expected;
  depth>=9 in [0.90, 1.10] reported; depth>=10 deferral-only/anchored per
  run reported with its interval. Verdict map at four chunks: hi < 1.0
  with point <= 0.55 -> the window matters, keep the merged rule and build
  the second-acted-ghost anchor; lo >= 0.70 -> the window is ornament,
  simplify to the deferral; otherwise extend to eight chunks (then the same
  map; still straddling -> file as "window adds at most about a third" and
  simplify on cost grounds). Sufficiency read from the cells in the
  grader's matched scope: deferral-only quarter vs bit-18-clear control at
  depth>=10 must pass the merged rule's criterion (lower edge > 1.0, point
  >= 1.3); anchored quarter vs control expected about 2.5 as a replication;
  failing both refutes the merged result itself (escalate). Refuters:
  bit-27 depth>=8 outside [0.95, 1.05]; plan_complete between quarters
  more than 3 points apart; held_at_exit > 1%; steps between quarters >
  1.02x. Cost: throughput >= 0.97, steps <= 1.05x. Not to be combined with
  a deferral-length arm (it would cut the cells and break the co-bit
  matching); the length is a later whole-half contrast.
- Mechanism: within the merged mechanism's treated half, a nested salted
  half (a free bit) disables the window release and keeps only the
  expiry: every post-fault request is invoked at ready + 32 steps (or at
  a dry queue). The other quarter keeps the merged rule. Nothing else
  changes.
- Why: the merged candidate's anchor released 7.8% of held requests and
  92% expired, yet depth 9 rose 12% and depth 10 2.5x. If the deferral-only
  quarter matches the anchored quarter on depth 9 and 10, the window is
  ornament and the merged rule should be simplified to a plain deferral
  (and its length becomes the next question); if the anchored quarter is
  higher, the window earns its place.
- Frozen prediction: nested contrast deferral-only against anchored within
  the treated half; depth>=10 per run in [0.70, 1.10] (null expected -
  the deferral is the mechanism); depth>=9 in [0.90, 1.10]; depth>=8 null;
  firing: the deferral quarter's expired/held >= 0.99 and the anchored
  quarter's anchor share about 0.08; falsifier: the deferral quarter's
  depth>=10 interval entirely below 0.70 (the window matters) or above
  1.30 (the window hurts); cost and steps clauses as the parent's;
  four chunks.

## reply-first-at-unsettled-restarted-receiver

- kind: add | category: scheduler | origin: proposer | status: FILED at iteration 34 (nothing separated: depth>=8 1.032 [0.985, 1.080], depth>=11 1.38 [0.87, 2.20] on 43 vs 31 against a merge claim of 2.0; not refuted; swaps_over_fresh under-fired at 11,200 per chunk against 20,000 and the fresh-first overtaken share barely moved, 0.9989 - the ghost reply and the fresh request are rarely eligible in the same step, so the loss is arrival timing, not a tie-break) | previously ADMITTED at iteration 34 (judge gain 7, cost 0) | parent: recovering-receiver-reply-first-deferral (held; this is its no-hold, same-step form and supersedes it)
- Mechanism: Two online signals and one same-step preference, no hold, no config field. Signal 1, per record: 'reply to the destination's current incarnation'. SendLedger gains trigger_origin: Option<(node, incarnation)>, written in State::note_handler_entry (scheduler.rs:1356 passes record_origin and r.origin_incarnation) and cleared at timer entries and at recover. In State::push_runnable (state.rs:910) a remote Record or ChannelSend gets reply_to_current = (ledger[origin].trigger_origin == Some((dest, incarnation(dest)))), stored on the runnable (excluded from Hash like origin_incarnation and send_ordinal). Signal 2, per node: a RestartState {opening: u64 bitmask of the distinct remote destinations of sends issued while trigger == None and incarnation > 0 (the RecoverInit segment, before any entry), replied: u64 bitmask of opening peers from which a reply_to_current entry was taken and wrote state (the post-exec token compare at scheduler.rs:1371-1378), settled = opening == 0 or popcount(replied & opening) * 2 > popcount(opening)}; cleared at crash_node, opened at recover_crashed_node. Preference, on the treated half (fresh salt, probes exempt): in the Network branch after pair_order_dispatch (scheduler.rs:1018), if the pick's destination D has incarnation > 0 and is unsettled, and the pick is not a reply_to_current, and an eligible record to D with reply_to_current exists, take that reply instead (highest priority, lowest index among equals). This deliberately overrides fresh_first_dispatch for one class: a dead incarnation's reply to D (the reply node 2 sent before it crashed) is taken ahead of node 2's fresh opening request to D while D is still recovering. Nothing is masked or held; a displaced record stays eligible and is taken whenever no reply to D is eligible. The fresh_first heard-table update at scheduler.rs:1239 moves out of the util_stats gate. Census on all runs, both halves, ledger reads only: message entries from a dead incarnation into a restarted receiver split by settled/unsettled at entry, and reply entries at restarted receivers split the same way.
- Rationale: The census's R3->R4 losses on general depth-8 runs are 29 of 57 'receiver_recovering' (node 1 still in RecoverInit when node 2's reactions land) and iteration 30 recorded that most depth-8 runs that fail depth 9 fail it because node 1 is still recovering when both ghosts land. VR.spur drops StartViewChange, DoViewChange and Recovery while status == 2 (lines 301, 385, 403). Node 1 leaves status 2 only after RecoveryResponses from a majority including the primary, and those responses are replies to its opening sends: RR 0->1 (fresh) and RR 2->1 (sent by node 2 before it crashed, so a ghost). The merged fresh-first swap puts node 2's fresh Recovery request ahead of that ghost RR at node 1 (treated overtaken 1,324,046 of 1,324,046), so node 1 takes the request while recovering and drops it, and P4_2 (the request answered in the old view: 11/11 violating corpus runs, 0/875 general) cannot happen. The tournament's priority draw is a coin between the replies and the ghosts/request when all are eligible; this swap fixes the coin the way fresh-first fixed the ghost/fresh coin at depth 8. The chain's depth-7/8 order (Recovery 2->1 before ghost SVC 2->1 at node 1) is untouched: both are non-replies and keep their fresh-first order; RR 2->1 is not a chain label at all. So depth 8 is expected flat and the gain lands at depth 9 (ghosts land on a settled node 1 that acts on them), depth 10 (w2 after an acted DVC, which the merged deferral already times) and depth 11 (node 2 recovers into the old view because node 1 answered it, so an old-view PrepareOK 2->0 exists). Iteration 32's hold on the Recover inverted the depth-8 order and cost 55%; this reorders records to the recovering node only and never the Recover, and never puts a ghost before the fresh request.
- Generality: Stated without protocol names: a node that has come back from a crash and sent an opening round of messages takes the answers to that round ahead of other traffic until a majority of the peers it asked have answered. 'Reply' is read off the ledger (the sender's segment was woken by a message from the destination's current incarnation), 'opening' off the restart segment's sends, 'settled' off a majority count; no handler, message or role is named. On a protocol whose restart sends nothing (Raft.spur and Paxos.spur re-read persisted state) opening is empty, settled is immediate, and the swap never fires, so the panel members are untouched by construction and the counters will show it; on any protocol with a request/response recovery round it orders the round's completion before the recovering node is asked to do anything else, which is the ordering every such protocol's correctness argument assumes.
- Frozen prediction (rewritten by the judge at admission): bit replyFirstRecovering = 1 << 22 (4194304), own salt, run-cap and timer probes exempt, treated share by run id about 0.485. Rung and band: depth>=8 (epoch 14 primary) per-run treated/untreated, probe-free, co-bit matched, in [0.96, 1.08]: null expected; the swap does not touch the Recovery-before-ghost-SVC order the label encodes Advance rungs: MERGE CLAIM: depth>=11 treated events >= 2.0x control pooled over four chunks with at least 40 treated events (current cache 22, 19, 19, 26 per chunk across both halves; iteration 32's hold read 1.79 [1.02, 3.14] here from a mechanism that also halved depth 8, so the bar is above it): depth 11 is the first rung requiring rr_1_to_2, the response that exists only if node 1 answered node 2's Recovery. depth>=10 reported, expected [1.00, 1.40]; depth>=9 reported, expected [0.95, 1.15] - the label is the Enter order of the ghost SVC/DVC pair, which this swap does not order; depth>=12 reported. Firing: reply_first.swaps >= 100,000 per chunk (about 300 s, 600,000 runs); reply_first.contests within 5% of swaps; reply_first.swaps_over_fresh (a fresh-first pick displaced by a ghost reply) >= 20,000 per chunk; reply_first.contests_skipped_settled reported; reply_first.census.{treated,control}.ghost_entries_settled/_unsettled and reply_entries_settled/_unsettled on all runs; restart_state.opened per run within 1% across halves; reply_first.stale_flag (destination restarted again after the reply was sent) reported as a share of swaps Independent observable: share of dead-incarnation entries at restarted receivers landing after settle: treated >= 1.25x control; fresh_first.census.treated.overtaken / ghost_entries_from_restarted_origin in the candidate session < 0.99 (1.000 on every baseline chunk); census P4_2 on a kept explore among treated depth>=8 runs >= 3x control's Falsifier: depth>=11 pooled treated/control interval entirely below 1.30 with reply_first.swaps_over_fresh >= 20,000 per chunk; or settled-share ratio below 1.10 and overtaken share still 1.000 (inert); or depth>=8 interval entirely below 0.95; or plan_complete more than 2 points below control (baseline share about 0.23 on the cached tree) or steps per run above 1.03x Cost: cross-binary runs per explore-second >= 0.97 of the paired baseline cache; wall per step equal within 1% across halves (the scan runs only at steps whose pick targets an unsettled restarted node)
- Judge: The swap only fires when a reply_to_current record to the recovering node is eligible at the step; it cannot create the second reply (RR 0->1) if node 0 has not yet processed the request, and after RR 2->1 lands the next pick is the fresh Recovery again, dropped as before. So conversion to an answered recovery is bounded by how often both replies are in flight together, a share nobody has measured. The merge claim as written sits on depth>=9, but the epoch-14 depth-9 label is the Enter order of the ghost SVC/DVC pair (oracle-v2 plan table; a dropped delivery still matches, see the plan's run-3 walkthrough), which this swap never touches, so the predicted depth-9 gain is the same conflation of label order with acting that iteration 32's lesson named. The reply flag is a proxy (any send from a segment woken by the destination's current incarnation), so a DoViewChange woken by a fresh SVC c Notes: (b) 'settled' is computable online: opening from the ledger (trigger == None after recover, incarnation > 0) at push time; replied from the reply_to_current flag plus a state-token compare at entry. It is NOT iteration 32's definition: that counted any delivery-triggered acted entry from an opening peer; this counts only reply_to_current acted entries. More importantly the predicate's role differs - in iteration 32 it was the release condition of a hold (fired in 2.7% of holds because it comes late), here it only switches the preference off, and with n=3 the majority of two opening peers is both, so settled coincides with 'no reply left' and the gate is nearly redundant; count reply_first.contests_skipped_settled to see if it ever matters. (c) The reply and the ghost SVC are different records to the same destination: RR 2->1 comes from node 2's Recovery-handler segment woken by node 1's current incarnation (reply_to_current); SVC 2->1 comes from a timer segment or from an SVC-handler segment woken by node 1's dead incarnation (trigger_origin != current), so it is never preferred. Iteration 32 inverted depth 7/8 by withholding node 2's Recover so the ghosts drained before the fresh 

## ghost-follow-through-at-settled-receiver

- kind: add | category: scheduler | origin: proposer | status: KEPT at iteration 34 (judge gain 4, cost 0, rank 2) (bit 17 earmarked here is now taken by crashQuietPhase, iteration 38; a build would use bit 12) | parent: iteration-34 feedback round
- Mechanism: A cross-destination same-step preference keyed on two online signals the explorer already keeps or that the sibling hypothesis adds: fresh_first.heard_from(D, O, current) (the receiver has taken a message from O's current incarnation) and the RestartState settled predicate of the sibling (a majority of D's opening peers have answered), plus the record's origin_incarnation != incarnation(O) (a ghost). On the treated half (own salt, probes exempt), in the Network branch after the same-pair swaps (scheduler.rs:1018): when the eligible set holds a ghost record (O, k) -> D such that D has incarnation > 0, D is settled, and D has heard O's current incarnation, and the tournament's pick is any other record, replace the pick with that ghost (the lowest send ordinal among eligible ghosts of the same class, so pair order is preserved), regardless of the pick's destination. At most one such pull per network step; the displaced pick stays eligible. Nothing is masked; the rule only decides which eligible record runs at this step. Counters: ghost_follow.pulls, ghost_follow.eligible_steps (steps with a qualifying ghost in the eligible set), ghost_follow.pull_hist by the number of steps the ghost waited since its receiver settled and heard the origin, and a both-halves census at message entry: dead-incarnation entries at settled receivers that had heard the origin's current incarnation, and the network-step gap from that settle-and-heard moment to the entry.
- Rationale: The second failure class at the R3->R4 transition is 'none delivered to node 1 (reaction went to node 0 only, or run ended)': 24 of 57 on general depth-8 runs. Once node 1 has recovered and taken node 2's fresh Recovery request, the ghosts SVC 2->1 and DVC 2->1 are the records the chain needs next (depths 8 and 9), but they compete in the tournament with everything else in the network queue on a priority coin drawn at send time, and a general run churns through a median 16-22 views in the meantime, so the ghost lands on a round node 1 has already left (stale_view is 54-62% of the R2 failures) or never lands before the cap. Fresh-first fixes only the same-pair order; this rule pulls the ghost forward against records to other destinations, and only in the state where the same-pair order has already been decided (the fresh incarnation was heard), so it can never invert depth 7/8. It cannot fire at a never-crashed node, which is exactly right for the chain: node 0 must not take node 2's ghost SVC or node 1's reaction SVC until the old-view commit (depth 11), and node 0 has incarnation 0. In the violating corpus run the DVC lands the step after the SVC; the merged client deferral (32 steps) makes w2 land after the DVC only if the DVC lands soon, so a faster 8->9 raises P(10|9) as well.
- Generality: Rule without protocol names: a node that has restarted, finished its recovery round and already heard a peer's current incarnation consumes that peer's dead-incarnation messages next, in the order they were sent. It reads incarnations, the heard table, the settled count and send ordinals; it names no handler or timer. The class it accelerates is the one the goal file calls the stale-incarnation hazard, delivered into the receiver state where such a message is most likely to be acted on (the acceptance-distance census: sender-restarted deliveries act at 0.142 at one to two entries since the receiver's restart). On protocols without a recovery round the settled predicate is immediate and the rule still applies to any restarted receiver that heard the peer's fresh traffic, which is the raft-stale-vote member's shape (a stale vote landing at a restarted node), so the panel guard is the read that says whether it generalizes.
- Frozen prediction (rewritten by the judge at admission): bit ghostFollowThrough = 1 << 17 (131072), own salt, run-cap and timer probes exempt, treated share by run id about 0.485. Rung and band: depth>=8 per-run treated/untreated, probe-free, co-bit matched, in [1.00, 1.12]: a small gain from ghost SVC 2->1 landing before the run ends, no inversion possible because the pull requires the fresh incarnation already heard Advance rungs: depth>=9 in [1.10, 1.45] (the merge claim; label is the Enter order of the ghost pair, so this rung is the right one for a pull); depth>=10 at least the depth>=9 ratio, expected [1.15, 1.80]; depth>=11 reported (expected flat unless the reply-first swap is also in the tree) Firing: ghost_follow.pulls >= 50,000 per chunk; ghost_follow.eligible_steps >= 60,000; pulls/eligible_steps >= 0.6; pulls split by the pair-order bit 15 and by whether the displaced pick was to the same destination; ghost_follow.census.{treated,control} entries and gap histogram on all runs; the settled predicate declared before the session: RestartState.settled if reply-first is built first, else entries_since_restart(D) >= 2, named in the plan Independent observable: median settle-and-heard-to-entry gap treated <= 0.5x control; dead-incarnation entries at settled heard-fresh receivers per run treated >= 1.15x control Falsifier: depth>=9 interval entirely below 1.10 with pulls >= 50,000 per chunk; or gap ratio above 0.7; or depth>=8 below 0.95; or steps per run above 1.03x; or plan_complete more than 2 points below control Cost: cross-binary runs per explore-second >= 0.97 of the paired baseline; wall per step equal within 1% across halves (one scan of eligible records per network step only while some restarted node is settled and has heard a restarted peer, a per-run flag)
- Judge: The class it targets ('none delivered to node 1', 24 of 57) mixes two cases the census does not split: the reaction was never sent to node 1 because node 2's crash truncated the fan-out (partial_fanout_crash_bias 0.5 makes that common) - no record exists and nothing can be pulled - and the record existed but the run capped. Only the second is reachable. The acceptance-distance figure it leans on (0.142 at one to two entries) is not what the current cache reads: sender-restarted acted fractions rise monotonically with distance (0.082, 0.121, 0.136, 0.146, 0.156, 0.156, 0.182 at bucket 6+), so 'delivered where it is most likely to act' is unsupported now, and the pull at settled-and-heard is at >= 3 entries anyway. On its own it also does nothing for the substance: if node 1 dropped the Recovery while recovering, pulling the ghost SVC forward puts node 1 into view change without ever answe Notes: (d) Not a hold in disguise: the displaced pick stays eligible at full priority and is re-drawn next step; at most one pull per network step and each qualifying ghost is consumed on delivery, so the total displacement in a run is bounded by the number of qualifying ghosts (4-8) and no record waits on a condition. It is, however, a cross-destination preference, so its residue is a one-step delay to an arbitrary record per pull; report the destination class of displaced picks. Build order matters for the substance: after the reply-first swap, the pull lands the ghost pair on a node 1 that has already answered; before it, the pull only speeds up label-9 hits of P4_2-dead runs. The frozen prediction must state the settled predicate actually built (RestartState from the sibling, or entries_since_restart >= 2 if built first) and report pulls split by the pair-order bit 15, since the order component overlaps the merged rule on the bit-15-clear half.

## learned-class-odds-at-restarted-receiver-contests

- kind: add | category: scheduler | origin: proposer | status: KEPT at iteration 34 (judge gain 2, cost 0, rank 3) | parent: iteration-34 feedback round
- Mechanism: The feedback form of the two fixed swaps above: instead of hard-coding reply-first while unsettled and ghost-next once settled, learn which class to take from unsteered probe runs and apply the learned order on steered runs. Every remote record carries a class from the online signals: REPLY (reply_to_current), OPENING (sent from a restart segment of a restarted origin, i.e. the origin's incarnation > 0 and the sender ledger's trigger was None at the send), GHOST (origin_incarnation != incarnation(origin)), OTHER. A contest is a network step whose eligible set holds records to one destination D with incarnation > 0 of at least two classes, after fresh_first_dispatch and pair_order_dispatch have run. Cell = (D settled?, D heard the pick's origin's current incarnation?, bitmask of classes present) - 2 x 2 x 15 = 60 cells, each with four class arms. Learning: on timer-context probe runs (run_id phase 16 of 32, TIMER_STEER_OFF, which take the stock pick), each contest records (cell, class taken, acted), acted being the existing post-exec token compare. Steering: on the treated half of steered runs (own salt), at a contest whose cell has >= 200 samples on every present arm, the pick is replaced by the highest-priority eligible record of the class with the highest learned acted rate in that cell when that rate exceeds the pick's class rate by more than the 200-sample binomial standard error; otherwise the pick stands. Cells below the floor leave the pick. Counters: class_odds.contests, .steered, .cells_engaged, per-cell acted rates in the utilization dump, and the same both-halves entry census as reply-first (settled/unsettled ghost and reply entries).
- Rationale: The one learned mechanism the loop merged (timer context, +30% per run on depth 6, and the only merge whose per-run gain showed on both panel members) learned acted odds per structural context from unsteered probes and biased a roll. This applies the same pattern at the site the last three merges worked on. It should recover the fixed rules where they are right: at an unsettled receiver a reply acts (the recovery handler writes the response tally) while a ghost StartViewChange or a fresh Recovery request is dropped (VR.spur status == 2 guards at lines 301, 385, 403), so the learner reads REPLY >> GHOST, OPENING there; at a settled receiver that heard the fresh incarnation, GHOST acts (the view-change tally) and the learner prefers it. Where the fixed rules are wrong for a protocol the learner reads something else, which is the portfolio argument the goal file asks for. It is dominated by the fixed swaps on VR if those are right and pays only through generality and through cells the fixed rules do not cover (ghosts from two origins at one receiver, replies from two peers); acted is a proxy iterations 9 and 10 showed is not the bottleneck for stale deliveries in general, so the claim here is narrower: at a restarted receiver, acted separates the record the node can use from the one it drops.
- Generality: The cell features are incarnation structure only (restarted, settled, heard the sender's current incarnation, which incarnation classes are present) and the reward is the existing state-token compare; nothing names a handler, message or role. The learner is per session and per protocol, so each panel member learns its own order; a member whose restarted nodes never face a multi-class contest has no engaged cells and takes the stock pick, so it is untouched.
- Frozen prediction (rewritten by the judge at admission): bit classOddsSteer = 1 << 12 (4096) as proposed, or 1 << 28 if the kept crash-arm-skips entry is built first; own salt, run-cap and timer probes exempt (probes feed the learner and take the stock pick), treated share by run id about 0.485. Rung and band: depth>=8 per-run treated/untreated, probe-free, co-bit matched, in [0.95, 1.08]: null expected, the same-origin fresh/ghost order stays with fresh-first Advance rungs: depth>=9 reported in [0.95, 1.20]; depth>=11 treated events reported against control pooled over four chunks (the rung the reply class reaches, as for the fixed swap); depth>=10 reported Firing: class_odds.probe_contests >= 8,000 per chunk (all probe runs) and class_odds.contests >= 150,000 per chunk on the treated half; class_odds.cells_engaged >= 6 by the end of chunk 1 and >= 15 by the end of chunk 4; class_odds.steered >= 20,000 per chunk from chunk 2; per-cell arm counts and acted rates in the utilization dump Independent observable: in engaged unsettled cells REPLY's acted rate >= 2x GHOST's and OPENING's; in engaged settled-and-heard cells GHOST >= 1.5x OTHER; entry census settled-share treated >= 1.20x control from chunk 2 Falsifier: depth>=11 pooled ratio below 1.30 and depth>=9 interval entirely below 1.05 with steered >= 20,000 per chunk from chunk 2 and >= 6 cells engaged; or REPLY below 1.5x GHOST in engaged unsettled cells (no learnable signal); or probe_contests below 8,000 per chunk (the learner cannot engage; close as starved, not refuted); or depth>=8 below 0.95; or steps per run above 1.03x Cost: cross-binary runs per explore-second >= 0.96 of the paired baseline (the contest scan runs only when the pick's destination is a restarted node; the learner writes are atomics on probe runs)
- Judge: It rides the same dispatch site and needs the flags of the two fixed swaps, and by its own account is dominated by them on VR; the dedupe rule caps it. The learner is starved: timer-context probes are one run in 32 (timer_context.rs PROBE_PHASE 16 of run_cap::PROBE_PERIOD 32), about 19,000 runs per 600,000-run chunk; at the candidate's own floor of 150,000 treated contests per chunk that is about 10,000 probe contests per chunk spread over 60 cells, each needing every present arm at 200 samples (a two-arm cell needs 400) - at most 25 arm-floors per chunk even if perfectly spread, so 'cells_engaged >= 20 by the end of chunk 1' is arithmetically out of reach and the falsifier's floors would not be met in a four-chunk grade, leaving the read inconclusive by construction. On probes the stock pick without fresh-first or pair-order is the priority coin, so minority classes in a cell (a reply a Notes: (f) Probe share is 1/32 of runs; the learner's sample supply is the probe share times the contest rate, which the candidate must measure (class_odds.probe_contests) before any engagement claim. Worth building only after a fixed swap merges, as the mechanism for the residual multi-class contests, and then with a probe-contest floor read from the first chunk. Bit collision: 12 is earmarked for the kept crash-arm entry; take 28 if built.

## deep-signal-plan-only-corpus-tier

- kind: add | category: feedback | origin: proposer | status: REJECTED at iteration 34 (judge score 0: already answered) | parent: replay-corpus (iteration 27)
- Reason: Already answered, and on a false premise. The candidate rests on 'its own read named the cause as the cut, not the signal', but iteration 27's session record splits its slots by the prefix bit: tier-2 PLAN-ONLY children (bit 13 set, bit 21 clear - no cut, fresh schedule from step 0, exactly the serving proposed here) read depth 8 per run 0.00985 against tier-1 plan-only 0.01561 (0.63x), depth 9 0.60x, depth 6 0.61x, over 120,589 runs in research/lite/state/replay-tier-answered-overtake-cut/chunk-100{0,1}.cand.json (tier-2 prefix children read 0.71x, so the cut was not the main loss). Plan re-sampling on a deeper incarnation-ordered signal (heard-and-replied ghost entry) has been measured without a cut and lost to tier 1 by a third; the S2 refinement (settled, acted) narrows the same family and offers no reason its plans would re-sample better. Also confounded as designed: control slots serve tier 1 half-prefix (1.12x plan-only), so the slot contrast is biased against the treatment. Supply and the plan-only channel (campaign.rs:393 GridRun::Child prefix=false) are real; the premise is not.

## post-fault-deferral-length-contrast

- kind: dose | category: scheduler | origin: operator-agent | status:
  MERGE DECIDED at iteration 36 (eight chunks pooled over two sessions:
  depth>=10 long/short 1.281 [1.019, 1.609] z 2.93, the merge claim met;
  depth>=8 0.980 [0.945, 1.017]; the second session alone separated up on
  depth>=10 at z 3.0 on the rule; the merged rule becomes a 64-step deferral
  on the whole treated half) | previously ADMITTED at iteration 36 (judge gain 6, cost 0, rank 2 of the iteration-35
  round; prediction rewritten: eight-chunk extension, an overshoot sends the
  next dose to 16, held_at_exit clause 0.1%) | parent:
  post-fault-request-deferral-ablation (decided: simplify) and
  client-release-into-ghost-consumer-fanout-window (merged)
- Mechanism: the merged deferral holds post-fault client requests for 32
  steps. On a salted half of the bit-18 treated runs (bit 1 << 28,
  clientDeferralLong, own salt, probes exempt) the expiry is 64 steps
  instead of 32; nothing else changes, the dry-queue release stays. A
  second session can later try 16 under the same bit if 64 loses.
- Why: iteration 33 showed the delay is the whole depth-10 lever and its
  length has never been varied. Depth 10 asks for the second write to land
  after the recovered node's ghost DoViewChange has acted at the new
  primary; the census puts that entry a few dozen steps after the second
  recover in most runs, so 32 may be short of it in a fraction of runs
  and 64 would cover them, at the cost of pushing requests past the end
  of the plan in short runs (held_at_exit rises).
- Frozen prediction (draft; the judge rewrites at admission): bit
  268435456 (1 << 28) set only when bit 18 is set, own salt, about 0.24 of
  all runs per quarter. Grader primary (declared bit 28, depth>=8) band
  [-0.06, +0.06], null expected. Merge claim on the advance rungs: depth>=10
  long/short per run >= 1.25 with the lower edge above 1.0 over four chunks
  (the 32-step quarter reads about 0.00026 per run, 120 events per four
  chunks per quarter); depth>=9 in [0.95, 1.15] reported. Firing: long
  quarter hold steps per released in [63, 66], held_at_exit/held <= 3%
  (the short quarter reads 0.008%); refuter: plan_complete more than 3
  points below the short quarter, or depth>=10 long/short interval
  entirely below 0.90. Cost: throughput >= 0.97, steps <= 1.05x.

## crash-phase-on-landing-node

- kind: add | category: scheduler | origin: proposer | status: MERGE DECIDED at iteration 35 (two four-chunk sessions pooled: matched depth>=8 1.072 [1.011, 1.138] z 3.18 on 7,293 vs 6,789 events, inside the band [1.04, 1.20], replicated 1.073 and 1.071; depth>=9 unresolved (1.13 then 1.00); merged as the plain rule - the phase is read on the landing node on every anchored retarget run, no quartering) | previously ADMITTED at iteration 35 (judge gain 7, cost 0; top pick) | parent: iteration-35 ablation-and-salvage round
- Mechanism: In spur/spur-core/src/simulator/core/scheduler.rs crash_hold_mask() builds crash_phase::Fanout from the PLANNED victim n's ledger and asks state.crash_phase.hold(n, fanout, ...), while retarget_crash() at apply moves the crash to the ghost absorber d chosen by ghost_absorber::choose(). On runs with both crashPhase (512) and ghostAbsorberRetarget (1 << 19) set, a salted half (nested bit, own salt, about 0.115 of all runs; probes exempt by inheritance) computes d = choose(n, ledgers, servers, is_live, has_pending_pair) at each hold step once the step hold has expired and evaluates the drawn arm's phase on d's ledger (segment_sends = issued - floor, undelivered = recent, in_flight), on n itself when the choice is SameVictim or NoAbsorber. The arm draw, WINDOW, reserve and the apply-time retarget are unchanged; a treated run reads the same random sequence as its twin. New counters in util_stats.rs: crash_phase.landing.{evaluated_on_other_node, condition_on_other_node, expired_on_other_node, mismatch_at_apply (landing differs from the node the phase was last read on)}, and the existing per-arm apply inflight buckets split by landing != planned on both quarters. No config field. Registration: run_variant.rs CRASH_PHASE_ON_LANDING = 1 << 23 set only when CRASH_PHASE and GHOST_ABSORBER_RETARGET are set; decide.ts row 8388608 renamed from ghostAbsorberRedraw to crashPhaseOnLanding (the redraw was closed at iteration 20 and is not in the tree: grep 'redraw' over spur-core/src/simulator returns nothing).
- Rationale: A miswire between two merged mechanisms. The retarget's pool entry says it outright: 'placement timing and the fan-out anchor's hold are evaluated on v as today; only the identity of the node that dies changes'. On the iteration-23 dump victim_swap.applied is 132,470 of 645,194 treated crashes (20.5% move) and on those the fan-out condition was met on a node that did not crash while the node that did crash was at an arbitrary point of its own fan-out. The retarget picks the node that most recently absorbed a fault-crossing delivery, acted preferred - on the chain that is node 2 right after it acted on the ghost StartViewChange, and its current segment then holds the reaction SVCs and the DoViewChange, the depth-8 and depth-9 records. The g34 side reads show both mechanisms manufacture depth-8 shape that fails 9: anchored runs convert 8->9 at 0.168 against 0.199, retarget runs at 0.178 against 0.189, and both are flat by depth 10 (0.97-1.00; 0.97-1.22). Reading the phase on the landing node puts the crash inside the absorber's reaction fan-out, which is bug.md's step 5 (the corpus plan's crash_2 right after deliver_svc_1_to_2) and is what the closed REACTION arm (iteration 17) looked for on the planned victim and found in 8% of releases: on the planned victim a fault-caused fan-out is rare inside the window, on the retarget's destination it is what the destination was chosen for. Sizing: moved-crash runs carry about 40% of the cell's depth-8 events (20% of crashes at about 2.7x the rate, from the 1.35 retarget contrast); the anchor is worth 1.30 where it reads the right node and about nothing where it reads the wrong one, so the cell gains about +12% on depth 8, and the depth-9 conversion on those runs moves toward or past the unanchored 0.199, giving depth 9 +15-30% in the cell.
- Generality: The rule composes two existing protocol-agnostic reads: the node a fault will land on (the retarget's ledger ranking) and that node's own fan-out phase (issued, undelivered, in flight). It names no handler, message or role; it removes an inconsistency - a condition evaluated on one node and applied to another - rather than adding a heuristic. On protocols where the retarget never moves a crash (no fault-crossing deliveries before the second fault) the quarter is byte for byte the merged rule and the counters show it.
- Frozen prediction (rewritten by the judge at admission): {"treatmentBit": {"name": "crashPhaseOnLanding", "value": 8388608, "shift": 23, "nestedIn": ["crashPhase (512)", "ghostAbsorberRetarget (524288)"], "reuse": "bit 23 was ghostAbsorberRedraw (closed iteration 20); no mechanism in spur-core sets it (verified by grep); the decide.ts row is renamed by the operator at admission", "salt": "own", "treatedShareOfAllRuns": 0.115, "probesExempt": "by inheritance"}, "rung": "depth>=8 (epoch 14 primary), per-run ratio treated quarter / merged quarter, probe-free, co-bit matched within crashPhase = 1 and ghostAbsorberRetarget = 1", "band": [1.04, 1.2], "advanceRungs": {"depth>=9": {"expected": [1.1, 1.45], "mergeClaim": true, "note": "carries a merge when depth 8 is flat and its band is not refuted"}, "depth>=10": {"expected": "at least the depth-9 ratio", "reported": true}}, "decisiveContrast": "treated quarter (phase read on the landing node) versus merged quarter (phase read on the planned victim) at depth>=9, with depth>=8 not below 0.97", "firing": {"counter": "crash_phase.landing.condition_on_other_node", "floorPerChunk": 8000, "unit": "counted once per armed crash: evaluated_on_other_node = armed crashes whose hold-time choice was Retarget at least once; condition_on_other_node = those released by the phase predicate on d's ledger; expired_on_other_node = those released by the window or reserve while last read on d; mismatch_at_apply = condition releases whose apply-time victim differs from the node the phase was last read on", "also": ["crash_phase.landing.evaluated_on_other_node >= 12,000 per chunk", "crash_phase.landing.expired_on_other_node / evaluated_on_other_node reported against the merged arms' 0.18", "crash_phase.landing.mismatch_at_apply <= 5% of condition releases"]}, "independentObservable": {"statement": "on crashes where landing != planned, victim_had_inflight_sends / crashes on the treated quarter >= 1.10x the merged quarter's (both quarters split the census by landing != planned); on a kept explore the census's 'ghost DVC 2->1 exists' among treated depth-8 runs >= 1.3x the merged quarter's", "expected": "moved crashes on the merged quarter land at the census control's 0.70; treated toward the anchored 0.83-0.85"}, "falsifier": "depth>=9 interval entirely below 1.05 with the floor met; or depth>=8 interval entirely below 0.97; or condition_on_other_node / evaluated_on_other_node below 0.50 (the absorber's segment is seldom in phase inside 96 steps, REACTION's reading recurring); or plan_complete more than 2 points below the merged quarter; steps per run > 1.03x; crashes or recovers per run off by more than 1%", "cost": "cross-binary throughput >= 0.97 of the paired cache (2,042 rps); choose() scans at most num_servers ledgers per waiting crash per step on the quarter only; wall per step equal within 1% across quarters", "decisionMap": "depth 9 up with depth 8 >= 0.97 -> merge as the rule for retarget runs; depth 9 flat with condition share >= 0.5 -> file with the DVC-exists census; condition share < 0.5 -> close and record that the absorber's reaction is not in phase inside 96 steps", "rewritten": true, "rewriteNote": "only the firing unit was made explicit (per armed crash, not per step); bands, floors and the decision map are the proposer's"}
- Judge: The 96-step phase wait starts at the drawn step hold's expiry, which is uniform over the completed-run span and unrelated to when the absorber consumed its ghost; d's 'current segment' at that moment is whatever handler d is in, and the EARLY/MID predicates accept ANY fan-out of d over the next 96 steps (a churning run enters 16-22 views), not the reaction to the ghost. Iteration 17 found fault-woken segments inside the window rare and single-send (8% broadcast share), so 'puts the crash inside the absorber's reaction fan-out' is optimistic; the honest form is 'crash the absorber during one of its fan-outs', which is still the retarget's thesis sharpened. The sizing assumes the anchor is worth nothing on moved crashes; even read on the wrong node it delays the crash by up to 96 steps, which may carry part of the retarget quarter's 1.34, so the headroom could be smaller than +12%. choose( Notes: Ranked first: a verified inconsistency between two merged mechanisms, a mechanism-to-observable path that names the DAG's depth-9/10 records, and checkable side reads that all reproduce. Shares the crash_phase actuator with crash-phase-arm-ablation-early-only; build this one first (or in a separate session) so the 'merged quarter' control is the merged three-arm rule and not a mixture. The decide.ts row rename is operator registration at admission, not candidate scope. Implementer must watch: (1) choose() must be called with the same is_live/has_pending_pair closures retarget_crash uses (scheduler.rs:1443-1455), else the hold-time d and the apply-time d differ systematically and mismatch_at_apply is not noise; (2) count evaluated/condition/expired once per armed crash, not per step; (3) SameVictim and NoAbsorber must fall back to n's ledger byte for byte; (4) no random draw is added, so the twin quarter reads the same stream - assert this in a test like crash_phase.rs's CountingRng tests; (5) the per-arm apply buckets must be split by landing != planned on both quarters or the independent observable cannot be read.

## crash-phase-arm-ablation-early-only

- kind: ablate | category: scheduler | origin: proposer | status: KEPT at iteration 35 (judge gain 5, cost 0, rank 3) | parent: iteration-35 ablation-and-salvage round
- Mechanism: In spur/spur-core/src/simulator/crash_phase.rs RunAnchor::draw keeps drawing one value from Stream::CrashPhase per placed crash on anchored runs (bit 512). On a salted half of the anchored runs (nested bit, own salt, about 0.23 of all runs; probes already exempt by inheritance from crashPhase) a drawn CrashPhaseArm::Mid is replaced by Early before settle() runs; the drawn arm is recorded under crash_phase.early_only.mapped_mid_to_early and the effective arm under the existing per-arm counters. The window, the reserve, the STOCK arm and every other quarter are byte for byte the merged rule, and the treated quarter reads the same random sequence as its twin. No config field. Registration: run_variant.rs gains CRASH_PHASE_EARLY_ONLY = 1 << 14 set only when CRASH_PHASE is set; research/orchestrator/src/decide.ts VARIANT_BITS row 16384 renamed from crashPhaseReaction to crashPhaseEarlyOnly (the reaction arm was closed at iteration 17 and is not in the tree: grep 'reaction' over spur-core/src/simulator returns nothing, so the bit is a registry row with no mechanism behind it).
- Rationale: The whole-mechanism question the operator asked is already answered by the g34 session's per-bit side reads on the current tree (both sides, about 1.9M runs each, randomized salted halves): crashPhase reads depth>=8 1.298 [1.266, 1.332] and 1.307 [1.275, 1.340], depth>=9 1.099 and 1.088, depth>=10 0.999 and 0.972 - load-bearing at the primary, ornament by depth 10. Anchored runs convert 8->9 at 0.168 (0.002397/0.014237) against 0.199 (0.002181/0.010966) for unanchored placed runs: the anchor manufactures depth-8 shape whose depth-9 record is missing. The chain's depth-9 record is the ghost DoViewChange, the LAST send of the absorber's reaction segment (pair-send-order: the DVC leaves the same handler right after the SVC broadcast with the next ordinal); EARLY (segment issued, nothing delivered) keeps that whole segment in flight at the crash, while MID (some delivered) admits crashes after the SVC or the DVC has already landed. The iteration-23 dump shows the arms differ at apply: EARLY lands 49.6% of its crashes with 3+ sends in flight against 40.5% for MID, MID lands 24% at exactly one against 16% for EARLY. Per-arm depth has never been read; this quarter reads it with one contrast. Arithmetic: with S the stock arm's depth-8 rate, (E+M+S)/3 = 1.30 S so E+M = 2.9 S; early-only over merged is (2E+S)/(E+M+S): 1.00 if E = M, 1.18 at E = 1.8, 1.49 at E = 2.4, 0.51 at M = 2.4. Removal outcome: a band read licenses dropping MID (the table becomes EARLY/STOCK), which is the iteration-33 shape of simplification; the mirror read licenses dropping EARLY.
- Generality: The rule reads the victim's own send ledger (issued, floor, recent, in_flight) and names no handler, message or role. 'Crash while everything the node just sent is still undelivered' is the fully-uninformed stratum of a fan-out on any protocol; deciding whether the partly-informed stratum earns its third of the anchored draws is a question about the anchor's portfolio value, and the panel members (paxos stale ballot, mencius, raft stale vote, paxos stale scout) are the read on whether the simplification costs them.
- Frozen prediction (rewritten by the judge at admission): {"treatmentBit": {"name": "crashPhaseEarlyOnly", "value": 16384, "shift": 14, "nestedIn": ["crashPhase (512)"], "reuse": "bit 14 was crashPhaseReaction (closed iteration 17); no mechanism in spur-core sets it (verified by grep); the decide.ts row is renamed by the operator at admission", "salt": "own", "treatedShareOfAllRuns": 0.23, "probesExempt": "by inheritance from crashPhase"}, "rung": "depth>=8 (epoch 14 primary), per-run ratio early-only quarter / merged quarter, probe-free, co-bit matched within crashPhase = 1", "band": [1.06, 1.35], "advanceRungs": {"depth>=9": {"expected": [1.1, 1.5], "note": "conversion 8->9 on the quarter >= 0.185 against the merged quarter's 0.168; reported, not a merge claim"}, "depth>=10": {"expected": [1.0, 1.6], "reported": true}, "early-only over unanchored placed half": {"expected": [1.35, 1.7], "reported": true}}, "decisiveContrast": "early-only quarter versus merged three-arm quarter at depth>=8: >= 1.06 with depth 9 not below 1.00 licenses dropping the MID arm; <= 0.95 says MID is load-bearing and licenses the mirror ablation; [0.95, 1.06) says the arms are equivalent and nothing is removed", "firing": {"counter": "crash_phase.early_only.mapped_mid_to_early", "floorPerChunk": 25000, "also": ["crash_phase.early.armed on the quarter about 2x the merged quarter's", "per-arm expired/armed reported (EARLY 0.184, MID 0.186 on the iteration-23 dump)"]}, "independentObservable": {"statement": "treated-quarter apply-time inflight_bucket_3plus share of anchored applies >= 1.05x the merged quarter's; P(depth>=9 | depth>=8) on the quarter >= 0.185", "expected": "0.458 against 0.428 pooled buckets (1.07x) from the iteration-23 per-arm shares; conversion 0.19-0.22 against 0.168"}, "falsifier": "depth>=8 interval entirely below 0.95 with the floor met (MID load-bearing); or steps per run > 1.03x the merged quarter; or plan_complete more than 2 points below it (about 0.23); or crashes or recovers per run off by more than 1%", "cost": "cross-binary runs per explore-second >= 0.97 of the paired cache (2,042 rps); wall per step equal within 1% across quarters", "rewritten": true}
- Judge: The anchored crash is mostly the run's FIRST (iteration 17: 223,675 draws skipped for no prior fault against 45,739 armed under the reaction rule), so the arm table shapes crash_nl, not crash_2. Depth 8 and 9 in the v2 DAG are node 2's fresh Recovery and ghost SVC landing at node 1 - records made by crash_2 stranding node 2's reactions - so an arm change on the first crash has no direct handle on the 8->9 conversion; the anchored deficit (0.168 vs 0.199) can as well come from the anchor delaying the second crash by up to 96 steps (run-timing composition) as from MID versus EARLY. The 'depth 9 at least the depth-8 ratio' claim is therefore under-argued. The pooled-bucket observable as frozen (>= 1.10x) exceeds what the proposer's own numbers predict: from the iteration-23 dump the early-only quarter pools 3plus at (2 x 0.496 + 0.383)/3 = 0.458 against the merged (0.496 + 0.405 + 0.383)/3  Notes: Well-verified numbers and a DAG-consistent story for depth 8; the depth-9 half of the argument is thin. Deduped against rank 1: same actuator, so it does not score high alongside it; admit as the following round's ablation once the landing-node read is in, or run in a session without bit 23. Rewritten: the pooled-bucket observable threshold 1.10x -> 1.05x (expected 1.07x from the dump).

## retire-stock-placement-control

- kind: ablate | category: scheduler | origin: proposer | status: KEPT at iteration 35 (judge gain 4, cost 0, rank 4) | parent: iteration-35 ablation-and-salvage round
- Mechanism: spur/spur-core/src/simulator/fault_timing.rs DEFAULT_FRACTION 0.9 -> 1.0. placed_from(1.0) clamps to phase 1 of 64, phase 0 is the run-cap probe phase and probes are exempt at every fraction, so every non-probe run draws crash holds; run-cap probes stay stock and uncapped as today and remain the sole feed of both length learners (nothing they read moves). No bit can be declared: the change removes the untreated remainder of crashPlaced (bit 1), so it is graded cross-binary only, on depth>=8 events per explore-second against the paired cache, with the crashPlaced contrast's control side expected to fall to the probe population (about 3% of runs) as the exact check that the change did what it says.
- Rationale: Iteration 7 held the placed share at 0.9 'on purpose' so that 'an ordinary stock control survives at about 8% of runs' to measure placement. That measurement is done: on the g34 session the crashPlaced contrast reads depth>=8 29.4x [23.3, 37.2] on one side and 36.0x [28.0, 46.4] on the other, over 3.8M runs, and depth>=6 35-40x. Those 8% of runs (154k-159k per session) produce 0.00046 depth-8 events per run against 0.0135 for a placed run, about 0.3% of the session's depth-8 events for 8% of its wall. Placing them yields per-run P(depth>=8) 0.969 x 0.01355 + 0.031 x 0.00046 = 0.01314 against 0.918 x 0.01355 + 0.082 x 0.00046 = 0.01247 today, +5.4% per run, less about 0.5% throughput for the 6% longer placed runs: about +5% on the objective for a one-constant change. Honest reading of the gradability: this sits at the 5% cross-binary layout floor (iteration 15), so it separates only if the build lands on the right side of layout noise; it is proposed because it is a dead knob under the lens, not because it is a strong read, and the exact independent observable (the control side of bit 1 collapsing to probes) confirms the mechanism regardless of the rung.
- Generality: The placer is protocol-agnostic (it draws a crash's step over the learned completed-run span) and its portfolio value is recorded (paxos per-run violations +35% at merge). The stock posture exists only as an instrument; removing an instrument that has finished measuring changes no heuristic and adds no knob. The quick panel (four members) is the guard that the extra 8% placed share costs no member per run.
- Frozen prediction (rewritten by the judge at admission): {"treatmentBit": {"name": null, "value": null, "reuse": "none: the change removes the untreated remainder of crashPlaced (bit 1); no internal control exists", "treatedShareOfAllRuns": null}, "rung": "depth>=8 events per explore-second, cross-binary against the paired baseline cache over four chunks - REPORTED with the 5% layout caveat, not a merge criterion", "band": [1.03, 1.08], "bandNote": "the expected read; inside the layout floor, so it cannot separate and is not gated", "primaryCheck": "the grader's crashPlaced (bit 1) contrast reports a control side of about 3% of graded runs (probes only) instead of 8%, and crash_place.draws per chunk rises about 8% over the cache (about 1,030k -> about 1,120k per 600k-run chunk); run_cap.probes and the learned cap gauge equal on both sides; crashPlaced treated per-run depth>=8 unchanged within 2% (0.0135 on both g34 sides)", "advanceRungs": {"depth>=9 and 10 per second": {"expected": "the same band; reported"}}, "decisiveContrast": "none on the rung; merge as a dead-knob removal when the primary check holds, cross-binary depth>=8 per second is not below 0.97, throughput is not below 0.97, and the quick panel is flat per run", "firing": {"counter": "crash_place.draws", "floorPerChunk": 300000}, "falsifier": "the bit-1 control side does not collapse to the probe population; or the cap gauge or draws per probe differ across sides (the learners' feed moved); or cross-binary depth>=8 per second below 0.97 over four chunks; or throughput below 0.97 of the paired cache; or any quick-panel member's per-run violation rate below its calibration band", "cost": "cross-binary throughput >= 0.97 of the paired cache (expected about 0.995)", "gradabilityCaveat": "the rung read sits at the cross-binary layout floor; the change is admitted as a dead-knob removal whose mechanism check is exact, not as a separable gain", "rewritten": true}
- Judge: The rung read is structurally unreadable: the expected +5.4% per run sits inside the 5% cross-binary build-layout floor (iteration 15), so the frozen band [1.03, 1.08] can neither be met nor refuted by the harness, and the falsifier '< 1.00 over four chunks' can fire on layout noise alone. The outcome is also close to already-answered by method: iteration 7 step 4 extrapolated the 0.484 -> 0.891 dose from the internal contrast under exactly the additivity argument used here, and the g34 contrast (29-36x) makes the last 8% a near-certainty rather than a hypothesis. What the change buys (+5%) it pays for in measurement: the 8% stock non-probe population is the only control that differs from placed runs by placement alone (probes are also uncapped), so every future placement-dependent read and every 'co-bit matched within crashPlaced' contrast loses its untreated side; that is a validity co Notes: Every checkable claim holds; the argument is arithmetic on measured quantities, which is why it grades as a plausible-but-unreadable story rather than a mechanism round. Rewritten: the mechanism check (bit-1 control side collapses to the probe population; draws per chunk up about 8%) is the primary and gates the merge; the cross-binary depth-8 per second is reported with the layout caveat and acts only as a regression guard; the panel guard stays. If built, do it as the constant change so the fault_timing.rs docstring rationale is rewritten in the same commit.

## opening-round-first-at-recovering-receiver

- kind: add | category: scheduler | origin: proposer | status: KEPT at iteration 35 (judge gain 5, cost 2, rank 5) | parent: iteration-35 ablation-and-salvage round
- Mechanism: Two online signals from the filed reply-first design and one eligibility mask, no same-step swap, no hold on any Recover. SendLedger gains trigger_origin: Option<(node, incarnation)> written in State::note_handler_entry from the record that woke the segment (scheduler.rs:1356 site) and cleared at timer entries, crash and recover; at push_runnable a remote Record gets reply_to_current = (ledger[origin].trigger_origin == Some((dest, incarnation(dest)))), stored on the runnable outside the hash like origin_incarnation. Per node a RestartState {opening: bitmask of remote destinations of sends issued while trigger == None after a recover, replied: bitmask of opening peers from which a reply_to_current entry wrote state (the post-exec token compare at scheduler.rs:1371-1378), settled = opening empty or popcount(replied & opening) * 2 > popcount(opening)}, cleared at crash_node, opened at recover_crashed_node. On the treated half (salted, run-cap and timer probes exempt) is_ineligible() in schedule_runnable marks a remote Record to D ineligible while D has incarnation > 0, an open unsettled RestartState younger than 32 steps, and the record is not reply_to_current; ChannelSends, Timers and faults are never masked; when the mask would leave the step with nothing eligible it is lifted for that step and counted (opening_hold.lifted_for_liveness). An episode opens at D's recover and closes at settle or 32 steps; after closing D is not held again until its next restart. Nothing is reordered by this rule: at release the fresh request and the dead incarnation's records are co-eligible and the merged fresh-first and pair-order preferences take them in fresh-then-send order. Counters: opening_hold.{episodes, held_offers, released.settled, released.expired, released.no_open_round, lifted_for_liveness, hold_steps_sum}; census on a salted sixteenth of runs, both halves (the iteration-29 lesson): non-reply dead-incarnation entries and fresh non-reply entries at restarted receivers split settled/unsettled at entry. Registration: run_variant.rs OPENING_ROUND_FIRST = 1 << 16; decide.ts row 65536 renamed from ghostPeerAnswer to openingRoundFirst (the destination-answer hold was closed at iteration 18 and is not in the tree; grep 'orphan' finds one comment in util_stats.rs).
- Rationale: The receiver-recovering class is the largest R3->R4 loss the census names on general depth-8 runs (29 of 57; 'none delivered' 24) and iteration 34 closed the same-step family for it: the ghost reply and the fresh request are almost never eligible in the same step, so the loss is an arrival gap, which only a hold can close. Iteration 32 held the Recover and halved depth 8 because the hold put the ghost before the Recover; this holds the records, not the restart, and holds the fresh request and the ghosts TOGETHER, so the depth-7/8 order the label encodes is untouched and merely delayed. The substance the chain lacks is P4_2 (the recovered node's request answered by a peer still in the old round: 11/11 violating corpus runs, 5/3,720 treated depth-8 general runs at iteration 26): a node in its opening round drops the request; a node that has finished it answers, and in the corpus that answer comes one step before the peer takes the ghost SVC (run 572). Depth 11's rr_1_to_2 exists only on that path, so the advance rung the read carries is 11, with 9 and 10 reported. Depth-8 cost, stated: labels 7 and 8 are Enter events at D delayed by at most 32 steps against a median run of about 2,100; the cost is runs where the delay meets the cap or D's round moves under it, expected about 3-8%, frozen at [0.92, 1.03]. The risk is the message-hold family's: the settle depends on replies that may not exist (node 1 waiting on the crashed victim's own reply in 81% of receiver-recovering failures per the iteration-25 judge) - so the settled-release share is the first thing read and a low share closes the round before any rung is credited.
- Generality: Rule without protocol names: a node that has come back from a crash and sent an opening round takes the answers to that round before it takes anything else, for a bounded number of steps. 'Reply' is read off the ledger (the sender's segment was woken by a message from the destination's current incarnation), 'opening' off the restart segment's sends, 'settled' off a majority count. On a protocol whose restart sends nothing (Raft.spur and Paxos.spur re-read persisted state) the opening set is empty, settled is immediate and the mask never fires, so the panel members are untouched by construction; on any protocol with a request-response recovery round it delivers the round's completion before the node is asked to act on anything else, which is the ordering every such protocol's recovery argument assumes.
- Frozen prediction: {"treatmentBit": {"name": "openingRoundFirst", "value": 65536, "shift": 16, "nestedIn": [], "reuse": "bit 16 was ghostPeerAnswer (closed iteration 18); no mechanism in spur-core sets it (verified); the decide.ts row is renamed by the operator at admission; 1 << 30 restartAfterPeerSettle is the alternative", "salt": "own", "treatedShareOfAllRuns": 0.47, "probesExempt": "run-cap and timer probes"}, "rung": "depth>=8 (epoch 14 primary), per-run ratio treated / untreated, probe-free, co-bit matched - frozen as a COST band, not a gain", "band": [0.92, 1.03], "expectedDepth8Cost": "about 3-8%: labels 7, 8 and 9 are Enter events at the recovering node delayed as a block by at most 32 steps against a median run of about 2,100; the loss is runs where the delay meets the cap or the node's round moves under it; a read below 0.90 refutes", "advanceRungs": {"depth>=11": {"mergeClaim": true, "expected": ">= 1.8x control pooled over four chunks with >= 40 treated events (cache 17-27 per chunk both halves)"}, "depth>=9": {"expected": [1.0, 1.2], "reported": true}, "depth>=10": {"expected": [1.05, 1.5], "reported": true}, "depth>=6 and 7": {"expected": [0.97, 1.03]}}, "decisiveContrast": "treated half versus untreated half on depth>=11 given depth>=8 >= 0.92 and released.settled / episodes >= 0.30; the settled share is read first and a share below 0.15 closes the round before any rung is credited", "firing": {"counter": "opening_hold.episodes", "floorPerChunk": 150000, "also": ["opening_hold.held_offers >= 1,000,000 per chunk", "opening_hold.released.settled / episodes >= 0.30", "opening_hold.released.expired, lifted_for_liveness, mutual reported", "opening_hold.hold_steps_sum / episodes in [4, 32]"]}, "independentObservable": {"statement": "census on a salted sixteenth of runs, both halves: non-reply dead-incarnation entries at restarted receivers landing after settle treated >= 1.5x control; fresh non-reply entries at restarted receivers landing after settle treated >= 1.5x control; on a kept explore census P4_2 among treated depth-8 runs >= 3x control's (control 5/3,720 at iteration 26)"}, "falsifier": "depth>=8 interval entirely below 0.90; or released.settled / episodes below 0.15 with episodes >= 150,000 (a blind delay: close and retire the receiver-side hold); or the settled shares below 1.2x control; or depth>=11 interval entirely below 1.2 with the settled share >= 0.30 and >= 40 treated events; or plan_complete more than 3 points below control, steps per run > 1.05x, crashes or recovers per run off by more than 1%", "cost": "cross-binary throughput >= 0.97 of the paired cache; O(1) mask test per candidate behind a per-run flag; census scan on a sixteenth of runs only; wall per step equal within 1% across halves", "rewritten": false}
- Judge: The chain has two nodes recovering at once (recover_nl and recover_2 both precede label 8), and each is a member of the other's opening round. Node 1's round settles only when node 2 replies; if node 2 has not answered before crash_2 (the iteration-25 judge's 81% class: node 1 waiting on the victim itself), node 2 cannot answer while it recovers, and node 2's own fresh Recovery 2->1 is exactly what this rule holds at node 1 - a mutual hold that can only end by the 32-step expiry. In that class the mechanism is a blind 32-step delay of everything non-reply addressed to node 1, and at release node 1 is still recovering and drops node 2's request, so P4_2 is not gained. Iteration 32's analogous settle fired in 2.7% of holds against a predicted 30%; the candidate's own close clause (released.settled / episodes < 0.15) is the most likely reading. The settle predicate is strict (majority of a  Notes: The one hold the record leaves open (on the request, not the Recover), argued from the census's largest R4 loss with every cited number reproducing; it enforces label 8 rather than inverting it. It ranks last on cost and on the red-team reading that the two-recovering-nodes shape makes the settle rare and the close clause likely. If built: use the side map (origin, send_ordinal) -> reply_to_current instead of a Record field so exec.rs is untouched and the cost is 0; add opening_hold.mutual (episodes during which a held record was a fresh opening-round request from a node that itself had an open unsettled episode) and read it before any rung; keep the liveness lift and count it. Prediction kept as frozen (the cost band, the settled-share gate and the depth-11 merge claim are already explicit).

## post-fault-request-timing-axis

- kind: add | category: scheduler | origin: user | status: FILED at iteration 37 (inapplicable branch of the frozen prediction: released.event over held 0.064 against the 0.30 floor, so arm C graded as a 128-step dose; eight chunks pooled C/B depth>=8 0.986 [0.953, 1.020], depth>=10 1.208 [0.997, 1.463], depth>=11 1.149 [0.772, 1.711] against the key claim of 1.5; 84 percent of events were same-origin pairs, one label early; the axis code stays filed with the patch, the event key is replaced by a progress-keyed successor, see post-fault-release-on-recovered-progress) | previously ADMITTED at
  iteration 37 through the moderated lane (the user set the direction and
  agreed to the plan; judge evidence check gain 5, cost 0;
  prediction rewritten at admission) | parent:
  post-fault-deferral-length-contrast (merged at 64 steps) and the
  direction note after iteration 36
- Mechanism: post-fault request timing becomes a three-arm axis drawn per
  run - A immediate (today's control), B fixed 64-step deferral (today's
  treated half), C event-keyed release: held requests leave when some live
  node has acted twice on messages from incarnations that no longer exist,
  with a 128-step cap; bit 28 (renamed clientEventRelease) tags C inside
  the bit-18 half. Plan: research/lite/plans/post-fault-request-timing-axis.md.
- Judge red team: On the depth-10 rung the event key cannot beat the fixed 64-step arm except through its cap. Depth 10 is w2 (label 10, the post-fault Write invocation on node 0) after the ghost DVC 2->1 (label 9); rootAnchoredPrefix only asks that w2's event follow label 9's. In any run where E fires at node 1 on the DVC at ready+s with s < 64, the fixed arm's release at ready+65 also follows the DVC, so both arms score depth 10: an event release before 64 is a wash on this rung. C's depth-10 excess over B can only come from (i) DVCs acting in (64, 128] after the ready step - exactly the 128-against-64 dose - and its deficit from (ii) false early events. So the plan's decisive clause measures the cap net of early releases, not the key, and its independent observable (mean hold below 64 while C >= B) is unattainable by construction: with released.event/held at the 0.30 floor and the rest capped at 128, the mean hold over all C releases is at least 0.3*e + 0.7*128 > 89. The key's real payoff is at depth 11-12 (after label 9 node 1 broadcasts StartView; label 11 needs w2's PrepareOK 2->0 to land at node 0 before StartView 1->0, so only a release soon after the DVC helps), rungs the loop records only 
- Judge notes: Code claims check out line for line (hook, ungated token compare, incarnation bump, nested scope, selftest fixture, config values); the mechanism is real and the axis framing matches the user's direction. The evidence design has one structural flaw: depth 10 rewards any release after the ghost DVC, so a release keyed on that record is indistinguishable from a 64-step hold on every run where the record acts within 64 steps, and C's depth-10 read against B is the 128-versus-64 dose net of false early events. The frozen prediction is rewritten to say so and to put the key's own claim on depth>=11 (with the eight-chunk requirement its counts need) plus a census read of w2's distance from the label-9 record. The strongest unmeasured risk is the ghost RecoveryResponse 2->1 making the ghost SVC node 1's second acted ghost; a pre-grade census on depth>=8 runs (RR 2->1 Enter at node 1 after crash_2) tells how much of the chain population E misfires on, and a cheap counter (E fired where the prior acted ghost at R came from the same origin incarnation) records it in-run. Score 5: plausible, verified code path, but the decisive observable as written did not test the mechanism and the corrected one is thin at four chunks. Cost 0 per rubric; expect the iteration-33 layout effect (three-slot counters read 0.942 cross-binary) and read cost by steps and wall per step across arms.
- Frozen prediction (rewritten by the judge at admission): {"treatmentBit": {"name": "clientEventRelease", "value": 268435456, "shift": 28, "nestedIn": ["clientFanoutRelease (262144)"], "reuse": "row 268435456 renamed from clientDeferralLong (operator edit in decide.ts VARIANT_BITS; precedent bit 8388608)", "salt": "own (EVENT_SALT)", "treatedShareOfAllRuns": 0.233, "controlShareOfAllRuns": "B 0.235 (bit 18 set, bit 28 clear); A 0.469 (bit 18 clear, probe-free)", "probesExempt": "by inheritance from bit 18"}, "precondition": "Built on the landed 64-step deferral (EXPIRY_STEPS = 64 on the whole bit-18 half, no bit-28 quarter); the tree at spur 327bf72 still reads 32, so the merge lands first or the fixed arm is not the arm iteration 36 merged.", "rung": "depth>=8 (epoch 14 primary), per-run ratio event arm / fixed arm, probe-free, co-bit matched within clientFanoutRelease = 1", "band": [0.94, 1.06], "bandNote": "null expected at the primary: label 8 is a server-side order at node 1 and request timing between A and B read 1.01 / 0.996 / 0.98 on this rung", "firing": {"counter": "client_anchor.event.released.event", "floorPerChunk": "event arm held >= 150,000 (the fixed arm holds about 259,000 per chunk on the same share)", "applicabilityGate": "released.event / held >= 0.30 on the event arm; below it the arm is a 128-step dose and the key reads are inapplicable", "also": ["fixed arm hold steps per released in [64, 66]", "event arm: hold steps per event-released request reported (median expected below 64); hold steps per released over all event-arm releases reported with no band (at the 0.30 floor it is at least 89 by construction)", "held_at_exit / held <= 0.1% on both arms (the fixed arm reads 0.025%; the event arm's 128 cap is the one at risk)", "released.dry_queue reported on both arms", "event census on all three arms: events_total, runs_by_events {0,1,2,3+}, first_event_step and first_ghost_acted_step histograms relative to the first crash {<16,<32,<64,<128,128+}, events_at_restarted_receiver; fixed and event arms within 5% of each other on events per run (their trajectories coincide until the first release); the immediate arm reported with no band (the fan-out census already differs 10% between the immediate and held halves)", "ready_after_last_event: held requests on the event arm whose ready step followed the run's last E (these run to the cap), reported", "same_origin_pair: E firings where the receiver's prior acted ghost came from the same origin incarnation as the firing entry, reported"]}, "advanceRungs": {"depth>=10": {"mergeClaim": false, "reading": "C/B per run pooled over four chunks, reported as the cap read: release timing in (64,128] after the ready step net of early false events. Not attributable to the key, because a release before 64 steps that follows the label-9 record is also covered by the fixed arm's hold on this rung. Expected >= 1.0.", "falsifier": "interval entirely below 0.90: early false events outnumber the tail, the second acted ghost is the wrong key"}, "depth>=11": {"mergeClaim": true, "expected": "C/B per run >= 1.5 with the lower edge above 1.0 pooled over eight chunks (two four-chunk sessions on the same binary; the fixed arm reads about 40 depth-11 events per four chunks, so 1.5x separates at z about 2.9 at eight and 1.25x cannot be resolved at this size). Rationale: after the label-9 record acts, the new primary broadcasts StartView; label 11 needs the post-fault write's PrepareOK 2->0 to land at node 0 before StartView 1->0, so only a release soon after the record helps.", "extension": "the two sessions are queued from the start; a four-chunk read is a progress read, never a verdict"}, "depth>=9": {"expected": [0.95, 1.2], "reported": true}, "depth>=12": {"reported": true}}, "controlChecks": "from the cells: B/A depth>=10 in [3.0, 5.0] (iteration 36 read 4.07); C/A reported; the fixed arm's depth>=10 rate in [0.00028, 0.00042] per run (the control moved otherwise)", "independentObservable": {"statement": "On a kept explore of both sessions, read with the ghost_census.py dump path: among event-arm runs at depth>=9, the share whose post-fault Write invocation on node 0 falls within 16 steps after the Enter of the label-9 record (DVC 2->1 at node 1) is higher than the fixed arm's share; reported with both shares and counts. Also reported: events_at_restarted_receiver / events_total on the event arm, and same_origin_pair / events_total."}, "falsifier": "depth>=10 C/B interval entirely below 0.90 (wrong key: remove C, keep the axis code, record the E1 census); or released.event / held < 0.30 (inapplicable: file as a 128 dose read); or depth>=8 C/B outside [0.94, 1.06]; or plan_complete between arms more than 2 points apart; or steps per run between arms > 1.03x; or held_at_exit / held > 0.1% on either arm", "cost": "cross-binary throughput >= 0.97 of the paired cache; a read in [0.94, 0.97) with steps per run within 1.03x between arms and wall per step within 1% across arms is recorded as a layout read (iteration 33's three-slot counters read 0.942 and were not the merging binary), below 0.94 refutes; the hook adds three integer compares at an existing site", "decisionMap": "depth>=11 claim met at eight chunks and depth>=10 not below 0.90 -> C stays as an arm beside A and B; depth>=10 entirely below 0.90 -> remove C, keep the axis code and the census; applicability gate failed -> file as a 128 dose read on the fixed arm's length line; depth>=11 straddling at eight chunks with depth>=10 >= 1.0 -> file as 'key unresolved at this rung's counts', C kept as an arm only by operator decision under the per-cell panel plan", "grading": "start --treatment-bit 268435456 --band-min -0.06 --band-max 0.06, two four-chunk sessions on the same binary pooled by cell counts", "rewritten": true}
- Implementer watch: ["Land the 64-step merge first (EXPIRY_STEPS = 64, quarter code removed) and build on it; the research/lite tree is at 32. The fixed arm must be the iteration-36 arm or the B/A control check and the [64, 66] clause do not apply.", "Detect E inside note_ghost_delivery before the mark is overwritten: acted && origin_restarted && l.last_ghost_acted, with origin != receiver. Use r.origin_incarnation != state.incarnation(origin) for origin_restarted, computed before exec next to the ghost token at scheduler.rs:1300; the compare is already ungated.", "Add the two cheap census counters the judge relies on: same_origin_pair (store the last acted ghost's origin and incarnation in the SendLedger) and ready_after_last_event; without them a depth-10 read below 1.0 cannot be told apart between the RR-ghost misfire and node-0 firings.", "Before or alongside the grade, run ghost_census.py over depth>=8 runs of a kept explore and count runs whose RecoveryResponse 2->1 Enter at node 1 is after crash_2's step; that is the share of the chain population on which E fires one label early.", "The 128 cap is the only depth-10 channel; do not read a depth-10 gain as the key. Queue both four-chunk sessions from the start since the key's claim is on depth>=11.", "Per-arm counters are three-slot statics like iteration 33's; expect a cross-binary throughput read near 0.94-0.97 for layout and read cost by steps per run and wall per step across arms as well.", "Probes must stay Immediate (arm(run_id) returns Immediate for run-cap and timer-context probes); extend run_variant.rs tests so bit 28 implies bit 18 and never a probe bit.", "Renaming decide.ts row 268435456 to clientEventRelease is an operator edit at admission, not candidate scope."]

## crash-quiet-phase-arms

- kind: add | category: scheduler | origin: proposer | status: CLOSED at iteration 38 by its own keep rule (VR depth>=8 quiet/fan-out 0.826 [0.771, 0.886], a loss though far milder than the frozen band [0.08, 0.45]; on the candidate binary no named member read up per cell: forget-promise 4 vs 44 events, recover-forget-accepted 0.73 [0.44, 1.19], raft-forget-vote 0.59 [0.26, 1.38]); depth>=9 separated UP 1.29 [1.11, 1.50] and depth>=10 1.49 [0.97, 2.30], plan completion 0.224 against 0.182 - filed as a finding and seeded as a per-fault-index arm table | parent: crash placement and crash phase (merged), the per-cell panel read
- Mechanism: In spur/spur-core/src/simulator/crash_phase.rs the anchored half of placed runs (bit 512 crashPhase) draws one of {EARLY, MID, STOCK} per placed crash and withholds the crash until the read node's fan-out shows the drawn phase. This adds a salted QUARTER of the anchored runs (bit 1 << 17 crashQuietPhase, own salt QUIET_SALT, nested in crashPhase and crashPlaced, probes exempt by inheritance; about 0.11 of all runs) on which the per-crash draw is taken from {LANDED, ANSWERED, STOCK} instead, with the same one-value draw from Stream::CrashPhase (% 3), the same WINDOW = 96, the same cap reserve and the same landing-node read (phase_read_node), so a treated run consumes the random sequence its twin does. Predicates over the read node's SendLedger: LANDED = segment_sends >= 1 && undelivered == 0 && in_flight == 0 (everything the node's current handler segment sent has landed and nothing of its own is in the network: a sender-side round just closed); ANSWERED = trigger == HandlerTrigger::Delivery && segment_sends == 0 && in_flight == 0 (the node's latest segment was woken by a message, wrote or tallied in silence, and nothing of its own is in flight: a receiver-side round just closed, the quorum-reached or learned-a-decision moment). crash_phase::Fanout gains delivery_woken: bool read from ledger.trigger at the existing crash_hold_mask site in core/scheduler.rs; no other site changes. The STOCK third is unchanged and is the same-side null inside the quarter. New util_stats.rs block crash_phase.quiet.{runs, landed, answered, stock} where landed/answered/stock are CrashPhaseArmStats (armed, released_on_condition, expired, wait_steps_sum, release/apply victim_had_inflight, inflight buckets, moved_read_on_landing/planned), plus crash_phase.quiet.mapped_draws (draws taken from the quiet table). Registration: run_variant.rs CRASH_QUIET_PHASE = 1 << 17 set only when CRASH_PHASE is set; decide.ts VARIANT_BITS gains row 131072 crashQuietPhase (unregistered today; no rename). No config field; the quarter share is a constant beside ANCHOR_SALT (the share becomes a config constant only if arm-share-constants-from-panel is built).
- Rationale: Verified state of the crash side (spur tree at run_variant.rs / crash_phase.rs / fault_timing.rs / ghost_absorber.rs): four fault arms, all keyed to the same idea. Bit 1 (0.9 of non-probe runs) draws the crash's step uniformly over the learned completed-run span; bit 9 (half of placed) then waits up to 96 steps for a drawn fan-out phase of the victim, EARLY (segment issued >= 1 send, none delivered) or MID (>= 2 issued, some delivered) or STOCK; bit 19 moves the crash to the node that last absorbed a fault-crossing delivery; the landing-node merge reads the phase on that node. Of the three opposite-side candidates the operator named, the uniform-no-anchor crash already exists and is already read per cell: it is the unanchored placed half (bit 1 set, bit 9 clear, about 0.44 of runs) and the panel's crashPhase column is exactly fan-out-anchored against uniform (paxos-accept-stale-ballot 1.01 flat, raft-stale-vote 1.24 wide). What does not exist is a crash placed on a node with nothing in flight. The crash census on the merged tree (chunk-1000 of crash-phase-on-landing-node-b) reads victim_had_inflight_sends 842,610 of 1,193,525 decisions (0.71), inflight_bucket_0 0.29; the EARLY arm applies with in-flight 137,434 / 163,563 (0.84), STOCK 0.73. The quiet pair inverts that number by construction (condition-released LANDED/ANSWERED crashes apply at in_flight 0) and so is the axis's other side, not a variant of the same side. One correction to research/lite/plans/panel-per-cell-read.md section 5: EARLY admits a single undelivered send (segment_sends >= 1, undelivered == segment_sends), so 'crash a node whose single reply has already landed' is not excluded by the fan-out arms today; MID (>= 2 sends) is. The distinct behaviour the quiet arms add is therefore not 'crash after a lone reply' but 'crash with nothing of the node's in the network', including the ANSWERED moment (silent absorption: quorum reached, decision learned, vote tallied) that no current arm can select. VR reading, frozen as a loss: labels 3 and 5 of the epoch-14 chain are crashes with the victim's sends in flight (crash_nl with its SVCs undelivered, crash_2 with three sends undelivered); a LANDED or ANSWERED release forbids both, so on the treated quarter only STOCK-drawn crashes (one third) and the roughly 10 percent of anchored-run crashes that draw no hold can carry the chain. With (E+M+S)/3 = 1.30 S from the g34 per-bit read, the quarter over the three-arm control is about S/(3.9 S) plus leakage: 0.18-0.45 on depth>=8. Tree-level cost while the quarter is in the tree: about 0.11 x 0.7 = 8 percent of depth-8 events per chunk, the stated price of having the axis's other side; the share is the operator's knob. The panel is where the arm earns its place; the decision rule is the operator's.
- Generality: The rule reads only the node's send ledger and handler trigger: 'crash a node while everything it sent has landed and nothing of its own is in the network' and 'crash a node right after it took a message and replied with nothing'. No handler, message, role or timer label is named. Every request-response protocol has both moments (a sender whose round closed; a receiver that tallied a quorum or learned a decision in silence), and the bug class they expose is the inverse of the fan-out class: state forgotten or acted upon AFTER peers have already used the node's messages, rather than messages stranded from a node that then loses its state. Mencius (no crashes) is inert by construction and is the null row.
- Frozen prediction (rewritten by the judge at admission): {"treatmentBit": {"name": "crashQuietPhase", "value": 131072, "shift": 17, "nestedIn": ["crashPhase (512)", "crashPlaced (1)"], "reuse": "none: 131072 is not in VARIANT_BITS and no mechanism sets 1 << 17 (grep verified); the row is added at admission", "salt": "own (QUIET_SALT), salted_phase(run_id, QUIET_SALT, 4) == 0 within is_anchored(run_id)", "treatedShareOfAllRuns": 0.11, "controlShareOfAllRuns": "0.33 (crashPhase set, crashQuietPhase clear), matched by probeFreeScope plus invariantCoBits in both decide.ts and grader panelCells", "probesExempt": "by inheritance from crashPhase (run-cap probes are never placed)"}, "rung": "depth>=8 (epoch 14 primary), per-run ratio treated / matched untreated (crashPhase = 1), probe-free", "band": [0.08, 0.45], "bandNote": "Frozen as a LOSS. Labels 3 (crash_nl) and 5 (crash_2) are both crashes with the victim's sends undelivered; each placed crash draws its own arm, so on the quarter both chain crashes must be STOCK-drawn (1/9), un-held (about 0.1) or leak at apply (candidate's own expectation 0.02-0.08). Lower edge 0.085 = (1/3)^2 / 1.3 with zero leakage; upper edge 0.45 is the candidate's single-crash estimate with leakage. A read below 0.08 says the quarter loses more than its STOCK third can explain and is an implementation check (the quiet table touching STOCK draws, or the control's sequence moved) before anything else is read.", "advanceRungs": {"depth>=9": {"expected": [0.08, 0.5], "reported": true}, "depth>=10": {"expected": [0.05, 0.6], "reported": true, "note": "few events on 0.11 of runs; reported, never a claim"}, "depth>=4 and depth>=6": {"expected": [0.15, 0.6], "reported": true, "note": "the inversion begins at label 3 (crash_nl with the SVCs undelivered), so the loss shows from depth>=4; depth>=4 near 1.0 with depth>=8 in band says the loss comes from elsewhere and is an implementation check"}}, "vrCost": {"statement": "Tree-level price of carrying the quarter: the anchored half carries about 1.3x the unanchored depth-8 rate, so the quarter holds about 0.14 of the tree's depth-8 events; at the expected ratio the tree loses 10-13 percent of depth>=8 events per chunk (candidate said 8).", "acceptable": "cross-binary depth>=8 events per explore-second over four chunks >= 0.84 of the paired cache (expected 0.86-0.92; the 5 percent layout floor applies, so a read in [0.84, 0.88) is recorded as the stated price, not a separate finding); throughput (runs per explore-second) >= 0.97 of the paired cache; wall per step within 1 percent across the quarter and its control.", "unacceptable": "cross-binary depth>=8 per second below 0.84, or throughput below 0.97: close regardless of the panel."}, "panelCells": {"readOn": "grader panel --binary <candidate spur binary> --members paxos-fixed-forget-promise,raft-forget-vote,paxos-fixed-recover-forget-accepted,paxos-fixed-host-control,paxos-accept-stale-ballot,mencius-opt1-2,raft-stale-vote,paxos-fixed-recover-stale-scout --seed <s> --scale 3, cell crashQuietPhase (131072); matched control = crashPhase set, crashQuietPhase clear (panelCells invariant co-bits). Pooling across seeds: sum treatedRuns/treatedViolations and controlRuns/controlViolations per member from research/lite/state/panel/<iso>/<member>/{porcupine,runs}.json and apply the cell arithmetic (log-ratio, z 2.7, overdispersion 1.3, >= 5 violations on each half, ratio - 1 >= 0.02).", "upDefinition": "a cell reads UP when the pooled ratio's 2.7-sigma lower edge (overdispersion 1.3) is above 1, ratio - 1 >= 0.02, and both halves carry >= 5 violations - the grader's own 'up'.", "expectedUp": [{"member": "paxos-fixed-forget-promise", "direction": "up", "expected": ">= 2.0 per run", "runsPerRead": "runsPerConfig 20000 -> about 480,000 runs per seed (479,513 observed), about 70 s explore at 6.9k rps", "eventsPerRead": "rate 9.2e-5: control (0.33 share) about 14.6 events; treated quarter 4.9 at the base rate, >= 9.7 at a 2x lift, >= 19 at 4x", "seeds": "1000, 1001, 1002, 1003 pooled (1.92M runs). A >= 4x lift reads up on seed 1000 alone; a 2x lift needs about 33 treated events, which four pooled seeds supply. Read seed 1000 after the grade, pool the rest at the review.", "why": "acceptor_ballot dropped at RecoverInit; the acceptor's promise must have been used by its leader and the superseded P2a pending across a crash that strands nothing of the acceptor's; LANDED is that moment (manifest orderingClass and plan section 5 agree)"}, {"member": "paxos-fixed-recover-forget-accepted", "direction": "up", "expected": ">= 2.0 per run once calibrated", "precondition": "calibrate first on the merged tree: three seeds x 480,000 runs against paxos-fixed-host-control at the same overlay, join only at >= 20x separation from the control (plan section 5 rule); the rate r_c sets treated events per read = 0.11 x 480,000 x r_c x lift", "runsPerRead": "runsPerConfig 20000 -> about 480,000 runs per seed", "seeds": "1000-1003 pooled after calibration, same arithmetic as forget-promise", "why": "accepted dropped at RecoverInit; the acceptor's P2b must have been used (slot chosen) before it crashes; LANDED, or ANSWERED after a Decision taken in silence (N2 in the plan, 5/5 proven)"}, {"member": "raft-forget-vote", "direction": "up", "expected": ">= 1.5 per run; only a >= 2x lift is confirmable inside the budget", "runsPerRead": "runsPerConfig 40000 -> 2,880,000 runs per seed, about 390 s explore at 7.4k rps", "eventsPerRead": "rate 2.7e-5: control about 25.7 events; treated quarter 8.6 at the base rate, 17 at 2x", "seeds": "1000 and 1001 pooled (5.76M runs, about 13 min) confirm a >= 2x lift at z 2.7; a third seed is allowed; a 1.5x lift cannot be confirmed within three seeds and is REPORTED, never a keep criterion", "why": "voted_for dropped at RecoverInit; the vote must have been counted before the crash"}], "expectedDown": [{"member": "raft-stale-vote", "expected": [0.3, 0.9], "note": "quick set, about 114 events in 288,000; treated about 12 at the base rate, so likely wide or count-only; reported", "why": "needs the candidate's crash inside its RequestVote fan-out"}, {"member": "paxos-fixed-recover-stale-scout", "expected": "count-only (about 30 events at scale 3)", "why": "needs the crash after the P1a fan-out with the P1b replies in flight"}], "expectedFlat": [{"member": "paxos-accept-stale-ballot", "expected": [0.85, 1.05], "note": "3,353 events per read, treated about 370: resolves in one read", "why": "crashPhase read 1.01 for it; two proposers contesting a slot, crash optional"}, {"member": "mencius-opt1-2", "expected": "flat (null row, no crashes)"}, {"member": "paxos-fixed-host-control", "expected": "0 violations (clean control)"}], "notUpDefinition": "a named member is NOT up when, after its specified pooled seeds, the cell reads flat or down, or reads count-only with pooled treated violations >= 15 and ratio < 1.5.", "powerNote": "treated events scale with the share (1:3 treated:control runs at the quarter), so the share stays at the quarter through the read; the member's runs per read is the bound. Forget-promise and forget-accepted resolve a 2x lift on four pooled seeds (about 5 min each), raft-forget-vote a 2x lift on two (about 13 min)."}, "firing": {"counter": "crash_phase.quiet.landed.armed", "floorPerChunk": 25000, "also": ["crash_phase.quiet.answered.armed >= 25,000 and crash_phase.quiet.stock.armed within 15 percent of each (equal-mass draw)", "crash_phase.quiet.mapped_draws >= 75,000 per chunk (about 0.11 x 574k runs x 1.93 armed crashes per anchored run = 122k expected)", "released_on_condition / armed >= 0.60 on landed, >= 0.40 on answered; expired / armed reported per arm", "wait_steps_sum / (released_on_condition + expired) reported per arm, expected below 27", "crash_phase.quiet.landed.released_with_peer_held reported (condition releases while a record of the read node sits in crash_info.queued_messages)", "control arms crash_phase.early/mid/stock per-chunk armed fall to about three quarters of 161k/161k/160k with release and apply shares unchanged within 2 percent"]}, "independentObservable": {"statement": "apply-time victim_had_inflight / apply_decisions on condition-released LANDED and ANSWERED crashes <= 0.10 (EARLY reads 0.84, STOCK 0.73 on chunk -b); treated-quarter anchored applies inflight_bucket_0 share >= 0.55 against 0.16 (EARLY), 0.14 (MID), 0.27 (STOCK); read from the new quiet block against the existing per-arm blocks on the same chunk", "expected": "0.02-0.08 in flight at apply (a step or two may pass between mask-off and the crash being taken); bucket_0 about 0.6"}, "falsifier": "landed.armed < 25,000 per chunk (closed without a rate read); or in-flight share at apply on condition-released quiet crashes > 0.25 (the predicates do not produce quiescent crashes); or depth>=8 treated/control > 0.60 with the floor met (the arm is not inverting the condition; check the read node); or depth>=8 below 0.08 (implementation check before any read is credited); or treated steps per run > 1.03x control; or plan_complete more than 2 points apart; or crashes or recovers per run off by more than 1 percent; or the VR cost clause failed; or, on the panel, none of the three named members reads UP after its specified pooled seeds (remove the arm, keep the quiet census counters, record that the panel has no quiet-side member).", "cost": "cross-binary runs per explore-second >= 0.97 of the paired cache (about 1,990-2,040 rps); wall per step within 1 percent across the quarter and its control (one trigger read at an existing site). Tree-level depth>=8 price as stated under vrCost.", "decisionMap": "depth>=8 in [0.08, 0.45], VR cost clause met, and at least one named member UP (pooled per its seed schedule) -> merge and KEEP THE ARM AT THE QUARTER (the share the read was taken at; any later share change is an operator decision from the tree ledger and needs its own panel re-read). depth>=8 in band, cost met, named members not up after their pooled seeds -> remove the arm, keep the quiet census, file the finding 'no quiet-side member on the current panel'. depth>=8 above 0.60 or below 0.08, or apply-time in-flight share above 0.25 -> implementation check before any read is credited. VR cost clause failed -> close regardless of the panel.", "grading": "grader start --treatment-bit 131072 --band-min -0.92 --band-max -0.55, four chunks; then grader panel on the candidate binary: quick set plus paxos-fixed-forget-promise and raft-forget-vote at seed 1000 right after the grade (about 8 min), seeds 1001-1003 for forget-promise and 1001 for raft-forget-vote pooled at the review; paxos-fixed-recover-forget-accepted calibrated first (three seeds against paxos-fixed-host-control) and read the same way once admitted.", "rewritten": true}
- Grading protocol: Build on the merged tree (spur 02df730 or later). Grade: research/lite grader start --treatment-bit 131072 --band-min -0.92 --band-max -0.55, four chunks, primary depth>=8 per run treated/matched control (crashPhase = 1), all firing and independent-observable clauses read on chunk 1 before the rungs are credited; VR cost clause (cross-binary depth>=8 per second >= 0.84, throughput >= 0.97) read at finish. Panel: grader panel --binary <candidate> --members paxos-accept-stale-ballot,mencius-opt1-2,raft-stale-vote,paxos-fixed-recover-stale-scout,paxos-fixed-forget-promise,raft-forget-vote,paxos-fixed-host-control --seed 1000 --scale 3 after the grade; pool seeds 1001-1003 (forget-promise) and 1001 (raft-forget-vote) at the review by summing halves from the panel state files; calibrate paxos-fixed-recover-forget-accepted (three seeds vs the fixed host) and add it. Verdict by the decisionMap: keep at the quarter only on an UP cell (2.7 sigma, overdispersion 1.3, >= 5 violations per half, ratio - 1 >= 0.02) for at least one named member.
- Judge: The chain has TWO crashes that need the victim's sends in flight, not one: label 3 (crash_nl; deliver_svc_1_to_2 follows it in the DAG) and label 5 (crash_2; deliver_svc_2_to_0 and deliver_svc_2_to_1 follow it). Each placed crash on an anchored run draws its own arm, so on the quarter both must be STOCK-drawn (1/9), un-held (about 0.1 of crashes) or leak at apply; the candidate's single-crash arithmetic (S/3.9S = 0.26 plus leakage, band [0.18, 0.45]) is too optimistic at the low end - the compounded estimate is about 0.085 with zero leakage, 0.12-0.20 with the leakage the candidate itself predicts (0.02-0.08 at apply plus the 0.1 un-held). Band lower edge widened to 0.08. The predicates are common moments, not rare ones: LANDED is any node whose last segment's sends have all landed (a backup after its PrepareOK landed), ANSWERED is any node idle after a no-send delivery (a Commit), so re Notes: Ranked first and the only mechanism in the round: a verified inversion of the crash axis, reading the same ledger the merged arms read, with the twin-stream property preserved and every cited number reproducing. Its VR read is a frozen loss by design and the keep decision lives on the panel; the prediction below makes that read operational. Implementer: (1) the treated table is a separate [Landed, Answered, Stock] array drawn with the same % 3 so the control's random sequence is untouched - assert with a CountingRng twin test like crash_phase.rs:352-386; (2) read trigger from the landing node's ledger copy already taken at scheduler.rs:725, never the planned victim's; (3) add crash_phase.quiet.landed.released_with_peer_held (read node has a record in crash_info.queued_messages at a condition release) so 'landed' is reported net of set-aside records; (4) Fanout gains delivery_woken: bool; the test helper fanout() sets it false; (5) decide.ts VARIANT_BITS row {131072, crashQuietPhase} is operator registration in the same commit; (6) crash_phase.quiet.{runs, mapped_draws, landed/answered/stock: CrashPhaseArmStats} in util_stats.rs. False claims named: ["The 'correction' to panel-per-cell-read.md section 5 is wrong as phrased: EARLY admits a lone reply IN FLIGHT (1 issued, 1 undelivered), not one that 'has already landed' (1, 0), which is false for EARLY and MID and admitted only by STOCK and the unanchored placed half. Section 5's forget-promise row stands. Not load-bearing: the mechanism's stated distinct contribution (select in_flight == 0) is correct.", "powerNote: 'the share does not fix that (power is bounded by the member's total events)' is wrong - treated events scale with the share (1:3 treated:control runs at the quarter, 1:7 at a

## restart-after-drain-stratum-tag

- kind: enabling | category: scheduler | origin: proposer | status: REJECTED at iteration 38 (judge score 0) | parent: iteration-38 fault-injection round
- Reason: Out of bounds on its payoff and already answered on its in-bounds part, with two checkable claims failing. (1) The simulator side changes no run; every observable it adds (before_drain / eligible in [0.85, 0.92]) is the iteration-25 control read (0.885, pool.md restart-before-stranded-drain-preempt) restated, so the in-bounds content is already answered. (2) Its only new payoff - a per-member panel column - requires the grader's panelCells to admit a NON_DECLARABLE outcome bit as an observational stratum (grader.ts:1475 skips them today) and requires moving the decide.ts selftest fixture: decide.ts:1683 asserts bit 4096 is 'not on the roster', and registering 4096 in VARIANT_BITS plus NON_DECLARABLE_BITS would make the declaration check return 'instrument or outcome' instead (decide.ts:465-466), failing the selftest. Both are grader/orchestrator edits, which GOAL.md places outside a hypothesis; a candidate whose entire value is realized through harness edits is out of bounds, not merely inert. (3) Checkable claims: the crash+1 push holds (path.rs:658-666 pushes Runnable::Recover when RecoverNode becomes ready, which is the step after mark_event_completed at path.rs:775-781 for the crash; push_runnable puts it in the victim's local queue, state.rs:927-930; crash_node empties that queue, scheduler.rs:1679-1694, and deliveries to a crashed node go to queued_messages, so the queue holds only the Recover; RECOVERY_PLACEBO_FACTOR 1.0 at scheduler.rs:218 and general_vr.json recovery_weight_placebo true confirm the priority band is inert). But 'taken by the local roll within one to three steps' is FALSE against the record: the recorded crash-to-restart interval is mean 5.4 foreign handler entries (pool.md:548), a lower bound on steps; pick_local (queue_selector.rs:52-64) weights by total local queue size across all nodes at p_local 0.6-0.95, so the per-step chance is p_local / total_local, not p_local. (4) The drained computation 'inflight_at_crash - ledger.in_flight' is FLAWED: flight_leave runs when a PEER crashes holding the dead incarnation's record (scheduler.rs:1698, set aside into queued_messages, re-entered at the peer's recover), and on purgatory/partition drops, so in_flight can fall without any consumption; 'drained' must be counted at the delivery site (a fault_crossing entry whose origin is currently crashed, scheduler.rs:1311) as iteration 25's stock_before_drain was. (5) The counter it names, crash_recovery.recoveries_with_own_prior_sends_inflight, is delivery_effects.recoveries_with_own_prior_sends_inflight (735,951 on chunk -b, 801,448 on the other chunk). (6) The observational column is confounded by construction: after_drain is likelier the more of the dead incarnation's sends were in flight, which is also what the recovery-shaped members depend on, so a member 'up' on the column does not name a hold's beneficiary without splitting by inflight-at-crash bucket. (7) The acceptance clause 'equal digests of executions and runs per shared run id' is false by construction: the runs row's variant column would carry bit 4096 on about 13 percent of runs; it must exclude the variant column. If the operator wants this instrument, it is operator-lane work bundled with the panelCells change and the fixture move; the counters alone (restart_drain.* with the delivery-site drained count, split by inflight-at-crash bucket) could ride along with any mechanism build at zero cost.

## arm-share-constants-from-panel

- kind: meta | category: scheduler | origin: proposer | status: REJECTED at iteration 38 (judge score 0) | parent: iteration-38 fault-injection round
- Reason: Inert, and premature (judge gain 0-1). In bounds as code (run_phase.rs, the mechanism modules, explorer.rs) and the allocation surface is a legitimate object under GOAL.md's 'ability to switch among them', but at its defaults it is a pure re-randomization of every merged arm's half (mix(id ^ salt) % 64 < 32 selects a different half than % 2 == 1) whose pass criterion is 'as today': an A/A with no mechanism content and nothing learned about exploration, costing a four-chunk session. Side effects are real and negative: every per-cell panel baseline (research/lite/state/panel) and every filed patch's re-grade (replyFirstRecovering, bit 22) would be read on new halves; and it adds a six-field config block, which GOAL.md names as the fallback, not the design, when no panel verdict has yet licensed any share other than one half. The share knob it introduces has one prospective user (the quiet quarter's share), and that share is fixed at the quarter through its panel read by the rank-1 decision rule. Build it, if ever, as part of the first share change a panel read licenses, with the A/A on re-randomized halves as that change's acceptance test; not as a round. Not a duplicate of the rejected adaptive-arm-allocation-bandit-salvage (which touched the campaign block), and the candidate is right that in-session adaptation is circular for the fault arms - that argument is filed as its useful content.

## post-fault-release-on-recovered-progress

- kind: add | category: scheduler | origin: operator-agent | status:
  CLOSED at iteration 47 on the inapplicable branch of its own frozen
  prediction: over four chunks the clock released 68,039 holds per chunk
  (floor 100,000) and 0.180 of the holds on its quarter (floor 0.5); the
  arm-blind census puts the restarted node's third acted entry inside the
  64-step window on 0.166 of all holds, mean acted count at release 3.32.
  Graded as the 128-step dose it degenerates to, eight chunks read depth>=8
  0.982 [0.943, 1.022], depth>=10 0.743 [0.573, 0.964] SEPARATED DOWN,
  depth>=11 0.533 [0.312, 0.911] at z 2.7 - the longer hold costs a quarter
  of depth 10 and half of depth 11, which reverses iteration 37's 1.21
  [1.00, 1.46]. Finding: acted
  handler entries since restart is the right kind of clock but N = 3 is
  slower than the hold's window four times in five on this tree; any
  successor must pick N from the census (N = 1, "the restarted node has
  acted at all", fires on most holds) and must be proposed as a mechanism
  round, not a dose sweep. Not re-seeded here | previously ADMITTED at
  iteration 47 as the session primary; KEPT at iteration 44 (judge gain 5,
  cost 0, rank 4) | parent: post-fault-request-timing-axis (filed) and the
  64-step deferral (merged)
- Frozen prediction (admission, iteration 47): bit clientProgressRelease =
  1 << 28 (268435456), recycled from the dead clientEventRelease row, set
  only when CLIENT_FANOUT_RELEASE (1 << 18) is set, own salt, probes exempt
  by inheritance; treated share about 0.25 of non-probe runs; matched
  control is the other half of the hold runs (bit 18 set, bit 28 clear),
  the 64-step hold unchanged. depth>=8 in [0.94, 1.06]. Decisive: depth>=10
  progress/step at or above 1.20 with the interval's lower edge above 1.00
  pooled over eight chunks; depth>=11 reported. Firing:
  client_anchor.released.progress at or above 100,000 per chunk and
  released.progress / held at or above 0.5 on the treated quarter (below
  0.5 is the inapplicable branch of iteration 37 - the arm graded as a
  128-step dose). Independent observable, the arm-blind census on every
  arm: at each held request's release, the most recently restarted node's
  acted entries since its restart and the step distance from its third
  acted entry to the request's ready step; the share of holds whose third
  acted entry lands before ready_step + 64 reported; released.progress
  exactly 0 on mencius-opt1-2 (no restart, only the cap governs).
  Falsifier: depth>=10 interval entirely below 0.90; or the applicability
  floor missed; or the firing floor missed. Panel claim, signed:
  paxos-fixed-recover-forget-accepted UP (>= 1.10) progress-clocked against
  64-step within the hold half, because the hold reads 0.59 there and a
  recovered acceptor reaches three acted entries within a few deliveries,
  so the clock releases the request earlier in most runs; refuted only if
  that cell reads DOWN. Cost: throughput >= 0.97; every counter is per
  release or per handler entry on a branch that already runs, nothing per
  step or per dispatch.
- Updated at iteration 46 (a duplicate proposal was folded in here rather
  than opened as its own row). The release unit is acted handler entries at
  the most recently restarted node, and it is cheaper than this entry
  assumed: SendLedger already carries `entries` and `entries_at_restart`
  (core/state.rs:686) and note_ghost_delivery already applies the
  `env.writes != before` acted test (core/state.rs:1092), so the clock needs
  a per-entry increment and a snapshot at note_incarnation_bump, not a new
  accounting path. Bit 1024 (entryClock) is free to recycle. The census this
  entry is gated behind stays mandatory and arm-blind. One clause must be
  restored before admission: the decisive read is depth>=10 at or above 1.20
  with the interval's lower edge above 1.00, because a band on depth>=8
  alone leaves the arm unfalsifiable on the only rung the hold was merged
  for.
- Mechanism: arm C of the request-timing axis keyed on protocol progress
  instead of scheduler steps or a rare double-ghost event: a held post-fault
  request is released when the most recently restarted node has acted (a
  handler entry changed its state token) N times since its restart, N = 3
  as the first dose, with the 128-step cap as the fallback. The count is
  arm-blind and censused on all runs (acted entries since restart at the
  first restart step of the request's hold).
- Why: iteration 37 showed the double-ghost event fires in 4 percent of runs
  and one label early when it does, while the chain needs the write after
  the recovered peer's third acted entry (ghost RecoveryResponse, ghost
  StartViewChange, ghost DoViewChange at node 1 are labels 7, 8, 9). Acted
  entries since restart is a progress clock every protocol has; the step
  constants 32 and 64 were proxies for it. Falsifiable against the 64-step
  arm on depth 10 and 11 the way iteration 37 was, with released.progress
  over held expected above 0.5 (the applicability floor the event arm
  missed), and readable on the panel cells for the opposite-side members.
- Frozen prediction (draft; the judge rewrites at admission): bit 28 reused
  (clientEventRelease renamed clientProgressRelease), set within bit 18, own
  salt; depth>=8 C/B in [0.94, 1.06]; decisive depth>=10 C/B >= 1.20 with
  lower edge above 1.0 pooled over eight chunks, depth>=11 reported; firing
  released.progress/held >= 0.5, steps per progress release reported (the
  census says whether N = 3 lands after label 9); falsifier depth>=10 C/B
  entirely below 0.90 or the floor missed; cost throughput >= 0.97.

## stale-first-same-pair-dispatch

- kind: add | category: scheduler | origin: proposer | status: CLOSED at iteration 39 by its own keep rule (VR depth>=8 stale/fresh 0.232 [0.212, 0.254], a far larger loss than the frozen band [0.60, 0.90]; depth>=9 0.387 and depth>=10 0.594 separated down; the named panel member did not confirm: raft-stale-vote 1.55 [0.94, 2.57] on three pooled seeds against a 2x keep threshold, the stale scout 1.56 [0.58, 4.18], both suggestive and neither separated) | parent: iteration-39 delivery-axis round
- Mechanism: New arm on the DELIVERY axis, the opposite side of freshFirstPair. In fresh_first_dispatch (scheduler.rs:1540-1600) the merged rule, on bit 24 runs, replaces a drawn ghost (origin_incarnation != incarnation(origin)) by the highest-priority eligible fresh record from the same origin to the same destination. On a nested salted quarter (bit 1 << 22, staleFirstPair, own salt STALEFST, set only when bit 24 is set; probes exempt by inheritance) the direction is inverted: when the drawn record is fresh and an eligible dead-incarnation record from the same origin to the same destination exists, take that ghost instead (highest priority, lowest queue index among equals; fresh_first::rival gains the index for the want_fresh == false search, which today only detects). Same gate (origin ledger has both net_fresh and stale records in the queue), same no-draw-consumed property, ghost census unchanged, channel sends neutral. pair_order_dispatch runs after it as today and orders inside the class taken. Counters (fresh_first block, third slot stale_arm): contests, swaps_to_stale, repeat_swaps, taken histogram, and the existing ghost-entry overtaken census read per arm. Registration: run_variant.rs STALE_FIRST_PAIR = 1 << 22 set only with FRESH_FIRST_PAIR; decide.ts VARIANT_BITS row 4194304 renamed from replyFirstRecovering (filed at iteration 34, patch kept, not in the tree: run_variant.rs sets no bit 22) to staleFirstPair. No config field. Nesting inside bit 24 gives the grader a matched two-sided read (stale quarter against fresh-first quarter, the coin's two ends) and leaves the stock half untouched as the third cell; while the arm is in the tree the pooled bit-24 headline reads (fresh + stale) against stock, the same acknowledged pooling the request-timing axis carries on bit 18.
- Rationale: Fresh-first is the tree's one class-order bias and it reads as one: +12% on depth 8 for VR and 0.79 [0.44, 1.41] on raft-stale-vote in the first per-cell panel read. panel-per-cell-read.md section 5 classes two members as 'opposite: the stale reply first' (raft-stale-vote, paxos-fixed-recover-stale-scout). Read in simulator terms: the candidate's RequestVote (or the scout's P1a) is sent, the sender crashes and restarts, and the restarted incarnation's request to the same follower (acceptor) is co-eligible with the dead incarnation's; fresh-first lands the new-term request first, the follower's term (ballot) rises and the ghost is refused, so the stale grant that the buggy reply handler would count is never produced. Stale-first produces it every time the contest occurs. For VR the same swap at node 1 puts the ghost SVC 2->1 before the fresh Recovery 2->1, which inverts label 8, so the VR read is a frozen loss: the control's stock coin took the ghost first about 60% of the time and fresh-first's 100% fresh read 1.12 over stock, so 100% stale should read about 0.92 of stock and about 0.82 of the fresh-first quarter it is matched against. The one order at node 1 where a ghost first helps (RR 2->1 before Recovery 2->1) is an arrival gap, not a contest (iteration 34), so it does not offset the loss. This is the arm the pool held twice (pair-order-drawn-class-fresh-stale-stock, HELD at iteration 26: 'run stale-first alone with a negative band') and the direction note now asks for: a strategy whose bias is the mirror of a merged one, read per cell.
- Generality: Rule: at a network step whose draw fell on a record from a sender's current incarnation, take instead an eligible record from that sender's dead incarnation to the same destination. Names no handler or role; the mirror image of the merged fresh-first rule, and inert wherever fresh-first is inert (no restarted sender with both classes in the queue). The panel decides which side a bug needs: a term- or ballot-guard bug that consumes a stale reply reads up on this cell, a recovery-completion bug reads down, a bug without restarts reads flat.
- Frozen prediction (rewritten by the judge at admission): {"treatmentBit": {"name": "staleFirstPair", "value": 4194304, "shift": 22, "nestedIn": ["freshFirstPair (16777216)"], "reuse": "row 4194304 renamed from replyFirstRecovering (filed iteration 34, not in the tree)", "salt": "own (STALEFST), salted_phase(run_id, STALEFST, 2) == 1 within fresh_first::is_treated(run_id)", "treatedShareOfAllRuns": 0.235, "controlShareOfAllRuns": "0.235 (freshFirstPair set, staleFirstPair clear), matched by invariant co-bits; stock half (0.47) is the third cell", "probesExempt": "by inheritance from freshFirstPair"}, "rung": "depth>=8 (epoch 14 primary), per-run ratio stale quarter / fresh-first quarter, probe-free, co-bit matched", "band": [0.6, 0.9], "bandNote": "Frozen as a LOSS. The floor is widened from 0.70 to 0.60 because the control ghost-first share is recorded twice with different values (0.37 overtaken in the plan, 0.711 in the merge note); a linear model gives 0.82 of the fresh-first quarter under the first and 0.63 under the second. Stale quarter over stock half reported from the cells, expected [0.70, 0.98].", "advanceRungs": {"depth>=9": {"expected": [0.55, 0.95], "reported": true}, "depth>=10": {"reported": true}, "depth>=6 and depth>=7": {"expected": [0.97, 1.03], "reported": true, "note": "a read below 0.95 is an implementation check on the gate"}}, "panelCells": {"readOn": "grader panel --binary <candidate> --members paxos-accept-stale-ballot,mencius-opt1-2,raft-stale-vote,paxos-fixed-recover-stale-scout,paxos-fixed-forget-promise,raft-forget-vote,paxos-fixed-host-control --seed <s> --scale 3, cell staleFirstPair (4194304), matched control = freshFirstPair set, staleFirstPair clear (panelCells invariant co-bits); pooling across seeds per the cell arithmetic", "expectedUp": [{"member": "raft-stale-vote", "direction": "up", "expected": ">= 1.5 per run against the fresh-first quarter (its freshFirstPair cell read 0.79, so stale over fresh is expected near 1/0.79 or above)", "runsPerRead": "288,000 runs per seed at scale 3 (quick set)", "eventsPerRead": "about 117 violations per seed; about 27 per quarter at the base rate, about 23 on the fresh-first quarter", "seeds": "1000 after the grade; 1001-1003 pooled at the review; a fifth seed allowed. A >= 2x lift is confirmable on three pooled seeds (z about 3.9), 1.5x needs five (z 2.7 at about 125 control events); a 1.3x lift is REPORTED, never a keep criterion", "why": "the follower must grant the dead incarnation's RequestVote before the restarted incarnation's raises its term; the guard-dropped RequestVoteReply handler then counts the stale grant"}, {"member": "paxos-fixed-recover-stale-scout", "direction": "up", "expected": ">= 1.5 per run", "runsPerRead": "96,000 runs per seed at scale 3; count-only at that size (about 29 violations per seed, about 7 per quarter)", "seeds": "1000-1003 pooled: confirms only a >= 2.5x lift (z about 3.1); if the operator gives the member the slow-set run count (10x, 960,000 per seed) a 1.5x lift confirms on two pooled seeds", "why": "the acceptor must promise the dead scout's ballot before the restarted scout's higher one, producing the stale P1b the clause-dropped HandleP1bResponse counts"}], "expectedFlat": [{"member": "paxos-accept-stale-ballot", "expected": [0.9, 1.1]}, {"member": "mencius-opt1-2", "expected": "flat (null row)"}, {"member": "paxos-fixed-forget-promise", "expected": "reported"}, {"member": "raft-forget-vote", "expected": "reported"}, {"member": "paxos-fixed-host-control", "expected": "0 violations"}], "upDefinition": "a cell reads UP when the pooled ratio's 2.7-sigma lower edge (overdispersion 1.3) is above 1, ratio - 1 >= 0.02, and both halves carry >= 5 violations - the grader's own 'up'. Pool by summing treatedRuns/treatedViolations and controlRuns/controlViolations per member from research/lite/state/panel/<iso>/<member>/{porcupine,runs}.json.", "notUpDefinition": "a named member is NOT up when, after its specified pooled seeds, the cell reads flat or down, or reads count-only with pooled treated violations >= 15 and ratio < 1.5.", "powerNote": "treated and matched-control events both come from quarters, so per-seed counts are a quarter of the member's; raft-stale-vote is the member that can decide within four seeds (at >= 2x), the scout is count-only unless run at the slow-set size"}, "firing": {"counter": "fresh_first.stale_arm.swaps_to_stale", "floorPerChunk": 40000, "also": ["fresh_first.stale_arm.contests per treated run within 10% of the fresh-first quarter's contests per run (the gate is arm-blind)", "repeat_swaps / swaps_to_stale <= 0.25 with the taken histogram", "no stale-arm contested dispatch delivered a fresh record while a same-pair ghost was eligible (exact, 0)", "fresh-first quarter's swaps and overtaken share unchanged from the merged read (0.9989)", "stale quarter ghost-entry overtaken share reported per chunk"]}, "independentObservable": "stale quarter ghost-entry overtaken share <= 0.10 against 0.9989 on the fresh-first quarter and the stock half in [0.25, 0.65] (both recorded control values fall inside)", "falsifier": "depth>=8 stale/fresh-first interval containing or above 1.00; or overtaken share above 0.20; or swaps_to_stale below 40,000 per chunk; or steps per run > 1.03x; or plan_complete more than 2 points apart; or crashes or recovers per run off by 1%; or, on the panel, neither named member UP after its specified pooled seeds (remove the arm, keep the stale-arm census, record 'no stale-first member on the panel')", "vrCost": "tree-level price while the quarter is in the tree: about 0.235 x (1.12 - band) of depth>=8 events per chunk, 4-12% across the band. Acceptable: cross-binary depth>=8 events per explore-second >= 0.88 of the paired cache (layout floor applies); throughput >= 0.97; wall per step within 1% across quarters", "decisionMap": "depth>=8 in [0.60, 0.90], cost met, and raft-stale-vote or the stale scout UP after pooled seeds -> merge and keep the quarter (class-order axis fresh 0.235 / stale 0.235 / stock 0.47; any share change is an operator decision from the tree ledger with its own panel re-read); band met, cost met, no named member up -> remove the arm, keep the census, record 'no stale-first member'; depth>=8 above 0.95 -> implementation check (the swap did not invert); depth>=8 below 0.50 -> implementation check on the gate before any read is credited; VR cost clause failed -> close regardless", "grading": "grader start --treatment-bit 4194304 --band-min -0.40 --band-max -0.10, four chunks; panel on the candidate binary: quick set at seed 1000 after the grade, seeds 1001-1003 pooled for the two named members at the review", "rewritten": true}
- Grading protocol: Build on the merged tree. Grade four chunks on bit 4194304 (nested in 24), primary depth>=8 stale quarter / fresh-first quarter; firing and overtaken-share clauses read on chunk 1 before any rung is credited; VR cost clause at finish. Panel per panelCells.readOn; verdict by the decisionMap. The panel state files are the pooling source.
- Judge: Strongest case against: (a) it is a frozen VR loss whose only keep path is the panel, and the two named members are small (raft-stale-vote about 117 violations per 288,000-run seed, the scout about 29 per 96,000-run seed), so at quarter cells the candidate's power claims are wrong: '1.5x separates on two pooled seeds, 1.3x on four' fails the grader's 2.7-sigma rule (two seeds at 1.5x is z about 1.8; four seeds at 1.5x is z about 2.05); the operational rule below replaces those clauses. (b) The 0.92-of-stock estimate rests on 'the stock coin took the ghost first about 60% of the time' (fresh-first plan line 24, control overtaken share 0.37); the iteration-26 merge note reads the control overtaken share at 0.711 (ghost-first about 29%), which would put a 100% ghost-first quarter near 0.63-0.71 of the fresh-first quarter. The two records disagree, so the band is widened downward. (c) The mirror swap is skipped when the destination is down (fresh_first_dispatch checks currently_crashed), a Notes: Cost 0: fresh_first.rs and the dispatch site in scheduler.rs only; no exec.rs, history.rs or event-accounting touch (the candidate wrote 0.5; the rubric has no such value). Nested quarter inside bit 24 gives the matched two-sided read the direction note asked for; while in the tree the pooled bit-24 headline reads fresh+stale against stock, which the ledger must record. Interaction with the receiver-ghost holds: none at the dispatch site (a hold masks before the draw; this swaps among eligibles). False claims named: ["power clauses: '1.5x separates on two pooled seeds, 1.3x on four' is false under the grader's cell rule at about 27 events per quarter per seed; 2x needs three pooled seeds, 1.5x five; 1.3x is never confirmable at these counts", "'stock coin took the ghost first about 60%' is one of two disagreeing records (plan line 24 says 0.37 overtaken; the iteration-26 merge note says 0.711 overtaken); the derived 0.92 and the band floor 0.70 depend on which is right"]

## receiver-ghosts-first-at-restart

- kind: add | category: scheduler | origin: proposer | status: KEPT at iteration 39 (judge gain 3, cost 2, rank 3); bit unassigned - 65536 was reassigned to recoverWindowEarly at iteration 50, whose EARLY direction is the priority form of this entry's class | parent: iteration-39 delivery-axis round
- Mechanism: New arm on the DELIVERY axis, the opposite side of receiver-ghost-hold-until-restart-settles and of today's interleaved drain. Mechanism: same dest_incarnation_at_send stamp on Record (shared with the settle-hold if both are built; otherwise added here). recover_crashed_node (scheduler.rs:1789) counts, once per recovery, the records addressed to the recovering node in the buffer it re-pushes plus those still in the network queue whose stamp is the dead incarnation, into SendLedger.receiver_ghosts_pending (decremented at the message-entry site when such a record is taken; the queue scan happens once per recovery, where crash_node already scans the queue). On the treated half (bit 1 << 16, receiverGhostsFirst, own salt BUFFIRST, probes exempt), is_ineligible masks a record addressed to node v whose stamp equals v's current incarnation (sent after the restart) while v.receiver_ghosts_pending > 0 and current_step < restart_step + 32; records whose origin role differs from v's role (client requests) are never masked, so the request-timing axis is untouched. Liveness lift as the sibling's. The held records stay in the network queue. This is the BUFFERED_FIRST arm of the kept entry restart-buffer-fresh-first-release, built in the Record-mask form the judge required (no side vector, all_queues_empty untouched). Counters (util_stats.rs block receiver_ghosts_first): episodes (recoveries with pending > 0), masked_offers, holds, released.{drained, cap, liveness}, hold_steps_sum, pending_at_restart histogram {1, 2, 3+}, and the same both-halves receiver-ghost entry/acted census as the sibling. Registration: run_variant.rs RECEIVER_GHOSTS_FIRST = 1 << 16; decide.ts VARIANT_BITS row 65536 renamed from ghostPeerAnswer (closed iteration 18, not in the tree). No config field.
- Rationale: The settle-hold sibling makes the outage's messages land after the restart window; this arm makes them land before anything else, the burst-at-reconnect semantics of a queue that replays a backlog in order on reconnect. It is a frozen VR loss: at node 1 the buffered SVC 2->1 and DVC 2->1 drain into a node whose RecoveryResponses (sent after the restart) are held behind them, so they are consumed at status 2 and dropped (VR.spur:301, 385) and labels 8-9 are unreachable on the buffered route the violating run used; node 1's recovery is also delayed by the drain (a few steps, cap 32). The side it serves is the panel's forget class: paxos-fixed-forget-promise needs the superseded P2a, pending across the acceptor's crash, to be accepted before any new-ballot P1a raises the forgotten acceptor_ballot; raft-forget-vote needs a RequestVote buffered during the outage to be answered before the elected leader's AppendEntries names a leader. Both are 'the stale message acts at the instant of restart', which today happens by the tournament's coin and this arm makes certain. Depth cost: a hold on chain records (RR 0->1, RR 2->1, Recovery 2->1 at node 1) bounded by the buffer's drain, the same shape as iteration 32's Recover hold but on the other side of the coin; the loss is the price of carrying the side, and the keep decision is the panel's.
- Generality: Rule: after a node restarts, the messages addressed to it during its outage are delivered before any message sent to it since it came back, up to 32 steps. Names nothing protocol-specific; every protocol with crash recovery has an outage backlog and the two natural semantics for it (replay first, or defer until settled) are the two arms, with the stock interleaving between them. A bug that needs the backlog to act on the fresh restart state reads up; a bug that needs the recovery handshake to finish first reads down; protocols without crashes are inert.
- Frozen prediction (rewritten by the judge at admission): {"treatmentBit": {"name": "receiverGhostsFirst", "value": 65536, "shift": 16, "nestedIn": [], "reuse": "row 65536 renamed from ghostPeerAnswer (closed iteration 18; run_variant.rs sets no bit 16); NOTE the kept entry opening-round-first-at-recovering-receiver also names this bit - operator resolves at admission, 1073741824 (restartAfterPeerSettle, closed iteration 32) is the alternative", "salt": "own (BUFFIRST)", "treatedShareOfAllRuns": 0.47, "controlShareOfAllRuns": 0.47, "probesExempt": "run-cap and timer-context probes never treated", "exclusivity": "not drawn on any run treated by a receiver-side hold if one is in the tree"}, "rung": "depth>=8 (epoch 14 primary), per-run ratio treated / untreated, probe-free, co-bit matched", "band": [0.8, 1.0], "bandNote": "Frozen as a small COST, not the proposed loss: no chain record is a receiver-ghost, so the only VR effect is the fresh RecoveryResponses to a restarted node waiting a few steps behind a small outage backlog in the runs that have one. A read above 1.02 says the mask touched nothing (check episodes); a read below 0.70 says fresh chain records beyond the backlog window were held (implementation check).", "advanceRungs": {"depth>=9": {"expected": [0.75, 1.0], "reported": true}, "depth>=10": {"reported": true}, "depth>=6 and depth>=7": {"expected": [0.95, 1.02], "reported": true}}, "panelCells": {"readOn": "grader panel --binary <candidate> --members paxos-fixed-forget-promise,raft-forget-vote,paxos-fixed-recover-forget-accepted,paxos-fixed-host-control,paxos-accept-stale-ballot,mencius-opt1-2,raft-stale-vote,paxos-fixed-recover-stale-scout --seed <s> --scale 3, cell receiverGhostsFirst (65536), matched control = bit clear; pooling per the cell arithmetic from research/lite/state/panel", "expectedUp": [{"member": "paxos-fixed-forget-promise", "direction": "up", "expected": ">= 2.0 per run", "runsPerRead": "runsPerConfig 20000 -> about 480,000 runs per seed (479,513 observed), about 70 s explore", "eventsPerRead": "rate 9.2e-5: about 44 per seed, 22 per half at the base rate", "seeds": "1000 after the grade; 1001-1003 pooled at the review. A >= 2x lift confirms on two pooled seeds (z about 2.9); 1.5x is NOT confirmable within four seeds (z about 2.3) and is REPORTED, never a keep criterion", "why": "the superseded P2a pending across the acceptor's crash is delivered before any new-ballot P1a; with acceptor_ballot forgotten it is accepted"}, {"member": "raft-forget-vote", "direction": "up", "expected": ">= 2.0 per run", "runsPerRead": "runsPerConfig 40000 -> 2,880,000 runs per seed, about 390 s explore", "eventsPerRead": "rate 2.7e-5: about 78 per seed, 39 per half", "seeds": "1000 and 1001 pooled (about 13 min) confirm a >= 2x lift at z 2.7; a third seed allowed; 1.5x cannot be confirmed within three seeds and is REPORTED", "why": "a RequestVote buffered during the outage is answered before the leader's AppendEntries; with voted_for forgotten the node votes twice in one term"}, {"member": "paxos-fixed-recover-forget-accepted", "direction": "up", "expected": "reported until calibrated", "precondition": "calibrate first (three seeds x 480,000 against paxos-fixed-host-control, join at >= 20x separation), then read like forget-promise"}], "expectedDown": [{"member": "paxos-fixed-recover-stale-scout", "expected": "reported"}, {"member": "raft-stale-vote", "expected": "reported"}], "expectedFlat": [{"member": "paxos-accept-stale-ballot", "expected": [0.9, 1.1]}, {"member": "mencius-opt1-2", "expected": "flat (null row)"}, {"member": "paxos-fixed-host-control", "expected": "0 violations"}], "upDefinition": "a cell reads UP when the pooled ratio's 2.7-sigma lower edge (overdispersion 1.3) is above 1, ratio - 1 >= 0.02, and both halves carry >= 5 violations - the grader's own 'up'. Pool by summing treatedRuns/treatedViolations and controlRuns/controlViolations per member from research/lite/state/panel/<iso>/<member>/{porcupine,runs}.json.", "notUpDefinition": "a named member is NOT up when, after its specified pooled seeds, the cell reads flat or down, or reads count-only with pooled treated violations >= 15 and ratio < 1.5.", "powerNote": "at the half share the treated and control halves are equal; forget-promise resolves 2x on two pooled seeds, raft-forget-vote 2x on two; nothing below 2x is decidable at these member sizes"}, "firing": {"counter": "receiver_ghosts_first.holds", "floorPerChunk": 60000, "also": ["episodes (recoveries with pending > 0) reported per chunk with the share of recoveries they are (expected 0.15-0.45); an episode share below 0.05 closes the round as inert", "released.drained / holds >= 0.80", "released.cap / holds <= 0.15", "hold_steps_sum / holds in [1, 8]", "pending_at_restart histogram {1, 2, 3+}", "both-halves census: receiver-ghost entries per run within 5% across halves; acted share per half"]}, "independentObservable": "treated receiver-ghost acted share <= 0.7x control (the backlog lands on a node still recovering more often); among treated recoveries with a non-empty backlog the share whose first message entry after restart is a receiver-ghost >= 0.90 against control's coin; on a kept explore, treated depth>=8 runs show no held record addressed to the restarted node that was sent after its restart and waited past the backlog drain (exact, 0)", "falsifier": "depth>=8 interval entirely below 0.70 (implementation check); or holds below 60,000 per chunk or episode share below 0.05 (inert; close without a rate read); or released.drained / holds < 0.60; or steps per run > 1.03x; or plan_complete more than 2 points apart; or crashes or recovers per run off by 1%; or, on the panel, neither forget-promise nor raft-forget-vote UP after its specified pooled seeds (remove the arm, keep the census, file 'no burst-side member')", "vrCost": "tree-level price at the half: 0.47 x (1 - band) = 0-10% of depth>=8 events per chunk. Acceptable: cross-binary depth>=8 per second >= 0.88 of the paired cache at the half; throughput >= 0.97; wall per step within 1% across halves", "decisionMap": "depth>=8 in [0.80, 1.00], cost met, and a named member UP after pooled seeds -> merge at a QUARTER share (re-read the panel at the quarter before the share is recorded) as the burst side; band met, no named member up -> remove the arm, keep the census, file 'no burst-side member'; depth>=8 below 0.70 -> implementation check; above 1.02 with the episode floor met -> the mask is not binding, implementation check; cost failed -> close", "grading": "grader start --treatment-bit 65536 --band-min -0.20 --band-max 0.00, four chunks; panel on the candidate binary: forget-promise and raft-forget-vote at seed 1000 after the grade, pooled seeds at the review", "rewritten": true}
- Grading protocol: Build in the cost-0 form (bias tag at recover_crashed_node, no Record field). Resolve the bit-16 collision with kept openingRoundFirst at admission. Grade four chunks on the chosen bit, primary depth>=8 treated/untreated; episode share and drained ratio read on chunk 1 before any rung is credited; panel per panelCells.readOn; verdict by the decisionMap. Nothing below a 2x member lift is a keep.
- Judge: The VR-loss narrative is built on a false reading of run 572: 'the buffered route (run 572's) is closed on treated runs' and 'the buffered SVC 2->1 and DVC 2->1 drain into a node whose RecoveryResponses are held behind them'. In run 572 node 1 was down only from step 18 to 19 and completed recovery at 24; SVC/DVC 2->1 were sent at 25 to node 1's live incarnation and delivered at 30 and 33 - nothing on that route was buffered and this arm is inert on the violating run (no backlog at node 1's restart, so no episode). Structurally no chain record can be a receiver-ghost: VR.spur answers Recovery only at status 0 (line 403), never retries it (RecoverInit sends once), and needs 2 of 3 responses, so a chain in which node 1 is down when node 2 reacts to SVC 1->2 (node 2 then at status 1) deadlocks node 1's recovery. The arm's VR effect is therefore the residual: fresh records to a restarted node (RR 0->1, RR 2->1 at node 1; RR 0->2, RR 1->2 at node 2) held while a small backlog (node 0's Prep Notes: Cost 2 as proposed because dest_incarnation_at_send is a Record field stamped in exec.rs:268 and path.rs:203. A cost-0 form exists and is required: the buffered class already carries RECEIVER_RESTARTED; tag the still-queued class at recover_crashed_node with the same bias in the one queue scan the candidate already proposes (crash_node scans the queue at 1700), and count pending from those tags - no Record field, no exec.rs touch. If built that way expectedCost is 0. Exclusivity with the settle-hold sibling is moot if the sibling is not built (see rank 4). Bit 16 collision with kept openingRoundFirst must be resolved at admission. False claims named: ["'the buffered route (run 572's) is closed on treated runs' - run 572's SVC/DVC 2->1 were not buffered; node 1 was up and recovered when they were sent", "'at node 1 the buffered SVC 2->1 and DVC 2->1 drain into a node whose RecoveryResponses are held behind them' cannot occur on a chain-completing run (Recovery answered only at status 0, no retry, quorum 2 of 3)", "'1.5x on four [seeds]' for forget-promise is not confirmable under the 2.7-sigma rule at 22 events per half per seed"]

## receiver-ghost-hold-until-restart-settles

- kind: add | category: scheduler | origin: proposer | status: CLOSED at iteration 39 (judge rank 4, gain 2, cost 2 as proposed: its VR claim rested on a misread of run 572 - the chain's ghost StartViewChange and DoViewChange are sender-ghosts sent to the live incarnation at step 25, not records buffered at a crashed peer; no chain record can be a receiver-ghost because VR.spur answers Recovery only in normal status; no panel member predicted up, so no keep path) | parent: iteration-39 delivery-axis round
- Mechanism: New arm on the DELIVERY axis (how a message in flight across a crash is treated). Today a record addressed to node v while v is down is either moved into crash_info.queued_messages at crash_node (scheduler.rs:1690-1715) or when dispatched to the down node (scheduler.rs:1224-1231), and every buffered record is pushed back into the network queue the step v recovers (recover_crashed_node, scheduler.rs:1789-1797, tagged DeliveryBias::RECEIVER_RESTARTED); records sent to v during its downtime and not yet dispatched simply stay in the queue. Both classes then compete at once with the fresh traffic of v's restart and land on a node that is still recovering, where they act 2.2% of the time (deliveryEffects.receiver_restarted acted 12,493 / 551,728, three consecutive census reads). Mechanism: Record gains dest_incarnation_at_send: u32 (stamped beside origin_incarnation at exec.rs:268, path.rs:203, scheduler.rs:1917, excluded from Hash). A record whose dest_incarnation_at_send != state.incarnation(rec.node) is a receiver-ghost. SendLedger gains acted_entries (bumped at the message-entry site in scheduler.rs after exec when node_state_token changed; one u64 compare, ungated) and acted_at_restart and restart_step (set in recover_crashed_node beside entries_at_restart). On the treated half (bit 1 << 12, receiverGhostSettleHold, own salt RCVGHOST, run-cap and timer-context probes exempt), is_ineligible (scheduler.rs:832) masks a receiver-ghost record to v while acted_entries - acted_at_restart < 2 and current_step < restart_step + 64; records whose origin role differs from v's role (client requests) are never masked, so the request-timing axis is untouched. Liveness lift: when the mask leaves no eligible runnable in any queue the step is recomputed without it (as ghost-pending-timer-hold did); records stay in the network queue, so all_queues_empty and event accounting are unchanged. Releases are natural: the mask stops matching when the count reaches 2 or the cap passes. Counters (util_stats.rs block receiver_ghost_hold): masked_offers, holds (records masked at least once), released.{settled, cap, liveness}, hold_steps_sum, held_cross_role_exempt, and a both-halves O(1) census at the entry site: receiver_ghost_entries and receiver_ghost_acted per half, split buffered (RECEIVER_RESTARTED bias) versus queued, and by whether the origin's incarnation is also stale. Registration: run_variant.rs RECEIVER_GHOST_SETTLE_HOLD = 1 << 12; decide.ts VARIANT_BITS row 4096 receiverGhostSettleHold (the selftest fixture uses 4096 as its off-roster value, so that fixture moves to another value in the same commit; bit 30 renamed from restartAfterPeerSettle is the fallback if the operator prefers no fixture edit). No config field.
- Rationale: The violating corpus run (oracle-v2-epoch14.md run 572) reaches labels 8 and 9 through the crash buffer: SVC 2->1 and DVC 2->1 were dispatched at step 25 while node 1 was down, buffered, and re-delivered at 30 and 33, after node 1 had completed recovery (RR 0->1, RR 2->1) and taken the fresh Recovery 2->1 at 29. That order happened by luck: today the buffer is released into the queue at recover_nl and competes at every step, so the ghosts usually land while node 1 is still recovering, where VR.spur drops them (StartViewChange and DoViewChange return at status 2, VR.spur:301 and 385) - the receiver-recovering class that iterations 30 and 34 named as the residual loss at depth 8 and 9, and which no same-step swap reaches because the ghost and the recovery traffic are rarely co-eligible (an arrival gap, iteration 34). At a recovering node the only handler that writes is RecoveryResponse (VR.spur:430-444; Prepare, Recovery, SVC, DVC all return without writes at status != 0), so two acted deliveries since restart is the recovery-complete moment at n = 3, without naming it. The hold therefore delivers the buffered ghosts exactly when they can act, and it also holds a Recovery 2->1 or 1->2 that was sent while its receiver was down until that receiver is normal (Recovery returns at status != 0, VR.spur:403), rescuing run-3-shaped failures where the fresh Recovery lands on a recovering node and is dropped. Chain order check (the directive's question): the hold never puts a ghost before the fresh Recovery - at release the held SVC/DVC and a held Recovery are co-eligible and fresh-first (bit 24) takes the Recovery first, pair-order (bit 15) takes SVC before DVC; nothing addressed to a live incarnation is held, so RR 2->1 (sent after recover_nl to node 1's current incarnation) is never held and the recovery it completes is not delayed. This is why the directive's literal (b), 'hold all ghosts until the receiver recovers', would deadlock the chain (RR 2->1 is itself a dead-incarnation record that node 1 needs to finish recovering) and why the population here is receiver-ghosts, not sender-ghosts. Contrast with the closed holds: the orphan family (0.82 on depth 6) and the peer-settled Recover hold (0.45 on depth 8) held chain records (the ghost SVC 1->2 at label 4, the Recover at label 6-7) on blind 96-step budgets that expired 90% of the time; this holds records that act 2.2% of the time today, keyed on the receiver's own progress that arrives within a few steps of its restart, with a 64-step cap as the backstop. Depth cost argument: the held population is 0.3-0.4% of deliveries (about 1.8 per run) and today nearly inert, so the hold displaces no productive dispatch; the risk is a receiver that never settles (its peers down), bounded by the cap and the liveness lift.
- Generality: Rule: a message addressed to an incarnation of its receiver that no longer exists is delivered only after the restarted receiver has acted on two messages since it came back, or after 64 steps. It names no handler, message or role. Every crash-recovery protocol has a restart during which the node ignores or defers most traffic (VR recovery, Raft's RecoverInit re-reading persisted state, Paxos acceptors re-loading promises); the arm makes the messages that arrived during the outage land after that window instead of inside it. The stock half keeps immediate drain, so a bug that needs a stale message to act at the instant of restart (the panel's forget-promise and forget-vote members) keeps its route; the per-cell panel shows which side each member's bug lives on. Inert on protocols without crashes (mencius null row) and on runs with no restart.
- Frozen prediction (rewritten by the judge at admission): {"treatmentBit": {"name": "receiverGhostSettleHold", "value": 4096, "shift": 12, "nestedIn": [], "salt": "own (RCVGHOST)", "treatedShareOfAllRuns": 0.47, "controlShareOfAllRuns": 0.47, "probesExempt": "run-cap and timer-context probes never treated", "registration": "run_variant.rs RECEIVER_GHOST_SETTLE_HOLD; decide.ts VARIANT_BITS row 4096 with the selftest off-roster fixture moved in the same commit; bit 30 (restartAfterPeerSettle) is the no-fixture-edit fallback"}, "rung": "depth>=8 (epoch 14 primary), per-run ratio treated / untreated, probe-free, co-bit matched", "band": [0.97, 1.03], "bandNote": "Frozen as NULL. No record on the oracle chain is addressed to a dead incarnation of its receiver on a chain-completing run; the held population on chain-shaped runs is node 0's Prepare/Commit records sent during the outage, dropped at status 2 today and harmless after recovery. A read above 1.05 or below 0.95 is an implementation check (the mask touched a live-incarnation record).", "advanceRungs": {"depth>=9": {"expected": [0.95, 1.05], "reported": true}, "depth>=10": {"reported": true}, "depth>=6 and depth>=7": {"expected": [0.98, 1.03], "reported": true}}, "panelCells": {"readOn": "grader panel --binary <candidate> --members paxos-accept-stale-ballot,mencius-opt1-2,raft-stale-vote,paxos-fixed-recover-stale-scout,paxos-fixed-forget-promise,raft-forget-vote,paxos-fixed-host-control --seed 1000 --scale 3, cell receiverGhostSettleHold (4096); pool seeds 1001-1003 for the slow members", "expectedUp": [], "expectedDown": [{"member": "paxos-fixed-forget-promise", "expected": [0.4, 1.0]}, {"member": "raft-forget-vote", "expected": [0.4, 1.0]}, {"member": "paxos-fixed-recover-stale-scout", "expected": [0.3, 1.0]}], "expectedFlat": [{"member": "paxos-accept-stale-ballot", "expected": [0.9, 1.1]}, {"member": "mencius-opt1-2", "expected": "flat (null row)"}, {"member": "paxos-fixed-host-control", "expected": "0 violations"}, {"member": "raft-stale-vote", "expected": "reported"}], "upDefinition": "a cell reads UP when the pooled ratio's 2.7-sigma lower edge (overdispersion 1.3) is above 1, ratio - 1 >= 0.02, and both halves carry >= 5 violations - the grader's own 'up'. Pool by summing treatedRuns/treatedViolations and controlRuns/controlViolations per member from research/lite/state/panel/<iso>/<member>/{porcupine,runs}.json.", "notUpDefinition": "a named member is NOT up when, after its specified pooled seeds, the cell reads flat or down, or reads count-only with pooled treated violations >= 15 and ratio < 1.5.", "keepRule": "with no member expected UP and VR null, there is no keep path under the operator's arm rule; the round's only product is the census and the down cells"}, "firing": {"counter": "receiver_ghost_hold.holds", "floorPerChunk": 100000, "also": ["released.settled / holds >= 0.60", "released.cap / holds <= 0.30", "hold_steps_sum / holds in [3, 25]", "held_cross_role_exempt reported", "both-halves census: receiver-ghost entries per run within 5% across halves; acted share per half; buffered vs queued split; on depth>=8 runs the count of held records addressed to the node that restarted first (expected about 0 chain records; any SVC/DVC/Recovery held on a depth>=8 run is reported with its run id)"]}, "independentObservable": "treated receiver-ghost acted share >= 2.0x control (control 0.02-0.03); on depth>=8 treated runs, held records are Prepare/Commit-shaped (origin never crashed in the run) in >= 0.95 of holds - the check that the chain's records are untouched", "falsifier": "depth>=8 outside [0.95, 1.05] (implementation check); or released.settled / holds < 0.50; or treated acted share < 1.5x control; or holds below 100,000 per chunk; or steps per run > 1.03x; or plan_complete more than 2 points apart", "cost": "cross-binary throughput >= 0.97 of the paired cache; wall per step within 1% across halves; the Record grows by 4 bytes (or 0 in the bias-tag form)", "decisionMap": "null band met and observables met -> file the census (no arm kept: nothing reads UP by the candidate's own panel table); any named member unexpectedly UP after pooled seeds -> re-propose as a panel-side arm with that member named; band missed -> implementation check; cost failed -> close", "grading": "grader start --treatment-bit 4096 --band-min -0.03 --band-max 0.03, four chunks; panel quick set at seed 1000 after the grade", "rewritten": true}
- Grading protocol: Not recommended for a session. If run: build in the bias-tag form (cost 0), grade four chunks on the null band, read the chain-record hold count on chunk 1 (expected 0), panel quick set after; file the census regardless of outcome.
- Judge: The central checkable claim is false. The candidate says run 572's SVC 2->1 and DVC 2->1 'were dispatched at step 25 while node 1 was down, buffered, and re-delivered at 30 and 33 after node 1 had completed recovery'. The run record (tmp/loop/precision/plan, debug combined --run-id 572) shows node 1 crashed at step 18, recovered at 19 (Recovery sent 19), RR 0->1 at 22, RR 2->1 at 24 with 'recovery complete' logged at 24; node 2 took the ghost SVC 1->2 at 25 and SENT SVC 2->1 and DVC 2->1 at 25 (the trace's 'Dispatch' rows are sender-side sends) to node 1's live, already-recovered incarnation; node 2 crashed at 26. Those two records are sender-ghosts only; dest_incarnation_at_send equals node 1's incarnation at delivery, so the hold never touches them. The plan's 'dispatched @25' was misread as a scheduler dispatch to a down node. Worse, this is not a detail of one run: on any chain-completing run node 1 must be up when node 2 reacts, because VR.spur answers Recovery only at status 0 (l Notes: Cost 2 as proposed (Record field stamped at exec.rs:268). Kept only because the rubric's reject list does not cover it; it should not be scheduled ahead of ranks 1-3. If the operator wants the receiver-ghost census (buffered vs still-queued split, acted share per class), it rides along with rank 3 at zero cost - both candidates propose the identical census. The correct sibling for the receiver-recovering class remains the kept opening-round-first entry (which holds the fresh Recovery too), and iteration 34's arrival-gap finding already says why a hold there costs depth 8. False claims named: ["'SVC 2->1 and DVC 2->1 were dispatched at step 25 while node 1 was down, buffered, and re-delivered at 30 and 33' - node 1 recovered at 19 and completed recovery at 24; both records were sent at 25 to the live incarnation and are not receiver-ghosts", "'the hold therefore delivers the buffered ghosts exactly when they can act' and the depth>=8 band [1.05, 1.35] - no chain record is a receiver-ghost on a chain-completing run (Recovery answered only at status 0, no retry, quorum 2 of 3)", "'rescuing run-3-shaped failures where the fresh Recovery lands on a recovering node' - a Recovery 2->1 that is a receiver-ghost implies node 1 down at label 6, hence at label 4, hence a dead chain", "'StartViewChange and DoViewChange return at status 2, VR.spur:301 and 385' - 385 is StartView; DoViewChan

## crash-arm-table-by-fault-index

- kind: add | category: scheduler | origin: operator-agent | status: CLOSED at iteration 41 (refuted on its own band [0.97, 1.05]: matched depth>=8 0.828 [0.760, 0.903] though the first crash was untouched - quiet arms on fault index 1 exactly 0, fan-out arms unchanged there - so the depth-8 loss belongs to the SECOND crash, which is the one whose in-flight sends become the chain ghosts at labels 8 and 9; the 8-to-9 conversion gain replicated exactly (1.29 here, 1.55 at iteration 38 on a wider control) but cannot pay for the loss) | parent:
  crash-quiet-phase-arms (closed) and crash-phase (merged)
- Mechanism: the crash-phase arm table is chosen per fault index within the
  run instead of per run: the first crash draws from the fan-out table
  {EARLY, MID, STOCK} (the chain's initiating crash needs sends in flight),
  the second and later crashes draw from the quiet table {LANDED, ANSWERED,
  STOCK} on a salted half of the anchored runs (a new bit; probes exempt by
  inheritance); everything else as merged (window, reserve, landing-node
  read).
- Why: iteration 38 put the quiet table on every crash of a run and read
  depth>=8 0.83 (the initiating crash lost its in-flight sends) but
  depth>=9 1.29 [1.11, 1.50] separated up and depth>=10 1.49, with plan
  completion up 4 points: a quiet second crash converts depth 8 to depth 9
  better than a fan-out-timed one. The chain's second crash (node 2 after
  its StartViewChange and DoViewChange have been sent) is exactly a
  landed-or-answered moment. Splitting the table by fault index keeps the
  initiating crash in flight and gives the second crash the quiet timing.
- Frozen prediction (draft; the judge rewrites): depth>=8 in [0.97, 1.05]
  (the first crash unchanged); decisive depth>=9 treated/untreated >= 1.15
  with lower edge above 1.0 over four chunks, depth>=10 reported; firing
  crash_phase.quiet.{landed,answered}.armed counted only on second-or-later
  crashes, first-crash quiet arms exactly zero; independent observable:
  in-flight share at apply on condition-released second crashes <= 0.20
  against the fan-out arms' 0.84; falsifier depth>=9 interval entirely
  below 1.0 or depth>=8 below 0.95; cost throughput >= 0.97. Panel cells on
  the candidate binary reported for the forget members.

## stale-first-at-settled-receiver-only

- kind: add | category: scheduler | origin: operator-agent | status:
  KEPT at iteration 40 (judge gain 2, cost 0, rank 6; prediction rewritten: Ranked last and NOT recommended for a session. It is kept rather than rejected because it has falsifiable content and a sound mechanism argument for a smaller VR loss, and because if the operator ever funds the slow-set read it becomes decidable in one seed. Do not schedule it ahead of ranks 1-3. If) | parent:
  stale-first-same-pair-dispatch (closed) and fresh-first (merged)
- Mechanism: the stale-first preference narrowed to the contests where the
  reversal is plausibly wanted: the destination has completed a restart in
  this run (its first delivery-triggered entry since the restart has acted)
  and the contest is the first ghost of that pair, not every ghost. Every
  other same-pair contest keeps the merged fresh-first order. Salted half
  of the fresh-first treated runs, own bit.
- Why: iteration 39 reversed every contest and cost three quarters of the
  depth-8 rate while the two stale-shaped panel members read 1.55 and 1.56
  without separating. The census says the stale quarter swapped 1.66M times
  with 0.46 repeats per swap; a first-ghost-only rule at a settled receiver
  cuts that by roughly the repeat factor and leaves the chain's depth-7/8
  order (where the receiver is still recovering) untouched, which is where
  the loss comes from.
- Frozen prediction (draft; the judge rewrites): depth>=8 in [0.85, 1.02]
  (a much smaller loss than 0.23, and the falsifier is a loss below 0.80);
  panel keep rule: raft-stale-vote and paxos-fixed-recover-stale-scout each
  >= 1.5 with the lower edge above 1.0 on three pooled seeds of the
  candidate binary; firing swaps_to_stale between 0.15 and 0.35 of the
  full arm's 1.66M per four chunks with repeat swaps under 0.05; cost
  throughput >= 0.97.

## origin-sticky-at-destination

- kind: add | category: scheduler | origin: proposer | status: CLOSED at iteration 43 in the admitted layer order (depth>=8 0.738 [0.718, 0.759] with the override counters exactly zero, against 0.749 when the arm sat above fresh-first: the layer position was NOT the cause and the iteration-42 filing's explanation is withdrawn). Sender grouping at a receiver costs about a quarter of depth 8 wherever it sits, while depths 6 and 7 lose 3.5 percent and depth 9 falls with 8 (0.780). The chain needs a recovering node to interleave its two peers, not to drain one; the inverse arm is the one with a case | parent: iteration-40 dispatch-draw round
- Mechanism: New arm on the DELIVERY axis, in core/scheduler.rs immediately before fresh_first_dispatch, plus a new simulator/origin_turn.rs. Verified gap: fresh_first_dispatch (scheduler.rs:1540-1600) and pair_order_dispatch (scheduler.rs:1617-1660) both require r.origin_node == origin AND r.node == dest, so they decide the incarnation class and the send ordinal WITHIN one sender-receiver pair and say nothing about which sender a receiver takes next. On the loop config that cross-origin order is decided by a k=10 near-greedy tournament over priorities drawn i.i.d. per record from a 0.30-wide band, so it is an unbiased coin the tree has never touched. On the treated half (own salt ORIGTURN, probes exempt) the step, when its draw fell on a remote record to destination D from origin O, takes instead the highest-priority eligible record to D from the origin D took its last message entry from, when one exists and that origin is not O; lowest queue index among equals. The destination's last-entry origin is a new per-destination field in origin_turn::RunState, written at the existing message-entry site (scheduler.rs:1264-1300, where fresh_first.note_entry already runs) but NOT gated on util_stats::enabled(), since the preference reads it on every treated step. Layering, which is the point: origin (this arm) -> incarnation class (fresh-first) -> send ordinal (pair order), each refining inside the previous one's choice, so nothing merged is undone; both later preferences still receive the full eligible slice. Nothing is masked or held; the displaced record stays eligible. No config field. run_variant.rs ORIGIN_STICKY = 1 << 26 (67108864, retired row renamed in decide.ts VARIANT_BITS). New util_stats.rs block origin_turn: {contests, sticky_swaps, repeat_swaps, no_last_origin, same_origin_already, taken_hist} on the treated half, and an arm-blind census on a salted sixteenth of runs: consecutive_same_origin_entries and the run-length histogram of same-origin entry streaks per destination, on both halves.
- Rationale: The VR-side case is the chain itself. Oracle labels 7, 8 and 9 are three deliveries from node 2 to node 1 - the post-restart Recovery, then the ghost StartViewChange, then the ghost DoViewChange - and the tree biases only the order among them (fresh-first the class, pair order the ordinal). What decides whether node 1 takes those three from node 2 rather than interleaving records from node 0 is the raw priority tournament, which on the loop config is a coin with no bias at all. An origin-sticky preference makes a destination finish hearing from the sender it last heard from before switching, which is exactly the shape a fan-out-then-crash chain needs at its receiver. It is also the arm the record's own decomposition is missing: the loop has merged a class preference and an ordinal preference inside a pair and has never touched the choice of pair, and 'which peer does this node hear from next' is a first-class scheduling decision in every message-passing protocol. Against the alternatives the operator named: a PCT-style demotion of the top eligible record would perturb exactly this order but without direction, and an unbiased perturbation cannot beat a directed one when the tree's own measurement says direction is worth a factor of four (iteration 39); a reversed pair send order is a bias on an order the loop has already priced at about 15 percent of depth 9 with a known sign, so it buys a known loss. Honest position on the keep rule: this arm's case is the VR primary and it should close if it loses there. Its opposite side, origin alternation, is the arm with the panel case (paxos-accept-stale-ballot's bug is two proposers' commands contesting one acceptor, a cross-origin same-destination contest; raft-accept-stale-term-append is two leaders' appends at one follower) and is the follow-up to build whichever way this reads, since the two are one boolean apart in the same code.
- Frozen prediction (rewritten by the judge): {"treatmentBit": {"name": "originSticky", "value": 67108864, "shift": 26, "nestedIn": [], "reuse": "VARIANT_BITS row 67108864 renamed from ghostPendingTimerHoldLong; verified unset in spur-core", "salt": "own (ORIGTURN)", "share": "0.5 of non-probe runs", "controlShareOfAllRuns": 0.47, "probesExempt": "run-cap and timer-context probes never treated", "registration": "run_variant.rs ORIGIN_STICKY plus the decide.ts VARIANT_BITS rename, same commit"}, "mechanism": "At node 1 the chain's labels 7, 8 and 9 are three deliveries from node 2. Their relative order is already set by fresh-first and pair order; what stickiness adds is that once node 1 has taken one 2->1 record, the remaining ones come before node 0's traffic, so fewer node-0 entries fall between them and fewer chances arise for node 1's status or view to move and drop the ghost SVC and DVC at status != 0. The cost side is symmetric and is priced into the band: in the runs where node 1's last pre-chain entry is from node 0, the arm delays the chain instead.", "rung": "depth>=8 (epoch 14 primary), per-run ratio treated/untreated, probe-free, co-bit matched", "band": [0.98, 1.12], "bandNote": "Widened downward from the proposed [1.02, 1.15] to admit the coin-amplifier risk: at three servers the rule is 'repeat the last origin', and about half of runs will amplify the wrong origin at node 1. A read entirely above 1.02 is the arm working; a read in [0.98, 1.02] is the two sides cancelling and is a null, not a merge; a read entirely below 0.95 closes it.", "sizePct": {"min": -0.02, "max": 0.12}, "advanceRungs": {"depth>=9": "expected [1.00, 1.30], reported - the SVC-then-DVC pair is where grouping should bite hardest", "depth>=10": "reported; label 11 (PrepareOK 2->0 before StartView 1->0 at node 0) is itself a cross-origin order and is the rung where the inverse arm would speak", "depth>=6 and depth>=7": "expected [0.98, 1.03]; a read below 0.95 is an implementation check"}, "firing": {"counter": "origin_turn.sticky_swaps", "floorPerChunk": 40000, "also": ["origin_turn.contests per treated run reported; below 0.5 the contest does not exist and the arm is inapplicable", "origin_turn.no_last_origin and same_origin_already reported, so the three ways the rule declines are separable", "origin_turn.repeat_swaps / sticky_swaps <= 0.25 with the taken histogram", "exact: on a treated step where the drawn record's origin already equals the destination's last-entry origin, the pick is unchanged (0 swaps) - the rule must not become a second greedy pass"]}, "independentObservable": "The origin_turn census carries its OWN treated/untreated slots keyed on the ORIGTURN flag, sampled on a salted sixteenth of runs on both halves (the iteration-29 hot-path lesson). Two reads, both per chunk, neither the rung: (1) the mean same-origin message-entry streak per destination is at least 1.25x on the treated half; (2) the share of message entries whose origin equals that destination's previous entry origin is at least 1.20x the MEASURED untreated share on the same census - the untreated share is an output of this census, not a value assumed in advance.", "falsifier": "depth>=8 treated/untreated interval entirely below 1.00 over four chunks (close the arm; propose origin alternation, the same code with the test inverted, with paxos-accept-stale-ballot named UP); or the interval entirely inside [0.98, 1.02] with the streak observable met (the two sides cancelled: close and record the null as the price of the coin at three servers); or origin_turn.sticky_swaps below 40,000 per chunk; or origin_turn.contests per treated run below 0.5 (inapplicable); or the streak observable below 1.10x (the swap did not change what it claims to change: implementation check before any rung is credited); or any swap on a step whose drawn origin already equals the last-entry origin (exact, 0); or steps per run above 1.03x; or plan_complete more than 2 points apart.", "panelCells": {"keepRuleRequired": false, "why": "the arm predicts no VR loss; its own keepIfVrLoses is NONE and stands", "readOn": "grader panel --binary <candidate> --members paxos-accept-stale-ballot,mencius-opt1-2,raft-stale-vote,paxos-fixed-recover-forget-accepted --seed 1000 --scale 3, cell originSticky (67108864), matched control = bit clear", "expectedDown": [{"member": "paxos-accept-stale-ballot", "expected": "[0.85, 1.00]; its bug needs a cross-origin contest at one acceptor, which stickiness suppresses. About 3,350 violations at seed 1000 scale 3, about 1,675 per half, so a 6 percent move resolves - the only member on the panel with that power. A DOWN cell here is the arm's bias made visible and is the direct evidence for building origin alternation next."}], "expectedFlat": [{"member": "mencius-opt1-2", "expected": "flat; it has no crashes but it does have destinations, so a move here is a real read and is recorded"}], "reported": [{"member": "raft-stale-vote", "expected": "reported"}, {"member": "paxos-fixed-recover-forget-accepted", "expected": "reported"}], "keepIfVrLoses": "NONE. This is a VR-side arm and it closes on a VR-primary loss or on a cancelled null. No panel member rescues it."}, "cost": "cross-binary throughput >= 0.97 of the paired cache; wall per step within 1 percent between halves. One pass over the already-built eligible slice at network steps only, plus one ungated integer write per message entry - the same shape and site as fresh_first_dispatch, which cost nothing measurable when it merged. A read in [0.94, 0.97) with steps per run within 1.03x is build layout; below 0.94 refutes.", "orderOfOperations": "origin_turn -> fresh_first -> pair_order, called immediately before fresh_first_dispatch in the Network branch (scheduler.rs:1054), so both merged preferences refine inside the chosen pair and receive the full eligible slice. The swap consumes no random draw, so a treated and an untreated run read the same random sequence at every step.", "rewritten": true}
- Judge: The stated mechanism is wrong as written and I rewrote it. The oracle DAG constrains the RELATIVE order of labels 7, 8, 9, not their adjacency, and the order among them is already decided by the two merged preferences (fresh-first puts the Recovery before the ghosts; pair order puts SVC before DVC). So 'making the receiver finish with that sender raises the probability that all three land in order' does not follow: node 0's records interleaving at node 1 break nothing in the DAG. What stickiness actually buys is temporal grouping - fewer node-0 entries between the three, hence fewer chances for node 1's status or view to move and cause the ghost SVC and DVC to be dropped at status != 0 - plus, once node 1 has taken the Recovery 2->1, its next two entries from node 2 come ahead of node 0's  Notes: Nearest pool neighbours checked for dedupe: restart-opening-send-first-at-every-peer (HELD at 26) is about a sender's opening send ordinal, not about which sender a receiver hears from; pair-order-drawn-class-fresh-stale-stock is a class preference inside a pair. Neither overlaps. This is a genuinely untouched layer of the same-step decision and the honest keepIfVrLoses NONE is the right posture for this round. False claims named: ["'Making the receiver finish with that sender before switching raises the per-run probability that all three land in order, which is the primary rung's own condition.' The DAG constrains relative order only, and the order among labels 7-9 is already set by the two merged preferences. The mechanism clause has been rewritten to the grouping-and-interference argument, which is what the arm can actually claim.", "'In the arm-blind census, ... the share of message entries whose origin equals the destination's previous entry origin is at least 0.55 on treated against a control expected near 1/(serv

## pair-send-order-ghost-class-only

- kind: add | category: scheduler | origin: proposer | status: DECIDED at iteration 44 - simplify the merged rule to the ghost class (depth>=8 ghost-only over merged 1.0074 [0.9524, 1.0657], the null held inside its band while 3,644,866 fresh-class corrections were suppressed, 64 percent of the merged rule's firing; depth>=9 1.011, depth>=10 0.833 unresolved on small counts; throughput 1.010) | parent: iteration-40 dispatch-draw round
- Mechanism: Nested ablation arm inside the merged pairSendOrder half (bit 1 << 15). pair_order_dispatch (scheduler.rs:1617-1660) today fires whenever the picked record's SENDER has crashed at least once in the run - state.incarnation(origin) > 0 or the origin is currently down - and then takes the eligible record of the same origin, destination and origin_incarnation with the lowest send ordinal. That covers both the dead incarnation's records and the CURRENT incarnation's, but iteration 29's evidence and the module's own doc comment are about one class: 'two records from the same dead incarnation to the same peer in send order'. On a salted half of the pairSendOrder treated runs (own salt PAIRGHOST, set only when PAIR_SEND_ORDER is set, probes exempt by inheritance) the rule is narrowed to picks whose origin_incarnation differs from state.incarnation(origin) - the ghost class only - and every same-incarnation-live-sender pick keeps the draw's order. No other change: same gate on the sender's ledger, same contest scan, same census, no random draw consumed, nothing masked. run_variant.rs PAIR_ORDER_GHOST_ONLY = 1 << 29 (536870912, retired row renamed in decide.ts VARIANT_BITS), set only with PAIR_SEND_ORDER. New util_stats.rs counters in the pair_order block, third slot ghost_only: {corrections_ghost, corrections_fresh_suppressed (the corrections the full rule would have made on a live-incarnation pick and this arm does not), contests_by_class{ghost, fresh}}, with contests_by_class counted on the full merged half as well so the two classes' shares of the merged rule's firing are known for the first time.
- Rationale: Three reasons this is worth one grade. First, it prices a merged mechanism that has never been split: the loop knows pairSendOrder is worth about 10-15 percent of depth 9 but not which class carries it, and the same nested-ablation move at iteration 33 removed the fan-out window from the client release and named the deferral as the whole lever, which is the highest-value-per-chunk result the loop has had. Second, it is a NARROWING, which the standing directive prefers over a reversal after two opposite-side arms closed on their VR cost: the ghost-class order that the evidence supports is retained in full, so the arm's downside is bounded by whatever the live-sender half was contributing, unlike iteration 39's reversal which cost three quarters of depth 8. Third, the bias it removes is real and undirected: forcing a live sender's records to a peer into send ordinal order is a FIFO-like constraint the tree imposes on every crashed-at-least-once sender for the rest of the run, and it suppresses exactly the reorderings that panel members whose bugs need a later message before an earlier one from a live leader depend on. The honest risk, stated so the grade can see it: at node 2's post-restart fan-out the Recovery is a low-ordinal send of the LIVE incarnation, so the merged rule may be part of what puts label 7 before node 2's later sends; if depth>=9 falls the answer is that the fresh class carries part of the merged effect, and that is itself the finding the ablation is for.
- Frozen prediction (rewritten by the judge): {"treatmentBit": {"name": "pairOrderGhostOnly", "value": 536870912, "shift": 29, "nestedIn": ["pairSendOrder (32768)"], "reuse": "VARIANT_BITS row 536870912 renamed from recoverPreempt; verified unset in spur-core", "salt": "own (PAIRGHOST), drawn within pair_order::is_treated(run_id)", "share": "about 0.235 of all runs", "controlShareOfAllRuns": "0.235 (pairSendOrder set, this bit clear); the stock half (0.47) is the third cell", "probesExempt": "by inheritance from pairSendOrder", "registration": "run_variant.rs PAIR_ORDER_GHOST_ONLY set only with PAIR_SEND_ORDER, plus the decide.ts VARIANT_BITS rename, same commit"}, "mechanism": "The narrowed rule keeps the ordinal ordering of a sender's DEAD incarnation's records to one peer - which is the class the chain's label-8-before-label-9 correction belongs to - and returns the live sender's ordering, likely about two thirds of the merged rule's corrections by volume, to the priority draw. Label 8 is a class order at node 1 decided by fresh-first, not an ordinal order, so the primary is expected null; the rung that can move is depth>=9, where the merged gain lives.", "rung": "depth>=8 (epoch 14 primary), per-run ratio ghost-only quarter / full merged quarter, probe-free, co-bit matched", "band": [0.95, 1.05], "sizePct": {"min": -0.05, "max": 0.05}, "decisiveRung": {"rung": "depth>=9", "expected": [0.95, 1.1], "requirement": "lower edge above 0.95 over four chunks", "why": "that is the null which says the ghost class carries the merged effect and the narrowing is free; a read below 0.95 says the live-sender half carries part of it, which is itself the finding"}, "advanceRungs": {"depth>=10": "reported", "depth>=6 and depth>=7": "expected [0.98, 1.02]"}, "firing": {"counter": "pair_order.ghost_only.corrections_fresh_suppressed", "floorPerChunk": 20000, "also": ["pair_order.contests_by_class{ghost, fresh} counted on the FULL merged quarter as well, so the two classes' shares of the merged rule's firing are known for the first time - this is the round's product regardless of the rung", "pair_order.ghost_only.corrections_ghost per treated run within 10 percent of the merged quarter's ghost-class corrections per run (the ghost path is unchanged by construction)", "exact: pair-entry inversions within a ghost class on the narrowed arm remain 0, matching the merged half's pair_order.census.treated.inversions of 0; live-class inversions rise from 0 toward the stock half's level (the merged half reads control inversions 159,182 against treated 0)"]}, "independentObservable": "The fresh class's share of the merged rule's corrections, read on the full merged quarter and never measured before, reported per chunk. Applicability floor: the fresh class must be at least 0.20 of merged corrections; below that the narrowing removes almost nothing and the read is inapplicable. The record's nearest estimate puts it near 0.65-0.70, so this floor is expected to clear easily and the clause exists to catch an implementation that narrowed the wrong way.", "falsifier": "depth>=9 ghost-only/full interval entirely below 0.95 (the live-sender half carries part of the merged effect: keep the merged rule as it stands and record the class split as the finding); or depth>=8 interval entirely outside [0.95, 1.05]; or corrections_fresh_suppressed below 20,000 per chunk; or the fresh class below 0.20 of merged corrections (inapplicable); or any ghost-class inversion on the narrowed arm (exact, implementation check); or ghost-class corrections per run more than 10 percent off the merged quarter's (implementation check).", "panelCells": {"keepRuleRequired": false, "why": "the arm predicts a null, not a loss; the panel is reported", "readOn": "grader panel --binary <candidate> --members raft-accept-stale-term-append,paxos-fixed-recover-forget-accepted,paxos-accept-stale-ballot,mencius-opt1-2 --seed 1000 --scale 3, cell pairOrderGhostOnly (536870912), matched control = pairSendOrder set with this bit clear; seeds 1001-1003 pooled for the stale-term member", "reported": [{"member": "raft-accept-stale-term-append", "expected": "reported; >= 1.15 would support the claim that the live-sender FIFO constraint suppresses bugs needing a later append before an earlier one from a live leader. About 1,337 violations over three pooled seeds at 8,640,000 runs each; at quarter cells one seed is count-only, so this is a pooled-seed read or nothing"}, {"member": "paxos-fixed-recover-forget-accepted", "expected": "reported"}, {"member": "paxos-accept-stale-ballot", "expected": "[0.95, 1.05]"}], "expectedFlat": [{"member": "mencius-opt1-2", "expected": "flat, null row - with no crashes both forms are inert"}]}, "cost": "cross-binary throughput >= 0.98 of the paired cache; wall per step within 1 percent across quarters. The narrowed arm does strictly less work than the merged rule (one integer compare that short-circuits before the queue scan on live-sender picks), so a throughput read below 1.00 is layout, not mechanism.", "decisionMap": "depth>=8 in [0.95, 1.05] and depth>=9 lower edge above 0.95 -> simplify the merged rule to the ghost class and record the class split. depth>=9 below 0.95 -> keep the merged rule as it stands, close the arm, record the split as the finding. Applicability floor missed -> file the class split as a census read.", "rewritten": true}
- Judge: The candidate frames this as a small narrowing whose downside is bounded. It is not small: the fresh (live-incarnation) class is very likely the MAJORITY of the merged rule's corrections, because after a restart a sender's post-restart traffic to a peer keeps arriving while its dead incarnation's records are a bounded set that drains. The nearest measurement in the record agrees - on the same-pair contested dispatches from restarted origins, fresh_first.census.treated reads stale_drawn 292,434 of contested_dispatches 948,310, so about 69 percent of those contests draw a live-incarnation record. So the arm removes most of the rule's firing, and 'the arm's downside is bounded by whatever the live-sender half was contributing' is a tautology dressed as a safety argument. What rescues it is th Notes: This is the cheapest build of the round (about 120 lines net including tests) and the only one whose merging outcome is a null, so it is the right second grade to run alongside a larger arm if two fit the session. Its product either way is the first split of pairSendOrder's firing by class, which the loop has never had. False claims named: ["'its downside is bounded by whatever the live-sender half was contributing, unlike iteration 39's reversal' - stated as a safety property, it is circular. The honest version, which I have written into the prediction, is that the removal is LARGE in volume (likely about two thirds of corrections) and expected null on the chain because the chain's ordinal correction is ghost-class; the ablation is safe for a reason the candidate did not give."]

## network-destination-episode-draw

- kind: add | category: scheduler | origin: proposer | status: KEPT at iteration 40 (judge gain 5, cost 0, rank 5) | parent: iteration-40 dispatch-draw round
- Mechanism: New arm on the DISPATCH DRAW itself, in core/scheduler.rs at the QueueSelection::Network branch (about line 1030-1050) plus a new simulator/net_episode.rs. Today a network step builds `eligible` over the whole network queue and hands all of it to select_within_queue, a k=10 tournament that is near-greedy on a priority stamped once at record creation (core/state.rs:84-87, record band center 0.5 width 0.15; Record::reset never touches it) and, on the loop config, on nothing else (novelty_enabled false, all steer_terms 0, so route_by_terms returns None and the score is a constant plus the priority term). On the treated half (own salt NETEPISODE, probes exempt) the network step instead runs an EPISODE: net_episode::RunState holds a focus destination and a remaining length. If the focus is set and at least one eligible record is addressed to it, the tournament is run over that destination's sub-slice only and the remaining length is decremented; otherwise a new episode is opened by drawing a destination uniformly among the distinct destinations present in `eligible` (one draw on a new Stream::NetFocus) with length L = 8 network steps. If no eligible record is addressed to the focus, the step falls through to the stock full-slice draw and the episode ends. Nothing is masked, held or made ineligible: is_ineligible, QueueInfo, the class roll and the purgatory are untouched, so no run can stall and the crash/recover/timer paths are unchanged. fresh_first_dispatch and pair_order_dispatch run afterwards over the FULL eligible slice exactly as today; every same-pair rival shares the drawn record's destination, so both merged preferences see the same candidate sets they see now. No config field. run_variant.rs NET_EPISODE_DRAW = 1 << 25 (33554432, retired row renamed in decide.ts VARIANT_BITS from its old name); bit 12 is free but the decide.ts selftest fixture uses 4096 as its off-roster value, so 33554432 is the cheaper reuse. New util_stats.rs block net_episode: {runs, episodes, focus_steps, fallthrough_steps, episode_len_hist, focus_bucket_size_hist{1,2,3,4plus}} on the treated half, plus an arm-blind census sampled on a salted sixteenth of runs (the iteration-29 lesson that a both-halves queue scan on the hot path cost 11 percent of a session): distinct_dests_hist{1,2,3plus} at network steps and same_dest_rivals_sum/entries, the mean number of eligible records sharing the drawn record's destination, read on both halves.
- Rationale: This is the partial-order question answered in the direction the evidence supports rather than the naive one. Two records to DIFFERENT destinations commute in the one-step sense - the simulator's state is partitioned by node, each handler reads and writes only its own node's state, and the commuting test is destination equality, one integer compare, so detection is cheap. But skipping a commuting choice buys nothing in a random-walk explorer with no backtrack or sleep set: the run executes every record either way, so the entropy is not recoverable. What the commuting analysis DOES say is where the ordering-relevant choices are - inside one destination's inbox - and the tree's whole dispatch portfolio agrees: fresh_first_dispatch and pair_order_dispatch both require same origin AND same destination, and reversing the first cost three quarters of depth 8 (iteration 39), so same-destination order is the single most valuable thing the draw decides. The deficiency this arm attacks is measured: iteration 34 found that at a recovering receiver the two contenders are 'almost never eligible in the same step' (143,000 firings displaced a fresh-first pick only 11,200 times) - an arrival gap, not a coin. A flat near-greedy draw over a small network queue keeps it that way, because a destination's records are consumed roughly as fast as they arrive and the queue never accumulates per destination. Serving one destination at a time makes every other destination accumulate, so when the focus moves the next destination has a real contest instead of a lone record. That is the lens's 'queue-policy shape that concentrates schedules on few decision points', and the codebase already contains the local-queue version of it: PreemptiveSelector holds an active_node for up to preempt_interval steps and 20 percent of grid runs draw it (explorer.rs:650-659). The network queue, where every cross-node ordering lives, has no such shape, and it is a minority of steps to begin with (p_local drawn in [0.6, 0.95] at explorer.rs:662, or set to 0.75-0.92 by the curriculum at curriculum.rs:182-188). Argued against and rejected in favour of this: a PCT arm on record priorities. PCT's amplification needs a long-lived priority-carrying entity, and this simulator has none - priority is stamped at creation and never revised, so demoting the top eligible record is a one-step perturbation, not a change to the rest of the schedule. And the arithmetic kills the uniform-step siting outright: at k = 2,200 steps, PCT's 1/(n*k^(d-1)) is about 7e-8 per run for d = 3 against a measured depth-8 rate of 1.1e-2, so change points must be anchored to protocol events, which is what every merged arm already is.
- Frozen prediction (rewritten by the judge): {"treatmentBit": {"name": "netEpisodeDraw", "value": 33554432, "shift": 25, "nestedIn": [], "reuse": "VARIANT_BITS row 33554432 renamed from ghostPendingTimerHold; verified unset in spur-core", "salt": "own (NETEPISODE)", "share": "0.5 of non-probe runs", "controlShareOfAllRuns": 0.47, "probesExempt": "run-cap and timer-context probes never treated", "registration": "run_variant.rs NET_EPISODE_DRAW plus the decide.ts rename, same commit"}, "mechanism": "Serving one destination's inbox for a bounded episode lets the other destinations accumulate, so a destination has more co-eligible records when it is next served. Same-destination co-eligibility is the necessary condition for a same-pair contest; the arm claims only the necessary condition and the census measures how much of it becomes same-pair. The cost side, priced into the band: records to unfocused destinations wait tens of network steps, and iteration 32 showed a 23-step hold on a chain record costs 55 percent of depth 8.", "rung": "depth>=8 (epoch 14 primary), per-run ratio treated/untreated, probe-free, co-bit matched", "band": [0.92, 1.15], "bandNote": "Widened from the proposed [1.03, 1.20] in both directions. Downward because the arm delays every unfocused destination's records by a dose comparable to the holds that have cost depth 8 before, and the candidate priced no downside at all; upward bound trimmed because the same-pair share of the same-destination gain is unbounded in the argument. A read entirely above 1.03 with the co-eligibility observable met is a merge; a read inside [0.98, 1.03] is a null and the arm closes with its census kept.", "sizePct": {"min": -0.08, "max": 0.15}, "advanceRungs": {"depth>=9": "expected [0.95, 1.25], reported", "depth>=10": "reported", "depth>=6 and depth>=7": "expected [0.97, 1.08]; a read below 0.95 says the delay is reaching the early chain and is an implementation check"}, "firing": {"counter": "net_episode.episodes", "floorPerChunk": 500000, "also": ["APPLICABILITY, read on chunk 1 before any rung is credited: mean episode length (focus_steps / episodes) at least 2.0, and focus_steps / (focus_steps + fallthrough_steps) at least 0.30. Below either, the episode ends as soon as it starts, L = 8 never binds and the arm is a random-destination-first draw rather than an episode - file as a shape read with no rung credited", "distinct_dests_hist{1,2,3plus} at network steps on both halves; distinct_dests_hist{2plus} below 0.30 of network steps means there is nothing to focus on and the arm is inapplicable", "episode_len_hist and focus_bucket_size_hist{1,2,3,4plus}", "NEW, required: delay census - the number of network steps a record spends in the queue while its destination is not the focus, mean and 90th percentile, on the treated half, reported against the treated half's mean queue residence. This is the depth-cost meter iteration 32's lesson demands and the candidate omitted"]}, "independentObservable": "The net_episode census carries its OWN treated/untreated slots keyed on the NETEPISODE flag, sampled on a salted sixteenth of runs on both halves. Two reads, neither the rung: (1) the mean number of eligible records sharing the drawn record's destination is at least 1.20x on the treated half; (2) the mean number of eligible records sharing the drawn record's ORIGIN AND destination - the pair-level quantity the merged preferences actually consume - is at least 1.10x on the treated half. Clause (2) is the one that decides whether the destination episode reaches the mechanism it claims, and it is new: without it the arm cannot distinguish a destination-wide effect from a pair-level one.", "falsifier": "depth>=8 treated/untreated interval entirely below 1.00 over four chunks (the shape costs what it was meant to buy: close, keep the census); or the interval entirely inside [0.98, 1.03] (null: close, keep the census); or the pair-level co-eligibility ratio below 1.05 (the episode produced no extra same-pair contests, which is the mechanism: inapplicable, file as a shape read); or mean episode length below 2.0 or focus share below 0.30 (the episode does not exist); or net_episode.episodes below 500,000 per chunk; or distinct_dests_hist{2plus} under 0.30 of network steps; or plan_complete more than 2 points apart; or steps per run above 1.03x.", "implementerMustDefine": "The eligible slice holds Record, ChannelSend, Partition and Heal runnables. The episode must define a focus destination for ChannelSend (the node of the waiting reader) or the step must fall through to the stock full-slice draw whenever the drawn item is not a Record - the choice must be stated in the plan and counted (net_episode.non_record_fallthroughs), because silently excluding channel sends from every focus defers the RPC reply path systematically and would be an unpredicted second bias inside the same bit.", "panelCells": {"keepRuleRequired": false, "why": "the arm predicts a gain, not a loss; it must stand on the VR rung", "readOn": "grader panel --binary <candidate> --members paxos-accept-stale-ballot,paxos-fixed-recover-forget-accepted,mencius-opt1-2,raft-stale-vote --seed 1000 --scale 3, cell netEpisodeDraw (33554432), matched control = bit clear", "reported": [{"member": "paxos-accept-stale-ballot", "expected": ">= 1.10 reported; about 3,350 violations at seed 1000 scale 3 splits to about 1,675 per half, so a 6 percent move resolves - the only member with that power. Its bug needs two commands co-eligible at one acceptor"}, {"member": "paxos-fixed-recover-forget-accepted", "expected": "reported; about 2,370 violations over three pooled seeds"}, {"member": "raft-stale-vote", "expected": "reported"}], "expectedFlat": [{"member": "mencius-opt1-2", "expected": "flat; it has no crashes but it does have destinations, so a move here is a real read and is recorded"}], "keepIfVrLoses": "NONE. Two opposite-side arms have now closed on their VR cost, and this arm's case is a VR-rung case; a VR loss closes it. If paxos-accept-stale-ballot reads UP on a losing arm that is recorded as a portfolio note, not a keep."}, "cost": "cross-binary throughput >= 0.97 of the paired cache; wall per step within 1 percent between halves. One extra traversal of the already-built eligible slice at network steps only, with no touch of is_ineligible - which is what cost the closed directed-link-speed arm 23 percent, since its mask ran inside the per-queue size computation on every step. A read in [0.94, 0.97) with steps per run within 1.03x is build layout; below 0.94 refutes.", "rewritten": true}
- Judge: Every code claim in this candidate checks out, and the mechanism argument does not. Three problems, in order of severity. (1) The episode focuses on a DESTINATION, but both merged preferences and the contest the candidate wants to create require the same PAIR (same origin AND same destination). Accumulating records at node 1 accumulates node 0's traffic alongside node 2's, so the same-pair co-eligibility the mechanism sentence promises rises only by the same-pair share of the same-destination gain. The candidate's own verified note states the same-origin-and-same-destination gate and then the mechanism sentence quietly drops the origin. (2) The episode almost certainly does not last. It ends the moment no eligible record is addressed to the focus, and at three servers the network queue is  Notes: Nearest pool neighbour is fresh-first-destination-wide-restart-episode (HELD at iteration 26, gain 4), which widens the fresh-first preference to destination scope; this candidate is the draw-side version of the same intuition and the ledger should record them as the two sides of one idea. Interaction with origin-sticky-at-destination: both act on the network draw; on independent salts they average over each other, but if both merge the joint cell must be read once. If only one grade fits beside rank 1, take origin-sticky - it is the same site with a directed mechanism. False claims named: ["'the simulator's state is partitioned by node, each handler reads and writes only its own node's state, and the commuting test is destination equality' - true of ROLE state (exec.rs reads and writes state.nodes[node_id.index]; the one cross-index write at exec.rs:655 is a local-channel reader on the same node) but not of the simulator state two records both touch: both mutate the shared network queue, the send ledger and the RNG stream, so destination equality is not a sound commuting test for the schedule, only for node-role state. The candidate does not use it for partial-order reduction, 

## crash-quiet-except-toward-restarted-peer

- kind: add | category: scheduler | origin: operator-agent | status:
  KEPT at iteration 44 (judge gain 5, cost 0, rank 3; iteration-42 corrections carried) | parent:
  crash-arm-table-by-fault-index (closed) and crash-quiet-phase-arms
  (closed)
- Mechanism: a fourth crash-phase arm, drawn beside EARLY, MID and STOCK on
  a salted half of the anchored placed runs: QUIET_EXCEPT_TARGET fires when
  the node's segment sends have all landed and its in-flight records are
  addressed only to nodes that have restarted in this run. So the crash
  keeps the sends the chain needs (the ghosts addressed to the recovered
  peer) and removes the rest of the traffic that a fan-out-timed crash
  leaves outstanding.
- Why: two sessions now separate the same two effects. Quiet timing on any
  crash costs depth 8 about a sixth (0.83 both times) and lifts the 8-to-9
  conversion about 1.3x; iteration 41 showed the loss is the second crash's,
  because that crash's in-flight sends ARE the ghost StartViewChange and
  DoViewChange of labels 8 and 9. The two readings together say: the chain
  wants a crash whose in-flight sends are exactly the ones addressed to the
  recovering peer, and nothing else. No existing arm can express that.
- Frozen prediction (draft; the judge rewrites): depth>=8 in [0.98, 1.15]
  (the loss disappears because the chain's ghosts survive); decisive
  depth>=9 treated/untreated >= 1.15 with the lower edge above 1.0 over
  four chunks; depth>=10 reported; firing: the new arm armed at least
  60,000 per chunk with released_on_condition over armed at least 0.4;
  independent observable: in-flight at apply on condition releases of the
  new arm between 0.5 and 0.9 (some in flight, unlike the quiet arms' 0.16)
  and the share of those in-flight records addressed to a restarted node
  at least 0.9; falsifier: depth>=8 below 0.95, or the addressed-share
  below 0.7 (the predicate is not selecting what it claims); cost
  throughput >= 0.97.

## origin-alternation-at-destination

- kind: add | category: scheduler | origin: operator-agent | status: CLOSED at iteration 45, and with it the sender-preference family (depth>=8 0.9486 [0.9099, 0.9890] separated below 1.0, depth>=9 0.895 separated down, plan completion 0.170 against 0.190; the override gate read exactly zero in every cell and the streak observable inverted to 0.74 of control, so the arm did what it claimed). The judge's red team is now an empirical result: a preference and its inverse both lose against the drawn order, 0.738 one way and 0.949 the other | parent:
  origin-sticky-at-destination (closed, both layer positions)
- Mechanism: the inverse of the closed arm and in the same place (the last
  dispatch layer, standing aside whenever fresh-first or pair order has a
  preference): among the records a destination could take that those layers
  rank equally, prefer one whose sender is NOT the sender that destination
  last took a delivery-triggered entry from. Same bit machinery, own salt,
  probes exempt; the closed arm's counters and streak census are reused
  unchanged, and the observable inverts (mean same-sender streak below the
  control's rather than above).
- Why: two sessions measured sender grouping at 0.749 and 0.738 on depth 8
  with the layer position ruled out, and depth 9 fell with it (0.780) while
  depths 6 and 7 barely moved (0.965). The rung that collapses is exactly
  the one that needs a recovering node to hear from BOTH peers: VR's
  recovery completes on responses from a majority including the primary,
  and labels 7 to 9 interleave node 0's and node 2's records at node 1.
  Grouping by sender drains one peer's queue first and delays the other;
  alternation does the opposite, and the loop has never had a mechanism
  that spreads a receiver's attention across senders.
- Frozen prediction (draft; the judge rewrites at admission): depth>=8 in
  [1.05, 1.35] - the mirror of a measured 0.74, so this is a real
  prediction rather than a hope, and a read below 1.00 closes the family
  for good; depth>=9 expected at or above depth>=8's ratio; firing swaps at
  least 100M per chunk with the override counters exactly zero (the same
  gate iteration 43 passed); independent observable: mean same-sender
  streak at a destination at most 0.80 of the control's (the closed arm
  read 1.567 the other way); falsifier: depth>=8 interval entirely below
  1.00, or the streak observable above 0.95; cost throughput >= 0.97.

## post-fault-request-rush-arm

- kind: add | category: scheduler | origin: proposer | status:
  MERGED at iteration 46 (spur 0500275). VR did not decide it: matched RUSH
  against STOCK over four chunks read depth>=8 1.060 [0.976, 1.151], above
  the frozen band and unseparated, and the grader printed `human`. The merge
  is on the pre-committed panel rule - paxos-fixed-recover-forget-accepted
  1.27 [1.01, 1.60] UP over six pooled seeds against the hold's 0.59 [0.47,
  0.75] DOWN, with all four crash-carrying members reading the two
  directions in opposite senses and the crash-free member an A/A on both.
  The first build cost 4.6 percent of throughput from two unsampled
  censuses; sampling them (one step in 64, one operation in 8) returned it
  to 0.973 | previously ADMITTED at iteration 46 (judge gain 8, cost 2,
  rank 1; top pick; the independent observable was rewritten before
  admission) | parent:
  post-fault-request-timing-axis (filed) and the merged 64-step hold
- Mechanism: the inverse direction of the merged post-fault hold, added as
  a third arm so the axis carries both directions and the coin. A second
  salt in client_anchor.rs draws RUSH on half of the runs the hold does not
  treat, giving HOLD 1/2, RUSH 1/4, STOCK 1/4. On a RUSH run a post-fault
  client request is invoked at its ready step exactly as STOCK does, but the
  record its invocation pushes takes the top of the priority range instead
  of a drawn one (path.rs:199), and every record later built under that
  op's ambient causal_operation_id (exec.rs:560) inherits the same top
  priority. The drawn priority is still sampled and discarded so the run's
  RNG stream keeps its shape. Priority is the channel the existing blend
  already scores on at weight 0.75, so no new same-step override rule is
  added.
- Why: the hold is the loop's one anti-general merge - 0.86, 0.52 and 0.39
  DOWN per cell on paxos-accept-stale-ballot,
  paxos-fixed-recover-forget-accepted and raft-forget-vote, UP on nothing,
  while worth about 4x at VR depth 10. That signature is a fixed direction
  on a real axis. STOCK is not the hold's inverse: it issues the request at
  plan-ready and then lets it lose every dispatch contest to the fan-out in
  flight, which is a weak hold. RUSH is the first arm that puts the request
  ahead of the fault-adjacent traffic.
- Verified by the judge: the priority sample at path.rs:199, the
  causal_operation_id ambient at exec.rs:560 threaded into the three
  record-construction sites, the 0.75/0.25 blend weights (steer_terms.rs:80),
  bit 16384 dead in run_variant.rs, mencius-opt1-2 at zero crashes so the
  zero-harm check is structural.
- Judge red team, carried into the build: fresh_first_dispatch and
  pair_order_dispatch are eligibility layers AHEAD of the blended score, so
  a top-priority record can still be displaced; the build must count
  "rushed record was the pick" against "rushed record was eligible and
  displaced", which is what separates a null from an inert arm.
- Frozen prediction: bit clientRushPriority = 1 << 14 (16384, recycled from
  the dead crashPhaseReaction row), 0.25 of non-probe runs under RUSH_SALT
  among runs with bit 1<<18 clear, so the matched contrast is RUSH vs STOCK.
  depth>=8 per-run ratio in [0.90, 1.02].
  Firing: client_anchor.axis.rush.records_prioritized >= 200,000 per chunk
  and client_anchor.axis.rush.ops >= 60,000 per chunk.
  Independent observable (as rewritten at admission):
  client_anchor.axis.rush.first_delivery_distance mean on RUSH at least 10
  percent below STOCK's (RUSH <= 0.90 x STOCK), HOLD's the largest of the
  three, and rush.ops exactly 0 on mencius-opt1-2.
  Falsifier: refuted if the contrast's 2.7-sigma interval lies entirely
  below 0.90; or if the RUSH first_delivery_distance mean is not at least
  10 percent below STOCK's (sign explicit: it must be strictly smaller;
  equal or larger means the priority override is not advancing the request
  and the arm is inert); or if paxos-fixed-recover-forget-accepted reads
  RUSH/STOCK below 1.00 pooled over three seeds.
  Cost clause: cross-binary throughput at or above 0.97 of the paired
  baseline.
- Cross-reference: this is the narrow, arm-gated form of the pool's
  causal-chain-priority-inheritance-with-demotion-points (scored 6/2, never
  built).

## post-fault-hold-clocked-by-restart-progress

- kind: add | category: scheduler | origin: proposer | status:
  MERGED INTO post-fault-release-on-recovered-progress at iteration 46
  (judge gain 6, cost 0, rank 2; a duplicate of that kept entry, and its
  claimed improvement - folding the census in arm-blind - is not one,
  because the kept entry already mandates exactly that). Not a separate
  row. Its contribution to the kept entry: the release unit is acted
  handler entries at the most recently restarted node, computable from
  SendLedger.entries and .entries_at_restart (state.rs:686) with the
  env.writes != before test note_ghost_delivery already uses (state.rs:1092),
  bit 1024 entryClock free to recycle, and the depth>=10 decisive clause
  must be restored (>= 1.20 with the lower edge above 1.00) or the arm is
  unfalsifiable on the only rung the hold was merged for | parent:
  post-fault-release-on-recovered-progress

## incarnation-race-coverage-key

- kind: add | category: feedback | origin: proposer | status:
  KEPT at iteration 46 at the floor (judge gain 2, cost 0, rank 3; do not
  schedule) | parent: none
- Mechanism: split the timeline coverage key by the SENDER's incarnation
  class (TimelineTuple gains stale: bool) and let the within-run novelty
  steer chase whichever class is currently rare, forcing key granularity to
  Race on the treated half.
- Why it is at the floor: its central evidential claim is TRUE and verified
  - novelty_enabled is false in general_vr.json, key_granularity collapses
  to Constant, timeline_steer_bias returns 1.0, so a quarter of the blend's
  weight is genuinely dead - but the opportunity that implies is already
  answered. Iteration 12 restored novelty at full strength (44.5M flips,
  keys 5 to 8,954) and lost: throughput 0.796 and a randomized in-session
  contrast of 0.9801 [0.967, 0.993] with the ablated eighth better per run.
  The candidate does not clear that gate. Its panel claim is also
  unsupported: paxos-accept-stale-ballot's shape is ballot supersession, not
  incarnation staleness, and the sharpest prediction rests on equating them.
- Reopen only with a proposal that clears iteration 12's gate explicitly -
  a novelty channel whose throughput cost is bounded and whose per-run
  contrast is positive, not merely a new key field.


## fresh-first-ablate-never-restarted-destination

- kind: ablate | category: scheduler | origin: proposer | status:
  MERGED at iteration 47 as a narrowing of the fresh-first rule (spur
  85ff891): the swap now happens only at a destination whose incarnation is
  above zero, as the default with no arm. Eight chunks read depth>=8 1.024,
  z 2.7 [0.990, 1.059], inside the frozen confirming band, with 162,042
  suppressions per chunk - 48 percent of the rule's firing returned to the
  draw; panel sign check passed over three seeds (raft-stale-vote 1.18
  [0.70, 1.99], nothing down, mencius A/A 0.92). Counter renamed
  fresh_first.skipped_never_restarted_dest; bit 1024 freshFirstDestCut is
  now a registered row with no tag, like every closed arm |
  previously ADMITTED at iteration 47 as the session's secondary under an
  independent salt (judge gain 6, cost 0, rank 1 of four) | parent:
  fresh-first-same-pair-dispatch-tiebreak (merged)
- Mechanism: on a salted half of the freshFirstPair-treated runs, skip the
  fresh-first swap when the destination has never restarted in the run -
  state.incarnation(dest) == 0 and not currently crashed, the two integer
  tests pair_order_dispatch already applies to the origin - and count it.
  The other half runs the merged rule whole.
- Why: the rule was argued for a destination that is itself recovering
  (label 8); at a destination that never went down it fixes an order on a
  dimension the chain does not constrain, which iteration 45 showed is a
  diversity cost whichever way it points. The answerable range is [0.89,
  1.00] because fresh-first earns 1.12 over the coin, not a factor of four.
- Frozen prediction: bit freshFirstDestCut = 1 << 10 (1024), recycled from
  the dead entryClock row, set only when FRESH_FIRST_PAIR (1 << 24) is set,
  own salt, probes exempt by inheritance; share about 0.25; matched control
  bit 24 set, bit 10 clear. Read: interval inside [0.95, 1.06] narrows the
  merged rule to restarted-destination contests; upper edge below 0.95 keeps
  the rule whole and records the share; an interval spanning 0.95 is
  UNDECIDED, recorded, not extended. Firing: fresh_first.dest_cut.suppressed
  >= 50,000 per chunk; suppressed / (suppressed + swaps) reported.
  Independent observable: among ghost entries at never-restarted
  destinations, overtaken share <= 0.80 on the cut half against >= 0.95 on
  the full half (a split on the existing message-entry census, O(1)).
  Falsifier: suppressed below the floor, or the never-restarted overtaken
  share on the cut half above 0.90 (class mis-selected). Panel claim, sign
  only: raft-stale-vote UP; refuted only if it reads DOWN; the suppressed
  share on that member is reported before the cell is read. mencius is a
  structural A/A. Cost: throughput >= 0.99.

## delivery-class-order-stale-arm-over-drawn-quarter

- kind: arm | category: scheduler | origin: proposer | status: KEPT at
  iteration 47 (judge gain 6, cost 0, rank 2; every claim verified, the only
  signed and resolvable panel claim of the round; not scheduled because the
  VR half re-asks what iteration 39 closed, at 13 to 21 percent of a
  session's depth-8 events, and stale-first-at-settled-receiver-only asks
  the residual at a fifth of the price) | parent:
  fresh-first-same-pair-dispatch-tiebreak
- Mechanism: stale-first as a quarter arm drawn over the runs fresh-first
  leaves clear, completing the delivery-class axis (FRESH 1/2, STALE 1/4,
  STOCK 1/4); enables the half-dead want_fresh == false branch of
  fresh_first::rival. Bit 1 << 22 recycled from staleFirstPair. Panel claim
  raft-stale-vote UP >= 1.30 over six seeds.

## fresh-first-ablate-contests-after-first-hearing

- kind: ablate | category: scheduler | origin: proposer | status: KEPT at
  iteration 47 (judge gain 5, cost 0, rank 3; not scheduled) | parent:
  fresh-first-same-pair-dispatch-tiebreak
- Note from the judge: fresh_first::note_entry runs only inside
  `if message_entry && util_stats::enabled()`, so a cut keyed on
  heard_from would make a scheduling decision depend on instrumentation;
  the table must be maintained unconditionally before this can be built.
  Its observable is tautological and its named panel member's parent cell
  is 0.97, leaving nothing to restore.

## absorber-spared-crash-target-arm

- kind: arm | category: scheduler | origin: proposer | status: KEPT at
  iteration 47 at the floor (judge gain 3, cost 0, rank 4; do not schedule
  as written) | parent: ghost-absorber-crash-retarget
- Falsified claim: the independent observable put the retarget half's
  marked-victim share at or above 0.85; the baseline records 0.330
  (victim_swap.census.treated.victim_had_absorbed 157,950 / 479,257), and
  victim_swap.no_absorber is 321,307 of 479,257 releases, so on two thirds
  of releases no node carries a mark and the inverse comparator degenerates
  to a lowest-index rule. Reopen only with thresholds read from the census.


## reply-before-news-at-destination

- kind: add | category: scheduler | origin: proposer | status: FILED at
  iteration 48 (panel rule not met over three seeds: forget-accepted 1.15
  [0.83, 1.59] on REPLY_FIRST, raft-stale-vote 1.30 [0.85, 2.00], nothing
  down, mencius A/A 1.12; VR guards met, depth>=8 1.015 [0.962, 1.070];
  contests 1.49M per chunk, news_strict 0.987; NEWS_FIRST fired 28x less
  than its mirror and is unreadable. Patch kept at
  tmp/loop/lite/reply-news/spur.patch. Reopen only with a panel member whose
  shape is a reply-before-news race at a never-restarted coordinator, or at
  a power that separates 1.15) | previously ADMITTED at iteration 48 (judge
  gain 5, cost 0, rank 1 of four) | parent:
  fresh-first-same-pair-dispatch-tiebreak (merged, narrowed) and
  pair-send-order-ghost-class-only (merged)
- Mechanism: a cross-origin same-step preference at one destination,
  composed after fresh_first_dispatch and pair_order_dispatch. Class REPLY:
  a remote record whose origin has restarted and whose origin_incarnation is
  the origin's current one. Class NEWS: a remote record whose origin's state
  token has moved since the destination last took an entry from that origin
  (a per-(destination, origin) token table, one write per delivery, written
  OUTSIDE the util_stats gate). REPLY_FIRST takes the REPLY rival,
  NEWS_FIRST the NEWS rival, stock keeps the draw; displaced record stays
  eligible; no draw consumed. Bits 8192 (replyBeforeNews, half) and 2048
  (newsBeforeReply, a quarter of the rest), stock quarter the control.
- Chain edge fixed: PrepareOK 2->0 before {StartView 1->0, StartViewChange
  1->0, StartViewChange 2->0} at node 0 - the grader's rung 11 to 12. That
  transition converts at 0.70 pooled over 24 baseline chunks, so the largest
  attainable depth>=12 ratio is 1.43 while eight chunks need 1.65 to
  separate: VR is a guard (depth>=8 [0.95, 1.10], depth>=10 [0.95, 1.30]),
  never decisive. Panel decides on the iteration-46 rule:
  paxos-fixed-recover-forget-accepted UP on REPLY_FIRST and DOWN (<= 0.90) on
  NEWS_FIRST over three seeds; raft-stale-vote must not read DOWN. Firing
  reply_news.contests >= 60,000 per chunk, swaps_reply/contests >= 0.5, and
  news_strict/contests reported. Cost throughput >= 0.97.

## recovering-receiver-inbound-admission-axis

- kind: add | category: scheduler | origin: proposer | status: KEPT at
  iteration 48 (judge gain 3, cost 2, rank 2; not scheduled) | parent:
  post-fault-request-timing-axis (filed)
- Why held back: its central ordering - both RecoveryResponses to the
  restarted node after w2 - has no edge in the DAG (they are co-predecessors
  of the PrepareOK). It needs a restart ordinal (State has only an
  incarnation count) and a run-level client-invocation counter (at the
  history push, hence cost 2). The gate would likely open within a few steps
  of each restart. EARLY is the direction with a case, not LATE.

## restart-progress-priority-change-point

- kind: add | category: scheduler | origin: proposer | status: KEPT at
  iteration 48 at the floor (judge gain 2, cost 2, rank 3; do not build as
  written) | parent: post-fault-release-on-recovered-progress (closed)
- Why: a one-shot re-draw of queued priorities breaks the treated/untreated
  random-stream parity every merged rule asserts by test, making any depth
  read uninterpretable. Correct about one thing: priority is not in
  Record::hash, so a queue re-draw is safe for dedup. PCT change points
  remain genuinely unattempted; a parity-preserving form (a fixed band shift
  rather than a re-draw) could be re-proposed.

## origin-restart-class-order-at-recovering-receiver

- kind: add | category: scheduler | origin: proposer | status: REJECTED at
  iteration 48 (judge score 0: already answered) | parent: fresh-first
- Reason: the sender-choice-at-a-destination family is closed in both
  directions (0.738 at iteration 43, 0.949 at iteration 45), and the two
  labels it means (RecoveryResponse 0->2 and 1->2) are concurrent in the
  DAG - the exact condition under which a preference and its inverse both
  lose. Its "strict subset of reply-before-news" claim is false (it admits
  ghosts).


## post-fault-release-on-earliest-restarted-progress

- kind: add | category: scheduler | origin: operator-agent | status:
  REJECTED at iteration 48 (judge gain 2, cost 0; two load-bearing claims
  false) | parent: post-fault-release-on-recovered-progress (closed)
- What was wrong: counting acted entries from the hold rather than from the
  restart is a strictly harder release condition, so the clock fires no
  earlier and generally later than the one closed for firing rarely;
  recover_nl and recover_2 are unordered in the DAG, so "node 1 is the
  earliest-restarted node" does not follow from the crash order; and the
  hold begins at the run's first executed crash, before any restart, so on
  the modal hold every restarted-node selector returns None and the cap
  governs - there the arm is byte-identical to the closed one. The 128-step
  cap governed 82 percent of holds at iteration 47 and read depth>=10 0.743
  separated down; re-running it would re-buy a measurement already owned.
- The one durable fact: any release clock keyed on a restarted node's
  progress must first wait for the crashed node to come back, and the it-47
  census (third acted entry inside 64 steps on 0.165 of holds, 0.179 at 128)
  says that latency exceeds the hold window on most holds. A progress clock
  therefore needs no cap or a far longer one - and a fixed longer hold is
  known to be worse - so the untested object is a cap-free, dry-queue-only
  progress release. Not seeded; recorded.


## post-fault-release-on-hold-opener-progress-no-cap

- kind: add | category: scheduler | origin: proposer | status: CLOSED at
  iteration 49 on the smoke gate, no chunk bought: release.progress / held
  0.050 (floor 0.50), held_at_exit / held 0.950 (cap 0.01), steps per run
  1.194x the 64-step quarter (cap 1.08), dry-queue releases 11 of 52,192.
  The latch opened on 8.9 percent of treated runs; the census (one hold in
  four) reads within_64 2,323, beyond_64 914, never 51,495 - the opener
  restarts and acts three times in about 6 percent of holds and never in 94.
  Plan completion 3.1 percent against 22.8. Patch and smoke utilization kept
  at tmp/loop/lite/opener-progress. This closes the progress-clock family:
  the node whose crash opens the hold mostly does not come back and act
  within the run, so no release keyed on it is applicable with or without a
  cap | previously ADMITTED at iteration 49 behind the gate (judge gain 5,
  cost 2, rank 1 of three) | parent:
  post-fault-release-on-recovered-progress (closed), the 64-step hold
- Mechanism: on a salted half of the hold-half runs (bit 4096
  clientOpenerProgress, nested in bit 1<<18, own salt, probes exempt by
  inheritance) the step cap is removed; the held requests are released,
  once per run, when the node whose crash opened the hold (the landing node
  recorded at the hold site) has restarted and taken num_servers acted
  handler entries since that restart; the dry-queue release is the only
  liveness rule. Matched control: bit 18 set, bit 4096 clear, the 64-step
  hold unchanged.
- What the judge found: VR.spur's receiver-side Recovery handler writes no
  state, so rung 7 is not an acted entry and the latch's three acted entries
  (two of the opener's own RecoveryResponses plus rung 8) open one rung
  before DoViewChange -> w2; the alignment claim is false. N = num_servers is
  the literal 3 on this config and on 9 of 11 panel members. About 79
  percent of runs end on a cap with events outstanding and 9.0 percent of
  executed crashes never see their recover, so a cap-free hold is expected
  to fail held_at_exit or run length in the smoke.
- SMOKE GATE (all four, on the 60-second smoke, before any chunk):
  client_anchor.release.progress / held >= 0.50 on the treated quarter;
  held_at_exit / held <= 0.01; within-binary steps per run on the treated
  quarter <= 1.08x the control quarter's; release.dry / held <= 0.30.
  Failing any clause closes the row on the census.
- If graded: decisive depth>=10 treated/control >= 1.25 with lower edge
  above 1.00 at z 2.7 over eight chunks; depth>=8 guard [0.94, 1.08];
  firing release.progress >= 60,000 per chunk; panel paxos-accept-stale-
  ballot UP >= 1.10 within the hold half over three seeds, refuted if DOWN;
  mencius A/A; cost throughput >= 0.97 after the paired steps-per-run read.
- Rides in the same binary, no bit: the class census - client_anchor.held,
  released and post_fault_request split by ClientOpSpec class (Read against
  Write/Rmw) on every arm, so the merged hold's read/write composition is
  measured for the first time and next round's class split can be signed
  on evidence.

## post-fault-hold-class-split-read-write

- kind: ablate | category: scheduler | origin: proposer | status: KEPT at
  iteration 49 (judge gain 5, cost 0, rank 2; not built this round: its
  panel sign rests on VR's 2:1 read majority, but every panel member runs
  num_read_ops 1-3 against num_write_ops 3-5, a 3:1 WRITE majority, so the
  WRITE_CLASS cell still holds most post-fault work there and cannot move
  forget-accepted from 0.59 toward 1; the sign is probably backwards) |
  parent: the 64-step hold (merged)
- Mechanism: three cells inside the hold half - hold writes only (bit
  65536), hold reads only (bit 4194304), hold both (the merged rule) - under
  mutually exclusive salts; the rest byte-identical. Build next round with
  the panel claim re-signed from the class census this round collects.

## crash-release-anchored-on-outstanding-client-work

- kind: add | category: scheduler | origin: proposer | status: KEPT at
  iteration 49 (judge gain 3, cost 2, rank 3; deferred) | parent:
  crash-phase-on-landing-node (merged), crash-quiet-phase-arms (closed)
- Why deferred: BUSY is structurally near-inert - the plan generator emits
  crashes as roots with no mandatory client predecessor, every root client
  request is invoked at step 0 before any crash, and plan completion is
  about 0.21, so a client operation is outstanding at nearly every crash
  already. The treated half would be about one third QUIET against the
  fan-out table, and QUIET is the closed quiet-crash family's predicate one
  level up (iteration 38 read 0.826, iteration 41 0.828 on the second crash
  alone). The DAG has no response events, so "w1 is outstanding at
  crash_nl" is not a DAG fact. The fan-out arms' window-expiry share is
  0.159, not 0.18.


## recovering-receiver-inbound-priority-axis

- kind: add | category: scheduler | origin: proposer | status: CLOSED at
  iteration 50 on its guard after one chunk (depth>=8 0.763 [0.691, 0.842]
  entirely below 0.96; depth>=9 0.700 separated down): promoting the outage
  backlog costs a quarter of depth 8. The nested fresh-only cut read 1.477
  [1.336, 1.634] against the uncut arm on depth 8 and 3.31 [1.83, 5.98] on
  depth 10 - the harm is the backlog, the fresh half is neutral to positive.
  Superseded by recovering-receiver-fresh-early-axis (fresh-only as the
  whole of EARLY, bit 65536 renamed recoverWindowFreshEarly). Session
  stopped after chunk 1 | previously GRADING at iteration 50 after the smoke
  gate: clauses 1, 2, 4 pass (0.907, 17.1,
  1.0016); clause 3 reads 1.55 against 2.0 but the 2.0 assumed a stock base
  of 0.02-0.15 where the measured base is 0.47 (ceiling 2.14), settle
  latency is down 9.1 percent, and the class leaves the queue faster on
  EARLY - graded on an operator override recorded in observations |
  previously ADMITTED at iteration 50 behind a pre-committed smoke gate
  (judge gain 6, cost 0, rank 1 of three; two scope changes required at
  admission and taken) | parent:
  recovering-receiver-inbound-admission-axis (kept at 48), the rush arm
- Mechanism: a remote record entering the network queue whose destination
  has incarnation > 0 and fewer than N = 2*|role| handler entries since its
  restart takes the top of the priority range (client_anchor::RUSH_PRIORITY)
  over the already-drawn value, at the Runnable::Record remote branch of
  State::push_runnable - which also covers the outage backlog re-pushed at
  restart and purgatory releases. EARLY on a salted half of the eligible
  runs; STOCK the other half. Scope changes at admission: eligible = not a
  probe AND NOT a rushed run (the rush arm stamps about 561 records per
  rushed run at 1.0 against about 569 deliveries, so the channel is
  saturated there; complementCoBits drops rushed runs from the control);
  LATE not drawn this round (halves the populations; EARLY is the direction
  with a case). No exec.rs, history.rs, path.rs, no Record field; a
  role-count table added to State::new; a counter-only restart step in
  note_incarnation_bump read by no predicate.
- Frozen prediction (judge's rewrite): bit recoverWindowEarly = 1 << 16
  (65536, recycled from ghostPeerAnswer; receiver-ghosts-first-at-restart's
  bit reference is reassigned). PRIMARY depth>=10 EARLY/STOCK, lower edge
  above 1.00 at z 2.7 with overdispersion 1.3 over eight chunks and ratio-1
  >= 0.02; about 342 against 456 events, resolves 1.246. depth>=11 is
  corroboration (about 74 against 98, resolves 1.606). MERGE RULE: depth>=10
  separates up AND depth>=11 point estimate >= 1.15 the same way AND no
  readable panel member reads DOWN (below 0.85). Guards depth>=8 [0.96,
  1.12], throughput >= 0.97 after the within-binary steps-per-run read.
  SMOKE GATE, all four on the 60-second smoke: runs_with_stamp / arm_runs
  .early >= 0.50; stamped.early / arm_runs.early >= 1.0; the 1-in-64
  sampled dispatch share on EARLY >= 2.0x STOCK's (a channel that steers
  moves it 5x-9x under Tournament k=10; 1.15x would pass a dead one); steps
  per run EARLY <= 1.08x STOCK. Independent observable: recovery settle
  latency (restart to N-th entry) at least 10 percent below STOCK on EARLY;
  flat closes the arm as inert. Panel: veto only - no readable member DOWN;
  mencius offers exactly 0; paxos-accept-stale-ballot near-structural zero
  (requiresRecovery false). Not extended on a favourable read.
- Judge's caveats carried: the stamp is sticky (a record stamped in the
  window keeps 1.0), which makes EARLY closer to "the backlog first" than
  "inbound first while recovering" - the reason the cut rides along; the
  window can close on timer firings (entries counts Timer triggers too), so
  the histogram is split by trigger.

## recovering-receiver-early-fresh-scope-ablation

- kind: ablate | category: scheduler | origin: proposer | status: DECIDED
  at iteration 50 on one chunk: cut/uncut depth>=8 1.477 [1.336, 1.634],
  depth>=9 1.668 [1.316, 2.114], depth>=10 3.31 [1.83, 5.98] - the falsifier
  (below 0.90) is not just missed, the backlog class carries a LOSS and the
  fresh class is the arm; promoted to the axis's whole definition in
  recovering-receiver-fresh-early-axis | previously ADMITTED at iteration
  50, nested in EARLY from the start (judge gain 6, cost 0, rank 2) |
  parent: recovering-receiver-inbound-priority-axis
- Mechanism: on a salted quarter of EARLY (bit recoverWindowFreshOnly =
  1 << 12, 4096, recycled from clientOpenerProgress) the stamp is applied
  only to records that do not carry DeliveryBias::RECEIVER_RESTARTED - the
  single-site flag recover_crashed_node sets on exactly the re-pushed
  outage backlog. Control: the uncut three quarters of EARLY.
- Frozen prediction (judge's rewrite): depth>=10 only, about 114 against
  342 events, resolves 1.395 - reads a large attribution or nothing.
  Confirming read: cut/full inside [0.95, 1.10] narrows EARLY to
  post-restart sends. Falsifier: cut/full below 0.90 with the upper edge
  under 1.00 (the backlog carries the value). Firing: cut_suppressed >=
  100,000 per chunk; backlog_stamped / stamped.early on the uncut portion
  inside [0.20, 0.90]. Observable: settle latency cut vs uncut - if equal,
  the backlog contributes nothing to recovery completion. Prior on disk:
  delivery_effects.receiver_restarted.acted_fraction 0.0036 against 0.2558
  for all deliveries.

## recovering-receiver-window-headroom-census

- kind: census | category: scheduler | origin: proposer | status: ADMITTED
  at iteration 50 as counters riding in the axis binary (judge gain 4, cost
  0 in its rewritten form) | parent: recovering-receiver-inbound-priority-axis
- Rewritten: dispatch-side and entry-side MARGINALS only (the per-record
  entry/dispatch pair would need a Record field and cost 2). Entry histogram
  of entries_since_restart(dest) {0,1,2,3-5,6-8,9-15,16+} split by
  RECEIVER_RESTARTED and by the destination's last trigger, one push in
  eight; the same at dispatch; wait steps for class vs non-class records at
  the same destination; restart to k-th entry for k = |role| and 2*|role|.
  Pre-committed reads against the prior on disk (acceptance_distance already
  puts the backlog subclass's post-window share near 0.58): the informative
  number is the POST-RESTART-SENDS subclass - at or below 0.10 closes the
  axis and REFILES (not closes) the two sibling pool entries; 0.10-0.30
  re-keys N; above 0.30 proceeds. If bucket 0 carries > 0.60 of entry mass
  the cut is mandatory (it already is, on the acted-fraction prior).


## recovering-receiver-fresh-early-axis

- kind: add | category: scheduler | origin: operator-agent (derived in-round
  from the cut's reading; the judge named this design in advance as "the
  most informative single design") | status: CLOSED at iteration 52 on the
  pre-committed eight-chunk re-test: depth>=10 0.978 [0.785, 1.219] on 388
  against 395, guard 0.971 met, depth>=11 0.737, depth>=12 0.651, depth>=13
  0.392 (74/100, 49/75, 13/33) - the iteration-51 deep lean reversed on 2.3x
  the sample. Stripped binary cost nothing per step (0.9975 pooled). The
  recovering-receiver family is closed both ways; the LATE mirror is not
  decidable at this power and is not scheduled. Was: RE-TEST GRADING at
  iteration 52 (session recover-fresh2, eight chunks straight through, primary
  depth>=10 lower edge > 1.00 at z 2.7, guard depth>=8 [0.96, 1.12], panel
  veto only, no extension; stripped binary's wall per step 0.985 on the
  designated pair and 0.9975 pooled over twelve, firing 19.0 stamps per
  EARLY run and 0.876 of EARLY runs stamped). Previously FILED at iteration
  51 after four chunks - depth>=10 1.067 [0.766, 1.488], depth>=11 1.368, depth>=12
  1.341, depth>=13 1.659, guard 0.983 met, none separated; the binary's wall
  per step is 1.11x on every seed (census on the hot path), so the arm as
  built fails its cost clause. RE-TEST pre-committed as iteration 52: census
  stripped to firing counters, smoke wall/step within 2 percent of baseline
  or no run, eight chunks, primary depth>=10 lower edge > 1.00, no
  extension. Previously GRADING at iteration 51 -
  gate passed on all four clauses (0.907, 12.4, 0.428 ceiling-normalized,
  0.999); the dispatch-share census was re-scoped to the rule's class after
  reading 0.224 over the mixed population (both numbers kept); settle
  latency -4.0 percent against a 5 percent falsifier, overridden with the
  reason recorded (the observable counts backlog entries the rule now leaves
  alone). Decisive read fixed: depth>=10 lower edge > 1.00 at z 2.7 over
  eight chunks, guard depth>=8 [0.96, 1.12], no reinterpretation | previously
  ADMITTED at iteration 51 behind the same smoke gate | parent: recovering-receiver-inbound-priority-axis
  (closed), recovering-receiver-early-fresh-scope-ablation (decided)
- Mechanism: identical to the closed axis except that EARLY stamps only
  class records that do NOT carry DeliveryBias::RECEIVER_RESTARTED - records
  sent to the restarted node since it came back - and never the outage
  backlog. Same non-rushed non-probe population, EARLY half vs STOCK half,
  bit 65536 (recoverWindowFreshEarly), no nested cut, same census.
- Frozen prediction: the closed axis's, with the sign now set by data:
  PRIMARY depth>=10 EARLY/STOCK lower edge above 1.00 at z 2.7 over eight
  chunks (resolves about 1.25); depth>=11 corroboration >= 1.15 point;
  guard depth>=8 [0.96, 1.12] (one chunk of the cut arithmetic says ~1.00);
  merge rule and panel veto as before; smoke gate clauses 1, 2, 4 as before
  and clause 3 restated ceiling-normalized: (EARLY share - STOCK share) /
  (1 - STOCK share) >= 0.35 (chunk 1 read (0.666-0.396)/(1-0.396) = 0.45 on
  the mixed arm). Cost throughput >= 0.97 after the paired steps read.


## lite-run-budget-dose-2000

- kind: add (config dose) | category: config | origin: proposer | status:
  ADMITTED at iteration 53 behind a smoke gate, graded cross-binary with no
  bit; MERGE HELD FOR THE USER if it passes (judge gain 7, cost 0, rank 1 of
  four). Smoke gate PASSED: steps/run 2,796 -> 1,600, rps 1.71x, plan
  completion 0.226 -> 0.224, no zero arm; learned cap reached 0.294 -> 0.
  Eight chunks PASSED every band: four-changed-arm depth>=8/sec 1.545
  [1.30, 2.10], campaign-wide 1.311 (grader 1.355 separated, rule: merge),
  grid-short 0.947 inside [0.90, 1.10] but its deep rungs fell 25-35 percent
  through shared learners (run-cap scope, placement span) - the arms are
  coupled and the base field is not a clean per-arm dose. Per-run depth>=8
  1.006 on the changed arms. DECLINED BY THE USER: no config changes; the
  loop is for simulator mechanisms. Finding kept (runs past the point where
  plan events release buy no plan progress); the budget axis is closed.
  Export tmp/loop/lite/budget-2000 kept | parent: learned-run-cap-probe-p99
  (merged)
- Change: scheduler_configs/loop/general_vr.json max_iterations 6000 -> 2000;
  nothing else; the campaign block and grid-short's 1500 overlay untouched.
- Evidence, recomputed by the judge from 16 cached chunks with probes out
  and each arm's own wall as denominator: grid-short/grid events per second
  2.33 / 2.39 / 2.31 / 2.73 / 3.05 / 2.91 at depth>=8..13, per-run 1.14 /
  1.16 / 1.12 / 1.33 / 1.48 / 1.42, per-chunk depth>=8 in [2.02, 3.02] on
  all 16; on 36 chunks the shallow result strengthens (2.36) and the deep
  headline decays (2.28 / 2.37 / 1.78 at 11-13, depth>=13 per-run 0.86).
- Confounds the judge priced: the learned cap binds first (median scope
  ~3300, 43-50 percent of runs end on it), so the true contrast is ~3300 vs
  1500 and the dose buys ~1.65x on the arms it touches; grid-short is
  unchanged and carries 37 percent of depth-8 events, so the campaign-wide
  ceiling is 1.84x and the realistic read ~1.47x; grid's own per-run
  depth>=6 fell 3.89 -> 2.93 percent as the learned cap shortened its budget,
  which points the other way and is the strongest argument against.
- Frozen prediction (judge's rewrite): DECISIVE = depth>=8 events per
  explore-second on the four changed arms (grid, grid-no-purgatory,
  grid-post-fault-2 and the fourth), cross-binary against the paired-seed
  baseline over eight chunks, band [1.30, 2.10]; campaign-wide depth>=8 per
  second secondary at [1.20, 1.80]; grid-short per second is the invariance
  control and must read inside [0.90, 1.10]; depth>=10 and >=11 per second
  reported. Firing: mean steps per run on the changed arms in [900, 1700]
  (the cap-scope floor is vacuous because the learner disengages at 2000).
  SMOKE GATE: steps per run in [900, 1700] on the changed arms; runs per
  second >= 1.4x the same-seed baseline smoke; plan-completion share within
  0.05 of the baseline's; no arm at zero runs. PANEL: unreachable by
  construction (members set their own maxIterations; grader overrides) -
  read as a strict A/A and recorded as such; generality is unguarded, which
  is why the merge is held. COST: wall per step within 1.02 (identical
  binary); merging changes templateSha and invalidates every cached baseline
  and the epoch identity.

## lite-config-cell-deep-supply-walk

- kind: add | category: feedback | origin: proposer | status: KEPT at
  iteration 53 (judge gain 5, cost 0, rank 2) | parent:
  hazard-thompson-config-walk (kept)
- Per-cell Thompson walk over the config grid inside each arm, rewarded by a
  protocol-free post-fault shape; bit 4194304. Does not touch the campaign
  block. Bounded near 1.3x by the dead third of one-crash cells (rung 5 is a
  second crash - verified).

## lite-deep-run-budget-extension

- kind: add | category: scheduler | origin: proposer | status: KEPT at
  iteration 53 (judge gain 4, cost 0, rank 3) | parent:
  learned-run-cap-probe-p99
- Two-tier cap: median-shoulder base, extended once for runs whose planned
  fault cycles have all completed with plan events still unreleased; bit
  131072. path.rs holds crashed/recovered sets and pending_recover, so the
  predicate is computable; the cap is the loop bound at path.rs:516. Bounded
  near 1.3x by the redistribution arithmetic. Re-price after the dose.

## lite-postfault-state-fork

- kind: add | category: feedback | origin: proposer | status: KEPT at
  iteration 53 at the back (judge gain 5, cost 2, rank 4) | parent:
  ghost-prefix-replay-corpus
- Checkpoint State (Clone is derived, though the struct's own comment says
  it is never cloned) at the last planned recover and run N continuations.
  Cost 2: re-emitting the prefix's trace rows per continuation touches the
  recording path. Breaks the per-run unit by construction; only a
  cross-binary per-second read is honest. Schedule only after a budget
  candidate has read.

## state-fork-continuations-at-ghost-signal-cut

- kind: add | category: scheduler | origin: proposer | status: FILED at
  iteration 54 on its smoke gate (cut at 7.6 percent of the run, child wall
  0.93 of a tape child against 0.85; machinery works, patch kept under
  research/lite/patches/state-fork; the deeper cut is the follow-up
  state-fork-cut-at-last-planned-recover) | parent: lite-postfault-state-fork
- Clone the PathState and the exec_plan locals at the step where the
  corpus's ghost-signal cut fires on a fresh grid-arm parent; a state-fork
  slot (half of the prefix-replay slots, bit 256 replayStateFork, nested in
  replayPrefix) resumes from the clone with a fresh schedule rng and pays
  only the continuation. Continuation draws keyed on the parent's id so the
  child's tag is the parent's mechanism bits. Counters in the replay
  section: state_fork_slots, state_fork_children, state_fork_fallback_tape,
  prefix and continuation step sums, snapshot bytes, fork_points_taken,
  fork_clone_wall_us_sum.
- Frozen prediction (judge's rewrite): within-binary, depth>=8 events per
  child-wall-second, fork children against tape-prefix children stratified
  on inherited arm bits, interval inflated by sqrt(1 + (m-1)/2) for m = 8
  children per parent, band [1.25, 2.5], refuted below 1.10; per-run guard
  [1.03, 1.35] with the lower edge not below 1.00; wall ratio fork over tape
  at or below 0.85; cross-binary throughput at or above 0.98; campaign-wide
  depth>=8 per second reported, not decided. Firing:
  replay.state_fork_children >= 20,000 per chunk, fallback share below 0.2.
  Smoke gate: fidelity test green, clone wall under 2 percent, RSS under
  2 GB per arm, wall ratio at or below 0.85, child tag equals parent bits.

## per-cell-factored-axis-beta-selector-rarity-reward

- kind: add | category: scheduler | origin: proposer | status: CLOSED at
  iteration 54 on two chunks (depth>=8 0.905 [0.857, 0.955] against [1.04,
  1.16]; the learner fired, departures 0.98, and raised its reward 1.106x
  while depth fell from rung 3 on; the rarity reward orders the arms against
  depth on four of five axes on the control half; patch kept under
  research/lite/patches/axis-selector, the switch is sound and the reward is
  the open question) | parent: none
- Per-cell (arm_index, config_index) learner over the run-level arm axes:
  crash {stock, placed, placed+phase}, retarget, fresh-first, pair order,
  request {hold, rush, stock}; one discounted Beta per direction (g 0.995),
  reward r = 1 when the run's mean rarity of post-recover delivery-context
  keys beats the cell's EMA; both halves observe. Treated half (bit 64
  armSelectorAxis, salted, non-probe) draws each axis by posterior-weighted
  coin sampling (probability proportional to coin share times a sampled
  posterior), so flat posteriors reproduce the coins; 24-observation
  warmup on the coins. Untreated half keeps the coins and identical
  streams. Chosen bits written into the tag.
- Frozen prediction (judge's rewrite): survey contrast for bit 64, treated
  against every untreated probe-free run, z 2.7 with overdispersion 1.3,
  depth>=8 per run in [1.04, 1.16], refuted below 1.04; guard steps per run
  treated to control within 1.05; build fault if axis_leader_agreements per
  draw stays below 0.60; proxy fault if the reward-rate ratio is at or above
  1.12 with depth>=8 at or below 1.0; prior fault if the treated placed
  share is below 0.80 with depth>=8 below 1.0. Cost at or above 0.97.
  Firing arm_selector_axis.chosen_runs >= 50,000 per chunk. Smoke gate:
  coin_fallback share below 0.05, steps within 1.05, control reward base
  rate in [0.3, 0.7].

## per-cell-thompson-joint-arm-selector-rarity-reward

- kind: add | category: scheduler | origin: proposer | status: KEPT at
  iteration 54 behind the factored selector (judge gain 3, cost 0, rank 3)
  | parent: per-cell-factored-axis-beta-selector-rarity-reward
- Joint Thompson over the 72 arm combinations per cell with the same
  rarity reward. Not buildable as written: the 0.995 discount leaves under
  three effective observations per combination and its own leader-agreement
  criterion is unreachable. The follow-up if the factored selector reads
  up and its cells show an interaction; needs a coin-mix prior and a
  discount that covers twenty observations per combination.

## per-cell-exp3-arm-selector-acted-stale-at-restarted-receiver-reward

- kind: add | category: scheduler | origin: proposer | status: KEPT at
  iteration 54 at the back (judge gain 2, cost 0, rank 4) | parent:
  per-cell-factored-axis-beta-selector-rarity-reward
- Exp3 per cell over the joint combination rewarded by a dead-incarnation
  delivery acted on at a restarted receiver. Hazard-shaped reward with
  sign evidence against it in the record (four hazard-up depth-down
  results); eta 0.02 against importance weights up to 1,440 blows up the
  weights on single rewards. Its per-combination control arrays ride along
  in the factored selector's build and answer whether the reward orders
  the combinations as depth does before a learner is pointed at it.

## state-fork-cut-at-last-planned-recover

- kind: add | category: scheduler | origin: operator-agent | status: CLOSED at
  iteration 54 on its cost gate without chunks (receiver's recover at step
  321 of 4,400 on the long arms, cut share 0.073; fork child wall 0.90 raw,
  0.83 net, against 0.80; the plan is applied in the first few hundred
  steps and the fork saves only the prefix; patch kept under
  research/lite/patches/state-fork-recover-cut) | parent:
  state-fork-continuations-at-ghost-signal-cut
- The state fork's cut moves from the step the ghost signal fires to the
  step in which the signal's receiver - the node whose pending crash armed
  the signal - applies its planned recover, so the continuation is the
  post-restart delivery race the depth-8 event is drawn in, and the prefix
  is everything before it. Parents that end before that recover take no
  fork point (state_fork_no_cut_parents); their fork slots fall back to
  tape. Everything else as the parent entry.
- Frozen prediction (judge's rewrite): within-binary depth>=8 events per
  child-wall-second, fork against tape-prefix cells, stratified, z 2.7,
  overdispersion 1.3, sibling inflation 2.12, band [1.25, 3.0], refuted
  below 1.10; per-run guard [0.95, 1.30]; wall ratio above 0.80 refutes on
  cost; cross-binary throughput at or above 0.98; campaign-wide per second
  reported only. Smoke gate, decisive on cost before any chunk: wall ratio
  at or below 0.80, cut share at or above 0.25, fallback below 0.3, RSS in
  bounds, fidelity test green. The judge's arithmetic from the placement
  counters (mean hold 200 steps, crashes drawn below the median completed
  length) predicts a cut share of 0.15 to 0.30 on the long arms and a wall
  ratio that may fail the gate; the smoke answers it either way.

## per-cell-selector-overtaken-ghost-acted-at-restarted-receiver-reward

- kind: add | category: feedback | origin: proposer | status: MERGED at
  iteration 55 undecided (7bb10ea, spur 0587e8c; bit 64 depth>=8 1.043
  [0.994, 1.094] against the coin third on four chunks); at iteration 56
  the same bit reads 1.091 [1.033, 1.153] against the coin quarter on
  four chunks, separated above one | parent:
  per-cell-factored-axis-beta-selector-rarity-reward
- Reward for the filed per-cell selector: r = 1 when a dead-incarnation
  record lands on a receiver that has itself restarted and already heard
  the sender's new incarnation, and the handler writes state. Fresh-first
  reads up by construction (overtake share 1.000 against 0.646), placed
  up, the rest flat; base rate about 0.12 on the coin third. Discount
  0.998, warmup 24, probability-matching coin prior as filed.
- Frozen prediction (judge's version): depth>=8 per run, treated third
  against the coin third only, z 2.7 with overdispersion 1.3, band
  [1.04, 1.12], pass when the point is inside the band with the lower
  edge above 1.00, undecided when the interval holds both 1.00 and 1.04;
  chunk-1 gate on the coin third: stock/placed reward ratio at or below
  0.6, fresh on/off at or above 1.3, rush/stock at or below 1.05,
  hold/stock in [0.9, 1.1]; build fault if the treated fresh-first share
  stays below 0.53 by chunk 2 with the coin ratio above 1.3; firing
  reward_positive_control >= 12,000 and chosen_runs >= 150,000 per chunk;
  steps within 1.05; throughput >= 0.97.

## per-cell-selector-acted-absorber-crash-cycle-then-fresh-peer-reward

- kind: add | category: feedback | origin: proposer | status: MERGED at
  iteration 55 (7bb10ea, spur 0587e8c; bit 32 depth>=8 1.111 [1.060,
  1.165] against the coin third on four chunks, depth>=6 1.142, all four
  alignment gates met, throughput 0.996, regression passed, panel flat) |
  parent: per-cell-factored-axis-beta-selector-rarity-reward
- Reward: a crash lands on a node whose last fault-crossing delivery
  wrote state, the node recovers, and after its restart it takes a
  message from another restarted node's current incarnation. Retarget
  reads up by construction (absorbed victims 0.37 against 0.23 per
  crash), placed up, the rest flat. Judge corrections: the third clause
  is near-vacuous; base rate 0.04 to 0.07; firing floor 5,000 to coincide
  with the 0.03 inapplicable branch. Discount 0.998.
- Frozen prediction (judge's version): depth>=8 per run against the coin
  third, band [1.04, 1.13], same pass rule; chunk-1 gate: retarget on/off
  at or above 1.4, stock/placed at or below 0.5, rush/stock at or below
  1.05, fresh on/off in [0.9, 1.15]; inapplicable if the coin-third base
  rate is below 0.03.

## per-cell-selector-ghost-signal-fired-reward

- kind: add | category: feedback | origin: proposer | status: KEPT at
  iteration 55 as calibration (judge gain 5, cost 0, rank 3; its
  per-direction coin-third table is emitted in the iteration-55 build
  without a learner; children excluded by the attribution's slot bit) |
  parent: per-cell-factored-axis-beta-selector-rarity-reward
- Reward: state.replay_cut is Some at run end, fresh runs only. Placed up,
  everything else flat; base rate 0.21 on fresh runs. Effect on the crash
  axis alone is below the four-chunk resolution.

## per-cell-selector-either-recovery-shape-union-reward

- kind: add | category: feedback | origin: proposer | status: KEPT at
  iteration 55 behind its components (judge gain 4, cost 0, rank 4; its
  coin-third table is emitted in the same build) | parent:
  per-cell-selector-overtaken-ghost-acted-at-restarted-receiver-reward
- The disjunction of the two shape rewards on one bit; the one-bit
  fallback if both components pass and a single learner is wanted.

## per-cell-selector-mutual-absorber-cycle-reward

- kind: add | category: feedback | origin: proposer | status: INAPPLICABLE at
  iteration 56 on its smoke gate (base rate 0.0025 against the 0.010
  floor; signs the sharpest measured - retarget 4.17, phase 2.05,
  stock/placed 0.28 - but 62 rewards over 217 cells move no learner);
  kept as a coin-quarter table in the iteration-56 build | parent:
  per-cell-selector-acted-absorber-crash-cycle-then-fresh-peer-reward
- Reward: two nodes each crashed as an acted absorber, restarted, and
  heard each other's current incarnation after restart. Sharper than the
  merged absorber reward on its own axes: predicted retarget on/off at or
  above 3.0, stock/placed at or below 0.15, phase/placed at or above 1.5,
  fresh at or above 1.1, pair at or above 1.2; base rate 0.015 to 0.03,
  inapplicable below 0.010. Needs three crashes, so rewards per cell are
  thin.
- Frozen prediction (judge's version): depth>=8 per run, the bit-128
  quarter against the coin quarter, z 2.7 with overdispersion 1.3, band
  [1.10, 1.25], pass with the point inside and the lower edge above 1.00;
  chunk-1 gates on the coin quarter: base at or above 0.010, firing
  reward_positive_control at or above 1,800 per chunk, chosen_runs at or
  above 100,000, retarget at or above 2.25, stock/placed at or below 0.3,
  phase/placed at or above 1.2, pair at or above 1.0, hold/stock and
  rush/stock in [0.85, 1.15]; depth>=10 a reported lean; steps within
  1.05; throughput at or above 0.97. Four chunks.

## per-cell-selector-absorber-cycle-closed-before-first-post-fault-request-entry-reward

- kind: add | category: feedback | origin: proposer | status: MERGED at
  iteration 56 (e2733f0, spur 38fcbcc; bit 128 depth>=8 1.077 [1.020,
  1.138] against the coin quarter on four chunks, hold share 0.629,
  depth>=10 lean 1.48, throughput 0.99, regression passed, panel flat) |
  parent: per-cell-selector-acted-absorber-crash-cycle-then-fresh-peer-reward
- Frozen prediction (operator, before any chunk): depth>=8 per run, the
  bit-128 quarter against the coin quarter, z 2.7 with overdispersion
  1.3, band [1.05, 1.18], pass with the point inside and the lower edge
  above 1.00; chunk-1 gates on the coin quarter: base at or above 0.010,
  hold/stock at or above 1.3, rush/stock at or below 0.85, retarget at or
  above 1.5, stock/placed at or below 1.0; build observable: hold share
  at or above 0.60 and retarget share at or above 0.58 by chunk 2;
  depth>=10 reported as a lean; steps within 1.05; throughput at or above
  0.97; four chunks.
- Reward: the absorber cycle closed before the first post-fault client
  request's record entered a server. The table read this session decides
  whether it reads the hold up without rush up, at what base rate.

## per-cell-selector-restarted-node-ghost-and-fresh-peer-before-request-caused-entry-reward

- kind: add | category: feedback | origin: proposer | status: KEPT at
  iteration 56 as a coin-quarter table if cheap (judge gain 3, cost 0,
  rank 3; same mechanism as the entry above, optimistic base rate) |
  parent: per-cell-selector-overtaken-ghost-acted-at-restarted-receiver-reward

## per-cell-selector-fanout-window-before-first-post-fault-request-entry-reward

- kind: add | category: feedback | origin: proposer | status: REJECTED at
  iteration 56 (judge gain 2: circular - fan-out windows open at the same
  rate on both halves and the ordering clause is the hold's own action,
  already told by the release counters; one false claim) | parent:
  post-fault-request-timing-axis

## selector-pick-coin-times-leading-probability-within-learner-half

- kind: add | category: scheduler | origin: proposer | status: MERGED at
  iteration 57 (46505e2, spur ebf6d4e; pooled new half against matching
  half depth>=8 1.133 [1.086, 1.181] on four chunks, against the coin
  quarter 1.228 and depth>=10 1.76 [1.17, 2.65]; cross-binary depth>=8 per
  second 1.093, throughput 1.038; regression passed; panel flat) | parent:
  per-cell-selector-acted-absorber-crash-cycle-then-fresh-peer-reward
- The pick on the new half weights each direction by its coin share times
  the posterior probability that it leads its axis (Beta-difference
  normal approximation, no draw, no constant); the coin exactly on a flat
  axis pooled, the leader where the posteriors separate. Matching half
  unchanged; both halves credit the same posteriors.
- Frozen prediction (judge's version): depth>=8 per run, the pooled
  new-rule half against the pooled matching half, z 2.7 with
  overdispersion 1.3, band [1.06, 1.22], pass with the point inside and
  the lower edge above 1.00; per learner reported; each half against the
  coin quarter, the matching half's read compared with 1.106/1.091/1.077;
  firing arm_selector_axis.concentrated_runs at or above 60,000 per
  learner per chunk; shares on the new half as the build observable
  (retarget and hold at or above 0.80 where the reward separates them,
  flat-axis shares in [0.35, 0.65] as a confound signal); steps within
  1.05; throughput at or above 0.97; depth>=10 a reported lean, pooled
  A+B below 0.80 on 120 or more events to a human before a merge. Four
  chunks.

## selector-pick-leader-mixture-by-leading-margin-within-learner-half

- kind: add | category: scheduler | origin: proposer | status: KEPT at
  iteration 57 (judge gain 4, rank 2; the same rule as the pick chosen on
  binary axes, worse on the three-way axes in young cells; its claimed
  hold share of 0.53 to 0.56 on the flat request axis was false, 0.41 to
  0.46 on the judge's model) | parent:
  selector-pick-coin-times-leading-probability-within-learner-half

## selector-pick-thompson-argmax-of-posterior-samples-within-learner-half

- kind: add | category: scheduler | origin: proposer | status: KEPT at
  iteration 57 behind the pick chosen (judge gain 3, rank 3; a flat
  three-way axis tends to thirds and young cells lift stock to 0.28;
  depth 10 on A and B modelled at 0.63 to 0.88) | parent:
  selector-pick-coin-times-leading-probability-within-learner-half

## selector-pick-greedy-posterior-mean-leader-within-learner-half

- kind: ablate | category: scheduler | origin: proposer | status: KEPT at
  iteration 57 as the exploitation ceiling, not a merge candidate (judge
  gain 3, rank 4; the flat request axis locks on rush or stock in young
  cells) | parent:
  selector-pick-coin-times-leading-probability-within-learner-half

## selector-posteriors-credited-from-coin-quarter-only

- kind: ablate | category: scheduler | origin: proposer | status: KEPT at
  iteration 57 as a follow-up on the merged-pick tree (judge gain 3, rank
  5; not splittable per run; moves nothing under matching; its stock
  claim is backwards; to be bundled with removing the residual unit flat
  prior in posterior(), which is real and live, and the dead
  total-at-or-below-zero fallback in sample_axis that would turn live
  with it) | parent: per-cell-factored-axis-beta-selector-rarity-reward

## selector-explore-share-posterior-odds-against-leader-most-decided-axis

- kind: add | category: scheduler | origin: proposer | status: MERGED at
  iteration 58 (df52d39, spur f545044; cross-binary depth>=8 per run 1.135
  [1.108, 1.162] on four paired seeds, per second 1.149, throughput
  1.014, coin share 0.151; regression passed; panel flat) | parent:
  selector-pick-coin-times-leading-probability-within-learner-half
- A run draws its learner over thirds, then explores with probability
  e = min over axes of (1 - m)/m, m the learner's leader margin in the
  cell, e = 1 before warmup; coin-drawn runs carry no learner bit and
  credit all three learners; learner runs pick by the concentrating rule
  on every axis; the matching half is retired.
- Frozen prediction (judge's version): cross-binary depth>=8 per graded
  run against the paired baseline on seeds 1000 to 1003, band [1.05,
  1.13], pass with the point at or above 1.05 and the lower edge above
  1.00 by the wider of the chunk ratios' dispersion and the binomial
  error at 1.3; refuted below 1.03 or with the interval entirely below
  1.05; per second and depth>=10 reported. Chunk-1 gates: explore.coin_runs
  at or above 20,000, mean coin share in the judge's stated range, the
  learners' shares on the axes their rewards separate at or above 0.75;
  steps within 1.05; throughput at or above 0.97. Four chunks.

## selector-explore-share-prior-owed-per-learner-third

- kind: add | category: scheduler | origin: proposer | status: KEPT at
  iteration 58 (judge rank 2; its per-learner assignment is the form the
  admitted rule took; its own share cannot reach its floor in cells that
  live one chunk: modelled +3.7 percent, inside the layout band) |
  parent: selector-pick-coin-times-leading-probability-within-learner-half

## selector-explore-share-prior-owed-per-cell-max-over-learners

- kind: add | category: scheduler | origin: proposer | status: KEPT at
  iteration 58 behind the per-third forms (judge: session-mean share
  claim false in one-chunk cells, modelled +4.4 percent) | parent:
  selector-pick-coin-times-leading-probability-within-learner-half

## selector-explore-share-posterior-odds-with-coin-only-credit-and-unit-prior-removed

- kind: ablate | category: scheduler | origin: proposer | status: REJECTED
  at iteration 58 (judge: removing the unit prior makes the cell mean
  zero before the first reward and the pairwise lead 0/0, uncaught by the
  pick's guard; coin-only credit starves one-chunk learners; modelled
  +0.9 percent) | parent: selector-posteriors-credited-from-coin-quarter-only

## selector-explore-one-coin-axis-per-learner-run

- kind: add | category: scheduler | origin: proposer | status: KEPT at
  iteration 58 (judge: a fixed exploration rate of one axis in five in a
  change-point form, modelled +4.4 percent, inside the layout band) |
  parent: selector-pick-coin-times-leading-probability-within-learner-half

## per-cell-selector-overtaken-ghost-acted-at-request-untouched-restarted-receiver-reward

- kind: add | category: feedback | origin: proposer | status: CLOSED at
  iteration 59 on one chunk (coin table stock/placed 1.62 against its
  letter of 1.0; A/(B+C) at depth>=8 as a ratio of ratios 0.801 [0.720,
  0.891] against a pass at 0.96; A's stock share 0.19; the clause reads
  early crashes up; patch kept under research/lite/patches/
  untouched-overtaken for the timer-reopened table and census) | parent:
  per-cell-selector-overtaken-ghost-acted-at-restarted-receiver-reward
- Reward: an acted overtaken ghost at a restarted receiver that no
  post-fault request had reached since its restart. Reads the hold up
  by the window the hold opens, fresh-first asserted up, rush down;
  own-run base about 0.02 to 0.03 on A's runs.
- Frozen prediction (judge's version): primary the within-binary ratio
  of A's depth>=8 per run to B and C's, as a ratio of ratios against the
  paired baseline chunks (today 1.008), pass at or above 0.96 with the
  lower edge above 0.93, refuted with the interval entirely below 0.94;
  cross-binary all-runs depth>=8 per run at or above 0.98; depth>=10 the
  same ratio of ratios (today 0.84), expected 1.15 to 1.5, reported, a
  human below 0.85 on 120 or more A events. Chunk-1 gates on the coin
  table: hold/stock at or above 1.5, rush/stock at or below 0.85, fresh
  at or above 1.2, pair at or above 0.95, stock/placed at or below 1.0,
  phase reported; A's own-run rate at or above 0.015 (inapplicable
  below); A's shares by chunk 2: hold at or above 0.68, rush at or below
  0.15, fresh-first at or above 0.68, stock at or below 0.12. Firing
  reward_positive_treated at or above 2,500 and reward_positive_control
  at or above 600 per chunk; steps within 1.05; throughput at or above
  0.97. Four chunks.

## per-cell-selector-overtaken-ghost-honoured-twice-or-before-receiver-request-reward

- kind: add | category: feedback | origin: proposer | status: KEPT at
  iteration 59 as the fallback if the untouched clause's own-run rate
  reads below 0.015 (judge gain 5, rank 2; the union dilutes the hold
  ratio and its pair clause is protocol-shaped) | parent:
  per-cell-selector-overtaken-ghost-acted-at-restarted-receiver-reward

## per-cell-selector-overtaken-ghost-after-timer-acted-segment-at-restarted-receiver-reward

- kind: add | category: feedback | origin: proposer | status: KEPT at
  iteration 59 as a coin table with a per-direction census in the same
  build, no learner (judge gain 4, rank 3; the one clause the found
  violation satisfies; its hold sign is a quiet-network story the census
  tests) | parent:
  per-cell-selector-overtaken-ghost-acted-at-restarted-receiver-reward

## per-cell-selector-overtaken-ghost-acted-anywhere-before-first-post-fault-request-entry-reward

- kind: add | category: feedback | origin: proposer | status: FILED at
  iteration 59 (judge gain 3, rank 4; learner C's run-level clause on a
  diluted fresh core) | parent:
  per-cell-selector-absorber-cycle-closed-before-first-post-fault-request-entry-reward

## recover-settle-learned-stop

- kind: add | category: scheduler | origin: proposer | status: CLOSED at
  iteration 60 on four chunks (cross-binary depth>=8 per second 1.065
  [1.018, 1.115] against refutation at 1.08; treated steps 0.836 against
  the 0.75 gate, the settle's heavy tail keying the stop at 935 to 2,411
  steps; the deep tail leans down on the treated half, depth>=12 0.68 on
  36 vs 53; patch kept under research/lite/patches/settle-stop) | parent:
  learned-run-cap-probe-p99
- A run on the treated half ends once every fault plan event has
  completed, it has applied a recover and taken a fault-crossing
  delivery after it, and the step has passed the last recover plus the
  scope's settle, learned on run-cap probes as 1.5 times the p99 of the
  last crossing delivery's step past the last recover, per (budget,
  campaign arm) scope with the cap learner's shape; no key falls back to
  the cap; a scope under its floor is identity.
- Frozen prediction (judge's version): cross-binary depth>=8 per
  explore-second on four paired seeds in [1.10, 1.30], refuted below
  1.08; within-binary per-run depth>=8 treated over untreated in [0.97,
  1.03] as the guard; pooled depth>=11 per run refuted if entirely below
  0.80, depths 9 to 13 reported; chunk-1 gates stops_taken at or above
  50,000, scopes_learned at or above 4, treated steps per run at or
  below 0.75 of untreated, probe_over_stop_completions at or below 5
  percent of probes_keyed; runs per second at or above 1.15; the panel
  per member on the bit-1024 violation contrast. Four chunks.

## crossing-quiet-learned-stop

- kind: add | category: scheduler | origin: proposer | status: KEPT at
  iteration 60 (judge gain 5; the aggressive re-arming form of the same
  mechanism; its claim that bit 2048 has no live reader was false) |
  parent: recover-settle-learned-stop

## response-quiet-settle-learned-stop

- kind: add | category: scheduler | origin: proposer | status: KEPT at
  iteration 60 (judge gain 4; the tail-safe conjunction, priced from the
  response-gap histogram the admitted build exports) | parent:
  recover-settle-learned-stop

## last-crossing-step-arm-quantile-stop

- kind: add | category: scheduler | origin: proposer | status: KEPT at
  iteration 60 (judge gain 2; the absolute-step form inherits the crash
  placement span; priced from the last-crossing-step histogram the
  admitted build exports) | parent: learned-run-cap-probe-p99

## selector-cells-pooled-by-configuration-across-grid-arms

- kind: add | category: scheduler | origin: proposer | status: MERGED at
  iteration 61 (e42b271, spur b86baad; cross-binary depth>=8 per run 1.052
  [1.028, 1.076], the long grid arms 1.10 to 1.14 separated, grid-short
  1.03, coin share 0.110, throughput 1.016; regression passed; panel
  unchanged) | parent:
  selector-explore-share-posterior-odds-against-leader-most-decided-axis
- One selector cell per configuration index shared by every grid arm;
  the aos arm keeps its own cell; panel members unchanged by
  construction. Adds a per-arm coin table and the margin by arm.
- Frozen prediction (judge's version): cross-binary depth>=8 per graded
  run on four paired seeds, band [1.05, 1.13], pass at a point at or
  above 1.05 with the lower edge above 1.00, refuted entirely below
  1.03; per second the co-read with throughput at or above 0.98; the
  run-weighted grid coin share at or below 0.12 over four chunks (0.14
  on chunk 1), campaign at or below 0.10, margin at or above 0.92;
  pooled.draws at or above 400,000; drag guard on grid-short and
  post-fault-2 per arm. Four chunks.

## selector-arm-cell-borrows-sibling-arms-evidence-to-discount-window

- kind: add | category: scheduler | origin: proposer | status: KEPT at
  iteration 61 (judge gain 4, rank 2; near full pooling inside a chunk on
  its treated half; kept for the case where the shared cell's per-arm
  tables show heterogeneity) | parent:
  selector-cells-pooled-by-configuration-across-grid-arms

## selector-every-learner-credits-every-run-with-its-own-reward

- kind: add | category: feedback | origin: proposer | status: CLOSED at
  iteration 65 on one chunk (depth>=8 per run 0.970 [0.927, 1.016]
  against refutation at 1.02; the coin share rose instead of falling;
  throughput 0.90 from three learners writing every run's cell; patch
  kept under research/lite/patches/cross-credit) | parent:
  selector-explore-share-posterior-odds-against-leader-most-decided-axis

## selector-cells-pooled-by-fault-shape-across-grid-arms

- kind: add | category: scheduler | origin: proposer | status: KEPT at
  iteration 61 at the bottom (judge gain 3; the window caps its coin
  share near 0.10, its panel claim misnamed the members; not to be built
  while the configuration-keyed form is unread) | parent:
  selector-cells-pooled-by-configuration-across-grid-arms

## post-fault-hold-then-rush-direction

- kind: arm | category: scheduler | origin: proposer | status: KEPT at
  iteration 62, not built (judge gain 4, cost 0, rank 1 of the round; the
  only mechanism that survived verification, but a within-run priority
  rule whose best outcome is a 1.5x lean at depth 11 undecidable under
  four chunks; the 10-to-11 funnel reads 0.18 on the rush already) |
  parent: post-fault-request-rush-arm

## post-fault-hold-reads-released-at-ghost-consequence-landing

- kind: arm | category: scheduler | origin: proposer | status: REJECTED at
  iteration 62 (judge gain 3, cost 2: the first acted landing at the
  never-restarted node is the label-12 leaf itself, so reads released
  there are invoked before the StartView lands; a record field would
  need exec.rs) | parent: post-fault-hold-class-split-read-write

## ghost-consequence-sends-deferred-until-post-fault-client-response

- kind: arm | category: scheduler | origin: proposer | status: REJECTED at
  iteration 62 (judge gain 2, cost 2: the segment that honours the ghost
  sends nothing on the chain, and the outstanding-at-send condition is
  false on every depth-10 run with one post-fault op) | parent:
  client-release-into-ghost-consumer-fanout-window

## causal-window-client-first-defer

- kind: arm | category: scheduler | origin: proposer | status: CLOSED at
  iteration 63 on two chunks (cross-binary flat at every rung; the deep
  tail on CLIENT_FIRST runs leans down, depth>=11 6 vs 19, depth>=12 3 vs
  15; the merged rewards read the window flat so the learners hold it at
  the coin; patch kept under research/lite/patches/causal-window for the
  segment table, the mask, the lift and the competitors census) | parent:
  ghost-consequence-sends-deferred-until-post-fault-client-response
- While a post-fault client operation is outstanding (one window per
  operation, 64 steps at most), the network draw skips same-role remote
  records with no post-fault cause, except replies to the destination's
  current incarnation and restart sends; a liveness lift when nothing
  else can move.
- Frozen prediction (judge's version): depth>=11 per run CLIENT_FIRST
  against STOCK, probe-free and co-bit matched, four chunks; merge on a
  lower edge above 1.0 (a point near 1.75), refute on an upper edge
  below 1.25 with the observable met, else unresolved with eight chunks
  pre-committed; the band applies only if the depth-10 competitors-at-
  open share is at or above 0.5 (0.3 to 0.5 a lean, below 0.3 void);
  depth>=8 in [0.96, 1.03]; depth>=10 refute below 0.90; smoke and
  chunk-1 gates on masked_records (100,000), windows opened (0.9 of
  post-fault invocations), closed on response (0.7), lifts (0.02),
  empty-masked-network steps (0.25 of window steps), timer fires inside
  windows (1.5x stock), steps per run (1.03x), plan completion (2
  points), throughput (0.97), mencius windows exactly zero.

## ghost-consequence-defer-from-send-with-client-work-release

- kind: arm | category: scheduler | origin: proposer | status: CLOSED at
  iteration 63 on its smoke as inapplicable (about 6,400 held records per
  chunk against a floor of 40,000; a ghost at a restarted destination
  rarely acts, so the flagged class is thin; two thirds of holds released
  by the caps); its quarter rides the causal-window session as a
  near-stock control | parent:
  ghost-consequence-sends-deferred-until-post-fault-client-response
- Records sent by a segment at a restarted node that acted on a fault-
  crossing entry (one hop through local records) are skipped at the
  draw from their send until an acted post-fault-caused same-role entry
  at their destination, any post-fault response, 64 idle steps, or 192
  steps. Frozen prediction: depth>=11 against STOCK as the sibling's,
  the flagged-at-invocation share at or above 0.6 to apply the band;
  depth>=8 in [0.97, 1.03], depth>=9 at or above 0.95; idle plus
  absolute cap releases at or below 0.50 of held records.

## causal-window-fanout-first-inverse

- kind: arm | category: scheduler | origin: proposer | status: REJECTED at
  iteration 63 for this session (judge gain 2; halves the live
  directions' power and separates nothing on paxos-accept-stale-ballot;
  re-proposable after the axis reads) | parent: causal-window-client-first-defer

## selector-graded-credit-by-chain-rung-for-learner-c

- kind: add | category: feedback | origin: proposer | status: CLOSED at
  iteration 64 on its smoke as inapplicable (C's own-run level-2 rate
  0.0010 against the 0.010 floor; the label-11 order is 6 percent of the
  core; patches kept under research/lite/patches/graded-credit, the
  columns build and the graded build, with the smoke census) | parent:
  per-cell-selector-absorber-cycle-closed-before-first-post-fault-request-entry-reward
- Learner C's credit becomes fractional by chain level: 0 below the
  core, a third for cycle-before-request, two thirds when a target-gated
  post-fault answer acted at a never-restarted node before any restarted
  sender's news acted there since the request, one when such news then
  acted at that node; the per-origin segment table ported state-side on
  every run makes the reply route readable; a shadow boolean pair per
  cell counts leaders changed.
- Frozen prediction (judge's version): merge on no harm (C's hold and
  retarget shares at or above 0.85, C's depth>=8 ratio of ratios upper
  edge at or above 0.95, cross-binary depth>=8 at or above 0.98,
  throughput at or above 0.97, steps at or below 1.02x), the level-2
  column's alignment (hold/stock at or above 1.3, rush/stock at or below
  0.85 pooled over two chunks), and legible non-inertness (cells with a
  leader changed at or above 5 by chunk 2, or a per-axis sign the core
  lacks at z 2 over four chunks); depth>=11 ratio of ratios against
  1.165 a lean in [1.05, 1.5], refuted only if entirely below 1.0;
  inapplicable if C's own-run level-2 rate is below 0.010 on the smoke;
  a clean null files the rule and merges the columns.

## per-cell-selector-cycle-before-request-and-post-fault-answer-before-restarted-news-reward

- kind: add | category: feedback | origin: proposer | status: KEPT at
  iteration 64 as level 2 of the graded credit and a coin column (judge
  gain 5, rank 2; the answer class rewritten to require the operation's
  client-role request to have entered the node) | parent:
  per-cell-selector-absorber-cycle-closed-before-first-post-fault-request-entry-reward

## per-cell-selector-post-fault-answer-then-restarted-news-acted-at-never-restarted-node-reward

- kind: add | category: feedback | origin: proposer | status: KEPT at
  iteration 64 as level 3 of the graded credit and a coin column; the
  fourth learner and bit 4096 not built (judge gain 3, rank 4; a
  re-drawn learner split would cut C to a quarter) | parent:
  per-cell-selector-cycle-before-request-and-post-fault-answer-before-restarted-news-reward

## per-cell-selector-restarted-competitor-queued-at-post-fault-answer-reward

- kind: add | category: feedback | origin: proposer | status: KEPT at
  iteration 64 as a coin column and histogram (judge gain 4, rank 3; the
  learner form is inapplicable at 0.003 to 0.009; it measures the calm
  hole) | parent:
  per-cell-selector-cycle-before-request-and-post-fault-answer-before-restarted-news-reward

## replay-prefix-checkpoint-after-acted-overtaken-ghost

- kind: add | category: scheduler | origin: proposer | status: CLOSED at iteration 66 (normal-chunk fallback 57.1% against <30%; throughput 0.941 and primary/sec 0.922; patch kept under research/lite/patches/acted-checkpoint) | gain: 7 | cost: 2 | rank: 1
- Branch the replay corpus after an acted overtaken ghost, preserving the recovery ordering.
- Frozen specification, prediction, observables, falsifiers and judge review: `research/lite/plans/iteration-66-admitted.json`, hypothesis `replay-prefix-checkpoint-after-acted-overtaken-ghost`.

## selector-one-parent-conditional-direction-posteriors

- kind: add | category: feedback | origin: proposer | status: CLOSED at iteration 67 (two seeds: repeated AOS harm, failed interaction prediction; grid primary gain did not justify merge; patch retained) | gain: 4 | cost: 0 | rank: 2
- Choose later scheduling directions conditionally on the cell's most decided axis.
- Frozen specification, prediction, observables, falsifiers and judge review: `research/lite/plans/iteration-66-admitted.json`, hypothesis `selector-one-parent-conditional-direction-posteriors`.

## selector-direction-evidence-on-common-cell-clock

- origin: proposer | status: REJECTED at iteration 67 as specified: its own 4% lower-edge admission condition fails the recorded 5% layout floor. Underlying mechanism remains untested. Full review: research/lite/plans/iteration-67-admitted.json.

## selector-learned-first-crash-relative-quantile

- origin: proposer | status: REJECTED at iteration 67 as specified: its own 4% lower-edge admission condition fails the recorded 5% layout floor. Underlying mechanism remains untested. Full review: research/lite/plans/iteration-67-admitted.json.

Conditional selector selected for iteration 67, with its iteration-66 frozen prediction unchanged; full judge record in research/lite/plans/iteration-67-admitted.json.

Iteration 68 direction pruning: current scores/dispositions in `research/lite/plans/iteration-68-admitted.json` supersede historical KEPT scores for next selection. Awaiting-approval entries remain unchanged.

## selector-conditional-parent-by-policy-interaction-value

- origin: proposer | status: CLOSED at iteration 68 (adequate parent/choice changes, failed argmax gate; primary/sec0.990 and campaign/sec0.964; one chunk, patch retained) | gain: 4 | cost: 0 | rank: 1
- Choose the conditioning axis by the value of adapting the other axes. Frozen prediction and review: `research/lite/plans/iteration-68-admitted.json`.

## selector-successful-joint-arms-with-uncertain-axis-mutation

- origin: proposer | status: KEPT at iteration 68 | gain: 3 | cost: 0 | rank: 2
- Resample successful joint arm sets and mutate their uncertain axes. Frozen prediction and review: `research/lite/plans/iteration-68-admitted.json`.

## replay-prefix-dependent-choice-frontier

- origin: proposer | status: CLOSED at iteration 69 (applicability31.3% below60%, tape4.77x above1.50, throughput0.872; one chunk, patch retained) | gain: 7 | cost: 2 | rank: 1
- Replay to distinct dependent dispatch choices and enumerate their alternatives. Full frozen implementation, prediction and source review: `research/lite/plans/iteration-69-admitted.json`.

## replay-prefix-causal-chain-demotion-search

- origin: proposer | status: KEPT at iteration 69 | gain: 5 | cost: 2 | rank: 2
- Keep causal-chain scheduling priorities through replay suffixes and demote chains at sampled change points. Full frozen implementation, prediction and source review: `research/lite/plans/iteration-69-admitted.json`.

Iteration69 selects dependency frontier at net5; causal-chain demotion and retained successful-vector population mutation each net3. Previous conditional-parent closure does not empirically answer these mechanisms.


## eval-transient-scalars-and-borrowed-operands

- origin: proposer | status: CLOSED at iteration 70 (fixed evaluator-work reduction21.008% below25%; no performance grade, patch retained) | gain: 7 | cost: 2 | rank: 1
- Carry borrowed/scalar intermediates inside pure evaluation until a canonical value escapes. Explicit perf-specific cross-binary exception; full frozen prediction, correctness corpus and review: `research/lite/plans/iteration-70-admitted.json`.

Iteration70 selects transient evaluator net5. Causal-chain demotion remains net3/rank2; successful-vector population remains net3/rank3. Frontier69 is closed. Awaiting-approval entries remain unchanged.
