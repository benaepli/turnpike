package reader

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
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
	return ReadExecutionsByRunWhere(dbPath, runIDs, nil)
}

// RowClause selects a subset of a run's execution rows. `Where` is a SQL
// predicate over the row. A clause with `PerRunCap` set names timer firings:
// the rows are read aggregated per run, at most `PerRunCap` of them in
// seq_num order, and rebuilt as rows whose client_id is the node and whose
// action is `System.TimerFired/label`; `Node` and `Label` are the SQL
// expressions that yield them. Firings of one timer can outnumber every
// other row of a run a hundred times over, and moving them one row at a
// time through the driver costs more than the scan.
type RowClause struct {
	Where     string
	PerRunCap int
	Node      string
	Label     string
}

// ReadExecutionsByRunWhere is ReadExecutionsByRun restricted to the rows that
// satisfy any one of `clauses`. Each clause is read by its own select, joined
// by UNION ALL rather than as one OR: DuckDB pushes a predicate into the
// parquet scan only when it tests single columns, so each clause must be a
// conjunction of column tests for the scan to skip the rows it excludes.
func ReadExecutionsByRunWhere(dbPath string, runIDs []int64, clauses []RowClause) (map[int64][]ExecutionRow, error) {
	if len(runIDs) == 0 {
		return nil, nil
	}
	db, err := openDB(dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	defer db.Close()

	source := ExecutionsSource(dbPath, AllRuns())
	inRuns := fmt.Sprintf("run_id IN (%s)", joinInt64s(runIDs))
	result := make(map[int64][]ExecutionRow, len(runIDs))

	var rowSelects []string
	var aggregated []RowClause
	for _, c := range clauses {
		if c.PerRunCap > 0 {
			aggregated = append(aggregated, c)
			continue
		}
		rowSelects = append(rowSelects, fmt.Sprintf("SELECT run_id, seq_num, unique_id, client_id, kind, action, payload, step FROM %s WHERE %s AND (%s)", source, inRuns, c.Where))
	}
	if len(clauses) == 0 {
		rowSelects = append(rowSelects, fmt.Sprintf("SELECT run_id, seq_num, unique_id, client_id, kind, action, payload, step FROM %s WHERE %s", source, inRuns))
	}
	if len(rowSelects) > 0 {
		query := "SELECT * FROM (" + strings.Join(rowSelects, " UNION ALL ") + ") ORDER BY run_id, seq_num ASC"
		rows, err := db.Query(query)
		if err != nil {
			return nil, fmt.Errorf("failed to query executions: %w", err)
		}
		for rows.Next() {
			var e ExecutionRow
			if err := rows.Scan(
				&e.RunID, &e.SeqNum, &e.UniqueID, &e.ClientID,
				&e.Kind, &e.Action, &e.Payload, &e.Step,
			); err != nil {
				rows.Close()
				return nil, fmt.Errorf("failed to scan execution row: %w", err)
			}
			result[e.RunID] = append(result[e.RunID], e)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}

	merged := len(aggregated) > 0
	for _, c := range aggregated {
		// The cap is applied in seq_num order before aggregation so the rows
		// are the first PerRunCap firings, the same ones a consumer keeps
		// when it truncates the run's candidates itself.
		query := fmt.Sprintf(`SELECT run_id, list(seq_num ORDER BY seq_num), list(step ORDER BY seq_num), list(node ORDER BY seq_num), list(label ORDER BY seq_num)
			FROM (SELECT run_id, seq_num, step, %s AS node, %s AS label,
				row_number() OVER (PARTITION BY run_id ORDER BY seq_num) AS rn
				FROM %s WHERE %s AND (%s))
			WHERE rn <= %d GROUP BY run_id`, c.Node, c.Label, source, inRuns, c.Where, c.PerRunCap)
		rows, err := db.Query(query)
		if err != nil {
			return nil, fmt.Errorf("failed to query timer firings: %w", err)
		}
		for rows.Next() {
			var runID int64
			var seqs, steps, nodes []any
			var labels []any
			if err := rows.Scan(&runID, &seqs, &steps, &nodes, &labels); err != nil {
				rows.Close()
				return nil, fmt.Errorf("failed to scan timer firings: %w", err)
			}
			for i := range seqs {
				result[runID] = append(result[runID], ExecutionRow{
					RunID:    runID,
					SeqNum:   asInt64(seqs[i]),
					UniqueID: -1,
					ClientID: asInt64(nodes[i]),
					Kind:     "TimerFired",
					Action:   TimerActionPrefix + asString(labels[i]),
					Step:     int32(asInt64(steps[i])),
				})
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	if merged {
		for id, rs := range result {
			sort.Slice(rs, func(i, j int) bool { return rs[i].SeqNum < rs[j].SeqNum })
			result[id] = rs
		}
	}
	return result, nil
}

// TimerActionPrefix starts the action of a timer row whose client_id names
// the node; the label follows it.
const TimerActionPrefix = "System.TimerFired/"

// EnterRow is a handler entry with the node that dispatched the message it
// handles: the rows a matcher needs to place a delivery of a named handler.
type EnterRow struct {
	RunID        int64
	SeqNum       int64
	NodeID       int64
	Step         int32
	FunctionName string
	TraceID      int64
	// Sender is the node of the first Dispatch row carrying the same
	// trace_id in seq_num order, or -1 when no Dispatch row joins.
	Sender int64
}

// ReadEntersForMatching reads, per run, the Enter rows of the named
// functions with their sender attached, at most `perGroupCap` per run,
// function, receiver and sender in seq_num order. A run's traces number in
// the thousands and a matcher keeps only the first few hundred candidates
// of a delivery, so the projection, the join and the cap happen in the
// store. The cap is taken on the finest grouping a delivery can be matched
// by, so the first `perGroupCap` rows of any coarser selection survive it.
func ReadEntersForMatching(dbPath string, runIDs []int64, functions []string, perGroupCap int) (map[int64][]EnterRow, error) {
	result := make(map[int64][]EnterRow, len(runIDs))
	if len(runIDs) == 0 || len(functions) == 0 {
		return result, nil
	}
	db, err := openDB(dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	defer db.Close()

	quoted := make([]string, 0, len(functions))
	for _, f := range functions {
		quoted = append(quoted, "'"+strings.ReplaceAll(f, "'", "''")+"'")
	}
	source := TracesSource(dbPath, AllRuns())
	inRuns := fmt.Sprintf("run_id IN (%s)", joinInt64s(runIDs))
	query := fmt.Sprintf(`WITH d AS (
			SELECT run_id, trace_id, arg_min(node_id, seq_num) AS sender
			FROM %s WHERE %s AND trace_kind = 'Dispatch' GROUP BY run_id, trace_id),
		e AS (
			SELECT run_id, seq_num, node_id, step, function_name, trace_id
			FROM %s WHERE %s AND trace_kind = 'Enter' AND function_name IN (%s))
		SELECT run_id, seq_num, node_id, step, function_name, trace_id, sender FROM (
			SELECT e.run_id, e.seq_num, e.node_id, e.step, e.function_name, e.trace_id,
				coalesce(d.sender, -1) AS sender,
				row_number() OVER (PARTITION BY e.run_id, e.function_name, e.node_id, coalesce(d.sender, -1) ORDER BY e.seq_num) AS rn
			FROM e LEFT JOIN d ON d.run_id = e.run_id AND d.trace_id = e.trace_id)
		WHERE rn <= %d ORDER BY run_id, seq_num ASC`,
		source, inRuns, source, inRuns, strings.Join(quoted, ", "), perGroupCap)
	rows, err := db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("failed to query handler entries: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var r EnterRow
		if err := rows.Scan(&r.RunID, &r.SeqNum, &r.NodeID, &r.Step, &r.FunctionName, &r.TraceID, &r.Sender); err != nil {
			return nil, fmt.Errorf("failed to scan handler entry: %w", err)
		}
		result[r.RunID] = append(result[r.RunID], r)
	}
	return result, rows.Err()
}

// TimerEncoding reports how a corpus records the node of a timer firing:
// "column" when the row's client_id names the node and its action ends in
// the label, "payload" when only the payload carries them, "none" when the
// corpus has no timer rows. One row decides it: a corpus is written by one
// binary.
func TimerEncoding(dbPath string) (string, error) {
	db, err := openDB(dbPath)
	if err != nil {
		return "", fmt.Errorf("failed to open database: %w", err)
	}
	defer db.Close()
	query := fmt.Sprintf("SELECT client_id FROM %s WHERE kind = 'TimerFired' LIMIT 1", ExecutionsSource(dbPath, AllRuns()))
	var clientID int64
	err = db.QueryRow(query).Scan(&clientID)
	switch {
	case err == sql.ErrNoRows:
		return "none", nil
	case err != nil:
		return "", fmt.Errorf("failed to probe timer rows: %w", err)
	case clientID >= 0:
		return "column", nil
	default:
		return "payload", nil
	}
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
