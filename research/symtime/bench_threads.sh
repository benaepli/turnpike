#!/usr/bin/env bash
# Runs a second each backend reaches at 1 to 30 worker threads, one solver
# state per thread.
#   bench_threads.sh NAME LEVEL [RUNS] [CAP_SECONDS] [BACKENDS...]
# Yices comes from the binary built against a thread-safe library. A cell
# that does not finish inside the cap is reported as over it, and the larger
# thread counts are still tried. Run from the repository root.
name=$1
level=$2
runs=${3:-2000}
cap=${4:-60}
shift 4 2>/dev/null
backends=${*:-simplex z3 yices}
out=research/symtime/out
echo "## $name / $level: $runs runs, ${cap} s cap per cell"
for backend in $backends; do
    bin=research/symtime/target/release/symtime
    [ "$backend" = yices ] && bin=$out/target-ts/release/symtime
    for threads in 1 2 4 8 16 30; do
        timeout "$cap" "$bin" linear-threads --backend "$backend" --tc "$out/${name}_tc" \
            --limit "$runs" --level "$level" --threads "$threads" 2>&1 | tail -1
        [ "${PIPESTATUS[0]}" -eq 124 ] && printf "%-13s threads %2s: over the %s s cap\n" "$backend" "$threads" "$cap"
    done
done
