# client-request-placement-span-draw

status: awaiting-approval | origin: proposer | judge gain 8, cost 2, net 6

## Hypothesis

Client requests get the admission placement crashes already have: a released
request is held until later in the run's own activity instead of being
invoked the step it becomes ready.

The gap is verified and real. Crashes carry a `Runnable` priority, an
eligibility mask and `crash_hold_until` (`path.rs:521-542`,
`scheduler.rs:700,773-846`); `EventAction::ClientRequest` is invoked inline
at `path.rs:458` in the first step its plan predecessors clear, and grep
finds no client-op analogue anywhere in `simulator/`. So the whole workload
is front-loaded, and the only client work that can land late is whatever
`post_fault_client_ops` (1, one uniformly chosen request per recover, a read
about two thirds of the time) happened to order there. Crash timing had an
actuator and moved depth>=6 per explore-second 2.39x once placement was
drawn over the completed span; client timing has none, on a per-run
population four times larger (~9 client events against 2 crashes).

## Frozen prediction (judge's rewrite; frozen at approval)

- firingCounter `client_place.holds`, floor 50000
- rung depth>=6, sizePct 0.10 .. 0.50
- independent observables: `post_fault_ops.ops_invoked_after_last_recover`
  per run up >=25% from 1.60; `held_steps_sum/draws` well above zero;
  `quiescent_releases` under half of `draws`; **steps-per-run and
  plan_complete share reported per posture each chunk**
- falsifier: with holds >= 50000, refuted if placed-posture pooled per-run
  P(depth>=6) is at or below stock-posture on the candidate side; or pooled
  depth>=6/s below 1.10 net of a same-session A/A; or throughput falls more
  than 10%; **or the placed per-run gain is not accompanied by placed
  steps/run within 15% of stock** - depth bought with run length is not a
  pass. Closed without a rate read if holds < 50000 or the span table never
  crosses its floor.

## The proposal's stated mechanism does not work

It said the held event is returned to Ready via `PlanEngine::mark_as_ready`
and re-offered later. Do that and `get_ready_events` returns the held event
on every subsequent step, so `ready_events` is never empty, and the deadlock
test at `path.rs:430-433` - whose first conjunct is `ready_events.is_empty()`
- can never fire again for the rest of the run. Not a false deadlock: a
permanently suppressed one. A run that would have exited at step 40 as
`Deadlock` instead spins to the learned cap, which is also the cheapest way
to fail the steps/run clause.

Use a local held map at the dispatch site; `mark_as_ready` stays dead. Per
step: collect ready events as today, partition into admitted and held, drain
held entries whose target has arrived, apply the quiescent release, then run
the deadlock test against `admitted` rather than `ready_events`. For an
untreated run `admitted == ready_events` element-for-element, so the rewrite
is a no-op there.

## The first-of-kind exemption, and why it is load-bearing

The graded oracle is `research/oracle/relax_minimal_general.json`, whose
chain is `w1 -> allow_t1 -> crash_nl -> deliver_1->2 -> crash_2 -> recover_2
-> w2 -> deliver_*->0 -> r1/r2/r3`. So depth>=6 is `recover_2` and depth>=7
is `w2`. `w1` is the DAG's only root, its candidates are Invocation rows,
and `rootAnchoredPrefix` gives depth 0 to every non-root label unless a
matched predecessor precedes it. A run whose only node-0 write is invoked
after `crash_nl` scores prefix depth 1, not 6.

Holding every request would displace that write in about half of treated
runs, and with 2-4 writes over 3 servers many runs have exactly one node-0
write. Holding everything is plausibly net-negative at the frozen rung while
positive at depth>=7. So the run's first ready request of each kind is
admitted unheld: `w1` stays where stock puts it, and the remaining 1-3
writes spread across the fault segment - the `w1`-early / `w2`-late
structure depth>=7 needs.

## Ordering versus timing

The nearest recorded evidence is `OBSERVATIONS.md:3052`, which closes
`post_fault_client_ops` permanently: at dose 0 every rung stayed inside the
A/A band (d>=6 delta -0.028) across five evaluations. Four reasons it does
not bound this candidate:

1. It was measured in a pre-placement regime (ablation 2026-08-30; crash
   placement merged 2026-08-31/09-01). Then, crashes fired at readiness in
   the opening burst, so "after the last recover" meant "around step 5".
   Recovers now land uniformly in [0, L50~1100). The ablation bounds the
   value of ordering client work after an *early* recover.
2. Realized dose: the knob moved 1.6 ops per run against 6-12 client ops.
   Placement acts on every non-exempt request, targeting 3-5.
3. Reach: a DAG edge can only say "after a completed event", and the
   generator only emits `recover -> request`. It cannot place a request
   *inside* an outage or *between* two crashes - which is exactly where the
   oracle's depth>=6 gate lives. Scheduler-side timing covers that interval;
   plan ordering structurally cannot.
4. The knob's chosen request is a read about two thirds of the time, so most
   ordered ops can never match `w2`.

If chunk 1 shows the contrast at ~1.0 with `ops_invoked_after_last_recover`
up sharply, the invocation-timing family closes alongside the ordering
family. That is a clean, cheap negative.

## Run-length control

1. The absolute span bound does almost all of it: no request is held past
   `U = min(L50, effective_cap/2)`. With L50 ~1000-1200 and a learned cap of
   ~4859, U is ~23% of the run's allowance, and the delay to completion is
   bounded by `U - t_ready`, not by any sum over requests.
2. `CAP_RESERVE = 1/2`, not the crash placer's 3/4: a held crash completes
   when scheduled, but a held request must be invoked *and answered*, and
   the response costs hundreds of steps. This binds only on `grid-short`
   (max_iterations 1500), where 3/4 would put the last invocation at step
   1125 of 1500 and make a cap exit near-certain.
3. The write chain (`generator.rs:184-206`) does mean a held write delays
   writes two positions later, but holds cannot stack: the target is an
   absolute step, not a displacement, so composition contracts toward U.

Quiescent release is a correctness backstop, not a run-length control, and
the plan says so rather than claiming it as the guarantee: `all_queues_empty`
includes the timer queue and this rig's frontier essentially never empties
(`plan_complete_quiescent = 0`). Expect it to fire near never - which passes
the frozen observable for the opposite of the intended reason.

Expected cost: something in +3..8% on steps/run, inside the 15% clause but
not comfortably, tightest on grid-short.

## Risk flags

- `core/exec.rs`: not touched. `core/state.rs` gains one bool beside
  `crash_hold_drawn`; it must stay out of `signature()` or it changes
  deduplication. `core/scheduler.rs` untouched - there is no eligibility
  mask, because a request never becomes a runnable until admitted.
- Event accounting: no new `Runnable` variants, no new history kinds, the
  completion scan untouched.
- Linearizability: the recording path is unchanged, but a request held at
  run exit produces neither an Invocation nor a Response where stock would
  have produced a pending Invocation. Valid for porcupine either way, but it
  lowers per-run violation exposure slightly. `unreleased_at_exit` is the
  counter that says whether this happens at any scale; expected ~0.
- **Goodhart flag, the one to weigh.** Write/Read/Rmw DAG candidates are
  Invocation rows and `Event.Step` *is* the invocation step, so this
  mechanism directly reschedules the quantity the rung is computed from.
  Two defences. It does so by changing when the system under test does real
  work - the messages, races and responses are genuine - which is the same
  status crash placement has. And the first-of-kind exemption was chosen
  with the oracle's root in view, which is stated here rather than buried;
  if that reads as too tailored, the neutral fallback is a per-request
  Bernoulli(1/2) hold, which spreads the same way without naming op kinds,
  at the cost of losing the `w1` root in ~25% of single-write runs. The
  panel (anchors paxos 223.42, mencius 6.30) is the real defence and should
  run before any merge.

## Operator work this needs (outside the implementer's lane)

The judge's steps/run and plan_complete observables are **not derivable from
today's variant cell**, which carries only runs/gradedRuns/depthAtLeast/
violations/wallUsSum. Reporting them needs `research/orchestrator/src/`
changes - `VARIANT_BITS` gains bits 16 and 32, `VariantMetrics` gains
`stepsUsedSum` and `planCompleteRuns`, filled from `RunRow.steps_used` and
`end_reason`, both already on the row. That is harness work, so it is mine
between iterations, not the implementer's.

## Grading plan

- Chunk 1 is a firing-and-safety check, not a rate read: `draws > 0`,
  `holds >= 50000`, `held_steps_sum/draws` in 300-600, `unreleased_at_exit`
  ~0.
- Primary read is the internal contrast, `variantContrasts` bit 16 at
  depth>=6, treated vs stock, pooled on the candidate side. Bit 32
  (`clientHoldDrawn`) is the selected-and-acted upper bound only.
- Secondary: pooled depth>=6/s >= 1.10 net of A/A; throughput >= 0.90.
- Run-length gate: placed mean steps_used within 15% of stock, plan_complete
  share alongside.
- Expect 2 chunks, up to 4.
- Stop early if chunk 1 shows the contrast at or below 1.0 (the internal
  falsifier has fired), or placed steps/run more than 15% above stock, or
  the depth>=1..3 rungs collapsing on the placed side, which is the `w1`
  root failure and says the exemption needs widening first.

## Tests

Breaking by design: `util_stats_export_completeness.rs` (no rest pattern -
the guard doing its job), `run_variant.rs` tests and both `explorer.rs` call
sites for the `of()` signature change. `fault_timing.rs:438-459` must keep
passing unmodified, which is what proves the `span_bound` extraction was
arithmetic-neutral.

New: stock and probe ids draw None and consume zero randomness (transplant
of `fault_timing.rs:399-415`); posture independence from the other three
bits over 64k ids with `placed AND probe` empty; draw inside
[t_ready, min(L50, cap/2)); and an integration test in the shape of
`run_cap_exit.rs` asserting every history has a Response for every
Invocation, `unreleased_at_exit == 0`, and at least one placed run with a
client Invocation at a step past a Crash row's step.
