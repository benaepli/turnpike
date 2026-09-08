import argparse
import json
from pathlib import Path


def median_bounds(histogram):
    total = sum(histogram)
    if not total:
        return None
    ranks = [(total + 1) // 2, (total + 2) // 2]
    values = []
    for rank in ranks:
        seen = 0
        for length, count in enumerate(histogram, 1):
            seen += count
            if seen >= rank:
                values.append(length)
                break
    return dict(lower=sum(values) / 2, upper=None if 32 in values else sum(values) / 2,
                stretches=total, overflow_stretches=histogram[-1])


def population(data, arms, ready):
    histogram = [0] * 32
    censored = [0] * 32
    dispatches = timers = 0
    for arm in arms:
        for stratum in ready:
            item = data[str(arm)][str(stratum)]
            dispatches += item['dispatches']
            timers += item['timers']
            for i in range(32):
                histogram[i] += item['lengths_including_censored'][str(i + 1)]
                censored[i] += item['censored'][str(i + 1)]
    return dict(median=median_bounds(histogram), dispatches=dispatches, timers=timers,
                timer_share=timers / dispatches if dispatches else None,
                censored_stretches=sum(censored),
                qualified_runs=sum(data[str(arm)]['qualified_runs'] for arm in arms)
                if len(ready) == 4 else None)


def comparison(prefix, control):
    a, b = prefix['median'], control['median']
    lower = a['lower'] / b['upper'] if a and b and b['upper'] else None
    upper = a['upper'] / b['lower'] if a and b and a['upper'] else None
    return dict(prefix=prefix, plan_only=control,
                median_ratio_bounds=dict(lower=lower, upper=upper),
                timer_share_ratio=prefix['timer_share'] / control['timer_share']
                if control['timer_share'] and prefix['timer_share'] is not None else None)


def summarize(raw):
    result = {k: v for k, v in raw.items() if isinstance(v, (int, float))}
    for label, a, b in [('multi_chain_share', 'multi_chain_samples', 'eligible_tournaments'),
                        ('final_authority_share', 'choice_changed_after_preferences', 'authority_decisions')]:
        result[label] = raw[a] / raw[b] if raw[b] else None
    results = {}
    groups = [('grid', range(4), range(4))]
    groups += [(f'arm_{i}', [i], range(4)) for i in range(4)]
    groups += [(f'readiness_{i}', range(4), [i]) for i in range(4)]
    for label, arms, ready in groups:
        results[label] = comparison(population(raw['prefix'], arms, ready),
                                    population(raw['plan_only'], arms, ready))
    return dict(counters=result, persistence=results,
                note='Selected qualified populations; descriptive, not an isolated randomized effect. '
                     'Length32 is >=32. Censored stretches already included once. '
                     'Readiness-specific qualified_runs is unavailable and left null.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('utilization', type=Path)
    args = parser.parse_args()
    print(json.dumps(summarize(json.loads(args.utilization.read_text())['replay_chain_pct']), indent=2))
