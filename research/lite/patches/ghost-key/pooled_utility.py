"""Summarize fixed populations from completed paired lite chunks."""

import json
from pathlib import Path

root = Path('/home/benaepli/Rust/turnpike')
state = json.loads((root / 'research/lite/state/ghost-key.json').read_text())
base = json.loads(Path(state['cacheFile']).read_text())
pairs = []
for b in base['chunks']:
    path = root / f"research/lite/state/ghost-key/chunk-{b['seed']}.cand.json"
    if path.exists():
        pairs.append((b['seed'], b['metrics'], json.loads(path.read_text())['metrics']))


def population(metrics, ids):
    rows = [a for m in metrics for a in m['campaign']['arms'] if a['id'] in ids]
    return dict(runs=sum(a['gradedRuns'] for a in rows),
                d8=sum(a['depthAtLeast'][7] for a in rows),
                d6=sum(a['depthAtLeast'][5] for a in rows),
                d11=sum(a['depthAtLeast'][10] for a in rows),
                seconds=sum(a['wallMs'] for a in rows) / 1000)


def compare(pairs, ids):
    b = population([p[1] for p in pairs], ids)
    c = population([p[2] for p in pairs], ids)
    return dict(base=b, candidate=c,
                per_run_ratio=(c['d8'] / c['runs']) / (b['d8'] / b['runs']),
                d6_per_run_ratio=(c['d6'] / c['runs']) / (b['d6'] / b['runs']),
                per_second_ratio=(c['d8'] / c['seconds']) / (b['d8'] / b['seconds']),
                throughput_ratio=(c['runs'] / c['seconds']) / (b['runs'] / b['seconds']))


ids = ['grid', 'grid-short', 'grid-no-purgatory', 'grid-post-fault-2', 'aos']
groups = {name: [name] for name in ids}
groups.update(four_grid=ids[:4], campaign=ids)
result = dict(seeds=[p[0] for p in pairs],
              pooled={name: compare(pairs, members) for name, members in groups.items()},
              chunks=[dict(seed=p[0], populations={name: compare([p], members)
                      for name, members in groups.items()}) for p in pairs],
              note='Per-second figures use recorded arm exposures. Fixed populations and count denominators; no independent-run uncertainty claim.')
print(json.dumps(result, indent=2))
