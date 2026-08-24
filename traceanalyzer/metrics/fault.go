package metrics

import (
	"database/sql"
	"fmt"
	"sort"

	"github.com/benaepli/turnpike-traceanalyzer/reader"
)

// CrashDuringFunction shows which functions were active when a crash occurred.
type CrashDuringFunction struct {
	FunctionName   string `json:"function_name"`
	InterruptCount int    `json:"interrupt_count"`
}

// CrashDistanceStats shows the minimum distance between crash events and trace events.
type CrashDistanceStats struct {
	MinDistance  int     `json:"min_distance"`
	MaxDistance  int     `json:"max_distance"`
	MeanDistance float64 `json:"mean_distance"`
	CrashCount   int     `json:"crash_count"`
}

// FunctionCrashCoverage shows the fraction of runs where a function was active during a crash.
type FunctionCrashCoverage struct {
	FunctionName     string  `json:"function_name"`
	RunsWithCrash    int     `json:"runs_with_crash"`
	TotalRuns        int     `json:"total_runs"`
	CoverageFraction float64 `json:"coverage_fraction"`
}

// FaultResult holds the complete fault/crash analysis.
type FaultResult struct {
	CrashDuringFunc []CrashDuringFunction   `json:"crash_during_function"`
	CrashDistance   *CrashDistanceStats     `json:"crash_distance"`
	CrashCoverage   []FunctionCrashCoverage `json:"crash_coverage"`
}

// ComputeFault computes crash proximity metrics by joining traces and
// executions, batching over runs. Interrupt and coverage counts sum across
// batches; the crash-distance aggregate merges as min/max plus a running
// sum and count.
func ComputeFault(dbPath string, runID int64, batchSize int) (*FaultResult, error) {
	db, err := reader.OpenDB(dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	defer db.Close()

	batches, err := batchesFor(dbPath, runID, batchSize)
	if err != nil {
		return nil, err
	}

	interrupts := make(Counters)
	crashRuns := make(Counters)
	var totalRuns int64
	dist := crashDistanceAcc{}

	for _, sel := range batches {
		tSrc := reader.TracesSource(dbPath, sel)
		eSrc := reader.ExecutionsSource(dbPath, sel)

		if err := collectCrashDuringFunc(db, tSrc, eSrc, interrupts); err != nil {
			return nil, err
		}
		if err := collectCrashDistance(db, tSrc, eSrc, &dist); err != nil {
			return nil, err
		}
		batchRuns, err := collectCrashCoverage(db, tSrc, eSrc, crashRuns)
		if err != nil {
			return nil, err
		}
		totalRuns += batchRuns
	}

	result := &FaultResult{}

	for fn, n := range interrupts {
		result.CrashDuringFunc = append(result.CrashDuringFunc, CrashDuringFunction{
			FunctionName:   fn,
			InterruptCount: int(n),
		})
	}
	sort.Slice(result.CrashDuringFunc, func(i, j int) bool {
		a, b := result.CrashDuringFunc[i], result.CrashDuringFunc[j]
		if a.InterruptCount != b.InterruptCount {
			return a.InterruptCount > b.InterruptCount
		}
		return a.FunctionName < b.FunctionName
	})

	for fn, n := range crashRuns {
		c := FunctionCrashCoverage{
			FunctionName:  fn,
			RunsWithCrash: int(n),
			TotalRuns:     int(totalRuns),
		}
		if totalRuns > 0 {
			c.CoverageFraction = float64(n) / float64(totalRuns)
		}
		result.CrashCoverage = append(result.CrashCoverage, c)
	}
	sort.Slice(result.CrashCoverage, func(i, j int) bool {
		a, b := result.CrashCoverage[i], result.CrashCoverage[j]
		if a.CoverageFraction != b.CoverageFraction {
			return a.CoverageFraction > b.CoverageFraction
		}
		return a.FunctionName < b.FunctionName
	})

	if dist.count > 0 {
		result.CrashDistance = &CrashDistanceStats{
			CrashCount:   int(dist.count),
			MinDistance:  int(dist.min),
			MaxDistance:  int(dist.max),
			MeanDistance: float64(dist.sum) / float64(dist.count),
		}
	}

	return result, nil
}

// crashDistanceAcc merges per-batch crash-distance aggregates. Keeping the sum
// and count separately makes the mean exact regardless of how runs are split
// into batches.
type crashDistanceAcc struct {
	count int64
	min   int64
	max   int64
	sum   int64
}

// collectCrashDuringFunc counts invocations that were still active when a crash
// landed in the same run.
func collectCrashDuringFunc(db *sql.DB, tSrc, eSrc string, interrupts Counters) error {
	query := fmt.Sprintf(`
		WITH paired AS (
			SELECT e.run_id, e.node_id, e.function_name,
			       e.step AS enter_step, x.step AS exit_step
			FROM %[1]s e
			JOIN %[1]s x
			  ON e.run_id = x.run_id
			  AND e.trace_id = x.trace_id
			  AND e.trace_kind = 'Enter'
			  AND x.trace_kind = 'Exit'
		),
		crashes AS (
			SELECT run_id, seq_num
			FROM %[2]s
			WHERE kind = 'Invocation' AND action LIKE '%%System.Crash'
		)
		SELECT p.function_name, COUNT(*) AS interrupt_count
		FROM paired p
		JOIN crashes c
		  ON p.run_id = c.run_id
		  AND c.seq_num >= p.enter_step
		  AND c.seq_num <= p.exit_step
		GROUP BY p.function_name
	`, tSrc, eSrc)

	if err := scanCounters(db, query, interrupts); err != nil {
		return fmt.Errorf("failed to query crash-during-function: %w", err)
	}
	return nil
}

// collectCrashDistance folds one batch's crash-to-trace distances into acc.
func collectCrashDistance(db *sql.DB, tSrc, eSrc string, acc *crashDistanceAcc) error {
	query := fmt.Sprintf(`
		WITH crashes AS (
			SELECT run_id, seq_num
			FROM %[2]s
			WHERE kind = 'Invocation' AND action LIKE '%%System.Crash'
		),
		crash_trace_dist AS (
			SELECT c.run_id, c.seq_num AS crash_seq, MIN(ABS(c.seq_num - t.step)) AS min_dist
			FROM crashes c
			JOIN %[1]s t ON c.run_id = t.run_id
			GROUP BY c.run_id, c.seq_num
		)
		SELECT COUNT(*), MIN(min_dist), MAX(min_dist), SUM(min_dist)
		FROM crash_trace_dist
	`, tSrc, eSrc)

	var count int64
	var minDist, maxDist, sumDist sql.NullInt64
	if err := db.QueryRow(query).Scan(&count, &minDist, &maxDist, &sumDist); err != nil {
		if err == sql.ErrNoRows {
			return nil
		}
		return fmt.Errorf("failed to query crash distance: %w", err)
	}
	if count == 0 {
		return nil
	}

	if acc.count == 0 || (minDist.Valid && minDist.Int64 < acc.min) {
		acc.min = minDist.Int64
	}
	if acc.count == 0 || (maxDist.Valid && maxDist.Int64 > acc.max) {
		acc.max = maxDist.Int64
	}
	acc.count += count
	acc.sum += sumDist.Int64
	return nil
}

// collectCrashCoverage counts, per function, the runs where it was active
// during a crash, and returns the batch's total run count.
func collectCrashCoverage(db *sql.DB, tSrc, eSrc string, crashRuns Counters) (int64, error) {
	query := fmt.Sprintf(`
		WITH paired AS (
			SELECT e.run_id, e.node_id, e.function_name,
			       e.step AS enter_step, x.step AS exit_step
			FROM %[1]s e
			JOIN %[1]s x
			  ON e.run_id = x.run_id
			  AND e.trace_id = x.trace_id
			  AND e.trace_kind = 'Enter'
			  AND x.trace_kind = 'Exit'
		),
		crashes AS (
			SELECT run_id, seq_num
			FROM %[2]s
			WHERE kind = 'Invocation' AND action LIKE '%%System.Crash'
		)
		SELECT p.function_name, COUNT(DISTINCT p.run_id) AS runs_with_crash
		FROM paired p
		JOIN crashes c
		  ON p.run_id = c.run_id
		  AND c.seq_num >= p.enter_step
		  AND c.seq_num <= p.exit_step
		GROUP BY p.function_name
	`, tSrc, eSrc)

	if err := scanCounters(db, query, crashRuns); err != nil {
		return 0, fmt.Errorf("failed to query crash coverage: %w", err)
	}

	var totalRuns int64
	if err := db.QueryRow(fmt.Sprintf(
		`SELECT COUNT(DISTINCT run_id) FROM %s`, tSrc,
	)).Scan(&totalRuns); err != nil {
		return 0, fmt.Errorf("failed to query total runs: %w", err)
	}
	return totalRuns, nil
}
