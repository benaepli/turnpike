package dagorder

import (
	"encoding/json"
	"fmt"
	"os"
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
// non-plan-mode trace/execution output.
func (k EventKind) Matchable() bool {
	switch k {
	case KindWrite, KindRead, KindRmw, KindCrash, KindRecover, KindDeliver:
		return true
	default:
		return false
	}
}

// EventSpec is a flat union mirroring the Rust EventSpec enum in
// spur/spur-core/src/simulator/plan_config.rs.
type EventSpec struct {
	Kind       EventKind
	Target     int    // Write/Read/Rmw/Crash/Recover/AllowTimer
	Key        string // Write/Read/Rmw
	TimerLabel string // AllowTimer
	Function   string // Deliver
	From       *int   // Deliver (optional)
	To         *int   // Deliver (optional)
}

// PlanConfig is the subset of PlanFileConfig this metric needs.
// Extra keys in the JSON are ignored.
type PlanConfig struct {
	NumServers   int
	Events       map[string]EventSpec
	Dependencies [][2]string
}

// LoadPlanConfig reads and decodes a plan_config.json file.
func LoadPlanConfig(path string) (*PlanConfig, error) {
	bytes, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read plan config %s: %w", path, err)
	}

	var raw struct {
		NumServers   int                        `json:"num_servers"`
		Events       map[string]json.RawMessage `json:"events"`
		Dependencies [][2]string                `json:"dependencies"`
	}
	if err := json.Unmarshal(bytes, &raw); err != nil {
		return nil, fmt.Errorf("decode plan config: %w", err)
	}

	cfg := &PlanConfig{
		NumServers:   raw.NumServers,
		Events:       make(map[string]EventSpec, len(raw.Events)),
		Dependencies: raw.Dependencies,
	}

	for id, msg := range raw.Events {
		spec, err := decodeEventSpec(msg)
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

// decodeEventSpec handles Rust's snake_case untagged-style enum serialization,
// where each variant is a single-key object or a bare string.
func decodeEventSpec(raw json.RawMessage) (EventSpec, error) {
	// Bare string variants (currently only "heal").
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
			var tup [2]json.RawMessage
			if err := json.Unmarshal(payload, &tup); err != nil {
				return EventSpec{}, fmt.Errorf("%s: expected [target, key]: %w", key, err)
			}
			var target int
			var k string
			if err := json.Unmarshal(tup[0], &target); err != nil {
				return EventSpec{}, fmt.Errorf("%s target: %w", key, err)
			}
			if err := json.Unmarshal(tup[1], &k); err != nil {
				return EventSpec{}, fmt.Errorf("%s key: %w", key, err)
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
			return EventSpec{Kind: kind, Target: target, Key: k}, nil

		case "crash", "recover":
			var target int
			if err := json.Unmarshal(payload, &target); err != nil {
				return EventSpec{}, fmt.Errorf("%s target: %w", key, err)
			}
			kind := KindCrash
			if key == "recover" {
				kind = KindRecover
			}
			return EventSpec{Kind: kind, Target: target}, nil

		case "allow_timer":
			var tup [2]json.RawMessage
			if err := json.Unmarshal(payload, &tup); err != nil {
				return EventSpec{}, fmt.Errorf("allow_timer: expected [target, label]: %w", err)
			}
			var target int
			var label string
			if err := json.Unmarshal(tup[0], &target); err != nil {
				return EventSpec{}, fmt.Errorf("allow_timer target: %w", err)
			}
			if err := json.Unmarshal(tup[1], &label); err != nil {
				return EventSpec{}, fmt.Errorf("allow_timer label: %w", err)
			}
			return EventSpec{Kind: KindAllowTimer, Target: target, TimerLabel: label}, nil

		case "partition":
			// Partitions are structurally unmatchable in non-plan-mode runs, so
			// the spec contents don't drive matching - but we still validate
			// the payload shape so a malformed config errors loudly. Mirrors
			// PartitionSpec in spur/spur-core/src/simulator/plan_config.rs:36-43,
			// an externally tagged enum with `tag = "type"`.
			var pinfo struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(payload, &pinfo); err != nil {
				return EventSpec{}, fmt.Errorf("partition: %w", err)
			}
			switch pinfo.Type {
			case "isolate_one", "halves", "majorities_ring", "bridge":
				// known variant; payload not retained (unused downstream)
			default:
				return EventSpec{}, fmt.Errorf("partition: unknown type %q", pinfo.Type)
			}
			return EventSpec{Kind: KindPartition}, nil

		case "heal":
			return EventSpec{Kind: KindHeal}, nil

		case "deliver":
			var d struct {
				Function string `json:"function"`
				From     *int   `json:"from"`
				To       *int   `json:"to"`
			}
			if err := json.Unmarshal(payload, &d); err != nil {
				return EventSpec{}, fmt.Errorf("deliver: %w", err)
			}
			return EventSpec{Kind: KindDeliver, Function: d.Function, From: d.From, To: d.To}, nil

		default:
			return EventSpec{}, fmt.Errorf("unknown event variant %q", key)
		}
	}

	return EventSpec{}, fmt.Errorf("unreachable")
}
