"""votes.py WITNESS REPLAY_CSV_DIR: whether a confirmed lease violation
needed a vote the thesis section 4.2.3 rule refuses.

Every "lease read" taken after a leader of a higher term was elected is
examined; the superseding leader is the newest such. For each node that
voted for it, the elapsed time on the voter's own clock since it last took
an AppendEntries from the stale leader's term is compared with the
election timeout. Global time at step n is the witness's
advances summed up to action n.
"""
import csv, json, re, sys

witness = json.load(open(sys.argv[1]))
d = sys.argv[2]
advance = {a: t for a, t in witness["advances"]}
clocks = {int(r["node_id"]): r for r in csv.DictReader(open(d + "/run_clocks.csv"))}
run = next(csv.DictReader(open(d + "/runs.csv")))
election = json.loads(run["clock"])["durations"]["durations"]["election"]
logs = sorted(csv.DictReader(open(d + "/logs.csv")), key=lambda r: (int(r["step"]), int(r["seq_num"])))

def time_at(step):
    return sum(t for a, t in advance.items() if a <= step)

def reading(node, step):
    c = clocks[node]
    return int(c["origin"]) + (int(c["rate_num"]) * time_at(step)) // int(c["rate_den"])

events = []
for r in logs:
    node, step, text = int(r["node_id"]), int(r["step"]), json.loads(r["content"])
    events.append((step, node, text))

reads = [(s, n) for s, n, t in events if "lease read" in t]
leaders = [(s, n, int(re.search(r"term (\d+)", t).group(1))) for s, n, t in events if "became leader" in t]
print(f"election timeout {election}")
found = False
for stale_step, stale in reads:
    stale_term = max(term for s, n, term in leaders if n == stale and s <= stale_step)
    newer = [(s, n, term) for s, n, term in leaders if s <= stale_step and term > stale_term]
    if not newer:
        continue
    found = True
    ns, nl, nterm = newer[-1]
    print(f"lease read by node {stale} at step {stale_step} in its term {stale_term}, after node {nl} became leader for term {nterm} at step {ns}")
    refused = []
    for s, n, t in events:
        if not re.search(rf"Node {n} voted for {nl} in term {nterm}$", t) or n == nl or s > ns:
            continue
        heard = [st for st, node, tx in events if node == n and st <= s and re.search(rf"AppendEntries: from leader {stale} term={stale_term}\b", tx)]
        if not heard:
            print(f"  node {n} voted at step {s}; never heard from node {stale} in term {stale_term}")
            refused.append(False)
            continue
        elapsed = reading(n, s) - reading(n, heard[-1])
        within = elapsed < election
        refused.append(within)
        print(f"  node {n} voted at step {s}; last heard the reader at step {heard[-1]}, {elapsed} ticks earlier on its clock: {'within' if within else 'past'} the timeout")
    print("  verdict:", "the vote rule refuses it" if refused and all(refused) else "the vote rule does not stop it")
if not found:
    print("no lease read after a newer leader")
