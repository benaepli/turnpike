package metrics

import (
	"context"
	"database/sql"
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

// ComputeGrade computes L0/L1 over the executions and traces tables. It runs
// one batch of runs at a time: every figure it reports is either a row count or
// a count(DISTINCT run_id), and batches cover disjoint run ranges, so summing
// the partials is exact.
func ComputeGrade(dbPath string, runID int64, batchSize int) (*GradeResult, error) {
	db, err := reader.OpenDB(dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	defer db.Close()

	batches, err := batchesFor(dbPath, runID, batchSize)
	if err != nil {
		return nil, err
	}

	start := time.Now()
	result := &GradeResult{}
	h := &HazardResult{}

	for _, sel := range batches {
		exec := reader.ExecutionsSource(dbPath, sel)
		traces := reader.TracesSource(dbPath, sel)

		var totalRuns int64
		if err := db.QueryRow(fmt.Sprintf(
			`SELECT count(DISTINCT run_id) FROM %s`, exec,
		)).Scan(&totalRuns); err != nil {
			return nil, fmt.Errorf("total runs: %w", err)
		}
		result.TotalRuns += totalRuns

		// L0: client invocation/response pairing (unpaired = deadlock/waste proxy).
		var invocations, responses, unpaired, runsWithUnpaired int64
		if err := db.QueryRow(fmt.Sprintf(`
			WITH inv AS (
				SELECT run_id, count(*) AS n FROM %[1]s
				WHERE kind = 'Invocation' AND action LIKE 'ClientInterface.%%'
				GROUP BY run_id
			), resp AS (
				SELECT run_id, count(*) AS n FROM %[1]s
				WHERE kind = 'Response' AND action LIKE 'ClientInterface.%%'
				GROUP BY run_id
			)
			SELECT
				coalesce(sum(inv.n), 0),
				coalesce(sum(coalesce(resp.n, 0)), 0),
				coalesce(sum(CASE WHEN inv.n > coalesce(resp.n, 0) THEN inv.n - coalesce(resp.n, 0) ELSE 0 END), 0),
				coalesce(sum(CASE WHEN inv.n > coalesce(resp.n, 0) THEN 1 ELSE 0 END), 0)
			FROM inv LEFT JOIN resp USING (run_id)
		`, exec)).Scan(&invocations, &responses, &unpaired, &runsWithUnpaired); err != nil {
			return nil, fmt.Errorf("invocation pairing: %w", err)
		}
		result.Invocations += invocations
		result.Responses += responses
		result.UnpairedInvocations += unpaired
		result.RunsWithUnpaired += runsWithUnpaired

		if err := accumulateHazards(db, exec, traces, h); err != nil {
			return nil, err
		}
	}

	if result.Invocations > 0 {
		result.UnpairedFraction = float64(result.UnpairedInvocations) / float64(result.Invocations)
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

// accumulateHazards adds one batch's L1 hazard run-counts into h.
//
// The four hazard queries share the same crash/recover/dispatch/delivery
// relations, so they are materialised once into temp tables rather than
// re-derived per query -- previously each hazard re-scanned executions twice
// and traces twice, rebuilding the delivery group-by four times over.
func accumulateHazards(db *sql.DB, exec, traces string, h *HazardResult) error {
	conn, err := db.Conn(context.Background())
	if err != nil {
		return fmt.Errorf("hazard connection: %w", err)
	}
	defer conn.Close()

	ctx := context.Background()
	setup := []string{
		`CREATE OR REPLACE TEMP TABLE crashes AS
			SELECT run_id, CAST(json_extract(payload, '$[0].value.index') AS BIGINT) AS node, step
			FROM ` + exec + ` WHERE kind = 'Crash'`,
		`CREATE OR REPLACE TEMP TABLE recovers AS
			SELECT run_id, CAST(json_extract(payload, '$[0].value.index') AS BIGINT) AS node, step
			FROM ` + exec + ` WHERE kind = 'Recover'`,
		`CREATE OR REPLACE TEMP TABLE d AS
			SELECT run_id, node_id AS sender, step, trace_id
			FROM ` + traces + ` WHERE trace_kind = 'Dispatch'`,
		`CREATE OR REPLACE TEMP TABLE e AS
			SELECT run_id, trace_id, min(node_id) AS receiver, min(step) AS estep
			FROM ` + traces + ` WHERE trace_kind = 'Enter'
			GROUP BY run_id, trace_id`,
	}
	for _, stmt := range setup {
		if _, err := conn.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("hazard prelude: %w", err)
		}
	}

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
		var n int64
		if err := conn.QueryRowContext(ctx, q.sql).Scan(&n); err != nil {
			return fmt.Errorf("hazard %s: %w", q.name, err)
		}
		*q.dst += n
	}
	return nil
}
