"""Build assets/data/gp-<date>.json, the fleet snapshot the simulator propagates with SGP4.

Refresh (one line, run from the repo root, at most once per CelesTrak update, i.e. 2 hours):
    python3 -I tools/gp-snapshot.py

Rebuild from files already fetched (no network), e.g. to re-run the trimming:
    python3 -I tools/gp-snapshot.py --from DIR   # DIR/<group>.json plus DIR/fetchlog.txt

CelesTrak usage policy: https://celestrak.org/usage-policy.php
One request per group, never in a loop; stop at the first non-200 answer or redirect and tell a human.
"""
import argparse, json, logging, os, sys, urllib.error, urllib.request
from datetime import datetime, timezone

log = logging.getLogger("gp-snapshot")

BASE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=json"
POLICY_URL = "https://celestrak.org/usage-policy.php"
# Site fleet id (matches planner preset ids) -> CelesTrak group name.
GROUPS = {"starlink": "starlink", "oneweb": "oneweb", "amazon-leo": "kuiper", "planet": "planet"}
THINNED_GROUP = "starlink"          # the only group the brief allows us to thin
MAX_BYTES = 2_000_000               # brief: keep the file under about 2 MB
TIMEOUT_S = 60
USER_AGENT = "anvilorbital-gp-snapshot (one fetch per group per update)"
# OMM fields SGP4 needs, plus name and NORAD id. Names kept as OMM so satellite.js can read them.
KEEP = ["OBJECT_NAME", "NORAD_CAT_ID", "EPOCH", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION",
        "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "BSTAR", "MEAN_MOTION_DOT",
        "MEAN_MOTION_DDOT"]


def fetch(group):
    url = BASE_URL.format(group=group)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    fetched = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            if resp.status != 200 or resp.geturl() != url:
                raise SystemExit(f"STOP: {group} answered {resp.status} at {resp.geturl()}; tell a human")
            return json.load(resp), fetched
    except urllib.error.URLError as e:
        raise SystemExit(f"STOP: {group} failed ({e}); do not retry, tell a human")


def load_saved(src, group):
    times = {}
    with open(os.path.join(src, "fetchlog.txt"), encoding="utf-8") as f:
        for line in f:
            parts = line.split()
            if len(parts) >= 3 and parts[2] == "200":
                times[parts[0]] = parts[1]
    if group not in times:
        raise SystemExit(f"STOP: no HTTP 200 fetch logged for {group} in {src}")
    with open(os.path.join(src, f"{group}.json"), encoding="utf-8") as f:
        return json.load(f), times[group]


def build(raw, every_nth):
    meta, sats = {}, []
    for fleet, group in GROUPS.items():
        recs, fetched = raw[fleet]
        recs = sorted(recs, key=lambda r: r["NORAD_CAT_ID"])
        n = every_nth if fleet == THINNED_GROUP else 1
        kept = recs[::n]
        sats += [{**{k: r[k] for k in KEEP}, "GROUP": fleet} for r in kept]
        meta[fleet] = {"celestrak_group": group, "url": BASE_URL.format(group=group),
                       "fetched_utc": fetched, "count_fetched": len(recs),
                       "count_kept": len(kept), "every_nth": n}
    return {"source": "CelesTrak GP data, OMM JSON", "policy": POLICY_URL,
            "note": "Positions drift by kilometres a day after each EPOCH; propagate with SGP4.",
            "groups": meta, "fields": KEEP + ["GROUP"], "sats": sats}


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", help="build from saved DIR/<group>.json instead of fetching")
    args = ap.parse_args()
    raw = {}
    for fleet, group in GROUPS.items():
        raw[fleet] = load_saved(args.src, group) if args.src else fetch(group)
        log.info("group=%s records=%d fetched_utc=%s", group, len(raw[fleet][0]), raw[fleet][1])
    every_nth = 1
    while True:
        out = json.dumps(build(raw, every_nth), separators=(",", ":"))
        if len(out.encode()) <= MAX_BYTES:
            break
        every_nth += 1
    date = min(t for _, t in raw.values())[:10]
    path = os.path.join("assets", "data", f"gp-{date}.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(out + "\n")
    log.info("wrote %s bytes=%d starlink_every_nth=%d", path, len(out.encode()), every_nth)


if __name__ == "__main__":
    sys.exit(main())
