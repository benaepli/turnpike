"""Stall-cap firing, cost and separation reads from completed chunks."""

import json, sys, csv, math
from pathlib import Path

root = Path('/home/benaepli/Rust/turnpike')
state = json.loads((root / 'research/lite/state/stall-cap.json').read_text())
base = json.loads(Path(state['cacheFile']).read_text())


def block(c, prefix):
    return {k[len(prefix):]: v for k, v in c.items() if k.startswith(prefix)}


def read(seed, cand, bc):
    cc = cand['utilStats']['counters']; bcnt = bc['utilStats']['counters']
    sc = block(cc, 'stall_cap.')
    out = dict(seed=seed, stall_cap=sc,
               firing_stops=cc.get('stall_cap.stops'), firing_floor_120k=(cc.get('stall_cap.stops') or 0) >= 120000,
               cap_max_scope=cc.get('stall_cap.cap_max_scope'), cap_band_450_900=(450 <= (cc.get('stall_cap.cap_max_scope') or 0) <= 900),
               probe_over_cap_share=(cc.get('stall_cap.probe_over_cap_completions') or 0) / max(1, cc.get('run_cap.probe_completions') or 1),
               learned_cap_reached=[cc.get('termination.all.learned_cap_reached'), bcnt.get('termination.all.learned_cap_reached')],
               stall_cap_reached=cc.get('termination.all.stall_cap_reached'),
               plan_complete=[cc.get('termination.all.plan_complete'), bcnt.get('termination.all.plan_complete')],
               iterations_exhausted=[cc.get('termination.all.iterations_exhausted'), bcnt.get('termination.all.iterations_exhausted')],
               runs=[cand['metrics']['runs'], bc['metrics']['runs']], violations=[cand['metrics']['violations'], bc['metrics']['violations']],
               failed=cand['session']['runsFailed'])
    out['learned_cap_drop'] = 1 - out['learned_cap_reached'][0] / out['learned_cap_reached'][1] if out['learned_cap_reached'][1] else None
    out['plan_complete_ratio'] = out['plan_complete'][0] / out['plan_complete'][1] if out['plan_complete'][1] else None
    # treated vs untreated steps per run by arm from the variants rows
    per_arm = {}
    for r in cand['metrics']['variants']:
        if r['variant'] & 6: continue
        cell = 'treated' if r['variant'] & 1024 else 'untreated'
        o = per_arm.setdefault(r['arm'], {}).setdefault(cell, {'runs': 0, 'steps': 0, 'wall': 0, 'd8': 0})
        o['runs'] += r['runs']; o['steps'] += r['stepsUsedSum']; o['wall'] += r['wallUsSum']; o['d8'] += r['depthAtLeast'][7]
    out['steps_per_run_ratio_by_arm'] = {a: (v['treated']['steps'] / v['treated']['runs']) / (v['untreated']['steps'] / v['untreated']['runs']) if 'treated' in v and 'untreated' in v and v['untreated']['runs'] and v['treated']['runs'] else None for a, v in per_arm.items()}
    out['wall_per_run_ratio_by_arm'] = {a: (v['treated']['wall'] / v['treated']['runs']) / (v['untreated']['wall'] / v['untreated']['runs']) if 'treated' in v and 'untreated' in v and v['untreated']['runs'] and v['treated']['runs'] else None for a, v in per_arm.items()}
    out['d8_per_run_ratio_by_arm'] = {a: (v['treated']['d8'] / v['treated']['runs']) / (v['untreated']['d8'] / v['untreated']['runs']) if 'treated' in v and 'untreated' in v and v['untreated']['d8'] and v['treated']['runs'] else None for a, v in per_arm.items()}
    # untreated per-step wall against the baseline (cost clause)
    bu = {}
    for r in bc['metrics']['variants']:
        if r['variant'] & 6: continue
        o = bu.setdefault(r['arm'], {'steps': 0, 'wall': 0}); o['steps'] += r['stepsUsedSum']; o['wall'] += r['wallUsSum']
    out['untreated_wall_per_step_vs_baseline'] = {a: ((v['untreated']['wall'] / v['untreated']['steps']) / (bu[a]['wall'] / bu[a]['steps'])) if a in bu and 'untreated' in v and v['untreated']['steps'] and bu[a]['steps'] else None for a, v in per_arm.items()}
    return out


out = []
for bc in base['chunks']:
    path = root / f"research/lite/state/stall-cap/chunk-{bc['seed']}.cand.json"
    if path.exists():
        out.append(read(bc['seed'], json.loads(path.read_text()), bc))
print(json.dumps(out, indent=1))
