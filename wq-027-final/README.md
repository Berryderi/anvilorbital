# WQ-027 final-PR check kit (remake -> main)

One script, `final-check.mjs`, for the final remake-to-main PR. No dependencies: Node 22+ and Google Chrome.

```
git -C ~/projects/anvilorbital worktree add --detach /tmp/claude-1000/fc-cand origin/remake
git -C ~/projects/anvilorbital worktree add --detach /tmp/claude-1000/fc-main origin/main
TMPDIR=/tmp/claude-1000 node final-check.mjs /tmp/claude-1000/fc-cand /tmp/claude-1000/fc-main /tmp/claude-1000/fc-out
```

Keep `TMPDIR` short: Chrome dies on long profile paths. `PROBE_DEBUG=1` shows Chrome's stderr.
A run takes about 5 minutes. It writes `report.txt` (one OK/FAIL line per check) and `shots/`.

## What it checks
1. Static link crawl over every page in the candidate (tools/ excluded) and every `url()` in its CSS: each
   reference resolves to a file, each `#fragment` exists as an id in the target, nothing loads from another host.
2. Old URLs: every page on main answers on the candidate, with and without the trailing slash (local server
   answers like GitHub Pages: 301 to the slash, 404.html on a miss); redirect pages land on their target, with JS
   on and off; a deep miss shows a styled 404; every planner deep link main knows (`BY_LINK_ID`) selects the same
   preset; `/planner/#starcloud` selects Starcloud.
3. Every page at 1280 and 390 with motion on, after a scroll-through: 0 JS errors from page start, no horizontal
   overflow, a `<main>` landmark, everything revealed. Full-page screenshot `<page>-<width>.png`.
4. Reduced motion at 1280 and 390: everything visible at load without scrolling, no running infinite
   animations, no smooth scroll. Screenshot `<page>-390-reduced.png`.
5. No-JS read-through at 1280 and 390: no text faded or transformed away; text hidden by `display:none` is
   listed as INFO for a human to judge. Screenshot `<page>-390-nojs.png`.
6. Every candidate load made only local requests; none to fonts.googleapis.com or fonts.gstatic.com.

Not in the script: the real-browser scroll recording, made by hand for the final PR.

## Known limits
- Headless Chrome's WebGL is software, so scene smoothness is not measured here.
- Full-page captures draw the fixed nav mid-image; that is a capture artifact.
- An empty no-JS tool (form with blank answers) passes check 5; look at `*-390-nojs.png`.
