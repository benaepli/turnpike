package metrics

import (
	"math"
	"testing"
)

// duckDBPercentileDisc is the rule DuckDB's PERCENTILE_DISC follows: the value
// at 1-based index max(ceil(q*n), 1) of the ordered observations. Verified
// against the engine for every n in 1..29 at q = 0.5/0.95/0.99.
func duckDBPercentileDisc(sorted []int64, q float64) int64 {
	idx := int(math.Ceil(q * float64(len(sorted))))
	if idx < 1 {
		idx = 1
	}
	return sorted[idx-1]
}

func TestPercentileMatchesPercentileDisc(t *testing.T) {
	for n := 1; n <= 29; n++ {
		observations := make([]int64, 0, n)
		h := make(Hist)
		for i := 1; i <= n; i++ {
			observations = append(observations, int64(i))
			h.Add("fn", int64(i), 1)
		}
		for _, q := range []float64{0.50, 0.95, 0.99} {
			want := duckDBPercentileDisc(observations, q)
			if got := h.Percentile("fn", q); got != want {
				t.Errorf("n=%d q=%v: got %d, want %d", n, q, got, want)
			}
		}
	}
}

// Repeated values must be weighted by their counts, not collapsed -- this is
// what makes the histogram a faithful stand-in for the raw observations.
func TestPercentileWeightsRepeatedValues(t *testing.T) {
	h := make(Hist)
	h.Add("fn", 0, 99)
	h.Add("fn", 500, 1)

	if got := h.Percentile("fn", 0.50); got != 0 {
		t.Errorf("p50: got %d, want 0", got)
	}
	// The single 500 sits at index 100, so only q > 0.99 reaches it.
	if got := h.Percentile("fn", 0.99); got != 0 {
		t.Errorf("p99: got %d, want 0", got)
	}
	if got := h.Percentile("fn", 1.0); got != 500 {
		t.Errorf("p100: got %d, want 500", got)
	}
}

func TestStatsMatchesDirectComputation(t *testing.T) {
	observations := []int64{2, 2, 5, 9, 9, 9, 14}
	h := make(Hist)
	for _, v := range observations {
		h.Add("fn", v, 1)
	}

	var sum float64
	for _, v := range observations {
		sum += float64(v)
	}
	mean := sum / float64(len(observations))
	var variance float64
	for _, v := range observations {
		variance += (float64(v) - mean) * (float64(v) - mean)
	}
	variance /= float64(len(observations))

	got := h.Stats("fn")
	if got.Count != int64(len(observations)) {
		t.Errorf("count: got %d, want %d", got.Count, len(observations))
	}
	if got.Min != 2 || got.Max != 14 {
		t.Errorf("min/max: got %d/%d, want 2/14", got.Min, got.Max)
	}
	if math.Abs(got.Mean-mean) > 1e-9 {
		t.Errorf("mean: got %v, want %v", got.Mean, mean)
	}
	if math.Abs(got.Stddev-math.Sqrt(variance)) > 1e-9 {
		t.Errorf("stddev: got %v, want %v", got.Stddev, math.Sqrt(variance))
	}
}

// Merging per-batch histograms must give the same answer as one histogram over
// all the observations -- the property the whole batching scheme rests on.
func TestMergeEqualsSingleBatch(t *testing.T) {
	batches := [][]int64{
		{1, 4, 4, 7},
		{2, 4, 9},
		{},
		{3, 3, 11, 4},
	}

	whole := make(Hist)
	merged := make(Hist)
	for _, batch := range batches {
		partial := make(Hist)
		for _, v := range batch {
			partial.Add("fn", v, 1)
			whole.Add("fn", v, 1)
		}
		merged.Merge(partial)
	}

	for _, q := range []float64{0.50, 0.95, 0.99} {
		if got, want := merged.Percentile("fn", q), whole.Percentile("fn", q); got != want {
			t.Errorf("q=%v: merged %d, whole %d", q, got, want)
		}
	}
	if got, want := merged.Stats("fn"), whole.Stats("fn"); got != want {
		t.Errorf("stats: merged %+v, whole %+v", got, want)
	}
}

func TestStatsOnEmptyHistogram(t *testing.T) {
	h := make(Hist)
	if got := (h.Stats("missing")); got != (HistStats{}) {
		t.Errorf("expected zero stats, got %+v", got)
	}
	if got := h.Percentile("missing", 0.95); got != 0 {
		t.Errorf("expected 0, got %d", got)
	}
}
