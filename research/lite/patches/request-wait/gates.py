"""Request-wait and shelter gates from completed chunks, with contrasts matched on the other bit."""

import json
from pathlib import Path

root = Path('/home/benaepli/Rust/turnpike')
state = json.loads((root / 'research/lite/state/request-wait.json').read_text())
base = json.loads(Path(state['cacheFile']).read_text())
WAIT = 1 << 29; SHELTER = 1 << 26; CO = [1 << 4, 1 << 28, 1 << 9, 1 << 19, 1 << 13, 1 << 10, 1 << 12]


def depth_by_key(cand, keyfn):
    out = {}
    for r in cand['metrics']['variants']:
        v = r['variant']
        if v & 6: continue
        key = keyfn(v)
        if key is None: continue
        o = out.setdefault(key, {'runs': 0, 'd5': 0, 'd6': 0, 'd8': 0, 'd9': 0, 'd10': 0, 'd11': 0, 'd12': 0})
        o['runs'] += r['runs']
        for k, i in [('d5', 4), ('d6', 5), ('d8', 7), ('d9', 8), ('d10', 9), ('d11', 10), ('d12', 11)]: o[k] += r['depthAtLeast'][i]
    return out


def matched(cand, bit, other):
    on = depth_by_key(cand, lambda v: tuple((v & b) != 0 for b in CO + [other]) if (v & bit) else None)
    off = depth_by_key(cand, lambda v: tuple((v & b) != 0 for b in CO + [other]) if not (v & bit) else None)
    out = {}
    for k in ['d5', 'd6', 'd8', 'd9', 'd10', 'd11', 'd12']:
        num = den = 0.0; e_on = e_off = 0
        for s, o in on.items():
            f = off.get(s)
            if not f or not f['runs'] or not o['runs'] or not f[k]: continue
            w = o['runs']; num += w * (o[k] / o['runs']); den += w * (f[k] / f['runs']); e_on += o[k]; e_off += f[k]
        out[k] = dict(ratio=(num / den) if den else None, on=e_on, off=e_off)
    return out


out = []
for bc in base['chunks']:
    p = root / f"research/lite/state/request-wait/chunk-{bc['seed']}.cand.json"
    if not p.exists(): continue
    cand = json.loads(p.read_text()); c = cand['utilStats']['counters']
    g = lambda k: c.get(k) or 0
    rw = dict(masked_offers=g('request_wait.masked_offers'), records_masked=g('request_wait.records_masked'), arrivals_after_bound=g('request_wait.arrivals_after_bound'),
              applicability=g('request_wait.records_masked') / max(1, g('request_wait.records_masked') + g('request_wait.arrivals_after_bound')),
              released_settled=g('request_wait.released_settled'), released_bound=g('request_wait.released_bound'), released_lifted=g('request_wait.released_lifted'),
              lifted_share=g('request_wait.released_lifted') / max(1, g('request_wait.masked_offers')),
              acted_ratio_treated=g('request_wait.cells.treated.request_entries_at_restarted_acted') / max(1, g('request_wait.cells.treated.request_entries_at_restarted')),
              acted_ratio_untreated=g('request_wait.cells.untreated.request_entries_at_restarted_acted') / max(1, g('request_wait.cells.untreated.request_entries_at_restarted')))
    rw['acted_ratio'] = rw['acted_ratio_treated'] / rw['acted_ratio_untreated'] if rw['acted_ratio_untreated'] else None
    rel = g('shelter.released_on_response') + g('shelter.released_on_expiry') + g('shelter.released_dry')
    sh = dict(ops_examined=g('shelter.ops_examined'), ops_sheltered=g('shelter.ops_sheltered'), records_ghost=g('shelter.records_ghost'), records_settled_fresh=g('shelter.records_settled_fresh'),
              released_on_response=g('shelter.released_on_response'), released_on_expiry=g('shelter.released_on_expiry'), released_dry=g('shelter.released_dry'),
              response_share_of_releases=g('shelter.released_on_response') / max(1, rel), expiry_share_of_releases=g('shelter.released_on_expiry') / max(1, rel),
              response_per_op=g('shelter.released_on_response') / max(1, g('shelter.ops_sheltered')), expiry_per_op=g('shelter.released_on_expiry') / max(1, g('shelter.ops_sheltered')),
              hazards=dict(ghost=g('shelter.hazards.ops_with_ghost'), fresh=g('shelter.hazards.ops_with_settled_fresh'), both=g('shelter.hazards.ops_with_both')),
              stall_clock_steps_not_suspended=g('shelter.stall_clock_steps_not_suspended'),
              sender_restarted_acted_treated=g('shelter.cells.treated.sender_restarted_acted') / max(1, g('shelter.cells.treated.sender_restarted_entries')),
              sender_restarted_acted_untreated=g('shelter.cells.untreated.sender_restarted_acted') / max(1, g('shelter.cells.untreated.sender_restarted_entries')))
    steps = {}
    for name, bit, other in [('wait', WAIT, SHELTER), ('shelter', SHELTER, WAIT)]:
        on = depth_by_key(cand, lambda v: 'x' if (v & bit) else None).get('x', {}); off = depth_by_key(cand, lambda v: 'x' if not (v & bit) else None).get('x', {})
    per = {}
    for r in cand['metrics']['variants']:
        v = r['variant']
        if v & 6: continue
        for name, bit in [('wait', WAIT), ('shelter', SHELTER)]:
            o = per.setdefault(name, {}).setdefault('on' if v & bit else 'off', {'runs': 0, 'steps': 0}); o['runs'] += r['runs']; o['steps'] += r['stepsUsedSum']
    steps = {n: (v['on']['steps'] / v['on']['runs']) / (v['off']['steps'] / v['off']['runs']) for n, v in per.items() if v.get('on', {}).get('runs') and v.get('off', {}).get('runs')}
    out.append(dict(seed=bc['seed'], runs=[cand['metrics']['runs'], bc['metrics']['runs']], violations=[cand['metrics']['violations'], bc['metrics']['violations']], failed=cand['session']['runsFailed'],
                    request_wait=rw, shelter=sh, steps_ratio=steps,
                    wait_matched={k: (round(v['ratio'], 4) if v['ratio'] else None, v['on'], v['off']) for k, v in matched(cand, WAIT, SHELTER).items()},
                    shelter_matched={k: (round(v['ratio'], 4) if v['ratio'] else None, v['on'], v['off']) for k, v in matched(cand, SHELTER, WAIT).items()}))
print(json.dumps(out, indent=1))
