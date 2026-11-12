#!/bin/bash
# Runs the page-mode probe matrix; each run bounded by timeout -k and the probe's own watchdog.
S=/tmp/claude-1000/-home-berryderi-projects-anvilorbital-team-worktrees-dev-2/96ae1cb6-7eae-40f1-967d-eb71685b9160/scratchpad
W=/home/berryderi/projects/anvilorbital-worktrees/dev-2-page-scene
P=/planner/,/findings/,/about/,/privacy/,/404.html
OUT=$S/${1:-shots-v4}; rm -rf "$OUT"; mkdir -p "$OUT"
export TMPDIR=/tmp/claude-1000
run() { echo "== $*"; timeout -k 10 170 node $S/page-probe.mjs $W $OUT "$@" 2>&1 | sed -E 's/"bgImage":"[^"]*"/"bgImage":"svg"/' | cut -c1-700; echo "exit ${PIPESTATUS[0]}"; }
run --width 1280 --pages $P
run --width 390 --pages $P
run --width 390 --reduced --pages $P
run --width 1280 --nojs --pages $P
run --width 390 --nojs --pages $P
run --width 390 --savedata --pages /planner/,/findings/
run --width 1280 --savedata --pages /planner/,/findings/
run --width 1280 --nostars --hidetext --pages /planner/,/findings/
run --width 390 --nostars --hidetext --pages /planner/,/findings/
echo MATRIX-DONE
