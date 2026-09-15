package reader

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteRunsProjectedKeepsOnlyNamedColumns(t *testing.T) {
	rows := []RunRow{
		{RunID: 7, Arm: "grid", StepsUsed: 12, Variant: 513},
		{RunID: 9, Arm: "grid", StepsUsed: 3, Variant: 0},
	}
	var buf bytes.Buffer
	if err := WriteRunsProjected(&buf, rows, []string{"run_id", "variant"}); err != nil {
		t.Fatal(err)
	}
	var got []map[string]any
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("output is not a JSON array: %v\n%s", err, buf.String())
	}
	if len(got) != 2 {
		t.Fatalf("want 2 rows, got %d", len(got))
	}
	for i, want := range []struct{ id, variant float64 }{{7, 513}, {9, 0}} {
		if len(got[i]) != 2 {
			t.Errorf("row %d carries %d keys, want 2: %v", i, len(got[i]), got[i])
		}
		if got[i]["run_id"] != want.id || got[i]["variant"] != want.variant {
			t.Errorf("row %d = %v, want run_id %v variant %v", i, got[i], want.id, want.variant)
		}
	}
	if !strings.HasSuffix(buf.String(), "]\n") {
		t.Errorf("output must end the array with a newline, got %q", buf.String())
	}
}

func TestWriteRunsProjectedEmptyTableIsEmptyArray(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteRunsProjected(&buf, nil, []string{"run_id"}); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(buf.String()) != "[]" {
		t.Errorf("want [], got %q", buf.String())
	}
}

func TestWriteRunsProjectedRejectsUnknownColumn(t *testing.T) {
	var buf bytes.Buffer
	err := WriteRunsProjected(&buf, []RunRow{{RunID: 1}}, []string{"run_id", "no_such_column"})
	if err == nil {
		t.Fatal("an unknown column must be an error")
	}
	if buf.Len() != 0 {
		t.Errorf("nothing may be written before the column check, got %q", buf.String())
	}
}

// TestReadRunsDeploymentColumns reads the deployment id and parameter tuple
// from a runs table and projects them by name.
func TestReadRunsDeploymentColumns(t *testing.T) {
	dir := t.TempDir()
	for _, sub := range []string{"executions", "runs"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	db, err := sql.Open("duckdb", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	out := filepath.Join(dir, "runs", "part-0.parquet")
	if _, err := db.Exec(`COPY (SELECT * FROM (VALUES
		(1::BIGINT, 'grid', 0::INTEGER, '{"n":3}'),
		(0::BIGINT, 'grid', -1::INTEGER, '{"n":5}')
	) AS t(run_id, arm, deployment_id, params)) TO '` + out + `' (FORMAT parquet)`); err != nil {
		t.Fatalf("write runs: %v", err)
	}

	rows, err := ReadRuns(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d", len(rows))
	}
	if rows[0].RunID != 0 || rows[0].DeploymentID != -1 || rows[0].Params != `{"n":5}` {
		t.Errorf("run 0: %+v", rows[0])
	}
	if rows[1].RunID != 1 || rows[1].DeploymentID != 0 || rows[1].Params != `{"n":3}` {
		t.Errorf("run 1: %+v", rows[1])
	}

	var buf bytes.Buffer
	if err := WriteRunsProjected(&buf, rows, []string{"run_id", "deployment_id", "params"}); err != nil {
		t.Fatal(err)
	}
	want := `[{"run_id":0,"deployment_id":-1,"params":"{\"n\":5}"},{"run_id":1,"deployment_id":0,"params":"{\"n\":3}"}]` + "\n"
	if buf.String() != want {
		t.Errorf("projection:\n got %s\nwant %s", buf.String(), want)
	}
}
