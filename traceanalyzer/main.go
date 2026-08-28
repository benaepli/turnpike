package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/benaepli/turnpike-traceanalyzer/metrics"
	"github.com/benaepli/turnpike-traceanalyzer/metrics/dagorder"
	"github.com/benaepli/turnpike-traceanalyzer/reader"
	"github.com/benaepli/turnpike-traceanalyzer/report"
)

func main() {
	inputPath := flag.String("input", "", "Path to DuckDB file or Parquet output directory (required)")
	runID := flag.Int64("run", -1, "Run ID to analyze (-1 for all runs)")
	format := flag.String("format", "table", "Output format: table or json")
	dagConfig := flag.String("dag-config", "", "Path to plan_config.json for DAG-ordering metric (optional)")
	dagSwaps := flag.Int("dag-swaps", 200, "Local-search swap budget per run for DAG matching")
	grade := flag.Bool("grade", false, "Grade mode: L0/L1 SQL metrics + budgeted DAG prefix depth per -dag-config (comma-separated), skipping the standard metrics")
	gradeMaxRuns := flag.Int("grade-max-runs", 2000, "Grade mode: deterministic sample cap per DAG config (0 = all runs)")
	gradeBudgetMs := flag.Int64("grade-budget-ms", 60000, "Grade mode: wall budget per DAG config in ms (0 = unbounded)")
	gradePerRun := flag.Bool("grade-per-run", false, "Grade mode: include full per_run arrays instead of top_runs")
	gradeRunDepths := flag.Bool("grade-run-depths", false, "Grade mode: include run_depths, a compact [run_id, prefix_depth] pair per graded run")
	batchRuns := flag.Int("batch-runs", 2000, "Runs per metric query batch; partials are merged in Go (0 = one query over all runs)")
	runsTable := flag.Bool("runs", false, "Emit the runs table (one row per run: strategy, seeds, steps, wall, end reason) as JSON and exit")
	flag.Parse()

	if *inputPath == "" {
		flag.Usage()
		log.Fatalln("Error: -input flag is required.")
	}

	if *runsTable {
		rows, err := reader.ReadRuns(*inputPath)
		if err != nil {
			log.Fatalf("failed to read runs table: %v", err)
		}
		if rows == nil {
			rows = []reader.RunRow{}
		}
		enc := json.NewEncoder(os.Stdout)
		if err := enc.Encode(rows); err != nil {
			log.Fatalf("failed to write runs JSON: %v", err)
		}
		return
	}

	formatNorm := strings.ToLower(*format)
	if formatNorm != "table" && formatNorm != "json" {
		log.Fatalf("invalid format %q (use table|json)", *format)
	}

	// Verify we can list run IDs
	runIDs, err := reader.ListRunIDs(*inputPath)
	if err != nil {
		log.Fatalf("failed to list run IDs: %v", err)
	}

	if *runID >= 0 {
		found := false
		for _, id := range runIDs {
			if id == *runID {
				found = true
				break
			}
		}
		if !found {
			log.Fatalf("run_id %d not found. Available: %v", *runID, runIDs)
		}
		fmt.Fprintf(os.Stderr, "Analyzing run %d...\n", *runID)
	} else {
		fmt.Fprintf(os.Stderr, "Analyzing all %d runs...\n", len(runIDs))
	}

	r := &report.FullReport{RunID: *runID}

	if *grade {
		fmt.Fprintln(os.Stderr, "  Computing grade metrics (L0/L1)...")
		r.Grade, err = metrics.ComputeGrade(*inputPath, *runID, *batchRuns)
		if err != nil {
			log.Printf("Warning: grade metrics failed: %v", err)
		}
		if *runID < 0 && reader.HasRuns(*inputPath) {
			rows, rerr := reader.ReadRuns(*inputPath)
			if rerr != nil {
				log.Printf("Warning: runs table failed: %v", rerr)
			} else {
				r.RunsMeta = metrics.ComputeRunsMeta(rows)
			}
		}
		if *dagConfig != "" {
			opts := dagorder.Options{
				MaxRuns:          *gradeMaxRuns,
				BudgetMs:         *gradeBudgetMs,
				IncludePerRun:    *gradePerRun,
				IncludeRunDepths: *gradeRunDepths,
			}
			for _, cfgPath := range strings.Split(*dagConfig, ",") {
				cfgPath = strings.TrimSpace(cfgPath)
				if cfgPath == "" {
					continue
				}
				fmt.Fprintf(os.Stderr, "  Computing DAG prefix depth for %s...\n", cfgPath)
				d, derr := dagorder.ComputeDagOrderOpts(*inputPath, cfgPath, *runID, *dagSwaps, opts)
				if derr != nil {
					log.Printf("Warning: dag grade for %s failed: %v", cfgPath, derr)
					continue
				}
				r.GradeDags = append(r.GradeDags, d)
			}
		}
		switch formatNorm {
		case "json":
			if err := report.WriteJSON(os.Stdout, r); err != nil {
				log.Fatalf("failed to write JSON: %v", err)
			}
		case "table":
			report.WriteTable(os.Stdout, r)
		}
		return
	}

	// Duration metrics
	fmt.Fprintln(os.Stderr, "  Computing duration metrics...")
	r.Duration, err = metrics.ComputeDuration(*inputPath, *runID, *batchRuns)
	if err != nil {
		log.Printf("Warning: duration metrics failed: %v", err)
	}

	// Dispatch latency metrics
	fmt.Fprintln(os.Stderr, "  Computing dispatch metrics...")
	r.Dispatch, err = metrics.ComputeDispatch(*inputPath, *runID, *batchRuns)
	if err != nil {
		log.Printf("Warning: dispatch metrics failed: %v", err)
	}

	// Interleaving metrics
	fmt.Fprintln(os.Stderr, "  Computing interleaving metrics...")
	r.Interleaving, err = metrics.ComputeInterleaving(*inputPath, *runID, *batchRuns)
	if err != nil {
		log.Printf("Warning: interleaving metrics failed: %v", err)
	}

	// Fault metrics
	fmt.Fprintln(os.Stderr, "  Computing fault metrics...")
	r.Fault, err = metrics.ComputeFault(*inputPath, *runID, *batchRuns)
	if err != nil {
		log.Printf("Warning: fault metrics failed: %v", err)
	}

	// Fingerprint metrics
	fmt.Fprintln(os.Stderr, "  Computing fingerprint metrics...")
	r.Fingerprint, err = metrics.ComputeFingerprint(*inputPath, *runID, *batchRuns)
	if err != nil {
		log.Printf("Warning: fingerprint metrics failed: %v", err)
	}

	// DAG-ordering metric (opt-in via -dag-config)
	if *dagConfig != "" {
		fmt.Fprintln(os.Stderr, "  Computing DAG-ordering metrics...")
		r.DagOrder, err = dagorder.ComputeDagOrder(*inputPath, *dagConfig, *runID, *dagSwaps)
		if err != nil {
			log.Printf("Warning: dag-order metrics failed: %v", err)
		}
	}

	// Output
	switch formatNorm {
	case "json":
		if err := report.WriteJSON(os.Stdout, r); err != nil {
			log.Fatalf("failed to write JSON: %v", err)
		}
	case "table":
		report.WriteTable(os.Stdout, r)
	}
}
