# ghost-prefix-replay-corpus

Iteration 21, epoch 13. Carries retarget-census-after-landing-fix as its
first commit.

## First commit: counter reordering in the merged retarget

At crash application the crash-anchor apply, term_acted, crash census and
crash_phase apply counters read the planned victim's ledger before the
retarget picks the landing node, so on treated runs about a fifth of those
rows describe a node that did not crash. Move those reads after the landing
is known and read the landing node's ledger; keep the anchor's arm keyed on
the planned node. No behaviour change on either half.

Frozen claim, exact per chunk: crash_census.victim_had_inflight_sends and
crash_anchor.applied each equal the sum of the two victim_swap census
inflight counts; crash_census.decisions equals crash_anchor.crashes_taken
and the two census crash counts. Predicted shift: early and mid
apply_victim_had_inflight shares fall from 0.842-0.848 into [0.815, 0.840];
stock stays in [0.715, 0.740]; release shares within 0.5 points of today.
Behaviour rails: victim_swap.applied over treated crashes in [0.18, 0.21];
victim_crashed_holds per treated run in [1.3, 2.7]; crashes per treated run
within 1% of crashes per control-plus-probe run; the bit-19 depth>=6
contrast's point inside [1.60, 1.85] with its interval overlapping it.
Falsifier: any identity broken; early or mid apply share outside
[0.80, 0.85]; applied share outside [0.18, 0.21]; bit-19 interval entirely
outside [1.55, 1.90]. Cost: throughput >= 0.95.

## Mechanism: coverage-guided prefix re-execution in the grid arms

Signal, on every run, once per run: a first-entry delivery whose origin is
crashed or has a stale incarnation enters a node whose ledger has a crash
pending. At that step the run stores the step and the RNG tape position.
Grid arms record every run's RNG tape; each arm keeps a corpus of 64
parents (tape to the cut, workload seed, config, config index, cut step,
uses) with FIFO eviction and at most 8 children per parent. A fresh run
that fires the signal is admitted; children never are. A run id is a
replay slot on a salted half of grid-arm runs (bit 1 << 20, replaySlot);
run-cap and timer-steer probes are never children. A slot with a non-empty
corpus runs a child of the next parent: PREFIX children (bit 1 << 21,
replayPrefix, a salted half of slots) replay the parent's tape to the cut
with a fresh suffix from the child's own seed; PLAN-ONLY children rerun
the parent's config and workload seed with a fresh schedule seed and no
tape. A slot with an empty corpus runs fresh and is counted. Children carry
the parent's config index and record no tape.

## Frozen prediction

- Bits: REPLAY_SLOT = 1 << 20 (replaySlot, merge read), REPLAY_PREFIX =
  1 << 21 (replayPrefix, nested attribution), both in run_variant.rs and
  VARIANT_BITS.
- Rung and band: depth>=6 per-run ratio treated (slots) against untreated
  (fresh), probe-free, co-bit matched, in [1.30, 4.00].
- Firing: replay.children >= 100,000 per chunk, with
  replay.{parents_admitted, children_prefix, children_plan_only,
  slots_unfilled, prefix_faithful, tape_words_sum,
  parent_depth6_children_pairs} exported.
- Independent observables: prefix_faithful over children_prefix >= 0.5;
  PREFIX >= 1.3x PLAN-ONLY on depth>=6 and >= 1.2x on depth>=7 per run;
  depth>=8 per treated run >= 0.9x control.
- Falsifier: the depth>=6 interval entirely below 1.30; or fidelity below
  0.5; or PREFIX not above PLAN-ONLY on depth>=6; or depth>=8 per treated
  run below 0.9x control.
- Cost clause: cross-binary throughput >= 0.92 (tape recording is a shared
  hot-path cost the contrast cannot see).
- Reading rule: children of one parent are correlated; inflate seEff by the
  square root of the design effect (about 2x at 8 children per parent)
  before reading the band.

## Grading

`start --treatment-bit 1048576 --band-min 0.30 --band-max 3.00`, two
chunks minimum; check the fix's identities on chunk 1.
