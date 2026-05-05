package dagorder

import (
	"fmt"
	"log"
	"slices"
	"sort"

	"github.com/benaepli/turnpike-traceanalyzer/reader"
)

// RunResult is the DAG-ordering result for a single run.
type RunResult struct {
	RunID               int64    `json:"run_id"`
	EdgeSatisfaction    float64  `json:"edge_satisfaction"`
	EligibleEdges       int      `json:"eligible_edges"`
	MatchedLabels       int      `json:"matched_labels"`
	TotalLabels         int      `json:"total_labels"`
	ZeroCandidateLabels []string `json:"zero_candidate_labels,omitempty"`
	CrowdedOutLabels    []string `json:"crowded_out_labels,omitempty"`
	TruncatedLabels     []string `json:"truncated_labels,omitempty"`
	ChainScore          float64  `json:"chain_score"`
	LongestChain        int      `json:"longest_chain"`
	CriticalPath        int      `json:"critical_path"`
}

// EdgeFreq reports how often a given DAG edge was satisfied across all runs.
type EdgeFreq struct {
	From           string  `json:"from"`
	To             string  `json:"to"`
	SatisfiedCount int     `json:"satisfied_count"`
	EligibleCount  int     `json:"eligible_count"`
	Fraction       float64 `json:"fraction"`
}

// DagOrderResult is the aggregate metric output.
type DagOrderResult struct {
	ConfigPath       string      `json:"config_path"`
	TotalRuns        int         `json:"total_runs"`
	MeanScore        float64     `json:"mean_score"`
	MinScore         float64     `json:"min_score"`
	MaxScore         float64     `json:"max_score"`
	P50Score         float64     `json:"p50_score"`
	P95Score         float64     `json:"p95_score"`
	MeanChainScore   float64     `json:"mean_chain_score"`
	MinChainScore    float64     `json:"min_chain_score"`
	P50ChainScore    float64     `json:"p50_chain_score"`
	P95ChainScore    float64     `json:"p95_chain_score"`
	DroppedEdgeCount int         `json:"dropped_edge_count"`
	TotalEdgeCount   int         `json:"total_edge_count"`
	DroppedMajority  bool        `json:"dropped_majority"`
	PerRun           []RunResult `json:"per_run,omitempty"`
	PerEdge          []EdgeFreq  `json:"per_edge,omitempty"`
}

// ComputeDagOrder loads the plan config, joins it against trace/execution output,
// and reports per-run and aggregate edge-satisfaction scores.
func ComputeDagOrder(dbPath, configPath string, runID int64, nSwaps int) (*DagOrderResult, error) {
	cfg, err := LoadPlanConfig(configPath)
	if err != nil {
		return nil, err
	}

	// Count how many edges touch an unmatchable event kind, independent of run.
	// A label is structurally unmatchable if its EventKind can't be observed
	// in non-plan-mode output (allow_timer, partition, heal).
	structuralUnmatchable := make(map[string]bool, len(cfg.Events))
	for id, spec := range cfg.Events {
		if !spec.Kind.Matchable() {
			structuralUnmatchable[id] = true
		}
	}
	dropped := 0
	for _, dep := range cfg.Dependencies {
		if structuralUnmatchable[dep[0]] || structuralUnmatchable[dep[1]] {
			dropped++
		}
	}
	total := len(cfg.Dependencies)
	droppedMajority := total > 0 && dropped*2 > total
	if droppedMajority {
		log.Printf(
			"Warning: DAG config %s has %d/%d edges (%.0f%%) touching unmatchable events "+
				"(allow_timer/partition/heal). Score reflects only the matchable subset.",
			configPath, dropped, total, 100*float64(dropped)/float64(total),
		)
	}

	execs, err := reader.ReadExecutions(dbPath, runID)
	if err != nil {
		return nil, fmt.Errorf("read executions: %w", err)
	}
	traces, err := reader.ReadTraces(dbPath, runID)
	if err != nil {
		return nil, fmt.Errorf("read traces: %w", err)
	}

	// Partition by run_id.
	execsByRun := make(map[int64][]reader.ExecutionRow)
	for _, e := range execs {
		execsByRun[e.RunID] = append(execsByRun[e.RunID], e)
	}
	tracesByRun := make(map[int64][]reader.TraceRow)
	for _, t := range traces {
		tracesByRun[t.RunID] = append(tracesByRun[t.RunID], t)
	}
	runIDs := make([]int64, 0, len(execsByRun))
	seen := make(map[int64]bool)
	for id := range execsByRun {
		if !seen[id] {
			runIDs = append(runIDs, id)
			seen[id] = true
		}
	}
	for id := range tracesByRun {
		if !seen[id] {
			runIDs = append(runIDs, id)
			seen[id] = true
		}
	}
	slices.Sort(runIDs)

	// Stable label list for bestMatching.
	labels := make([]string, 0, len(cfg.Events))
	for id := range cfg.Events {
		labels = append(labels, id)
	}
	sort.Strings(labels)

	// Accumulators for per-edge stats.
	type edgeAgg struct {
		satisfied int
		eligible  int
	}
	edgeAggs := make(map[[2]string]*edgeAgg, len(cfg.Dependencies))
	for _, dep := range cfg.Dependencies {
		edgeAggs[dep] = &edgeAgg{}
	}

	result := &DagOrderResult{
		ConfigPath:       configPath,
		DroppedEdgeCount: dropped,
		TotalEdgeCount:   total,
		DroppedMajority:  droppedMajority,
	}
	scores := make([]float64, 0, len(runIDs))
	chainScores := make([]float64, 0, len(runIDs))

	for _, rid := range runIDs {
		idx := buildRunIndex(execsByRun[rid], tracesByRun[rid])
		cands := make(map[string][]Event, len(cfg.Events))
		var truncated []string
		for id, spec := range cfg.Events {
			c, hitCap := buildCandidates(idx, spec)
			cands[id] = c
			if hitCap {
				truncated = append(truncated, id)
			}
		}
		if len(truncated) > 0 {
			sort.Strings(truncated)
			log.Printf(
				"Warning: dag-order run %d hit candidate cap (%d) for labels: %v",
				rid, maxCandidates, truncated,
			)
		}

		assign, score, matched, zeroCand, crowdedOut, longestChain, criticalPath := bestMatching(labels, cands, cfg.Dependencies, rid, nSwaps)

		// Eligible edge count from assignment (excludes unmatchable + unmatched).
		eligible := 0
		for _, dep := range cfg.Dependencies {
			eu, eok := assign[dep[0]]
			ev, vok := assign[dep[1]]
			if !eok || !vok {
				continue
			}
			eligible++
			agg := edgeAggs[dep]
			agg.eligible++
			if lessThan(eu, ev) {
				agg.satisfied++
			}
		}

		var chainScore float64
		if criticalPath > 0 {
			chainScore = float64(longestChain) / float64(criticalPath)
		}
		rr := RunResult{
			RunID:               rid,
			EdgeSatisfaction:    score,
			EligibleEdges:       eligible,
			MatchedLabels:       len(matched),
			TotalLabels:         len(cfg.Events),
			ZeroCandidateLabels: zeroCand,
			CrowdedOutLabels:    crowdedOut,
			TruncatedLabels:     truncated,
			ChainScore:          chainScore,
			LongestChain:        longestChain,
			CriticalPath:        criticalPath,
		}
		result.PerRun = append(result.PerRun, rr)
		scores = append(scores, score)
		chainScores = append(chainScores, chainScore)
	}

	result.TotalRuns = len(scores)
	if len(scores) > 0 {
		sum := 0.0
		sorted := append([]float64(nil), scores...)
		sort.Float64s(sorted)
		for _, s := range scores {
			sum += s
		}
		result.MeanScore = sum / float64(len(scores))
		result.MinScore = sorted[0]
		result.MaxScore = sorted[len(sorted)-1]
		result.P50Score = percentile(sorted, 0.50)
		result.P95Score = percentile(sorted, 0.95)
	}

	if len(chainScores) > 0 {
		sum := 0.0
		sorted := append([]float64(nil), chainScores...)
		sort.Float64s(sorted)
		for _, s := range chainScores {
			sum += s
		}
		result.MeanChainScore = sum / float64(len(chainScores))
		result.MinChainScore = sorted[0]
		result.P50ChainScore = percentile(sorted, 0.50)
		result.P95ChainScore = percentile(sorted, 0.95)
	}

	// PerEdge, sorted worst-first (lowest fraction first) so the hardest edges
	// surface at the top.
	result.PerEdge = make([]EdgeFreq, 0, len(cfg.Dependencies))
	for _, dep := range cfg.Dependencies {
		agg := edgeAggs[dep]
		var frac float64
		if agg.eligible > 0 {
			frac = float64(agg.satisfied) / float64(agg.eligible)
		}
		result.PerEdge = append(result.PerEdge, EdgeFreq{
			From:           dep[0],
			To:             dep[1],
			SatisfiedCount: agg.satisfied,
			EligibleCount:  agg.eligible,
			Fraction:       frac,
		})
	}
	sort.Slice(result.PerEdge, func(i, j int) bool {
		if result.PerEdge[i].Fraction != result.PerEdge[j].Fraction {
			return result.PerEdge[i].Fraction < result.PerEdge[j].Fraction
		}
		if result.PerEdge[i].From != result.PerEdge[j].From {
			return result.PerEdge[i].From < result.PerEdge[j].From
		}
		return result.PerEdge[i].To < result.PerEdge[j].To
	})

	return result, nil
}

// percentile over a sorted slice using nearest-rank.
func percentile(sorted []float64, q float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	if q <= 0 {
		return sorted[0]
	}
	if q >= 1 {
		return sorted[len(sorted)-1]
	}
	idx := int(q * float64(len(sorted)-1))
	return sorted[idx]
}
