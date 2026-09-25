#!/usr/bin/env bash
# One pass over every solver backend on one spec and level.
#   bench_solvers.sh NAME LEVEL [RUNS] [CAP_SECONDS]
# A backend that does not finish the sample inside the cap is reported as
# over the cap and gets no numbers. Run from the repository root.
name=$1
level=$2
runs=${3:-500}
cap=${4:-60}
out=research/symtime/out
main=research/symtime/target/release/symtime
echo "## $name / $level: $runs runs, ${cap} s cap per backend"
for backend in simplex z3 yices; do
    bin=$main
    result=$(timeout "$cap" "$bin" linear --backend "$backend" --tc "$out/${name}_tc" \
        --walls "$out/${name}_plain.walls" --limit "$runs" --level "$level" --forget true 2>&1)
    code=$?
    if [ $code -eq 124 ]; then
        printf "%-13s over the %s s cap\n" "$backend" "$cap"
    elif [ $code -ne 0 ]; then
        printf "%-13s failed: %s\n" "$backend" "$(echo "$result" | tail -1)"
    else
        printf "%-13s %s | %s | %s\n" "$backend" \
            "$(echo "$result" | grep -o 'differ from Z3 [0-9]* ([0-9]* comparisons)')" \
            "$(echo "$result" | grep -o 'rejected [0-9]*')" \
            "$(echo "$result" | grep 'time over' | sed 's/time over the run.s own wall time: //')"
    fi
done
