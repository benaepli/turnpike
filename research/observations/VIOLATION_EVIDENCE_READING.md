# How to read violation evidence

Three corrections established 2026-08-30, each of which had already misled a
reader of this record.

## A porcupine signature is not a defect fingerprint

`porcupine/cmd/porcupine_batch/main.go:69-101` hashes the model name, the
operation count, each partition's longest-prefix shape, and the sorted
`clientId:input` strings of unplaceable operations. `KVInput` carries the
per-run `uid`, so the hash is a function of the client history, not of the
schedule, the node states or the defect.

Across the whole archive, **9 distinct violating runs produced 9 distinct
signatures, with no collision ever**. Two violations always have two new
signatures. Runs 101633 and 154241 have different signatures and
`VIOLATION_101633.md` concludes their mechanism is identical.

Signature novelty carries no information about whether a defect is new, and
must not be used as evidence that a candidate found something.

## The by-arm violation tally in earlier notes is contaminated

A count of "17 violations" by arm circulated on 2026-08-29. It is wrong three
ways: the 2026-08-28 chunk diagnosed as a run-id collision artifact
(`research/logs/violations/baseline-sequential-1000-1787914659862/NOTE.md`)
contributes three non-violations, each double-counted across two arms, and two
real runs each appear in two chunks. The correct figure over the same period
is 9 distinct violating runs, which is what the loop's own archive rate uses.

The apparent 1.6x per-run enrichment of the `aos` and `grid-post-fault-2` arms
is entirely that artifact. With it removed those arms have one violation each,
and no arm is measurably enriched: `grid-short` holds 55.6% of violations on
43.8% of runs, an enrichment of 1.27x.

## The archive rate is stable, and it is the right comparator

Per-run violation rate by day, campaign-epoch sequential chunks only:

| date | chunks | runs | violations | 1 per |
| --- | --- | --- | --- | --- |
| 2026-08-28 | 12 | 2.47M | 0 | - |
| 2026-08-29 | 72 | 19.1M | 8 | 2.39M |
| 2026-08-30 | 43 | 12.7M | 6 | 2.12M |

No drift; 8 events against 6 is Poisson noise. A four-chunk baseline carries
one violation about a fifth of the time, which is why the baseline's own count
was replaced as the comparator.

At this rate a 1.1M-run candidate expects 0.42 violations, so seeing two has
p about 0.06 and several candidates per session will look elevated without
being so. Three did on 2026-08-30.

## A candidate that separates still needs its own follow-up

Iteration 5344 (`coverage-guided-fault-placement`) separated at 2 violations
in 599,968 runs against 1 per 2,699,255 - and the violation branch returns
before the depth logic, so it advanced at the two-chunk minimum and never
reached its cap. Two further chunks on its own binary and config, seeds 1002
and 1003, produced **0 violations in 591,456 runs**. Pooled: 2 in 1,191,424,
P(X>=2) = 0.073 pooled and 0.026 arm-conditioned - no longer separated. The
extra chunks expected 1.97 violations under the candidate's own observed rate
and 0.22 under the archive rate, so the null result is 5.8:1 against.

Its two original violations were near-twins - same arm, same `config_index`
29, same victim uid, same node, same rollback-to-empty - so the independence
the Poisson test assumes was optimistic. A violation advance that rests on
fewer than three events, or on events sharing a configuration, is worth one
follow-up pair of chunks before it changes anything the baseline is measured
against.
