# WQ-030 page mode: evidence

Code branch: `feat/page-scene`. Measured at c8ff164; 37e2c4f changes one comment only.

## Files
- `shots/`: viewport screenshots of planner, findings, about, privacy and 404 at 1280, 390, 390 with reduced motion, and JS off at 1280 and 390. Save-data shots cover planner and findings. The `-nostars-canvas` shots show the canvas alone (page text hidden, stars removed from the served copy only), for the luminance measure.
- `page-probe.mjs`: the probe (Node 22+, Chrome, no deps). `matrix.sh` runs every case, each bounded by `timeout -k` and the probe's own watchdog.
- `run-matrix.txt`: one JSON row per page per case.
- `home-probe.txt`: `tools/scene-probe.mjs --page /` at 1280 and 390, on this branch and on remake 1c1f9ee.
- `check-planner.txt`: the validator's check-planner output at this branch (byte-identical to remake 1c1f9ee).

## How to re-run
```
TMPDIR=/tmp/claude-1000 timeout -k 10 170 node page-probe.mjs <site root> <out dir> --width 1280 --pages /planner/,/findings/
```
Flags: `--width N`, `--reduced`, `--nojs`, `--savedata`, `--nostars --hidetext` (adds the `lum` stats over the lower right 45% box).

## What a row checks
- idle: rAF callbacks and WebGL draws over 3 s after the scene settles must be 0, and again for 2 s after a resize (the resize itself redraws once).
- errors: window errors, rejections and console.error from page start.
- overflow: no horizontal scroll. `nonLocal`: requests that left the local server must be 0.
- `lum`: WCAG relative luminance of every pixel in the corner box; `over0311` counts pixels brighter than 0.0311, the most a background can be for `--ink-3` text to keep 4.5:1.
