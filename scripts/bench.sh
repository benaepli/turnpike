#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SPEC="$ROOT/bin/spur/VR.spur"
BINARY="$ROOT/spur/target/release/spur"
MANIFEST="$ROOT/spur/Cargo.toml"

LEVEL="${1:-medium}"

# Count values in a range: values = ((max - min) / step) + 1
count_range() {
    local min=$1 max=$2 step=$3
    echo $(( ((max - min) / step) + 1 ))
}

# Generate a range JSON fragment: {"min": X, "max": X, "step": X}
range_json() {
    local min=$1 max=$2 step=$3
    printf '{"min": %d, "max": %d, "step": %d}' "$min" "$max" "$step"
}

case "$LEVEL" in
    small)
        # 3 × 1 × 1 × 2 × 1 = 6 configs × 16667 = ~100,002
        S_MIN=3;   S_MAX=7;   S_STEP=2    # [3,5,7] = 3
        W_MIN=5;   W_MAX=5;   W_STEP=1    # [5]     = 1
        R_MIN=3;   R_MAX=3;   R_STEP=1    # [3]     = 1
        CR_MIN=0;  CR_MAX=1;  CR_STEP=1   # [0,1]   = 2
        DD="0.3"                             # [0.3]   = 1
        RPC=16667
        MAX_ITER=500
        ;;
    medium)
        # 3 × 2 × 2 × 2 × 2 = 48 configs × 2084 = ~100,032
        S_MIN=3;   S_MAX=7;   S_STEP=2    # [3,5,7]   = 3
        W_MIN=5;   W_MAX=10;  W_STEP=5    # [5,10]    = 2
        R_MIN=3;   R_MAX=9;   R_STEP=6    # [3,9]     = 2
        CR_MIN=0;  CR_MAX=1;  CR_STEP=1   # [0,1]     = 2
        DD="0.0, 0.3"                       # [0.0,0.3] = 2
        RPC=2084
        MAX_ITER=1000
        ;;
    large)
        # 3 × 4 × 3 × 3 × 2 = 216 configs × 463 = ~100,008
        S_MIN=3;   S_MAX=7;   S_STEP=2    # [3,5,7]       = 3
        W_MIN=5;   W_MAX=20;  W_STEP=5    # [5,10,15,20]  = 4
        R_MIN=3;   R_MAX=15;  R_STEP=6    # [3,9,15]      = 3
        CR_MIN=0;  CR_MAX=2;  CR_STEP=1   # [0,1,2]       = 3
        DD="0.0, 0.3"                       # [0.0,0.3]     = 2
        RPC=463
        MAX_ITER=2000
        ;;
    *)
        echo "Usage: $0 [small|medium|large]"
        exit 1
        ;;
esac

S_N=$(count_range "$S_MIN" "$S_MAX" "$S_STEP")
W_N=$(count_range "$W_MIN" "$W_MAX" "$W_STEP")
R_N=$(count_range "$R_MIN" "$R_MAX" "$R_STEP")
CR_N=$(count_range "$CR_MIN" "$CR_MAX" "$CR_STEP")
DD_N=$(echo "$DD" | tr ',' '\n' | wc -l)
CONFIGS=$((S_N * W_N * R_N * CR_N * DD_N))
TOTAL=$((RPC * CONFIGS))

# Generate dependency_density JSON array
DD_JSON="["
first=true
for val in $(echo "$DD" | tr ',' ' '); do
    $first || DD_JSON+=", "
    first=false
    DD_JSON+="$val"
done
DD_JSON+="]"

# Generate config JSON
CONFIG=$(mktemp /tmp/spur-bench-config.XXXXXX.json)
trap 'rm -f "$CONFIG"' EXIT

cat > "$CONFIG" <<EOF
{
    "num_servers": $(range_json "$S_MIN" "$S_MAX" "$S_STEP"),
    "num_write_ops": $(range_json "$W_MIN" "$W_MAX" "$W_STEP"),
    "num_read_ops": $(range_json "$R_MIN" "$R_MAX" "$R_STEP"),
    "num_crashes": $(range_json "$CR_MIN" "$CR_MAX" "$CR_STEP"),
    "dependency_density": $DD_JSON,
    "num_runs_per_config": $RPC,
    "max_iterations": $MAX_ITER
}
EOF

OUTPUT_DIR="/tmp/spur-bench-$(date +%s)"

echo "=== Spur Simulator Benchmark ==="
echo "Level:    $LEVEL"
echo "Spec:     $SPEC"
echo "Configs:  $CONFIGS"
echo "Runs:     $TOTAL ($RPC × $CONFIGS configs)"
echo "-------------------------------"

# Build
printf "Building..."
BUILD_START=$SECONDS
cargo build --release --manifest-path "$MANIFEST" --bin spur 2>/dev/null
BUILD_ELAPSED=$(( SECONDS - BUILD_START ))
printf " done (%ds)\n" "$BUILD_ELAPSED"

# Run
printf "Running...\n"
RUN_START=$SECONDS
"$BINARY" explore --config "$CONFIG" -y --output-dir "$OUTPUT_DIR" "$SPEC"
RUN_ELAPSED=$(( SECONDS - RUN_START ))

RPS=$(awk "BEGIN { printf \"%.1f\", $TOTAL / $RUN_ELAPSED }")

echo "-------------------------------"
echo "Wall:     ${RUN_ELAPSED}s"
echo "Runs/sec: $RPS"

rm -rf "$OUTPUT_DIR"
