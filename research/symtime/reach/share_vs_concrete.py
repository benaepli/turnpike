"""share_vs_concrete.py SYMBOLIC_CSV CONCRETE_CSV [...]: the solver share
as the offline figures define it, the engines' time over the run's own time
taken concretely, from a symbolic session and the same session in concrete
time (same seeds and grid). In total, and per run matched by run id: the
p99 and the worst. Then against what the symbolic run's own steps would
cost concretely, the concrete session's time per step times its steps,
since a symbolic run can run longer than the concrete run of the same
seeds. Pairs of files are given in turn."""
import csv, sys

args = sys.argv[1:]
for sym_path, conc_path in zip(args[0::2], args[1::2]):
    sym = {r["run_id"]: r for r in csv.DictReader(open(sym_path))}
    conc = {r["run_id"]: r for r in csv.DictReader(open(conc_path))}
    total = sum(float(r["solver_us"]) for r in sym.values()) / sum(float(r["wall_us"]) for r in conc.values()) * len(conc) / len(sym)
    ratios = sorted(float(sym[k]["solver_us"]) / max(float(conc[k]["wall_us"]), 1.0) for k in sym if k in conc)
    p99 = ratios[int(len(ratios) * 0.99)]
    # The same against what the symbolic run's own steps cost concretely:
    # the concrete session's time per step times the symbolic run's steps.
    per_step = sum(float(r["wall_us"]) for r in conc.values()) / sum(float(r["steps"]) for r in conc.values())
    by_steps = sum(float(r["solver_us"]) for r in sym.values()) / (per_step * sum(float(r["steps"]) for r in sym.values()))
    step_ratios = sorted(float(r["solver_us"]) / (per_step * max(float(r["steps"]), 1.0)) for r in sym.values())
    print(f"{sym_path.rsplit('/', 1)[-1]:32} share {total:.3f}  p99 {p99:.2f}  worst {ratios[-1]:.2f}   "
          f"by steps {by_steps:.3f}  p99 {step_ratios[int(len(step_ratios) * 0.99)]:.2f}  worst {step_ratios[-1]:.2f}  runs {len(ratios)}")
