"""Restart-window firing, observable and falsifier reads from completed chunks."""

import json
from pathlib import Path

root = Path('/home/benaepli/Rust/turnpike')
state = json.loads((root / 'research/lite/state/restart-window.json').read_text())
base = json.loads(Path(state['cacheFile']).read_text())
CELLS = ['stock', 'local_drain', 'net_heavy']


def block(c):
    keys = ['runs', 'stock_preemptive_runs', 'windows_opened', 'window_steps', 'steps_group_changed',
            'closed_by_entries', 'closed_by_steps', 'restarted_local_steps']
    return {k: {cell: c.get(f'restart_window.{k}.{cell}') for cell in CELLS} for k in keys}


def gates(c):
    b = block(c)
    per_window = {cell: (b['restarted_local_steps'][cell] / b['windows_opened'][cell]) if b['windows_opened'][cell] else None for cell in CELLS}
    ratio = per_window['local_drain'] / per_window['stock'] if per_window['stock'] else None
    return dict(block=b,
                firing_window_steps_local_drain=b['window_steps']['local_drain'],
                firing_floor_2M=b['window_steps']['local_drain'] >= 2_000_000,
                steps_group_changed_local_drain=b['steps_group_changed']['local_drain'],
                changed_floor_500k=b['steps_group_changed']['local_drain'] >= 500_000,
                restarted_local_steps_per_window=per_window,
                local_drain_over_stock=ratio, observable_1_5x=(ratio is not None and ratio >= 1.5),
                closed_by_entries_share={cell: b['closed_by_entries'][cell] / (b['closed_by_entries'][cell] + b['closed_by_steps'][cell]) if (b['closed_by_entries'][cell] + b['closed_by_steps'][cell]) else None for cell in CELLS},
                window_steps_per_run={cell: b['window_steps'][cell] / b['runs'][cell] if b['runs'][cell] else None for cell in CELLS},
                stock_preemptive_share={cell: b['stock_preemptive_runs'][cell] / b['runs'][cell] if b['runs'][cell] else None for cell in CELLS})


out = []
for bc in base['chunks']:
    path = root / f"research/lite/state/restart-window/chunk-{bc['seed']}.cand.json"
    if not path.exists():
        continue
    cand = json.loads(path.read_text())
    out.append(dict(seed=bc['seed'], gates=gates(cand['utilStats']['counters']),
                    violations=[cand['metrics']['violations'], bc['metrics']['violations']],
                    runs=[cand['metrics']['runs'], bc['metrics']['runs']], failed=cand['session']['runsFailed']))
print(json.dumps(out, indent=1))
