# Anvil Orbital site

Static site with no build step, tracking or forms. Each page is plain HTML in its own folder, with shared styles in `assets/`. The Fleet Retirement Planner is `planner/index.html`.

The planner's model mirrors `tools/planner/planner.py` in the founders' private research repo. Simple model, not checked by a spacecraft engineer.

## Fleet snapshot for the simulator
`assets/data/gp-<date>.json` holds CelesTrak GP data (OMM JSON) for Starlink, OneWeb, Amazon Leo and Planet: only the SGP4 fields, name, NORAD id and fleet. Source, fetch time and counts per fleet are inside the file, along with how many Starlink satellites are shown ("1 in N"). Refresh by hand, at most once per CelesTrak update (every 2 hours), and follow https://celestrak.org/usage-policy.php:

    python3 -I tools/gp-snapshot.py
