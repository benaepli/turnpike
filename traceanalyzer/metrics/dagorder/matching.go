package dagorder

import (
	"math/rand/v2"
	"sort"
)

// eventKey identifies an Event for injectivity bookkeeping. Two events with
// the same (Table, Step, IntraSeq) refer to the same Parquet row; we must
// not match two labels to the same row. We can't key on Step alone because
// two rows in different tables can share a step; we can't key on IntraSeq
// alone because each table has its own 0..n counter.
type eventKey struct {
	Table    SourceTable
	Step     int32
	IntraSeq int64
}

func keyOf(e Event) eventKey {
	return eventKey{Table: e.Table, Step: e.Step, IntraSeq: e.IntraSeq}
}

// lessThan reports whether event a strictly precedes event b in the
// simulator's timeline.
//
// Step is the global timeline (path_state.crash_info.current_step), shared
// across tables. seq_num is per-table and not comparable across tables, so
// it is only used as a tie-breaker when both events come from the same
// table. When two events share a step but live in different tables, we
// have no defined ordering, so lessThan returns false in both directions
// - same-step cross-table edges are conservatively treated as
// *unsatisfied* (but still eligible for the denominator).
func lessThan(a, b Event) bool {
	if a.Step != b.Step {
		return a.Step < b.Step
	}
	if a.Table != b.Table {
		return false
	}
	return a.IntraSeq < b.IntraSeq
}

// assignment tracks which concrete Event (by index into the per-label candidate
// slice) each label is currently matched to, or -1 if unmatched.
type assignment struct {
	labels  []string              // stable order
	idxOf   map[string]int        // label -> position in labels
	cands   map[string][]Event    // per-label candidates (sorted asc by Step)
	choice  []int                 // parallel to labels; -1 if unmatched
	usedKey map[eventKey]struct{} // events already claimed (injectivity)
	depOut  map[int][]int         // label-index adjacency (predecessor -> successors)
	depIn   map[int][]int         // label-index adjacency (successor -> predecessors)
	topo    []int                 // topologically sorted label indices
	edges   [][2]int              // deps as label-index pairs
	unmatch map[int]struct{}      // label indices with zero candidates
}

// matchOutcome bundles everything bestMatchingFull derives from one run's
// assignment.
type matchOutcome struct {
	Assign       map[string]Event
	Score        float64  // edge-satisfaction in [0, 1]
	Matched      []string // labels with an assigned event
	ZeroCand     []string // labels with zero candidates
	CrowdedOut   []string // labels that lost all candidates to injectivity
	LongestChain int      // unanchored longest satisfied path (vertices)
	CriticalPath int      // longest path ignoring satisfaction (vertices)
	PrefixDepth  int      // root-anchored longest satisfied chain (vertices, 0 possible)
	PrefixPath   []string // labels forming the winning prefix chain, in order
}

// bestMatchingFull runs greedy topo assignment + random local swaps. This is a
// heuristic: greedy can claim a successor's only candidate for an earlier
// label, and the swap budget is bounded - there is no optimality guarantee.
func bestMatchingFull(
	labels []string,
	cands map[string][]Event,
	directDeps, allDeps [][2]string,
	seed int64,
	nSwaps int,
) matchOutcome {
	a := newAssignment(labels, cands, directDeps, allDeps)

	// Greedy pass in topological order.
	for _, li := range a.topo {
		a.assignEarliestAfterPredecessors(li)
	}

	bestSat, bestElig := a.edgeSatisfaction()
	bestChoice := append([]int(nil), a.choice...)

	if nSwaps > 0 && bestElig > 0 {
		rng := rand.New(rand.NewPCG(uint64(seed), uint64(seed)^0x9E3779B97F4A7C15))
		// Collect label indices that have alternatives.
		var swappable []int
		for li, lbl := range a.labels {
			if len(a.cands[lbl]) >= 1 {
				swappable = append(swappable, li)
			}
		}
		if len(swappable) > 0 {
			for range nSwaps {
				li := swappable[rng.IntN(len(swappable))]
				lbl := a.labels[li]
				candList := a.cands[lbl]
				newChoice := rng.IntN(len(candList)+1) - 1 // -1 means unassign
				if newChoice == a.choice[li] {
					continue
				}
				// Save current assignment for this label, try the swap.
				oldChoice := a.choice[li]
				// Check injectivity for assignment (not needed for unassign).
				if newChoice >= 0 {
					newEvent := candList[newChoice]
					newKey := keyOf(newEvent)
					if _, clash := a.usedKey[newKey]; clash {
						continue
					}
				}
				// Apply
				if oldChoice >= 0 {
					delete(a.usedKey, keyOf(candList[oldChoice]))
				}
				a.choice[li] = newChoice
				if newChoice >= 0 {
					a.usedKey[keyOf(candList[newChoice])] = struct{}{}
				}

				sat, elig := a.edgeSatisfaction()
				if better(sat, elig, bestSat, bestElig) {
					bestSat, bestElig = sat, elig
					bestChoice = append(bestChoice[:0], a.choice...)
				} else {
					// Revert
					if newChoice >= 0 {
						delete(a.usedKey, keyOf(candList[newChoice]))
					}
					a.choice[li] = oldChoice
					if oldChoice >= 0 {
						a.usedKey[keyOf(candList[oldChoice])] = struct{}{}
					}
				}
			}
		}
	}

	// Restore best choice.
	a.choice = bestChoice

	// Build outputs.
	assign := make(map[string]Event, len(a.labels))
	matched := make([]string, 0, len(a.labels))
	zeroCand := make([]string, 0)
	crowdedOut := make([]string, 0)
	for li, lbl := range a.labels {
		if _, u := a.unmatch[li]; u {
			zeroCand = append(zeroCand, lbl)
			continue
		}
		if a.choice[li] < 0 {
			// Had candidates but all were taken by another label due to injectivity.
			crowdedOut = append(crowdedOut, lbl)
			continue
		}
		assign[lbl] = a.cands[lbl][a.choice[li]]
		matched = append(matched, lbl)
	}

	score := 0.0
	if bestElig > 0 {
		score = float64(bestSat) / float64(bestElig)
	}
	sort.Strings(matched)
	sort.Strings(zeroCand)
	sort.Strings(crowdedOut)
	longestChain, criticalPath := a.longestSatisfiableChain()
	prefixDepth, prefixPath := a.rootAnchoredPrefix()
	return matchOutcome{
		Assign:       assign,
		Score:        score,
		Matched:      matched,
		ZeroCand:     zeroCand,
		CrowdedOut:   crowdedOut,
		LongestChain: longestChain,
		CriticalPath: criticalPath,
		PrefixDepth:  prefixDepth,
		PrefixPath:   prefixPath,
	}
}

// bestMatching is the legacy tuple-returning wrapper kept for existing tests.
func bestMatching(
	labels []string,
	cands map[string][]Event,
	directDeps, allDeps [][2]string,
	seed int64,
	nSwaps int,
) (map[string]Event, float64, []string, []string, []string, int, int) {
	o := bestMatchingFull(labels, cands, directDeps, allDeps, seed, nSwaps)
	return o.Assign, o.Score, o.Matched, o.ZeroCand, o.CrowdedOut, o.LongestChain, o.CriticalPath
}

// rootAnchoredPrefix computes the longest satisfied chain that starts at a
// chain root, over the transitive-closure edge set restricted to labels that
// have candidates in this run. A label is a root when every one of its
// closure predecessors is unmatchable in this run (zero candidates) - i.e.
// nothing observable was required before it. Unlike longestSatisfiableChain
// (which is unanchored and never below 1), this measures true prefix
// progress along the plan DAG and is 0 when not even a root was matched.
// Returns the depth in vertices and the winning chain's labels in order.
func (a *assignment) rootAnchoredPrefix() (int, []string) {
	n := len(a.labels)
	closIn := make(map[int][]int, n)
	for _, e := range a.edges {
		closIn[e[1]] = append(closIn[e[1]], e[0])
	}
	assigned := func(li int) bool { return a.choice[li] >= 0 }
	eventOf := func(li int) Event { return a.cands[a.labels[li]][a.choice[li]] }

	dp := make([]int, n)
	parent := make([]int, n)
	for i := range parent {
		parent[i] = -1
	}
	for _, li := range a.topo {
		if _, um := a.unmatch[li]; um {
			continue
		}
		isRoot := true
		best, bestParent := 0, -1
		for _, u := range closIn[li] {
			if _, um := a.unmatch[u]; um {
				continue
			}
			isRoot = false
			if dp[u] >= 1 && assigned(u) && assigned(li) && lessThan(eventOf(u), eventOf(li)) && dp[u]+1 > best {
				best, bestParent = dp[u]+1, u
			}
		}
		switch {
		case isRoot && assigned(li):
			dp[li] = 1
		case isRoot:
			dp[li] = 0
		default:
			dp[li], parent[li] = best, bestParent
		}
	}

	depth, argmax := 0, -1
	for li, d := range dp {
		if d > depth {
			depth, argmax = d, li
		}
	}
	if argmax < 0 {
		return 0, nil
	}
	var path []string
	for v := argmax; v >= 0; v = parent[v] {
		path = append(path, a.labels[v])
	}
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return depth, path
}

// better returns true iff (satA/eligA) > (satB/eligB). Ties -> false.
// When eligB == 0, any eligA > 0 is an improvement.
func better(satA, eligA, satB, eligB int) bool {
	if eligB == 0 {
		return eligA > 0 && satA > 0
	}
	// Compare satA * eligB > satB * eligA without floats.
	return satA*eligB > satB*eligA
}

func newAssignment(labels []string, cands map[string][]Event, directDeps, allDeps [][2]string) *assignment {
	// Stable label order for determinism.
	sortedLabels := append([]string(nil), labels...)
	sort.Strings(sortedLabels)

	idxOf := make(map[string]int, len(sortedLabels))
	for i, l := range sortedLabels {
		idxOf[l] = i
	}

	a := &assignment{
		labels:  sortedLabels,
		idxOf:   idxOf,
		cands:   cands,
		choice:  make([]int, len(sortedLabels)),
		usedKey: make(map[eventKey]struct{}),
		depOut:  make(map[int][]int),
		depIn:   make(map[int][]int),
		unmatch: make(map[int]struct{}),
	}
	for i := range a.choice {
		a.choice[i] = -1
	}

	// Direct edges for topo sort and greedy predecessor checks.
	for _, dep := range directDeps {
		from, okF := idxOf[dep[0]]
		to, okT := idxOf[dep[1]]
		if !okF || !okT {
			continue
		}
		a.depOut[from] = append(a.depOut[from], to)
		a.depIn[to] = append(a.depIn[to], from)
	}

	// All edges (including transitive) for scoring.
	for _, dep := range allDeps {
		from, okF := idxOf[dep[0]]
		to, okT := idxOf[dep[1]]
		if !okF || !okT {
			continue
		}
		a.edges = append(a.edges, [2]int{from, to})
	}

	for li, lbl := range a.labels {
		if len(a.cands[lbl]) == 0 {
			a.unmatch[li] = struct{}{}
		}
	}

	a.topo = topoSort(len(a.labels), a.depIn, a.depOut)
	return a
}

// topoSort returns indices in topological order. Cycles (shouldn't occur) fall
// back to index order for the unresolved tail.
func topoSort(n int, depIn, depOut map[int][]int) []int {
	indeg := make([]int, n)
	for i := range n {
		indeg[i] = len(depIn[i])
	}
	var ready []int
	for i := range n {
		if indeg[i] == 0 {
			ready = append(ready, i)
		}
	}
	sort.Ints(ready)
	var out []int
	for len(ready) > 0 {
		// Pop smallest index for determinism.
		v := ready[0]
		ready = ready[1:]
		out = append(out, v)
		for _, w := range depOut[v] {
			indeg[w]--
			if indeg[w] == 0 {
				// Insert into ready keeping it sorted.
				i := sort.SearchInts(ready, w)
				ready = append(ready, 0)
				copy(ready[i+1:], ready[i:])
				ready[i] = w
			}
		}
	}
	if len(out) < n {
		// Cycle: append remaining in index order.
		seen := make(map[int]bool, len(out))
		for _, v := range out {
			seen[v] = true
		}
		for i := range n {
			if !seen[i] {
				out = append(out, i)
			}
		}
	}
	return out
}

// assignEarliestAfterPredecessors picks the earliest unused candidate for `li`
// that strictly follows every already-assigned predecessor in the lessThan
// order. If no predecessor-respecting candidate exists, the label is left
// unassigned - under the scoring model where unassigned edges count as
// unsatisfied, forcing a bad pick would give the same score on violated
// edges but risk stealing a candidate from another label via injectivity.
// The swap phase can assign or unassign later with global scoring.
func (a *assignment) assignEarliestAfterPredecessors(li int) {
	lbl := a.labels[li]
	cand := a.cands[lbl]
	if len(cand) == 0 {
		return
	}

	// Collect all assigned predecessor events; ev must satisfy
	// lessThan(pred, ev) for every one.
	var preds []Event
	for _, p := range a.depIn[li] {
		c := a.choice[p]
		if c < 0 {
			continue
		}
		preds = append(preds, a.cands[a.labels[p]][c])
	}

	respectsPreds := func(ev Event) bool {
		for _, pred := range preds {
			if !lessThan(pred, ev) {
				return false
			}
		}
		return true
	}

	for i, ev := range cand {
		if _, used := a.usedKey[keyOf(ev)]; used {
			continue
		}
		if respectsPreds(ev) {
			a.choice[li] = i
			a.usedKey[keyOf(cand[i])] = struct{}{}
			return
		}
	}
	// No predecessor-respecting candidate; leave unassigned.
}

// longestSatisfiableChain computes the length of the longest path through the
// DAG where every edge along that path is satisfied (lessThan), plus the
// critical path length (longest path ignoring satisfaction). Both are measured
// in vertex count (a chain of 3 edges gives length 4).
func (a *assignment) longestSatisfiableChain() (longest int, criticalPath int) {
	// dpSat[v] = longest satisfiable path ending at v (vertex count).
	// dpAll[v] = longest path ending at v regardless of satisfaction (critical path).
	dpSat := make([]int, len(a.labels))
	dpAll := make([]int, len(a.labels))
	for i := range dpSat {
		dpSat[i] = 1
		dpAll[i] = 1
	}
	for _, li := range a.topo {
		for _, pred := range a.depIn[li] {
			// Critical path: always extend.
			if dpAll[pred]+1 > dpAll[li] {
				dpAll[li] = dpAll[pred] + 1
			}
			// Satisfiable chain: only extend if edge is satisfied.
			cu, cv := a.choice[pred], a.choice[li]
			if cu < 0 || cv < 0 {
				continue
			}
			eu := a.cands[a.labels[pred]][cu]
			ev := a.cands[a.labels[li]][cv]
			if lessThan(eu, ev) && dpSat[pred]+1 > dpSat[li] {
				dpSat[li] = dpSat[pred] + 1
			}
		}
	}
	for _, v := range dpSat {
		if v > longest {
			longest = v
		}
	}
	for _, v := range dpAll {
		if v > criticalPath {
			criticalPath = v
		}
	}
	return
}

// edgeSatisfaction counts how many DAG edges are satisfied. Edges touching
// a zero-candidate (structurally unmatchable) label are excluded entirely.
// All other edges are eligible: if both endpoints are assigned and ordered
// correctly the edge is satisfied; if either endpoint is unassigned or
// misordered the edge is unsatisfied but still counted in the denominator.
func (a *assignment) edgeSatisfaction() (satisfied, eligible int) {
	for _, e := range a.edges {
		u, v := e[0], e[1]
		if _, um := a.unmatch[u]; um {
			continue
		}
		if _, um := a.unmatch[v]; um {
			continue
		}
		eligible++
		cu, cv := a.choice[u], a.choice[v]
		if cu < 0 || cv < 0 {
			continue // unsatisfied; already counted in denominator
		}
		eu := a.cands[a.labels[u]][cu]
		ev := a.cands[a.labels[v]][cv]
		if lessThan(eu, ev) {
			satisfied++
		}
	}
	return
}
