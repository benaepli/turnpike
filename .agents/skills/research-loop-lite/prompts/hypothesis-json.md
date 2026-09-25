# Hypothesis JSON guide (hand to the proposer as its output format)

The overrides in `proposer.md` take precedence over this guide.

```
Reply with ONLY a JSON object: {"hypotheses": [...]}. Each hypothesis:
{"id": "kebab-case-slug", "parent": null or "existing-id", "kind": "add"|"ablate"|"meta"|"enabling"|"grader"|"perf"|"arm",
 "title": "...", "description": "what to change, concretely, incl. which files/mechanisms and the config field that gates it",
 "category": "scheduler"|"config"|"feedback"|"tooling"|"policy"|"grader"|"performance",
 "buildsOn": ["mechanism names this depends on"], "expectedGain": 0-10, "expectedCost": 0.1-10,
 "rationale": "why this should move the ladder", "generalityArgument": "why this is protocol-agnostic (rule 1)",
 "prediction": {"firingCounter": "dotted.path.in.utilization.json" or null, "firingFloor": 1,
   "rung": "depth>=4"|"depth>=5"|"depth>=6"|"depth>=7"|"depth>=8"|"depth>=9"|"depth>=10"|"depth>=11"|"depth>=12"|"depth>=13"|"violations"|"h2"|"throughput",
   "sizePct": {"min": 0.05, "max": 0.15}, "mechanism": "how the change produces that move",
   "independentObservable": "something else this predicts that the rung does not",
   "falsifier": "the result that would refute it"},
 "createdAtIso": "<now>", "notes": ""}

The prediction is frozen when the hypothesis is admitted and is what the result is graded against; it is never rewritten afterwards. firingCounter must name a counter the explorer already emits (the utilization dump lists them) and firingFloor the value at or above which the mechanism had occasions: a counter that stays below its floor closes the hypothesis before any rate is read, because a mechanism with no occasions produced no evidence either way. sizePct is a band in relative terms, so 0.05 to 0.15 claims +5% to +15% on that rung. A band wide enough to cover every outcome is not a prediction.
```
