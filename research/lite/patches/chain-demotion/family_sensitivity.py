import collections
import json
import math
from pathlib import Path

ROOT = Path('/home/benaepli/Rust/turnpike')
OUT = ROOT / 'tmp/loop/lite/chain-demotion'
MASK = (1 << 64) - 1
ARM_SALT = 0x41524D5345454453
WORKLOAD_SALT = 0x57424C4F41445345
SLOT = 1 << 20
PREFIX = 1 << 21


def mix(x):
    z = (x + 0x9E3779B97F4A7C15) & MASK
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK
    return z ^ (z >> 31)


def seed(session, run_id, salt):
    return mix(mix(session ^ salt) ^ run_id)


campaign = json.loads((OUT / 'retained-1000/campaign.json').read_text())
arms = {a['index']: a for a in campaign['arms'] if a['mode'] == 'grid'}
arm_seeds = {i: seed(campaign['session_seed'], i, ARM_SALT) for i in arms}
rows = json.loads((OUT / 'family-runs-1000.json').read_text())
groups = {}
issues = collections.Counter()
counts = collections.Counter()
for row in rows:
    arm = row['arm_index']
    if arm not in arms:
        continue
    run = row['run_id']
    fresh = seed(arm_seeds[arm], run, WORKLOAD_SALT) == row['workload_seed']
    key = (arm, row['workload_seed'])
    if key not in groups:
        groups[key] = dict(config=row['config_index'], n=0, roots=0, children=0,
                           prefix=0, plan=0, earliest=run, root=None)
    g = groups[key]
    if g['config'] != row['config_index']:
        issues['config_conflict'] += 1
    g['n'] += 1
    g['earliest'] = min(g['earliest'], run)
    counts['grid_runs'] += 1
    if fresh:
        g['roots'] += 1
        g['root'] = run
        counts['fresh_roots'] += 1
        if row['variant'] & SLOT:
            counts['unfilled_slots'] += 1
            if row['variant'] & PREFIX:
                counts['unfilled_prefix_slots'] += 1
    else:
        counts['filled_children'] += 1
        g['children'] += 1
        if not row['variant'] & SLOT:
            issues['non_slot_child'] += 1
        population = 'prefix' if row['variant'] & PREFIX else 'plan'
        g[population] += 1
        counts['filled_' + population] += 1
for g in groups.values():
    if g['roots'] != 1:
        issues['root_count_not_one'] += 1
    if g['root'] != g['earliest']:
        issues['parent_not_earliest'] += 1
    if g['children'] > 8:
        issues['child_bound_exceeded'] += 1


def describe(gs):
    gs = list(gs)
    sizes = collections.Counter(g['n'] for g in gs)
    n = sum(g['n'] for g in gs)
    children = collections.Counter(g['children'] for g in gs if g['children'])
    return dict(runs=n, families=len(gs), family_size_histogram=dict(sorted(sizes.items())),
                served_children_histogram=dict(sorted(children.items())),
                families_with_children=sum(g['children'] > 0 for g in gs),
                families_with_both_child_types=sum(g['prefix'] > 0 and g['plan'] > 0 for g in gs),
                max_family_size=max(sizes),
                equal_variance_perfect_correlation_design_effect=sum(m*m*c for m,c in sizes.items())/n)

summary = dict(seed=1000, counts=dict(counts), validation_issues=dict(issues),
               grid=describe(groups.values()),
               arms={a['id']: describe(g for (i,w),g in groups.items() if i == arm) for arm,a in arms.items()})
paired = json.loads((OUT / 'paired-summary.json').read_text())[0]
sensitivity = {}
for population in ['grid', 'campaign']:
    p = paired['populations'][population]
    ec, eb = p['candidate']['d8'], p['base']['d8']
    nc, nb = p['candidate']['runs'], p['base']['runs']
    rr = p['per_run_ratio']
    rate_ratio = p['per_second_ratio']
    vals = []
    for rho in [0, 0.1, 0.25, 0.5, 1]:
        design = 1 + 8 * rho
        se_rr = math.sqrt(design * (1/ec - 1/nc + 1/eb - 1/nb))
        se_rate = math.sqrt(design * (1/ec + 1/eb))
        vals.append(dict(rho=rho, assumed_design_effect=design,
                         per_run_ratio=rr,
                         per_run_interval=[rr*math.exp(-1.96*se_rr),rr*math.exp(1.96*se_rr)],
                         per_second_ratio=rate_ratio,
                         per_second_interval=[rate_ratio*math.exp(-1.96*se_rate),rate_ratio*math.exp(1.96*se_rate)]))
    sensitivity[population] = vals
summary['hypothetical_sensitivity'] = sensitivity
summary['sensitivity_assumptions'] = [
    'These are not empirical family-clustered confidence intervals.',
    'Each side uses a maximum size-nine replay family and common within-family correlation rho; all families are independent.',
    'Per-run intervals use a binomial log-rate-ratio approximation; per-second intervals use Poisson event counts with fixed exposure.',
    'Equal marginal variance and common correlation are stylized assumptions; adaptivity and shared learner dependence are not covered.',
    'The candidate size-weighted design effect is descriptive and cannot determine the outcome covariance.',
    'Baseline metadata and per-run outcome arrays were not retained here; no exact paired family covariance can be computed.'
]
(OUT / 'family-sensitivity-1000.json').write_text(json.dumps(summary, indent=2)+'\n')
print(json.dumps(summary, indent=2))
