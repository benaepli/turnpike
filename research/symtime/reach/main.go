// reach DIR: one explore session's reach readings as JSON on stdout.
// reach novelty DIR: for a symbolic session with its traces and logs, how
// often runs that took a flip are new, against runs that did not.
//
// Runs and their wall time, check verdicts by reason, and for a symbolic
// session the sums of every counter in each run's runs.clock.time report.
// Reads the Parquet tables through DuckDB, so a session of millions of runs
// is summarised without writing it out again.
package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	_ "github.com/marcboeker/go-duckdb/v2"
)

var counters = []string{
	"comparisons", "witnessed_taken", "flips_drawn", "flips_taken", "flips_refused",
	"implicit_decisions", "barrier_fallbacks", "fragile", "open", "trials",
	"timers_fired", "shadow_releases", "widened", "solver_us", "pivots", "glued",
}

func main() {
	if os.Args[1] == "novelty" {
		novelty(os.Args[2])
		return
	}
	dir := os.Args[1]
	db, err := sql.Open("duckdb", "")
	if err != nil {
		panic(err)
	}
	out := map[string]any{}
	session, _ := os.ReadFile(filepath.Join(dir, "session.json"))
	var s map[string]any
	if json.Unmarshal(session, &s) == nil {
		out["wall_ms"] = s["wall_ms"]
		out["runs_completed"] = s["runs_completed"]
		out["runs_failed"] = s["runs_failed"]
	}
	runs := fmt.Sprintf("read_parquet('%s/runs/*.parquet')", dir)
	var n, wall int64
	if err := db.QueryRow(fmt.Sprintf("SELECT count(*), coalesce(sum(wall_us), 0) FROM %s", runs)).Scan(&n, &wall); err != nil {
		panic(err)
	}
	out["runs"] = n
	out["run_wall_us"] = wall
	var crashes, crashed int64
	execs := fmt.Sprintf("read_parquet('%s/executions/*.parquet')", dir)
	if db.QueryRow(fmt.Sprintf("SELECT count(*), count(DISTINCT run_id) FROM %s WHERE action = 'System.Crash'", execs)).Scan(&crashes, &crashed) == nil {
		out["crashes"] = crashes
		out["runs_with_crash"] = crashed
	}
	sums := map[string]float64{}
	for _, c := range counters {
		var v sql.NullFloat64
		q := fmt.Sprintf("SELECT sum(CAST(json_extract(clock, '$.time.%s') AS DOUBLE)) FROM %s", c, runs)
		if err := db.QueryRow(q).Scan(&v); err != nil {
			panic(err)
		}
		if v.Valid {
			sums[c] = v.Float64
		}
	}
	if len(sums) > 0 {
		out["time"] = sums
		var conceded, flipped int64
		db.QueryRow(fmt.Sprintf("SELECT count(*) FROM %s WHERE json_extract_string(clock, '$.time.conceded') IS NOT NULL", runs)).Scan(&conceded)
		db.QueryRow(fmt.Sprintf("SELECT count(*) FROM %s WHERE CAST(json_extract(clock, '$.time.flips_taken') AS BIGINT) > 0", runs)).Scan(&flipped)
		out["conceded_runs"] = conceded
		out["runs_with_flip"] = flipped
	}
	checks := fmt.Sprintf("read_parquet('%s/checks/*.parquet')", dir)
	rows, err := db.Query(fmt.Sprintf("SELECT verdict, split_part(reason, ':', 1) || CASE WHEN reason LIKE 'candidate_unconfirmed: %%' THEN ': ' || split_part(split_part(reason, ': ', 2), ':', 1) ELSE '' END AS why, count(*) FROM %s GROUP BY ALL ORDER BY ALL", checks))
	if err == nil {
		verdicts := map[string]int64{}
		for rows.Next() {
			var verdict, why string
			var c int64
			rows.Scan(&verdict, &why, &c)
			verdicts[verdict+" "+why] = c
		}
		rows.Close()
		out["checks"] = verdicts
	}
	enc := json.NewEncoder(os.Stdout)
	enc.Encode(out)
}
