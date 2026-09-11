"""Stall-release firing and clause reads from completed chunks."""

import json
from pathlib import Path

root = Path('/home/benaepli/Rust/turnpike')
state = json.loads((root / 'research/lite/state/stall-release.json').read_text())
base = json.loads(Path(state['cacheFile']).read_text())


def read(seed, cand, bc):
    c = cand['utilStats']['counters']; b = bc['utilStats']['counters']
    sr = {k[len('stall_release.'):]: v for k, v in c.items() if k.startswith('stall_release.')}
    rel = sr.get('release_cell.runs') or 0; cut = sr.get('cut_cell.runs') or 0
    out = dict(seed=seed, stall_release=sr,
               firing_releases=sr.get('releases'), firing_floor_60k=(sr.get('releases') or 0) >= 60000,
               fault_dependents=sr.get('dependents_released.fault'), fault_floor_10k=(sr.get('dependents_released.fault') or 0) >= 10000,
               late_response_share=(sr.get('late_responses') or 0) / max(1, sr.get('ops_settled') or 1),
               invocations_per_run=dict(release=(sr.get('release_cell.invocations') or 0) / max(1, rel), cut=(sr.get('cut_cell.invocations') or 0) / max(1, cut)),
               plan_complete_share=dict(release=(sr.get('release_cell.plan_complete') or 0) / max(1, rel), cut=(sr.get('cut_cell.plan_complete') or 0) / max(1, cut)),
               stall_cap=dict(stops=c.get('stall_cap.stops'), base_stops=b.get('stall_cap.stops'), cap=c.get('stall_cap.cap_max_scope')),
               termination=dict(cand={k: c.get('termination.all.' + k) for k in ['plan_complete', 'learned_cap_reached', 'iterations_exhausted', 'stall_cap_reached', 'runs']},
                                base={k: b.get('termination.all.' + k) for k in ['plan_complete', 'learned_cap_reached', 'iterations_exhausted', 'stall_cap_reached', 'runs']}),
               runs=[cand['metrics']['runs'], bc['metrics']['runs']], violations=[cand['metrics']['violations'], bc['metrics']['violations']], failed=cand['session']['runsFailed'])
    out['invocations_ratio'] = out['invocations_per_run']['release'] / out['invocations_per_run']['cut'] if out['invocations_per_run']['cut'] else None
    out['plan_complete_ratio'] = out['plan_complete_share']['release'] / out['plan_complete_share']['cut'] if out['plan_complete_share']['cut'] else None
    out['clauses'] = dict(late_le_3pct=out['late_response_share'] <= 0.03, late_close_gt_10pct=out['late_response_share'] > 0.10,
                          invocations_ge_1_5=(out['invocations_ratio'] or 0) >= 1.5, plan_complete_ge_0_35=(out['plan_complete_ratio'] or 0) >= 0.35, plan_complete_close_lt_0_30=(out['plan_complete_ratio'] or 0) < 0.30)
    per_arm = {}
    for r in cand['metrics']['variants']:
        if r['variant'] & 6 or not (r['variant'] & 1024): continue
        cell = 'release' if r['variant'] & 4096 else 'cut'
        o = per_arm.setdefault(r['arm'], {}).setdefault(cell, {'runs': 0, 'steps': 0, 'd8': 0, 'd6': 0})
        o['runs'] += r['runs']; o['steps'] += r['stepsUsedSum']; o['d8'] += r['depthAtLeast'][7]; o['d6'] += r['depthAtLeast'][5]
    out['release_over_cut_by_arm'] = {a: dict(steps=(v['release']['steps'] / v['release']['runs']) / (v['cut']['steps'] / v['cut']['runs']), d8=((v['release']['d8'] / v['release']['runs']) / (v['cut']['d8'] / v['cut']['runs'])) if v['cut']['d8'] else None) for a, v in per_arm.items() if 'release' in v and 'cut' in v and v['cut']['runs'] and v['release']['runs']}
    return out


out = []
for bc in base['chunks']:
    p = root / f"research/lite/state/stall-release/chunk-{bc['seed']}.cand.json"
    if p.exists():
        out.append(read(bc['seed'], json.loads(p.read_text()), bc))
print(json.dumps(out, indent=1))
