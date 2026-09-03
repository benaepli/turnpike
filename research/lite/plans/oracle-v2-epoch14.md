# Oracle v2: a label chain whose deepest rungs separate the violating runs

Candidate files (this directory, `candidate/`):

- `relax_minimal_general_v2.json` (key "key1") and `relax_minimal_v2.json`
  (key "x"): 20 labels, 26 edges, existing label kinds only. Identical up to
  the key. This is the recommended oracle.
- `relax_minimal_general_v2_ghost.json` / `relax_minimal_v2_ghost.json`: the
  same DAG with a `dispatched_before` field on three deliver labels. Needs
  the matcher extension in section 4; the current loader ignores the field
  silently (json.Unmarshal into a struct drops unknown keys), so grading
  these with today's binary reproduces v2 exactly.

Grading outputs: `plan.v2*.json` (corpus, full run_depths),
`general.v2*.json.gz` (633,408-run store, run_depths), `*.summary.txt`
(histograms), `general_ge8_f_vs_h.txt` (per-run depth under v2 and under
the ghost-constrained v2 for the 6,654 general runs at v2 depth >= 8).
Variants a-h are in `mkdag.py`; `f` is the recommended one, `h` = f + ghost
fields. `matcher.py` is a Python re-implementation of witnessGreedy +
rootAnchoredPrefix over `-dump-run` JSON; it agrees with the traceanalyzer
on all 92 corpus runs and all 6,654 deep general runs checked (0
mismatches), and is the instrument for the extension estimate.

## 1. The chain

Node numbering in the spec: node 0 = OL (primary of view 0 = 0 mod 3), node
1 = NL (primary of view 1), node 2 = bug.md's "node 1". Prefix labels and
edges of the 13-label oracle are unchanged; new labels are marked +.

| depth | label | kind | meaning |
|---|---|---|---|
| 1 | w1 | write 0 | first write committed in view 0 |
| 2 | allow_t1 | timer node 1 "timeout" | NL suspects OL, broadcasts SVC(1) |
| 3 | crash_nl | crash 1 | NL crashes with its SVCs in flight |
| 4 | deliver_svc_1_to_2 | SVC 1->2 | the dead incarnation's SVC lands at node 2 (bug.md step 3); node 2 enters view change and sends SVC 2->0, SVC 2->1, DVC 2->1 |
| 5 | crash_2 | crash 2 | node 2 crashes with those three in flight (step 4) |
| 6 | recover_2 | recover 2 | node 2 restarts, sends Recovery to 0 and 1 |
| 7 | + deliver_rec_2_to_1 | Recovery 2->1, after recover_2 and recover_nl | node 2's post-restart Recovery reaches a node 1 that has itself recovered |
| 8 | + deliver_svc_2_to_1 | SVC 2->1, after rec_2_to_1 | the ghost SVC lands at node 1 only after the Recovery did: the Recovery was answered while node 1 was still normal in view 0 (P4_2) |
| 9 | + deliver_dvc_2_to_1 | DVC 2->1, after svc_2_to_1 | the ghost DVC lands after the ghost SVC, so node 1 is in view change and tallies it (P1c ordering; this is what the 22 R4 corpus runs get wrong) |
| 10 | w2 | write 0, after dvc_2_to_1, recover_nl, recover_2 | the write issued to the old primary once the ghost quorum has formed |
| side | + deliver_rr_1_to_2 | RecoveryResponse 1->2, after rec_2_to_1 | node 1 did answer (the response exists) |
| side | + deliver_rr_0_to_2 | RecoveryResponse 0->2, after recover_2 | node 0 answered too: node 2 has the f+1 responses to complete recovery |
| 11 | + deliver_pok_2_to_0 | PrepareOK 2->0, after w2, rr_1_to_2, rr_0_to_2 | node 2, recovered into view 0, acks w2 to the old primary: the old-view commit (P3) |
| 12 | + deliver_sv_1_to_0 | StartView 1->0, after pok_2_to_0 | the new leader's StartView reaches OL only after the old-view commit, so w2 is not in the new log (P3_lost) |
| 12 | deliver_svc_1_to_0, deliver_svc_2_to_0 | SVC x->0, after w2 and pok_2_to_0 (leaves) | node 0 must not have entered view change before it counted the PrepareOK; kept from the old oracle but no longer predecessors of the reads |
| 13 | r1, r2, r3 | read 0/1/2, after sv_1_to_0 | the reads that expose the lost write |

Edges added: recover_2->rec_2_to_1, recover_nl->rec_2_to_1,
rec_2_to_1->svc_2_to_1, svc_2_to_1->dvc_2_to_1, dvc_2_to_1->w2,
rec_2_to_1->rr_1_to_2, recover_2->rr_0_to_2, w2->pok_2_to_0,
rr_1_to_2->pok_2_to_0, rr_0_to_2->pok_2_to_0, pok_2_to_0->sv_1_to_0,
pok_2_to_0->deliver_svc_1_to_0, pok_2_to_0->deliver_svc_2_to_0,
sv_1_to_0->r1/r2/r3. Edges removed: deliver_svc_{1,2}_to_0->r1/r2/r3 (the
six read edges). Every other old edge is kept; depths 1-6 have exactly the
old meaning and the old counts (below).

Why the six read edges had to go: two of the eleven violating runs (2345,
2721) never deliver SVC 2->0 before the reads (node 0 already installed
view 1 from the StartView; the SVC is irrelevant to it), which is why the
old oracle left them at depth 8. Variant a keeps those edges and puts them
at depth 12 of 13. The SVC-to-0 labels are not part of the bug's mechanism
once the StartView has landed, so they are leaves.

Run 572 under the chain: rec_2_to_1@29, svc_2_to_1@30 (dispatched @25 <
crash_2 @26), dvc_2_to_1@33 (dispatched @25), w2@34, rr_1_to_2@35,
rr_0_to_2@39 (node 2 logs recovery complete view=0 at 39), pok_2_to_0@40
(node 0 executes op 2), sv_1_to_0@48 (node 0 installs view 1 with
op_number 1), svc_2_to_0@49, svc_1_to_0@50, reads@54. Run 3 (depth 9 under
the old oracle, not violating): rec_2_to_1@28 lands on a node 1 that is
still recovering (dropped), svc_2_to_1@29 follows it so depth 8 is reached,
but the only DVC 2->1 (@27, dropped) precedes it, so the run stops at depth
8 and never sees the pok/sv rungs.

## 2. Validation

Corpus `tmp/loop/precision/plan` (3,000 runs, 11 violating), exact depth:

| variant | 4 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | violating at max | non-violating at max | non-violating at >= 11 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| old oracle (max 9) | 2249 | 606 | 55 | 90 | - | - | - | - | 9 of 11 (2 at depth 8) | 81 (depth 9), 79 non-viol. at 9 in the epoch's count | - |
| v2 (= f, recommended) | 2249 | 336 | 250 | 49 | 105 | 0 | 0 | 11 | 11 / 11 | 0 | 0 |
| a (read edges kept) | 2249 | 336 | 250 | 49 | 105 | 0 | 2 viol. | 9 viol. | 9 (2 at 12) | 0 | 0 |
| b (w2 after svc not dvc) | 2249 | 336 | 35 | 341 | 0 | 15+2v | 13+9v | - | 9 | 13 | 28 |
| c (a without RR labels) | same as a | | | | | | | | 9 | 0 | 0 |
| d (a without pok/sv; RRs -> svc_x_to_0 -> reads, max 12) | 2249 | 336 | 250 | 49 | 105 | 2v | 9v | - | 9 | 0 | 0 |
| e (no rec->svc edge) | 2249 | 329 | 62 | 341 | 0 | 3+2v | 5+9v | - | 9 | 5 | 8 |
| h (f + ghost fields, Python matcher) | 2249 | 20+? | 51 | 0 | 10 | 0 | 0 | 11 | 11 / 11 | 0 | 0 |

(h row: A+B populations only, 92 runs: A 11 at depth 13; B 20 at 7, 51 at
8, 10 at 10.)

Reading: depth 10 (w2 after the ghost DVC after the ghost SVC after the
Recovery) still admits 105 non-violating corpus runs, all of them runs
whose w2 stalled or committed with node 1's own log; depth 11 (the
PrepareOK 2->0 after w2 and both RecoveryResponses) admits exactly the 11
violating runs and nothing else, over all 3,000 runs. Ordering the ghost
DVC before w2 (a vs b) and the Recovery before the ghost SVC (a vs e) each
cost precision when dropped: 13 and 5 non-violating runs at the top rung.
The RR labels add nothing on the corpus (c = a): a PrepareOK from node 2
after w2 already implies node 2 completed recovery. They are kept because
they make the rung's meaning explicit and because a payload extension
(response view) would attach to them; variant g (v2 without them) is the
equivalent 18-label form.

General store `tmp/loop/precision/general` (633,408 runs from one 300 s
session, zero violations; counts are therefore per-chunk counts):

| rung | old oracle (>= k) | v2 (>= k) | v2 exact | v2 + ghost fields (>= k), estimated | rung label |
|---|---|---|---|---|---|
| 1 | 341,354 | 341,354 | 17,461 | same | w1 |
| 2 | 323,893 | 323,893 | 201,072 | same | allow_t1 |
| 3 | 122,821 | 122,821 | 3,500 | same | crash_nl |
| 4 | 119,321 | 119,321 | 100,915 | about 110,000 (fresh re-timeouts drop out: 3-6% at the depth-6/7 strata, 16-27% at depth 8/9 per the census R1_fresh_only) | deliver_svc_1_to_2 |
| 5 | 18,406 | 18,406 | 618 | - | crash_2 |
| 6 | 17,788 | 17,788 | 326 | - | recover_2 |
| 7 | 1,965 (w2) | 17,462 | 10,808 | about 16,500 | rec_2_to_1 |
| 8 | 875 (svc to 0) | 6,654 | 5,670 | 5,771 (measured on the 6,654) | svc_2_to_1 |
| 9 | 74 (read) | 984 | 938 | 595 | dvc_2_to_1 |
| 10 | - | 46 | 31 | 10 | w2 |
| 11 | - | 15 | 6 | 1 | pok_2_to_0 |
| 12 | - | 9 | 9 | 0 | sv_1_to_0 |
| 13 | - | 0 | 0 | 0 | read |

Depths 1-6 are unchanged to the run (same depth_at_least prefix as the
epoch's grade file), so the ladder stays comparable through depth 6. The
variants without RR labels (c, g) read 17,244 / 6,007 at rungs 7 / 8 and
the same 984 / 46 / 15 / 9 / 0 above: the difference at 7 and 8 comes from
the edge-optimal assignment (the swap phase) finding a deeper witness chain
in a few hundred runs when the RR labels are present; the witness-greedy
pass is identical.

The nine general runs at depth 12 are the closest lookalikes: a PrepareOK
2->0 after a late write to node 0 and after both RecoveryResponses, then a
StartView 1->0. None reaches depth 13 because the general config issues
only 4-8 reads per run and none follows that StartView; and the census
shows the ghost DVC's sender recovering into the new view or never in every
one of them (the P4_2 timing is not met; the chain approximates P4_2 by
Enter order, which is where the ghost extension tightens it: 9 -> 0 at rung
12, 15 -> 1 at rung 11, 46 -> 10 at rung 10, 984 -> 595 at rung 9).

Best achievable with existing kinds (v2): 11/11 violating at depth 13, 0
non-violating corpus runs at depth >= 11, 15 / 9 / 0 general runs at
depths 11 / 12 / 13. With the ghost extension (estimated from the Python
matcher, exact on every run it was compared on): 11/11 at 13, 0
non-violating corpus runs at >= 11, 1 / 0 / 0 general runs at 11 / 12 / 13.

## 3. Recommended ladder and merge-primary rung

The loop wants at least about 1,000 events per 300 s chunk on the merge
primary. Under v2:

- depth 6 (recover_2): 17,788 per chunk, unchanged; keep as the
  cross-epoch comparison rung.
- depth 7 (rec_2_to_1 after both recoveries): 17,462 per chunk. It is
  nearly free given depth 6 (98%), so it carries little information.
- depth 8 (Recovery 2->1 delivered before the ghost SVC 2->1, the P4_2
  proxy): 6,654 per chunk (about 5,800 with the ghost extension).
  Recommended merge primary: it is the first rung that encodes a condition
  the general explorer fails on the violating path (recovery-answer
  ordering) and it keeps the power the loop needs.
- depth 9 (ghost SVC before ghost DVC at node 1): 984 per chunk (about
  600 with the extension). Just under the threshold: use as a secondary
  rung, not the primary.
- depths 10-13: 46 / 15 / 9 / 0 per chunk. These are the rungs that now
  reward the violating structure (the corpus reaches 11-13 only on the
  violating runs); they are event-starved in general runs and belong to
  the violation-prior side of the grader, not to merge decisions.

## 4. Minimal matcher extension: `dispatched_before`

Condition not expressible today: that a delivery is a ghost, i.e. its
dispatch step lies before a crash of the sender that precedes the delivery.
The corpus cannot rank it (every SVC/DVC 2->1 after crash_2 is a ghost by
construction) but the general store can: 880 of the 6,654 depth-8 runs have
a fresh re-timeout SVC 1->2 at depth 4, and 389 of the 984 depth-9 runs
match a fresh SVC or DVC 2->1.

Spec. A deliver label may carry `"dispatched_before": "<label>"`. A
candidate Enter row e of that label is admissible only if its message's
dispatch step d satisfies `-1 < d < step(<label>)`, where step(<label>) is
the step of the event assigned to the referenced label, and the referenced
label must be assigned (in the witness pass: treated like an unassigned
predecessor, the label stays unassigned; in rootAnchoredPrefix: the vertex
does not extend the chain). Strict inequality: a crash is its own scheduler
step, so the dispatch and the crash never share one. The referenced label
is normally a crash of the sender and normally already a transitive
predecessor (crash_2 -> recover_2 -> ... -> svc_2_to_1), which is what makes
"dispatched before crash_2, delivered after recover_2" mean ghost.

In the candidate files: deliver_svc_1_to_2 dispatched_before crash_nl;
deliver_svc_2_to_1 and deliver_dvc_2_to_1 dispatched_before crash_2.

Touch points (traceanalyzer/metrics/dagorder, traceanalyzer/reader):

- `planconfig.go`: `EventSpec` gains `DispatchedBefore string` (Deliver
  only). `decodeEventSpec`'s deliver struct gains
  `DispatchedBefore string `json:"dispatched_before"``. `LoadPlanConfig`
  validates that a non-empty value names an existing event, the way it
  validates dependency endpoints.
- `candidates.go`: `Event` gains `DispatchStep int32` (-1 when no Dispatch
  row joins). `runIndex` gains `dispatchStep map[int64]int32`;
  `buildRunIndexFromEnters` fills it from `EnterRow.DispatchStep` (already
  read by the store query, currently dropped when the row is copied into a
  `TraceRow`); `buildRunIndex` fills it from the Dispatch rows' Step.
  `collectDelivers` sets `DispatchStep` on each Event.
- `matching.go`: `assignment` gains `dispBefore map[int]int` (label index
  -> referenced label index). `newAssignment` takes the map (or the spec
  map) and fills it. `witnessGreedy` and `assignEarliestAfterPredecessors`
  skip candidates failing the rule and leave the label unassigned when the
  referenced label is unassigned. `rootAnchoredPrefix`'s `ok` check adds:
  referenced label assigned and `eventOf(li).DispatchStep >= 0 &&
  eventOf(li).DispatchStep < eventOf(ref).Step`, so a swap-phase assignment
  cannot smuggle a fresh delivery into the prefix. The swap phase itself
  needs no change (edge satisfaction stays as defined); if the rule should
  also count as an edge for the score, add the pair to `edges` with a
  custom comparison, but the depth rung does not need that.
- `dagorder.go`: `matchOne` passes the constraint map into
  `bestMatchingFull` (one extra parameter).
- `reader.go`: no change; `ReadEntersForMatching` already computes
  `dispatch_step` in the `d` CTE.
- Tests: one case in `witness_test.go` with two Enter candidates of the same
  function/from/to, one dispatched before the crash label's step and one
  after, asserting the prefix takes the former and stalls when only the
  latter exists.

Alternatives considered and not proposed: a `log` label kind matching a
logs-table line at a node (for example node 2 "recovery complete. view=0")
would encode P3_old_view_recovery exactly, but needs a new reader query
over the logs table, ties the oracle to spec log text, and the chain above
already gets 0 general runs at depth 12 with the dispatch rule; a payload
constraint on the RecoveryResponse view would need payload parsing of
handler arguments (the Enter payload is a list of stringified values) for
a gain the depth-11/12 counts do not call for.

## 5. Risks

- Over-fitting to the plan's deliveries. The corpus plan forces w2 after
  the ghost DVC and forces both SVCs to node 0, so the corpus cannot tell
  dvc_2_to_1->w2 from svc_2_to_1->w2 on violating runs; it does show (b)
  that the weaker edge admits 13 non-violating runs at the top. Mechanically
  the write only needs to reach node 1 after node 1 left normal status in
  view 0; a violating general run that invokes w2 between the ghost SVC and
  the ghost DVC would stop at depth 9. The census found 10 of 11 violating
  runs invoke w2 after the fan-out, and 11 of 11 after the ghost DVC.
- The Recovery-before-SVC edge (rung 8) approximates "answered while node
  1 was normal in view 0" by Enter order. A Recovery that lands while node
  1 is still in RecoverInit is dropped and the run still reaches depth 8;
  the RR label (a response exists) and the pok rung catch that only
  further down. The ghost extension does not fix this either; a payload or
  log constraint would. It did not matter on either store (0 non-violating
  at >= 11).
- The committing PrepareOK is fixed to 2->0. In the violating structure the
  old-view quorum is {0, 2} necessarily (node 1 is in view change), so this
  is the only PrepareOK that can commit w2; but if w2 is acked from node
  2's Prepare handler rather than from its RecoveryResponse handler the
  label still matches (same function/from/to).
- Candidate cap: long general runs hit the 256-candidate cap on allow_t1,
  deliver_svc_1_to_2 and deliver_svc_2_to_1 (warnings in the grade err);
  the cap keeps the first 256 in seq order per (function, node, sender), so
  late-run chains in very long runs can be cut. Same as the old oracle.
- VR-specificity: the label set names Recovery, RecoveryResponse,
  PrepareOK and StartView in addition to the old oracle's StartViewChange.
  The DAG was already VR-specific by function name; this is more of the
  same kind. The `dispatched_before` rule itself is protocol-agnostic.
- Matcher nondeterminism across variants: rung 7/8 counts differ by 1-10%
  between DAGs that share the witness path (a vs c), from the swap phase.
  Comparisons between epochs should use one fixed DAG file.
- The ghost files are silently downgraded by today's loader: grading them
  before the extension lands reproduces v2 with no warning. Land the
  extension (or a loud unknown-field error) before switching to them.
