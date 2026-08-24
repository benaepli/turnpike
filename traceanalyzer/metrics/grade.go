package metrics

import (
	"fmt"
	"time"

	"github.com/benaepli/turnpike-traceanalyzer/reader"
)

// HazardResult reports generic (protocol-agnostic) hazard coverage: how often
// exploration produces the crash/recovery message races that distributed
// protocol bugs typically hide behind. All rates are fractions of total runs.
type HazardResult struct {
	// H1: a node dispatched a message, crashed afterwards, and the message
	// was delivered (first Enter) after the crash — "crash with in-flight send".
	CrashInflightRuns int64   `json:"h1_crash_inflight_runs"`
	CrashInflightRate float64 `json:"h1_rate"`
	// H2: H1 where the sender also recovered before the delivery — a message
	// from a dead incarnation arrives while its node is already back.
	StaleIncarnationRuns int64   `json:"h2_stale_incarnation_runs"`
	StaleIncarnationRate float64 `json:"h2_rate"`
	// H2b: receiver-side variant — dispatched before the receiver's crash,
	// delivered after the receiver's recovery.
	ReceiverStaleRuns int64   `json:"h2b_receiver_stale_runs"`
	ReceiverStaleRate float64 `json:"h2b_rate"`
	// H3: at least two distinct nodes each crashed and recovered in the run.
	TwoNodeCrashRecoverRuns int64   `json:"h3_two_node_crash_recover_runs"`
	TwoNodeCrashRecoverRate float64 `json:"h3_rate"`
}

// GradeResult is the cheap (pure SQL) part of the metric ladder: throughput /
// waste counters (L0) and hazard coverage (L1). The expensive DAG prefix
// metrics (L2) are attached separately by the caller, and the linearizability
// verdict (L3) comes from porcupine_batch.
type GradeResult struct {
	TotalRuns           int64         `json:"total_runs"`
	Invocations         int64         `json:"invocations"`
	Responses           int64         `json:"responses"`
	UnpairedInvocations int64         `json:"unpaired_invocations"`
	UnpairedFraction    float64       `json:"unpaired_fraction"`
	RunsWithUnpaired    int64         `json:"runs_with_unpaired"`
	Hazards             *HazardResult `json:"hazards,omitempty"`
	WallMs              int64         `json:"wall_ms"`
}

// ComputeGrade computes L0/L1 over the executions and traces tables with
// aggregate DuckDB queries (no per-run Go loop, so it stays cheap on large
// corpora).
func ComputeGrade(dbPath string, runID int64) (*GradeResult, error) {
	db, err := reader.OpenDB(dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	defer db.Close()

	exec := reader.ExecutionsSource(dbPath)
	traces := reader.TracesSource(dbPath)
	filter := runIDFilter(runID)
	start := time.Now()
	result := &GradeResult{}

	// Total runs (any executions row).
	if err := db.QueryRow(fmt.Sprintf(
		`SELECT count(DISTINCT run_id) FROM %s WHERE 1=1 %s`, exec, filter,
	)).Scan(&result.TotalRuns); err != nil {
		return nil, fmt.Errorf("total runs: %w", err)
	}

	// L0: client invocation/response pairing (unpaired = deadlock/waste proxy).
	if err := db.QueryRow(fmt.Sprintf(`
		WITH inv AS (
			SELECT run_id, count(*) AS n FROM %s
			WHERE kind = 'Invocation' AND action LIKE 'ClientInterface.%%' %s
			GROUP BY run_id
		), resp AS (
			SELECT run_id, count(*) AS n FROM %s
			WHERE kind = 'Response' AND action LIKE 'ClientInterface.%%' %s
			GROUP BY run_id
		)
		SELECT
			coalesce(sum(inv.n), 0),
			coalesce(sum(coalesce(resp.n, 0)), 0),
			coalesce(sum(CASE WHEN inv.n > coalesce(resp.n, 0) THEN inv.n - coalesce(resp.n, 0) ELSE 0 END), 0),
			coalesce(sum(CASE WHEN inv.n > coalesce(resp.n, 0) THEN 1 ELSE 0 END), 0)
		FROM inv LEFT JOIN resp USING (run_id)
	`, exec, filter, exec, filter)).Scan(
		&result.Invocations, &result.Responses,
		&result.UnpairedInvocations, &result.RunsWithUnpaired,
	); err != nil {
		return nil, fmt.Errorf("invocation pairing: %w", err)
	}
	if result.Invocations > 0 {
		result.UnpairedFraction = float64(result.UnpairedInvocations) / float64(result.Invocations)
	}

	// L1 hazards. Shared CTE prelude: crash/recover rows (node from the VNode
	// payload), dispatches (node_id = sender), and first-Enter deliveries.
	prelude := fmt.Sprintf(`
		WITH crashes AS (
			SELECT run_id, CAST(json_extract(payload, '$[0].value.index') AS BIGINT) AS node, step
			FROM %s WHERE kind = 'Crash' %s
		), recovers AS (
			SELECT run_id, CAST(json_extract(payload, '$[0].value.index') AS BIGINT) AS node, step
			FROM %s WHERE kind = 'Recover' %s
		), d AS (
			SELECT run_id, node_id AS sender, step, trace_id
			FROM %s WHERE trace_kind = 'Dispatch' %s
		), e AS (
			SELECT run_id, trace_id, min(node_id) AS receiver, min(step) AS estep
			FROM %s WHERE trace_kind = 'Enter' %s
			GROUP BY run_id, trace_id
		)
	`, exec, filter, exec, filter, traces, filter, traces, filter)

	h := &HazardResult{}
	queries := []struct {
		dst  *int64
		name string
		sql  string
	}{
		{&h.CrashInflightRuns, "h1", `
			SELECT count(DISTINCT d.run_id) FROM d
			JOIN crashes c ON c.run_id = d.run_id AND c.node = d.sender AND d.step < c.step
			JOIN e ON e.run_id = d.run_id AND e.trace_id = d.trace_id AND e.estep > c.step`},
		{&h.StaleIncarnationRuns, "h2", `
			SELECT count(DISTINCT d.run_id) FROM d
			JOIN crashes c ON c.run_id = d.run_id AND c.node = d.sender AND d.step < c.step
			JOIN e ON e.run_id = d.run_id AND e.trace_id = d.trace_id AND e.estep > c.step
			JOIN recovers r ON r.run_id = d.run_id AND r.node = d.sender
				AND r.step > c.step AND r.step < e.estep`},
		{&h.ReceiverStaleRuns, "h2b", `
			SELECT count(DISTINCT d.run_id) FROM d
			JOIN e ON e.run_id = d.run_id AND e.trace_id = d.trace_id
			JOIN crashes c ON c.run_id = d.run_id AND c.node = e.receiver AND d.step < c.step
			JOIN recovers r ON r.run_id = d.run_id AND r.node = e.receiver
				AND r.step > c.step AND e.estep > r.step`},
		{&h.TwoNodeCrashRecoverRuns, "h3", `
			SELECT count(*) FROM (
				SELECT run_id FROM (
					SELECT DISTINCT c.run_id, c.node FROM crashes c
					JOIN recovers r ON r.run_id = c.run_id AND r.node = c.node AND r.step > c.step
				) GROUP BY run_id HAVING count(*) >= 2
			)`},
	}
	for _, q := range queries {
		if err := db.QueryRow(prelude + q.sql).Scan(q.dst); err != nil {
			return nil, fmt.Errorf("hazard %s: %w", q.name, err)
		}
	}
	if result.TotalRuns > 0 {
		n := float64(result.TotalRuns)
		h.CrashInflightRate = float64(h.CrashInflightRuns) / n
		h.StaleIncarnationRate = float64(h.StaleIncarnationRuns) / n
		h.ReceiverStaleRate = float64(h.ReceiverStaleRuns) / n
		h.TwoNodeCrashRecoverRate = float64(h.TwoNodeCrashRecoverRuns) / n
	}
	result.Hazards = h
	result.WallMs = time.Since(start).Milliseconds()
	return result, nil
}
