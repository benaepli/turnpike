# State edits (SQLite via the typed LoopState)

Run from `research/orchestrator`. Upserts are safe while the daemon runs;
the daemon reads the pool at selection time.

Requeue a hypothesis that was closed or blocked by a harness bug (never one
closed on evidence):

```bash
npx tsx -e "
const { LoopState } = require('./src/state.ts');
const st = new LoopState();
const h = st.getHypothesis('HYPOTHESIS_ID');
if (h && h.status !== 'proposed') st.upsertHypothesis({ ...h, status: 'proposed', branch: null, notes: 'requeued: REASON' });
console.log(st.countByStatus()); st.close();"
```

Close a stale proposal (for example one that targets orchestrator code no
agent lane can reach):

```bash
npx tsx -e "
const { LoopState } = require('./src/state.ts');
const st = new LoopState();
const h = st.getHypothesis('HYPOTHESIS_ID');
if (h && h.status === 'proposed') st.upsertHypothesis({ ...h, status: 'closed', notes: 'REASON' });
st.close();"
```

Inspect an evaluation:

```bash
npx tsx -e "
const { LoopState } = require('./src/state.ts');
const st = new LoopState();
for (const e of st.evaluationsFor('HYPOTHESIS_ID')) { const m = e.metrics; const g = m.gradedRuns || 1; console.log(e.fidelity, e.seed, 'ok', e.ok, e.error ?? '', 'runs', m.runs, 'P>=4', ((m.depthAtLeast[3]??0)/g).toFixed(4), 'P>=5', ((m.depthAtLeast[4]??0)/g).toFixed(4), 'h1', m.h1Rate.toFixed(3), 'h2', m.h2Rate.toFixed(3), 'rps', m.runsPerSec.toFixed(0), 'suspended', e.suspendedMs); }
st.close();"
```

Load new seeds: edit `research/seed_hypotheses.json`, then `npx tsx src/cli.ts seed`.
