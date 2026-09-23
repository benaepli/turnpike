"""table.py SUMMARY_DIR: the reach readings from `reach` summaries, per
spec and arm: runs, wall, confirmed violations per wall-hour, candidates
left unconfirmed by reason, and the symbolic costs."""
import collections, json, os, sys

d = sys.argv[1]
arms = collections.defaultdict(lambda: collections.Counter())
checks = collections.defaultdict(lambda: collections.Counter())
for name in sorted(os.listdir(d)):
    if not name.endswith('.json'):
        continue
    spec, arm, _seed = name[:-5].rsplit('-', 2)
    s = json.load(open(os.path.join(d, name)))
    a = arms[(spec, arm)]
    a['chunks'] += 1
    a['runs'] += s.get('runs', 0)
    a['wall_ms'] += s.get('wall_ms', 0)
    a['run_wall_us'] += s.get('run_wall_us', 0)
    a['conceded_runs'] += s.get('conceded_runs', 0)
    a['runs_with_flip'] += s.get('runs_with_flip', 0)
    a['failed'] += s.get('runs_failed', 0)
    for k, v in s.get('time', {}).items():
        a['t_' + k] += v
    for k, v in s.get('checks', {}).items():
        checks[(spec, arm)][k.strip()] += v

for (spec, arm), a in sorted(arms.items()):
    c = checks[(spec, arm)]
    hours = a['wall_ms'] / 3.6e6
    confirmed = c.get('illegal', 0) + c.get('illegal confirmed_by_replay', 0)
    unconfirmed = sum(v for k, v in c.items() if k.startswith('unknown candidate_unconfirmed'))
    print(f"{spec} {arm}: chunks {a['chunks']} runs {a['runs']} wall {a['wall_ms']/1000:.0f}s "
          f"runs/s {a['runs']*1000/max(a['wall_ms'],1):.0f} failed {a['failed']}")
    print(f"  confirmed {confirmed} ({confirmed/hours:.1f}/wall-hour, 1 in {a['runs']/max(confirmed,1):.0f} runs)"
          f"  unconfirmed {unconfirmed}  other unknown {sum(v for k,v in c.items() if k.startswith('unknown') and 'candidate' not in k)}")
    for k, v in sorted(c.items()):
        if 'candidate_unconfirmed' in k:
            print(f"    {k} {v}")
    if a['t_comparisons']:
        cmp = a['t_comparisons']
        print(f"  solver share {a['t_solver_us']/a['run_wall_us']:.3f}  comparisons/run {cmp/a['runs']:.1f}"
              f"  flips drawn {a['t_flips_drawn']/cmp:.3f} taken {a['t_flips_taken']/cmp:.3f} refused {a['t_flips_refused']/cmp:.3f}"
              f"  runs with a flip {a['runs_with_flip']/a['runs']:.3f}")
        print(f"  widenings {a['t_widened']:.0f}  conceded runs {a['conceded_runs']}  barrier fallbacks {a['t_barrier_fallbacks']:.0f}"
              f"  implicit {a['t_implicit_decisions']:.0f}  shadow releases per timed fire {a['t_shadow_releases']/max(a['t_timers_fired'],1):.3f}"
              f"  per run {a['t_shadow_releases']/a['runs']:.1f}")
        if a['t_trials']:
            print(f"  open share {a['t_open']/a['t_trials']:.3f} ({a['t_open']:.0f} of {a['t_trials']:.0f} trials)")
