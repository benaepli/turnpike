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
  KEPT at iteration 39 (judge gain 4, cost 0, rank 2; the chain reading was wrong - label 7 is the Recovery request and the most recently restarted node is node 2, whose third acted entry is the write itself - so a census of the acted count at the label-9 entry comes before any N is credited) | previously PROPOSED at iteration 37 | parent:
  post-fault-request-timing-axis (filed) and the 64-step deferral (merged)
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

- kind: add | category: scheduler | origin: proposer | status: KEPT at iteration 39 (judge gain 3, cost 2, rank 3) | parent: iteration-39 delivery-axis round
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

- kind: add | category: scheduler | origin: operator-agent | status:
  PROPOSED at iteration 38 for the next judge round | parent:
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
  PROPOSED at iteration 39 for the next judge round | parent:
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
