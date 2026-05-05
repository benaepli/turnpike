package dagorder

import (
	"os"
	"path/filepath"
	"testing"
)

// TestLoadExamplePlan checks that the simple example plan parses correctly.
func TestLoadExamplePlan(t *testing.T) {
	path := findConfig(t, "example_plan.json")
	cfg, err := LoadPlanConfig(path)
	if err != nil {
		t.Fatalf("LoadPlanConfig: %v", err)
	}
	if cfg.NumServers != 3 {
		t.Errorf("NumServers: got %d, want 3", cfg.NumServers)
	}
	if len(cfg.Events) != 5 {
		t.Errorf("len(Events): got %d, want 5", len(cfg.Events))
	}
	if len(cfg.Dependencies) != 3 {
		t.Errorf("len(Dependencies): got %d, want 3", len(cfg.Dependencies))
	}
	w1, ok := cfg.Events["w1"]
	if !ok {
		t.Fatalf("event w1 missing")
	}
	if w1.Kind != KindWrite || w1.Target != 0 || w1.Key != "key1" {
		t.Errorf("w1: got %+v, want Write(0,\"key1\")", w1)
	}
	crash, ok := cfg.Events["crash1"]
	if !ok {
		t.Fatalf("event crash1 missing")
	}
	if crash.Kind != KindCrash || crash.Target != 1 {
		t.Errorf("crash1: got %+v, want Crash(1)", crash)
	}
}

// TestLoadVrBugDeliver checks the more complex plan with deliver events.
func TestLoadVrBugDeliver(t *testing.T) {
	path := findConfig(t, "vr_bug_deliver.json")
	cfg, err := LoadPlanConfig(path)
	if err != nil {
		t.Fatalf("LoadPlanConfig: %v", err)
	}
	if len(cfg.Events) != 17 {
		t.Errorf("len(Events): got %d, want 17", len(cfg.Events))
	}
	if len(cfg.Dependencies) != 22 {
		t.Errorf("len(Dependencies): got %d, want 22", len(cfg.Dependencies))
	}

	deliver, ok := cfg.Events["deliver_svc_1_to_2"]
	if !ok {
		t.Fatalf("event deliver_svc_1_to_2 missing")
	}
	if deliver.Kind != KindDeliver || deliver.Function != "Node.StartViewChange" {
		t.Errorf("deliver: got %+v", deliver)
	}
	if deliver.From == nil || *deliver.From != 1 {
		t.Errorf("deliver.From: got %v, want 1", deliver.From)
	}
	if deliver.To == nil || *deliver.To != 2 {
		t.Errorf("deliver.To: got %v, want 2", deliver.To)
	}

	allow, ok := cfg.Events["allow_t1"]
	if !ok {
		t.Fatalf("event allow_t1 missing")
	}
	if allow.Kind != KindAllowTimer || allow.Target != 1 || allow.TimerLabel != "timeout" {
		t.Errorf("allow_t1: got %+v", allow)
	}
}

// TestUnknownEventVariant verifies that unknown keys produce a clear error
// rather than silently parsing.
func TestUnknownEventVariant(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.json")
	content := `{"num_servers": 1, "events": {"e1": {"bogus": 42}}, "dependencies": []}`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadPlanConfig(path); err == nil {
		t.Fatal("expected error for unknown event variant, got nil")
	}
}

// TestDependencyValidation rejects edges that reference unknown event labels.
func TestDependencyValidation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.json")
	content := `{
		"num_servers": 1,
		"events": {"e1": {"crash": 0}},
		"dependencies": [["e1", "nonexistent"]]
	}`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadPlanConfig(path); err == nil {
		t.Fatal("expected error for unknown dep label, got nil")
	}
}

// findConfig locates a scheduler_configs/<name> file by walking up from CWD.
func findConfig(t *testing.T, name string) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for range 8 {
		candidate := filepath.Join(dir, "scheduler_configs", name)
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("could not locate scheduler_configs/%s", name)
	return ""
}
