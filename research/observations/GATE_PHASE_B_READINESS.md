# What Phase B needs before it starts

Phase A of the gate simplification is landed and the offline replay harness
works. This note says what the next mandate has to build, what it can now
rely on, and the four things that will bite it.

## What it can rely on

**The replay harness.** `npx tsx src/replay.ts [--assert] [--all]` re-decides
every epoch-7-or-later recorded decision through the live `decideSequential`
and `finalGate` on the recorded evaluations, at zero explore cost, and
asserts a named acceptance list. Phase B extends the `EXPECTED` table in that
file rather than writing a second harness. Its current state: 29 of 62
verdicts change, no recorded merge closes, 5369 does not merge, 5361 does.

**The null band, settled.** `research/observations/EVAL_NOISE_FLOOR.md` shows
the A/A spread on the stratified rate is the Poisson floor its own event
count implies, `sqrt(1/ec + 1/eb)`, about 3.1% at depth>=6, with eight rung
comparisons from two independent A/A pairs all inside 1.1 sigma of it. The
mid-run stopper should therefore compute its band from the event counts it
already holds. Do not hand it a constant, and do not have it read a number
out of an observations file: both were considered and both are worse than the
arithmetic.

**The firing-counter mapping.** `research/observations/PANEL_RETIRED.md` keeps
the config-path to counter table and the firing rule that the deleted panel
ran on. The counters themselves are still collected every iteration and
stored under `util:<hypothesis id>`, so the input the merge decider's firing
check needs is live; only the code that read it is gone. Rebuild it as a
small module, not as a revived panel.

## What it has to build

The mid-run stopper and the merge decider, as the spec describes them. Two
notes on shape that Phase A settled:

`Hypothesis.firingCounter` already exists and is now unread. The prediction
object should absorb that field rather than add a second one beside it: a
hypothesis that declares a counter and a hypothesis that declares a
prediction naming a counter must not be two different things.

`judgedByNonInferiority(kind)` in decide.ts is now the single definition of
which kinds are read as non-inferiority, shared by the sampler and the gate.
Anything Phase B adds that branches on kind should read that, not re-derive
it. Two definitions of this fact is what let the gate close on a criterion
the sampler was never asked to meet.

## Four things that will bite

**The replay cannot resolve a candidate that would keep sampling.** The rule
decides when to stop, so a candidate today's rule carries past the last chunk
the record holds has no offline verdict; those report as `unresolved`. Eight
of the twelve deleted-guard cases are that shape. An LLM stopper is worse
than unresolved - it is not replayable at all - so the mitigation the spec
names is not optional: log the posteriors block verbatim beside the stopper's
answer, or rejections stop being auditable the day it lands.

**Two self-tests read source text, not behavior.** `selfTestUnmeasured` in
decide.ts greps loop.ts for one `unmeasurableReasons(spurFiles, superFiles)`,
one `lintFailures.length === 0`, and exactly five bare occurrences of
`sampled`. Any commit touching loop.ts must fix those counts in the same
commit or the loop refuses to start. `selfTestGateConsistency` in
sequential.ts asserts the rule and the gate agree on synthetic chunks under
both kinds; any commit changing one side must move the fixture in the same
commit. Both are features. Neither is a nuisance to route around.

**`FidelityName` is the record's schema, not the loop's menu.**
`research/state.sqlite` holds 33 evaluations at fidelity `confirm`, 56 at
`promote` and 41 at `screen`, and `LoopState.allEvaluations` parses every
stored row. Removing a member breaks the violation prior and STATUS
rendering, whatever the loop stopped producing. The same caution applies to
anything else Phase B is tempted to prune from `schemas.ts`.

**One recorded merge is blocked by something Phase A did not touch.**
Iteration 5328 advanced as "violations appeared (1)" and merged. Under the
current code it no longer advances, and the cause is
`cand.violations <= base.violations` in the sequential non-inferiority
condition: at chunk 2 the candidate had 1 violation and the baseline 0, so
1 <= 0 fails. Every other clause passes on that chunk - all four pRegress are
0.000 and the primary rung sits at pGreater 0.9945. The clause is sign-
flipped against the project's own objective, where a violation is the thing
being hunted, and it is monotone: once it fails no further sampling can
restore it. Phase C names it for deletion. The replay is the evidence that it
costs real merges, and it is worth deleting early rather than last.
