"""patterns.py REPLAY_DIR OPS_JSON [LIMIT]: joint (node, site, result) patterns of a
symbolic session's time decisions, read from its replay artifacts.

Each decision's node is the node of the action its step took (step n
takes action n); its result
follows from the outcome it took and the site's operation, which the
concrete recorder names (`symtime patterns` prints them). Prints the same
three readings `symtime patterns` prints for a concrete session.
"""
import json, os, sys

# Outcome index to the operation's value, as the simulator numbers the
# outcomes of each operation.
RESULT = {
    "Less": {0: True, 1: False},
    "GreaterEqual": {0: False, 1: True},
    "LessEqual": {0: True, 1: False},
    "Greater": {0: False, 1: True},
    "Equal": {0: False, 1: True, 2: False},
    "NotEqual": {0: True, 1: False, 2: True},
}

def main():
    directory, ops = sys.argv[1], json.loads(sys.argv[2])
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else None
    patterns = set()
    runs = two = two_false = unknown_site = 0
    names = sorted((n for n in os.listdir(directory) if n.endswith(".json")), key=lambda n: int(n[4:-5]))
    for name in names[:limit]:
        artifact = json.load(open(os.path.join(directory, name)))
        actions = artifact["actions"]
        runs += 1
        joint = set()
        for d in artifact.get("time_decisions", []):
            op = ops.get(str(d["site"]))
            if op not in RESULT:
                unknown_site += 1
                continue
            # Step n takes action n.
            action = actions[d["step"]] if d["step"] < len(actions) else {}
            node = action.get("node")
            joint.add((node, d["site"], RESULT[op][d["taken"]]))
        held = {}
        for node, site, result in joint:
            held.setdefault((site, result), set()).add(node)
        two += any(r and len(n) >= 2 for (_, r), n in held.items())
        two_false += any(not r and len(n) >= 2 for (_, r), n in held.items())
        patterns.add(tuple(sorted(joint, key=repr)))
    print(f"runs {runs}")
    print(f"distinct joint patterns {len(patterns)}")
    print(f"runs with one site true on two nodes {two}")
    print(f"runs with one site false on two nodes {two_false}")
    print(f"decisions at sites the recorder did not name {unknown_site}")

main()
