#!/usr/bin/env bash
# Records one spec's time constraints, measures the same runs without the
# recorder, and checks and classifies the record.
#
#   run.sh NAME SPEC CONFIG [RUNS_PER_CONFIG] [SEED]
#
# Run from the repository root. Expects out/spur-recorder (built with
# --features time-constraints) and out/spur-plain beside this script.
set -euo pipefail

name=$1
spec=$2
config=$3
per_config=${4:-1250}
seed=${5:-1000}

here=research/symtime
out=$here/out
analyzer=$here/target/release/symtime
common=(-e standard --config "$config" --set "session_seed=$seed" --set "num_runs_per_config=$per_config" -y)

rm -rf "$out/${name}_tc" "$out/${name}_emit"
code=0
SPUR_TIME_CONSTRAINTS_DIR=$PWD/$out/${name}_tc "$out/spur-recorder" explore "${common[@]}" \
    --output-dir "$out/$name" "$spec" >"$out/$name.explore.log" 2>&1 || code=$?
echo "recorder explore exit $code"

code=0
RAYON_NUM_THREADS=1 "$out/spur-plain" explore "${common[@]}" --set record_replay=false \
    --output-dir "$out/${name}_plain" "$spec" >"$out/$name.plain.log" 2>&1 || code=$?
echo "plain explore exit $code"

for d in "$out/$name" "$out/${name}_plain"; do
    ./traceanalyzer/main -input "$d" -runs 2>/dev/null |
        python3 -c 'import json,sys; [print(r["run_id"], r["wall_us"], r["steps_used"]) for r in json.load(sys.stdin)]' >"$d.walls"
done
python3 - "$out/$name.walls" "$out/${name}_plain.walls" <<'EOF'
import sys
a = {l.split()[0]: l.split()[2] for l in open(sys.argv[1])}
b = {l.split()[0]: l.split()[2] for l in open(sys.argv[2])}
same = sum(1 for k in a if b.get(k) == a[k])
print(f"runs with equal step counts in both sessions: {same} of {len(a)}")
walls = sorted(float(l.split()[1]) for l in open(sys.argv[2]))
print(f"plain wall_us per run: median {walls[len(walls)//2]:.0f} p99 {walls[int(len(walls)*0.99)]:.0f}")
EOF

{
    "$analyzer" check --tc "$out/${name}_tc"
    echo
    "$analyzer" classify --tc "$out/${name}_tc"
} | tee "$out/$name.report.txt"

