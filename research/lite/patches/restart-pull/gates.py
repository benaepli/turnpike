"""Restart-pull firing, window and nested-trigger reads from completed chunks."""

import json
from pathlib import Path

root = Path('/home/benaepli/Rust/turnpike')
state = json.loads((root / 'research/lite/state/restart-pull.json').read_text())
base = json.loads(Path(state['cacheFile']).read_text())
P = 'crash_place.restart_pull.'
CELLS = ['untreated', 'treated', 'pull_only', 'trigger']


def cell(c, name):
    g = lambda k: c.get(f'{P}cells.{name}.{k}') or 0
    runs = g('runs'); later = g('later_crashes_applied'); armed = g('early_armed')
    b3 = g('early_inflight_bucket_3plus'); btot = sum(g(f'early_inflight_bucket_{i}') for i in ['0', '1', '2', '3plus'])
    return dict(runs=runs, crashes_per_run=g('crashes_applied') / max(1, runs), steps_per_run=g('steps_used_sum') / max(1, runs),
                within_window_share=g('applied_within_window') / max(1, later), early_expired_over_armed=g('early_expired') / max(1, armed),
                bucket_3plus_share=b3 / max(1, btot))


def depth_by_cell(cand):
    out = {}
    for r in cand['metrics']['variants']:
        v = r['variant']
        if v & 6 or not (v & 1): continue  # probes out; placed runs only
        name = 'untreated' if not (v & 16) else ('trigger' if v & 268435456 else 'pull_only')
        o = out.setdefault(name, {'runs': 0, 'd5': 0, 'd6': 0, 'd8': 0, 'd9': 0, 'd10': 0})
        o['runs'] += r['runs']
        for k, i in [('d5', 4), ('d6', 5), ('d8', 7), ('d9', 8), ('d10', 9)]: o[k] += r['depthAtLeast'][i]
    return out


def ratio(a, b, k):
    return ((a[k] / a['runs']) / (b[k] / b['runs'])) if a['runs'] and b['runs'] and b[k] else None


def read(seed, cand, bc):
    c = cand['utilStats']['counters']
    cells = {n: cell(c, n) for n in CELLS}
    trig = {k: c.get(f'{P}trigger.{k}') for k in ['armed', 'fired', 'expired', 'superseded', 'steps_from_restart_sum', 'fired_crashes_applied_retarget', 'fired_crashes_on_ghost_node_retarget', 'fired_crashes_applied_stock', 'fired_crashes_on_ghost_node_stock']}
    d = depth_by_cell(cand)
    treated = {'runs': 0, 'd5': 0, 'd6': 0, 'd8': 0, 'd9': 0, 'd10': 0}
    for n in ('pull_only', 'trigger'):
        for k in treated: treated[k] += d.get(n, {}).get(k, 0)
    out = dict(seed=seed, pulls=c.get(P + 'pulls'), firing_floor_150k=(c.get(P + 'pulls') or 0) >= 150000, restarts_with_held_crash=c.get(P + 'restarts_with_held_crash'),
               scopes_engaged=c.get(P + 'scopes_engaged'), lag_p90=c.get(P + 'lag_p90'), lag_samples=c.get(P + 'lag_samples'), steps_saved_per_pull=(c.get(P + 'steps_saved_sum') or 0) / max(1, c.get(P + 'pulls') or 1),
               cells=cells,
               within_window_ratio=cells['treated']['within_window_share'] / cells['untreated']['within_window_share'] if cells['untreated']['within_window_share'] else None,
               steps_ratio_treated=cells['treated']['steps_per_run'] / cells['untreated']['steps_per_run'] if cells['untreated']['steps_per_run'] else None,
               crashes_ratio_treated=cells['treated']['crashes_per_run'] / cells['untreated']['crashes_per_run'] if cells['untreated']['crashes_per_run'] else None,
               trigger=trig, fired_over_armed=(trig['fired'] or 0) / max(1, trig['armed'] or 1),
               trigger_vs_pull_only=dict(steps=cells['trigger']['steps_per_run'] / cells['pull_only']['steps_per_run'] if cells['pull_only']['steps_per_run'] else None,
                                         bucket_3plus=cells['trigger']['bucket_3plus_share'] / cells['pull_only']['bucket_3plus_share'] if cells['pull_only']['bucket_3plus_share'] else None,
                                         expired_over_armed=cells['trigger']['early_expired_over_armed'] / cells['pull_only']['early_expired_over_armed'] if cells['pull_only']['early_expired_over_armed'] else None),
               depth_treated_over_untreated={k: ratio(treated, d.get('untreated', {'runs': 0}), k) for k in ['d5', 'd6', 'd8', 'd9', 'd10']} if d.get('untreated') else None,
               depth_trigger_over_pull_only={k: ratio(d.get('trigger', {'runs': 0}), d.get('pull_only', {'runs': 0}), k) for k in ['d5', 'd6', 'd8', 'd9', 'd10']} if d.get('trigger') and d.get('pull_only') else None,
               depth_counts=d,
               runs=[cand['metrics']['runs'], bc['metrics']['runs']], violations=[cand['metrics']['violations'], bc['metrics']['violations']], failed=cand['session']['runsFailed'])
    return out


out = []
for bc in base['chunks']:
    p = root / f"research/lite/state/restart-pull/chunk-{bc['seed']}.cand.json"
    if p.exists():
        out.append(read(bc['seed'], json.loads(p.read_text()), bc))
print(json.dumps(out, indent=1))
