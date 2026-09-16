package dagorder

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

type EventKind int

const (
	KindUnknown EventKind = iota
	KindWrite
	KindRead
	KindRmw
	KindCrash
	KindRecover
	KindAllowTimer
	KindPartition
	KindHeal
	KindDeliver
)

// ResolvedPlanFile is the file run-plan writes into its output directory: the
// plan with every node path replaced by its global node index.
const ResolvedPlanFile = "plan_resolved.json"

// NoNode is the Target of a client operation that has no destination node.
// The invocation of such an operation carries a unit value where a node would
// be, and parseInvocationPayload reads that as NoNode, so the two match.
const NoNode = -1

func (k EventKind) String() string {
	switch k {
	case KindWrite:
		return "write"
	case KindRead:
		return "read"
	case KindRmw:
		return "rmw"
	case KindCrash:
		return "crash"
	case KindRecover:
		return "recover"
	case KindAllowTimer:
		return "allow_timer"
	case KindPartition:
		return "partition"
	case KindHeal:
		return "heal"
	case KindDeliver:
		return "deliver"
	default:
		return "unknown"
	}
}

// Matchable reports whether events of this kind can be located in
// non-plan-mode trace/execution output. Kind alone decides it: a label of a
// matchable kind with no candidates in a run stays required and fails every
// chain that runs through it. A timer admission matches a timer firing on the
// target node with the same label, so it is matchable, but a corpus written
// before timer firings were recorded holds no such row anywhere and the
// caller marks those labels unobservable for that corpus.
func (k EventKind) Matchable() bool {
	switch k {
	case KindWrite, KindRead, KindRmw, KindCrash, KindRecover, KindDeliver, KindAllowTimer:
		return true
	default:
		return false
	}
}

// EventSpec is a flat union over the event forms of a resolved plan. Every
// node is a global node index.
type EventSpec struct {
	Kind       EventKind
	Target     int    // Write/Read/Rmw (NoNode without a destination), Crash/Recover/AllowTimer
	Key        string // Write/Read/Rmw
	TimerLabel string // AllowTimer; empty matches any timer on the node
	Function   string // Deliver
	From       *int   // Deliver (optional)
	To         *int   // Deliver (optional)
}

// PlanConfig is the subset of a resolved plan this metric needs.
// Extra keys in the JSON are ignored.
type PlanConfig struct {
	// NodeCount is the number of deployed nodes; every node an event names
	// is below it.
	NodeCount    int
	Events       map[string]EventSpec
	Dependencies [][2]string
}

// LoadPlanConfig reads and decodes a resolved plan. path names the resolved
// plan file, or a run-plan output directory holding it.
func LoadPlanConfig(path string) (*PlanConfig, error) {
	if info, err := os.Stat(path); err == nil && info.IsDir() {
		path = filepath.Join(path, ResolvedPlanFile)
	}
	bytes, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read resolved plan %s: %w", path, err)
	}
	return ParsePlanConfig(bytes)
}

// ParsePlanConfig decodes the contents of a resolved plan.
func ParsePlanConfig(bytes []byte) (*PlanConfig, error) {
	var raw struct {
		NodeCount    *int                       `json:"node_count"`
		Events       map[string]json.RawMessage `json:"events"`
		Dependencies [][2]string                `json:"dependencies"`
	}
	if err := json.Unmarshal(bytes, &raw); err != nil {
		return nil, fmt.Errorf("decode resolved plan: %w", err)
	}
	// A plan config that has not been through run-plan names nodes by path
	// and has no node count; its events cannot be matched against indices.
	if raw.NodeCount == nil {
		return nil, fmt.Errorf("resolved plan has no node_count; pass the %s that run-plan writes, not the plan config", ResolvedPlanFile)
	}
	if *raw.NodeCount < 1 {
		return nil, fmt.Errorf("resolved plan node_count must be positive, got %d", *raw.NodeCount)
	}

	cfg := &PlanConfig{
		NodeCount:    *raw.NodeCount,
		Events:       make(map[string]EventSpec, len(raw.Events)),
		Dependencies: raw.Dependencies,
	}

	for id, msg := range raw.Events {
		spec, err := decodeEventSpec(msg, cfg.NodeCount)
		if err != nil {
			return nil, fmt.Errorf("event %q: %w", id, err)
		}
		cfg.Events[id] = spec
	}

	for _, dep := range cfg.Dependencies {
		if _, ok := cfg.Events[dep[0]]; !ok {
			return nil, fmt.Errorf("dependency references unknown event %q", dep[0])
		}
		if _, ok := cfg.Events[dep[1]]; !ok {
			return nil, fmt.Errorf("dependency references unknown event %q", dep[1])
		}
	}

	return cfg, nil
}

// decodeNode reads a global node index and checks it names a deployed node.
func decodeNode(raw json.RawMessage, nodeCount int, what string) (int, error) {
	var n int
	if err := json.Unmarshal(raw, &n); err != nil {
		return 0, fmt.Errorf("%s: expected a resolved node index, got %s", what, string(raw))
	}
	if n < 0 || n >= nodeCount {
		return 0, fmt.Errorf("%s: node %d is outside the %d deployed nodes", what, n, nodeCount)
	}
	return n, nil
}

// decodeNodes reads a list of global node indices.
func decodeNodes(raw json.RawMessage, nodeCount int, what string) ([]int, error) {
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, fmt.Errorf("%s: expected a list of resolved node indices, got %s", what, string(raw))
	}
	out := make([]int, 0, len(items))
	for i, item := range items {
		n, err := decodeNode(item, nodeCount, fmt.Sprintf("%s[%d]", what, i))
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, nil
}

// decodePosition reads a position in a group of the given size.
func decodePosition(raw json.RawMessage, size int, what string) error {
	var p int
	if err := json.Unmarshal(raw, &p); err != nil {
		return fmt.Errorf("%s: expected a position in the group, got %s", what, string(raw))
	}
	if p < 0 || p >= size {
		return fmt.Errorf("%s: position %d is outside the group of %d", what, p, size)
	}
	return nil
}

// decodeEventSpec reads one event of a resolved plan: a single-key object
// naming the variant, or the bare string "heal".
func decodeEventSpec(raw json.RawMessage, nodeCount int) (EventSpec, error) {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if s == "heal" {
			return EventSpec{Kind: KindHeal}, nil
		}
		return EventSpec{}, fmt.Errorf("unknown bare event variant %q", s)
	}

	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return EventSpec{}, fmt.Errorf("event spec must be object or bare string: %w", err)
	}
	if len(obj) != 1 {
		return EventSpec{}, fmt.Errorf("event spec must have exactly one variant key, got %d", len(obj))
	}

	for key, payload := range obj {
		switch key {
		case "write", "read", "rmw":
			var op struct {
				Dest json.RawMessage `json:"dest"`
				Key  *string         `json:"key"`
			}
			if err := json.Unmarshal(payload, &op); err != nil {
				return EventSpec{}, fmt.Errorf("%s: expected {dest, key}: %w", key, err)
			}
			if op.Key == nil {
				return EventSpec{}, fmt.Errorf("%s: missing key", key)
			}
			target := NoNode
			if len(op.Dest) > 0 && string(op.Dest) != "null" {
				n, err := decodeNode(op.Dest, nodeCount, key+" dest")
				if err != nil {
					return EventSpec{}, err
				}
				target = n
			}
			var kind EventKind
			switch key {
			case "write":
				kind = KindWrite
			case "read":
				kind = KindRead
			case "rmw":
				kind = KindRmw
			}
			return EventSpec{Kind: kind, Target: target, Key: *op.Key}, nil

		case "crash", "recover":
			target, err := decodeNode(payload, nodeCount, key)
			if err != nil {
				return EventSpec{}, err
			}
			kind := KindCrash
			if key == "recover" {
				kind = KindRecover
			}
			return EventSpec{Kind: kind, Target: target}, nil

		case "allow_timer":
			var t struct {
				Node  json.RawMessage `json:"node"`
				Label string          `json:"label"`
			}
			if err := json.Unmarshal(payload, &t); err != nil {
				return EventSpec{}, fmt.Errorf("allow_timer: expected {node, label}: %w", err)
			}
			if len(t.Node) == 0 {
				return EventSpec{}, fmt.Errorf("allow_timer: missing node")
			}
			target, err := decodeNode(t.Node, nodeCount, "allow_timer node")
			if err != nil {
				return EventSpec{}, err
			}
			return EventSpec{Kind: KindAllowTimer, Target: target, TimerLabel: t.Label}, nil

		case "partition":
			// Partitions cannot be matched in non-plan-mode runs, so the
			// fields are only validated so that a malformed plan fails loudly.
			if err := validatePartition(payload, nodeCount); err != nil {
				return EventSpec{}, err
			}
			return EventSpec{Kind: KindPartition}, nil

		case "heal":
			return EventSpec{Kind: KindHeal}, nil

		case "deliver":
			var d struct {
				Function string          `json:"function"`
				From     json.RawMessage `json:"from"`
				To       json.RawMessage `json:"to"`
			}
			if err := json.Unmarshal(payload, &d); err != nil {
				return EventSpec{}, fmt.Errorf("deliver: %w", err)
			}
			spec := EventSpec{Kind: KindDeliver, Function: d.Function}
			if len(d.From) > 0 && string(d.From) != "null" {
				n, err := decodeNode(d.From, nodeCount, "deliver from")
				if err != nil {
					return EventSpec{}, err
				}
				spec.From = &n
			}
			if len(d.To) > 0 && string(d.To) != "null" {
				n, err := decodeNode(d.To, nodeCount, "deliver to")
				if err != nil {
					return EventSpec{}, err
				}
				spec.To = &n
			}
			return spec, nil

		default:
			return EventSpec{}, fmt.Errorf("unknown event variant %q", key)
		}
	}

	return EventSpec{}, fmt.Errorf("unreachable")
}

// validatePartition checks a partition's fields against its type: the group
// members are node indices, and side_a and bridge are positions in the group.
func validatePartition(payload json.RawMessage, nodeCount int) error {
	var p struct {
		Type   string            `json:"type"`
		Group  json.RawMessage   `json:"group"`
		SideA  []json.RawMessage `json:"side_a"`
		Bridge json.RawMessage   `json:"bridge"`
		Node   json.RawMessage   `json:"node"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fmt.Errorf("partition: %w", err)
	}
	group := func() ([]int, error) {
		if len(p.Group) == 0 {
			return nil, fmt.Errorf("partition %s: missing group", p.Type)
		}
		g, err := decodeNodes(p.Group, nodeCount, "partition "+p.Type+" group")
		if err != nil {
			return nil, err
		}
		if len(g) == 0 {
			return nil, fmt.Errorf("partition %s: empty group", p.Type)
		}
		return g, nil
	}
	switch p.Type {
	case "isolate_one":
		if len(p.Node) == 0 {
			return fmt.Errorf("partition isolate_one: missing node")
		}
		_, err := decodeNode(p.Node, nodeCount, "partition isolate_one node")
		return err
	case "halves":
		g, err := group()
		if err != nil {
			return err
		}
		for i, pos := range p.SideA {
			if err := decodePosition(pos, len(g), fmt.Sprintf("partition halves side_a[%d]", i)); err != nil {
				return err
			}
		}
		return nil
	case "majorities_ring":
		_, err := group()
		return err
	case "bridge":
		g, err := group()
		if err != nil {
			return err
		}
		if len(p.Bridge) == 0 {
			return fmt.Errorf("partition bridge: missing bridge")
		}
		return decodePosition(p.Bridge, len(g), "partition bridge")
	default:
		return fmt.Errorf("partition: unknown type %q", p.Type)
	}
}
