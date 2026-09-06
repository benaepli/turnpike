"""Quarter bins of one long campaign explore.

Reads the runs table and the grade output of a single session and reports,
per quarter of session wall time, the depth rate of each run population.
The coin population is the selector-free control: its arms come from the run
id whatever the selector's cells hold, so its quarter-over-quarter movement
is the run cap, the crash placement span, the timer context and the replay
corpus. The ratio of the two ratios is the selector's own term.
"""
import json
import math
import sys
from collections import defaultdict

RUN_CAP_PROBE = 1 << 1
TIMER_STEER_OFF = 1 << 2
PROBES = RUN_CAP_PROBE | TIMER_STEER_OFF
ARM_SELECTOR_BITS = (1 << 5) | (1 << 6) | (1 << 7)
REPLAY_SLOT = 1 << 20
OD = 1.3


def read_depths(path):
    with open(path) as fh:
        g = json.load(fh)
    return {rid: d for rid, d in g['grade_dags'][0]['run_depths']}


def read_runs(path):
    with open(path) as fh:
        raw = json.load(fh)
    rows = raw['rows'] if isinstance(raw, dict) and 'rows' in raw else raw
    return rows


def population(variant):
    """'coin', 'learner', 'probe'."""
    if variant & PROBES:
        return 'probe'
    if variant & ARM_SELECTOR_BITS:
        return 'learner'
    return 'coin'


def rate(hits, n):
    return hits / n if n else float('nan')


def ratio_se(h1, n1, h2, n2):
    """Relative standard error of (h2/n2)/(h1/n1), Poisson on the counts,
    overdispersion charged."""
    if not (h1 and h2):
        return float('nan')
    return math.sqrt(OD * (1.0 / h1 + 1.0 / h2))


def main():
    out = sys.argv[1]
    quarter_ms = int(sys.argv[2]) if len(sys.argv) > 2 else 300_000
    depths = read_depths(out + '.grade.json')
    rows = read_runs(out + '.runs.json')

    cells = defaultdict(lambda: {'n': 0, 'd8': 0, 'd10': 0, 'steps': 0, 'cap': 0, 'graded': 0})
    arm_cells = defaultdict(lambda: {'n': 0, 'd8': 0, 'd10': 0})
    quarters = set()
    for r in rows:
        off = r.get('session_offset_ms')
        if off is None:
            continue
        q = off // quarter_ms
        quarters.add(q)
        var = r.get('variant', 0) or 0
        pop = population(var)
        fresh = (var & REPLAY_SLOT) == 0
        arm = r.get('arm')
        rid = r['run_id']
        d = depths.get(rid)
        for key in ((q, pop, fresh), (q, pop, 'both'), (q, 'all', fresh), (q, 'all', 'both')):
            c = cells[key]
            c['n'] += 1
            c['steps'] += r.get('steps_used') or 0
            if r.get('end_reason') == 'learned_cap_reached':
                c['cap'] += 1
            if d is not None:
                c['graded'] += 1
                if d >= 8:
                    c['d8'] += 1
                if d >= 10:
                    c['d10'] += 1
        if d is not None and fresh:
            a = arm_cells[(q, arm, pop)]
            a['n'] += 1
            if d >= 8:
                a['d8'] += 1
            if d >= 10:
                a['d10'] += 1

    qs = sorted(quarters)
    print(f'quarters {qs}  quarter_ms {quarter_ms}')
    print()
    print(f'{"q":>2} {"pop":<8} {"fresh":<6} {"runs":>9} {"graded":>9} {"d>=8":>7} {"rate8":>8} {"d>=10":>6} {"rate10":>9} {"cap%":>6} {"steps":>7}')
    for q in qs:
        for pop in ('all', 'coin', 'learner', 'probe'):
            for fresh in (True, 'both'):
                c = cells.get((q, pop, fresh))
                if not c or not c['n']:
                    continue
                print(f'{q:>2} {pop:<8} {str(fresh):<6} {c["n"]:>9} {c["graded"]:>9} {c["d8"]:>7} '
                      f'{rate(c["d8"], c["graded"]):>8.5f} {c["d10"]:>6} {rate(c["d10"], c["graded"]):>9.6f} '
                      f'{100.0 * c["cap"] / c["n"]:>6.1f} {c["steps"] / c["n"]:>7.1f}')
        print()

    if len(qs) < 2:
        return
    q1 = qs[0]
    later = qs[1:]

    def pooled(pop, quarters_):
        h = sum(cells[(q, pop, True)]['d8'] for q in quarters_)
        n = sum(cells[(q, pop, True)]['graded'] for q in quarters_)
        return h, n

    print('fresh rows, depth>=8 per graded run, quarter over quarter 1')
    print(f'{"contrast":<28} {"pop":<8} {"ratio":>7} {"+-":>7}')
    reads = {}
    for label, qq in [('Q_last / Q1', [qs[-1]]), ('mean(Q2..Qn) / Q1', later)]:
        for pop in ('all', 'coin', 'learner'):
            h1, n1 = pooled(pop, [q1])
            h2, n2 = pooled(pop, qq)
            if not (n1 and n2 and h1 and h2):
                continue
            r = (h2 / n2) / (h1 / n1)
            se = ratio_se(h1, n1, h2, n2)
            reads[(label, pop)] = r
            print(f'{label:<28} {pop:<8} {r:>7.4f} {100 * se:>6.1f}%')
    print()
    print('selector term = all / coin (the coin ratio carries cap, span, timer, corpus)')
    for label in ('Q_last / Q1', 'mean(Q2..Qn) / Q1'):
        if (label, 'all') in reads and (label, 'coin') in reads:
            print(f'{label:<28} {reads[(label, "all")] / reads[(label, "coin")]:>7.4f}')
    print()

    print('fresh rows by arm, depth>=8 per graded run')
    arms = sorted({a for (_, a, _) in arm_cells}, key=lambda x: (x is None, x))
    print(f'{"arm":<22} {"pop":<8} ' + ' '.join(f'{"q" + str(q):>8}' for q in qs) + f' {"last/Q1":>8}')
    for arm in arms:
        for pop in ('coin', 'learner'):
            vals = []
            for q in qs:
                a = arm_cells.get((q, arm, pop))
                vals.append(rate(a['d8'], a['n']) if a and a['n'] else float('nan'))
            if all(math.isnan(v) for v in vals):
                continue
            tail = vals[-1] / vals[0] if vals[0] else float('nan')
            print(f'{str(arm):<22} {pop:<8} ' + ' '.join(f'{v:>8.5f}' for v in vals) + f' {tail:>8.4f}')


if __name__ == '__main__':
    main()
