package dagorder

import (
	"slices"
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
	o := bestMatchingFull(labels, cands, deps, transitiveClosure(deps), 1, 0)
	if o.PrefixDepth != 3 {
		t.Fatalf("prefix depth = %d, want 3", o.PrefixDepth)
	}
	if !slices.Equal(o.PrefixPath, []string{"a", "b", "c"}) {
		t.Fatalf("prefix path = %v, want [a b c]", o.PrefixPath)
	}
}

// The root's outgoing edge is violated but a transitive hop is satisfied:
// a(10) -> b(5) -> c(20). a->b unsatisfied; closure edge a->c satisfied,
// so the anchored chain is a,c with depth 2.
func TestPrefixDepthSkipsViolatedMiddle(t *testing.T) {
	labels := []string{"a", "b", "c"}
	deps := [][2]string{{"a", "b"}, {"b", "c"}}
	cands := map[string][]Event{"a": pev(10), "b": pev(5), "c": pev(20)}
	o := bestMatchingFull(labels, cands, deps, transitiveClosure(deps), 1, 0)
	if o.PrefixDepth != 2 {
		t.Fatalf("prefix depth = %d, want 2 (a,c)", o.PrefixDepth)
	}
	if !slices.Equal(o.PrefixPath, []string{"a", "c"}) {
		t.Fatalf("prefix path = %v, want [a c]", o.PrefixPath)
	}
}

// Anchoring: a satisfied tail does NOT count when the chain never leaves the
// root. a(100) -> b(10) -> c(20) -> d(30): greedy assigns a, leaves b
// unassigned (its only candidate precedes a), then assigns c and d (their
// direct pred b is unassigned, so unconstrained). The unanchored
// longest_chain finds c->d = 2, but no satisfied chain from the root a
// reaches them, so the anchored prefix is 1.
func TestPrefixDepthAnchored(t *testing.T) {
	labels := []string{"a", "b", "c", "d"}
	deps := [][2]string{{"a", "b"}, {"b", "c"}, {"c", "d"}}
	cands := map[string][]Event{"a": pev(100), "b": pev(10), "c": pev(20), "d": pev(30)}
	o := bestMatchingFull(labels, cands, deps, transitiveClosure(deps), 1, 0)
	if o.LongestChain != 2 {
		t.Fatalf("longest chain = %d, want 2 (unanchored c,d)", o.LongestChain)
	}
	if o.PrefixDepth != 1 {
		t.Fatalf("prefix depth = %d, want 1 (anchored at a)", o.PrefixDepth)
	}
}

// A structurally unmatchable label between root and tail is contracted:
// a -> t -> b where t has zero candidates. Chain a,b via closure, depth 2.
func TestPrefixDepthContractsUnmatchable(t *testing.T) {
	labels := []string{"a", "t", "b"}
	deps := [][2]string{{"a", "t"}, {"t", "b"}}
	cands := map[string][]Event{"a": pev(1), "t": nil, "b": pev(5)}
	o := bestMatchingFull(labels, cands, deps, transitiveClosure(deps), 1, 0)
	if o.PrefixDepth != 2 {
		t.Fatalf("prefix depth = %d, want 2 (a,b through unmatchable t)", o.PrefixDepth)
	}
}

// Nothing assigned at all: depth 0, nil path (distinguishable from
// longestSatisfiableChain's floor of 1).
func TestPrefixDepthZero(t *testing.T) {
	labels := []string{"a", "b"}
	deps := [][2]string{{"a", "b"}}
	cands := map[string][]Event{"a": nil, "b": nil}
	o := bestMatchingFull(labels, cands, deps, transitiveClosure(deps), 1, 0)
	if o.PrefixDepth != 0 || o.PrefixPath != nil {
		t.Fatalf("prefix = (%d, %v), want (0, nil)", o.PrefixDepth, o.PrefixPath)
	}
}
