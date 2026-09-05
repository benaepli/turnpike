#!/usr/bin/env python3
"""Pool per-cell panel contrasts across seeds.

Reads the runs.json and porcupine.json the grader's panel command writes
under research/lite/state/panel/<iso>/<member>/ and pools one treatment
bit's contrast across several such directories with the grader's own cell
arithmetic: probes dropped, the control matched on co-bits the treated side
always carries and on co-bits it is always drawn clear of, a log-ratio
interval at z 2.7 with overdispersion 1.3, and a count-only read under five
violations a side.

Usage: pool_cells.py <panel-dir> [<panel-dir> ...] <bit>
"""
import json, sys, os, glob, math
from collections import defaultdict

# Registered bits, mirrored from decide.ts VARIANT_BITS.
BITS = {1:"crashPlaced",2:"runCapProbe",4:"timerSteerOff",8:"crashHoldDrawn",16:"staleOrder",
32:"restartLatency",64:"noveltyOn",128:"partitioned",256:"linkSpeed",512:"crashPhase",
1024:"freshFirstDestCut",4096:"recoverWindowFreshOnly",16384:"clientRushPriority",65536:"recoverWindowFreshEarly",524288:"ghostAbsorberRetarget",
8388608:"crashPhaseOnLanding",1048576:"replaySlot",2097152:"replayPrefix",33554432:"ghostPendingTimerHold",
67108864:"originAlternate",536870912:"pairOrderGhostOnly",16777216:"freshFirstPair",8192:"replyBeforeNews",
2048:"newsBeforeReply",32768:"pairSendOrder",262144:"clientFanoutRelease",1073741824:"restartAfterPeerSettle",
134217728:"clientDeferralOnly",4194304:"staleFirstPair",268435456:"clientProgressRelease",131072:"crashQuietBySecond"}
PROBES = 2 | 4
Z = 2.7
OD = 1.3
MIN_EFFECT = 0.02
MIN_VIOL = 5

def load(d, member):
    rp = os.path.join(d, member, "runs.json")
    pp = os.path.join(d, member, "porcupine.json")
    if not (os.path.exists(rp) and os.path.exists(pp)): return None
    runs = json.load(open(rp))
    porc = json.load(open(pp))
    rows = runs["rows"] if isinstance(runs, dict) and "rows" in runs else runs
    viol = porc["violating_run_ids"] if isinstance(porc, dict) and "violating_run_ids" in porc else porc
    return rows, set(viol)

def cells(rows, viol):
    agg = defaultdict(lambda: [0,0])
    for r in rows:
        rid = r["run_id"] if isinstance(r, dict) else r[0]
        v = r["variant"] if isinstance(r, dict) else r[1]
        a = agg[v]; a[0] += 1
        if rid in viol: a[1] += 1
    return agg

def contrast(agg, bit):
    scope = {v:c for v,c in agg.items() if (v & PROBES) == 0}
    treated = {v:c for v,c in scope.items() if v & bit}
    if not treated: return None
    inv = None
    clear = None
    for v,c in treated.items():
        if c[0] <= 0: continue
        m = v & ~bit
        inv = m if inv is None else inv & m
        cl = ~v
        clear = cl if clear is None else clear & cl
    inv = inv or 0
    shared = {v:c for v,c in scope.items() if not (v & bit) and (v & inv) == inv}
    present = 0
    for v,c in shared.items():
        if c[0] > 0: present |= v
    comp = (clear or 0) & present & ~bit
    control = {v:c for v,c in shared.items() if (v & comp) == 0}
    tr = [sum(c[0] for c in treated.values()), sum(c[1] for c in treated.values())]
    co = [sum(c[0] for c in control.values()), sum(c[1] for c in control.values())]
    return tr, co, inv, comp

def read(tr, co):
    if tr[0] == 0 or co[0] == 0: return None
    p1 = tr[1]/tr[0]; p2 = co[1]/co[0]
    if p2 == 0: return None
    ratio = p1/p2
    if tr[1] == 0 or co[1] == 0: return ratio, None, None, "count-only"
    se = math.sqrt(OD*((1-p1)/tr[1] + (1-p2)/co[1]))
    lo = ratio*math.exp(-Z*se); hi = ratio*math.exp(Z*se)
    if tr[1] < MIN_VIOL or co[1] < MIN_VIOL: r = "count-only"
    elif lo > 1 and ratio-1 >= MIN_EFFECT: r = "up"
    elif hi < 1 and 1-ratio >= MIN_EFFECT: r = "down"
    else: r = "flat"
    return ratio, lo, hi, r

dirs = sys.argv[1:-1]
bit = int(sys.argv[-1])
members = sorted({os.path.basename(p.rstrip('/')) for d in dirs for p in glob.glob(os.path.join(d,'*/'))})
print(f"pooling bit {bit} ({BITS.get(bit)}) over {len(dirs)} seeds\n")
for m in members:
    T=[0,0]; C=[0,0]; seeds=0
    for d in dirs:
        got = load(d, m)
        if not got: continue
        rows, viol = got
        agg = cells(rows, viol)
        r = contrast(agg, bit)
        if not r: continue
        tr, co, inv, comp = r
        T[0]+=tr[0]; T[1]+=tr[1]; C[0]+=co[0]; C[1]+=co[1]; seeds+=1
    if seeds == 0: continue
    out = read(T, C)
    if out is None:
        print(f"{m}: no control"); continue
    ratio, lo, hi, rd = out
    iv = f"[{lo:.2f},{hi:.2f}]" if lo else ""
    print(f"{m}: {ratio:.2f} {iv} {T[1]}/{T[0]} vs {C[1]}/{C[0]} {rd} ({seeds} seeds)")
