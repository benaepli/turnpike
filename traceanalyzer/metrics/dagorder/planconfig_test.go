package dagorder

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/benaepli/turnpike-traceanalyzer/reader"
)

// resolvedExample carries every event form a resolved plan can hold.
const resolvedExample = `{
	"deploy": "Single",
	"params": {"n": 3},
	"num_runs": 50,
	"max_iterations": 5000,
	"node_count": 3,
	"events": {
		"w1": {"write": {"dest": 0, "key": "key1"}},
		"w2": {"write": {"key": "key2"}},
		"r1": {"read": {"dest": 2, "key": "key1"}},
		"m1": {"rmw": {"key": "key1"}},
		"c1": {"crash": 1},
		"v1": {"recover": 1},
		"t1": {"allow_timer": {"node": 2, "label": "election"}},
		"p1": {"partition": {"type": "halves", "group": [0, 1, 2], "side_a": [0]}},
		"p2": {"partition": {"type": "majorities_ring", "group": [0, 1, 2]}},
		"p3": {"partition": {"type": "bridge", "group": [0, 1, 2], "bridge": 1}},
		"p4": {"partition": {"type": "isolate_one", "node": 0}},
		"h1": "heal",
		"d1": {"deliver": {"function": "Node.AppendEntries", "from": 0, "to": 1}},
		"d2": {"deliver": {"function": "Node.AppendEntries"}}
	},
	"dependencies": [["w1", "c1"], ["c1", "v1"], ["v1", "r1"]]
}`

func writePlan(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), ResolvedPlanFile)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadResolvedPlan(t *testing.T) {
	cfg, err := LoadPlanConfig(writePlan(t, resolvedExample))
	if err != nil {
		t.Fatalf("LoadPlanConfig: %v", err)
	}
	if cfg.NodeCount != 3 {
		t.Errorf("NodeCount: got %d, want 3", cfg.NodeCount)
	}
	if len(cfg.Events) != 14 {
		t.Errorf("len(Events): got %d, want 14", len(cfg.Events))
	}
	if len(cfg.Dependencies) != 3 {
		t.Errorf("len(Dependencies): got %d, want 3", len(cfg.Dependencies))
	}

	checks := map[string]EventSpec{
		"w1": {Kind: KindWrite, Target: 0, Key: "key1"},
		"w2": {Kind: KindWrite, Target: NoNode, Key: "key2"},
		"r1": {Kind: KindRead, Target: 2, Key: "key1"},
		"m1": {Kind: KindRmw, Target: NoNode, Key: "key1"},
		"c1": {Kind: KindCrash, Target: 1},
		"v1": {Kind: KindRecover, Target: 1},
		"t1": {Kind: KindAllowTimer, Target: 2, TimerLabel: "election"},
		"p1": {Kind: KindPartition},
		"p4": {Kind: KindPartition},
		"h1": {Kind: KindHeal},
		"d2": {Kind: KindDeliver, Function: "Node.AppendEntries"},
	}
	for id, want := range checks {
		if got := cfg.Events[id]; got != want {
			t.Errorf("%s: got %+v, want %+v", id, got, want)
		}
	}
	d1 := cfg.Events["d1"]
	if d1.Kind != KindDeliver || d1.Function != "Node.AppendEntries" ||
		d1.From == nil || *d1.From != 0 || d1.To == nil || *d1.To != 1 {
		t.Errorf("d1: got %+v", d1)
	}
}

// TestLoadResolvedPlanFromDirectory reads the resolved plan out of a run-plan
// output directory.
func TestLoadResolvedPlanFromDirectory(t *testing.T) {
	path := writePlan(t, resolvedExample)
	cfg, err := LoadPlanConfig(filepath.Dir(path))
	if err != nil {
		t.Fatalf("LoadPlanConfig: %v", err)
	}
	if len(cfg.Events) != 14 {
		t.Errorf("len(Events): got %d, want 14", len(cfg.Events))
	}
}

// TestRejectsUnresolvedPlan requires the node count and index targets that
// only a resolved plan carries.
func TestRejectsUnresolvedPlan(t *testing.T) {
	unresolved := `{"deploy": "Single", "params": {"n": 3},
		"events": {"c1": {"crash": "nodes[1]"}}, "dependencies": []}`
	_, err := ParsePlanConfig([]byte(unresolved))
	if err == nil || !strings.Contains(err.Error(), ResolvedPlanFile) {
		t.Fatalf("a plan without node_count must point at %s, got %v", ResolvedPlanFile, err)
	}
	withPath := `{"node_count": 3, "events": {"c1": {"crash": "nodes[1]"}}, "dependencies": []}`
	if _, err := ParsePlanConfig([]byte(withPath)); err == nil {
		t.Fatal("a path target must be an error")
	}
}

func TestRejectsMalformedEvents(t *testing.T) {
	cases := map[string]string{
		"unknown variant":        `{"bogus": 42}`,
		"old tuple form":         `{"write": [0, "key1"]}`,
		"missing key":            `{"read": {"dest": 0}}`,
		"dest out of range":      `{"write": {"dest": 3, "key": "k"}}`,
		"negative crash":         `{"crash": -1}`,
		"timer without node":     `{"allow_timer": {"label": "election"}}`,
		"deliver to a client":    `{"deliver": {"function": "Node.A", "to": 7}}`,
		"unknown partition":      `{"partition": {"type": "thirds", "group": [0, 1, 2]}}`,
		"side_a out of group":    `{"partition": {"type": "halves", "group": [0, 1], "side_a": [2]}}`,
		"bridge out of group":    `{"partition": {"type": "bridge", "group": [0, 1, 2], "bridge": 3}}`,
		"bridge missing":         `{"partition": {"type": "bridge", "group": [0, 1, 2]}}`,
		"ring member path":       `{"partition": {"type": "majorities_ring", "group": "nodes"}}`,
		"empty group":            `{"partition": {"type": "halves", "group": [], "side_a": []}}`,
		"isolate_one node range": `{"partition": {"type": "isolate_one", "node": 5}}`,
	}
	for name, event := range cases {
		content := `{"node_count": 3, "events": {"e1": ` + event + `}, "dependencies": []}`
		if _, err := ParsePlanConfig([]byte(content)); err == nil {
			t.Errorf("%s: expected an error, got nil", name)
		}
	}
}

// TestDependencyValidation rejects edges that reference unknown event labels.
func TestDependencyValidation(t *testing.T) {
	content := `{
		"node_count": 1,
		"events": {"e1": {"crash": 0}},
		"dependencies": [["e1", "nonexistent"]]
	}`
	if _, err := LoadPlanConfig(writePlan(t, content)); err == nil {
		t.Fatal("expected error for unknown dep label, got nil")
	}
}

// TestInvocationWithoutDestination matches a dest-less plan operation only
// against invocations that carry a unit destination.
func TestInvocationWithoutDestination(t *testing.T) {
	unit := `[{"type":"VUnit","value":null},{"type":"VString","value":"k"},{"type":"VInt","value":4}]`
	node := `[{"type":"VNode","value":{"role":0,"index":0}},{"type":"VString","value":"k"},{"type":"VInt","value":5}]`
	target, key, err := parseInvocationPayload(unit)
	if err != nil || target != NoNode || key != "k" {
		t.Fatalf("unit dest: got %d %q %v", target, key, err)
	}
	if _, _, err := parseInvocationPayload(`[{"type":"VInt","value":0},{"type":"VString","value":"k"}]`); err == nil {
		t.Fatal("a dest that is neither a node nor unit must be an error")
	}
	rows := []reader.ExecutionRow{
		{RunID: 1, SeqNum: 1, ClientID: 0, Kind: "Invocation", Action: "Client.Write", Payload: unit, Step: 3},
		{RunID: 1, SeqNum: 2, ClientID: 0, Kind: "Invocation", Action: "Client.Write", Payload: node, Step: 4},
		{RunID: 1, SeqNum: 3, ClientID: 0, Kind: "Invocation", Action: "ClientInterface.Write", Payload: unit, Step: 5},
	}
	got, _ := collectClientInvocations(rows, EventSpec{Kind: KindWrite, Target: NoNode, Key: "k"})
	if len(got) != 1 || got[0].Step != 3 || got[0].NodeID != NoNode {
		t.Fatalf("dest-less write: %+v", got)
	}
	got, _ = collectClientInvocations(rows, EventSpec{Kind: KindWrite, Target: 0, Key: "k"})
	if len(got) != 1 || got[0].Step != 4 {
		t.Fatalf("write to node 0: %+v", got)
	}
}
