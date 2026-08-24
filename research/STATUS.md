# Research Loop Status

Generated: 2026-08-24T09:13:48.646Z
Grader version: ta:0de6d9d+porc:b49e339

## Metric ladder

| Metric | Baseline | Latest merged |
| --- | --- | --- |
| violations | 0 | — |
| meanPrefixDepth | 2.25 | — |
| P(depth>=4) | 0.036 | — |
| P(depth>=5) | 0.002 | — |
| P(depth>=6) | 0.000 | — |
| P(depth>=7) | 0.000 | — |
| P(depth>=8) | 0.000 | — |
| h1Rate | 0.491 | — |
| h2Rate | 0.393 | — |
| h2bRate | 0.417 | — |
| h3Rate | 0.340 | — |
| runsPerSec | 122.3 | — |

## Hypothesis pool

Total: 9 (proposed: 9)

| id | kind | status | gain/cost | title |
| --- | --- | --- | --- | --- |
| send-anchored-crash-points | add | proposed | 8/3 | Crash points anchored to message dispatch events |
| pct-priority-selector | add | proposed | 6/6 | PCT-style priority change points selector |
| orphan-message-purgatory | add | proposed | 9/4 | Hold in-flight messages of a crashed sender until it recove… |
| incarnation-timeline-tuples | add | proposed | 7/5 | Incarnation-aware timeline novelty tuples |
| hazard-fitness-for-guided-modes | add | proposed | 7/6 | Use hazard events as fitness for genetic/AOS modes |
| exclusive-timer-firing | add | proposed | 6/3 | Fire timers on at most one node per window |
| enable-timeline-feedback-general-config | enabling | proposed | 4/0.500 | Turn on timeline feedback + steer in the general config |
| enable-purgatory-general-config | enabling | proposed | 5/0.500 | Turn on message-delay purgatory in the general config |
| ablate-dead-randomly-drop-msgs | ablate | proposed | 2/1 | Remove the dead randomly_drop_msgs code path |

## Last 15 iterations

No iterations recorded yet.

## Open needs_human PRs

None.

## Policy snapshot

- Models: propose=claude-opus-5, judge=claude-opus-5, implement=claude-opus-5, diagnose=claude-opus-5, reflect=claude-opus-5, audit=claude-opus-5
- Budgets: 90 wall-min/hypothesis, 20 wall-h/day, 80 implement turns, 600s build, 40GB free disk floor
- Bandit: explorationQuota=0.3, ucbC=1.2
- Fidelity explore wall (s): screen=150, promote=600, confirm=900
- Evaluation: spec=bin/spur/VR.spur, audit every 5 iterations

