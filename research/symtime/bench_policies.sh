#!/usr/bin/env bash
# The three policies on every dataset, durations open, one thread: exact,
# exact with draw-then-verify, and float with draw-then-verify and a cap of
# five times the run. One process at a time, each under capped.sh.
#   bench_policies.sh BIN OUTDIR [DATASETS...]
# Run from the repository root; policy_table.py OUTDIR prints the table.
bin=$1
outdir=$2
shift 2
here=research/symtime
out=$here/out
mkdir -p "$outdir"
for name in ${@:-clean recv_anchor cached_flag long forms idioms webs chains crossclock}; do
    case $name in
        clean | recv_anchor | cached_flag) runs=2000 ;;
        long | forms | idioms) runs=1000 ;;
        *) runs=400 ;;
    esac
    for policy in exact draw float_draw_cap5; do
        case $policy in
            exact) settings=() backend=simplex ;;
            draw) settings=(SIMPLEX_DRAW=0.5) backend=simplex ;;
            float_draw_cap5) settings=(SIMPLEX_DRAW=0.5 SIMPLEX_CAP=5) backend=float ;;
        esac
        env PER_RUN=1 "${settings[@]}" $here/capped.sh -m 6 -t 600 "$bin" linear-threads --backend $backend \
            --tc "$out/${name}_tc" --walls "$out/${name}_plain.walls" --limit $runs --level durations --threads 1 \
            >"$outdir/${name}__${policy}.out" 2>"$outdir/${name}__${policy}.txt"
        echo "$name $policy exit $?: $(cat "$outdir/${name}__${policy}.out")"
    done
done
