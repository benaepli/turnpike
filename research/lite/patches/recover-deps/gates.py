"""Plan-dependency firing, per-cell stall shares and leak check from completed chunks."""

import json
from pathlib import Path

root = Path('/home/benaepli/Rust/turnpike')
state = json.loads((root / 'research/lite/state/recover-deps.json').read_text())
base = json.loads(Path(state['cacheFile']).read_text())
CELLS = ['stock', 'exempt', 'forced']
DENS = ['density_zero', 'density_positive']
FIELDS = ['runs', 'crashes', 'unrecovered_crashes', 'zero_recovery_runs', 'plan_complete', 'steps_used_sum']


def block(c):
    return {cell: {d: {f: c.get(f'plan_deps.{cell}.{d}.{f}') for f in FIELDS} for d in DENS} for cell in CELLS}


def share(x, num, den):
    return (x[num] / x[den]) if x[den] else None


def gates(c):
    b = block(c)
    unrec = {cell: {d: share(b[cell][d], 'unrecovered_crashes', 'crashes') for d in DENS} for cell in CELLS}
    zero = {cell: {d: share(b[cell][d], 'zero_recovery_runs', 'runs') for d in DENS} for cell in CELLS}
    complete = {cell: {d: share(b[cell][d], 'plan_complete', 'runs') for d in DENS} for cell in CELLS}
    steps = {cell: {d: share(b[cell][d], 'steps_used_sum', 'runs') for d in DENS} for cell in CELLS}
    pos = 'density_positive'
    def ratio(a, s):
        return (a / s) if (a is not None and s) else None
    out = dict(
        block=b,
        firing_dropped=c['plan_deps.recover_edges_dropped'], firing_floor_60k=c['plan_deps.recover_edges_dropped'] >= 60000,
        forced_edges=c['plan_deps.recover_edges_forced'], forced_floor_30k=c['plan_deps.recover_edges_forced'] >= 30000,
        unrecovered_share=unrec, zero_recovery_share=zero, plan_complete_share=complete, steps_per_run=steps,
        exempt_over_stock_unrec_pos=ratio(unrec['exempt'][pos], unrec['stock'][pos]),
        forced_over_stock_unrec_pos=ratio(unrec['forced'][pos], unrec['stock'][pos]),
        exempt_over_stock_zero_pos=ratio(zero['exempt'][pos], zero['stock'][pos]),
        density_zero_leak=dict(exempt_unrec=unrec['exempt']['density_zero'], stock_unrec=unrec['stock']['density_zero'],
                               exempt_complete=complete['exempt']['density_zero'], stock_complete=complete['stock']['density_zero']),
        exempt_steps_over_stock={d: ratio(steps['exempt'][d], steps['stock'][d]) for d in DENS},
    )
    out['clauses'] = dict(
        exempt_unrec_le_0_75x=(out['exempt_over_stock_unrec_pos'] is not None and out['exempt_over_stock_unrec_pos'] <= 0.75),
        forced_unrec_ge_1_15x=(out['forced_over_stock_unrec_pos'] is not None and out['forced_over_stock_unrec_pos'] >= 1.15),
        exempt_zero_le_0_70x=(out['exempt_over_stock_zero_pos'] is not None and out['exempt_over_stock_zero_pos'] <= 0.70),
    )
    return out


out = []
for bc in base['chunks']:
    path = root / f"research/lite/state/recover-deps/chunk-{bc['seed']}.cand.json"
    if not path.exists():
        continue
    cand = json.loads(path.read_text())
    cc = cand['utilStats']['counters']; bcnt = bc['utilStats']['counters']
    grid_complete = None
    out.append(dict(seed=bc['seed'], gates=gates(cc),
                    baseline_pooled=dict(unrecovered_share=bcnt['crash_recovery.recovers'] / bcnt['crash_recovery.crashes'] if bcnt.get('crash_recovery.crashes') else None),
                    violations=[cand['metrics']['violations'], bc['metrics']['violations']],
                    runs=[cand['metrics']['runs'], bc['metrics']['runs']], failed=cand['session']['runsFailed']))
print(json.dumps(out, indent=1))
