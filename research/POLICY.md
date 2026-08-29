# Loop Policy

Generated: 2026-08-29T03:44:35.683Z

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

## Sequential evaluation

- exploreBudgetSec: 300
- maxRunsPerConfig: 4000
- maxChunks: 4
- minChunks: 2
- rejectP: 0.05
- inconclusiveP: 0.9
- niP: 0.95
- regressMargin: 0.25
- maxResumes: 2
- resumeCooldown: 2
- draws: 2000
- wallSecPerChunk: 1800

## Budgets

- maxWallMinutesPerHypothesis: 150
- maxLineageDepth: 6
- stagnationWindow: 8
- maxImplementTurns: 110
- maxImplementMinutes: 20
- maxBuildSeconds: 600
- minFreeDiskGb: 40

## Proposal / Audit

- proposal.lenses: 7
- proposal.maxPoolSize: 60
- audit.everyK: 5

## Evaluation

- spec: bin/spur/VR.spur
- configTemplate: scheduler_configs/loop/general_vr.json
- oracleDags: research/oracle/relax_minimal_general.json
- rayonThreads: 14

## Regression

- panelManifest: research/panel/manifest.json
- vrNoFaultConfig: scheduler_configs/loop/regression_vr_nofault.json
- throughputTolerance: 0.2
- wallSecPerCase: 560

## Clamps applied on load

None - policy file was within hard limits.

## Changelog

- initial policy
