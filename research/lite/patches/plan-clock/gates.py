"""Plan-clock firing, inertness and clause reads from completed chunks."""

import json
from pathlib import Path

root = Path('/home/benaepli/Rust/turnpike')
state = json.loads((root / 'research/lite/state/plan-clock.json').read_text())
base = json.loads(Path(state['cacheFile']).read_text())


def read(seed, cand, bc):
    c = cand['utilStats']['counters']; b = bc['utilStats']['counters']
    pc = {k[len('stall_cap.plan_clock.'):]: v for k, v in c.items() if k.startswith('stall_cap.plan_clock.')}
    plan_cap = c.get('stall_cap.plan_clock.cap_max_scope'); run_cap = c.get('run_cap.current_cap_max_scope')
    enders_c = (c.get('termination.all.learned_cap_reached') or 0) + (c.get('termination.all.iterations_exhausted') or 0)
    enders_b = (b.get('termination.all.learned_cap_reached') or 0) + (b.get('termination.all.iterations_exhausted') or 0)
    out = dict(seed=seed, plan_clock=pc,
               firing_stops=pc.get('stops'), firing_floor_60k=(pc.get('stops') or 0) >= 60000,
               plan_cap=plan_cap, run_cap=run_cap, plan_over_run_cap=(plan_cap / run_cap) if plan_cap and run_cap else None,
               inert_ge_0_9=(plan_cap / run_cap >= 0.9) if plan_cap and run_cap else None, clause_lt_0_8=(plan_cap / run_cap < 0.8) if plan_cap and run_cap else None,
               probe_over_cap_share=(pc.get('probe_over_cap_completions') or 0) / max(1, pc.get('probes_keyed') or 1),
               budget_enders=[enders_c, enders_b], budget_enders_ratio=enders_c / enders_b if enders_b else None,
               fine_stops=[c.get('stall_cap.stops'), b.get('stall_cap.stops')], fine_cap=[c.get('stall_cap.cap_max_scope'), b.get('stall_cap.cap_max_scope')],
               termination=dict(cand={k: c.get('termination.all.' + k) for k in ['plan_complete', 'learned_cap_reached', 'iterations_exhausted', 'stall_cap_reached', 'runs']},
                                base={k: b.get('termination.all.' + k) for k in ['plan_complete', 'learned_cap_reached', 'iterations_exhausted', 'stall_cap_reached', 'runs']}),
               runs=[cand['metrics']['runs'], bc['metrics']['runs']], violations=[cand['metrics']['violations'], bc['metrics']['violations']], failed=cand['session']['runsFailed'])
    cells = {}
    for cell in ['release_plan_clock', 'release_no_plan_clock', 'cut_plan_clock', 'cut_no_plan_clock']:
        r = pc.get(f'{cell}.runs') or 0
        cells[cell] = dict(runs=r, steps_per_run=(pc.get(f'{cell}.steps_used_sum') or 0) / max(1, r), plan_complete_share=(pc.get(f'{cell}.plan_complete') or 0) / max(1, r))
    out['cells'] = cells
    per_arm = {}
    for r in cand['metrics']['variants']:
        if r['variant'] & 6 or not (r['variant'] & 1024): continue
        cell = 'treated' if r['variant'] & 268435456 else 'untreated'
        o = per_arm.setdefault(r['arm'], {}).setdefault(cell, {'runs': 0, 'steps': 0, 'd8': 0, 'd10': 0})
        o['runs'] += r['runs']; o['steps'] += r['stepsUsedSum']; o['d8'] += r['depthAtLeast'][7]; o['d10'] += r['depthAtLeast'][9]
    out['treated_over_untreated_by_arm'] = {a: dict(steps=(v['treated']['steps'] / v['treated']['runs']) / (v['untreated']['steps'] / v['untreated']['runs']), d8=((v['treated']['d8'] / v['treated']['runs']) / (v['untreated']['d8'] / v['untreated']['runs'])) if v['untreated']['d8'] else None, d10=((v['treated']['d10'] / v['treated']['runs']) / (v['untreated']['d10'] / v['untreated']['runs'])) if v['untreated']['d10'] else None) for a, v in per_arm.items() if 'treated' in v and 'untreated' in v and v['untreated']['runs'] and v['treated']['runs']}
    return out


out = []
for bc in base['chunks']:
    p = root / f"research/lite/state/plan-clock/chunk-{bc['seed']}.cand.json"
    if p.exists():
        out.append(read(bc['seed'], json.loads(p.read_text()), bc))
print(json.dumps(out, indent=1))
