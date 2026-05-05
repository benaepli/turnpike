package dagorder

import (
	"testing"
)

// ev is a small helper for building same-table (TableExec) events keyed by
// step. IntraSeq is set from step so each event has a distinct injectivity key.
func ev(step int32) Event {
	return Event{Step: step, IntraSeq: int64(step), Table: TableExec}
}

// TestPerfectOrdering: three events with a w1->r1 dep, candidates arrive in order.
func TestPerfectOrdering(t *testing.T) {
	labels := []string{"w1", "r1"}
	cands := map[string][]Event{
		"w1": {ev(10)},
		"r1": {ev(20)},
	}
	deps := [][2]string{{"w1", "r1"}}
	_, score, _, _, _, _, _ := bestMatching(labels, cands, deps, 1, 0)
	if score != 1.0 {
		t.Errorf("score: got %f, want 1.0", score)
	}
}

// TestReversedOrdering: only candidate for r1 precedes only candidate for w1.
func TestReversedOrdering(t *testing.T) {
	labels := []string{"w1", "r1"}
	cands := map[string][]Event{
		"w1": {ev(20)},
		"r1": {ev(10)},
	}
	deps := [][2]string{{"w1", "r1"}}
	_, score, _, _, _, _, _ := bestMatching(labels, cands, deps, 1, 0)
	if score != 0.0 {
		t.Errorf("score: got %f, want 0.0", score)
	}
}

// TestUnmatchableExcluded: an edge touching a zero-candidate label shouldn't
// contribute to numerator or denominator. With only 1 edge and it touches
// an unmatchable label, eligible = 0 and score defaults to 0.
func TestUnmatchableExcluded(t *testing.T) {
	labels := []string{"w1", "timer"}
	cands := map[string][]Event{
		"w1":    {ev(10)},
		"timer": {}, // unmatchable
	}
	deps := [][2]string{{"timer", "w1"}}
	_, score, matched, zeroCand, _, _, _ := bestMatching(labels, cands, deps, 1, 0)
	if score != 0.0 {
		t.Errorf("score: got %f, want 0.0 (but eligible=0)", score)
	}
	if len(matched) != 1 || matched[0] != "w1" {
		t.Errorf("matched: got %v, want [w1]", matched)
	}
	if len(zeroCand) != 1 || zeroCand[0] != "timer" {
		t.Errorf("zeroCand: got %v, want [timer]", zeroCand)
	}
}

// TestPartialSatisfaction: two edges, one holds and one doesn't.
func TestPartialSatisfaction(t *testing.T) {
	labels := []string{"a", "b", "c"}
	cands := map[string][]Event{
		"a": {ev(10)},
		"b": {ev(20)},
		"c": {ev(5)}, // before a
	}
	deps := [][2]string{{"a", "b"}, {"a", "c"}}
	_, score, _, _, _, _, _ := bestMatching(labels, cands, deps, 1, 0)
	if score != 0.5 {
		t.Errorf("score: got %f, want 0.5", score)
	}
}

// TestInjectivity: two labels sharing one concrete event can't both match it.
func TestInjectivity(t *testing.T) {
	labels := []string{"w1", "w2"}
	e := ev(10)
	cands := map[string][]Event{
		"w1": {e},
		"w2": {e},
	}
	deps := [][2]string{{"w1", "w2"}}
	assign, _, matched, _, crowdedOut, _, _ := bestMatching(labels, cands, deps, 1, 0)
	if len(matched) != 1 {
		t.Errorf("matched: got %d labels, want 1 (other is injectivity-blocked)", len(matched))
	}
	if len(crowdedOut) != 1 {
		t.Errorf("crowdedOut: got %d labels, want 1", len(crowdedOut))
	}
	for _, lbl := range matched {
		if assign[lbl].Step != 10 {
			t.Errorf("assigned wrong event: %+v", assign[lbl])
		}
	}
}

// TestLocalSearchImproves: greedy picks poorly, local search finds better.
func TestLocalSearchImproves(t *testing.T) {
	labels := []string{"w1", "w2"}
	cands := map[string][]Event{
		"w1": {ev(5), ev(30)},
		"w2": {ev(20), ev(40)},
	}
	deps := [][2]string{{"w1", "w2"}}
	_, scoreNoSwaps, _, _, _, _, _ := bestMatching(labels, cands, deps, 1, 0)
	_, scoreWithSwaps, _, _, _, _, _ := bestMatching(labels, cands, deps, 1, 500)
	if scoreWithSwaps < scoreNoSwaps {
		t.Errorf("local search made score worse: %f -> %f", scoreNoSwaps, scoreWithSwaps)
	}
}

// TestDeterminism: same seed -> same score.
func TestDeterminism(t *testing.T) {
	labels := []string{"a", "b", "c"}
	cands := map[string][]Event{
		"a": {ev(10), ev(40), ev(80)},
		"b": {ev(20), ev(50), ev(90)},
		"c": {ev(30), ev(60), ev(100)},
	}
	deps := [][2]string{{"a", "b"}, {"b", "c"}, {"a", "c"}}
	_, s1, _, _, _, _, _ := bestMatching(labels, cands, deps, 42, 200)
	_, s2, _, _, _, _, _ := bestMatching(labels, cands, deps, 42, 200)
	if s1 != s2 {
		t.Errorf("non-deterministic: %f != %f", s1, s2)
	}
}

// TestTopoRespected: if the DAG is already linearizable over candidates,
// greedy alone should score 1.0 even without swaps.
func TestTopoRespected(t *testing.T) {
	labels := []string{"a", "b", "c", "d"}
	cands := map[string][]Event{
		"a": {ev(1)},
		"b": {ev(2)},
		"c": {ev(3)},
		"d": {ev(4)},
	}
	deps := [][2]string{{"a", "b"}, {"b", "c"}, {"c", "d"}, {"a", "d"}}
	_, score, _, _, _, _, _ := bestMatching(labels, cands, deps, 1, 0)
	if score != 1.0 {
		t.Errorf("score: got %f, want 1.0", score)
	}
}

// TestCrossTableSeqIgnored: an edge from an exec-sourced label (later step)
// to a trace-sourced label (earlier step) must score 0, even though the
// trace's IntraSeq is much larger than the exec's. Pre-fix behavior compared
// IntraSeq directly and would have called this satisfied.
func TestCrossTableSeqIgnored(t *testing.T) {
	labels := []string{"write_op", "deliver_op"}
	cands := map[string][]Event{
		"write_op":   {{Step: 5, IntraSeq: 10, Table: TableExec}},
		"deliver_op": {{Step: 3, IntraSeq: 99, Table: TableTrace}},
	}
	deps := [][2]string{{"write_op", "deliver_op"}}
	_, score, _, _, _, _, _ := bestMatching(labels, cands, deps, 1, 0)
	if score != 0.0 {
		t.Errorf("score: got %f, want 0.0 (write at step 5 cannot precede deliver at step 3)", score)
	}
}

// TestCrossTableSameStepUnsatisfied: same step across tables has no defined
// ordering; treat the edge as eligible-but-unsatisfied (conservative).
func TestCrossTableSameStepUnsatisfied(t *testing.T) {
	labels := []string{"a", "b"}
	cands := map[string][]Event{
		"a": {{Step: 7, IntraSeq: 0, Table: TableExec}},
		"b": {{Step: 7, IntraSeq: 0, Table: TableTrace}},
	}
	deps := [][2]string{{"a", "b"}}
	_, score, _, _, _, _, _ := bestMatching(labels, cands, deps, 1, 0)
	if score != 0.0 {
		t.Errorf("score: got %f, want 0.0 (same-step cross-table is unordered)", score)
	}
}

// TestSameStepSameTableUsesIntraSeq: within one table, IntraSeq breaks ties.
func TestSameStepSameTableUsesIntraSeq(t *testing.T) {
	labels := []string{"a", "b"}
	cands := map[string][]Event{
		"a": {{Step: 7, IntraSeq: 1, Table: TableExec}},
		"b": {{Step: 7, IntraSeq: 2, Table: TableExec}},
	}
	deps := [][2]string{{"a", "b"}}
	_, score, _, _, _, _, _ := bestMatching(labels, cands, deps, 1, 0)
	if score != 1.0 {
		t.Errorf("score: got %f, want 1.0 (same-step same-table ordered by IntraSeq)", score)
	}
}

// TestInjectivityCrossTable: two events with same Step but different Table
// must NOT collide in injectivity bookkeeping.
func TestInjectivityCrossTable(t *testing.T) {
	labels := []string{"a", "b"}
	cands := map[string][]Event{
		"a": {{Step: 5, IntraSeq: 0, Table: TableExec}},
		"b": {{Step: 5, IntraSeq: 0, Table: TableTrace}},
	}
	deps := [][2]string{}
	_, _, matched, _, crowdedOut, _, _ := bestMatching(labels, cands, deps, 1, 0)
	if len(matched) != 2 {
		t.Errorf("matched: got %d, want 2 (cross-table events should not collide); crowdedOut=%v", len(matched), crowdedOut)
	}
}
