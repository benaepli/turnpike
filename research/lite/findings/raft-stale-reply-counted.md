# Raft.spur: a reply from a superseded term counted as current

Classification: **implementation bug** (translation error, not a paper bug).

Spec: `bin/spur/Raft.spur` (Raft, extended Raft paper figure 2). Workload: 5
servers, 3-5 writes, 1-2 reads, 1 key, 1-2 concurrent writes, 2-4 crashes with
recovery. Seed 1000, one exhausted grid of 1,440,000 runs: **800 violating
runs**, a rate of 5.6e-4.

## Root cause

Figure 2 gives each RPC reply a term, and the receiver's rule is two-sided: a
reply with a higher term makes the receiver step down, and a reply with a
lower term is from a superseded incarnation and carries no information about
the current one. Both reply handlers implemented only the first half:
`AppendEntriesReply` (`Raft.spur:379`) and `RequestVoteReply` (`:464`) tested
`resp_term > current_term` and then fell through to counting the reply.

So a vote granted in term T could be counted after the candidate had already
advanced to T+1, and an acknowledgement sent in term T could raise
`match_index` for a leader now in T+1. At three servers the first is a second
leader in one term. At five the acknowledged entry can be committed on a
follower whose log the next leader truncates.

## Why implementation and not paper

The paper's reply path drops stale replies; nothing in figure 2 counts a reply
whose term is not the receiver's own. The panel's `panel/raft_clean.spur` has
carried the guard at both handlers since the panel was built, precisely
because the members had to be seeded on a host without this defect.

## Fix, applied to `bin/spur/Raft.spur`

Both handlers return without acting when `resp_term != current_term`, after
the step-down test (`Raft.spur:390-394`, `:475-479`). This is the same guard
`panel/raft_clean.spur` carries, so the two files are now identical.

| spec | runs | violating runs |
| --- | --- | --- |
| before the fix | 1,440,000 | 800 |
| after the fix | 1,440,000 | 0 |

Same binary, same seed, same grid; both grids exhausted inside the wall.

## What the rate says

The defect had been recorded as unmeasured: 200 runs at 3 servers, 0
violations. At 5 servers with 2-4 crashes it is 5.6e-4, higher than every
seeded Raft panel member's calibrated rate and a quarter of Raft's measured
detection ceiling of 0.0021. The server count, not the defect, was what the
earlier reading was measuring.

The panel is unaffected: its Raft members are all seeded from
`panel/raft_clean.spur`, which never had the defect.
