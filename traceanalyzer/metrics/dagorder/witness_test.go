package dagorder

import (
	"encoding/json"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/benaepli/turnpike-traceanalyzer/reader"
)

// witnessMismatch is one run where the matcher did not reach the depth the
// exact witness checker says the run's own events admit.
type witnessMismatch struct {
	RunID     int64 `json:"run_id"`
	Heuristic int   `json:"heuristic"`
	Exact     int   `json:"exact"`
}

type witnessReport struct {
	Corpus      string                      `json:"corpus"`
	Config      string                      `json:"config"`
	GradedRuns  int                         `json:"graded_runs"`
	Mismatches  []witnessMismatch           `json:"mismatches"`
	Depths      [][2]int64                  `json:"depths"`
	Contracted  []string                    `json:"contracted"`
	Evidence    map[string]map[string][]int `json:"evidence,omitempty"`
	ExactDepths map[string]int              `json:"exact_depths,omitempty"`
}

// TestCorpusWitnessExactness grades a corpus with the production matcher and
// with the exact witness checker and requires them to agree on every run. It
// runs only when TA_WITNESS_CORPUS names a run store; TA_WITNESS_CONFIG names
// the oracle DAG, TA_WITNESS_MAX_RUNS caps the sample the way -grade-max-runs
// does, TA_WITNESS_SWAPS sets the swap budget, TA_WITNESS_OUT receives a JSON
// report, and TA_WITNESS_EVIDENCE lists run ids whose per-label candidate
// steps are recorded.
func TestCorpusWitnessExactness(t *testing.T) {
	dbPath := os.Getenv("TA_WITNESS_CORPUS")
	cfgPath := os.Getenv("TA_WITNESS_CONFIG")
	if dbPath == "" || cfgPath == "" {
		t.Skip("set TA_WITNESS_CORPUS and TA_WITNESS_CONFIG to run the corpus witness check")
	}
	maxRuns := envInt(t, "TA_WITNESS_MAX_RUNS", 0)
	nSwaps := envInt(t, "TA_WITNESS_SWAPS", 200)

	cfg, err := LoadPlanConfig(cfgPath)
	if err != nil {
		t.Fatalf("load plan config: %v", err)
	}
	unobservable := make(map[string]bool, len(cfg.Events))
	for id, spec := range cfg.Events {
		if !spec.Kind.Matchable() {
			unobservable[id] = true
		}
	}
	encoding, err := reader.TimerEncoding(dbPath)
	if err != nil {
		t.Fatalf("probe timer encoding: %v", err)
	}
	if encoding == "none" {
		for id, spec := range cfg.Events {
			if spec.Kind == KindAllowTimer {
				unobservable[id] = true
			}
		}
	}
	t.Logf("timer encoding %q", encoding)

	labels := make([]string, 0, len(cfg.Events))
	for id := range cfg.Events {
		labels = append(labels, id)
	}
	sort.Strings(labels)
	allDeps := transitiveClosure(cfg.Dependencies)

	ids, err := reader.ListRunIDs(dbPath)
	if err != nil {
		t.Fatalf("list run ids: %v", err)
	}
	if maxRuns > 0 && len(ids) > maxRuns {
		ids = sampleRunIDs(ids, maxRuns)
	}

	evidence := make(map[int64]bool)
	for _, s := range strings.Split(os.Getenv("TA_WITNESS_EVIDENCE"), ",") {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			t.Fatalf("bad TA_WITNESS_EVIDENCE entry %q: %v", s, err)
		}
		evidence[v] = true
	}

	rep := witnessReport{
		Corpus:      dbPath,
		Config:      cfgPath,
		Mismatches:  []witnessMismatch{},
		Evidence:    map[string]map[string][]int{},
		ExactDepths: map[string]int{},
	}
	for id := range unobservable {
		rep.Contracted = append(rep.Contracted, id)
	}
	sort.Strings(rep.Contracted)

	rowFilter := timerRowFilter(cfg, encoding)
	functions := deliverFunctions(cfg)
	const chunkSize = 4000
	for start := 0; start < len(ids); start += chunkSize {
		stop := min(start+chunkSize, len(ids))
		chunk := ids[start:stop]
		execsByRun, err := reader.ReadExecutionsByRunWhere(dbPath, chunk, rowFilter)
		if err != nil {
			t.Fatalf("read executions: %v", err)
		}
		tracesByRun, err := reader.ReadEntersForMatching(dbPath, chunk, functions, maxCandidates)
		if err != nil {
			t.Fatalf("read handler entries: %v", err)
		}
		for _, rid := range chunk {
			idx := buildRunIndexFromEnters(execsByRun[rid], tracesByRun[rid])
			cands := make(map[string][]Event, len(cfg.Events))
			for id, spec := range cfg.Events {
				c, _ := buildCandidates(idx, spec)
				cands[id] = c
			}
			o := bestMatchingFull(labels, cands, cfg.Dependencies, allDeps, unobservable, rid, nSwaps)
			exact := exactWitnessDepth(labels, cands, cfg.Dependencies, unobservable)
			rep.GradedRuns++
			rep.Depths = append(rep.Depths, [2]int64{rid, int64(o.PrefixDepth)})
			if o.PrefixDepth != exact {
				rep.Mismatches = append(rep.Mismatches, witnessMismatch{RunID: rid, Heuristic: o.PrefixDepth, Exact: exact})
			}
			if evidence[rid] {
				key := strconv.FormatInt(rid, 10)
				steps := make(map[string][]int, len(cands))
				for id, c := range cands {
					s := make([]int, 0, len(c))
					for _, e := range c {
						s = append(s, int(e.Step))
					}
					steps[id] = s
				}
				rep.Evidence[key] = steps
				rep.ExactDepths[key] = exact
			}
		}
	}

	if out := os.Getenv("TA_WITNESS_OUT"); out != "" {
		b, err := json.Marshal(rep)
		if err != nil {
			t.Fatalf("encode report: %v", err)
		}
		if err := os.WriteFile(out, b, 0o644); err != nil {
			t.Fatalf("write report: %v", err)
		}
	}
	t.Logf("graded %d runs, %d mismatches", rep.GradedRuns, len(rep.Mismatches))
	if len(rep.Mismatches) > 0 {
		shown := rep.Mismatches
		if len(shown) > 20 {
			shown = shown[:20]
		}
		t.Fatalf("%d runs where the matcher missed the exact witness depth (first %d): %+v",
			len(rep.Mismatches), len(shown), shown)
	}
}

func envInt(t *testing.T, name string, def int) int {
	t.Helper()
	v := os.Getenv(name)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		t.Fatalf("bad %s=%q: %v", name, v, err)
	}
	return n
}
