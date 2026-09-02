package dagorder

import (
	"math/rand/v2"
	"slices"
	"sort"
	"testing"
)

func pev(step int32) []Event {
	return []Event{{Step: step, IntraSeq: int64(step), Table: TableTrace}}
}

// Linear chain fully satisfied: depth = 3, path = a,b,c.
func TestPrefixDepthLinear(t *testing.T) {
	labels := []string{"a", "b", "c"}
	deps := [][2]string{{"a", "b"}, {"b", "c"}}
	cands := map[string][]Event{"a": pev(1), "b": pev(2), "c": pev(3)}
	o := bestMatchingFull(labels, cands, deps, transitiveClosure(deps), nil, 1, 0)
	if o.PrefixDepth != 3 {
		t.Fatalf("prefix depth = %d, want 3", o.PrefixDepth)
	}
	if !slices.Equal(o.PrefixPath, []string{"a", "b", "c"}) {
		t.Fatalf("prefix path = %v, want [a b c]", o.PrefixPath)
	}
}

// A violated middle hop stops the chain: a(10) -> b(5) -> c(20). b's only
// candidate precedes a, so b is unassigned; c's surviving predecessor b is
// unmatched, so c fails. The closure hop a->c is not a chain edge - a chain
// may not skip a required event.
func TestPrefixDepthFailsOnViolatedMiddle(t *testing.T) {
	labels := []string{"a", "b", "c"}
	deps := [][2]string{{"a", "b"}, {"b", "c"}}
	cands := map[string][]Event{"a": pev(10), "b": pev(5), "c": pev(20)}
	o := bestMatchingFull(labels, cands, deps, transitiveClosure(deps), nil, 1, 0)
	if o.PrefixDepth != 1 {
		t.Fatalf("prefix depth = %d, want 1 (a alone)", o.PrefixDepth)
	}
	if !slices.Equal(o.PrefixPath, []string{"a"}) {
		t.Fatalf("prefix path = %v, want [a]", o.PrefixPath)
	}
}

// Anchoring: a satisfied tail does NOT count when the chain never leaves the
// root. a(100) -> b(10) -> c(20) -> d(30): the edge assignment places a,
// leaves b unassigned (its only candidate precedes a), then places c and d
// (their direct pred b is unassigned, so they are unconstrained). The
// unanchored longest_chain finds c->d = 2, but b is a required predecessor,
// so no witness-complete chain from the root a reaches them and the anchored
// prefix is 1. The assignment itself is untouched by the prefix rule.
func TestPrefixDepthAnchored(t *testing.T) {
	labels := []string{"a", "b", "c", "d"}
	deps := [][2]string{{"a", "b"}, {"b", "c"}, {"c", "d"}}
	cands := map[string][]Event{"a": pev(100), "b": pev(10), "c": pev(20), "d": pev(30)}
	o := bestMatchingFull(labels, cands, deps, transitiveClosure(deps), nil, 1, 0)
	if o.LongestChain != 2 {
		t.Fatalf("longest chain = %d, want 2 (unanchored c,d)", o.LongestChain)
	}
	if o.PrefixDepth != 1 {
		t.Fatalf("prefix depth = %d, want 1 (anchored at a)", o.PrefixDepth)
	}
	if _, ok := o.Assign["c"]; !ok {
		t.Errorf("c should still be assigned: the prefix rule must not move the assignment")
	}
	if _, ok := o.Assign["d"]; !ok {
		t.Errorf("d should still be assigned: the prefix rule must not move the assignment")
	}
}

// A predecessor that exists but is misordered is not the same as one that is
// absent: a(1) -> b(0) -> c(5). b has a candidate, it just precedes a.
func TestPrefixDepthFailsOnSkippedDirectPredecessor(t *testing.T) {
	labels := []string{"a", "b", "c"}
	deps := [][2]string{{"a", "b"}, {"b", "c"}}
	cands := map[string][]Event{"a": pev(1), "b": pev(0), "c": pev(5)}
	o := bestMatchingFull(labels, cands, deps, transitiveClosure(deps), nil, 1, 0)
	if o.PrefixDepth != 1 {
		t.Fatalf("prefix depth = %d, want 1", o.PrefixDepth)
	}
	if !slices.Equal(o.PrefixPath, []string{"a"}) {
		t.Fatalf("prefix path = %v, want [a]", o.PrefixPath)
	}
}

// An observable label with zero candidates in this run is still required: it
// is the crash_nl case in miniature. Two thirds of the runs that once graded
// at depth >= 6 on the general store carried no crash of the non-leader at
// all; they must not be credited with the prefix that starts at that crash.
func TestPrefixDepthFailsOnZeroCandidateObservableLabel(t *testing.T) {
	labels := []string{"a", "b", "c"}
	deps := [][2]string{{"a", "b"}, {"b", "c"}}
	cands := map[string][]Event{"a": pev(1), "b": nil, "c": pev(5)}
	o := bestMatchingFull(labels, cands, deps, transitiveClosure(deps), nil, 1, 0)
	if o.PrefixDepth != 1 {
		t.Fatalf("prefix depth = %d, want 1 (b is required and unobserved)", o.PrefixDepth)
	}
}

// A label whose kind cannot be observed on this corpus is contracted out:
// a -> t -> b with t declared unobservable. b inherits a as its predecessor,
// giving depth 2.
func TestPrefixDepthContractsUnobservableKind(t *testing.T) {
	labels := []string{"a", "t", "b"}
	deps := [][2]string{{"a", "t"}, {"t", "b"}}
	cands := map[string][]Event{"a": pev(1), "t": nil, "b": pev(5)}
	unobs := map[string]bool{"t": true}
	o := bestMatchingFull(labels, cands, deps, transitiveClosure(deps), unobs, 1, 0)
	if o.PrefixDepth != 2 {
		t.Fatalf("prefix depth = %d, want 2 (a,b through contracted t)", o.PrefixDepth)
	}
	if !slices.Equal(o.PrefixPath, []string{"a", "b"}) {
		t.Fatalf("prefix path = %v, want [a b]", o.PrefixPath)
	}
}

// Every surviving predecessor must be matched and earlier, not just the
// deepest one. Diamond a->b, a->c, b->d, c->d with c after d: d fails. This
// is the shape of the plan-corpus runs whose reads all precede one of the two
// deliveries to node 0.
func TestPrefixDepthRequiresAllDirectPredecessors(t *testing.T) {
	labels := []string{"a", "b", "c", "d"}
	deps := [][2]string{{"a", "b"}, {"a", "c"}, {"b", "d"}, {"c", "d"}}
	cands := map[string][]Event{"a": pev(1), "b": pev(2), "c": pev(9), "d": pev(5)}
	o := bestMatchingFull(labels, cands, deps, transitiveClosure(deps), nil, 1, 0)
	if o.PrefixDepth != 2 {
		t.Fatalf("prefix depth = %d, want 2 (d fails on c)", o.PrefixDepth)
	}
}

// minimalShape is the oracle DAG of research/oracle/relax_minimal.json.
func minimalShape() ([]string, [][2]string) {
	labels := []string{
		"w1", "allow_t1", "crash_nl", "recover_nl", "deliver_svc_1_to_2",
		"crash_2", "recover_2", "deliver_svc_1_to_0", "deliver_svc_2_to_0",
		"w2", "r1", "r2", "r3",
	}
	deps := [][2]string{
		{"w1", "allow_t1"},
		{"allow_t1", "crash_nl"},
		{"crash_nl", "recover_nl"},
		{"crash_nl", "deliver_svc_1_to_2"},
		{"deliver_svc_1_to_2", "crash_2"},
		{"crash_2", "recover_2"},
		{"recover_nl", "w2"},
		{"recover_2", "w2"},
		{"w2", "deliver_svc_1_to_0"},
		{"w2", "deliver_svc_2_to_0"},
		{"deliver_svc_1_to_0", "r1"},
		{"deliver_svc_1_to_0", "r2"},
		{"deliver_svc_1_to_0", "r3"},
		{"deliver_svc_2_to_0", "r1"},
		{"deliver_svc_2_to_0", "r2"},
		{"deliver_svc_2_to_0", "r3"},
	}
	return labels, deps
}

// minimalInOrder places every label of the oracle shape in dependency order,
// including the two joins recover_nl and deliver_svc_2_to_0.
func minimalInOrder() map[string][]Event {
	return map[string][]Event{
		"w1":                 pev(1),
		"allow_t1":           pev(2),
		"crash_nl":           pev(3),
		"recover_nl":         pev(4),
		"deliver_svc_1_to_2": pev(5),
		"crash_2":            pev(6),
		"recover_2":          pev(7),
		"w2":                 pev(8),
		"deliver_svc_1_to_0": pev(9),
		"deliver_svc_2_to_0": pev(10),
		"r1":                 pev(11),
		"r2":                 pev(12),
		"r3":                 pev(13),
	}
}

// A run holding the whole oracle shape in order reaches the deepest rung.
func TestPrefixDepthFullChainReachesMaxDepth(t *testing.T) {
	labels, deps := minimalShape()
	o := bestMatchingFull(labels, minimalInOrder(), deps, transitiveClosure(deps), nil, 1, 200)
	if o.PrefixDepth != 9 {
		t.Fatalf("prefix depth = %d, want 9", o.PrefixDepth)
	}
	want := []string{
		"w1", "allow_t1", "crash_nl", "deliver_svc_1_to_2", "crash_2",
		"recover_2", "w2", "deliver_svc_1_to_0", "r1",
	}
	if !slices.Equal(o.PrefixPath, want) {
		t.Fatalf("prefix path = %v, want %v", o.PrefixPath, want)
	}
}

// The swap phase maximizes satisfied edges, not depth, so the prefix is read
// off the greedy assignment as well. Depth is therefore invariant to the swap
// budget and dag-swaps needs no recalibration.
func TestPrefixDepthIgnoresSwapBudget(t *testing.T) {
	labels, deps := minimalShape()
	all := transitiveClosure(deps)
	cands := minimalInOrder()
	// A middle label with a decoy candidate the swap could prefer.
	cands["w2"] = []Event{{Step: 8, IntraSeq: 8, Table: TableTrace}, {Step: 40, IntraSeq: 40, Table: TableTrace}}
	base := bestMatchingFull(labels, cands, deps, all, nil, 7, 0)
	for _, n := range []int{200, 2000} {
		o := bestMatchingFull(labels, cands, deps, all, nil, 7, n)
		if o.PrefixDepth != base.PrefixDepth {
			t.Fatalf("prefix depth at %d swaps = %d, want %d (swap budget must not move depth)",
				n, o.PrefixDepth, base.PrefixDepth)
		}
	}
}

// exactWitnessDepth computes the deepest witness-complete prefix directly:
// every label takes the earliest candidate that follows the earliest choice of
// each of its surviving predecessors, which is the minimum event it can take
// over all witness-complete embeddings. Injectivity is ignored, so the answer
// is an upper bound on any matcher's depth. Test-only, and deliberately built
// from the raw inputs rather than from an assignment.
func exactWitnessDepth(labels []string, cands map[string][]Event, directDeps [][2]string, unobservable map[string]bool) int {
	sorted := append([]string(nil), labels...)
	sort.Strings(sorted)
	n := len(sorted)
	idxOf := make(map[string]int, n)
	for i, l := range sorted {
		idxOf[l] = i
	}
	depIn := make(map[int][]int, n)
	depOut := make(map[int][]int, n)
	for _, d := range directDeps {
		f, okF := idxOf[d[0]]
		to, okT := idxOf[d[1]]
		if !okF || !okT {
			continue
		}
		depIn[to] = append(depIn[to], f)
		depOut[f] = append(depOut[f], to)
	}
	contracted := make([]bool, n)
	for i, l := range sorted {
		contracted[i] = unobservable[l]
	}
	survIn := make([][]int, n)
	for v := range n {
		seen := make([]bool, n)
		var walk func(u int)
		walk = func(u int) {
			if seen[u] {
				return
			}
			seen[u] = true
			if contracted[u] {
				for _, w := range depIn[u] {
					walk(w)
				}
				return
			}
			survIn[v] = append(survIn[v], u)
		}
		for _, u := range depIn[v] {
			walk(u)
		}
	}

	earliest := make([]Event, n)
	feasible := make([]bool, n)
	dp := make([]int, n)
	for _, li := range topoSort(n, depIn, depOut) {
		if contracted[li] {
			continue
		}
		cand := cands[sorted[li]]
		preds := survIn[li]
		if len(preds) == 0 {
			if len(cand) > 0 {
				earliest[li], feasible[li], dp[li] = cand[0], true, 1
			}
			continue
		}
		best, ok := 0, true
		for _, u := range preds {
			if !feasible[u] {
				ok = false
				break
			}
			if dp[u]+1 > best {
				best = dp[u] + 1
			}
		}
		if !ok {
			continue
		}
		for _, e := range cand {
			fits := true
			for _, u := range preds {
				if !lessThan(earliest[u], e) {
					fits = false
					break
				}
			}
			if fits {
				earliest[li], feasible[li], dp[li] = e, true, best
				break
			}
		}
	}
	depth := 0
	for _, d := range dp {
		if d > depth {
			depth = d
		}
	}
	return depth
}

// randomWitnessCase builds a small DAG whose events carry globally unique
// keys, so injectivity can never bind and the matcher must reach the exact
// answer.
func randomWitnessCase(rng *rand.Rand, seq *int64) ([]string, [][2]string, map[string][]Event, map[string]bool) {
	n := 2 + rng.IntN(7)
	labels := make([]string, n)
	for i := range labels {
		labels[i] = string(rune('a' + i))
	}
	var deps [][2]string
	for i := range n {
		for j := i + 1; j < n; j++ {
			if rng.IntN(100) < 45 {
				deps = append(deps, [2]string{labels[i], labels[j]})
			}
		}
	}
	cands := make(map[string][]Event, n)
	unobs := make(map[string]bool, n)
	for _, l := range labels {
		k := rng.IntN(5)
		evs := make([]Event, 0, k)
		for range k {
			*seq++
			tbl := TableExec
			if rng.IntN(2) == 0 {
				tbl = TableTrace
			}
			evs = append(evs, Event{Step: int32(rng.IntN(20)), IntraSeq: *seq, Table: tbl})
		}
		sort.Slice(evs, func(i, j int) bool {
			if evs[i].Step != evs[j].Step {
				return evs[i].Step < evs[j].Step
			}
			return evs[i].IntraSeq < evs[j].IntraSeq
		})
		cands[l] = evs
		if rng.IntN(100) < 15 {
			unobs[l] = true
		}
	}
	return labels, deps, cands, unobs
}

// The matcher must report the exact witness depth whenever injectivity does
// not bind, on every shape.
func TestPrefixDepthMatchesExactWitness(t *testing.T) {
	rng := rand.New(rand.NewPCG(0x5eed, 0xC0FFEE))
	var seq int64
	for i := range 500 {
		labels, deps, cands, unobs := randomWitnessCase(rng, &seq)
		all := transitiveClosure(deps)
		want := exactWitnessDepth(labels, cands, deps, unobs)
		for _, swaps := range []int{0, 200} {
			o := bestMatchingFull(labels, cands, deps, all, unobs, int64(i), swaps)
			if o.PrefixDepth != want {
				t.Fatalf("case %d swaps %d: prefix depth = %d, exact witness = %d\nlabels %v\ndeps %v\ncands %v\nunobs %v",
					i, swaps, o.PrefixDepth, want, labels, deps, cands, unobs)
			}
		}
	}
}

// Nothing assigned at all: depth 0, nil path (distinguishable from
// longestSatisfiableChain's floor of 1).
func TestPrefixDepthZero(t *testing.T) {
	labels := []string{"a", "b"}
	deps := [][2]string{{"a", "b"}}
	cands := map[string][]Event{"a": nil, "b": nil}
	o := bestMatchingFull(labels, cands, deps, transitiveClosure(deps), nil, 1, 0)
	if o.PrefixDepth != 0 || o.PrefixPath != nil {
		t.Fatalf("prefix = (%d, %v), want (0, nil)", o.PrefixDepth, o.PrefixPath)
	}
}
