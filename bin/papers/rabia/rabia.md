## Algorithm 1: Rabia SMR Framework — Code for Replica N_i

```text
Local Variables:
    PQ_i            ▷priority queue, initially empty
    seq             ▷current slot index, initially 0

Code for Replica N_i:
1:  while true do
2:      proposal_i ← first element in PQ_i that is not already in log
                     ▷proposal_i is i's input to Weak-MVC
3:      output ← Weak-MVC(proposal_i, seq)
4:      log[seq] ← output          ▷Add output to current slot
5:      if output = ⊥ or output ≠ proposal_i then
6:          PQ_i.push(proposal_i)
7:      seq ← seq + 1

/* Event handler: executing in background */
Upon receiving ⟨REQUEST, c⟩ from client c:
8:  PQ_i.push(⟨REQUEST, c⟩)
9:  forward ⟨REQUEST, c⟩ to all other replicas

/* Executing in background periodically */
Log Compaction:
10: for each j-th slot in the log do
11:     if log[j] has been executed locally then
12:         truncate log[j]         ▷Discard it or take a snapshot
```

---

## Algorithm 2: Weak-MVC — Code for Replica i

```text
When Weak-MVC is invoked with input q and seq:
1:  // Exchange Stage: exchange proposals
2:  Send (PROPOSAL, q) to all              ▷q is client request
3:  wait until receiving ≥ n − f PROPOSAL messages
4:  if request q appears ≥ ⌊n/2⌋ + 1 times in PROPOSALs then
5:      state ← 1
6:  else
7:      state ← 0

8:  // Randomized Binary Consensus Stage (Phase p ≥ 1)
9:  p ← 1                                  ▷Start with Phase 1
10: while true do
11:     /* Round 1 */
12:     Send (STATE, p, state) to all       ▷state can be 0 or 1
13:     wait until receiving ≥ n − f phase-p STATE messages
14:     if value v appears ≥ ⌊n/2⌋ + 1 times in STATEs then
15:         vote ← v
16:     else
17:         vote ← ?
18:     /* Round 2 */
19:     Send (VOTE, p, vote) to all         ▷vote can be 0, 1 or ?
20:     wait until receiving ≥ n − f phase-p VOTE messages
21:     if a non-? value v appears ≥ f + 1 times in VOTEs then
22:         Return FindReturnValue(v)       ▷Termination
23:     else if a non-? value v appears at least once in VOTEs then
24:         state ← v
25:     else
26:         state ← CommonCoinFlip(p)       ▷p-th coin flip
27:     p ← p + 1                           ▷Proceed to next phase
```

---

## Algorithm 3: Weak-MVC Helper Function

```text
Procedure FindReturnValue(v)
1:  if v = 1 then
2:      Find value m that appears ≥ ⌊n/2⌋ + 1 times
        in PROPOSAL messages received in Phase 0
3:      Return m
4:  else
5:      Return ⊥                            ▷return null value
```
