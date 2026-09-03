#!/usr/bin/env python3
"""Ghost-delivery census over simulator runs.

A ghost is a message whose sender crashed after dispatching it and before it
was delivered. Each run is read once through `traceanalyzer/main -dump-run`
and reduced to one row of predicates: the view-change chain walked by ghosts
(rungs R1-R4), a view-change quorum completed by a ghost (P2), and a write
committed in the old view after the new view's broadcast was sent (P3). Only
the per-run row is kept; dumps are never stored.

Subcommands:
  select  print run ids taken from a grade file's run_depths at one depth
  census  evaluate populations of runs; write a per-run CSV and a JSON summary
  tables  render a JSON summary as markdown tables

Column conventions of a dump: executions rows carry Kind, Action, Step,
UniqueID and a JSON Payload whose first element names the node for Crash,
Recover, Invocation and Response rows; trace rows share one TraceID across the
Dispatch, Enter and Exit rows of a message, with NodeID the sender on Dispatch
and the receiver on Enter, and Payload a JSON list of stringified handler
arguments (the view number is element 0 for every view-change handler); log
rows carry node_id, step and a quoted content string.

Handler attribution: the dispatches a handler made are the Dispatch rows at the
receiver with the same Step as the handler's Enter row. (NodeID, Step) is
unique among Enter rows because one step runs one handler; the census counts
any duplicate it meets and reports it. A dispatch at a (node, step) with no
Enter row was made by a handler resumed after an await, by a timer, or by the
client path; by default it is attributed to the innermost handler on that node
whose Enter/Exit sequence-number span contains it (--same-step-only turns this
off and leaves such dispatches unattributed).
"""
import argparse
import bisect
import csv
import json
import os
import random
import re
import subprocess
import sys
from collections import Counter, defaultdict
from multiprocessing import Pool

SVC = 'Node.StartViewChange'
DVC = 'Node.DoViewChange'
SV = 'Node.StartView'
PREPARE = 'Node.Prepare'
PREPARE_OK = 'Node.PrepareOK'
COMMIT = 'Node.Commit'
INIT = 'Node.Init'
WRITE = 'ClientInterface.Write'

# Set by the census command before workers fork.
SAME_STEP_ONLY = False

RE_INIT = re.compile(r'^Node (\d+) initialized')
RE_REC_START = re.compile(r'^Node (\d+) starting recovery')
RE_REC_DONE = re.compile(r'^Node (\d+) recovery complete\. view=(\d+)')
RE_ENTER_VC = re.compile(r'^Node (\d+) entering view change to view (\d+)')
RE_ENTER_NORMAL = re.compile(r'^Node (\d+) entering normal mode at view (\d+)')

# Receiver status values as the spec keeps them: 0 normal, 1 view change,
# 2 recovering.
NORMAL, VIEW_CHANGE, RECOVERING = 0, 1, 2

BOOL_FIELDS = [
    'R1', 'R1_first', 'R1_fresh_only', 'R2', 'R3', 'R4', 'R4_loose',
    'P1a', 'P1b', 'P1c', 'P4_nl', 'P4_2',
    'P2a', 'P2a_r', 'P2b', 'P2c',
    'P3', 'P3_lost', 'P3_ghost', 'P3_ghost_lost', 'P3_old_view_recovery', 'P3_issued_after',
    'P3a', 'P3a_c', 'P3b', 'P3b_d0', 'P2b_and_P3b', 'P2b_and_P3b_d0', 'P2b_and_P3b_same',
]
FUNNEL = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']
FIELDS = [
    'pop', 'db', 'run_id', 'depth', 'violating', 'steps', 'last_step', 'end_reason',
    'n_servers', 'n_crash', 'n_recover', 'n_timer_fired', 'n_enter_dupes',
    'n_unattributed_dispatches', 'n_fallback_dispatches', 'n_views', 'n_vc_entries', 'n_msgs',
    'n_ghost', 'n_ghost_restarted', 'n_ghost_acted',
    'n_svc_1_to_2', 'n_ghost_svc_1_to_2', 'R2_class', 'R2_classes_all', 'R4_class', 'R4_classes_all',
    'n_fanouts', 'n_ghost_fanouts', 'P2b_sender_rc', 'P2b_sender_rc_any', 'P2b_detail',
    'P3_detail',
] + BOOL_FIELDS + FUNNEL


def parse_list(payload):
    try:
        v = json.loads(payload)
    except (TypeError, ValueError):
        return []
    return v if isinstance(v, list) else []


def as_int(s):
    try:
        return int(s)
    except (TypeError, ValueError):
        return None


def node_of(payload):
    lst = parse_list(payload)
    try:
        return lst[0]['value']['index']
    except (IndexError, KeyError, TypeError):
        return None


def log_text(content):
    try:
        v = json.loads(content)
        if isinstance(v, str):
            return v
    except (TypeError, ValueError):
        pass
    return content.strip('"')


class Msg:
    __slots__ = ('tid', 'func', 'D', 'E', 'X', 'sender', 'receiver',
                 'd_step', 'e_step', 'args', 'handler', 'view')

    def __init__(self, tid, func):
        self.tid = tid
        self.func = func
        self.D = self.E = self.X = None
        self.sender = self.receiver = None
        self.d_step = self.e_step = None
        self.args = []
        self.handler = []
        self.view = None


class Run:
    def __init__(self, dump, fallback=True):
        self.run_id = dump['run_id']
        self.crash = defaultdict(list)
        self.recover = defaultdict(list)
        self.invocations = []
        self.responses = {}
        self.timer_fired = 0
        self.max_step = 0
        for e in dump['executions']:
            self.max_step = max(self.max_step, e['Step'])
            k = e['Kind']
            if k == 'Crash':
                self.crash[node_of(e['Payload'])].append(e['Step'])
            elif k == 'Recover':
                self.recover[node_of(e['Payload'])].append(e['Step'])
            elif k == 'Invocation':
                self.invocations.append(e)
            elif k == 'Response':
                self.responses[e['UniqueID']] = e
            elif k == 'TimerFired':
                self.timer_fired += 1
        for lst in self.crash.values():
            lst.sort()
        for lst in self.recover.values():
            lst.sort()

        self.msgs = {}
        self.disp_by_ns = defaultdict(list)
        self.enter_by_ns = {}
        self.enter_dupes = 0
        n_init = 0
        for t in dump['traces']:
            self.max_step = max(self.max_step, t['Step'])
            m = self.msgs.get(t['TraceID'])
            if m is None:
                m = Msg(t['TraceID'], t['FunctionName'])
                self.msgs[t['TraceID']] = m
            kind = t['TraceKind']
            if kind == 'Dispatch':
                m.D = t
                self.disp_by_ns[(t['NodeID'], t['Step'])].append(t)
            elif kind == 'Enter':
                m.E = t
                key = (t['NodeID'], t['Step'])
                if key in self.enter_by_ns:
                    self.enter_dupes += 1
                else:
                    self.enter_by_ns[key] = m
                if t['FunctionName'] == INIT:
                    n_init += 1
            elif kind == 'Exit':
                m.X = t
        self.n_servers = n_init
        for m in self.msgs.values():
            if m.D is not None:
                m.sender = m.D['NodeID']
                m.d_step = m.D['Step']
            if m.E is not None:
                m.receiver = m.E['NodeID']
                m.e_step = m.E['Step']
                m.handler = self.disp_by_ns.get((m.receiver, m.e_step), [])
            src = m.E if m.E is not None else m.D
            m.args = parse_list(src['Payload']) if src is not None else []
            m.view = as_int(m.args[0]) if m.args else None
        self.unattributed = 0
        self.fallback_attributed = 0
        enters_by_node = defaultdict(list)
        for m in self.msgs.values():
            if m.E is not None:
                enters_by_node[m.receiver].append(m)
        for (node, step), ds in self.disp_by_ns.items():
            if (node, step) in self.enter_by_ns:
                continue
            for d in ds:
                owner = None
                if fallback:
                    for m in enters_by_node.get(node, []):
                        if m.E['SeqNum'] < d['SeqNum'] and (
                                m.X is None or m.X['SeqNum'] > d['SeqNum']):
                            if owner is None or m.E['SeqNum'] > owner.E['SeqNum']:
                                owner = m
                if owner is None:
                    self.unattributed += 1
                else:
                    owner.handler = owner.handler + [d]
                    self.fallback_attributed += 1

        # Per-node state timeline reconstructed from the spec's own log lines.
        events = defaultdict(list)
        self.rc = defaultdict(list)
        self.evc = defaultdict(list)
        self.views = set()
        self.n_vc_entries = 0
        for l in dump['logs']:
            self.max_step = max(self.max_step, l['step'])
            text = log_text(l['content'])
            step, seq = l['step'], l['seq_num']
            mo = RE_INIT.match(text)
            if mo:
                events[int(mo.group(1))].append((step, seq, NORMAL, 0))
                self.views.add(0)
                continue
            mo = RE_REC_START.match(text)
            if mo:
                events[int(mo.group(1))].append((step, seq, RECOVERING, None))
                continue
            mo = RE_REC_DONE.match(text)
            if mo:
                n, v = int(mo.group(1)), int(mo.group(2))
                events[n].append((step, seq, NORMAL, v))
                self.rc[n].append((step, v))
                self.views.add(v)
                continue
            mo = RE_ENTER_VC.match(text)
            if mo:
                n, v = int(mo.group(1)), int(mo.group(2))
                events[n].append((step, seq, VIEW_CHANGE, v))
                self.evc[n].append((step, v))
                self.views.add(v)
                self.n_vc_entries += 1
                continue
            mo = RE_ENTER_NORMAL.match(text)
            if mo:
                n, v = int(mo.group(1)), int(mo.group(2))
                events[n].append((step, seq, NORMAL, v))
                self.views.add(v)
        self.state_events = {}
        self.state_steps = {}
        for n, lst in events.items():
            lst.sort(key=lambda x: (x[0], x[1]))
            # A recovery start carries no view; the view survives from the
            # previous state.
            filled = []
            view = 0
            for step, seq, status, v in lst:
                if v is not None:
                    view = v
                filled.append((step, status, view))
            self.state_events[n] = filled
            self.state_steps[n] = [x[0] for x in filled]

    def state_before(self, node, step):
        """(status, view) of `node` from the last log event strictly before
        `step`, or None when the node logged nothing before it."""
        steps = self.state_steps.get(node)
        if not steps:
            return None
        i = bisect.bisect_left(steps, step)
        if i == 0:
            return None
        _, status, view = self.state_events[node][i - 1]
        return status, view

    def between(self, steps, lo, hi):
        """True when some value in the sorted list `steps` lies strictly
        between lo and hi."""
        i = bisect.bisect_right(steps, lo)
        return i < len(steps) and steps[i] < hi

    def ghost(self, m):
        if m.sender is None or m.E is None:
            return False
        return self.between(self.crash.get(m.sender, []), m.d_step, m.e_step)

    def restarted(self, m):
        if m.sender is None or m.E is None:
            return False
        return self.between(self.recover.get(m.sender, []), m.d_step, m.e_step)

    @staticmethod
    def acted(m):
        return len(m.handler) > 0

    def fanout_group(self, m):
        """(FunctionName, count) of the largest same-named dispatch group the
        handler made, or None when the handler dispatched nothing."""
        if not m.handler:
            return None
        c = Counter(d['FunctionName'] for d in m.handler)
        name, cnt = c.most_common(1)[0]
        return name, cnt

    def is_fanout(self, m):
        g = self.fanout_group(m)
        return g is not None and g[1] >= self.n_servers - 1

    def enters(self, func=None, node=None, sender=None):
        for m in self.msgs.values():
            if m.E is None:
                continue
            if func is not None and m.func != func:
                continue
            if node is not None and m.receiver != node:
                continue
            if sender is not None and m.sender != sender:
                continue
            yield m


def classify_unacted(run, m):
    """Why a StartViewChange the receiver did not act on was dropped, from the
    receiver's reconstructed state just before delivery."""
    st = run.state_before(m.receiver, m.e_step)
    if st is None or m.view is None:
        return 'unknown'
    status, view = st
    if status == RECOVERING:
        return 'receiver_recovering'
    if m.view < view:
        return 'stale_view'
    if m.view == view and status == NORMAL:
        return 'same_view_receiver_normal'
    if m.view == view and status == VIEW_CHANGE:
        return 'same_view_in_view_change'
    return 'other'


def evaluate(run):
    r = {}
    r['n_servers'] = run.n_servers
    r['n_crash'] = sum(len(v) for v in run.crash.values())
    r['n_recover'] = sum(len(v) for v in run.recover.values())
    r['n_timer_fired'] = run.timer_fired
    r['n_enter_dupes'] = run.enter_dupes
    r['n_unattributed_dispatches'] = run.unattributed
    r['n_fallback_dispatches'] = run.fallback_attributed
    r['n_views'] = len(run.views)
    r['n_vc_entries'] = run.n_vc_entries
    r['last_step'] = run.max_step
    r['steps'] = None
    msgs = [m for m in run.msgs.values() if m.E is not None and m.D is not None]
    r['n_msgs'] = len(msgs)
    ghosts = [m for m in msgs if run.ghost(m)]
    r['n_ghost'] = len(ghosts)
    r['n_ghost_restarted'] = sum(1 for m in ghosts if run.restarted(m))
    r['n_ghost_acted'] = sum(1 for m in ghosts if run.acted(m))
    n = run.n_servers
    majority = n // 2 + 1

    # Funnel R1-R4 on the StartViewChange 1->2 delivery and node 2's reaction.
    svc12 = sorted(run.enters(SVC, node=2, sender=1), key=lambda m: m.e_step)
    r['n_svc_1_to_2'] = len(svc12)
    r1_msgs = [m for m in svc12 if run.ghost(m)]
    r['n_ghost_svc_1_to_2'] = len(r1_msgs)
    r['R1'] = bool(r1_msgs)
    crash1 = run.crash.get(1, [])
    first_after = next((m for m in svc12 if crash1 and m.e_step > crash1[0]), None)
    r['R1_first'] = first_after is not None and run.ghost(first_after)
    rec1 = run.recover.get(1, [])
    r['R1_fresh_only'] = (not r['R1']) and bool(rec1) and any(
        m.d_step > rec1[0] for m in svc12)
    r2_msgs = [m for m in r1_msgs if run.acted(m)]
    r['R2'] = bool(r2_msgs)
    unacted = [m for m in r1_msgs if not run.acted(m)]
    classes = [classify_unacted(run, m) for m in unacted]
    r['R2_class'] = classes[0] if (r['R1'] and not r['R2']) else ''
    r['R2_classes_all'] = '|'.join(classes)
    reactions = []
    for m in r2_msgs:
        for h in m.handler:
            hm = run.msgs[h['TraceID']]
            if hm.E is None:
                if any(c > h['Step'] for c in run.crash.get(2, [])):
                    reactions.append(hm)
            elif run.ghost(hm):
                reactions.append(hm)
    r['R3'] = bool(reactions)
    r4 = False
    r4_loose = False
    for hm in reactions:
        if hm.E is None or hm.receiver != 1:
            continue
        if not (run.ghost(hm) and run.restarted(hm)):
            continue
        if run.acted(hm):
            r4 = True
            r4_loose = True
        elif hm.func == DVC:
            # A first DoViewChange at the primary is counted without any
            # dispatch; the receiver's state says whether it was counted.
            st = run.state_before(1, hm.e_step)
            if st is not None and st[0] == VIEW_CHANGE and st[1] == hm.view:
                r4_loose = True
    r['R4'] = r4
    r['R4_loose'] = r4_loose
    r4_classes = []
    for hm in reactions:
        if hm.E is None:
            r4_classes.append('undelivered_%s' % hm.func.split('.')[-1])
        elif hm.receiver != 1:
            r4_classes.append('to_other_node')
        elif not run.restarted(hm):
            r4_classes.append('sender_not_restarted')
        elif run.acted(hm):
            r4_classes.append('acted')
        else:
            r4_classes.append(classify_unacted(run, hm))
    r['R4_classes_all'] = '|'.join(r4_classes)
    r['R4_class'] = ''
    if r['R3'] and not r4:
        delivered = [(hm.e_step, c) for hm, c in zip(reactions, r4_classes)
                     if hm.E is not None and hm.receiver == 1]
        r['R4_class'] = min(delivered)[1] if delivered else 'none_delivered_to_node_1'

    # P1: two acted ghosts from restarted senders; the VR pair and its order.
    gra_senders = {m.sender for m in ghosts if run.restarted(m) and run.acted(m)}
    r['P1a'] = len(gra_senders) >= 2
    p1b = False
    p1c = False
    svc21 = [m for m in run.enters(SVC, node=1, sender=2)
             if run.ghost(m) and run.restarted(m) and run.acted(m)]
    dvc21 = list(run.enters(DVC, node=1, sender=2))
    for m1 in r2_msgs:
        for m2 in svc21:
            if m2.d_step < m1.e_step:
                continue
            p1b = True
            for m3 in dvc21:
                if m3.d_step != m2.d_step or m3.e_step <= m2.e_step:
                    continue
                s2 = run.state_before(1, m2.e_step)
                s3 = run.state_before(1, m3.e_step)
                if s2 and s3 and s2[0] != RECOVERING and s3[0] != RECOVERING:
                    p1c = True
    r['P1b'] = p1b
    r['P1c'] = p1c

    def recovery_overtakes(receiver, sender, ghost, before_step):
        """True when the sender's Recovery request from the incarnation that
        follows the crash making `ghost` a ghost was delivered to and answered
        by `receiver` before `before_step`."""
        crashes = [c for c in run.crash.get(sender, []) if ghost.d_step < c < ghost.e_step]
        if not crashes:
            return False
        for m in run.enters('Node.Recovery', node=receiver, sender=sender):
            if m.d_step > crashes[0] and m.e_step < before_step and run.acted(m):
                return True
        return False

    r['P4_nl'] = any(recovery_overtakes(2, 1, m1, m1.e_step) for m1 in r1_msgs)

    # P2: the DoViewChange whose handler broadcast StartView, and the exact
    # quorum window since the receiver entered that view.
    fanouts = []
    for m in run.enters(DVC):
        if sum(1 for d in m.handler if d['FunctionName'] == SV) >= n - 1:
            fanouts.append(m)
    fanouts.sort(key=lambda m: m.e_step)
    r['n_fanouts'] = len(fanouts)
    p2b_hits = []
    p2c = False
    for ms in fanouts:
        p, f, v = ms.receiver, ms.e_step, ms.view
        starts = [s for s, vv in run.evc.get(p, []) if vv == v and s <= f]
        start = max(starts) if starts else -1
        window = [m for m in run.enters(DVC, node=p)
                  if m.view == v and start <= m.e_step <= f]
        gh = [m for m in window if m.sender != p and run.ghost(m)]
        if not gh:
            continue
        g = min(gh, key=lambda m: m.e_step)
        p2b_hits.append((ms, g, start, window))
        rcs_p = [s for s, _ in run.rc.get(p, []) if s < f]
        if run.restarted(g) and (not rcs_p or max(rcs_p) < min(m.e_step for m in window)):
            p2c = True
    r['n_ghost_fanouts'] = len(p2b_hits)
    r['P2b'] = bool(p2b_hits)
    r['P2c'] = p2c
    r['P2b_sender_rc'] = ''
    r['P2b_sender_rc_any'] = ''
    r['P2b_detail'] = ''
    ghost_fanout = None
    r['P4_2'] = False
    if p2b_hits:
        ms, g, start, window = p2b_hits[0]
        ghost_fanout = (ms, g)
        r['P4_2'] = recovery_overtakes(ms.receiver, g.sender, g, start)
        rcs = [(s, vv) for s, vv in run.rc.get(g.sender, []) if g.d_step < s < g.e_step]
        if not rcs:
            r['P2b_sender_rc'] = 'none'
        else:
            s, vv = max(rcs)
            r['P2b_sender_rc'] = 'old_view' if vv < ms.view else 'new_view'
        # The sender's first completed recovery after the ghost was sent,
        # wherever in the run it lands.
        later = [(s, vv) for s, vv in run.rc.get(g.sender, []) if s > g.d_step]
        if not later:
            r['P2b_sender_rc_any'] = 'none'
        else:
            s, vv = min(later)
            r['P2b_sender_rc_any'] = '%s@%d' % ('old_view' if vv < ms.view else 'new_view', s)
        r['P2b_detail'] = 'p=%d f=%d v=%s start=%d window=%s ghost=trace%d %d->%d D@%d E@%d restarted=%d' % (
            ms.receiver, ms.e_step, ms.view, start,
            ','.join('%d:%d@%d' % (m.tid, m.sender, m.e_step) for m in window),
            g.tid, g.sender, g.receiver, g.d_step, g.e_step, run.restarted(g))

    # P2a: generic form of the same window. The receiver's own most recent
    # n-1 broadcast carrying the same first argument opens the window, and
    # the window never reaches back across the receiver's latest restart,
    # which erased whatever it had counted; the window must hold a majority
    # of distinct senders, self-sends included.
    p2a = False
    p2a_r = False
    bcast_by_node = defaultdict(list)
    for (node, step), ds in run.disp_by_ns.items():
        c = Counter((d['FunctionName'], (parse_list(d['Payload']) or [None])[0]) for d in ds)
        for (fn, key), cnt in c.items():
            if cnt >= n - 1:
                bcast_by_node[node].append((step, fn, key))
    for ms in run.msgs.values():
        if ms.E is None or not run.is_fanout(ms):
            continue
        rnode, f = ms.receiver, ms.e_step
        key = ms.args[0] if ms.args else None
        starts = [s for s, fn, k in bcast_by_node.get(rnode, []) if k == key and s < f]
        if not starts:
            continue
        start = max(starts + [s for s in run.recover.get(rnode, []) if s < f])
        window = [m for m in run.enters(ms.func, node=rnode)
                  if (m.args[0] if m.args else None) == key and start <= m.e_step <= f]
        if len({m.sender for m in window}) < majority:
            continue
        gh = [m for m in window if m.sender != rnode and run.ghost(m)]
        if gh:
            p2a = True
            if any(run.restarted(m) for m in gh):
                p2a_r = True
    r['P2a'] = p2a
    r['P2a_r'] = p2a_r

    # P3: an old-view commit at another node after the StartView fan-out was
    # sent and before that node received its StartView.
    writes = []
    for inv in run.invocations:
        if inv['Action'] != WRITE:
            continue
        resp = run.responses.get(inv['UniqueID'])
        if resp is None:
            continue
        writes.append((inv, resp, node_of(inv['Payload'])))
    prepares_by_uid = defaultdict(set)
    for m in run.msgs.values():
        if m.func == PREPARE and m.D is not None and m.D.get('CausalOperationID') is not None:
            a = parse_list(m.D['Payload'])
            if len(a) >= 3:
                prepares_by_uid[(m.sender, m.D['CausalOperationID'])].add((a[0], a[2]))
    poks_by_node = defaultdict(list)
    for m in run.enters(PREPARE_OK):
        poks_by_node[m.receiver].append(m)

    def startview_to(ms, d):
        for h in ms.handler:
            if h['FunctionName'] != SV:
                continue
            hm = run.msgs[h['TraceID']]
            if hm.E is not None and hm.receiver == d:
                return hm
        return None

    def in_startview_log(ms, uid):
        for h in ms.handler:
            if h['FunctionName'] == SV:
                args = parse_list(h['Payload'])
                return len(args) > 1 and ('"uid": Some(%d)' % uid) in args[1]
        return False

    def p3_for(ms):
        """The earliest commit inside ms's window as
        (PrepareOK step, write uid, node, invocation step, StartView step,
        uid present in the fan-out's log)."""
        p, f, v = ms.receiver, ms.e_step, ms.view
        if v is None:
            return None
        best = None
        for inv, resp, d in writes:
            if d == p or d is None:
                continue
            uid = inv['UniqueID']
            keys = prepares_by_uid.get((d, uid), set())
            sv = startview_to(ms, d)
            for pok in poks_by_node.get(d, []):
                if pok.e_step <= f or pok.view is None or pok.view >= v:
                    continue
                if not any(h['FunctionName'] == COMMIT for h in pok.handler):
                    continue
                joined = pok.E.get('CausalOperationID') == uid or (
                    len(pok.args) >= 2 and (pok.args[0], pok.args[1]) in keys)
                if not joined:
                    continue
                if sv is not None and sv.E is not None and sv.e_step <= pok.e_step:
                    continue
                cand = (pok.e_step, uid, d, inv['Step'], sv.e_step if sv is not None else None,
                        in_startview_log(ms, uid))
                if best is None or cand < best:
                    best = cand
        return best

    p3_any = None
    for ms in fanouts:
        hit = p3_for(ms)
        if hit is not None:
            p3_any = (ms, hit)
            break
    r['P3'] = p3_any is not None
    r['P3_lost'] = p3_any is not None and not p3_any[1][5]
    r['P3_issued_after'] = p3_any is not None and p3_any[1][3] > p3_any[0].e_step
    r['P3_detail'] = ''
    if p3_any is not None:
        ms, (pstep, uid, d, istep, svstep, in_log) = p3_any
        r['P3_detail'] = 'p=%d f=%d v=%s d=%d uid=%s inv@%d prepareok@%d startview_to_d@%s in_new_log=%d' % (
            ms.receiver, ms.e_step, ms.view, d, uid, istep, pstep, svstep, in_log)
    r['P3_ghost'] = False
    r['P3_ghost_lost'] = False
    r['P3_old_view_recovery'] = False
    if ghost_fanout is not None:
        ms, g = ghost_fanout
        hit = p3_for(ms)
        if hit is not None:
            r['P3_ghost'] = True
            r['P3_ghost_lost'] = not hit[5]
            pstep = hit[0]
            r['P3_old_view_recovery'] = any(
                vv < ms.view and g.d_step < s < pstep for s, vv in run.rc.get(g.sender, []))

    # P3a/P3b as first proposed: the write's response inside the broadcast
    # window, and the write's Prepares carrying a view below the new view.
    p3a = False
    p3a_c = False
    for ms in run.msgs.values():
        if ms.E is None or not run.is_fanout(ms):
            continue
        p, f = ms.receiver, ms.e_step
        grp = run.fanout_group(ms)[0]
        for inv, resp, d in writes:
            if d == p or resp['Step'] <= f:
                continue
            to_d = None
            for h in ms.handler:
                if h['FunctionName'] != grp:
                    continue
                hm = run.msgs[h['TraceID']]
                if hm.E is not None and hm.receiver == d:
                    to_d = hm
            if to_d is None or to_d.e_step > resp['Step']:
                p3a = True
                if inv['Step'] > f:
                    p3a_c = True
    r['P3a'] = p3a
    r['P3a_c'] = p3a_c
    p3b = False
    p3b_d0 = False
    p3b_same = False
    for ms in fanouts:
        p, f, v = ms.receiver, ms.e_step, ms.view
        for inv, resp, d in writes:
            if d == p or d is None or resp['Step'] <= f:
                continue
            sv = startview_to(ms, d)
            if sv is not None and sv.e_step <= resp['Step']:
                continue
            keys = prepares_by_uid.get((d, inv['UniqueID']), set())
            views = [as_int(k[0]) for k in keys]
            if not views or any(x is None or v is None or x >= v for x in views):
                continue
            p3b = True
            if d == 0:
                p3b_d0 = True
            if ghost_fanout is not None and ghost_fanout[0] is ms:
                p3b_same = True
    r['P3b'] = p3b
    r['P3b_d0'] = p3b_d0
    r['P2b_and_P3b'] = r['P2b'] and p3b
    r['P2b_and_P3b_d0'] = r['P2b'] and p3b_d0
    r['P2b_and_P3b_same'] = p3b_same
    return r


def dump_run(traceanalyzer, db, run_id):
    out = subprocess.run([traceanalyzer, '-input', db, '-dump-run', str(run_id)],
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def worker(job):
    traceanalyzer, pop, db, run_id, depth, violating, steps, end_reason = job
    try:
        run = Run(dump_run(traceanalyzer, db, run_id), fallback=not SAME_STEP_ONLY)
        row = evaluate(run)
    except Exception as e:  # a failed dump is reported, not fatal
        return {'pop': pop, 'db': db, 'run_id': run_id, 'error': str(e)}
    row['pop'] = pop
    row['db'] = db
    row['run_id'] = run_id
    row['depth'] = depth
    row['violating'] = violating
    if steps is not None:
        row['steps'] = steps
    row['end_reason'] = end_reason or ''
    row['R5'] = row['R4'] and row['P2b']
    row['R6'] = row['R5'] and row['P3_ghost']
    row['R7'] = row['R6'] and bool(violating)
    return row


def read_ids(path):
    ids = []
    with open(path) as fh:
        for line in fh:
            line = line.split('#', 1)[0]
            ids.extend(int(x) for x in line.replace(',', ' ').split())
    return ids


def read_depths(path):
    with open(path) as fh:
        g = json.load(fh)
    return {rid: d for rid, d in g['grade_dags'][0]['run_depths']}


def read_runs_table(path):
    with open(path) as fh:
        rows = json.load(fh)
    return {r['run_id']: (r.get('steps_used'), r.get('end_reason')) for r in rows}


def parse_kv(items):
    out = {}
    for it in items or []:
        k, v = it.split('=', 1)
        out[k] = v
    return out


def cmd_select(a):
    depths = read_depths(a.grade)
    exclude = set(read_ids(a.exclude)) if a.exclude else set()
    ids = sorted(rid for rid, d in depths.items() if d == a.depth and rid not in exclude)
    if a.sample and a.sample < len(ids):
        rng = random.Random(a.seed)
        ids = sorted(rng.sample(ids, a.sample))
    print(' '.join(str(x) for x in ids))


def quantiles(values):
    vals = sorted(values)
    if not vals:
        return {}

    def q(p):
        k = (len(vals) - 1) * p
        lo, hi = int(k), min(int(k) + 1, len(vals) - 1)
        return vals[lo] + (vals[hi] - vals[lo]) * (k - lo)
    return {'min': vals[0], 'q1': q(0.25), 'median': q(0.5), 'q3': q(0.75), 'max': vals[-1],
            'mean': sum(vals) / len(vals)}


def summarize(rows):
    pops = defaultdict(list)
    for r in rows:
        if 'error' in r:
            continue
        pops[r['pop']].append(r)
    summary = {'populations': {}, 'precision_recall': {}}
    for pop, rs in sorted(pops.items()):
        s = {'n': len(rs), 'violating': sum(1 for r in rs if r['violating'])}
        s['predicates'] = {}
        for f in BOOL_FIELDS:
            c = sum(1 for r in rs if r[f])
            s['predicates'][f] = {'count': c, 'rate': c / len(rs)}
        funnel = []
        prev = len(rs)
        for k in FUNNEL:
            c = sum(1 for r in rs if r[k])
            funnel.append({'rung': k, 'survivors': c, 'rate': c / len(rs),
                           'conditional': (c / prev) if prev else None,
                           'lost': prev - c})
            prev = c
        s['funnel'] = funnel
        s['R2_class'] = dict(Counter(r['R2_class'] for r in rs if r['R2_class']))
        s['R2_classes_all_messages'] = dict(Counter(
            c for r in rs for c in r['R2_classes_all'].split('|') if c))
        s['R4_class'] = dict(Counter(r['R4_class'] for r in rs if r['R4_class']))
        s['R4_classes_all_messages'] = dict(Counter(
            c for r in rs for c in r['R4_classes_all'].split('|') if c))
        s['P2b_sender_rc'] = dict(Counter(r['P2b_sender_rc'] for r in rs if r['P2b_sender_rc']))
        s['P2b_sender_rc_any'] = dict(Counter(
            r['P2b_sender_rc_any'].split('@')[0] for r in rs if r['P2b_sender_rc_any']))
        s['P3_old_view_recovery_among_P3_ghost'] = {
            'P3_ghost': sum(1 for r in rs if r['P3_ghost']),
            'old_view_recovery': sum(1 for r in rs if r['P3_old_view_recovery'])}
        s['end_reason'] = dict(Counter(r['end_reason'] for r in rs))
        s['n_views'] = quantiles([r['n_views'] for r in rs])
        s['n_vc_entries'] = quantiles([r['n_vc_entries'] for r in rs])
        s['steps'] = quantiles([r['steps'] for r in rs if r['steps'] is not None])
        s['last_step'] = quantiles([r['last_step'] for r in rs])
        s['n_ghost'] = quantiles([r['n_ghost'] for r in rs])
        s['n_fanouts'] = quantiles([r['n_fanouts'] for r in rs])
        s['n_enter_dupes'] = sum(r['n_enter_dupes'] for r in rs)
        s['agreement'] = {
            'P2a_vs_P2b': sum(1 for r in rs if r['P2a'] == r['P2b']) / len(rs),
            'P2a_r_vs_P2c': sum(1 for r in rs if r['P2a_r'] == r['P2c']) / len(rs)}
        summary['populations'][pop] = s
    # Precision and recall for violation, per database, over every censused
    # run of that database and over its runs at depth >= 8.
    by_db = defaultdict(list)
    for r in rows:
        if 'error' not in r:
            by_db[r['db']].append(r)
    preds = ['P1c', 'P4_nl', 'P4_2', 'P2b', 'P2c', 'P3', 'P3_lost', 'P3_ghost', 'P3_ghost_lost', 'P3b',
             'P2b_and_P3b', 'P2b_and_P3b_d0', 'P2b_and_P3b_same', 'P2a', 'P3a', 'R4', 'R4_loose']
    for db, rs in by_db.items():
        if not any(r['violating'] for r in rs):
            continue
        for label, sub in (('all', rs), ('depth>=8', [r for r in rs if (r['depth'] or 0) >= 8])):
            out = {}
            pos = sum(1 for r in sub if r['violating'])
            for f in preds:
                tp = sum(1 for r in sub if r[f] and r['violating'])
                fp = sum(1 for r in sub if r[f] and not r['violating'])
                out[f] = {'tp': tp, 'fp': fp, 'fn': pos - tp,
                          'precision': tp / (tp + fp) if tp + fp else None,
                          'recall': tp / pos if pos else None}
            summary['precision_recall']['%s (%s, n=%d)' % (db, label, len(sub))] = out
    summary['errors'] = [r for r in rows if 'error' in r]
    return summary


def cmd_census(a):
    global SAME_STEP_ONLY
    SAME_STEP_ONLY = a.same_step_only
    depths = {db: read_depths(p) for db, p in parse_kv(a.depths).items()}
    violating = {db: set(read_ids(p)) for db, p in parse_kv(a.violating).items()}
    runs_tables = {db: read_runs_table(p) for db, p in parse_kv(a.runs_table).items()}
    jobs = []
    for spec in a.pop:
        name, rest = spec.split('=', 1)
        db, ids = rest.rsplit(':', 1)
        for rid in read_ids(ids):
            steps, end = runs_tables.get(db, {}).get(rid, (None, None))
            jobs.append((a.traceanalyzer, name, db, rid, depths.get(db, {}).get(rid),
                         1 if rid in violating.get(db, set()) else 0, steps, end))
    rows = []
    with Pool(a.workers) as pool:
        for i, row in enumerate(pool.imap_unordered(worker, jobs, chunksize=4)):
            rows.append(row)
            if (i + 1) % 200 == 0:
                print('%d/%d' % (i + 1, len(jobs)), file=sys.stderr)
    rows.sort(key=lambda r: (r['pop'], r['run_id']))
    with open(a.csv, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS + ['error'], extrasaction='ignore')
        w.writeheader()
        for r in rows:
            w.writerow({k: (int(v) if isinstance(v, bool) else v) for k, v in r.items()})
    summary = summarize(rows)
    with open(a.json, 'w') as fh:
        json.dump(summary, fh, indent=1, sort_keys=True)
    print('rows=%d errors=%d' % (len(rows), len(summary['errors'])), file=sys.stderr)


def pct(c, n):
    return '%d/%d (%.1f%%)' % (c, n, 100.0 * c / n) if n else '-'


def cmd_tables(a):
    with open(a.json) as fh:
        s = json.load(fh)
    pops = a.pops.split(',') if a.pops else sorted(s['populations'])
    P = s['populations']
    out = []
    out.append('| predicate | ' + ' | '.join(pops) + ' |')
    out.append('|---|' + '---|' * len(pops))
    for f in BOOL_FIELDS:
        out.append('| %s | ' % f + ' | '.join(
            pct(P[p]['predicates'][f]['count'], P[p]['n']) for p in pops) + ' |')
    out.append('')
    out.append('| rung | ' + ' | '.join(pops) + ' |')
    out.append('|---|' + '---|' * len(pops))
    for i, k in enumerate(FUNNEL):
        cells = []
        for p in pops:
            fr = P[p]['funnel'][i]
            cond = '' if fr['conditional'] is None else ' cond %.0f%%' % (100 * fr['conditional'])
            cells.append('%s%s' % (pct(fr['survivors'], P[p]['n']), cond))
        out.append('| %s | ' % k + ' | '.join(cells) + ' |')
    out.append('')
    for field, title in (('R2_class', 'R2 not acted: class of the first ghost'),
                         ('R4_class', 'R4 not acted: class of the first reaction at node 1'),
                         ('R4_classes_all_messages', 'R3 reaction messages by class')):
        keys = sorted({k for p in pops for k in P[p][field]})
        out.append('| %s | ' % title + ' | '.join(pops) + ' |')
        out.append('|---|' + '---|' * len(pops))
        for k in keys:
            out.append('| %s | ' % k + ' | '.join(str(P[p][field].get(k, 0)) for p in pops) + ' |')
        out.append('')
    out.append('| distribution | ' + ' | '.join(pops) + ' |')
    out.append('|---|' + '---|' * len(pops))
    for f in ('n_views', 'n_vc_entries', 'steps', 'last_step', 'n_ghost', 'n_fanouts'):
        cells = []
        for p in pops:
            q = P[p][f]
            cells.append('%g / %g / %g (min %g, max %g)' % (
                q['q1'], q['median'], q['q3'], q['min'], q['max']) if q else '-')
        out.append('| %s q1/median/q3 | ' % f + ' | '.join(cells) + ' |')
    out.append('')
    out.append('| ghost DVC sender recovery before consumption | ' + ' | '.join(pops) + ' |')
    out.append('|---|' + '---|' * len(pops))
    for k in ('none', 'old_view', 'new_view'):
        out.append('| before consumption: %s | ' % k + ' | '.join(str(P[p]['P2b_sender_rc'].get(k, 0)) for p in pops) + ' |')
    for k in ('none', 'old_view', 'new_view'):
        out.append('| anywhere later: %s | ' % k + ' | '.join(str(P[p]['P2b_sender_rc_any'].get(k, 0)) for p in pops) + ' |')
    out.append('')
    for name, pr in s['precision_recall'].items():
        out.append('Precision / recall for violation on %s' % name)
        out.append('')
        out.append('| predicate | tp | fp | fn | precision | recall |')
        out.append('|---|---|---|---|---|---|')
        for f, v in pr.items():
            out.append('| %s | %d | %d | %d | %s | %s |' % (
                f, v['tp'], v['fp'], v['fn'],
                '-' if v['precision'] is None else '%.3f' % v['precision'],
                '-' if v['recall'] is None else '%.3f' % v['recall']))
        out.append('')
    print('\n'.join(out))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('select')
    s.add_argument('--grade', required=True)
    s.add_argument('--depth', type=int, required=True)
    s.add_argument('--exclude')
    s.add_argument('--sample', type=int, default=0)
    s.add_argument('--seed', type=int, default=1)
    s.set_defaults(fn=cmd_select)
    c = sub.add_parser('census')
    c.add_argument('--pop', action='append', required=True,
                   help='NAME=DB_DIR:ID_FILE; repeatable')
    c.add_argument('--depths', action='append', help='DB_DIR=GRADE_JSON')
    c.add_argument('--violating', action='append', help='DB_DIR=ID_FILE')
    c.add_argument('--runs-table', action='append', help='DB_DIR=RUNS_JSON')
    c.add_argument('--traceanalyzer', default='traceanalyzer/main')
    c.add_argument('--workers', type=int, default=8)
    c.add_argument('--same-step-only', action='store_true',
                   help='attribute dispatches to handlers by same step only')
    c.add_argument('--csv', required=True)
    c.add_argument('--json', required=True)
    c.set_defaults(fn=cmd_census)
    t = sub.add_parser('tables')
    t.add_argument('--json', required=True)
    t.add_argument('--pops', help='comma-separated population names in column order')
    t.set_defaults(fn=cmd_tables)
    a = ap.parse_args()
    a.fn(a)


if __name__ == '__main__':
    main()
