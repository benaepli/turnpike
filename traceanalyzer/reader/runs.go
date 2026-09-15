package reader

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
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
	// Bitfield naming the session-global mechanisms that selected the run:
	// 1 placed crashes, 2 run-cap probe, 4 timer-context probe, 8 a crash
	// hold was actually drawn. Zero for a corpus written before the column.
	Variant int32 `json:"variant"`
	// Index into the deployments table; -1 when the run failed before a
	// deployment was chosen.
	DeploymentID int32 `json:"deployment_id"`
	// JSON object of the parameter tuple that selected the run, kept as the
	// text the table stores.
	Params string `json:"params"`
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
			case "variant":
				r.Variant = int32(asInt64(v))
			case "deployment_id":
				r.DeploymentID = int32(asInt64(v))
			case "params":
				r.Params = asString(v)
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

// runColumnIndex maps each RunRow JSON field name to its struct field index.
func runColumnIndex() map[string]int {
	t := reflect.TypeOf(RunRow{})
	idx := make(map[string]int, t.NumField())
	for i := 0; i < t.NumField(); i++ {
		name := strings.Split(t.Field(i).Tag.Get("json"), ",")[0]
		if name != "" {
			idx[name] = i
		}
	}
	return idx
}

// WriteRunsProjected writes the runs table as one JSON array holding only
// the named columns of each row, in the order given. Column names are the
// JSON field names of RunRow; an unknown name is an error before any output
// is written. Rows are streamed so a table of millions of runs never has a
// second copy in memory.
func WriteRunsProjected(w io.Writer, rows []RunRow, cols []string) error {
	idx := runColumnIndex()
	fields := make([]int, 0, len(cols))
	keys := make([][]byte, 0, len(cols))
	for _, c := range cols {
		i, ok := idx[c]
		if !ok {
			return fmt.Errorf("unknown runs column %q", c)
		}
		fields = append(fields, i)
		key, err := json.Marshal(c)
		if err != nil {
			return err
		}
		keys = append(keys, key)
	}
	bw := bufio.NewWriterSize(w, 1<<20)
	bw.WriteByte('[')
	for n := range rows {
		if n > 0 {
			bw.WriteByte(',')
		}
		rv := reflect.ValueOf(&rows[n]).Elem()
		bw.WriteByte('{')
		for k, i := range fields {
			if k > 0 {
				bw.WriteByte(',')
			}
			val, err := json.Marshal(rv.Field(i).Interface())
			if err != nil {
				return err
			}
			bw.Write(keys[k])
			bw.WriteByte(':')
			bw.Write(val)
		}
		bw.WriteByte('}')
	}
	bw.WriteString("]\n")
	return bw.Flush()
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
