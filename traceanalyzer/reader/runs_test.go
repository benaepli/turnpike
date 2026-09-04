package reader

import (
	"bytes"
	"encoding/json"
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
