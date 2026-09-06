import json
from pathlib import Path

root = Path('/home/benaepli/Rust/turnpike')
out = root / 'tmp/loop/lite/conditional-pairs'
base = json.loads((root / 'research/lite/baselines/34b5ef40e3bf-30-f9daa01b-300-g870d4c11-s3d907a50.json').read_text())
result = []

def aggregate(rows):
    n = sum(r['gradedRuns'] for r in rows)
    steps = sum(r.get('stepsUsedSum', 0) for r in rows)
    return dict(runs=n, d8=sum(r['depthAtLeast'][7] for r in rows),
                d11=sum(r['depthAtLeast'][10] for r in rows),
                mean_steps=steps/n if n and all('stepsUsedSum' in r for r in rows) else None,
                us_per_step=sum(r.get('wallUsSum', 0) for r in rows)/steps if steps else None,
                complete_share=sum(r.get('planCompleteRuns', 0) for r in rows)/n if n and all('planCompleteRuns' in r for r in rows) else None)

for b in base['chunks']:
    seed = b['seed']
    path = root / f'research/lite/state/conditional-pairs/chunk-{seed}.cand.json'
    if not path.exists():
        continue
    c = json.loads(path.read_text())
    bm, cm = b['metrics'], c['metrics']
    arms = []
    for ba, ca in zip(bm['campaign']['arms'], cm['campaign']['arms']):
        assert ba['id'] == ca['id']
        arms.append(dict(arm=ba['id'], base=aggregate([ba]), candidate=aggregate([ca]),
                         per_run_ratio=(ca['depthAtLeast'][7]/ca['gradedRuns'])/(ba['depthAtLeast'][7]/ba['gradedRuns']),
                         per_second_ratio=(ca['depthAtLeast'][7]/ca['wallMs'])/(ba['depthAtLeast'][7]/ba['wallMs'])))
    populations = {}
    for name, ids in [('grid', {a['arm'] for a in arms if a['arm'] != 'aos'}), ('campaign', {a['arm'] for a in arms})]:
        br = [a for a in bm['campaign']['arms'] if a['id'] in ids]
        cr = [a for a in cm['campaign']['arms'] if a['id'] in ids]
        ba, ca = aggregate(br), aggregate(cr)
        populations[name] = dict(base=ba, candidate=ca,
            per_run_ratio=(ca['d8']/ca['runs'])/(ba['d8']/ba['runs']),
            per_second_ratio=(ca['d8']/(cm['exposureMs'] if name == 'campaign' else sum(r['wallMs'] for r in cr)))/(ba['d8']/(bm['exposureMs'] if name == 'campaign' else sum(r['wallMs'] for r in br))),
            baseline_weighted_per_run_ratio=sum(x['gradedRuns']*y['depthAtLeast'][7]/y['gradedRuns'] for x,y in zip(br,cr))/ba['d8'])
    strata = {}
    for name, test in [('fresh_non_slot', lambda v:not v & (1<<20)), ('replay_slot',lambda v:bool(v & (1<<20))), ('probe',lambda v:bool(v & 2)), ('learner_a',lambda v:bool(v & 64)), ('learner_b',lambda v:bool(v & 32)), ('learner_c',lambda v:bool(v & 128))]:
        strata[name] = {side: {arm: aggregate([r for r in m['variants'] if (arm == 'all' or r['arm'] == arm) and test(r['variant'])]) for arm in ['all','aos']} for side,m in [('base',bm),('candidate',cm)]}
    rewards = {}
    for label, key in [('A','overtaken_ghost'),('B','absorber_cycle'),('C','cycle_before_request')]:
        prefix = 'arm_selector_axis.'+key+'.'
        values = []
        for x in [b,c]:
            stats=x['utilStats']['counters']
            values.append([stats[prefix+'reward_positive_treated'],stats[prefix+'reward_runs_treated']])
        rewards[label] = dict(base=values[0],candidate=values[1],ratio=(values[1][0]/values[1][1])/(values[0][0]/values[0][1]))
    support = None
    raw = out / f'normal-{seed}.utilization.json'
    if raw.exists():
        p = json.loads(raw.read_text())['arm_selector_axis']['conditional_pair']
        support = {k:v for k,v in p.items() if k != 'cells'}
        support.update(qualified_cells=sum(x['supported_decisions']>=100 for x in p['cells']),
                       supported_change_share=p['supported_argmax_changes']/p['supported_decisions'],
                       mean_tv=p['total_variation_micro']/1e6/sum(d['decisions'] for x in p['cells'] for d in x['decisions']))
    result.append(dict(seed=seed, arms=arms, populations=populations, strata=strata, rewards=rewards, support=support,
                       runs=cm['runs'], violations=cm['violations'], throughput=cm['runsPerSec']/bm['runsPerSec']))
(out / 'paired-summary.json').write_text(json.dumps(result,indent=2)+'\n')
for x in result:
    print(json.dumps({k:v for k,v in x.items() if k not in ['arms','strata']},indent=2))
