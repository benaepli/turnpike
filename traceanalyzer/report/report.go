package report

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/benaepli/turnpike-traceanalyzer/metrics"
	"github.com/benaepli/turnpike-traceanalyzer/metrics/dagorder"
)

// FullReport is the top-level structure for all metrics output.
type FullReport struct {
	RunID        int64                       `json:"run_id"` // -1 means all runs
	Duration     *metrics.DurationResult     `json:"duration,omitempty"`
	Dispatch     *metrics.DispatchResult     `json:"dispatch,omitempty"`
	Interleaving *metrics.InterleavingResult `json:"interleaving,omitempty"`
	Fault        *metrics.FaultResult        `json:"fault,omitempty"`
	Fingerprint  *metrics.FingerprintResult  `json:"fingerprint,omitempty"`
	DagOrder     *dagorder.DagOrderResult    `json:"dag_order,omitempty"`
	Grade        *metrics.GradeResult        `json:"grade,omitempty"`
	GradeDags    []*dagorder.DagOrderResult  `json:"grade_dags,omitempty"`
	RunsMeta     *metrics.RunsMeta           `json:"runs_meta,omitempty"`
}

// WriteJSON writes the report as JSON to the given writer.
func WriteJSON(w io.Writer, r *FullReport) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(r)
}

// WriteTable writes the report as human-readable tables to the given writer.
func WriteTable(w io.Writer, r *FullReport) {
	if r.RunID >= 0 {
		fmt.Fprintf(w, "=== Trace Analysis for Run %d ===\n\n", r.RunID)
	} else {
		fmt.Fprintf(w, "=== Trace Analysis (All Runs) ===\n\n")
	}

	writeDurationTable(w, r.Duration)
	writeDispatchTable(w, r.Dispatch)
	writeInterleavingTable(w, r.Interleaving)
	writeFaultTable(w, r.Fault)
	writeFingerprintTable(w, r.Fingerprint)
	writeDagOrderTable(w, r.DagOrder)
	writeGradeTable(w, r.Grade)
	for _, d := range r.GradeDags {
		writeDagOrderTable(w, d)
		writeDepthTable(w, d)
	}
}

func writeGradeTable(w io.Writer, g *metrics.GradeResult) {
	if g == nil {
		return
	}
	fmt.Fprintf(w, "## Grade: throughput & hazards\n")
	fmt.Fprintf(w, "  Runs: %d  Invocations: %d  Responses: %d  Unpaired: %d (%.4f) in %d runs\n",
		g.TotalRuns, g.Invocations, g.Responses, g.UnpairedInvocations, g.UnpairedFraction, g.RunsWithUnpaired)
	if h := g.Hazards; h != nil {
		fmt.Fprintf(w, "  H1 crash-with-in-flight-send:  %6d runs (%.4f)\n", h.CrashInflightRuns, h.CrashInflightRate)
		fmt.Fprintf(w, "  H2 stale-incarnation delivery: %6d runs (%.4f)\n", h.StaleIncarnationRuns, h.StaleIncarnationRate)
		fmt.Fprintf(w, "  H2b receiver-stale delivery:   %6d runs (%.4f)\n", h.ReceiverStaleRuns, h.ReceiverStaleRate)
		fmt.Fprintf(w, "  H3 two-node crash+recover:     %6d runs (%.4f)\n", h.TwoNodeCrashRecoverRuns, h.TwoNodeCrashRecoverRate)
		fmt.Fprintf(w, "  H4 timer fired with in-flight: %6d runs (%.4f)\n", h.TimerRaceRuns, h.TimerRaceRate)
	}
	fmt.Fprintf(w, "  Wall: %d ms\n\n", g.WallMs)
}

func writeDepthTable(w io.Writer, d *dagorder.DagOrderResult) {
	if d == nil {
		return
	}
	fmt.Fprintf(w, "### Prefix Depth (%s)\n", d.ConfigPath)
	fmt.Fprintf(w, "  Graded: %d/%d runs (sampled=%v, budget_exhausted=%v)\n",
		d.GradedRuns, d.AvailableRuns, d.Sampled, d.BudgetExhausted)
	fmt.Fprintf(w, "  Max: %d  Mean: %.3f  P95: %d\n", d.MaxPrefixDepth, d.MeanPrefixDepth, d.P95PrefixDepth)
	denom := d.GradedRuns
	if denom < 1 {
		denom = 1
	}
	for k, n := range d.DepthAtLeast {
		fmt.Fprintf(w, "  depth >= %2d: %6d runs (%.5f)\n", k+1, n, float64(n)/float64(denom))
	}
	fmt.Fprintln(w)
}

func writeDurationTable(w io.Writer, d *metrics.DurationResult) {
	if d == nil || len(d.Functions) == 0 {
		fmt.Fprintf(w, "## Function Duration\nNo data.\n\n")
		return
	}

	fmt.Fprintf(w, "## Function Duration (step-distance)\n")
	fmt.Fprintf(w, "%-35s %6s %6s %6s %8s %8s %6s %6s %6s %6s %s\n",
		"Function", "Count", "Unp.", "Unp%", "Min", "Max", "Mean", "P50", "P95", "P99", "Var?")
	fmt.Fprintf(w, "%s\n", strings.Repeat("-", 115))

	for _, f := range d.Functions {
		flag := ""
		if f.HighVariance {
			flag = "HIGH"
		}
		fmt.Fprintf(w, "%-35s %6d %6d %5.1f%% %8d %8d %6.1f %6d %6d %6d %s\n",
			truncate(f.FunctionName, 35),
			f.Count, f.UnpairedCount, f.UnpairedRatio*100,
			f.Min, f.Max, f.Mean,
			f.P50, f.P95, f.P99,
			flag)
	}
	fmt.Fprintln(w)
}

func writeDispatchTable(w io.Writer, d *metrics.DispatchResult) {
	if d == nil || len(d.Functions) == 0 {
		return // Silently skip if no dispatch data
	}

	fmt.Fprintf(w, "## Dispatch Queueing Latency (Enter - Dispatch)\n")
	fmt.Fprintf(w, "%-35s %6s %8s %8s %6s %6s %6s %6s\n",
		"Function", "Count", "Min", "Max", "Mean", "P50", "P95", "P99")
	fmt.Fprintf(w, "%s\n", strings.Repeat("-", 90))

	for _, f := range d.Functions {
		fmt.Fprintf(w, "%-35s %6d %8d %8d %6.1f %6d %6d %6d\n",
			truncate(f.FunctionName, 35),
			f.Count, f.MinLatency, f.MaxLatency, f.MeanLatency,
			f.P50Latency, f.P95Latency, f.P99Latency)
	}
	fmt.Fprintln(w)
}

func writeInterleavingTable(w io.Writer, il *metrics.InterleavingResult) {
	if il == nil {
		fmt.Fprintf(w, "## Interleaving\nNo data.\n\n")
		return
	}

	if len(il.Depth) > 0 {
		fmt.Fprintf(w, "## Interleaving Depth (cross-node events during invocation)\n")
		fmt.Fprintf(w, "%-35s %6s %6s %6s %8s %6s %6s\n",
			"Function", "Count", "Min", "Max", "Mean", "P50", "P95")
		fmt.Fprintf(w, "%s\n", strings.Repeat("-", 85))
		for _, d := range il.Depth {
			fmt.Fprintf(w, "%-35s %6d %6d %6d %8.1f %6d %6d\n",
				truncate(d.FunctionName, 35),
				d.Count, d.MinDepth, d.MaxDepth, d.MeanDepth,
				d.P50Depth, d.P95Depth)
		}
		fmt.Fprintln(w)
	}

	if len(il.Overlap) > 0 {
		fmt.Fprintf(w, "## Concurrent Same-Function Overlap\n")
		fmt.Fprintf(w, "%-35s %10s %10s %10s\n",
			"Function", "Pairs", "Overlap", "Fraction")
		fmt.Fprintf(w, "%s\n", strings.Repeat("-", 70))
		for _, o := range il.Overlap {
			fmt.Fprintf(w, "%-35s %10d %10d %9.3f\n",
				truncate(o.FunctionName, 35),
				o.TotalPairs, o.OverlapCount, o.OverlapFraction)
		}
		fmt.Fprintln(w)
	}

	if len(il.SchedDelta) > 0 {
		fmt.Fprintf(w, "## Schedulable Count Delta (exit - enter)\n")
		fmt.Fprintf(w, "%-35s %6s %8s %8s %8s\n",
			"Function", "Count", "Min", "Max", "Mean")
		fmt.Fprintf(w, "%s\n", strings.Repeat("-", 70))
		for _, s := range il.SchedDelta {
			fmt.Fprintf(w, "%-35s %6d %8d %8d %8.1f\n",
				truncate(s.FunctionName, 35),
				s.Count, s.MinDelta, s.MaxDelta, s.MeanDelta)
		}
		fmt.Fprintln(w)
	}
}

func writeFaultTable(w io.Writer, f *metrics.FaultResult) {
	if f == nil {
		fmt.Fprintf(w, "## Fault Analysis\nNo data.\n\n")
		return
	}

	if len(f.CrashDuringFunc) > 0 {
		fmt.Fprintf(w, "## Functions Active During Crash\n")
		fmt.Fprintf(w, "%-35s %10s\n", "Function", "Interrupts")
		fmt.Fprintf(w, "%s\n", strings.Repeat("-", 48))
		for _, c := range f.CrashDuringFunc {
			fmt.Fprintf(w, "%-35s %10d\n",
				truncate(c.FunctionName, 35), c.InterruptCount)
		}
		fmt.Fprintln(w)
	}

	if f.CrashDistance != nil {
		fmt.Fprintf(w, "## Crash-to-Trace Distance\n")
		fmt.Fprintf(w, "  Crashes: %d, Min dist: %d, Max dist: %d, Mean dist: %.1f\n\n",
			f.CrashDistance.CrashCount,
			f.CrashDistance.MinDistance,
			f.CrashDistance.MaxDistance,
			f.CrashDistance.MeanDistance)
	}

	if len(f.CrashCoverage) > 0 {
		fmt.Fprintf(w, "## Per-Function Crash Coverage\n")
		fmt.Fprintf(w, "%-35s %8s %8s %10s\n", "Function", "CrRuns", "Total", "Coverage")
		fmt.Fprintf(w, "%s\n", strings.Repeat("-", 65))
		for _, c := range f.CrashCoverage {
			fmt.Fprintf(w, "%-35s %8d %8d %9.3f\n",
				truncate(c.FunctionName, 35),
				c.RunsWithCrash, c.TotalRuns, c.CoverageFraction)
		}
		fmt.Fprintln(w)
	}
}

func writeFingerprintTable(w io.Writer, fp *metrics.FingerprintResult) {
	if fp == nil {
		fmt.Fprintf(w, "## Exploration Diversity\nNo data.\n\n")
		return
	}

	fmt.Fprintf(w, "## Exploration Diversity\n")
	fmt.Fprintf(w, "  Total runs:           %d\n", fp.TotalRuns)
	fmt.Fprintf(w, "  Unique fingerprints:  %d\n", fp.UniqueFingerprints)
	fmt.Fprintf(w, "  Diversity ratio:      %.4f\n", fp.DiversityRatio)
	fmt.Fprintf(w, "  Unique node profiles: %d\n", fp.UniqueNodeProfiles)
	fmt.Fprintln(w)

	if len(fp.CausalChains) > 0 {
		fmt.Fprintf(w, "## Causal Chain Diversity\n")
		fmt.Fprintf(w, "%-35s %10s %12s\n", "Function", "Chains", "Invocations")
		fmt.Fprintf(w, "%s\n", strings.Repeat("-", 60))
		for _, c := range fp.CausalChains {
			fmt.Fprintf(w, "%-35s %10d %12d\n",
				truncate(c.FunctionName, 35),
				c.DistinctChains, c.TotalInvocations)
		}
		fmt.Fprintln(w)
	}
}

func writeDagOrderTable(w io.Writer, d *dagorder.DagOrderResult) {
	if d == nil {
		return // silently skip when -dag-config wasn't passed
	}

	fmt.Fprintf(w, "## DAG-Ordering Conformance (%s)\n", d.ConfigPath)
	fmt.Fprintf(w, "  Total runs:      %d\n", d.TotalRuns)
	fmt.Fprintf(w, "  Mean score:      %.4f\n", d.MeanScore)
	fmt.Fprintf(w, "  Min / Max:       %.4f / %.4f\n", d.MinScore, d.MaxScore)
	fmt.Fprintf(w, "  P50 / P95:       %.4f / %.4f\n", d.P50Score, d.P95Score)
	if d.TotalEdgeCount > 0 {
		fmt.Fprintf(w, "  Dropped edges:   %d / %d (unmatchable events: allow_timer/partition/heal)\n",
			d.DroppedEdgeCount, d.TotalEdgeCount)
	}
	if d.DroppedMajority {
		fmt.Fprintf(w, "  !! WARNING: >50%% of edges touch unmatchable events; score covers the matchable subset only.\n")
	}
	fmt.Fprintln(w)

	// Top runs (best scores first) - most useful for bug-hunting.
	if len(d.PerRun) > 0 {
		top := topNRuns(d.PerRun, 10)
		fmt.Fprintf(w, "### Top Runs by Score\n")
		fmt.Fprintf(w, "%-10s %10s %8s %8s %8s %8s %8s %8s\n",
			"RunID", "Score", "Satisfied", "Eligible", "Matched", "Labels", "ZeroCnd", "Crowded")
		fmt.Fprintf(w, "%s\n", strings.Repeat("-", 80))
		for _, r := range top {
			satisfied := int(r.EdgeSatisfaction * float64(r.EligibleEdges))
			fmt.Fprintf(w, "%-10d %10.4f %8d %8d %8d %8d %8d %8d\n",
				r.RunID, r.EdgeSatisfaction, satisfied, r.EligibleEdges,
				r.MatchedLabels, r.TotalLabels,
				len(r.ZeroCandidateLabels), len(r.CrowdedOutLabels))
		}
		fmt.Fprintln(w)
	}

	// Per-edge frequencies, worst-first (already sorted that way in dagorder.go).
	if len(d.PerEdge) > 0 {
		fmt.Fprintf(w, "### Per-Edge Satisfaction (worst first)\n")
		fmt.Fprintf(w, "%-30s %-30s %10s %10s %10s\n",
			"From", "To", "Satisfied", "Eligible", "Fraction")
		fmt.Fprintf(w, "%s\n", strings.Repeat("-", 96))
		for _, e := range d.PerEdge {
			fmt.Fprintf(w, "%-30s %-30s %10d %10d %9.3f\n",
				truncate(e.From, 30), truncate(e.To, 30),
				e.SatisfiedCount, e.EligibleCount, e.Fraction)
		}
		fmt.Fprintln(w)
	}
}

// topNRuns returns up to n runs sorted by EdgeSatisfaction desc (ties -> RunID asc).
func topNRuns(runs []dagorder.RunResult, n int) []dagorder.RunResult {
	out := make([]dagorder.RunResult, len(runs))
	copy(out, runs)
	sort.Slice(out, func(i, j int) bool {
		if out[i].EdgeSatisfaction != out[j].EdgeSatisfaction {
			return out[i].EdgeSatisfaction > out[j].EdgeSatisfaction
		}
		return out[i].RunID < out[j].RunID
	})
	if len(out) > n {
		out = out[:n]
	}
	return out
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen-2] + ".."
}
