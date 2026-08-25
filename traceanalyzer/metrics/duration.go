package metrics

import (
	"fmt"
	"math"

	"github.com/benaepli/turnpike-traceanalyzer/reader"
)

// FunctionDurationStats holds per-function duration statistics.
type FunctionDurationStats struct {
	FunctionName  string  `json:"function_name"`
	Count         int     `json:"count"`
	UnpairedCount int     `json:"unpaired_count"`
	UnpairedRatio float64 `json:"unpaired_ratio"`
	Min           int     `json:"min"`
	Max           int     `json:"max"`
	Mean          float64 `json:"mean"`
	Stddev        float64 `json:"stddev"`
	P50           int     `json:"p50"`
	P95           int     `json:"p95"`
	P99           int     `json:"p99"`
	CV            float64 `json:"cv"` // coefficient of variation
	HighVariance  bool    `json:"high_variance"`
}

// DurationResult holds the complete duration analysis.
type DurationResult struct {
	Functions []FunctionDurationStats `json:"functions"`
}

// ComputeDuration computes function duration distributions, one batch of runs
// at a time. Each batch returns a compact (function, duration, count)
// histogram; every statistic reported here derives from the merged histogram,
// so the result matches a whole-corpus query exactly.
func ComputeDuration(dbPath string, runID int64, batchSize int) (*DurationResult, error) {
	db, err := reader.OpenDB(dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	defer db.Close()

	batches, err := batchesFor(dbPath, runID, batchSize)
	if err != nil {
		return nil, err
	}

	durations := make(Hist)
	enters := make(Counters)

	for _, sel := range batches {
		src := reader.TracesSource(dbPath, sel)

		// The latest Enter per (run, trace) paired with its Exit. The run
		// filter lives in src, so it applies to the window function too rather
		// than only to the join result.
		histQuery := fmt.Sprintf(`
			WITH latest_enter AS (
				SELECT run_id, trace_id, function_name, step
				FROM %[1]s
				WHERE trace_kind = 'Enter'
				QUALIFY ROW_NUMBER() OVER (PARTITION BY run_id, trace_id ORDER BY step DESC) = 1
			),
			paired AS (
				SELECT e.function_name, x.step - e.step AS duration
				FROM latest_enter e
				JOIN %[1]s x
				  ON e.run_id = x.run_id
				  AND e.trace_id = x.trace_id
				  AND x.trace_kind = 'Exit'
			)
			SELECT function_name, duration, COUNT(*) AS n
			FROM paired
			GROUP BY function_name, duration
		`, src)
		if err := scanHist(db, histQuery, durations); err != nil {
			return nil, fmt.Errorf("failed to query duration stats: %w", err)
		}

		enterQuery := fmt.Sprintf(`
			SELECT function_name, COUNT(*) AS total_enters
			FROM %s
			WHERE trace_kind = 'Enter'
			GROUP BY function_name
		`, src)
		if err := scanCounters(db, enterQuery, enters); err != nil {
			return nil, fmt.Errorf("failed to query enter counts: %w", err)
		}
	}

	result := &DurationResult{}
	for _, fn := range durations.Functions() {
		st := durations.Stats(fn)
		s := FunctionDurationStats{
			FunctionName: fn,
			Count:        int(st.Count),
			Min:          int(st.Min),
			Max:          int(st.Max),
			Mean:         st.Mean,
			Stddev:       st.Stddev,
			P50:          int(durations.Percentile(fn, 0.50)),
			P95:          int(durations.Percentile(fn, 0.95)),
			P99:          int(durations.Percentile(fn, 0.99)),
		}

		totalEnters := enters[fn]
		s.UnpairedCount = int(totalEnters - st.Count)
		if totalEnters > 0 {
			s.UnpairedRatio = float64(s.UnpairedCount) / float64(totalEnters)
		}
		if s.Mean > 0 {
			s.CV = s.Stddev / s.Mean
		}
		s.HighVariance = s.CV > 1.0

		result.Functions = append(result.Functions, s)
	}
	return result, nil
}

// Round helper for display.
func roundFloat(val float64, precision int) float64 {
	ratio := math.Pow(10, float64(precision))
	return math.Round(val*ratio) / ratio
}
