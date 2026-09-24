package main

import (
	"database/sql"
	"fmt"
	"os"
	"strings"
)

// runsCSV: one line per run of a symbolic session, for fitting the cap's
// units and reading solver shares: the run's steps and wall time, and the
// engine's time, pivots and merge work from its runs.clock.time report.
func runsCSV(dir string) {
	db, err := sql.Open("duckdb", "")
	if err != nil {
		panic(err)
	}
	fields := []string{"ops", "solver_us", "pivots", "solver_work", "comparisons", "flips_drawn", "flips_refused", "false_witnesses", "cost_units", "run_units", "left_to_concrete"}
	cols := []string{"run_id", "steps_used", "wall_us"}
	for _, f := range fields {
		cols = append(cols, fmt.Sprintf("coalesce(CAST(json_extract(clock, '$.time.%s') AS DOUBLE), 0)", f))
	}
	cols = append(cols, "coalesce(json_extract_string(clock, '$.time.conceded'), '')")
	q := fmt.Sprintf("SELECT %s FROM read_parquet('%s/runs/*.parquet') ORDER BY run_id", strings.Join(cols, ", "), dir)
	rows, err := db.Query(q)
	if err != nil {
		panic(err)
	}
	header := append([]string{"run_id", "steps", "wall_us"}, fields...)
	header = append(header, "conceded")
	fmt.Println(strings.Join(header, ","))
	n := len(header)
	for rows.Next() {
		vals := make([]any, n)
		ptrs := make([]any, n)
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			panic(err)
		}
		out := make([]string, n)
		for i, v := range vals {
			out[i] = fmt.Sprint(v)
		}
		fmt.Println(strings.Join(out, ","))
	}
	_ = os.Stdout.Sync()
}
