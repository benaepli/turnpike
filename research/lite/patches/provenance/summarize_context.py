"""Read frozen selector-context diagnostics from a completed utilization file."""

import argparse
import json
from pathlib import Path


def ratio(a, b):
    return a / b if b else None


def rates(row):
    n = row['specialized_learner_draws']
    return dict(specialized=n,
                fallback=row['shared_fallback_learner_draws'],
                specialized_share=ratio(n, n + row['shared_fallback_learner_draws']),
                scored=row['scored_runs'],
                sampled=row['sampled_runs'],
                sampled_unscored=row['sampled_unscored_runs'],
                context_loss_sum=row['context_loss_sum'],
                shared_loss_sum=row['shared_loss_sum'],
                loss_ratio=ratio(row['context_loss_sum'], row['shared_loss_sum']),
                tv_mean=ratio(row['tv_sum'], n),
                changed_argmax_share=ratio(row['changed_argmax_runs'], n),
                issued=row['issued_runs'], completed=row['completed_runs'],
                failed=row['failed_runs'], unfilled=row['unfilled_slot_fresh'],
                credited_runs=row['credited_runs'], learner_credits=row['learner_credits'],
                context_blocks_created=row['context_blocks_created'])


def summarize(raw):
    x = raw['selector_context']
    scopes = {}
    for name, scope in x['scopes'].items():
        scopes[name] = dict(totals=rates(scope),
                           contexts={k: rates(v) for k, v in scope['contexts'].items()},
                           learners={k: rates(v) for k, v in scope['learners'].items()})
    checks = {'specialized_100k': x['specialized_learner_draws'] >= 100000}
    for name, contexts, minimum, sample in [
            ('grid', ['fresh', 'plan_reuse', 'prefix_replay'], 5000, 1000),
            ('aos', ['fresh', 'tape_mutation'], 1000, 100)]:
        s = scopes[name]
        share = s['totals']['specialized_share']
        checks[name + '_specialized_share_75pct'] = share is not None and share >= .75
        checks[name + '_scored_floor'] = s['totals']['scored'] >= sample
        for context in contexts:
            checks[name + '_' + context + '_supply'] = s['contexts'][context]['specialized'] >= minimum
    identities = dict(issued_accounted=x['issued_runs'] == x['completed_runs'] + x['failed_runs'],
                      draws_accounted=x['issued_runs'] == x['specialized_learner_draws'] + x['shared_fallback_learner_draws'] + x['coin_draws'] + x['probe_draws'],
                      samples_accounted=x['sampled_runs'] == x['scored_runs'] + x['sampled_unscored_runs'],
                      unfilled_assigned=x['scopes']['grid']['contexts']['fresh']['learners']['none']['unfilled_slot_fresh'] == 0)
    return dict(totals=rates(x), scopes=scopes, supply_checks=checks,
                all_supply_pass=all(checks.values()), consistency=identities,
                layout={k: v for k, v in x.items() if k.endswith('_bytes')},
                note='Draw identity assumes no failure before selection; failures remain explicit. Per-chunk loss and policy diagnostics are descriptive until the frozen pooled horizon; supply gates apply separately to each chunk.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('utilization', type=Path)
    args = parser.parse_args()
    print(json.dumps(summarize(json.loads(args.utilization.read_text())), indent=2))
