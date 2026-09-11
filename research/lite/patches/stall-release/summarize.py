import json, sys
d=json.load(open(sys.argv[1]))
for k in ['phase','chunk','verdict','reason','resolvedIfStopped','canStillAdvance','advice','unresolvedGuards','stratumFault','regressed']:
    print(k, json.dumps(d.get(k)))
p=d['primary']; print('PRIMARY', json.dumps({k:p.get(k) for k in ['ratio','lo','hi','z','perChunkRatios','treatedShare','bandReading','verdict','meiAtCap']}))
print('treated', p['treated']['runs'], p['treated']['events'], round(p['treated']['rate'],5), 'steps', round(p['treated']['meanStepsUsed']), 'complete', round(p['treated']['planCompleteShare'],4), '| control', p['control']['runs'], p['control']['events'], round(p['control']['rate'],5), 'steps', round(p['control']['meanStepsUsed']), 'complete', round(p['control']['planCompleteShare'],4), '| faults', p['balance']['faults'])
print('advance', [(a['rung'],round(a['ratio'],3),round(a['lo'],3),round(a['hi'],3),a['verdict']) for a in p['advance']])
c=d['cost']; print('COST', round(c['ratio'],4), 'null', round(c['nullBand'],4), 'inside floor', c['insideLayoutFloor'], 'regressed', c['primaryRungRegressed'], '| throughput', round(c['throughput']['ratio'],4), 'epoch projected', round(c['throughput']['epoch']['projected'],4), 'measured', round(c['throughput']['epoch']['measured'],4))
print('violations', d['stopper']['violations'], 'timing', {k:d['timing'][k] for k in ['lastChunkWallSec','candRps','baseMedianRps','slowConfirmed']})
for r in d['stopper']['rungs']:
    print({k:(round(r[k],4) if isinstance(r.get(k),float) else r.get(k)) for k in ['rung','candEvents','baseEvents','ratio','nullBand','pGreater']})
for v in d['variantContrasts']['candidate']:
    if v['bit'] in (1024,4096):
        for r in v['rungs']:
            if r['rung'] in ('depth>=4','depth>=6','depth>=8','depth>=9','depth>=10'): print('VC', {k:(round(x,4) if isinstance(x,float) else x) for k,x in r.items()})
