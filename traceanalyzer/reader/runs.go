package reader

import (
	"fmt"
	"os"
	"path/filepath"
)

// RunRow is one row of the explorer's runs table: which strategy issued the
// run, its seeds, and what it cost.
type RunRow struct {
	RunID           int64  `json:"run_id"`
	Arm             string `json:"arm"`
	ArmIndex        int32  `json:"arm_index"`
	ConfigIndex     int32  `json:"config_index"`
	WorkloadSeed    uint64 `json:"workload_seed"`
	ScheduleSeed    uint64 `json:"schedule_seed"`
	StepsUsed       int32  `json:"steps_used"`
	WallUs          int64  `json:"wall_us"`
	EndReason       string `json:"end_reason"`
	SessionOffsetMs int64  `json:"session_offset_ms"`
}

// runsDir returns the runs table directory of a parquet corpus, or "" when
// the corpus has none (a DuckDB file, or output written before the table
// existed).
func runsDir(path string) string {
	if !isParquetDir(path) {
		return ""
	}
	dir := filepath.Join(path, "runs")
	if filepath.Base(path) == "runs" {
		dir = path
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return ""
	}
	files, err := filepath.Glob(filepath.Join(dir, "*.parquet"))
	if err != nil || len(files) == 0 {
		return ""
	}
	return dir
}

// HasRuns reports whether the corpus carries a runs table.
func HasRuns(path string) bool {
	return runsDir(path) != ""
}

// ReadRuns reads every row of the runs table in run_id order.
func ReadRuns(path string) ([]RunRow, error) {
	dir := runsDir(path)
	if dir == "" {
		return nil, nil
	}
	db, err := openDB(path)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	defer db.Close()

	query := fmt.Sprintf(`
		SELECT run_id, arm, arm_index, config_index, workload_seed, schedule_seed,
		       steps_used, wall_us, end_reason, session_offset_ms
		FROM read_parquet('%s', union_by_name=true)
		ORDER BY run_id ASC
	`, filepath.Join(dir, "*.parquet"))
	rows, err := db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("failed to query runs: %w", err)
	}
	defer rows.Close()

	var out []RunRow
	for rows.Next() {
		var r RunRow
		if err := rows.Scan(
			&r.RunID, &r.Arm, &r.ArmIndex, &r.ConfigIndex, &r.WorkloadSeed, &r.ScheduleSeed,
			&r.StepsUsed, &r.WallUs, &r.EndReason, &r.SessionOffsetMs,
		); err != nil {
			return nil, fmt.Errorf("failed to scan run row: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
