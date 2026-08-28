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
	// Timer firings that woke a waiting record, and how many changed the
	// node's state, split by whether a delivery to the node was pending.
	// Zero for a corpus written before these columns existed.
	TimersFired         int32 `json:"timers_fired"`
	TimersActed         int32 `json:"timers_acted"`
	TimersInflightFired int32 `json:"timers_inflight_fired"`
	TimersInflightActed int32 `json:"timers_inflight_acted"`
	TimersIdleFired     int32 `json:"timers_idle_fired"`
	TimersIdleActed     int32 `json:"timers_idle_acted"`
	MaxInertStreak      int32 `json:"max_inert_streak"`
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

	// Every column is read by name so a corpus from before a column existed
	// still loads, with that column at its zero value.
	query := fmt.Sprintf(`
		SELECT * FROM read_parquet('%s', union_by_name=true)
		ORDER BY run_id ASC
	`, filepath.Join(dir, "*.parquet"))
	rows, err := db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("failed to query runs: %w", err)
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, fmt.Errorf("failed to read run columns: %w", err)
	}

	var out []RunRow
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, fmt.Errorf("failed to scan run row: %w", err)
		}
		var r RunRow
		for i, c := range cols {
			v := vals[i]
			switch c {
			case "run_id":
				r.RunID = asInt64(v)
			case "arm":
				r.Arm = asString(v)
			case "arm_index":
				r.ArmIndex = int32(asInt64(v))
			case "config_index":
				r.ConfigIndex = int32(asInt64(v))
			case "workload_seed":
				r.WorkloadSeed = uint64(asInt64(v))
			case "schedule_seed":
				r.ScheduleSeed = uint64(asInt64(v))
			case "steps_used":
				r.StepsUsed = int32(asInt64(v))
			case "wall_us":
				r.WallUs = asInt64(v)
			case "end_reason":
				r.EndReason = asString(v)
			case "session_offset_ms":
				r.SessionOffsetMs = asInt64(v)
			case "timers_fired":
				r.TimersFired = int32(asInt64(v))
			case "timers_acted":
				r.TimersActed = int32(asInt64(v))
			case "timers_inflight_fired":
				r.TimersInflightFired = int32(asInt64(v))
			case "timers_inflight_acted":
				r.TimersInflightActed = int32(asInt64(v))
			case "timers_idle_fired":
				r.TimersIdleFired = int32(asInt64(v))
			case "timers_idle_acted":
				r.TimersIdleActed = int32(asInt64(v))
			case "max_inert_streak":
				r.MaxInertStreak = int32(asInt64(v))
			}
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// asInt64 reads any integer or float column value; NULL reads as zero.
func asInt64(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case int32:
		return int64(x)
	case int16:
		return int64(x)
	case int8:
		return int64(x)
	case int:
		return int64(x)
	case uint64:
		return int64(x)
	case uint32:
		return int64(x)
	case uint16:
		return int64(x)
	case uint8:
		return int64(x)
	case float64:
		return int64(x)
	case float32:
		return int64(x)
	default:
		return 0
	}
}

func asString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []byte:
		return string(x)
	case nil:
		return ""
	default:
		return fmt.Sprint(x)
	}
}
