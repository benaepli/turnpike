"""Ghost-release firing, placement and nested-cell reads from completed chunks."""

import json
from pathlib import Path

root = Path('/home/benaepli/Rust/turnpike')
state = json.loads((root / 'research/lite/state/ghost-release.json').read_text())
base = json.loads(Path(state['cacheFile']).read_text())
P = 'crash_place.ghost_release.'
CELLS = ['untreated', 'treated', 'release_all', 'single']


def cell(c, n):
    g = lambda k: c.get(f'{P}cells.{n}.{k}') or 0
    runs = g('runs'); later = g('later_crashes_applied'); fa = g('fired_crashes_applied')
    btot = sum(g(f'fired_inflight_bucket_{i}') for i in ['0', '1', '2', '3plus'])
    return dict(runs=runs, crashes_per_run=g('crashes_applied') / max(1, runs), steps_per_run=g('steps_used_sum') / max(1, runs),
                within3_per_later=g('applied_within_3_of_acted_ghost') / max(1, later),
                fired_within3=g('fired_crashes_applied_within_3') / max(1, fa), fired_within3_unanchored=g('fired_crashes_applied_within_3_unanchored') / max(1, g('fired_crashes_applied_unanchored')),
                fired_within3_anchored=g('fired_crashes_applied_within_3_anchored') / max(1, g('fired_crashes_applied_anchored')),
                on_ghost_node=g('fired_crashes_on_ghost_node') / max(1, fa), on_ghost_retarget=g('fired_crashes_on_ghost_node_retarget') / max(1, g('fired_crashes_applied_retarget')), on_ghost_stock=g('fired_crashes_on_ghost_node_stock') / max(1, g('fired_crashes_applied_stock')),
                fired_bucket0_share=g('fired_inflight_bucket_0') / max(1, btot), fired_bucket3plus_share=g('fired_inflight_bucket_3plus') / max(1, btot),
                double_crash_per_fired=g('double_crash_after_release') / max(1, fa), fired_crashes_applied=fa)


def depth_by_cell(cand):
    out = {}
    for r in cand['metrics']['variants']:
        v = r['variant']
        if v & 6 or not (v & 1): continue
        name = 'untreated' if not (v & 16) else ('single' if v & 268435456 else 'release_all')
        o = out.setdefault(name, {'runs': 0, 'd5': 0, 'd6': 0, 'd8': 0, 'd9': 0, 'd10': 0})
        o['runs'] += r['runs']
        for k, i in [('d5', 4), ('d6', 5), ('d8', 7), ('d9', 8), ('d10', 9)]: o[k] += r['depthAtLeast'][i]
    return out


def ratio(a, b, k):
    return ((a[k] / a['runs']) / (b[k] / b['runs'])) if a.get('runs') and b.get('runs') and b.get(k) else None


def read(seed, cand, bc):
    c = cand['utilStats']['counters']
    cells = {n: cell(c, n) for n in CELLS}
    d = depth_by_cell(cand)
    treated = {'runs': 0, 'd5': 0, 'd6': 0, 'd8': 0, 'd9': 0, 'd10': 0}
    for n in ('release_all', 'single'):
        for k in treated: treated[k] += d.get(n, {}).get(k, 0)
    single = {k: c.get(f'{P}single.{k}') for k in ['releases', 'released_own_crash', 'released_via_ranking', 'released_forced', 'no_release_case']}
    return dict(seed=seed, armed=c.get(P + 'armed'), fired=c.get(P + 'fired'), firing_floor_50k=(c.get(P + 'fired') or 0) >= 50000, fired_nothing_held=c.get(P + 'fired_nothing_held'),
                expired=c.get(P + 'expired'), superseded=c.get(P + 'superseded'), fired_over_armed=(c.get(P + 'fired') or 0) / max(1, c.get(P + 'armed') or 1),
                steps_from_restart_mean=(c.get(P + 'steps_from_restart_sum') or 0) / max(1, c.get(P + 'fired') or 1), released_crashes=c.get(P + 'released_crashes'), restarts_with_held_crash=c.get(P + 'restarts_with_held_crash'),
                lag=dict(p50=c.get(P + 'lag_p50'), p75=c.get(P + 'lag_p75'), p90=c.get(P + 'lag_p90'), samples=c.get(P + 'lag_samples')), scopes_engaged=c.get(P + 'scopes_engaged'),
                cells=cells,
                within3_ratio=cells['treated']['within3_per_later'] / cells['untreated']['within3_per_later'] if cells['untreated']['within3_per_later'] else None,
                steps_ratio_treated=cells['treated']['steps_per_run'] / cells['untreated']['steps_per_run'] if cells['untreated']['steps_per_run'] else None,
                crashes_ratio_treated=cells['treated']['crashes_per_run'] / cells['untreated']['crashes_per_run'] if cells['untreated']['crashes_per_run'] else None,
                single=single, single_releases_per_fired=None,
                single_vs_release_all=dict(steps=cells['single']['steps_per_run'] / cells['release_all']['steps_per_run'] if cells['release_all']['steps_per_run'] else None,
                                           on_ghost=(cells['single']['on_ghost_node'], cells['release_all']['on_ghost_node']),
                                           double_crash=(cells['single']['double_crash_per_fired'], cells['release_all']['double_crash_per_fired'])),
                depth_treated_over_untreated={k: ratio(treated, d.get('untreated', {}), k) for k in ['d5', 'd6', 'd8', 'd9', 'd10']},
                depth_single_over_release_all={k: ratio(d.get('single', {}), d.get('release_all', {}), k) for k in ['d5', 'd6', 'd8', 'd9', 'd10']},
                depth_counts=d, runs=[cand['metrics']['runs'], bc['metrics']['runs']], violations=[cand['metrics']['violations'], bc['metrics']['violations']], failed=cand['session']['runsFailed'])


out = []
for bc in base['chunks']:
    p = root / f"research/lite/state/ghost-release/chunk-{bc['seed']}.cand.json"
    if p.exists():
        out.append(read(bc['seed'], json.loads(p.read_text()), bc))
print(json.dumps(out, indent=1))
