package metrics

import (
	"database/sql"
	"fmt"
	"sort"

	"github.com/benaepli/turnpike-traceanalyzer/reader"
)

// FingerprintResult holds the complete exploration diversity analysis.
type FingerprintResult struct {
	TotalRuns          int                    `json:"total_runs"`
	UniqueFingerprints int                    `json:"unique_fingerprints"`
	DiversityRatio     float64                `json:"diversity_ratio"`
	UniqueNodeProfiles int                    `json:"unique_node_profiles"`
	CausalChains       []CausalChainDiversity `json:"causal_chains,omitempty"`
}

// CausalChainDiversity shows how many distinct causal operation ID sequences
// appear per function across runs.
type CausalChainDiversity struct {
	FunctionName     string `json:"function_name"`
	DistinctChains   int    `json:"distinct_chains"`
	TotalInvocations int    `json:"total_invocations"`
}

// ComputeFingerprint computes exploration diversity metrics.
//
// The distinct-counts here cannot simply be summed across batches: a run
// fingerprint is unique per run, but causal_operation_id values recur across
// runs. So each batch returns its raw keys and the distinct-counting happens in
// Go over an accumulated set, which keeps the answer exact while bounding what
// the engine has to hold at once.
func ComputeFingerprint(dbPath string, runID int64, batchSize int) (*FingerprintResult, error) {
	db, err := reader.OpenDB(dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	defer db.Close()

	batches, err := batchesFor(dbPath, runID, batchSize)
	if err != nil {
		return nil, err
	}

	result := &FingerprintResult{}
	fingerprints := make(map[string]struct{})
	profiles := make(map[string]struct{})
	chains := make(map[string]map[int64]struct{})
	invocations := make(Counters)

	for _, sel := range batches {
		src := reader.TracesSource(dbPath, sel)
		if err := collectTraceFingerprints(db, src, &result.TotalRuns, fingerprints); err != nil {
			return nil, err
		}
		if err := collectNodeProfiles(db, src, profiles); err != nil {
			return nil, err
		}
		if err := collectCausalChains(db, src, chains, invocations); err != nil {
			return nil, err
		}
	}

	result.UniqueFingerprints = len(fingerprints)
	result.UniqueNodeProfiles = len(profiles)
	if result.TotalRuns > 0 {
		result.DiversityRatio = float64(result.UniqueFingerprints) / float64(result.TotalRuns)
	}

	names := make([]string, 0, len(chains))
	for fn := range chains {
		names = append(names, fn)
	}
	sort.Strings(names)
	for _, fn := range names {
		result.CausalChains = append(result.CausalChains, CausalChainDiversity{
			FunctionName:     fn,
			DistinctChains:   len(chains[fn]),
			TotalInvocations: int(invocations[fn]),
		})
	}
	return result, nil
}

// collectTraceFingerprints hashes each run's ordered (function_name, trace_kind)
// sequence and adds the hashes to seen.
func collectTraceFingerprints(db *sql.DB, src string, totalRuns *int, seen map[string]struct{}) error {
	query := fmt.Sprintf(`
		SELECT MD5(STRING_AGG(function_name || ':' || trace_kind, ',' ORDER BY seq_num)) AS fingerprint
		FROM %s
		GROUP BY run_id
	`, src)

	rows, err := db.Query(query)
	if err != nil {
		return fmt.Errorf("failed to query trace fingerprints: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var fp string
		if err := rows.Scan(&fp); err != nil {
			return fmt.Errorf("failed to scan fingerprint: %w", err)
		}
		*totalRuns++
		seen[fp] = struct{}{}
	}
	return rows.Err()
}

// collectNodeProfiles hashes each (run, node) function-call-count vector.
func collectNodeProfiles(db *sql.DB, src string, seen map[string]struct{}) error {
	query := fmt.Sprintf(`
		SELECT MD5(STRING_AGG(function_name || ':' || CAST(cnt AS VARCHAR), ',' ORDER BY function_name)) AS profile
		FROM (
			SELECT run_id, node_id, function_name, COUNT(*) AS cnt
			FROM %s
			WHERE trace_kind = 'Enter'
			GROUP BY run_id, node_id, function_name
		) sub
		GROUP BY run_id, node_id
	`, src)

	rows, err := db.Query(query)
	if err != nil {
		return fmt.Errorf("failed to query node profiles: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var profile string
		if err := rows.Scan(&profile); err != nil {
			return fmt.Errorf("failed to scan node profile: %w", err)
		}
		seen[profile] = struct{}{}
	}
	return rows.Err()
}

// collectCausalChains records the causal operation ids seen per function, plus
// the invocation count. The ids recur across runs, so they are unioned rather
// than counted per batch.
func collectCausalChains(db *sql.DB, src string, chains map[string]map[int64]struct{}, invocations Counters) error {
	query := fmt.Sprintf(`
		SELECT function_name, causal_operation_id, COUNT(*) AS n
		FROM %s
		WHERE trace_kind = 'Enter' AND causal_operation_id IS NOT NULL
		GROUP BY function_name, causal_operation_id
	`, src)

	rows, err := db.Query(query)
	if err != nil {
		return fmt.Errorf("failed to query causal chains: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var fn string
		var id, n int64
		if err := rows.Scan(&fn, &id, &n); err != nil {
			return fmt.Errorf("failed to scan causal chain row: %w", err)
		}
		if chains[fn] == nil {
			chains[fn] = make(map[int64]struct{})
		}
		chains[fn][id] = struct{}{}
		invocations.Add(fn, n)
	}
	return rows.Err()
}
