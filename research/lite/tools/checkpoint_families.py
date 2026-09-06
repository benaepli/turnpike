"""Join checkpoint diagnostics to independently graded complete runs."""

import argparse
from collections import defaultdict
import json
import math
from pathlib import Path


def summarize(diagnostics, grade):
    dags = grade["grade_dags"]
    if len(dags) != 1:
        raise ValueError("Exactly one graded DAG is required")
    depths = dict(dags[0]["run_depths"])
    families = defaultdict(list)
    seen = set()
    for row in diagnostics:
        child, parent = row["run_id"], row["parent_run_id"]
        if child in seen:
            raise ValueError(f"Repeated child diagnostic: {child}")
        if child not in depths or parent not in depths:
            raise ValueError(f"Missing graded child or parent: {child}, {parent}")
        seen.add(child)
        families[parent].append(row)

    resumed = [r for rows in families.values() for r in rows if r["prefix"]]
    n = len(resumed)
    unique = sum(len({r["suffix_digest"] for r in rows if r["prefix"]})
                 for rows in families.values())
    new_parents = sorted(parent for parent, rows in families.items()
                         if depths[parent] < 11 and any(
                             r["prefix"] and depths[r["run_id"]] >= 11 for r in rows))
    output = {
        "diagnostic_rows": len(seen),
        "parents_with_children": len(families),
        "resumed_children": n,
        "suffix_distinct_share": unique / n if n else None,
        "additional_message_share": sum(r["suffix_message_count"] > 0 for r in resumed) / n if n else None,
        "new_depth11_parent_count": len(new_parents),
        "new_depth11_parent_ids": new_parents,
        "resumed_depth11_count": sum(depths[r["run_id"]] >= 11 for r in resumed),
    }

    # Both child cells of a parent belong to the same statistical cluster.
    contrasts = {}
    for rung in [8, 9, 10, 11]:
        clusters = []
        for rows in families.values():
            nt = sum(r["prefix"] for r in rows)
            nc = len(rows) - nt
            yt = sum(r["prefix"] and depths[r["run_id"]] >= rung for r in rows)
            yc = sum(not r["prefix"] and depths[r["run_id"]] >= rung for r in rows)
            clusters.append((nt, nc, yt, yc))
        nt, nc, yt, yc = map(sum, zip(*clusters)) if clusters else (0, 0, 0, 0)
        result = {"treated_runs": nt, "control_runs": nc,
                  "treated_events": yt, "control_events": yc}
        if min(nt, nc, yt, yc) > 0 and len(clusters) > 1:
            pt, pc = yt / nt, yc / nc
            ratio = pt / pc
            variance = sum(((a - pt * t) / yt - (b - pc * c) / yc) ** 2
                           for t, c, a, b in clusters)
            se = math.sqrt(variance * len(clusters) / (len(clusters) - 1))
            independent_se = math.sqrt(1 / yt - 1 / nt + 1 / yc - 1 / nc)
            for name, uncertainty in [("parent_cluster", se),
                                      ("sibling_sensitivity", independent_se * math.sqrt(4.5))]:
                width = 2.7 * 1.3 * uncertainty
                result[name] = {"ratio": ratio, "lo": ratio * math.exp(-width),
                                "hi": ratio * math.exp(width)}
        contrasts[str(rung)] = result
    output["descriptive_filled_slot_contrasts"] = contrasts
    output["limitation"] = "Filled slots only; not the intention-to-treat, co-bit-matched grader primary."
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("diagnostics", type=Path)
    parser.add_argument("grade", type=Path)
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.diagnostics.read_text().splitlines() if line]
    print(json.dumps(summarize(rows, json.loads(args.grade.read_text())), indent=2))
