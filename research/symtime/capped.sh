#!/usr/bin/env bash
# Runs a command under a memory cap and a time limit, so that a solver that
# never stops ends itself and not the machine.
#   capped.sh [-m GIGABYTES] [-t SECONDS] COMMAND...
# One process at a time: every symtime process loads its whole dataset.
gigabytes=6
seconds=600
while getopts "m:t:" flag; do
    case "$flag" in
        m) gigabytes=$OPTARG ;;
        t) seconds=$OPTARG ;;
        *) exit 2 ;;
    esac
done
shift $((OPTIND - 1))
ulimit -v $((gigabytes * 1024 * 1024))
exec timeout "$seconds" "$@"
