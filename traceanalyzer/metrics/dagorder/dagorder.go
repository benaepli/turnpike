package dagorder

import (
	"fmt"
	"log"
	"math/rand/v2"
	"slices"
	"sort"
	"time"

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
	PrefixDepth         int      `json:"prefix_depth"`
	PrefixPath          []string `json:"prefix_path,omitempty"`
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
	ConfigPath          string      `json:"config_path"`
	TotalRuns           int         `json:"total_runs"`
	MeanScore           float64     `json:"mean_score"`
	MinScore            float64     `json:"min_score"`
	MaxScore            float64     `json:"max_score"`
	P50Score            float64     `json:"p50_score"`
	P95Score            float64     `json:"p95_score"`
	MeanChainScore      float64     `json:"mean_chain_score"`
	MinChainScore       float64     `json:"min_chain_score"`
	P50ChainScore       float64     `json:"p50_chain_score"`
	P95ChainScore       float64     `json:"p95_chain_score"`
	DroppedEdgeCount    int         `json:"dropped_edge_count"`
	TotalEdgeCount      int         `json:"total_edge_count"`
	TransitiveEdgeCount int         `json:"transitive_edge_count"`
	DroppedMajority     bool        `json:"dropped_majority"`
	AvailableRuns       int         `json:"available_runs"`
	GradedRuns          int         `json:"graded_runs"`
	Sampled             bool        `json:"sampled"`
	BudgetExhausted     bool        `json:"budget_exhausted"`
	MaxPrefixDepth      int         `json:"max_prefix_depth"`
	MeanPrefixDepth     float64     `json:"mean_prefix_depth"`
	P95PrefixDepth      int         `json:"p95_prefix_depth"`
	DepthAtLeast        []int       `json:"depth_at_least,omitempty"` // [i] = graded runs with prefix_depth >= i+1
	PerRun              []RunResult `json:"per_run,omitempty"`
	TopRuns             []RunResult `json:"top_runs,omitempty"` // deepest runs, kept when per_run is omitted
	PerEdge             []EdgeFreq  `json:"per_edge,omitempty"`
}

// Options controls sampling and budgeting for ComputeDagOrderOpts. The zero
// value reproduces the historical unbounded, per-run-inclusive behavior
// except IncludePerRun, which must be set explicitly.
type Options struct {
	MaxRuns       int   // >0: deterministically sample at most this many runs
	BudgetMs      int64 // >0: stop grading further runs once exceeded (reported, never silent)
	IncludePerRun bool  // emit the full per_run array (large); otherwise only top_runs
	TopN          int   // size of top_runs when per_run is omitted (default 10)
}

// ComputeDagOrder loads the plan config, joins it against trace/execution output,
// and reports per-run and aggregate edge-satisfaction scores.
func ComputeDagOrder(dbPath, configPath string, runID int64, nSwaps int) (*DagOrderResult, error) {
	return ComputeDagOrderOpts(dbPath, configPath, runID, nSwaps, Options{IncludePerRun: true})
}

// ComputeDagOrderOpts is ComputeDagOrder with sampling and wall-budget
// controls, for use by the grade pipeline over large corpora.
func ComputeDagOrderOpts(dbPath, configPath string, runID int64, nSwaps int, opts Options) (*DagOrderResult, error) {
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

	// Compute transitive closure for scoring.
	allDeps := transitiveClosure(cfg.Dependencies)

	// Determine the run-id set up front; rows are read in bounded chunks
	// below (memory is ~2.4 GB per 1000 materialized runs, so reading a whole
	// corpus at once is not viable for grade-everything mode).
	availableRuns := 0
	sampledFlag := false
	var allIDs []int64
	if runID < 0 {
		ids, err := reader.ListRunIDs(dbPath)
		if err != nil {
			return nil, fmt.Errorf("list run ids: %w", err)
		}
		availableRuns = len(ids)
		if opts.MaxRuns > 0 && len(ids) > opts.MaxRuns {
			ids = sampleRunIDs(ids, opts.MaxRuns)
			sampledFlag = true
		}
		allIDs = ids
	} else {
		availableRuns = 1
		allIDs = []int64{runID}
	}
	const chunkSize = 500

	// Stable label list for bestMatching.
	labels := make([]string, 0, len(cfg.Events))
	for id := range cfg.Events {
		labels = append(labels, id)
	}
	sort.Strings(labels)

	// Accumulators for per-edge stats (over transitive closure).
	type edgeAgg struct {
		satisfied int
		eligible  int
	}
	edgeAggs := make(map[[2]string]*edgeAgg, len(allDeps))
	for _, dep := range allDeps {
		edgeAggs[dep] = &edgeAgg{}
	}

	result := &DagOrderResult{
		ConfigPath:          configPath,
		DroppedEdgeCount:    dropped,
		TotalEdgeCount:      total,
		TransitiveEdgeCount: len(allDeps),
		DroppedMajority:     droppedMajority,
		AvailableRuns:       availableRuns,
		Sampled:             sampledFlag,
	}
	scores := make([]float64, 0, len(allIDs))
	chainScores := make([]float64, 0, len(allIDs))
	prefixDepths := make([]int, 0, len(allIDs))
	gradeStart := time.Now()

	for start := 0; start < len(allIDs) && !result.BudgetExhausted; start += chunkSize {
		stop := start + chunkSize
		if stop > len(allIDs) {
			stop = len(allIDs)
		}
		chunk := allIDs[start:stop]
		execsByRun, err := reader.ReadExecutionsByRun(dbPath, chunk)
		if err != nil {
			return nil, fmt.Errorf("read executions: %w", err)
		}
		tracesByRun, err := reader.ReadTracesByRun(dbPath, chunk)
		if err != nil {
			return nil, fmt.Errorf("read traces: %w", err)
		}
		for _, rid := range chunk {
			if opts.BudgetMs > 0 && time.Since(gradeStart).Milliseconds() > opts.BudgetMs {
				result.BudgetExhausted = true
				break
			}
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

			o := bestMatchingFull(labels, cands, cfg.Dependencies, allDeps, rid, nSwaps)
			assign, score, matched := o.Assign, o.Score, o.Matched
			zeroCand, crowdedOut := o.ZeroCand, o.CrowdedOut
			longestChain, criticalPath := o.LongestChain, o.CriticalPath

			// Eligible edge count from assignment (over transitive closure).
			eligible := 0
			for _, dep := range allDeps {
				eu, eok := assign[dep[0]]
				ev, vok := assign[dep[1]]
				// Skip edges touching structurally unmatchable labels.
				if structuralUnmatchable[dep[0]] || structuralUnmatchable[dep[1]] {
					continue
				}
				eligible++
				agg := edgeAggs[dep]
				agg.eligible++
				if eok && vok && lessThan(eu, ev) {
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
				PrefixDepth:         o.PrefixDepth,
				PrefixPath:          o.PrefixPath,
			}
			result.PerRun = append(result.PerRun, rr)
			// Only the top N survive when per-run output was not requested, so
			// trim periodically instead of holding a RunResult for every run.
			if !opts.IncludePerRun && len(result.PerRun) >= 4*topRunCount(opts) {
				result.PerRun = trimToTopRuns(result.PerRun, topRunCount(opts))
			}
			scores = append(scores, score)
			chainScores = append(chainScores, chainScore)
			prefixDepths = append(prefixDepths, o.PrefixDepth)
		}
	}

	result.TotalRuns = len(scores)
	result.GradedRuns = len(scores)
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

	if len(prefixDepths) > 0 {
		maxD, sum := 0, 0
		for _, d := range prefixDepths {
			sum += d
			if d > maxD {
				maxD = d
			}
		}
		result.MaxPrefixDepth = maxD
		result.MeanPrefixDepth = float64(sum) / float64(len(prefixDepths))
		sortedD := append([]int(nil), prefixDepths...)
		sort.Ints(sortedD)
		result.P95PrefixDepth = sortedD[int(0.95*float64(len(sortedD)-1))]
		result.DepthAtLeast = make([]int, maxD)
		for _, d := range prefixDepths {
			for k := 1; k <= d; k++ {
				result.DepthAtLeast[k-1]++
			}
		}
	}

	if !opts.IncludePerRun {
		result.TopRuns = trimToTopRuns(result.PerRun, topRunCount(opts))
		result.PerRun = nil
	}

	// PerEdge, sorted worst-first (lowest fraction first) so the hardest edges
	// surface at the top.
	result.PerEdge = make([]EdgeFreq, 0, len(allDeps))
	for _, dep := range allDeps {
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

// transitiveClosure computes the transitive closure of a DAG's edge set,
// returning all implied (a,c) pairs where a path a->...->c exists.
// The result is deduplicated and sorted for determinism.
func transitiveClosure(deps [][2]string) [][2]string {
	adj := make(map[string]map[string]bool)
	nodes := make(map[string]bool)
	for _, d := range deps {
		nodes[d[0]] = true
		nodes[d[1]] = true
		if adj[d[0]] == nil {
			adj[d[0]] = make(map[string]bool)
		}
		adj[d[0]][d[1]] = true
	}
	// For each source, DFS forward and add all reachable pairs.
	for src := range nodes {
		visited := make(map[string]bool)
		stack := []string{src}
		for len(stack) > 0 {
			cur := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			for next := range adj[cur] {
				if !visited[next] {
					visited[next] = true
					if adj[src] == nil {
						adj[src] = make(map[string]bool)
					}
					adj[src][next] = true
					stack = append(stack, next)
				}
			}
		}
	}
	var out [][2]string
	for from := range adj {
		for to := range adj[from] {
			out = append(out, [2]string{from, to})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i][0] != out[j][0] {
			return out[i][0] < out[j][0]
		}
		return out[i][1] < out[j][1]
	})
	return out
}

// sampleRunIDs deterministically samples k of the given ids (uniform, without
// replacement) and returns them sorted. Seeded from the id list shape so the
// same corpus always yields the same sample - required for reproducible
// evaluations.
func sampleRunIDs(ids []int64, k int) []int64 {
	out := append([]int64(nil), ids...)
	seed := uint64(len(ids))*0x9E3779B97F4A7C15 + uint64(ids[0]) + uint64(ids[len(ids)-1])
	rng := rand.New(rand.NewPCG(seed, seed^0xD1B54A32D192ED03))
	for i := 0; i < k; i++ {
		j := i + rng.IntN(len(out)-i)
		out[i], out[j] = out[j], out[i]
	}
	out = out[:k]
	slices.Sort(out)
	return out
}

// topRunCount is how many runs the TopRuns summary keeps.
func topRunCount(opts Options) int {
	if opts.TopN > 0 {
		return opts.TopN
	}
	return 10
}

// trimToTopRuns returns the best n runs by (prefix depth, edge satisfaction,
// run id). Ranking is a total order, so trimming a superset that still contains
// the true top n yields the same answer as ranking everything at the end.
func trimToTopRuns(runs []RunResult, n int) []RunResult {
	top := append([]RunResult(nil), runs...)
	sort.Slice(top, func(i, j int) bool {
		if top[i].PrefixDepth != top[j].PrefixDepth {
			return top[i].PrefixDepth > top[j].PrefixDepth
		}
		if top[i].EdgeSatisfaction != top[j].EdgeSatisfaction {
			return top[i].EdgeSatisfaction > top[j].EdgeSatisfaction
		}
		return top[i].RunID < top[j].RunID
	})
	if len(top) > n {
		top = top[:n]
	}
	return top
}
