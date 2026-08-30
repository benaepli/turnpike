# The bug panel: what it measured, and the table worth keeping

The panel ran a set of protocol specs carrying known defects on the
candidate's binary and the baseline's in one window, asking whether a change
erodes bug-finding away from VR. It is removed from the loop. This note keeps
the part of it that is durable: the config-path to counter mapping, the six
members' measured calibration, and the firing rule those two exist to serve.

## Why it was removed

Measured over its whole life, 29 runs at 494 s mean wall (18% of the
iterations that reached the regression suite, about 4 hours of explore in
total):

- zero collapses, ever
- `combinedZ` non-null in 5 of 29 runs; the other 24 judged nothing
- those five values: -0.098, -0.091, -0.028, -0.005, +0.036, against a
  review bar of -2.0
- zero verdicts changed

Two of the six members cannot produce a number at their calibrated rate.
`raft-commit-prev-term` measured 0 events per second over 20,016 runs;
`raft-forget-vote` measured 0.00552 per second, which is 0.08 expected events
in its 15 s wall. A member that expects less than one event cannot separate
anything, so it was never going to judge.

The question the panel asked is still a good question and nothing else asks
it. It should come back as an offline check run on demand, not as a stage in
every merge.

## The firing rule

A mechanism that had no occasions on a member did not fail on it, and the
member must not be read as having measured anything. The rule, as it stood:

1. If the candidate changed spur source and declared a firing counter, the
   member judges only when that counter is nonzero in BOTH arms. Otherwise
   the status is `no-occasions`.
2. If the candidate changed only the explorer config, take the dotted paths
   whose values differ between the two config templates, drop the paths the
   runner overwrites or deletes before the explorer sees them, and map each
   remaining path through the table below. A path with no entry yields
   `unknown`, which voids the member - the safe direction. A mapped path
   whose counter is nonzero in both arms is `fired`.
3. No differing path at all is `no-config-change`.

The runner-overwritten paths are the campaign-only keys plus
`num_runs_per_config`, `session_seed`, `num_crashes`, `max_iterations` and
`wall_budget_sec`. Counting a difference on one of those as an unmapped
mechanism voided every arm-kind candidate on `campaign.arms`, a key the
config materializer deletes.

## Config path prefix -> utilization counter

A path matches a prefix exactly or as a dotted extension of it.

| config path prefix | counter that must be nonzero in both arms |
| --- | --- |
| `post_fault_client_ops` | `post_fault_ops.pairs_seen` |
| `purgatory` | `purgatory.delayed_sends` |
| `feedback.steer` | `steer.evaluations` |
| `feedback` | `feedback.scored_runs` |
| `use_coverage_scheduling` | `feedback.scored_runs` |
| `quick_fire_multiplier` | `multiplier_authority.quick_fire_decisions` |
| `emit_multiplier_authority` | `multiplier_authority.decisions` |
| `rng_stream_isolation` | `rng_streams.isolated_runs` |
| `within_queue_selector` | `multiplier_authority.decisions` |
| `queue_policy` | `multiplier_authority.decisions` |
| `schedule_policy` | `multiplier_authority.decisions` |

The counters themselves are still collected: the loop reads the candidate's
own utilization counters before each sequential evaluation and stores them
under `util:<hypothesis id>`. Only the panel's use of them is gone.

## Member calibration, 14 threads, measured 2026-08-28

| member | role | wall s | expected rate | runs | violations | events/s | runs/s | clean runs | clean violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| paxos-accept-stale-ballot | gate | 10 | 0.01664 | 20736 | 345 | 29.418 | 1733 | 20736 | 1 |
| mencius-opt1-2 | gate | 15 | 0.007418 | 51360 | 381 | 2.403 | 294 | 25680 | 0 |
| raft-stale-vote | report | 15 | 0.0002998 | 20016 | 6 | 0.188 | 619 | 20016 | 0 |
| raft-commit-prev-term | report | 15 | 0.00001 | 20016 | 0 | 0 | 616 | 20016 | 0 |
| raft-forget-vote | report | 15 | 0.00001 | 20016 | 0 | 0.006 | 617 | 20016 | 0 |
| paxos-forget-promise | report | 15 | 0.0002001 | 19992 | 4 | 0.633 | 2892 | 19992 | 3 |

Two rows deserve a second look before any of this is rebuilt.
`paxos-accept-stale-ballot` reports one violation on its clean arm, and
`paxos-forget-promise` reports three, so neither clean control is actually
clean at the wall it runs at. A member whose control violates cannot
attribute a violation to the defect it was chosen for.

The specs are under `bin/spur/panel/` and `bin/spur/mencius/` and are
untouched. The manifests are at `research/panel/manifest.json` and its
thread-keyed siblings; nothing reads them any more.
