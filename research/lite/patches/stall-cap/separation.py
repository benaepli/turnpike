"""Separation gate: share of untreated runs at each depth rung whose longest quiet gap exceeds the standing stall cap."""

import json, csv, sys
G = sys.argv[1]
grade = json.load(open(G + '.grade.json'))
dags = grade.get('grade_dags') or grade.get('dags') or []
depths = {}
for dag in dags:
    for rid, d in dag.get('run_depths', []):
        depths[int(rid)] = int(d)
runs = json.load(open(G + '.runs.json'))
rows = runs if isinstance(runs, list) else runs.get('runs') or runs.get('rows')
variant = {int(r['run_id']): int(r['variant']) for r in rows}
gap = {}
with open(G + '/stall_cap_runs.csv') as f:
    for r in csv.DictReader(f):
        gap[int(r['run_id'])] = (int(r['longest_quiet_gap']), r['stall_cap_standing'])
out = dict(graded_runs=len(depths), untreated_rows=len(gap), joined=0)
by_rung = {}
for rid, (g, cap) in gap.items():
    v = variant.get(rid)
    if v is None or (v & 6) or (v & 1024):
        continue
    d = depths.get(rid)
    if d is None:
        continue
    out['joined'] += 1
    capv = int(cap) if cap not in ('', 'none', 'None') else None
    over = capv is not None and g > capv
    for rung in (4, 6, 8, 10):
        if d >= rung:
            o = by_rung.setdefault(rung, dict(runs=0, over_cap=0, capped=0))
            o['runs'] += 1
            if capv is not None:
                o['capped'] += 1
                o['over_cap'] += over
for rung, o in sorted(by_rung.items()):
    o['share_over_cap'] = o['over_cap'] / o['capped'] if o['capped'] else None
out['by_rung'] = by_rung
out['gate'] = dict(depth8_share=by_rung.get(8, {}).get('share_over_cap'), depth6_share=by_rung.get(6, {}).get('share_over_cap'),
                   passes_0_05=all((by_rung.get(r, {}).get('share_over_cap') or 0) <= 0.05 for r in (6, 8)),
                   closes_0_10=any((by_rung.get(r, {}).get('share_over_cap') or 0) > 0.10 for r in (6, 8)))
print(json.dumps(out, indent=1))
