"""Plan-shape reads: supply census per cell, premise gate, artifact rule, matched 2x2 contrasts from the variants rows."""

import json
from pathlib import Path

root = Path('/home/benaepli/Rust/turnpike')
state = json.loads((root / 'research/lite/state/plan-shape.json').read_text())
base = json.loads(Path(state['cacheFile']).read_text())
SURV = 1 << 26; WTR = 1 << 29; CO = [1 << 13, 1 << 4, 1 << 28, 1 << 9, 1 << 19, 1 << 10, 1 << 12, 1 << 20, 1 << 21]
RUNGS = ['d1', 'd5', 'd8', 'd9', 'd10', 'd11', 'd12', 'd13']; IDX = {'d1': 0, 'd5': 4, 'd8': 7, 'd9': 8, 'd10': 9, 'd11': 10, 'd12': 11, 'd13': 12}


def rows(cand, pred, keyfn):
    out = {}
    for r in cand['metrics']['variants']:
        v = r['variant']
        if v & 6 or r['arm'] == 'aos' or not pred(v): continue
        k = keyfn(v); o = out.setdefault(k, {'runs': 0, 'steps': 0, **{d: 0 for d in RUNGS}})
        o['runs'] += r['runs']; o['steps'] += r['stepsUsedSum']
        for d, i in IDX.items(): o[d] += r['depthAtLeast'][i]
    return out


def matched(cand, bit, other):
    strata = lambda v: tuple((v & b) != 0 for b in CO + [other])
    on = rows(cand, lambda v: (v & bit) != 0, strata); off = rows(cand, lambda v: not (v & bit), strata)
    out = {}
    for d in RUNGS:
        num = den = 0.0; e_on = e_off = 0
        for s, o in on.items():
            f = off.get(s)
            if not f or not f['runs'] or not o['runs']: continue
            w = o['runs']; num += w * (o[d] / o['runs']); den += w * (f[d] / f['runs']); e_on += o[d]; e_off += f[d]
        out[d] = dict(ratio=(num / den) if den else None, on=e_on, off=e_off)
    ons = rows(cand, lambda v: (v & bit) != 0, lambda v: 'x').get('x', {}); offs = rows(cand, lambda v: not (v & bit), lambda v: 'x').get('x', {})
    out['steps_ratio'] = ((ons['steps'] / ons['runs']) / (offs['steps'] / offs['runs'])) if ons and offs else None
    out['conv_9_10'] = (ons['d10'] / ons['d9'] if ons.get('d9') else None, offs['d10'] / offs['d9'] if offs.get('d9') else None)
    return out


def cellcensus(c, prefix, name):
    g = lambda k: c.get(f'{prefix}.cell.{name}.{k}') or 0
    runs = g('runs')
    return {k: g(k) / max(1, runs) for k in ['post_restart_invocations_at_survivor', 'post_restart_writes_at_survivor', 'post_restart_reads_at_survivor', 'acked_writes_at_survivor_after_two_restarts', 'acked_writes_with_stranded_records', 'reads_invoked_after_such_ack', 'post_restart_writes_invoked', 'post_restart_write_acks', 'reads_invoked_after_post_restart_write_ack', 'reads_outstanding_at_survivor_state_move_post_ack']} | {'runs': runs, 'acked_with_stranded_count': g('acked_writes_with_stranded_records')}


out = []
for bc in base['chunks']:
    p = root / f"research/lite/state/plan-shape/chunk-{bc['seed']}.cand.json"
    if not p.exists(): continue
    cand = json.loads(p.read_text()); c = cand['utilStats']['counters']; g = lambda k: c.get(k) or 0
    surv = {n: cellcensus(c, 'plan_shape.survivor', n) for n in ['stock', 'survivor']}
    wtr = {n: cellcensus(c, 'plan_shape.write_read', n) for n in ['stock', 'write_then_read']}
    rec = dict(seed=bc['seed'], runs=[cand['metrics']['runs'], bc['metrics']['runs']], violations=[cand['metrics']['violations'], bc['metrics']['violations']], failed=cand['session']['runsFailed'],
               survivor_firing=dict(seen=g('plan_shape.survivor.reserved_seen'), retargeted=g('plan_shape.survivor.reserved_retargeted'), no_survivor=g('plan_shape.survivor.plans_without_survivor')),
               write_read_firing=dict(pairs=g('plan_shape.write_read.pairs_added'), last_free_write=g('plan_shape.write_read.write_fallbacks.last_free_write'), no_write=g('plan_shape.write_read.write_fallbacks.no_write_available'), read_unavailable=g('plan_shape.write_read.read_unavailable')),
               survivor_census=surv, survivor_ratios={k: (surv['survivor'][k] / surv['stock'][k]) if surv['stock'][k] else None for k in surv['stock'] if k not in ('runs', 'acked_with_stranded_count')},
               write_read_census=wtr, write_read_ratios={k: (wtr['write_then_read'][k] / wtr['stock'][k]) if wtr['stock'][k] else None for k in wtr['stock'] if k not in ('runs', 'acked_with_stranded_count')},
               survivor_matched=matched(cand, SURV, WTR), write_read_matched=matched(cand, WTR, SURV))
    out.append(rec)
print(json.dumps(out, indent=1))
