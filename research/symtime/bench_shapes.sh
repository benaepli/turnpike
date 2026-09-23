#!/usr/bin/env bash
# The exact simplex across spec shapes: answers against Z3, cost against the
# run, and one-thread runs a second beside Z3 and Yices.
#   bench_shapes.sh [RUNS] [CAP_SECONDS]
# Run from the repository root.
runs=${1:-1000}
cap=${2:-120}
bin=research/symtime/target/release/symtime
out=research/symtime/out
printf "%-12s %-10s | %-28s | %-16s | %-34s | %9s %9s %9s\n" dataset level "against Z3" "left to concrete" "simplex cost over the run" simplex z3 yices
for name in ${DATASETS:-clean recv_anchor cached_flag long forms}; do
    for level in concrete durations; do
        result=$(research/symtime/capped.sh -t "$cap" "$bin" linear --backend simplex --tc "$out/${name}_tc" --walls "$out/${name}_plain.walls" --limit "$runs" --level "$level" --forget true 2>&1)
        if [ $? -eq 124 ]; then
            printf "%-12s %-10s | over the %s s cap\n" "$name" "$level" "$cap"
            continue
        fi
        agree=$(echo "$result" | grep -o 'differ from Z3 [0-9]* ([0-9]* comparisons)')
        left=$(echo "$result" | grep -o 'without an answer [0-9]*' | grep -o '[0-9]*$')
        asked=$(echo "$result" | grep -o '^comparisons [0-9]*' | grep -o '[0-9]*$')
        cost=$(echo "$result" | grep 'time over' | sed 's/time over the run.s own wall time: //')
        rates=""
        for backend in simplex z3 yices; do
            r=$(research/symtime/capped.sh -t 60 "$bin" linear-threads --backend "$backend" --tc "$out/${name}_tc" --limit "$runs" --level "$level" --threads 1 2>&1 | grep -o '[0-9]* runs/s' | grep -o '[0-9]*')
            rates="$rates $(printf '%9s' "${r:-over}")"
        done
        printf "%-12s %-10s | %-28s | %-16s | %-34s |%s\n" "$name" "$level" "$agree" "$left of $asked" "$cost" "$rates"
    done
done
