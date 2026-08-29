package dagorder

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/benaepli/turnpike-traceanalyzer/reader"
)

// SourceTable distinguishes which Parquet table the event was read from.
// seq_num is independent across tables (each batch numbers rows 0..n in its
// own table; see spur/spur-core/src/simulator/history.rs:298,339,385), so we
// must not compare seq_num across tables. Step is comparable, but ties at
// the same step across tables have no defined ordering - see lessThan.
type SourceTable uint8

const (
	TableExec SourceTable = iota
	TableTrace
)

// Event is a concrete occurrence in a run that a plan label could match to.
type Event struct {
	Step     int32       // simulator's global step counter (path_state.crash_info.current_step)
	IntraSeq int64       // per-table seq_num, used as a tiebreaker within the same Table
	Table    SourceTable // which Parquet table sourced this row
	NodeID   int64       // the node the event occurred on (receiver for Deliver, target for Write/Crash/...)
	TraceID  int64       // only meaningful for trace-sourced events
}

// runIndex holds per-run lookups used when building candidates.
type runIndex struct {
	execs []reader.ExecutionRow
	// traces filtered to Enter rows, for Deliver matching.
	enters []reader.TraceRow
	// trace_id -> sender node_id, built from Dispatch rows.
	dispatchSender map[int64]int64
}

// buildRunIndexFromEnters builds the index from entries that already carry
// their sender, the shape reader.ReadEntersForMatching returns.
func buildRunIndexFromEnters(execs []reader.ExecutionRow, enters []reader.EnterRow) *runIndex {
	idx := &runIndex{
		execs:          execs,
		enters:         make([]reader.TraceRow, 0, len(enters)),
		dispatchSender: make(map[int64]int64, len(enters)),
	}
	for i := range enters {
		e := &enters[i]
		idx.enters = append(idx.enters, reader.TraceRow{
			RunID: e.RunID, SeqNum: e.SeqNum, NodeID: e.NodeID, Step: e.Step,
			FunctionName: e.FunctionName, TraceKind: "Enter", TraceID: e.TraceID,
		})
		if e.Sender >= 0 {
			if _, exists := idx.dispatchSender[e.TraceID]; !exists {
				idx.dispatchSender[e.TraceID] = e.Sender
			}
		}
	}
	return idx
}

// deliverFunctions lists the handlers the plan's deliver events name, the
// only functions whose entries the matcher reads.
func deliverFunctions(cfg *PlanConfig) []string {
	seen := map[string]bool{}
	var out []string
	for _, spec := range cfg.Events {
		if spec.Kind == KindDeliver && spec.Function != "" && !seen[spec.Function] {
			seen[spec.Function] = true
			out = append(out, spec.Function)
		}
	}
	sort.Strings(out)
	return out
}

func buildRunIndex(execs []reader.ExecutionRow, traces []reader.TraceRow) *runIndex {
	idx := &runIndex{
		execs:          execs,
		dispatchSender: make(map[int64]int64),
	}
	for i := range traces {
		r := &traces[i]
		switch r.TraceKind {
		case "Enter":
			idx.enters = append(idx.enters, *r)
		case "Dispatch":
			// Record sender; on duplicate trace_id, keep the first (shouldn't occur).
			if _, exists := idx.dispatchSender[r.TraceID]; !exists {
				idx.dispatchSender[r.TraceID] = r.NodeID
			}
		}
	}
	return idx
}

// taggedValue mirrors the Rust json_of_value output.
type taggedValue struct {
	Type  string          `json:"type"`
	Value json.RawMessage `json:"value"`
}

// vnodeValue mirrors NodeId { role: NameId(usize), index: usize }.
// NameId is a serde newtype, so it serializes as a bare integer.
type vnodeValue struct {
	Role  int `json:"role"`
	Index int `json:"index"`
}

// parseInvocationPayload extracts (targetNode, key) from a ClientInterface.Write/Read/Rmw
// invocation payload. Write has 3 args (dest, key, uid), Read has 2 (dest, key),
// RMW has 3 (dest, key, uid). We only care about the first two.
func parseInvocationPayload(payload string) (target int, key string, err error) {
	var tagged []taggedValue
	if err = json.Unmarshal([]byte(payload), &tagged); err != nil {
		return 0, "", fmt.Errorf("payload not JSON array: %w", err)
	}
	if len(tagged) < 2 {
		return 0, "", fmt.Errorf("expected >=2 payload elements, got %d", len(tagged))
	}

	if tagged[0].Type != "VNode" {
		return 0, "", fmt.Errorf("payload[0] expected VNode, got %q", tagged[0].Type)
	}
	var n vnodeValue
	if err = json.Unmarshal(tagged[0].Value, &n); err != nil {
		return 0, "", fmt.Errorf("VNode value: %w", err)
	}

	if tagged[1].Type != "VString" {
		return 0, "", fmt.Errorf("payload[1] expected VString, got %q", tagged[1].Type)
	}
	if err = json.Unmarshal(tagged[1].Value, &key); err != nil {
		return 0, "", fmt.Errorf("VString value: %w", err)
	}

	return n.Index, key, nil
}

// parseNodePayload extracts a single VNode's index from a payload whose first
// element is a VNode. Used for Crash/Recover/Partition rows, where the target
// node is in payload[0] (path.rs:471-485 passes the crashed node as the payload).
func parseNodePayload(payload string) (int, error) {
	var tagged []taggedValue
	if err := json.Unmarshal([]byte(payload), &tagged); err != nil {
		return 0, fmt.Errorf("payload not JSON array: %w", err)
	}
	if len(tagged) < 1 {
		return 0, fmt.Errorf("empty payload")
	}
	if tagged[0].Type != "VNode" {
		return 0, fmt.Errorf("payload[0] expected VNode, got %q", tagged[0].Type)
	}
	var n vnodeValue
	if err := json.Unmarshal(tagged[0].Value, &n); err != nil {
		return 0, fmt.Errorf("VNode value: %w", err)
	}
	return n.Index, nil
}

// actionFor returns the executions.action string for a ClientInterface op kind.
// Verified against spur/spur-core/src/simulator/path.rs:154-167 (op_name -> op_action).
func actionFor(kind EventKind) string {
	switch kind {
	case KindWrite:
		return "ClientInterface.Write"
	case KindRead:
		return "ClientInterface.Read"
	case KindRmw:
		return "ClientInterface.RMW"
	default:
		return ""
	}
}

// maxCandidates caps the candidate list per label to keep the matching search
// bounded. When a label hits this cap, buildCandidates flags it via the
// returned `truncated` set so callers can warn - silently dropping matches
// would let runs score 0 for no diagnosable reason.
const maxCandidates = 256

// buildCandidates returns the concrete events that could match the given spec
// in this run. Results are sorted ascending by Step (rows are appended in
// step order, so iteration order suffices) and truncated to maxCandidates.
// The second return is true iff the cap was hit.
func buildCandidates(idx *runIndex, spec EventSpec) ([]Event, bool) {
	switch spec.Kind {
	case KindWrite, KindRead, KindRmw:
		return collectClientInvocations(idx.execs, spec)
	case KindCrash:
		return collectExecByKind(idx.execs, "Crash", spec.Target)
	case KindRecover:
		return collectExecByKind(idx.execs, "Recover", spec.Target)
	case KindDeliver:
		return collectDelivers(idx, spec)
	case KindAllowTimer:
		return collectTimerFires(idx.execs, spec)
	default:
		// partition, heal: unmatchable in non-plan-mode runs.
		return nil, false
	}
}

// collectTimerFires matches TimerFired rows on the target node. A row whose
// client_id is not negative names the node there and the label after the
// action's `/`; an older row leaves client_id at -1 and carries both only in
// the payload, whose shape is a client invocation's, a node then a string,
// so the invocation parser reads it. An empty label in the spec matches any
// timer on the node.
func collectTimerFires(execs []reader.ExecutionRow, spec EventSpec) ([]Event, bool) {
	var out []Event
	for i := range execs {
		e := &execs[i]
		if e.Kind != "TimerFired" {
			continue
		}
		var target int
		var label string
		if e.ClientID >= 0 {
			target = int(e.ClientID)
			label = strings.TrimPrefix(e.Action, reader.TimerActionPrefix)
		} else {
			var err error
			target, label, err = parseInvocationPayload(e.Payload)
			if err != nil {
				continue
			}
		}
		if target != spec.Target || (spec.TimerLabel != "" && label != spec.TimerLabel) {
			continue
		}
		out = append(out, Event{
			Step:     e.Step,
			IntraSeq: e.SeqNum,
			Table:    TableExec,
			NodeID:   int64(target),
		})
		if len(out) >= maxCandidates {
			return out, true
		}
	}
	return out, false
}

func collectClientInvocations(execs []reader.ExecutionRow, spec EventSpec) ([]Event, bool) {
	action := actionFor(spec.Kind)
	var out []Event
	for i := range execs {
		e := &execs[i]
		if e.Kind != "Invocation" || e.Action != action {
			continue
		}
		target, key, err := parseInvocationPayload(e.Payload)
		if err != nil {
			// Payload format drift should be loud, but we don't want a single bad
			// row to abort the whole metric. Skip and move on.
			continue
		}
		if target != spec.Target || key != spec.Key {
			continue
		}
		out = append(out, Event{
			Step:     e.Step,
			IntraSeq: e.SeqNum,
			Table:    TableExec,
			NodeID:   int64(target),
		})
		if len(out) >= maxCandidates {
			return out, true
		}
	}
	return out, false
}

// collectExecByKind matches Crash/Recover rows. We deliberately filter on
// Kind alone (not Action): the executions table's Kind column is unique per
// system event (see history.rs:191-196), and the corresponding Action value
// - "System.Crash" / "System.Recover" - is already implied by Kind. Adding
// Action filtering would just couple this code to that string and gain
// nothing.
func collectExecByKind(execs []reader.ExecutionRow, kind string, target int) ([]Event, bool) {
	var out []Event
	for i := range execs {
		e := &execs[i]
		if e.Kind != kind {
			continue
		}
		// Crash/Recover rows set client_id = -1; the affected node is in
		// payload[0] as a VNode.
		idx, err := parseNodePayload(e.Payload)
		if err != nil {
			continue
		}
		if idx != target {
			continue
		}
		out = append(out, Event{
			Step:     e.Step,
			IntraSeq: e.SeqNum,
			Table:    TableExec,
			NodeID:   int64(idx),
		})
		if len(out) >= maxCandidates {
			return out, true
		}
	}
	return out, false
}

func collectDelivers(idx *runIndex, spec EventSpec) ([]Event, bool) {
	var out []Event
	for i := range idx.enters {
		r := &idx.enters[i]
		if r.FunctionName != spec.Function {
			continue
		}
		if spec.To != nil && r.NodeID != int64(*spec.To) {
			continue
		}
		if spec.From != nil {
			sender, ok := idx.dispatchSender[r.TraceID]
			// If no Dispatch row joins, we can't verify the sender; reject.
			if !ok || sender != int64(*spec.From) {
				continue
			}
		}
		out = append(out, Event{
			Step:     r.Step,
			IntraSeq: r.SeqNum,
			Table:    TableTrace,
			NodeID:   r.NodeID,
			TraceID:  r.TraceID,
		})
		if len(out) >= maxCandidates {
			return out, true
		}
	}
	return out, false
}
