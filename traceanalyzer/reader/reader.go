package reader

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "github.com/marcboeker/go-duckdb/v2"
)

// isParquetDir returns true if the given path is a Parquet output directory.
// It handles the root output dir (containing "traces" and/or "executions" subdirs),
// or the "traces" / "executions" dir itself.
func isParquetDir(path string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return false
	}

	// Check if this is the root dir (has "traces" or "executions" subdirectory)
	for _, sub := range []string{"traces", "executions"} {
		subInfo, err := os.Stat(filepath.Join(path, sub))
		if err == nil && subInfo.IsDir() {
			return true
		}
	}

	// Check if this directory itself contains .parquet files
	files, err := filepath.Glob(filepath.Join(path, "*.parquet"))
	return err == nil && len(files) > 0
}

// openDB opens an in-memory DuckDB when path is a Parquet directory, or opens
// the DuckDB file directly otherwise.
func openDB(path string) (*sql.DB, error) {
	opts := duckDBDSNOptions()
	if isParquetDir(path) {
		return sql.Open("duckdb", opts)
	}
	return sql.Open("duckdb", path+opts)
}

// OpenDB opens the database for external use (metrics queries).
func OpenDB(path string) (*sql.DB, error) {
	return openDB(path)
}

// IsParquetDir is the exported version of isParquetDir.
func IsParquetDir(path string) bool {
	return isParquetDir(path)
}

// RunSel selects a half-open range of run ids, [Lo, Hi). Metrics run one
// selection at a time so their working set stays proportional to the batch
// rather than to the whole corpus.
type RunSel struct {
	Lo, Hi int64
	All    bool
}

// AllRuns selects every run.
func AllRuns() RunSel { return RunSel{All: true} }

// SingleRun selects exactly one run.
func SingleRun(id int64) RunSel { return RunSel{Lo: id, Hi: id + 1} }

// Selection maps the -run flag onto a RunSel: negative means all runs.
func Selection(runID int64) RunSel {
	if runID < 0 {
		return AllRuns()
	}
	return SingleRun(runID)
}

// scoped wraps a table expression so the run filter applies to every scan that
// interpolates it, including the ones inside CTEs.
func scoped(raw string, sel RunSel) string {
	if sel.All {
		return raw
	}
	return fmt.Sprintf("(SELECT * FROM %s WHERE run_id >= %d AND run_id < %d)", raw, sel.Lo, sel.Hi)
}

func rawTracesSource(path string) string {
	if isParquetDir(path) {
		if filepath.Base(path) == "traces" {
			return fmt.Sprintf("read_parquet('%s', union_by_name=true)", filepath.Join(path, "*.parquet"))
		}
		return fmt.Sprintf("read_parquet('%s', union_by_name=true)", filepath.Join(path, "traces", "*.parquet"))
	}
	return "traces"
}

func rawExecutionsSource(path string) string {
	if isParquetDir(path) {
		if filepath.Base(path) == "executions" {
			return fmt.Sprintf("read_parquet('%s', union_by_name=true)", filepath.Join(path, "*.parquet"))
		}
		return fmt.Sprintf("read_parquet('%s', union_by_name=true)", filepath.Join(path, "executions", "*.parquet"))
	}
	return "executions"
}

// TracesSource returns the SQL table expression for the traces relation,
// restricted to sel.
func TracesSource(path string, sel RunSel) string {
	return scoped(rawTracesSource(path), sel)
}

// ExecutionsSource returns the SQL table expression for the executions
// relation, restricted to sel.
func ExecutionsSource(path string, sel RunSel) string {
	return scoped(rawExecutionsSource(path), sel)
}

// RunBatches groups the corpus's run ids into contiguous half-open ranges of at
// most batchSize runs. Ranges are contiguous so DuckDB can prune Parquet row
// groups on the run_id predicate. batchSize <= 0 yields a single all-runs
// selection.
func RunBatches(dbPath string, batchSize int) ([]RunSel, error) {
	if batchSize <= 0 {
		return []RunSel{AllRuns()}, nil
	}
	ids, err := ListRunIDs(dbPath)
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, nil
	}
	var batches []RunSel
	for i := 0; i < len(ids); i += batchSize {
		j := min(i+batchSize, len(ids))
		batches = append(batches, RunSel{Lo: ids[i], Hi: ids[j-1] + 1})
	}
	return batches, nil
}

// ListRunIDs returns all available run IDs from traces (works for both DuckDB and Parquet).
func ListRunIDs(dbPath string) ([]int64, error) {
	db, err := openDB(dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	defer db.Close()

	src := TracesSource(dbPath, AllRuns())
	query := fmt.Sprintf(`SELECT DISTINCT run_id FROM %s ORDER BY run_id ASC`, src)

	rows, err := db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("failed to query run IDs: %w", err)
	}
	defer rows.Close()

	var runIDs []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("failed to scan run_id: %w", err)
		}
		runIDs = append(runIDs, id)
	}
	return runIDs, rows.Err()
}

// ReadTracesByRun reads trace rows for an explicit set of run_ids, grouped by
// run. Scanning straight into the map avoids holding a flat slice and the
// grouped copy at the same time.
func ReadTracesByRun(dbPath string, runIDs []int64) (map[int64][]TraceRow, error) {
	if len(runIDs) == 0 {
		return nil, nil
	}
	db, err := openDB(dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	defer db.Close()

	query := fmt.Sprintf(`
		SELECT run_id, seq_num, node_id, step, function_name, trace_kind,
		       payload, schedulable_count, trace_id, causal_operation_id
		FROM %s
		WHERE run_id IN (%s)
		ORDER BY run_id, seq_num ASC
	`, TracesSource(dbPath, AllRuns()), joinInt64s(runIDs))
	rows, err := db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("failed to query traces: %w", err)
	}
	defer rows.Close()

	result := make(map[int64][]TraceRow, len(runIDs))
	for rows.Next() {
		var t TraceRow
		if err := rows.Scan(
			&t.RunID, &t.SeqNum, &t.NodeID, &t.Step, &t.FunctionName,
			&t.TraceKind, &t.Payload, &t.SchedulableCount, &t.TraceID,
			&t.CausalOperationID,
		); err != nil {
			return nil, fmt.Errorf("failed to scan trace row: %w", err)
		}
		result[t.RunID] = append(result[t.RunID], t)
	}
	return result, rows.Err()
}

// ReadExecutionsByRun reads execution rows for an explicit set of run_ids,
// grouped by run.
func ReadExecutionsByRun(dbPath string, runIDs []int64) (map[int64][]ExecutionRow, error) {
	if len(runIDs) == 0 {
		return nil, nil
	}
	db, err := openDB(dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	defer db.Close()

	query := fmt.Sprintf(`
		SELECT run_id, seq_num, unique_id, client_id, kind, action, payload, step
		FROM %s
		WHERE run_id IN (%s)
		ORDER BY run_id, seq_num ASC
	`, ExecutionsSource(dbPath, AllRuns()), joinInt64s(runIDs))
	rows, err := db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("failed to query executions: %w", err)
	}
	defer rows.Close()

	result := make(map[int64][]ExecutionRow, len(runIDs))
	for rows.Next() {
		var e ExecutionRow
		if err := rows.Scan(
			&e.RunID, &e.SeqNum, &e.UniqueID, &e.ClientID,
			&e.Kind, &e.Action, &e.Payload, &e.Step,
		); err != nil {
			return nil, fmt.Errorf("failed to scan execution row: %w", err)
		}
		result[e.RunID] = append(result[e.RunID], e)
	}
	return result, rows.Err()
}

// joinInt64s renders ids as a comma-separated SQL list. Values are integers,
// so direct interpolation is injection-safe.
func joinInt64s(ids []int64) string {
	var b strings.Builder
	for i, id := range ids {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, "%d", id)
	}
	return b.String()
}
