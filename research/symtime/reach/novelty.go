package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
)

// novelty: a run's timeline is the ordered leadership and lease events each
// node logged (elections, step-downs, leases, recoveries), digits masked; its
// branch set is the set of handlers each node ran and the log lines each
// node printed, digits masked, which follow the branches taken. A run is
// new when no run with a smaller id in the session had the same one. Runs
// that took a flip are compared with runs that did not in the same grid
// configuration, weighted by the flip runs in each.
func novelty(dir string) {
	db, err := sql.Open("duckdb", "")
	if err != nil {
		panic(err)
	}
	q := fmt.Sprintf(`
WITH tl AS (
  SELECT run_id, md5(string_agg(node_id || ':' || regexp_replace(content, '[0-9]+', '#', 'g'), ',' ORDER BY seq_num)) AS sig
  FROM read_parquet('%[1]s/logs/*.parquet')
  WHERE regexp_matches(content, 'became leader|stepping down|election timeout|lease|recovered')
  GROUP BY run_id),
items AS (
  SELECT run_id, node_id || ':' || function_name AS x FROM read_parquet('%[1]s/traces/*.parquet')
  UNION
  SELECT run_id, node_id || ':' || regexp_replace(content, '[0-9]+', '#', 'g') FROM read_parquet('%[1]s/logs/*.parquet')),
br AS (SELECT run_id, md5(string_agg(x, ',' ORDER BY x)) AS sig FROM items GROUP BY run_id),
ids AS (SELECT run_id FROM read_parquet('%[1]s/runs/*.parquet')),
ntl AS (SELECT run_id, row_number() OVER (PARTITION BY coalesce(sig, '') ORDER BY run_id) = 1 AS new FROM ids LEFT JOIN tl USING (run_id)),
nbr AS (SELECT run_id, row_number() OVER (PARTITION BY sig ORDER BY run_id) = 1 AS new FROM br),
r AS (SELECT run_id, config_index, coalesce(CAST(json_extract(clock, '$.time.flips_taken') AS BIGINT), 0) > 0 AS flip
      FROM read_parquet('%[1]s/runs/*.parquet'))
SELECT r.config_index, r.flip, count(*), sum(CAST(ntl.new AS BIGINT)), sum(CAST(nbr.new AS BIGINT))
FROM r JOIN ntl USING (run_id) JOIN nbr USING (run_id)
GROUP BY ALL ORDER BY ALL`, dir)
	rows, err := db.Query(q)
	if err != nil {
		panic(err)
	}
	type cell struct{ n, tl, br float64 }
	groups := map[int64][2]cell{}
	var total [2]cell
	for rows.Next() {
		var ci int64
		var flip bool
		var n, tl, br int64
		if err := rows.Scan(&ci, &flip, &n, &tl, &br); err != nil {
			panic(err)
		}
		g := groups[ci]
		k := 0
		if flip {
			k = 1
		}
		g[k] = cell{float64(n), float64(tl), float64(br)}
		groups[ci] = g
		total[k].n += float64(n)
		total[k].tl += float64(tl)
		total[k].br += float64(br)
	}
	var w, dtl, dbr float64
	for _, g := range groups {
		if g[0].n == 0 || g[1].n == 0 {
			continue
		}
		w += g[1].n
		dtl += g[1].n * (g[1].tl/g[1].n - g[0].tl/g[0].n)
		dbr += g[1].n * (g[1].br/g[1].n - g[0].br/g[0].n)
	}
	out := map[string]any{
		"flip_runs": total[1].n, "other_runs": total[0].n,
		"flip_new_timeline": total[1].tl / total[1].n, "other_new_timeline": total[0].tl / total[0].n,
		"flip_new_branches": total[1].br / total[1].n, "other_new_branches": total[0].br / total[0].n,
		"matched_timeline_difference": dtl / w, "matched_branch_difference": dbr / w,
	}
	json.NewEncoder(os.Stdout).Encode(out)
}
