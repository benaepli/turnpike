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

- kind: add | category: scheduler | origin: proposer | status: HELD at
  iteration 29 (judge gain 5; cost 2 as proposed via a Record field in
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

- kind: add | category: scheduler | origin: proposer | status: ADMITTED at
  iteration 31 (judge gain 6, cost 2 by the pool's precedent for invocation
  timing; iteration-31 top pick) | parent: client-request-placement-span-
  draw (closed under the old rung, whose oracle had no w2 label)
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
