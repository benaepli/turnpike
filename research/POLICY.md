# Loop Policy

Generated: 2026-08-24T17:46:14.196Z

Active (clamped) policy values. Hard limits are compiled into src/policy.ts and are not agent-editable.

## Models

| Phase | Model |
| --- | --- |
| propose | claude-opus-5 |
| judge | claude-opus-5 |
| implement | claude-opus-5 |
| diagnose | claude-opus-5 |
| reflect | claude-opus-5 |
| audit | claude-opus-5 |

## Bandit

- explorationQuota: 0.3
- ucbC: 1.2

## Fidelities

| Rung | exploreWallSec | runsPerConfig | gradeMaxRuns | gradeBudgetMs | seeds |
| --- | --- | --- | --- | --- | --- |
| screen | 150 | 100 | 0 | 45000 | 11 |
| promote | 600 | 250 | 0 | 120000 | 11, 23 |
| confirm | 900 | 400 | 0 | 300000 | 11, 23, 37 |

## Budgets

- maxWallMinutesPerHypothesis: 90
- maxLineageDepth: 6
- stagnationWindow: 8
- dailyWallHours: 20
- maxImplementTurns: 80
- maxBuildSeconds: 600
- minFreeDiskGb: 40

## Proposal / Audit

- proposal.lenses: 6
- proposal.maxPoolSize: 60
- audit.everyK: 5

## Evaluation

- spec: bin/spur/VR.spur
- configTemplate: scheduler_configs/loop/general_vr.json
- oracleDags: research/oracle/relax_minimal.json
- rayonThreads: 14

## Regression

- menciusBugSpec: bin/spur/mencius/Mencius_opt1_2.spur
- menciusBugConfig: scheduler_configs/loop/regression_mencius.json
- menciusFixedSpec: bin/spur/mencius/Mencius_opt1_2_fixed.spur
- vrNoFaultConfig: scheduler_configs/loop/regression_vr_nofault.json
- throughputTolerance: 0.2
- wallSecPerCase: 240

## Clamps applied on load

None — policy file was within hard limits.

## Changelog

- initial policy
