"""calibrate.py CSV...: fits the cap's units to wall time.

Each CSV is `reach runs` output. The engines' time is fitted as a sum of
rates over the main engine's pivots and merge work and the exact engine's
pivots and merge work, and the run's own time, its wall time less the
engines', as a rate per interpreter instruction, all by least squares with
no constant over every run of every file. Prints the rates in microseconds,
and for each file the solver share by wall time against the share by the
fitted units, in total and at the worst run.
"""
import csv, sys

TERMS = ["pivots", "solver_work", "exact_pivots", "exact_work"]


def load(path):
    out = []
    for r in csv.DictReader(open(path)):
        v = {k: float(r[k]) for k in r if k != "conceded"}
        v["own"] = max(v["wall_us"] - v["solver_us"], 1.0)
        out.append(v)
    return out


def least_squares(rows, xs, y):
    k = len(xs)
    a = [[sum(r[xs[i]] * r[xs[j]] for r in rows) for j in range(k)] + [sum(r[xs[i]] * r[y] for r in rows)] for i in range(k)]
    for c in range(k):
        p = max(range(c, k), key=lambda i: abs(a[i][c]))
        a[c], a[p] = a[p], a[c]
        if a[c][c] == 0:
            continue
        for i in range(k):
            if i != c:
                f = a[i][c] / a[c][c]
                a[i] = [x - f * z for x, z in zip(a[i], a[c])]
    return [a[i][k] / a[i][i] if a[i][i] else 0.0 for i in range(k)]


files = {p: load(p) for p in sys.argv[1:]}
every = [r for rs in files.values() for r in rs]
rates = least_squares(every, TERMS, "solver_us")
op = least_squares(every, ["ops"], "own")[0]
print("rates (us): " + "  ".join(f"{t} {x:.6g}" for t, x in zip(TERMS, rates)) + f"  ops {op:.6g}")
cost = lambda r: sum(x * r[t] for t, x in zip(TERMS, rates))
own = lambda r: op * r["ops"]
for path, rs in files.items():
    wall = sum(r["solver_us"] for r in rs) / sum(r["own"] for r in rs)
    units = sum(cost(r) for r in rs) / sum(own(r) for r in rs)
    worst_wall = max(r["solver_us"] / r["own"] for r in rs)
    worst_units = max(cost(r) / own(r) for r in rs if own(r) > 0)
    print(f"{path.rsplit('/', 1)[-1]:28} share by wall {wall:.3f} by units {units:.3f}   worst run by wall {worst_wall:.2f} by units {worst_units:.2f}")
