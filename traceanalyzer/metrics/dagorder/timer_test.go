package dagorder

import (
	"reflect"
	"testing"

	"github.com/benaepli/turnpike-traceanalyzer/reader"
)

func timerPlan(label string) *PlanConfig {
	return &PlanConfig{Events: map[string]EventSpec{
		"t": {Kind: KindAllowTimer, Target: 1, TimerLabel: label},
		"w": {Kind: KindWrite, Target: 0, Key: "x"},
	}}
}

func wheres(cs []reader.RowClause) []string {
	out := make([]string, 0, len(cs))
	for _, c := range cs {
		out = append(out, c.Where)
	}
	return out
}

func TestTimerRowFilterColumnEncoding(t *testing.T) {
	got := timerRowFilter(timerPlan("timeout"), "column")
	want := []string{
		"kind <> 'TimerFired'",
		"kind = 'TimerFired' AND client_id = 1 AND action = 'System.TimerFired/timeout'",
	}
	if !reflect.DeepEqual(wheres(got), want) {
		t.Fatalf("labelled column filter: got %q want %q", wheres(got), want)
	}
	if got[0].PerRunCap != 0 || got[1].PerRunCap != maxCandidates || got[1].Node != "client_id" || got[1].Label != "substr(action, 19)" {
		t.Fatalf("timer clause is read aggregated at the candidate cap with column node and label: %+v", got[1])
	}
	got = timerRowFilter(timerPlan(""), "column")
	if got[1].Where != "kind = 'TimerFired' AND client_id = 1 AND starts_with(action, 'System.TimerFired/')" {
		t.Fatalf("label-less column filter: %q", got[1].Where)
	}
	got = timerRowFilter(timerPlan("it's"), "column")
	if got[1].Where != "kind = 'TimerFired' AND client_id = 1 AND action = 'System.TimerFired/it''s'" {
		t.Fatalf("quote in label not escaped: %q", got[1].Where)
	}
}

func TestTimerRowFilterPayloadEncoding(t *testing.T) {
	got := timerRowFilter(timerPlan("timeout"), "payload")
	want := []string{
		"kind <> 'TimerFired'",
		"kind = 'TimerFired' AND CAST(json_extract(payload, '$[0].value.index') AS BIGINT) = 1 AND json_extract_string(payload, '$[1].value') = 'timeout'",
	}
	if !reflect.DeepEqual(wheres(got), want) {
		t.Fatalf("payload filter: got %q want %q", wheres(got), want)
	}
	if got[1].PerRunCap != maxCandidates || got[1].Node != "CAST(json_extract(payload, '$[0].value.index') AS BIGINT)" || got[1].Label != "json_extract_string(payload, '$[1].value')" {
		t.Fatalf("payload clause reads node and label from the payload: %+v", got[1])
	}
	got = timerRowFilter(timerPlan(""), "payload")
	if got[1].Where != "kind = 'TimerFired' AND CAST(json_extract(payload, '$[0].value.index') AS BIGINT) = 1" {
		t.Fatalf("label-less payload filter: %q", got[1].Where)
	}
}

func TestTimerRowFilterWithoutTimerRows(t *testing.T) {
	got := timerRowFilter(timerPlan("timeout"), "none")
	if !reflect.DeepEqual(wheres(got), []string{"kind <> 'TimerFired'"}) {
		t.Fatalf("a corpus without timer rows reads only non-timer rows: %q", wheres(got))
	}
	got = timerRowFilter(&PlanConfig{Events: map[string]EventSpec{"w": {Kind: KindWrite}}}, "column")
	if !reflect.DeepEqual(wheres(got), []string{"kind <> 'TimerFired'"}) {
		t.Fatalf("a plan without allow_timer reads only non-timer rows: %q", wheres(got))
	}
}

func TestCollectTimerFiresReadsBothEncodings(t *testing.T) {
	payload := `[{"type":"VNode","value":{"index":1}},{"type":"VString","value":"timeout"}]`
	other := `[{"type":"VNode","value":{"index":2}},{"type":"VString","value":"timeout"}]`
	column := []reader.ExecutionRow{
		{RunID: 7, SeqNum: 3, ClientID: 1, Kind: "TimerFired", Action: "System.TimerFired/timeout", Payload: payload, Step: 10},
		{RunID: 7, SeqNum: 4, ClientID: 2, Kind: "TimerFired", Action: "System.TimerFired/timeout", Payload: other, Step: 11},
		{RunID: 7, SeqNum: 5, ClientID: 1, Kind: "TimerFired", Action: "System.TimerFired/other", Payload: payload, Step: 12},
		{RunID: 7, SeqNum: 6, ClientID: 0, Kind: "Invocation", Action: "ClientInterface.Write", Payload: payload, Step: 13},
	}
	legacy := []reader.ExecutionRow{
		{RunID: 7, SeqNum: 3, ClientID: -1, Kind: "TimerFired", Action: "System.TimerFired", Payload: payload, Step: 10},
		{RunID: 7, SeqNum: 4, ClientID: -1, Kind: "TimerFired", Action: "System.TimerFired", Payload: other, Step: 11},
		{RunID: 7, SeqNum: 5, ClientID: -1, Kind: "TimerFired", Action: "System.TimerFired", Payload: `[{"type":"VNode","value":{"index":1}},{"type":"VString","value":"other"}]`, Step: 12},
		{RunID: 7, SeqNum: 6, ClientID: 0, Kind: "Invocation", Action: "ClientInterface.Write", Payload: payload, Step: 13},
	}
	spec := EventSpec{Kind: KindAllowTimer, Target: 1, TimerLabel: "timeout"}
	gotColumn, _ := collectTimerFires(column, spec)
	gotLegacy, _ := collectTimerFires(legacy, spec)
	want := []Event{{Step: 10, IntraSeq: 3, Table: TableExec, NodeID: 1}}
	if !reflect.DeepEqual(gotColumn, want) || !reflect.DeepEqual(gotLegacy, want) {
		t.Fatalf("labelled: column %+v legacy %+v want %+v", gotColumn, gotLegacy, want)
	}
	any := EventSpec{Kind: KindAllowTimer, Target: 1}
	gotColumn, _ = collectTimerFires(column, any)
	gotLegacy, _ = collectTimerFires(legacy, any)
	want = []Event{
		{Step: 10, IntraSeq: 3, Table: TableExec, NodeID: 1},
		{Step: 12, IntraSeq: 5, Table: TableExec, NodeID: 1},
	}
	if !reflect.DeepEqual(gotColumn, want) || !reflect.DeepEqual(gotLegacy, want) {
		t.Fatalf("label-less: column %+v legacy %+v want %+v", gotColumn, gotLegacy, want)
	}
}

func TestDeliverFunctionsAreTheNamedHandlersOnce(t *testing.T) {
	one := 1
	cfg := &PlanConfig{Events: map[string]EventSpec{
		"a": {Kind: KindDeliver, Function: "Node.B", From: &one},
		"b": {Kind: KindDeliver, Function: "Node.A"},
		"c": {Kind: KindDeliver, Function: "Node.B"},
		"w": {Kind: KindWrite},
	}}
	if got := deliverFunctions(cfg); !reflect.DeepEqual(got, []string{"Node.A", "Node.B"}) {
		t.Fatalf("deliverFunctions: %q", got)
	}
	if got := deliverFunctions(&PlanConfig{Events: map[string]EventSpec{"w": {Kind: KindWrite}}}); len(got) != 0 {
		t.Fatalf("a plan without deliveries names no handler: %q", got)
	}
}

func TestRunIndexFromEntersCarriesTheSender(t *testing.T) {
	enters := []reader.EnterRow{
		{RunID: 3, SeqNum: 5, NodeID: 2, Step: 9, FunctionName: "Node.A", TraceID: 40, Sender: 1},
		{RunID: 3, SeqNum: 7, NodeID: 0, Step: 11, FunctionName: "Node.A", TraceID: 41, Sender: -1},
	}
	idx := buildRunIndexFromEnters(nil, enters)
	if len(idx.enters) != 2 || idx.enters[0].TraceKind != "Enter" || idx.enters[1].NodeID != 0 {
		t.Fatalf("enters: %+v", idx.enters)
	}
	if s, ok := idx.dispatchSender[40]; !ok || s != 1 {
		t.Fatalf("sender of trace 40: %v %v", s, ok)
	}
	if _, ok := idx.dispatchSender[41]; ok {
		t.Fatalf("a row without a dispatch has no sender")
	}
	from := 1
	got, _ := collectDelivers(idx, EventSpec{Kind: KindDeliver, Function: "Node.A", From: &from})
	if len(got) != 1 || got[0].TraceID != 40 {
		t.Fatalf("delivery from node 1: %+v", got)
	}
	got, _ = collectDelivers(idx, EventSpec{Kind: KindDeliver, Function: "Node.A"})
	if len(got) != 2 {
		t.Fatalf("delivery from any node: %+v", got)
	}
}
