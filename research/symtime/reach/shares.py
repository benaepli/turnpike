"""shares.py CSV...: per `reach runs` file, the solver share by wall time
(engine time over the run's own), the worst run's, the runs that conceded
by cause, and the refusal counts."""
import collections, csv, sys

for path in sys.argv[1:]:
    rs = list(csv.DictReader(open(path)))
    own = lambda r: max(float(r["wall_us"]) - float(r["solver_us"]), 1.0)
    share = sum(float(r["solver_us"]) for r in rs) / sum(own(r) for r in rs)
    worst = max(float(r["solver_us"]) / own(r) for r in rs)
    ratios = sorted(float(r["solver_us"]) / own(r) for r in rs)
    p99 = ratios[int(len(ratios) * 0.99)]
    conceded = collections.Counter(r["conceded"] for r in rs if r["conceded"])
    total = lambda k: sum(float(r[k]) for r in rs)
    print(f"{path.rsplit('/', 1)[-1]:30} runs {len(rs):5}  share {share:.3f}  p99 {p99:.2f}  worst {worst:.2f}  "
          f"conceded {dict(conceded)}  flips {total('flips_drawn'):.0f} refused {total('flips_refused'):.0f} "
          f"false_witness {total('false_witnesses'):.0f}")
