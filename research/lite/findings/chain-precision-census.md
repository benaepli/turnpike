# Chain precision census: ghosts, quorums and the old-view commit window

Tool: `research/lite/tools/ghost_census.py` (python3 stdlib; shells
`traceanalyzer/main -dump-run` per run, one streaming pass, 12 workers).
Whole pass over 5,265 runs: 26 s wall. Per-run rows:
`scratchpad/census/census.csv`; summary: `chain-precision-census.json`
next to this file.

Corpora: `tmp/loop/precision/plan` (3,000 plan runs, 11 violating) and
`tmp/loop/precision/general` (633,408 campaign runs, 0 violating). Depths
from the grade files (`plan.grade2.json`, `general.grade.json`).

Populations:

| pop | source | selection | n |
|---|---|---|---|
| A | corpus | violating | 11 (9 at depth 9, 2 at depth 8) |
| B | corpus | depth 9, not violating | 81 |
| C | corpus | depth 8, not violating | 53 |
| plan7 | corpus | depth 7 | 606 |
| plan4 | corpus | depth 4 | 2,249 |
| D | general | depth 9 | 74 |
| E | general | depth 8 | 801 |
| F | general | depth 7 | 1,090 |
| G | general | depth 6, random sample seed 1 | 300 |

## Definitions used

A message is one TraceID (Dispatch at the sender, Enter at the receiver).
GHOST: the sender has a crash step strictly between dispatch and delivery.
RESTARTED: likewise a recover step. ACTED: a Dispatch row at the receiver
with the Enter's step. FANOUT: some function has >= n-1 such dispatches.
Dispatches at a (node, step) with no Enter row (resumed PrepareOK Commit
sends, timer broadcasts, client-path Prepares) are attributed to the
innermost open Enter/Exit span on that node (the judge's fallback);
`--same-step-only` disables it. (NodeID, Step) was unique among Enter rows
in all 5,265 runs. Node state (status, view) is rebuilt from the spec's log
lines (`entering view change`, `entering normal mode`, `starting recovery`,
`recovery complete. view=V`).

- R1: a StartViewChange 1->2 delivery is a GHOST. R1_fresh_only: no ghost,
  and some SVC 1->2 was dispatched after node 1's first recover step.
- R2: that ghost was ACTED on. Not-acted class from node 2's state just
  before delivery: `stale_view` (ghost view below node 2's view),
  `same_view_receiver_normal` (round already completed),
  `same_view_in_view_change` (already tallied), `receiver_recovering`.
- R3: a handler dispatch of the acted ghost is itself a ghost (or was never
  delivered and node 2 crashed after sending it).
- R4: such a reaction lands at node 1 GHOST, RESTARTED and ACTED. R4_loose
  also accepts a DoViewChange that node 1's state says was tallied (first
  DVC at the primary is counted without a dispatch); it never differed
  from R4.
- R5 = R4 and P2b; R6 = R5 and P3_ghost; R7 = violation.
- P1a: two acted ghosts from restarted senders, two senders. P1b: the VR
  pair (ghost SVC 1->2 acted; ghost SVC 2->1 acted after node 2's restart).
  P1c: P1b and the DVC 2->1 dispatched with that SVC lands after it, both
  at a node 1 that is not recovering.
- P4_nl: node 1's post-restart Recovery request was delivered to and
  answered by node 2 before node 1's ghost SVC landed there. P4_2: the
  ghost DVC sender's post-restart Recovery request was delivered to and
  answered by the fan-out node before that node entered the new view.
- P2b: a DoViewChange whose handler dispatched >= n-1 StartView (the
  fan-out m*, view v, node p, step f); window = DVC Enters at p with view
  v from p's latest `entering view change to view v` log step to f; P2b if
  the window holds a GHOST from another node. P2c: P2b, that sender
  RESTARTED, and p's own recovery completions all precede the window.
  P2a: generic window - any FANOUT m*, same function and first argument
  at the receiver since its latest n-1 broadcast with that argument, not
  reaching back across the receiver's latest restart, majority of distinct
  senders required.
- P3 (redefined): for a StartView fan-out (p, f, v), a completed client
  write to d != p whose PrepareOK at d (joined by CausalOperationID or by
  the write's Prepare (view, op) pair) has view < v, step > f, dispatched
  Commit, and d's StartView from m* lands later (or never). P3_lost: P3
  and the write's uid is absent from the fan-out's StartView log.
  P3_ghost: P3 on the P2b fan-out. P3_old_view_recovery: the ghost DVC's
  sender logged `recovery complete. view=V` with V < v before that
  PrepareOK. P3a/P3b: the proposals' original forms (response inside the
  broadcast window; Prepare views below v), P3b_d0 with d fixed to node 0.

## Reproduction of the judge's pre-check

| reading | judge | this tool | status |
|---|---|---|---|
| R1 D, E | 54/74, 672/801 | 54/74, 672/801 | exact |
| R2 D, E | 7, 156 | 7, 156 | exact |
| R3 D, E | 1, 57 | 1, 57 | exact |
| R4 D, E | 0, 0 | 0, 0 | exact |
| R1_fresh_only D, E | 20/74, 129/801 | 20/74, 129/801 | exact |
| R2 not-acted classes, D | 29 / 12 / 3 / 3 | stale 29, same-view-normal 12, recovering 3, same-view-in-vc 3 | exact |
| P2b A, B, C, D, E | 11, 0, 0, 17, 150 | 11, 0, 0, 17, 150 | exact |
| P2c A, B, C, D, E | 11, 0, 0, 14, 134 | 11, 0, 0, 14, 134 | exact |
| P1a A, B, C, D, E | 11, 51, 26, 8, 103 | 11, 51, 26, 8, 103 | exact |
| P1b A, B, C, D, E | 11, 22, 6, 0, 5 | 11, 22, 6, 0, 5 | exact |
| P1c A, B, C, D, E | 11, 0, 0, 0, 1 | 11, 0, 0, 0, 1 | exact |
| P3b A, B, C, D, E | 11, 0, 1, 1, 24 | P3b_d0: 11, 0, 1, 1, 24; P3b any d: 11, 0, 1, 3, 28 | exact once d = node 0 |
| P2b && P3b D, E | 0, 3 | P2b_and_P3b_d0: 0, 3 (424675, 424463, 220485); any d: 0, 4 (+475308) | exact once d = node 0 |
| P3a A, B, C, D, E | 11, 81, 53, 61, 512 | fallback: 11, 81, 53, 63, 533; same-step only: 11, 81, 53, 55, 437 | bracketed, not exact |

Discrepancies and explanation. (1) P3b: the proposal fixed d to node 0;
the generic form (any d != p) adds two depth-9 and four depth-8 hits, all
non-violating, and one extra P2b-and-P3b run (475308, d = 2). (2) P3a: the
judge's own count used the SeqNum-window rule (E.SeqNum < SeqNum <
X.SeqNum), a third attribution which absorbs dispatches inside an open
PrepareOK on the primary; the two rules implemented here bracket it (55-63
of 74, 437-533 of 801). P3a is the predicate the judge dropped as vacuous
(81/81 on B), so the bracket is reported and not chased. (3) The judge's
note that "CausalOperationID on PrepareOK equals the write's uid" is only
true for PrepareOKs sent from the Prepare handler; the committing PrepareOK
in every A run is sent from RecoveryResponse (run 572 trace 32,
CausalOperationID null), so the join falls back to the write's Prepare
(view, op) pair. Every other pre-check number reproduces exactly, so the
extensions below rest on the same rows and rules.

## Per-run predicates

| predicate | A | B | C | D | E | F | G | plan7 | plan4 |
|---|---|---|---|---|---|---|---|---|---|
| R1 | 11/11 | 81/81 | 53/53 | 54/74 (73.0%) | 672/801 (83.9%) | 1055/1090 (96.8%) | 281/300 (93.7%) | 606/606 | 0/2249 |
| R1_fresh_only | 0 | 0 | 0 | 20/74 (27.0%) | 129/801 (16.1%) | 35/1090 (3.2%) | 19/300 (6.3%) | 0 | 0 |
| R2 | 11/11 | 81/81 | 53/53 | 7/74 (9.5%) | 156/801 (19.5%) | 260/1090 (23.9%) | 71/300 (23.7%) | 606/606 | 0 |
| R3 | 11/11 | 81/81 | 53/53 | 1/74 (1.4%) | 57/801 (7.1%) | 22/1090 (2.0%) | 12/300 (4.0%) | 606/606 | 0 |
| R4 | 11/11 | 22/81 (27.2%) | 6/53 (11.3%) | 0/74 | 0/801 | 0/1090 | 0/300 | 136/606 (22.4%) | 0 |
| P1a | 11/11 | 51/81 (63.0%) | 26/53 (49.1%) | 8/74 (10.8%) | 103/801 (12.9%) | 98/1090 (9.0%) | 37/300 (12.3%) | 136/606 (22.4%) | 0 |
| P1b | 11/11 | 22/81 (27.2%) | 6/53 (11.3%) | 0/74 | 5/801 (0.6%) | 2/1090 (0.2%) | 0/300 | 136/606 (22.4%) | 0 |
| P1c | 11/11 | 0/81 | 0/53 | 0/74 | 1/801 (0.1%) | 0/1090 | 0/300 | 52/606 (8.6%) | 0 |
| P4_nl | 11/11 | 81/81 | 53/53 | 34/74 (45.9%) | 251/801 (31.3%) | 212/1090 (19.4%) | 53/300 (17.7%) | 174/606 (28.7%) | 0 |
| P4_2 | 11/11 | 0/81 | 0/53 | 0/74 | 0/801 | 1/1090 (0.1%) | 0/300 | 5/606 (0.8%) | 0 |
| P2a | 11/11 | 54/81 (66.7%) | 46/53 (86.8%) | 18/74 (24.3%) | 163/801 (20.3%) | 183/1090 (16.8%) | 65/300 (21.7%) | 48/606 (7.9%) | 0 |
| P2b | 11/11 | 0/81 | 0/53 | 17/74 (23.0%) | 150/801 (18.7%) | 181/1090 (16.6%) | 64/300 (21.3%) | 48/606 (7.9%) | 0 |
| P2c | 11/11 | 0/81 | 0/53 | 14/74 (18.9%) | 134/801 (16.7%) | 162/1090 (14.9%) | 56/300 (18.7%) | 48/606 (7.9%) | 0 |
| P3 | 11/11 | 0/81 | 1/53 (1.9%) | 0/74 | 1/801 (0.1%) | 0/1090 | 0/300 | 0/606 | 0 |
| P3_lost | 11/11 | 0/81 | 0/53 | 0/74 | 0/801 | 0/1090 | 0/300 | 0/606 | 0 |
| P3_ghost | 11/11 | 0/81 | 0/53 | 0/74 | 0/801 | 0/1090 | 0/300 | 0/606 | 0 |
| P3_old_view_recovery | 11/11 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| P3_issued_after | 10/11 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| P3b (any d) | 11/11 | 0/81 | 1/53 | 3/74 (4.1%) | 28/801 (3.5%) | 22/1090 (2.0%) | 10/300 (3.3%) | 0 | 0 |
| P2b_and_P3b (any d, run level) | 11/11 | 0 | 0 | 0/74 | 4/801 (0.5%) | 5/1090 (0.5%) | 0/300 | 0 | 0 |
| P2b_and_P3b_same (same fan-out) | 11/11 | 0 | 0 | 0/74 | 0/801 | 0/1090 | 0/300 | 0 | 0 |

The two P3 hits outside A (corpus 1112, general 328184) are commits whose
op was already in the fan-out's log (`in_new_log=1`), so nothing was lost;
P3_lost removes both. Run 828 is the one A run whose w2 was invoked before
the fan-out (step 32 vs 33) and still lost.

## Funnel per population

Survivors (cumulative) with the conditional rate from the previous rung.

| rung | A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|---|
| R1 ghost SVC 1->2 | 11 | 81 | 53 | 54 (73%) | 672 (84%) | 1055 (97%) | 281 (94%) |
| R2 acted | 11 | 81 | 53 | 7 (13%) | 156 (23%) | 260 (25%) | 71 (25%) |
| R3 reaction became ghosts | 11 | 81 | 53 | 1 (14%) | 57 (37%) | 22 (8%) | 12 (17%) |
| R4 reaction acted on by restarted node 1 | 11 | 22 (27%) | 6 (11%) | 0 | 0 | 0 | 0 |
| R5 and ghost-built fan-out (P2b) | 11 | 0 | 0 | 0 | 0 | 0 | 0 |
| R6 and old-view commit inside window (P3_ghost) | 11 | 0 | 0 | 0 | 0 | 0 | 0 |
| R7 violation | 11 | 0 | 0 | 0 | 0 | 0 | 0 |

Absolute survivors lost per rung, general: D: R1->R2 47, R2->R3 6, R3->R4
1. E: R1->R2 516, R2->R3 99, R3->R4 57. The largest drop by ratio and by
absolute count is R1->R2 (7.7x in D, 4.3x in E); the drop to zero is
R3->R4 (1 and 57 survivors lost, 0/2,265 general runs pass R4). The
predicted largest drop at R3 is not what the data show: R2->R3 is 14% and
37% conditional, and R3 is 1.4%/7.1% unconditional, inside the frozen
"<= 15%" but not the largest drop.

Stratification: R1 is 73% (D), 84% (E), 97% (F), 94% (G) - the depth-9
stratum is 11 points below depth 8 and 24 below depth 7, so the deeper the
matched chain the more often its SVC 1->2 is a fresh re-timeout
(R1_fresh_only 27% / 16% / 3%). R3 is 1.4 / 7.1 / 2.0 / 4.0%, inside the
10-point clause. The corpus passes R1-R3 in 100% of A, B, C and plan7 by
construction (crash right after the timer's sends, crash_2 right after
deliver_svc_1_to_2), so the corpus cannot rank R1-R3.

R2 failures (class of the first ghost SVC 1->2 not acted on):

| class | D | E | F | G |
|---|---|---|---|---|
| stale_view (ghost's view below node 2's) | 29 | 337 | 469 | 119 |
| same_view_receiver_normal (round already completed) | 12 | 77 | 106 | 36 |
| same_view_in_view_change (already tallied) | 3 | 67 | 120 | 30 |
| receiver_recovering | 3 | 35 | 100 | 25 |

R4 failures (class of the first R3 reaction delivered to node 1; runs
with R3 and not R4):

| class | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| receiver_recovering (node 1 still in RecoverInit) | 59 | 47 | 0 | 29 | 14 | 5 |
| none delivered to node 1 (reaction went to node 0 only, or run ended) | 0 | 0 | 1 | 24 | 6 | 7 |
| sender_not_restarted (landed before node 2's recover) | 0 | 0 | 0 | 2 | 2 | 0 |
| stale_view / same_view_receiver_normal | 0 | 0 | 0 | 2 | 0 | 0 |

In B the 22 runs that pass R4 all fail P1c for one reason: the ghost DVC
landed before the ghost SVC and was dropped (node 1 not yet in view
change), as the judge found on run 51. The other 59 B runs drop both
reactions while node 1 is still recovering, as on run 3.

## P1c, P2, P3: precision and recall within the corpus

Over all 3,000 corpus runs (11 positives) and over the 145 runs at depth
>= 8:

| predicate | tp | fp (3,000) | precision | fp (depth>=8) | precision | recall |
|---|---|---|---|---|---|---|
| P1c | 11 | 52 | 0.175 | 0 | 1.000 | 1.000 |
| P4_2 | 11 | 5 | 0.688 | 0 | 1.000 | 1.000 |
| P2b | 11 | 48 | 0.186 | 0 | 1.000 | 1.000 |
| P2c | 11 | 48 | 0.186 | 0 | 1.000 | 1.000 |
| P3 | 11 | 1 | 0.917 | 1 | 0.917 | 1.000 |
| P3_lost | 11 | 0 | 1.000 | 0 | 1.000 | 1.000 |
| P3_ghost (P2b and P3, same fan-out) | 11 | 0 | 1.000 | 0 | 1.000 | 1.000 |
| P3b (any d) | 11 | 1 | 0.917 | 1 | 0.917 | 1.000 |
| P2b_and_P3b | 11 | 0 | 1.000 | 0 | 1.000 | 1.000 |
| P2a (generic) | 11 | 148 | 0.069 | 100 | 0.099 | 1.000 |
| P4_nl | 11 | 308 | 0.034 | 134 | 0.076 | 1.000 |
| R4 | 11 | 164 | 0.063 | 28 | 0.282 | 1.000 |

P2b's 48 corpus false positives and P1c's 52 are all depth-7 runs
(plan7), where the run stalled; see the stall note below. On the corpus,
P1c, P2b and P4_2 select the same 11 + 48 runs: in a three-node plan run
the only way a ghost DVC is tallied is the SVC-before-DVC ordering at a
node 1 that has finished recovering, so they are one condition measured
three ways, as the judge said. P2a agrees with P2b on 98.4-99.8% of
general runs but on 33% of B and 13% of C: the generic window counts a
StartViewChange handler's own n-1 broadcast as an epoch-forming fan-out
and tallies ghost SVCs the receiver merely counted (run 3: SVC 0->1 at
step 44 with the ghost SVC 2->1 dropped at 29 in its window), so it is
unusable as a label without the receiver's state reset, which only the
spec's `entering view change` line gives.

## General-run readings

Ghost-built view-change quorums are common: P2b 23% (D), 18.7% (E), 16.6%
(F), 21.3% (G), 412 of 2,265 runs, with zero violations. P2c (sender
restarted, receiver past its own recovery) is 19% / 17% / 15% / 19%. The
rate does not depend on depth, so it is a property of the general
explorer, not of the matched chain.

What the ghost DVC's sender did after its crash (first P2b fan-out per run):

| sender's recovery | A | D | E | F | G | plan7 |
|---|---|---|---|---|---|---|
| completed into the old view before its ghost was consumed | 4 | 0 | 0 | 0 | 0 | 3 |
| completed into the old view anywhere later | 11 | 0 | 0 | 0 | 0 | 5 |
| completed into the new view (or later) | 0 | 9 | 37 | 15 | 4 | 22 |
| never completed recovery in the run | 0 | 8 | 113 | 166 | 60 | 21 |

In every A run the sender recovers into the old view (7 of 11 only after
its ghost was consumed, which is fine: the old-view quorum must exist by
the commit, not by the fan-out). In 0 of 412 general ghost-built fan-outs
does the sender recover into the old view. The proximate cause is P4_2:
in A, node 2's post-restart Recovery request reached node 1 and was
answered while node 1 was still in view 0 (run 572: Recovery 2->1 at step
29, node 1 enters view change at 30); in general 0/74 and 0/801 (1/1090 at
depth 7). The Recovery handler answers only in normal status, so a request
that lands during the view change is dropped and never retried: the
sender then either finishes recovery in the new view (from the new
primary) or never finishes (113 of 150 in E).

The redefined P3 (old-view commit after the fan-out, before StartView
reaches the committing node) reads 0/74, 1/801, 0/1090, 0/300, and
P3_lost (the write absent from the new log) 0 everywhere in general. The
proposals' P3b (Prepare views below v) reads 3-4% in general, and its
run-level conjunction with P2b 0/74, 4/801 (3 with d = node 0), 5/1090;
on the same fan-out 0 everywhere. All general P2b-and-P3b hits have the
ghost's sender recovering into the new view (424463 at step 96, 475308 at
337) or never (220485, 424675, 49506, 86107, 86256, 138059, 269657), so
bug.md step 4 is the unmet condition, as the judge predicted.

P1a (two acted ghosts from restarted senders) is 9-13% in general and
63% in B; in both it is dominated by Recovery requests from a
twice-crashed node (the nonce-reuse path), so it is not a usable proxy.
P4_nl (node 1's recovery request overtakes its ghost at node 2) is 100%
in the corpus by construction and 18-46% in general; among the 672 R1
runs of E it does not predict R2 (42/251 with P4_nl vs 114/421 without).

## View churn and run length

| distribution | A | B | D | E |
|---|---|---|---|---|
| distinct views entered, q1 / median / q3 | 2 / 2 / 2 | 2 / 2 / 2 | 16 / 22 / 29.75 (max 65) | 10 / 16 / 22 (max 243) |
| `entering view change` log rows | 3.5 / 5 / 5 | 4 / 4 / 5 | 41 / 55.5 / 78.5 | 24 / 38 / 56 |
| steps used | 91.5 / 93 / 100.5 | 96 / 98 / 101 | 564 / 842 / 2627 | 896 / 1500 / 2915 |
| ghost deliveries per run | 4 / 5 / 5 | 5 / 5 / 6 | 4 / 7 / 10 | 5 / 8 / 12 |
| StartView fan-outs per run | 1 / 1 / 1 | 1 / 1 / 1 | 11 / 16 / 22 | 5 / 9 / 15 |

F and G: 13 views, 30 / 28 view-change entries, 2,627 steps median. End
reasons: A and B all `plan_complete`; D 45 plan_complete / 21
learned_cap_reached / 8 iterations_exhausted; E 234 / 382 / 185.

A general depth-9 run enters a median 22 views and 16 fan-outs; it makes
as many ghosts per run as a corpus run (7 vs 5) but spends them on rounds
the receiver has already left (stale_view is 54-62% of R2 failures).

Corpus stall note. All 606 depth-7 corpus runs and 42 of the 53 depth-8
non-violating runs end by `iterations_exhausted` at step 35-53 with w2
invoked and never answered (run 168: node 2 received w2's Prepare while
recovering, then completed recovery into view 1 from node 1's answer;
node 1 dropped the view-0 Prepare; no PrepareOK quorum). B (81) and A (11)
are the only corpus populations that ran to completion, so B is the only
corpus control; C is mostly a stall population, and plan7's 48 P2b / 52
P1c / 5 P4_2 hits never reached a commit.

## Decision tables and the row each reading lands in

Funnel (general-chain-funnel-census), with the judge's repairs.

| row | reading | fires |
|---|---|---|
| largest conditional drop at R3 (predicted) | R2->R3 conditional 14% (D) / 37% (E); not the largest | no |
| largest drop at R1 | R1 73% / 84% | no |
| largest drop at R2 (judge's added row: the ghost's round is stale at the receiver) | R1->R2 loses 47/54 and 516/672; stale_view 29/47 and 337/516 | yes - direct a round at round-advance admission (a node whose inbound queue holds a dead incarnation's message does not fire its timer until it lands); ask the user whether the depth-4 label should require dispatch-before-crash and delivery into the same round |
| largest drop at R4 (drop to zero, absolute survivors lost) | R3->R4 loses 1 (D) and 57 (E); R4 0/2,265; failures: node 1 recovering 29, none delivered 24 | yes (second reading) - ghost delivery ordering: a dead incarnation's messages reach a receiver only after that receiver's restart round-trip completes, in send order |
| R1-R6 survive within 2x of the corpus but R7 = 0 | R4 = 0 | no |
| falsifier: R3 >= 50% or R1 < 20% | R3 1.4-7.1%, R1 73-97% | not falsified |

Ghost quorum (ghost-quorum-epoch-formation-census).

| row | reading | fires |
|---|---|---|
| P2b recall >= 10/11 and B rate <= 30% | 11/11, 0/81 | the trigger fires, but see the next row |
| judge's added row: P2b perfect on the corpus but >= 15% in general depth-8/9 with zero violations | D 23%, E 18.7%, 0 violations | yes - a fan-out-on-ghost label alone has precision near zero on general runs; propose it only conjoined with the downstream condition |
| P2b separates but P2a does not agree >= 85% | agreement 33% (B), 13% (C), 98-100% (general) | yes on the corpus - the generic window needs the receiver's state reset; user decision whether an oracle label may read the `entering view change` log line |
| B rate >= 60% | 0/81 | no |
| falsifier: recall < 7/11 or B >= 60% or agreement < 60% | agreement 33% on B | falsified on the agreement clause only; the exact window is what carries the reading |

Old-epoch commit window (old-epoch-commit-window-census), with the
judge's replacement row.

| row | reading | fires |
|---|---|---|
| P2b and P3 each occur in general but the conjunction is rare or absent and the hits fail old-view recovery (judge's row) | P2b 17/74, 150/801; P3 0/74, 1/801 (P3_lost 0); conjunction 0/875; P3b-based conjunction 4/801 all failing old-view recovery | yes - the deficit is joint timing on one node: the ghost DVC's sender must complete recovery into the old round before the old-round commit and before the new round's broadcast reaches it (P4_2: 11/11 vs 0/875) |
| P2b && P3 precision >= 0.8 and recall >= 0.8 on the corpus | P3_ghost 1.000 / 1.000 over 3,000 runs | fires on the corpus, but the conjunction is 0 in general, so the two-label extension is proposed only as a conjunction with the recovery condition |
| P3 separates alone but P2b does not | both separate | no |
| recall < 8/11 | 11/11 | no |

Ghost pair (ghost-pair-acted-census).

| row | reading | fires |
|---|---|---|
| P1a recall >= 10/11 and B rate <= 40% | B 63% | no |
| P1b && P1c separates but P1a does not | P1c 11/11 vs 0/81, 0/53; P1a 63% of B | yes - P1c is the corpus's ordering-plus-readiness condition; fold it into the funnel between R4 and P2b (it is P4_nl plus reaction-after-recovery), do not rank scheduler candidates by acted-ghost counts (dominated by Recovery replies) |
| B rate >= 60% with high recall | P1a 63% | yes for P1a - necessary, not sufficient |
| D rate <= 20% while A/B separate | P1a 10.8% in D | fires for the wrong reason (Recovery replies), as the judge said |

## Conclusion: what the general explorer lacks

The general explorer produces the raw material: per run it makes as many
ghost deliveries as a corpus run, builds a ghost-built view-change quorum
in one run of five, and matches the oracle's depth-9 shape 74 times in a
five-minute session. It never turns that into the bug because three
timing conditions, all about a restarted node's recovery relative to its
dead incarnation's messages, are never met together:

1. Ghosts land on rounds the receiver has already left. Free-running
   timers advance a general run through a median 16-22 views, so the ghost
   SVC 1->2 is stale at node 2 in 54-62% of the R2 failures and
   already-tallied or already-completed in most of the rest. The corpus
   holds node 2 in view 0 until the ghost arrives. Generic: a node whose
   inbound queue still holds a message from a peer's dead incarnation
   should not advance its round on a timer until that message lands.

2. When node 2 does act and then crashes with its reactions in flight
   (92 general runs), the reactions land at node 1 while node 1 is still
   recovering, or never land there; in 0 of 2,265 general runs does a
   reaction reach a node 1 that has completed its recovery (R4 = 0). In
   the corpus this is exactly what separates A from B: in A, node 1's own
   post-restart recovery request overtook its dead incarnation's SVC at
   node 2 and its recovery completed before node 2's ghosts arrived; in
   the 59 B runs that fail this the ghosts were dropped during recovery,
   and in the other 22 the DVC arrived ahead of the SVC. Generic: a
   restarted node's recovery round-trip completes before any of its dead
   incarnation's messages is consumed by a peer, and the peer's replies
   are delivered in send order.

3. The ghost-built quorum's second member never rejoins the old round. In
   all 11 A runs the ghost DVC's sender (node 2) recovers into view 0
   because its recovery request reached node 1 before node 1 entered view
   change (P4_2), so an old-view quorum {node 0, node 2} exists to commit
   w2 after the fan-out. In 0 of 412 general ghost-built fan-outs does
   this happen: the request lands on a node already in view change, is
   dropped, and the sender recovers into the new view (65) or never (347).
   Without it the old-view commit inside the broadcast window (P3_lost)
   cannot occur, and it does not: 0 of 2,265 general runs.

So the deficit is not fault placement and not the ghost quorum; it is
recovery-answer ordering. The mechanism family to steer at is: deliver a
restarted node's recovery requests and responses ahead of that node's
older in-flight messages at every peer (so recovery completes in the round
the peers are still in), and hold a node's timer while a dead
incarnation's message addressed to it is undelivered. For the oracle, the
depth-4 label should require the SVC 1->2 to be a ghost (16-27% of the
general depth-8/9 matches are fresh re-timeouts), and any new deep label
should be the conjunction "ghost-built fan-out AND the ghost's sender
recovered into the old round AND an old-round commit inside the broadcast
window", never the fan-out alone (precision near zero in general).

## Files

- Tool: `research/lite/tools/ghost_census.py` (`select`, `census`,
  `tables` subcommands; see its docstring).
- Summary JSON: `research/lite/findings/chain-precision-census.json`.
- Per-run CSV and population id files:
  `scratchpad/census/census.csv`, `scratchpad/census/{A,B,C,D,E,F,G,plan7,plan4}.txt`
  (scratchpad = `/tmp/claude-1000/-home-benaepli-Rust-turnpike/a9b7ef1d-0d30-4e4a-ac8f-8cc6f6a9dee4/scratchpad`).
- Same-step-only comparison pass: `scratchpad/census/census_samestep.{csv,json}`.
