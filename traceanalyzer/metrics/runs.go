package metrics

import (
	"sort"

	"github.com/benaepli/turnpike-traceanalyzer/reader"
)

// RunsMeta summarises the runs table: how runs ended, how long they took,
// and which strategy issued them.
type RunsMeta struct {
	Present    bool             `json:"present"`
	Runs       int64            `json:"runs"`
	EndReasons map[string]int64 `json:"end_reasons"`
	Arms       map[string]int64 `json:"arms"`
	MeanSteps  float64          `json:"mean_steps"`
	P50WallUs  int64            `json:"p50_wall_us"`
	// Wall offset of the last run to finish, the session's exposure as the
	// runs table saw it.
	LastOffsetMs int64 `json:"last_offset_ms"`
}

// ComputeRunsMeta summarises rows; an empty or absent table reports
// Present false.
func ComputeRunsMeta(rows []reader.RunRow) *RunsMeta {
	m := &RunsMeta{EndReasons: map[string]int64{}, Arms: map[string]int64{}}
	if len(rows) == 0 {
		return m
	}
	m.Present = true
	m.Runs = int64(len(rows))
	walls := make([]int64, 0, len(rows))
	var steps int64
	for _, r := range rows {
		m.EndReasons[r.EndReason]++
		m.Arms[r.Arm]++
		steps += int64(r.StepsUsed)
		walls = append(walls, r.WallUs)
		if r.SessionOffsetMs > m.LastOffsetMs {
			m.LastOffsetMs = r.SessionOffsetMs
		}
	}
	m.MeanSteps = float64(steps) / float64(len(rows))
	sort.Slice(walls, func(i, j int) bool { return walls[i] < walls[j] })
	m.P50WallUs = walls[len(walls)/2]
	return m
}
