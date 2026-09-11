"""Write-ring reads: applicability, fidelity, stratified contrasts (write slots vs plan-only control), uniform cell reads."""

import json
from pathlib import Path

root = Path('/home/benaepli/Rust/turnpike')
state = json.loads((root / 'research/lite/state/write-ring.json').read_text())
base = json.loads(Path(state['cacheFile']).read_text())
WRITE = 1 << 26; UNIFORM = 1 << 29; SLOT = 1 << 20; PREFIX = 1 << 21
# inherited mechanism bits used as strata (crashPlaced, crashHoldDrawn, crashPhase, ghostAbsorberRetarget, freshFirstPair, pairSendOrder, clientFanoutRelease, stallCap, stallRelease, recoverDeps, ghostRelease, single)
STRATA = [1, 8, 1 << 9, 1 << 19, 1 << 24, 1 << 15, 1 << 18, 1 << 10, 1 << 12, 1 << 13, 1 << 4, 1 << 28]
RUNGS = ['d5', 'd8', 'd9', 'd10', 'd11', 'd12', 'd13']
IDX = {'d5': 4, 'd8': 7, 'd9': 8, 'd10': 9, 'd11': 10, 'd12': 11, 'd13': 12}


def rows(cand, pred, keyfn):
    out = {}
    for r in cand['metrics']['variants']:
        v = r['variant']
        if v & 6 or r['arm'] == 'aos' or not pred(v): continue
        k = keyfn(v); o = out.setdefault(k, {'runs': 0, 'steps': 0, **{d: 0 for d in RUNGS}})
        o['runs'] += r['runs']; o['steps'] += r['stepsUsedSum']
        for d, i in IDX.items(): o[d] += r['depthAtLeast'][i]
    return out


def stratified(cand, on_pred, off_pred):
    on = rows(cand, on_pred, lambda v: tuple((v & b) != 0 for b in STRATA)); off = rows(cand, off_pred, lambda v: tuple((v & b) != 0 for b in STRATA))
    out = {}
    for d in RUNGS:
        num = den = 0.0; e_on = e_off = 0; r_on = r_off = 0
        for s, o in on.items():
            f = off.get(s)
            if not f or not f['runs'] or not o['runs']: continue
            w = o['runs']; num += w * (o[d] / o['runs']); den += w * (f[d] / f['runs']); e_on += o[d]; e_off += f[d]; r_on += o['runs']; r_off += f['runs']
        out[d] = dict(ratio=(num / den) if den else None, on=e_on, off=e_off, on_runs=r_on, off_runs=r_off)
    return out


def plain(cand, on_pred, off_pred):
    on = rows(cand, on_pred, lambda v: 'x').get('x', {}); off = rows(cand, off_pred, lambda v: 'x').get('x', {})
    return {d: dict(ratio=((on[d] / on['runs']) / (off[d] / off['runs'])) if on and off and off.get(d) and on.get('runs') else None, on=on.get(d), off=off.get(d)) for d in RUNGS} | {'steps_ratio': ((on['steps'] / on['runs']) / (off['steps'] / off['runs'])) if on and off and on.get('runs') and off.get('runs') else None, 'runs': (on.get('runs'), off.get('runs'))}


out = []
for bc in base['chunks']:
    p = root / f"research/lite/state/write-ring/chunk-{bc['seed']}.cand.json"
    if not p.exists(): continue
    cand = json.loads(p.read_text()); c = cand['utilStats']['counters']; g = lambda k: c.get(k) or 0
    wr = {k[len('replay.write_ring.'):]: v for k, v in c.items() if k.startswith('replay.write_ring.')}
    fresh_grid = (g('termination.all.runs') or 0) - (g('replay.children') or 0) - sum(a['runs'] for a in cand['metrics']['campaign']['arms'] if a['id'] == 'aos')
    plan_only = lambda v: (v & SLOT) and not (v & PREFIX)
    rec = dict(seed=bc['seed'], runs=[cand['metrics']['runs'], bc['metrics']['runs']], violations=[cand['metrics']['violations'], bc['metrics']['violations']], failed=cand['session']['runsFailed'],
               write_ring={k: v for k, v in wr.items() if not k.startswith('uniform')},
               applicability=g('replay.write_ring.signal_runs') / max(1, fresh_grid), fresh_grid=fresh_grid,
               fidelity=g('replay.write_ring.prefix_faithful') / max(1, g('replay.write_ring.children')),
               cut_step_mean=g('replay.write_ring.cut_step_sum') / max(1, g('replay.write_ring.parents_admitted')),
               child_steps_ratio=(g('replay.write_ring.child_steps_sum') / max(1, g('replay.write_ring.children'))) / max(1e-9, g('replay.write_ring.control_plan_only_steps_sum') / max(1, g('replay.write_ring.control.runs'))),
               plan_complete=dict(write=g('replay.write_ring.write.plan_complete') / max(1, g('replay.write_ring.write.runs')), control=g('replay.write_ring.control.plan_complete') / max(1, g('replay.write_ring.control.runs'))),
               uniform=dict(switched=g('replay.write_ring.uniform.switched'), not_switched=g('replay.write_ring.uniform.not_switched'),
                            stale_first_uniform=g('replay.write_ring.uniform.first_post_cut_delivery_at_target.uniform.stale') / max(1, g('replay.write_ring.uniform.first_post_cut_delivery_at_target.uniform.total')),
                            stale_first_tournament=g('replay.write_ring.uniform.first_post_cut_delivery_at_target.tournament.stale') / max(1, g('replay.write_ring.uniform.first_post_cut_delivery_at_target.tournament.total'))),
               ring_stratified=stratified(cand, lambda v: plan_only(v) and (v & WRITE), lambda v: plan_only(v) and not (v & WRITE)),
               ring_plain=plain(cand, lambda v: plan_only(v) and (v & WRITE), lambda v: plan_only(v) and not (v & WRITE)),
               uniform_stratified=stratified(cand, lambda v: (v & WRITE) and (v & UNIFORM), lambda v: (v & WRITE) and not (v & UNIFORM)),
               uniform_plain=plain(cand, lambda v: (v & WRITE) and (v & UNIFORM), lambda v: (v & WRITE) and not (v & UNIFORM)),
               write_vs_fresh=plain(cand, lambda v: plan_only(v) and (v & WRITE), lambda v: not (v & SLOT)))
    out.append(rec)
print(json.dumps(out, indent=1))
