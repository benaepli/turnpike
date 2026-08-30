#!/usr/bin/env python3
"""Print the acceptance-distance census from a session's utilization dump.

Usage: acceptance_distance.py <utilization.json> [...]

The census lives at delivery_effects.acceptance_distance and is only populated
when the session config sets stats, emit_acted_fraction and
emit_acceptance_distance. Several dumps given at once are summed, which is how
a prescreen split over more than one session is read.
"""

import json
import sys

PATHS = ("all", "sender_restarted", "receiver_restarted")


def load(paths):
    totals = {p: {} for p in PATHS}
    order = []
    for path in paths:
        with open(path) as f:
            census = json.load(f)["delivery_effects"]["acceptance_distance"]
        for p in PATHS:
            for row in census[p]:
                d = row["distance"]
                if d not in order:
                    order.append(d)
                cur = totals[p].setdefault(d, [0, 0])
                cur[0] += row["deliveries"]
                cur[1] += row["acted"]
    return totals, order


def wilson(acted, n):
    """95% interval on the acted fraction, so a thin bucket reads as thin."""
    if n == 0:
        return (0.0, 0.0)
    z = 1.96
    p = acted / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    totals, order = load(sys.argv[1:])
    for p in PATHS:
        print(f"\n{p}")
        print(f"  {'distance':>8}  {'deliveries':>11}  {'acted':>9}  {'acted_fraction':>14}  95% CI")
        for d in order:
            n, acted = totals[p].get(d, (0, 0))
            frac = acted / n if n else 0.0
            lo, hi = wilson(acted, n)
            print(f"  {d:>8}  {n:>11}  {acted:>9}  {frac:>14.4f}  [{lo:.4f}, {hi:.4f}]")
        n = sum(v[0] for v in totals[p].values())
        acted = sum(v[1] for v in totals[p].values())
        frac = acted / n if n else 0.0
        print(f"  {'total':>8}  {n:>11}  {acted:>9}  {frac:>14.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
