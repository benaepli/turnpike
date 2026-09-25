"""exit_share.py DIR TAG...: the online solver share per dataset for each
session tag, against the offline figures (section 3.2's float, draw and cap
column).

The share is the engines' time over the run's own time taken concretely:
the concrete session of the same seeds gives the concrete time per step,
and each symbolic run is charged its own steps at that rate. Printed with
the p99 and worst run, the share of time comparisons left to concrete time,
and whether the share is within 1.5 times the offline figure.
"""
import csv, os, sys

OFFLINE = {"clean": 0.10, "recv_anchor": 0.11, "cached_flag": 0.14, "long": 0.10, "forms": 0.23,
           "idioms": 0.58, "webs": 0.89, "chains": 2.23, "crossclock": 2.18}
d = sys.argv[1]
for tag in sys.argv[2:]:
    print(f"== {tag}")
    for spec, offline in OFFLINE.items():
        sym_path, conc_path = f"{d}/{tag}-{spec}.csv", f"{d}/concrete-{spec}.csv"
        if not (os.path.exists(sym_path) and os.path.exists(conc_path)):
            continue
        sym = list(csv.DictReader(open(sym_path)))
        conc = list(csv.DictReader(open(conc_path)))
        per_step = sum(float(r["wall_us"]) for r in conc) / sum(float(r["steps"]) for r in conc)
        ratios = sorted(float(r["solver_us"]) / (per_step * max(float(r["steps"]), 1.0)) for r in sym)
        share = sum(float(r["solver_us"]) for r in sym) / (per_step * sum(float(r["steps"]) for r in sym))
        decided = sum(float(r["comparisons"]) for r in sym)
        left = sum(float(r.get("left_to_concrete", 0) or 0) for r in sym)
        ok = "within" if share <= 1.5 * offline else "OVER"
        print(f"  {spec:12} share {share:7.3f}  offline {offline:.2f}  {ok:6}  p99 {ratios[int(len(ratios) * 0.99)]:7.2f}  worst {ratios[-1]:8.2f}  "
              f"left to concrete {100 * left / max(decided + left, 1):5.1f}%")
