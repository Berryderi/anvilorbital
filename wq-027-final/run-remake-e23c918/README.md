# Final check: remake e23c918 vs main 10c2600 (2026-11-13)

- `report.txt`: final-check kit, 235 OK, 0 FAIL, 20 INFO.
- `shots/`: every page at 1280 and 390, plus 390 with reduced motion and 390 with JS off. Pages whose height follows the viewport were shot one screen at a time and stitched top to bottom (`scripts/stitch.sh`). The fixed nav appears once per screen.
- `measures/measures.log`:
  - `page-probe.mjs --nostars --hidetext` at 1920×1080, 1280 and 390 (Earth and halo luminance in the lower-right box on tool pages). The `/` row is home's live scene, so the page-mode idle rule doesn't apply to it.
  - `tools/contrast-probe.mjs` on simulator steps 01–05 at 390 and 1280, playing and reduced, 4 frames each.
- `recording/`: headless Chrome 154 on the laptop's Intel Iris Xe GPU through Vulkan (renderer string in `stats.json`), with a CDP screencast.
  - `home-scroll-1280.mp4` and `home-scroll-390.mp4`: home loads, waits 4 s, then scrolls to the bottom with real wheel events (100 px every 60 ms).
  - `arrive-*.mp4` and `*-sheet.jpg`: the first 6 s of a tool page load.
  - `stars-*.txt`: star pixels per frame in a text-free corner.
  - `planner-stars-before-after.jpg`: that corner just before and just after the scene arrives, at 2×.
- `scripts/`: the scripts that made all of this.
