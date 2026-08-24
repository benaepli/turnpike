package metrics

import (
	"fmt"

	"github.com/benaepli/turnpike-traceanalyzer/reader"
)

// DispatchFunctionStats holds dispatch latency statistics for a single function.
type DispatchFunctionStats struct {
	FunctionName string  `json:"function_name"`
	Count        int     `json:"count"`
	MinLatency   int     `json:"min_latency"`
	MaxLatency   int     `json:"max_latency"`
	MeanLatency  float64 `json:"mean_latency"`
	P50Latency   int     `json:"p50_latency"`
	P95Latency   int     `json:"p95_latency"`
	P99Latency   int     `json:"p99_latency"`
}

// DispatchResult holds the dispatch latency results for all traced functions.
type DispatchResult struct {
	Functions []DispatchFunctionStats `json:"functions"`
}

// ComputeDispatch computes dispatch queueing latency distributions, batching
// over runs and merging per-batch latency histograms.
func ComputeDispatch(dbPath string, runID int64, batchSize int) (*DispatchResult, error) {
	db, err := reader.OpenDB(dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	defer db.Close()

	batches, err := batchesFor(dbPath, runID, batchSize)
	if err != nil {
		return nil, err
	}

	latencies := make(Hist)
	for _, sel := range batches {
		src := reader.TracesSource(dbPath, sel)
		query := fmt.Sprintf(`
			WITH latest_enter AS (
				SELECT run_id, trace_id, step
				FROM %[1]s
				WHERE trace_kind = 'Enter'
				QUALIFY ROW_NUMBER() OVER (PARTITION BY run_id, trace_id ORDER BY step DESC) = 1
			),
			paired AS (
				SELECT d.function_name, e.step - d.step AS latency
				FROM %[1]s d
				JOIN latest_enter e
				  ON d.run_id = e.run_id
				  AND d.trace_id = e.trace_id
				  AND d.trace_kind = 'Dispatch'
			)
			SELECT function_name, latency, COUNT(*) AS n
			FROM paired
			GROUP BY function_name, latency
		`, src)
		if err := scanHist(db, query, latencies); err != nil {
			return nil, fmt.Errorf("failed to query dispatch stats: %w", err)
		}
	}

	result := &DispatchResult{}
	for _, fn := range latencies.Functions() {
		st := latencies.Stats(fn)
		result.Functions = append(result.Functions, DispatchFunctionStats{
			FunctionName: fn,
			Count:        int(st.Count),
			MinLatency:   int(st.Min),
			MaxLatency:   int(st.Max),
			MeanLatency:  st.Mean,
			P50Latency:   int(latencies.Percentile(fn, 0.50)),
			P95Latency:   int(latencies.Percentile(fn, 0.95)),
			P99Latency:   int(latencies.Percentile(fn, 0.99)),
		})
	}
	return result, nil
}
