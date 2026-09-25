"""The policy table from the per-run lines bench_policies.sh writes.

policy_table.py DIR [REFERENCE_DIR]

Solver time over the runs' own execution time, the p99 of that ratio per
run, and the share of comparisons given no answer. With a reference
directory, also the number of runs whose answers differ and the ratio of
solver time on the same runs.
"""
import os
import sys

SPECS = ["clean", "recv_anchor", "cached_flag", "long", "forms", "idioms", "webs", "chains", "crossclock"]
POLICIES = ["exact", "draw", "float_draw_cap5"]


def load(path):
    runs = {}
    for line in open(path):
        t = line.split()
        if t and t[0] == "RUN":
            runs[int(t[1])] = dict(zip(t[2::2], t[3::2]))
    return runs


def cell(runs):
    ns = sum(int(r["ns"]) for r in runs.values())
    wall = sum(float(r["wall"]) for r in runs.values()) * 1000 or 1
    ratios = sorted(int(r["ns"]) / (float(r["wall"]) * 1000) for r in runs.values() if float(r["wall"]) > 0)
    p99 = ratios[int(len(ratios) * 0.99)] if ratios else 0
    asked = sum(int(r["comparisons"]) for r in runs.values()) or 1
    left = sum(int(r["conceded"]) for r in runs.values())
    return ns / wall, p99, 100 * left / asked


def main():
    here = sys.argv[1]
    ref = sys.argv[2] if len(sys.argv) > 2 else None
    print("spec".ljust(12) + "".join(p.rjust(34 if ref else 22) for p in POLICIES))
    for spec in SPECS:
        line = spec.ljust(12)
        for policy in POLICIES:
            path = f"{here}/{spec}__{policy}.txt"
            if not os.path.exists(path):
                line += "-".rjust(34 if ref else 22)
                continue
            runs = load(path)
            cost, p99, left = cell(runs)
            text = f"{cost:6.3f} {p99:6.2f} {left:5.1f}%"
            other = f"{ref}/{spec}__{policy}.txt" if ref else None
            if other and os.path.exists(other):
                theirs = load(other)
                keys = runs.keys() & theirs.keys()
                differ = sum(1 for k in keys if runs[k].get("answers") != theirs[k].get("answers"))
                mine = sum(int(runs[k]["ns"]) for k in keys)
                base = sum(int(theirs[k]["ns"]) for k in keys) or 1
                text += f" d{differ} x{mine / base:.2f}"
            line += text.rjust(34 if ref else 22)
        print(line)


main()
