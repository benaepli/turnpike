# panel-hard-bugs

Extension of the cross-protocol panel (`grader.ts panel`) with members whose
bugs are rare enough that a scheduler change can move them, so the panel
tests whether the merged fault mechanisms generalize instead of only
guarding two easy bugs. Constraints: `bin/spur/**` is protected; new specs
are additive files under `bin/spur/panel/`, never edits to `bin/spur/VR.spur`
or any existing spec. The measurement harness (grader, manifest) is operator
work.

## 1. Inventory

Tiers: easy = rate > 0.5% per run (any scheduler finds it); medium =
0.01%-0.5%; hard = < 0.01% or never observed under the general config.
Rates for the two live members are the merged-tree panel reads (seed 1000,
scale 3); the four dormant members carry their 2026-08-28 calibration at
rayonThreads 30 (`research/panel/manifest.30.json`,
`research/observations/PANEL_CALIBRATION.md`), which predates every lite
merge. Wall to N events at rate r per run and R runs/s is N / (R r).
N = 25 resolves a 2x move at z ~2.8 (z = ln(N2/N1) / sqrt(1/N1 + 1/N2));
N = 100 resolves ~1.45x; the manifest's minSeparation 20 resolves ~2.3x.

| member / bug | spec | shape | faults | r per run | R runs/s | events/s | wall to 25 | wall to 100 | tier |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| paxos-accept-stale-ballot | panel/paxos_accept_stale_ballot.spur (HandleP2a guard removed) | two commands in one slot | F0, numCrashes 1-2 | 0.0366-0.0372 | ~7,650 | 280-323 | 0.1 s | 0.4 s | easy |
| mencius-opt1-2 | mencius/Mencius_opt1_2.spur | rule-2 gap-fill over a committed slot | F0, numCrashes 0 | 0.0151 | ~1,550 | 21-24 | 1.1 s | 4.5 s | easy |
| raft-stale-vote | panel/raft_stale_vote.spur (RequestVoteReply term guard removed) | old-term vote counted after the candidate advanced | F2, numCrashes 2-4 | 3.0e-4 (54/172,278) | ~950 | 0.30 | 88 s | 350 s | medium |
| paxos-forget-promise | panel/paxos_forget_promise.spur (RecoverInit drops acceptor_ballot) | recovered acceptor accepts a superseded ballot | F2, numCrashes 1-2 | 2.0e-4, control 1.5e-4 | ~3,568 | 0.85 | 35 s | 140 s | medium, unattributable (1.3x control) |
| Paxos.spur background | bin/spur/Paxos.spur, F2 overlay | unknown; only under crash-recover | F2 | 1.0e-4 - 1.5e-4 | ~3,568 | ~0.4-0.5 | ~60 s | ~4 min | medium, unclassified real bug |
| raft-forget-vote | panel/raft_forget_vote.spur (RecoverInit drops voted_for) | recovered node grants a second vote in the same term | F2, numCrashes 2-4 | 1.7e-5 (3/171,604) | ~950 | 0.017 | 25 min | 100 min | hard |
| raft-commit-prev-term | panel/raft_commit_prev_term.spur (advance_commit_index term check removed) | figure 8: previous-term entry committed by count | F3, numCrashes 2-4 | < 5.9e-6 (0/170,277) | ~950 | 0 | > 70 min | - | hard, never observed |
| VR recovery-nonce reuse | bin/spur/VR.spur:71,93,433 (volatile nonce) | stale RecoveryResponse accepted by a later incarnation | crash during recovery | ~1.3e-6 (loop background; ~3e-7 on the latest 10M) | ~2,126 | 0.0028 | ~2.5 h | ~10 h | hard, measured for free by every grade |
| VR target (bug.md) | bin/spur/VR.spur | view-change/recovery race, 13-label chain | 2 crash-recover cycles | 0 in tens of millions (< ~5e-8); 11/3000 under find_bug_plan | ~2,126 | 0 | unmeasurable | - | hard, the goal |

Reading the table: the panel's two live members are both easy and both
moved only through throughput or crash placement; the four dormant members
are the only recovery-shaped known bugs in the repo and nobody has measured
them on a tree carrying the crash-placement, fan-out, retarget, fresh-first
or send-order merges. Raft's host ceiling is 0.0021 (a guaranteed split
brain detects at 0.2% because the client retries until some leader answers),
so no Raft member can ever be easy; Paxos's ceiling is >= 0.0251.

## 2. Candidate hard members

### Existing specs that can join today

1. `raft-stale-vote` (medium, recovery-shaped). Its bug is a stale-incarnation
   reply acted on after the node's epoch advanced, the same shape as VR's
   StartViewChange from NL's previous incarnation. 0.30 events/s means
   wallSec 40 (120 s at scale 3) yields ~36 events at the old rate, enough to
   see a 2x move. First member to promote; it needs no new file.
2. `raft-forget-vote` (hard). Recovered node inconsistent with its previous
   incarnation's promise. 0.017 events/s: 600 s gives E ~10 at the old rate.
   Report count only; belongs in the slow set.
3. `raft-commit-prev-term` (hard, never observed). Commit in an old epoch;
   the deepest analogue of the VR target (a 3-node figure 8 needs four
   leadership changes with two crash-recover cycles interleaved, deeper
   than VR's 13 labels). Report count only; any detection is the signal.
   Needs a targeted plan before it counts (below) so a zero is known to be
   a probability, not a reachability, result.
4. `paxos-forget-promise` cannot join: 4 against 3 on its own control. Its
   control, `Paxos.spur` under crashes at ~1e-4, is itself an unclassified
   recovery-shaped bug. Classify one trace first (one 60 s explore with the
   F2 overlay yields ~25 violating runs); if the mechanism is real it joins
   as `paxos-host-recovery` with its own shape line, and forget-promise's
   attribution problem is resolved by fixing the control rather than by
   dropping the member.

### New injections sharing the VR shape (additive files under bin/spur/panel/)

A. `paxos_recover_stale_scout.spur` (from Paxos.spur). Stale-incarnation
   message acted on after restart. `HandleP1bResponse` (Paxos.spur:322)
   guards `if scout_done or !ballot_eq(original_ballot, scout_ballot)`;
   drop the second clause so P1b promises addressed to the pre-crash
   scout are counted by the post-recovery scout that RecoverInit starts
   (Paxos.spur:128-130 sets leader_ballot = acceptor_ballot.round+1 and
   runs a scout). Violation shape: the recovered leader adopts on promises
   for a ballot no acceptor promised, spawns commanders at its new ballot
   with an incomplete pmax, and a slot already chosen gets a second command
   (two commands per slot, as accept-stale-ballot). Trigger needs a crash
   while P1b replies are in flight, exactly the hazard the loop's
   fault-placement and retarget mechanisms sample. Expected medium (1e-3
   to 1e-2 given Paxos's ceiling); must clear 20x the host background
   (>= 2e-3) to be attributable. Confirm: run-plan with events w1 -> allow
   timer on node 1 -> crash 1 after its P1a fan-out -> recover 1 -> deliver
   Node.HandleP1bResponse from 0 and 2 to 1 -> w2 to 1 -> reads at 0,1,2;
   `Paxos.spur` under the same plan must read 0.
B. `paxos_p2b_stale_ballot.spur` (from Paxos.spur). Commit in an old epoch.
   `HandleP2bResponse` (Paxos.spur:377) guards
   `if !ballot_eq(original_ballot, leader_ballot) or !active`; drop the
   ballot clause so acceptances for a preempted ballot count toward the
   current ballot's commander. Shape: a slot decided on a mixed-ballot
   majority. Reachable fault-free (preemption by a duelling proposer) and
   under crashes; run it under two overlays, numCrashes 0 and 1-2, so the
   pair separates what the crash mechanisms add to a shape they can reach
   either way. Expected medium-easy. Confirm: two proposers on one slot,
   deliver P2b for the first ballot after preemption.
C. `raft_recover_stale_append_reply.spur` (from raft_clean.spur, which is
   Raft.spur plus term guards at both reply handlers; Raft.spur itself
   lacks both). Drop the guard added at raft_clean.spur:391-395
   (AppendEntriesReply) instead of the RequestVoteReply one that
   raft_stale_vote drops: a stale-incarnation follower reply raises
   match_index and lets the leader commit on a follower whose log the next
   leader truncates. Recovery-shaped and commit-in-old-epoch at once;
   Raft's ceiling caps it at 0.2%, expected 1e-4 to 1e-3. Confirm: plan
   with leader 0 appending to 1, crash 1 before the entry is persisted on
   its reply path, recover 1, deliver the stale Node.AppendEntriesReply to
   0, then leader change to 2.
D. `sdpaxos_newview_commit_stale.spur` (from SDPaxos.spur, untried host
   with view changes and persisted recovery). `HandleNewViewCommit`
   (SDPaxos.spur:1257) guards `if msg.view < view { return; }`; drop it so a
   delayed NewViewCommit from a superseded view commits o_instances
   assigned in the old view. Exactly VR's step 7 shape (old-view state
   acted on after a newer view started). Gate: a C0 ceiling probe on
   SDPaxos first (one 20,000-run arm of a blatant injection such as
   `HandleCAccept` accepting every ballot), because its runs/s and
   detection ceiling are unmeasured and the spec is 1,295 lines.

### Controls that deliberately do not share the shape

E. `paxos-accept-stale-ballot-nofault`: the existing member with overlay
   numCrashes 0. No new file. Its per-run rate must not move under
   fault mechanisms; the existing member moved +35% per run at the
   crash-placement merge, so today it is not a clean no-fault control.
F. `mencius-opt1-2-3` (Mencius_opt1_2_3.spur, control
   Mencius_opt1_2_3_fixed.spur; bug_opt1_2_3.md). A pure false-suspicion
   ordering bug, numCrashes 0, rate unmeasured; one 60 s probe tiers it.

Ceiling probe, not a member: `paxos_decide_minority` (HandleP2bResponse
`>= majority()` -> `>= 1`) re-measures Paxos's hostCeiling, which the
calibration record marks as a lower bound because its previous probe
detected below the members.

### Targeted plan for raft-commit-prev-term (reachability proof)

3 servers, `strict_timers`, format of `research/oracle/tiers/find_bug_plan.json`
(labels: write/read [node,key], allow_timer [node,"election"], crash n,
recover n, deliver {function: "Node.X", from, to}). Chain: allow_timer 0 ->
deliver RequestVote 0->1, RequestVoteReply 1->0 (0 leads term 1) -> w1 at 0
(index 1 term 1, no AppendEntries delivered) -> crash 0 -> allow_timer 2 ->
RequestVote 2->1, reply (2 leads term 2) -> w2 at 2 (index 1 term 2, not
replicated) -> crash 2 -> recover 0 -> allow_timer 0 -> RequestVote 0->1
(1's log is empty, grants) -> AppendEntries 0->1 carrying the term-1 entry
-> AppendEntriesReply 1->0 -> the injected commit -> r1 at 0 sees w1 ->
crash 0 -> recover 2 -> allow_timer 2 -> RequestVote 2->1 (last term 2 > 1,
grants) -> AppendEntries 2->1 overwrites index 1 -> r2 at 2 and r3 at 1 see
w2 without w1. About 20 labels. `raft_clean.spur` under the same plan reads
0. Run with `spur run-plan bin/spur/panel/raft_commit_prev_term.spur -p <plan> -o tmp/loop/lite/plan-raft-f8 -y`
then porcupine on the output.

### Reachability proofs recorded

- A (`paxos_recover_stale_scout.spur`): proven 2026-09-03. Plan
  `research/lite/plans/paxos-recover-stale-scout-plan.json`, 16 labels,
  300 runs: injected spec porcupine exit 2 (runs 34 and 154), host
  `Paxos.spur` exit 0 under the identical plan. Violating run 34: node 1
  scouts at (2,1), is preempted, node 2 leads at (4,2) and decides w1 in
  slot 1, node 1 crashes and recovers scouting at (5,1), adopts on the
  (2,1) promises from 0 and 2 (empty pvals), puts w2 in slot 1 and performs
  it; reads give [2] at node 1 and [1] at nodes 0 and 2. Two commands in
  one slot, as predicted. Awaits the three-seed calibration and its control
  read before joining the slow set.

- raft-commit-prev-term: proven 2026-09-03. Plan
  `research/lite/plans/raft-commit-prev-term-figure8-plan.json`, 31 events
  (17 allow_timer used as quiescence barriers under p_timer 0, 3 crashes, 2
  recovers, single-release delivers): injected spec porcupine exit 2, host
  `raft_clean.spur` exit 0. Node 0 leads term 3 and applies the term-1
  entry on one ack (the injected commit); node 2 leads term 4, truncates
  node 1's index 1 to w2 and commits it; node 1's state machine keeps [1]
  and its own term-5 read returns [1] after node 2 read [2]. Two tool facts
  the plan format imposes: a deliver spec (function, from, to) can be
  released once per plan, and with 3 nodes the stale read must come from a
  follower's state machine, not from the old leader. The member joins the
  slow set as a count-only hard member; its zero under the general config
  is now a probability, not a reachability, result.

### Fixed Paxos host (2026-09-03)

Paxos.spur's crash violation is an implementation bug (request identity
minted from a volatile counter, compared without uid, reseeded from
slot_num on recovery; `research/lite/findings/paxos-host-crash-violation.md`).
The panel host is now `bin/spur/panel/paxos_host_fixed.spur`: the counter is
persisted and restored, writes are identified by uid and reads by request
id, a re-delivered write that is already decided returns at once, and
pending requests resolve by uid. 0 violations in 52,017 runs under the F2
overlay (the unfixed host: 3.7e-3 per run). Members re-derived from it:
`paxos_fixed_forget_promise.spur` (proof: `paxos-forget-promise-plan.json`,
300/300 violate, host 0/300) and `paxos_fixed_recover_stale_scout.spur`
(scout plan, 2/300 violate, host 0/300). The original `paxos-forget-promise`,
`paxos-recover-stale-scout` and `paxos-host-recovery-control` rows leave the
manifest (their reads are in observations.md); the unfixed injections stay
on disk as records. Calibration of the three new rows: three seeds each,
member rate must clear 20x the fixed-host control.

Calibration on the fixed host (2026-09-03, three seeds pooled, scale 3,
merged tree spur f769929):

| member | runs | violations | per run | per second | per seed | tier | set |
| --- | --- | --- | --- | --- | --- | --- | --- |
| paxos-fixed-host-control | 288,000 | 0 | < 1.0e-5 | 0 | 0, 0, 0 | control | with either set |
| paxos-fixed-forget-promise | 287,605 | 29 | 1.0e-4 | 0.70 | 6, 14, 9 | hard | slow, wallSec 45 (E about 95) |
| paxos-fixed-recover-stale-scout | 288,000 | 85 | 3.0e-4 | 1.88 | 27, 32, 26 | hard (15 short of medium) | quick, wallSec 15 (E about 85) |

Both members separate from their control without bound (0 control
events), so both are attributable; the scout member joins the quick guard
set because 45 s already yields about 85 events, enough to see a 2x move.

## 3. Calibration protocol

Regime: calibrate with the panel subcommand's own mechanics so the
calibration equals the measurement (general_vr.json template, member
overlay, runsPerConfig 4000, `wall_budget_sec` in the materialized config,
rayonThreads 30). The first version-2 calibration ran a different regime
and was discarded; do not repeat that.

Seeds and counts: three fixed seeds (1000, 1001, 1002), same binary, same
session. Pool violations across seeds. A member is tiered medium only when
the pool holds >= 100 violations (relative SE 10%); its `expectedRate` is
pooled violations / pooled runs, `eventsPerSec` = violations / explore
seconds, `dispersion` = observed variance of per-seed rates over Poisson
variance, floored at 1. A hard member with k < 20 events records the count
and the 95% upper bound (k = 0: expectedRate "< 3/runs", eventsPerSec 0);
it is never reported as a rate.

Control: run `cleanSpec` under the identical overlay and wall; require
member rate >= 20x control rate (the separation rule that admitted the two
gate members at 345x and inf). A member failing it (paxos-forget-promise at
1.3x) is unattributable and stays out until its control is understood.

Caveats the record documents: identical source differs 4-5% per second
across builds (layout), and host state moved paxos from 33.78 to 49.77
events/s between calibration and anchor with per-run flat. So per-run rate
is the guard, per-second is the portfolio read, and every panel entry
compares to the previous panel on the same host, not to the manifest.

Manifest additions (`research/panel/manifest.30.json`, member object; the
grader reads id, spec, role, porcupineModel, overlay, faults.numCrashes,
maxIterations, wallSec, expectedRate, calibration.{eventsPerSec,
runsPerSec}): id, spec, cleanSpec, shape, faults {class, numCrashes,
requiresRecovery}, porcupineModel "kv", overlay, maxIterations, role
("gate" | "report" | new "hard"), expectedRate, calibration {atIso,
rateRuns, rateViolations, dispersion, cleanRuns, cleanViolations,
hostCeiling, budgetRatio, runsPerSec, eventsPerSec, tauBestSec}, notes,
wallSec, replicates, plus new fields `tier` and `expectedEvents` (=
eventsPerSec x wallSec x scale 3) so a reader knows the power before the
run.

Grader changes (`research/lite/grader.ts`, cmdPanel): keep
DEFAULT_PANEL_MEMBERS as the quick guard set; add `--members hard`
resolving to a HARD_PANEL_MEMBERS list; per row emit `expectedEvents`
(calibration.eventsPerSec x exploreSec), and when violations is 0 emit
`violationsPerExploreSec: 0` with `read: "count-only"`; emit the Poisson z
against the previous panel's count only when both counts are >= 20.

Interpretation going forward: per-run rate flat within noise on easy
members = no harm (guard); per-second up with per-run flat = tempo; per-run
up on a recovery-shaped member = the fault mechanisms generalized
(portfolio gain); a hard member's zero is a zero with stated E, never a
rate.

## 4. Cost and sequencing

Today: paxos finishes its 96k-run grid in ~12.5 s of its 30 s budget,
mencius runs its 45 s; explore ~58 s plus porcupine over ~166k runs. Well
under 10 minutes.

Quick guard set (after every merge, target < 10 min): the two live members
plus raft-stale-vote at wallSec 40 (120 s at scale 3; E ~36 at the old
rate). Adds ~2 min explore plus porcupine over ~115k Raft runs.

Slow hard set (direction reviews only, `--members hard`, ~30 min):
raft-forget-vote 600 s (E ~10), raft-commit-prev-term 600 s (count),
paxos_recover_stale_scout once calibrated, sdpaxos after its ceiling probe,
and the two controls (E, F) at 45 s each.

Order: (1) re-measure the four dormant members on the merged tree with
`--members all` (6 x <= 45 s explore, about 8 minutes with porcupine) -
this is a real read already, since they have never run on a tree with the
crash-path merges; (2) promote raft-stale-vote to the quick set at wallSec
40; (3) build and calibrate paxos_recover_stale_scout (A); (4) write the
figure-8 run-plan and admit raft-commit-prev-term to the slow set as a
count; (5) ceiling probes on SDPaxos and Paxos, then D and the controls.

A hard member counts as a portfolio gain when: a never-observed member
records its first violation under the general config with a trace that
matches its shape line; or a medium member's per-run rate separates from
its previous panel at z >= 2.7 after dividing by sqrt(dispersion), with
runs/s within 5% (so it is not tempo). A single event on a member with
E < 3 is recorded, not credited.

## 5. Risks

- A hard member that never violates gives no read. With E expected events,
  P(0 | no change) = exp(-E): E = 3 leaves 5%, E = 1 leaves 37%. A member
  whose E in the run's wall is under 3 reports count only; under 1 it is
  not run except as a reachability proof.
- Overfitting the panel to the VR shape: three of the proposed members
  (A, C, D) share it by design; E and F exist so the panel also says
  whether fault mechanisms disturb non-fault bugs. Keep at least one
  no-shape member in every set.
- Host ceilings bound what any tuning can show: Raft at 0.0021 caps every
  Raft member; a 2x on raft-stale-vote is real but can never become a gate.
- Control contamination: Paxos.spur's ~1e-4 background under crashes makes
  any Paxos F2 member below ~2e-3 unattributable until it is classified.
- Untried hosts (SDPaxos, Mencius opt-1-2-3) have unknown runs/s and
  ceilings; probe before injecting.
- Protected path: bin/spur is protected and the overnight authority covers
  additive files only. Every new member is a new file under
  bin/spur/panel/ derived from an unmodified host; VR.spur is never edited,
  including for the nonce fix, which stays a filed finding.

## First step (one iteration)

On the merged research/lite tree with the baseline built, run the panel
over every manifest member at the default seed and scale
(`grader.ts panel --members all --scale 3 --seed 1000`), and record per
member: runs, violations, explore seconds, per-run rate, per-second rate,
and E = calibration.eventsPerSec x exploreSec. Compare raft-stale-vote
(E ~13), raft-forget-vote (E ~0.8), raft-commit-prev-term (E 0) and
paxos-forget-promise (E ~38, control ~28) against their 2026-08-28
calibration. Then set raft-stale-vote's wallSec to 40 in manifest.30.json
and add it to the quick set. No spec files change in this step.
