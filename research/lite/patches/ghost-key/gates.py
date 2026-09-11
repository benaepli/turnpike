"""Three nested contrasts inside the merged release cell, read from the chunk records."""

import json
from pathlib import Path

root = Path('/home/benaepli/Rust/turnpike')
state = json.loads((root / 'research/lite/state/ghost-key.json').read_text())
base = json.loads(Path(state['cacheFile']).read_text())
P = 'crash_place.ghost_release.cells.'
BITS = {'defer': 1 << 30, 'early': 1 << 29, 'stranded': 1 << 26}
CO = [1 << 9, 1 << 19, 1 << 28]


def g(c, cell, k):
    return c.get(f'{P}{cell}.{k}') or 0


def cellread(c, cell):
    runs = g(c, cell, 'runs'); fa = g(c, cell, 'fired_crashes_applied'); btot = sum(g(c, cell, f'fired_inflight_bucket_{i}') for i in ['0', '1', '2', '3plus'])
    return dict(runs=runs, steps_per_run=g(c, cell, 'steps_used_sum') / max(1, runs), crashes_per_run=g(c, cell, 'crashes_applied') / max(1, runs),
                within3_unanchored=g(c, cell, 'fired_crashes_applied_within_3_unanchored') / max(1, g(c, cell, 'fired_crashes_applied_unanchored')),
                within3_anchored=g(c, cell, 'fired_crashes_applied_within_3_anchored') / max(1, g(c, cell, 'fired_crashes_applied_anchored')),
                within3_per_later=g(c, cell, 'applied_within_3_of_acted_ghost') / max(1, g(c, cell, 'later_crashes_applied')),
                on_ghost=g(c, cell, 'fired_crashes_on_ghost_node') / max(1, fa), bucket0=g(c, cell, 'fired_inflight_bucket_0') / max(1, btot), bucket3plus=g(c, cell, 'fired_inflight_bucket_3plus') / max(1, btot),
                fired_over_armed=g(c, cell, 'triggers_fired') / max(1, g(c, cell, 'triggers_armed')), triggers_fired=g(c, cell, 'triggers_fired'), triggers_armed=g(c, cell, 'triggers_armed'),
                exempted=g(c, cell, 'defer_coin_exempted'), examined=g(c, cell, 'defer_coin_examined'),
                overridden=g(c, cell, 'phase_overridden'), overridden_split=[g(c, cell, 'phase_overridden_stock_to_early'), g(c, cell, 'phase_overridden_mid_to_early'), g(c, cell, 'phase_overridden_early_read_on_ghost')],
                released_on_condition=g(c, cell, 'phase_released_on_condition'), phase_expired=g(c, cell, 'phase_expired'),
                stranded_fired=g(c, cell, 'stranded_fired'), stranded_first=g(c, cell, 'stranded_fired_first_entry'), stranded_skipped=g(c, cell, 'stranded_skipped_entries'))


def depth_by_key(cand, keyfn):
    out = {}
    for r in cand['metrics']['variants']:
        v = r['variant']
        if v & 6 or not (v & 1): continue
        key = keyfn(v)
        if key is None: continue
        o = out.setdefault(key, {'runs': 0, 'd5': 0, 'd6': 0, 'd8': 0, 'd9': 0, 'd10': 0})
        o['runs'] += r['runs']
        for k, i in [('d5', 4), ('d6', 5), ('d8', 7), ('d9', 8), ('d10', 9)]: o[k] += r['depthAtLeast'][i]
    return out


def matched_ratio(cand, bit):
    """Nested contrast inside the release cell: bit on vs off, matched on the co-bits and the other two session bits (stratum-weighted by the on-side runs)."""
    others = [b for b in BITS.values() if b != bit]
    strata = depth_by_key(cand, lambda v: (tuple((v & b) != 0 for b in CO + others)) if (v & 16) else None)
    on = depth_by_key(cand, lambda v: (tuple((v & b) != 0 for b in CO + others)) if (v & 16) and (v & bit) else None)
    off = depth_by_key(cand, lambda v: (tuple((v & b) != 0 for b in CO + others)) if (v & 16) and not (v & bit) else None)
    out = {}
    for k in ['d5', 'd6', 'd8', 'd9', 'd10']:
        num = 0.0; den = 0.0; n_on = 0; n_off = 0; e_on = 0; e_off = 0
        for s, o in on.items():
            f = off.get(s)
            if not f or not f['runs'] or not o['runs'] or not f[k]: continue
            w = o['runs']; num += w * (o[k] / o['runs']); den += w * (f[k] / f['runs']); n_on += o['runs']; n_off += f['runs']; e_on += o[k]; e_off += f[k]
        out[k] = dict(ratio=(num / den) if den else None, on_events=e_on, off_events=e_off, on_runs=n_on, off_runs=n_off)
    return out


def treated_over_untreated(cand, bit):
    on = depth_by_key(cand, lambda v: 'on' if (v & 16) and (v & bit) else None).get('on')
    un = depth_by_key(cand, lambda v: 'un' if not (v & 16) else None).get('un')
    return {k: ((on[k] / on['runs']) / (un[k] / un['runs'])) if on and un and un[k] else None for k in ['d5', 'd6', 'd8', 'd9', 'd10']}


out = []
for bc in base['chunks']:
    p = root / f"research/lite/state/ghost-key/chunk-{bc['seed']}.cand.json"
    if not p.exists(): continue
    cand = json.loads(p.read_text()); c = cand['utilStats']['counters']
    rec = dict(seed=bc['seed'], runs=[cand['metrics']['runs'], bc['metrics']['runs']], violations=[cand['metrics']['violations'], bc['metrics']['violations']], failed=cand['session']['runsFailed'],
               parent=dict(armed=c.get('crash_place.ghost_release.armed'), fired=c.get('crash_place.ghost_release.fired'), lag=[c.get('crash_place.ghost_release.lag_p50'), c.get('crash_place.ghost_release.lag_p75'), c.get('crash_place.ghost_release.lag_p90')]),
               cells={n: cellread(c, n) for n in ['untreated', 'release_all', 'single', 'defer_on', 'defer_off', 'early_on', 'early_off', 'stranded_on', 'stranded_off']})
    for name, bit in BITS.items():
        rec[name] = dict(nested=matched_ratio(cand, bit), treated_over_untreated=treated_over_untreated(cand, bit))
    out.append(rec)
print(json.dumps(out, indent=1))
