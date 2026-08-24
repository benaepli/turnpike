package metrics

import (
	"database/sql"
	"fmt"
	"sort"

	"github.com/benaepli/turnpike-traceanalyzer/reader"
)

// InterleavingDepthStats holds per-function interleaving depth statistics.
type InterleavingDepthStats struct {
	FunctionName string  `json:"function_name"`
	Count        int     `json:"count"`
	MinDepth     int     `json:"min_depth"`
	MaxDepth     int     `json:"max_depth"`
	MeanDepth    float64 `json:"mean_depth"`
	P50Depth     int     `json:"p50_depth"`
	P95Depth     int     `json:"p95_depth"`
}

// OverlapStats holds same-function concurrent overlap statistics.
type OverlapStats struct {
	FunctionName    string  `json:"function_name"`
	TotalPairs      int     `json:"total_pairs"`
	OverlapCount    int     `json:"overlap_count"`
	OverlapFraction float64 `json:"overlap_fraction"`
}

// SchedDeltaStats holds schedulable count delta statistics per function.
type SchedDeltaStats struct {
	FunctionName string  `json:"function_name"`
	Count        int     `json:"count"`
	MinDelta     int64   `json:"min_delta"`
	MaxDelta     int64   `json:"max_delta"`
	MeanDelta    float64 `json:"mean_delta"`
}

// InterleavingResult holds the complete interleaving analysis.
type InterleavingResult struct {
	Depth      []InterleavingDepthStats `json:"interleaving_depth"`
	Overlap    []OverlapStats           `json:"concurrent_overlap"`
	SchedDelta []SchedDeltaStats        `json:"schedulable_count_delta"`
}

// ComputeInterleaving computes concurrency and overlap metrics, batching over
// runs. Depth and schedulable-count deltas merge as histograms; overlap merges
// as pair counts.
func ComputeInterleaving(dbPath string, runID int64, batchSize int) (*InterleavingResult, error) {
	db, err := reader.OpenDB(dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	defer db.Close()

	batches, err := batchesFor(dbPath, runID, batchSize)
	if err != nil {
		return nil, err
	}

	depths := make(Hist)
	deltas := make(Hist)
	totalPairs := make(Counters)
	overlaps := make(Counters)

	for _, sel := range batches {
		src := reader.TracesSource(dbPath, sel)
		if err := collectDepth(db, src, depths); err != nil {
			return nil, err
		}
		if err := collectOverlap(db, src, totalPairs, overlaps); err != nil {
			return nil, err
		}
		if err := collectSchedDelta(db, src, deltas); err != nil {
			return nil, err
		}
	}

	result := &InterleavingResult{}
	for _, fn := range depths.Functions() {
		st := depths.Stats(fn)
		result.Depth = append(result.Depth, InterleavingDepthStats{
			FunctionName: fn,
			Count:        int(st.Count),
			MinDepth:     int(st.Min),
			MaxDepth:     int(st.Max),
			MeanDepth:    st.Mean,
			P50Depth:     int(depths.Percentile(fn, 0.50)),
			P95Depth:     int(depths.Percentile(fn, 0.95)),
		})
	}

	pairFns := make([]string, 0, len(totalPairs))
	for fn := range totalPairs {
		pairFns = append(pairFns, fn)
	}
	sort.Strings(pairFns)
	for _, fn := range pairFns {
		o := OverlapStats{
			FunctionName: fn,
			TotalPairs:   int(totalPairs[fn]),
			OverlapCount: int(overlaps[fn]),
		}
		if o.TotalPairs > 0 {
			o.OverlapFraction = float64(o.OverlapCount) / float64(o.TotalPairs)
		}
		result.Overlap = append(result.Overlap, o)
	}

	for _, fn := range deltas.Functions() {
		st := deltas.Stats(fn)
		result.SchedDelta = append(result.SchedDelta, SchedDeltaStats{
			FunctionName: fn,
			Count:        int(st.Count),
			MinDelta:     st.Min,
			MaxDelta:     st.Max,
			MeanDelta:    st.Mean,
		})
	}

	return result, nil
}

// collectDepth counts, for each paired invocation, the trace events from other
// nodes that fall inside its [enter_step, exit_step] window.
func collectDepth(db *sql.DB, src string, depths Hist) error {
	query := fmt.Sprintf(`
		WITH latest_enter AS (
			SELECT run_id, node_id, trace_id, function_name, step
			FROM %[1]s
			WHERE trace_kind = 'Enter'
			QUALIFY ROW_NUMBER() OVER (PARTITION BY run_id, trace_id ORDER BY step DESC) = 1
		),
		paired AS (
			SELECT e.run_id, e.trace_id, e.node_id, e.function_name,
			       e.step AS enter_step, x.step AS exit_step
			FROM latest_enter e
			JOIN %[1]s x
			  ON e.run_id = x.run_id
			  AND e.trace_id = x.trace_id
			  AND x.trace_kind = 'Exit'
		),
		depth_per_inv AS (
			SELECT p.function_name, COUNT(t.run_id) AS depth
			FROM paired p
			LEFT JOIN %[1]s t
			  ON t.run_id = p.run_id
			  AND t.node_id != p.node_id
			  AND t.step >= p.enter_step
			  AND t.step <= p.exit_step
			GROUP BY p.run_id, p.trace_id, p.function_name
		)
		SELECT function_name, depth, COUNT(*) AS n
		FROM depth_per_inv
		GROUP BY function_name, depth
	`, src)

	if err := scanHist(db, query, depths); err != nil {
		return fmt.Errorf("failed to query interleaving depth: %w", err)
	}
	return nil
}

// collectOverlap counts same-function invocation pairs on different nodes and
// how many of them overlap in time.
func collectOverlap(db *sql.DB, src string, totalPairs, overlaps Counters) error {
	query := fmt.Sprintf(`
		WITH latest_enter AS (
			SELECT run_id, node_id, trace_id, function_name, step
			FROM %[1]s
			WHERE trace_kind = 'Enter'
			QUALIFY ROW_NUMBER() OVER (PARTITION BY run_id, trace_id ORDER BY step DESC) = 1
		),
		paired AS (
			SELECT e.run_id, e.node_id, e.function_name,
			       e.step AS enter_step, x.step AS exit_step
			FROM latest_enter e
			JOIN %[1]s x
			  ON e.run_id = x.run_id
			  AND e.trace_id = x.trace_id
			  AND x.trace_kind = 'Exit'
		)
		SELECT
			a.function_name,
			COUNT(*) AS total_pairs,
			SUM(CASE WHEN a.enter_step <= b.exit_step AND b.enter_step <= a.exit_step THEN 1 ELSE 0 END) AS overlap_count
		FROM paired a
		JOIN paired b
		  ON a.run_id = b.run_id
		  AND a.function_name = b.function_name
		  AND a.node_id < b.node_id
		GROUP BY a.function_name
	`, src)

	rows, err := db.Query(query)
	if err != nil {
		return fmt.Errorf("failed to query overlap: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var fn string
		var pairs, overlap int64
		if err := rows.Scan(&fn, &pairs, &overlap); err != nil {
			return fmt.Errorf("failed to scan overlap row: %w", err)
		}
		totalPairs.Add(fn, pairs)
		overlaps.Add(fn, overlap)
	}
	return rows.Err()
}

// collectSchedDelta records the change in schedulable_count across each paired
// invocation.
func collectSchedDelta(db *sql.DB, src string, deltas Hist) error {
	query := fmt.Sprintf(`
		WITH latest_enter AS (
			SELECT run_id, trace_id, function_name, schedulable_count
			FROM %[1]s
			WHERE trace_kind = 'Enter'
			QUALIFY ROW_NUMBER() OVER (PARTITION BY run_id, trace_id ORDER BY step DESC) = 1
		),
		paired AS (
			SELECT e.function_name, x.schedulable_count - e.schedulable_count AS delta
			FROM latest_enter e
			JOIN %[1]s x
			  ON e.run_id = x.run_id
			  AND e.trace_id = x.trace_id
			  AND x.trace_kind = 'Exit'
		)
		SELECT function_name, delta, COUNT(*) AS n
		FROM paired
		GROUP BY function_name, delta
	`, src)

	if err := scanHist(db, query, deltas); err != nil {
		return fmt.Errorf("failed to query sched delta: %w", err)
	}
	return nil
}
