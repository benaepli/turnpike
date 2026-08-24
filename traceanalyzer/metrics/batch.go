package metrics

import (
	"database/sql"
	"fmt"
	"math"
	"sort"

	"github.com/benaepli/turnpike-traceanalyzer/reader"
)

// Metrics run one batch of runs at a time and merge the partial results here.
// Every run's traces are independent -- joins key on (run_id, trace_id) and
// group-bys key on function_name -- so merging across disjoint run ranges gives
// the same answer as one whole-corpus query, with a working set proportional to
// the batch instead of the corpus.

// Hist is a per-function value histogram. It is a sufficient statistic for
// everything the duration, dispatch and depth metrics report, and stays small:
// one entry per distinct value observed, not per observation.
type Hist map[string]map[int64]int64

// Add records count occurrences of value for fn.
func (h Hist) Add(fn string, value, count int64) {
	m := h[fn]
	if m == nil {
		m = make(map[int64]int64)
		h[fn] = m
	}
	m[value] += count
}

// Merge folds other into h.
func (h Hist) Merge(other Hist) {
	for fn, m := range other {
		for v, c := range m {
			h.Add(fn, v, c)
		}
	}
}

// Functions returns the function names present, sorted, matching the
// ORDER BY function_name the queries used to do.
func (h Hist) Functions() []string {
	names := make([]string, 0, len(h))
	for fn := range h {
		names = append(names, fn)
	}
	sort.Strings(names)
	return names
}

// HistStats holds the aggregate statistics derivable from a histogram.
type HistStats struct {
	Count  int64
	Min    int64
	Max    int64
	Mean   float64
	Stddev float64
}

// Stats computes count/min/max/mean/population-stddev for one function.
func (h Hist) Stats(fn string) HistStats {
	m := h[fn]
	if len(m) == 0 {
		return HistStats{}
	}
	var s HistStats
	first := true
	var sum, sumSq float64
	for v, c := range m {
		if first || v < s.Min {
			s.Min = v
		}
		if first || v > s.Max {
			s.Max = v
		}
		first = false
		s.Count += c
		fv, fc := float64(v), float64(c)
		sum += fv * fc
		sumSq += fv * fv * fc
	}
	if s.Count > 0 {
		n := float64(s.Count)
		s.Mean = sum / n
		// Population variance, matching STDDEV_POP. Clamped because
		// catastrophic cancellation can push a zero-variance group slightly
		// negative.
		s.Stddev = math.Sqrt(math.Max(0, sumSq/n-s.Mean*s.Mean))
	}
	return s
}

// Percentile returns the q-quantile for one function, reproducing DuckDB's
// PERCENTILE_DISC: the value at 1-based index max(ceil(q*n), 1) of the sorted
// observations. Verified against the engine for every size 1..29 at q =
// 0.5/0.95/0.99.
func (h Hist) Percentile(fn string, q float64) int64 {
	m := h[fn]
	if len(m) == 0 {
		return 0
	}
	var n int64
	values := make([]int64, 0, len(m))
	for v, c := range m {
		values = append(values, v)
		n += c
	}
	sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })

	target := int64(math.Ceil(q * float64(n)))
	if target < 1 {
		target = 1
	}
	var cum int64
	for _, v := range values {
		cum += m[v]
		if cum >= target {
			return v
		}
	}
	return values[len(values)-1]
}

// Counters accumulates named integer totals across batches. Every counter the
// metrics report is either a row count or a count(DISTINCT run_id); because
// batches cover disjoint run ranges, summing is exact.
type Counters map[string]int64

// Add increments a counter.
func (c Counters) Add(key string, n int64) { c[key] += n }

// querier is the subset of *sql.DB the metric helpers need.
type querier interface {
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

// scanHist runs a per-batch query returning (function_name, value, count) and
// folds the rows into dst.
func scanHist(db querier, query string, dst Hist) error {
	rows, err := db.Query(query)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var fn string
		var value, count int64
		if err := rows.Scan(&fn, &value, &count); err != nil {
			return fmt.Errorf("failed to scan histogram row: %w", err)
		}
		dst.Add(fn, value, count)
	}
	return rows.Err()
}

// scanCounters runs a per-batch query returning (key, count) and folds the rows
// into dst.
func scanCounters(db querier, query string, dst Counters) error {
	rows, err := db.Query(query)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var key string
		var count int64
		if err := rows.Scan(&key, &count); err != nil {
			return fmt.Errorf("failed to scan counter row: %w", err)
		}
		dst.Add(key, count)
	}
	return rows.Err()
}

// batchesFor returns the run selections a metric should iterate over: one per
// batch for a whole-corpus run, or a single selection when -run pins one run or
// batching is disabled.
func batchesFor(dbPath string, runID int64, batchSize int) ([]reader.RunSel, error) {
	if runID >= 0 {
		return []reader.RunSel{reader.SingleRun(runID)}, nil
	}
	return reader.RunBatches(dbPath, batchSize)
}
