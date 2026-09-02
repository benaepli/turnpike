# client-request-placement-span-draw

status: awaiting-approval | origin: proposer | judge gain 8, cost 2, net 6

## What changes

Client requests get the admission timing crashes already have. A request that
becomes eligible may be held and invoked at a later step of the same run
instead of at the step its plan predecessors clear.

Today crashes carry a priority, an eligibility mask and a hold step
(`path.rs:521-542`, `scheduler.rs:700,773-846`), while
`EventAction::ClientRequest` is invoked inline at `path.rs:458` in the first
step it is eligible. There is no client-op analogue anywhere in `simulator/`.
So every request with no plan predecessor is invoked in the opening steps and
the workload is front-loaded; the only client work that lands late is
whatever `post_fault_client_ops` happened to order there, which is one
request per recover, chosen uniformly, so a read about two thirds of the
time.

Files: new `simulator/client_place.rs`; `simulator.rs` module line;
`path.rs` dispatch site; `core/state.rs` one bool; `run_variant.rs` two bits;
`explorer.rs` four call sites; `util_stats.rs` counter block; `rng.rs` one
stream; `fault_timing.rs` extract `span_bound` so both placers share one
implementation of the median-and-reserve arithmetic.

## How a hold works

Per step, replacing `path.rs:424-456`:

1. Collect ready events as today. `get_ready_events` performs its own
   `Ready -> InProgress` transition.
2. For each ready client request, call `client_place::draw_hold`. On `Some`,
   move it to a local held map keyed by node index and set
   `state.client_hold_drawn`. Everything else is admitted untouched.
3. Move held entries whose target step has arrived into the admitted set,
   in node-index order to match `get_ready_events`' own sort.
4. If the admitted set is empty, the queues are empty and something is held,
   release the earliest-target held entry now.
5. Run the deadlock test against the admitted set rather than the raw ready
   list.
6. Dispatch the admitted set through the existing loop, unchanged.

**Held requests live in a local map, not back in the plan engine.** Returning
a held event to Ready and re-offering it would leave the ready list non-empty
on every subsequent step, and the deadlock test's first conjunct is
`ready_events.is_empty()` (`path.rs:430-433`). The test could then never fire
again for the rest of the run: a run that wedges at step 40 would grind to
its step limit instead of stopping. That costs wall-clock on dead runs and
inflates run length, which is one of the numbers this change is checked
against. `PlanEngine::mark_as_ready` stays dead code.

For an untreated run the admitted set equals the ready list element for
element, so step 5 is a no-op rewrite there. On a treated run step 4
guarantees the admitted set is non-empty whenever anything is held and the
queues are dry, so a hold can never be read as a deadlock, and a genuine
deadlock is still caught because a genuinely stuck run has released its held
requests first.

A held event stays `InProgress`, so `is_complete()` and `outstanding_count()`
see it exactly as they see an invoked request awaiting its response.

## Which requests are held

Each eligible request is held independently with probability one half; if
held, its target step is drawn uniformly over
`[ready_step, min(L50, effective_cap/2))`, where `L50` is the median
completed-run length the `fault_timing` learner already maintains per
backup-budget scope. Below that learner's 200-sample floor nothing is held
and no randomness is consumed.

**The rule reads nothing about the request beyond it being a client request.**
It does not look at the operation kind, at whether the request is the first
of its kind, or at which node it targets. That is deliberate. The graded rung
is prefix depth against an oracle DAG whose landmarks include client
invocations, and whose match is anchored at its root, so a rule that exempted
certain requests to keep the oracle's root event early would be a design
choice made by reading the scoring function. The project's generality test
forbids that, and a mechanism tuned to the metric cannot tell us whether the
search improved. A blind coin costs some of the effect and buys a number we
can trust.

The cost is real and is watched rather than assumed away: on runs whose only
early write is held, the oracle's root goes unmatched and the run scores a
shallow prefix. The shallow-rung clause in the prediction is what detects it.

## Posture and tagging

`is_placed(run_id) = !run_cap::is_probe(run_id) && run_phase::phase(run_id, 128) >= 64`.

Every phase is the same mixed value reduced (`run_phase.rs:19-32`), so this
reads bit 6 of the mix while the run-cap probe reads bits 0-4 and crash
placement bits 0-5. The new posture is therefore independent of the three
existing ones, and inherits the grid-width decorrelation the alias fix
bought. Share about 48.4%.

Probes are exempt because `run_cap` and the span table are fed only by
probes; a treated probe would feed a hold imprint back into the bound that
governs holds, and the within-session contrast would stop extrapolating.

Tag bits `CLIENT_PLACED = 1<<4` (from the run id) and
`CLIENT_HOLD_DRAWN = 1<<5` (set when a hold was actually drawn), so the
grader's variant contrast reports placed against stock without hand work.

`draw_hold` returns `None` before touching any random stream on a stock run,
so the untreated half is byte-identical to today including draw counts. The
new stream is appended at index 7 and seeds are index-keyed, leaving streams
0-6 unchanged.

## Counters

| counter | fired as intended when |
|---|---|
| `client_place.draws` | > 0 in chunk 1; about (treated runs) x (client ops / 2) |
| `client_place.holds` | >= 50000 per chunk; withheld steps summed per step |
| `client_place.held_steps_sum` | `held_steps_sum / draws` around `U/2`, 300-600 |
| `client_place.capped_draws` | roughly the grid-short arm's share of draws |
| `client_place.quiescent_releases` | under half of draws |
| `client_place.unreleased_at_exit` | about 0; a large value means requests never reach the history |

One atomic per step rather than one per held request.

## Run length

Held requests defer plan completion, so treated runs could complete less and
hit the learned cap more, and per-run depth could rise merely because treated
runs are longer. Three things bound it:

1. The absolute span bound does most of the work. Nothing is held past
   `U = min(L50, effective_cap/2)`. With L50 around 1000-1200 measured and a
   learned cap near 4859, `U` is about a quarter of the run's allowance, and
   the delay to completion is bounded by `U - ready_step` rather than by any
   sum over requests.
2. The reserve is half the cap, not the three quarters crash placement uses,
   because a held crash completes when scheduled while a held request must be
   invoked and then answered, and the response costs hundreds of steps. This
   binds only on the `grid-short` arm.
3. Holds cannot stack. The target is an absolute step, not a displacement, so
   a request delayed behind another still draws against the same `U`;
   composition contracts toward `U` rather than walking away from it.

Quiescent release is a correctness backstop against dead air, not a
run-length control: `all_queues_empty` includes the timer queue and this
rig's frontier essentially never empties, so it will fire rarely.

## Risks

- `core/exec.rs` is not touched. `core/state.rs` gains one bool beside
  `crash_hold_drawn`; it must stay out of `signature()` or it changes
  deduplication. `core/scheduler.rs` is not touched: a request never becomes
  a runnable until admitted, so there is no eligibility mask.
- No new runnable variants, no new history kinds, the completion scan
  untouched.
- A request still held at run exit produces no invocation and no response,
  where stock would have produced a pending invocation. Valid for the checker
  either way, but it lowers per-run violation exposure slightly.
  `unreleased_at_exit` reports whether this happens at any scale.
- The mechanism moves the timestamps of events the rung is computed from.
  What separates it from tuning to the metric is that it changes when the
  system does real work rather than what is recorded, and that no part of the
  hold rule consults the oracle. The panel run (anchors paxos 223.42,
  mencius 6.30) is the check that the change helps other protocols too, and
  runs before any merge.

## Operator work

The steps-per-run and plan-complete observables are not derivable from
today's variant cell, which carries runs, graded runs, the depth ladder,
violations and summed wall time. Reporting them needs `VARIANT_BITS` to gain
bits 16 and 32 and `VariantMetrics` to gain `stepsUsedSum` and
`planCompleteRuns`, filled from fields already on the run row. That is
harness work and mine, not the implementer's.

## Frozen prediction (freezes at approval)

- firing counter `client_place.holds`, floor 50000
- rung depth>=6, sizePct 0.05 .. 0.40
- independent observables: `post_fault_ops.ops_invoked_after_last_recover`
  per run up at least 25% from 1.60; `held_steps_sum / draws` well above
  zero; `quiescent_releases` under half of `draws`; steps per run and
  plan-complete share reported per posture each chunk
- falsifier, with holds >= 50000: refuted if placed-posture pooled per-run
  P(depth>=6) is at or below stock-posture on the candidate side; or pooled
  depth>=6 per explore-second below 1.05 net of a same-session A/A; or
  throughput falls more than 10%; or placed steps per run is outside 15% of
  stock, since depth bought with run length is not a pass; or placed
  P(depth>=2) falls more than 5% below stock, which says holding the run's
  early writes is costing the oracle's root faster than the late writes gain
  depth. Closed without a rate read if holds < 50000 or the span table never
  crosses its floor.

The band is lower than the effect the actuator produced on crashes because
the blind coin holds the run's early requests too, and those losses net
against the late-request gains. That is the price of a rule that does not
read the scoring function.

## Grading plan

- Chunk 1 is a firing and safety check: `draws > 0`, `holds >= 50000`,
  `held_steps_sum / draws` in 300-600, `unreleased_at_exit` about 0.
- Primary read is the internal contrast, variant bit 16 at depth>=6, treated
  against stock, pooled on the candidate side. Bit 32 is the acted upper
  bound and is not randomised.
- Secondary: pooled depth>=6 per second at least 1.05 net of A/A;
  throughput at least 0.90.
- Gates each chunk: placed steps per run within 15% of stock;
  placed P(depth>=2) within 5% of stock.
- Expect 2 chunks, up to 4.
- Stop early if chunk 1 shows the contrast at or below 1.0, or either gate
  breached.

## Tests

Breaking by design: the utilization export completeness test destructures
without a rest pattern; the `run_variant` tests and both `explorer.rs` call
sites for the changed `of()` signature. The `fault_timing` cap-reserve test
must keep passing unmodified, which is what proves the `span_bound`
extraction was arithmetic-neutral.

New: a stock id and a probe id draw nothing and consume no randomness;
posture independence from the other three bits over 64k ids with
placed-and-probe empty; a draw lands inside `[ready_step, min(L50, cap/2))`
and nothing once the span is spent; and an integration test asserting every
history has a response for every invocation, `unreleased_at_exit` is zero,
and at least one placed run has a client invocation at a step past a crash.
