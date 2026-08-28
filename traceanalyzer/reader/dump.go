package reader

import (
	"fmt"
	"path/filepath"
)

// LogRow is one row of the logs table.
type LogRow struct {
	RunID   int64  `json:"run_id"`
	SeqNum  int64  `json:"seq_num"`
	NodeID  int64  `json:"node_id"`
	Step    int32  `json:"step"`
	Content string `json:"content"`
}

// RunDump is every row of one run across the three history tables, read
// through the run_id predicate so the rest of the corpus stays on disk.
type RunDump struct {
	RunID      int64          `json:"run_id"`
	Executions []ExecutionRow `json:"executions"`
	Traces     []TraceRow     `json:"traces"`
	Logs       []LogRow       `json:"logs"`
}

func rawLogsSource(path string) string {
	if isParquetDir(path) {
		if filepath.Base(path) == "logs" {
			return fmt.Sprintf("read_parquet('%s', union_by_name=true)", filepath.Join(path, "*.parquet"))
		}
		return fmt.Sprintf("read_parquet('%s', union_by_name=true)", filepath.Join(path, "logs", "*.parquet"))
	}
	return "logs"
}

// DumpRun reads one run's executions, traces and logs.
func DumpRun(dbPath string, runID int64) (*RunDump, error) {
	execs, err := ReadExecutionsByRun(dbPath, []int64{runID})
	if err != nil {
		return nil, err
	}
	traces, err := ReadTracesByRun(dbPath, []int64{runID})
	if err != nil {
		return nil, err
	}
	db, err := openDB(dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	defer db.Close()
	query := fmt.Sprintf(`
		SELECT run_id, seq_num, node_id, step, content
		FROM %s
		WHERE run_id = %d
		ORDER BY seq_num ASC
	`, rawLogsSource(dbPath), runID)
	rows, err := db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("failed to query logs: %w", err)
	}
	defer rows.Close()
	var logs []LogRow
	for rows.Next() {
		var l LogRow
		if err := rows.Scan(&l.RunID, &l.SeqNum, &l.NodeID, &l.Step, &l.Content); err != nil {
			return nil, fmt.Errorf("failed to scan log row: %w", err)
		}
		logs = append(logs, l)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	d := &RunDump{RunID: runID, Executions: execs[runID], Traces: traces[runID], Logs: logs}
	if d.Executions == nil {
		d.Executions = []ExecutionRow{}
	}
	if d.Traces == nil {
		d.Traces = []TraceRow{}
	}
	if d.Logs == nil {
		d.Logs = []LogRow{}
	}
	return d, nil
}
