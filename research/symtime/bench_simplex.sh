#!/usr/bin/env bash
# The simplex on the two fixed samples: answers against Z3, cost against the
# run, and runs a second on 1 and 30 threads. Run from the repository root.
#   bench_simplex.sh LABEL
bin=research/symtime/target/release/symtime
out=research/symtime/out
echo "=== $1"
for cell in "clean 2000" "cached_flag 500"; do
    set -- $cell
    result=$(timeout 120 "$bin" linear --backend simplex --tc "$out/${1}_tc" --walls "$out/${1}_plain.walls" --limit "$2" --level durations --forget true 2>&1)
    if [ $? -eq 124 ]; then
        echo "$1: over 120 s"
        continue
    fi
    echo "$1: $(echo "$result" | grep -o 'differ from Z3 [0-9]* ([0-9]* comparisons)') | $(echo "$result" | grep -o 'runs widened [0-9]*') | $(echo "$result" | grep 'time over' | sed 's/time over the run.s own wall time: //') | $(echo "$result" | grep 'pivots per run' | sed 's/pivots per run: /pivots /') | $(echo "$result" | grep 'peak tableau' | sed 's/peak tableau rows: /rows /')"
    for threads in 1 30; do
        timeout 60 "$bin" linear-threads --backend simplex --tc "$out/${1}_tc" --limit "$2" --level durations --threads $threads 2>&1 | tail -1 | sed "s/^simplex */  /"
    done
done
