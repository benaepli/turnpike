"""Population-block gates and own-run reward rates for completed paired chunks."""

import json
import sys
from pathlib import Path

root = Path('/home/benaepli/Rust/turnpike')
state = json.loads((root / 'research/lite/state/successful-vector.json').read_text())
base = json.loads(Path(state['cacheFile']).read_text())
LEARNERS = ['overtaken_ghost', 'absorber_cycle', 'cycle_before_request']
AXES = ['crash', 'retarget', 'fresh_first', 'pair_order', 'request']


def counters(rec):
    return rec['utilStats']['counters']


def pop(c, key):
    return c['arm_selector_population.' + key]


def series(c, key, n):
    return [c[f'arm_selector_population.{key}.{i}'] for i in range(n)]


def gates(c):
    sup = pop(c, 'supported_draws')
    changed = pop(c, 'changed_joint_draws')
    ham = series(c, 'hamming_hist', 6)
    two_plus = sum(ham[2:]) / sup if sup else 0.0
    tv_half = pop(c, 'tv_at_least_tenth') / sup if sup else 0.0
    mass = [m / (sup * 1e6) for m in series(c, 'mutation_axis_mass_micro', 5)] if sup else [0.0] * 5
    axes_ge_10 = sum(1 for m in mass if m >= 0.10)
    four = pop(c, 'supported_draws_with_four_distinct') / sup if sup else 0.0
    cells100 = series(c, 'cells_reaching_supported_draws', 5)[2]
    cells100_by = series(c, 'cells_reaching_hundred_supported_draws_by_learner', 3)
    comp = series(c, 'supported_completed_runs_by_learner', 3)
    succ = series(c, 'supported_successful_runs_by_learner', 3)
    return dict(
        supported_draws=sup, unsupported_draws=pop(c, 'unsupported_draws'),
        changed_joint_draws=changed, firing_floor_50000=changed >= 50000,
        supported_floor_100000=sup >= 100000,
        hamming_hist=ham, two_plus_share=two_plus, two_plus_gate_20pct=two_plus >= 0.20,
        tv_at_least_tenth_share=tv_half, tv_gate_half=tv_half >= 0.5,
        tv_mean=pop(c, 'tv_micro_sum') / (sup * 1e6) if sup else 0.0,
        mutation_mass=dict(zip(AXES, mass)), axes_ge_10pct=axes_ge_10, axes_gate_two=axes_ge_10 >= 2,
        four_distinct_share=four, four_distinct_gate_80pct=four >= 0.80,
        top_share_mean=pop(c, 'supported_top_share_micro') / (sup * 1e6) if sup else 0.0,
        cells_reaching_100=cells100, cells_gate_20=cells100 >= 20, cells_100_by_learner=cells100_by,
        cells_created=pop(c, 'cells_created'),
        supported_outcome_rate=[s / n if n else None for s, n in zip(succ, comp)],
        supported_completed=comp, supported_successful=succ,
        storage_bytes=pop(c, 'storage_bytes'), layout=series(c, 'layout_bytes', 2),
        live_entries_hist=series(c, 'live_entries_hist', 25), distinct_hist=series(c, 'distinct_hist', 25),
    )


def own_rates(c):
    out = {}
    for l in LEARNERS:
        n = c[f'arm_selector_axis.{l}.reward_runs_treated']
        p = c[f'arm_selector_axis.{l}.reward_positive_treated']
        out[l] = dict(runs=n, positive=p, rate=p / n if n else None)
    return out


result = dict(chunks=[], pooled_reward=None)
pooled = {l: dict(cn=0, cp=0, bn=0, bp=0) for l in LEARNERS}
for b in base['chunks']:
    path = root / f"research/lite/state/successful-vector/chunk-{b['seed']}.cand.json"
    if not path.exists():
        continue
    cand = json.loads(path.read_text())
    cc, bc = counters(cand), counters(b)
    cr, br = own_rates(cc), own_rates(bc)
    ratios = {l: (cr[l]['rate'] / br[l]['rate']) if br[l]['rate'] else None for l in LEARNERS}
    for l in LEARNERS:
        pooled[l]['cn'] += cr[l]['runs']; pooled[l]['cp'] += cr[l]['positive']
        pooled[l]['bn'] += br[l]['runs']; pooled[l]['bp'] += br[l]['positive']
    result['chunks'].append(dict(seed=b['seed'], gates=gates(cc), own_reward_candidate=cr,
                                 own_reward_baseline=br, own_reward_ratio=ratios,
                                 violations=[cand['metrics']['violations'], b['metrics']['violations']],
                                 runs=[cand['metrics']['runs'], b['metrics']['runs']],
                                 failed=cand['session']['runsFailed']))
pr = {}
for l in LEARNERS:
    p = pooled[l]
    cr = p['cp'] / p['cn'] if p['cn'] else None
    br = p['bp'] / p['bn'] if p['bn'] else None
    pr[l] = dict(candidate_rate=cr, baseline_rate=br, ratio=(cr / br) if cr and br else None)
rs = sorted([v['ratio'] for v in pr.values() if v['ratio'] is not None], reverse=True)
result['pooled_reward'] = dict(by_learner=pr, clause_two_ge_1_10_third_ge_0_95=(len(rs) == 3 and rs[1] >= 1.10 and rs[2] >= 0.95))
print(json.dumps(result, indent=1))
