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
	// contracted holds label indices whose kind cannot be observed in this
	// corpus at all. They are spliced out of the predecessor relation.
	contracted map[int]struct{}
	// survIn holds direct predecessors with contracted vertices replaced by
	// their own direct predecessors, transitively.
	survIn map[int][]int
}

// matchOutcome bundles everything bestMatchingFull derives from one run's
// assignment.
type matchOutcome struct {
	Assign   map[string]Event
	Score    float64  // edge-satisfaction in [0, 1]
	Matched  []string // labels with an assigned event
	ZeroCand []string // labels with zero candidates
	// CrowdedOut holds labels that had candidates but ended unassigned:
	// every candidate was claimed by another label, or none followed the
	// label's assigned predecessors.
	CrowdedOut   []string
	LongestChain int // unanchored longest satisfied path (vertices)
	CriticalPath int // longest path ignoring satisfaction (vertices)
	// PrefixDepth is the deepest witness-complete chain from a root, in
	// vertices. It is read off two admissible injective assignments - the
	// witness-exact greedy and the edge-optimal one - and is the deeper of
	// the two. Score and Assign come from the edge-optimal assignment alone.
	PrefixDepth int
	PrefixPath  []string // labels forming the winning prefix chain, in order
}

// bestMatchingFull runs greedy topo assignment + random local swaps. This is a
// heuristic: greedy can claim a successor's only candidate for an earlier
// label, and the swap budget is bounded - there is no optimality guarantee.
// unobservable names the labels whose kind cannot be observed in this corpus;
// they are contracted out of the chain the prefix depth walks.
func bestMatchingFull(
	labels []string,
	cands map[string][]Event,
	directDeps, allDeps [][2]string,
	unobservable map[string]bool,
	seed int64,
	nSwaps int,
) matchOutcome {
	a := newAssignment(labels, cands, directDeps, allDeps, unobservable)

	// Greedy pass in topological order.
	for _, li := range a.topo {
		a.assignEarliestAfterPredecessors(li)
	}
	witnessChoice := a.witnessGreedy()

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
	// The swap phase maximizes satisfied edges, which is not depth, so a move
	// that raises the edge count can break the witness chain. Ties go to the
	// edge-optimal assignment so the path agrees with Assign where it can.
	prefixDepth, prefixPath := a.rootAnchoredPrefix(a.choice)
	if wd, wp := a.rootAnchoredPrefix(witnessChoice); wd > prefixDepth {
		prefixDepth, prefixPath = wd, wp
	}
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
// It declares no unobservable kinds.
func bestMatching(
	labels []string,
	cands map[string][]Event,
	directDeps, allDeps [][2]string,
	seed int64,
	nSwaps int,
) (map[string]Event, float64, []string, []string, []string, int, int) {
	o := bestMatchingFull(labels, cands, directDeps, allDeps, nil, seed, nSwaps)
	return o.Assign, o.Score, o.Matched, o.ZeroCand, o.CrowdedOut, o.LongestChain, o.CriticalPath
}

// rootAnchoredPrefix computes the longest witness-complete chain that starts
// at a chain root, over the direct-predecessor relation with contracted
// vertices spliced out. A vertex extends the chain only when every one of its
// surviving predecessors is matched, is itself on a chain from a root, and
// strictly precedes it; a root is a vertex with no surviving predecessor.
// Depth k therefore means the first k events of the plan happened in order
// with nothing skipped. Unlike longestSatisfiableChain (which is unanchored
// and never below 1), this is 0 when not even a root was matched. choice is
// the assignment to read, so the caller can evaluate more than one. Returns
// the depth in vertices and the winning chain's labels in order.
func (a *assignment) rootAnchoredPrefix(choice []int) (int, []string) {
	n := len(a.labels)
	assigned := func(li int) bool { return choice[li] >= 0 }
	eventOf := func(li int) Event { return a.cands[a.labels[li]][choice[li]] }

	dp := make([]int, n)
	parent := make([]int, n)
	for i := range parent {
		parent[i] = -1
	}
	for _, li := range a.topo {
		if _, c := a.contracted[li]; c {
			// Never a chain member, never a parent.
			continue
		}
		preds := a.survIn[li]
		if len(preds) == 0 {
			if assigned(li) {
				dp[li] = 1
			}
			continue
		}
		if !assigned(li) {
			continue
		}
		ok := true
		best, bestParent := 0, -1
		for _, u := range preds {
			// dp[u] >= 1 forbids a chain from starting mid-DAG: an
			// unassigned root has dp 0 and poisons everything below it.
			if dp[u] < 1 || !assigned(u) || !lessThan(eventOf(u), eventOf(li)) {
				ok = false
				break
			}
			if dp[u]+1 > best {
				best, bestParent = dp[u]+1, u
			}
		}
		if ok {
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

func newAssignment(labels []string, cands map[string][]Event, directDeps, allDeps [][2]string, unobservable map[string]bool) *assignment {
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

		contracted: make(map[int]struct{}),
		survIn:     make(map[int][]int),
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
		if unobservable[lbl] {
			a.contracted[li] = struct{}{}
		}
	}

	// Splice contracted vertices out of the predecessor relation: a
	// successor inherits a contracted predecessor's own predecessors,
	// transitively. A vertex all of whose predecessors contract away becomes
	// a root.
	for v := range a.labels {
		seen := make(map[int]bool)
		var out []int
		var walk func(u int)
		walk = func(u int) {
			if seen[u] {
				return
			}
			seen[u] = true
			if _, c := a.contracted[u]; c {
				for _, w := range a.depIn[u] {
					walk(w)
				}
				return
			}
			out = append(out, u)
		}
		for _, u := range a.depIn[v] {
			walk(u)
		}
		sort.Ints(out)
		a.survIn[v] = out
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

// witnessGreedy assigns every label its earliest unused candidate that
// strictly follows each of its surviving predecessors, and leaves a label
// unassigned when one of those predecessors is unassigned: a label cannot
// stand on an event that was never observed. Topo order guarantees every
// surviving predecessor is already placed, so by induction each label lands
// on the earliest event it can take over all witness-complete embeddings,
// modulo injectivity, which can only push a choice later. Contracted labels
// are skipped: they are never chain members and would only claim candidates
// other labels need.
//
// It writes its own choice slice and its own injectivity set, so the
// edge-satisfaction assignment and the swap phase are untouched by it.
func (a *assignment) witnessGreedy() []int {
	choice := make([]int, len(a.labels))
	for i := range choice {
		choice[i] = -1
	}
	used := make(map[eventKey]struct{}, len(a.labels))
	for _, li := range a.topo {
		if _, c := a.contracted[li]; c {
			continue
		}
		cand := a.cands[a.labels[li]]
		if len(cand) == 0 {
			continue
		}
		preds := make([]Event, 0, len(a.survIn[li]))
		blocked := false
		for _, p := range a.survIn[li] {
			c := choice[p]
			if c < 0 {
				blocked = true
				break
			}
			preds = append(preds, a.cands[a.labels[p]][c])
		}
		if blocked {
			continue
		}
		for i, ev := range cand {
			if _, u := used[keyOf(ev)]; u {
				continue
			}
			ok := true
			for _, pred := range preds {
				if !lessThan(pred, ev) {
					ok = false
					break
				}
			}
			if ok {
				choice[li] = i
				used[keyOf(ev)] = struct{}{}
				break
			}
		}
	}
	return choice
}

// assignEarliestAfterPredecessors picks the earliest unused candidate for `li`
// that strictly follows every already-assigned predecessor in the lessThan
// order. If no predecessor-respecting candidate exists, the label is left
// unassigned - under the scoring model where unassigned edges count as
// unsatisfied, forcing a bad pick would give the same score on violated
// edges but risk stealing a candidate from another label via injectivity.
// The swap phase can assign or unassign later with global scoring.
//
// This is the edge-satisfaction assignment. The prefix depth is read off a
// separate pass, witnessGreedy, so the two never constrain each other.
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
