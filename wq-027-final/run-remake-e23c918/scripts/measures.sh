#!/bin/bash
# WQ-027 go-live measures at remake e23c918: 1920 luminance (WQ-030 margin) and ink-3 contrast on simulator steps 01-05 (WQ-035 gate).
OLD=<scratch>
S=<scratch>
SITE=$OLD/fc-cand; OUT=$S/measures; rm -rf "$OUT"; mkdir -p "$OUT/lum" "$OUT/contrast"
export TMPDIR=/tmp/claude-1000/d3; mkdir -p $TMPDIR
run() { echo "== $*"; timeout -k 15 240 "$@"; echo "exit $?"; }
{
run node $OLD/page-probe.mjs $SITE $OUT/lum --width 1920 --height 1080 --nostars --hidetext
run node $OLD/page-probe.mjs $SITE $OUT/lum --width 1280 --nostars --hidetext
run node $OLD/page-probe.mjs $SITE $OUT/lum --width 390 --nostars --hidetext
for w in 390 1280; do
  run node $SITE/tools/contrast-probe.mjs $SITE --width $w --frames 4 --shots $OUT/contrast/$w
  run node $SITE/tools/contrast-probe.mjs $SITE --width $w --frames 4 --reduced --shots $OUT/contrast/$w-reduced
done
} > $OUT/measures.log 2>&1
pkill -f "user-data-dir=/tmp/claude-1000/d[3]/"; echo MEASURES-DONE
