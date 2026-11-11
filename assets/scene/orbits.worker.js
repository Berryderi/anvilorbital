// Orbit worker for the home scene: all SGP4 work happens here, off the main thread.
// Messages in:  {type:'init', url, thin}      load the CelesTrak snapshot, keep the four fleets, every Nth record per `thin`
//               {type:'at', t}                positions and velocities of every kept satellite at time t (ms since 1970)
//               {type:'detail', i, t}         height of satellite i at t, and one full orbit as a ring of points
// Messages out: {type:'meta', ...}, {type:'at', t, pos, vel}, {type:'detail', i, t, heightKm, ring}, {type:'error', message}
// Scene units: 1 unit = 1,000 km; scene axes (x, y, z) = ECI (x, z, -y), so y is north.
import { json2satrec } from '../vendor/satellite.js/io.js';
import { propagate, gstime } from '../vendor/satellite.js/propagation.js';
import { eciToGeodetic } from '../vendor/satellite.js/transforms.js';

const UNIT_KM = 1000;
const MIN_HEIGHT_KM = 100;          // below this a record has re-entered; it is parked at the centre and not drawn
const R_EARTH_KM = 6371;
const RING_POINTS = 96;
const FLEETS = ['starlink', 'oneweb', 'amazon-leo', 'planet'];

let recs = [];

function toScene(p, out, o) { out[o] = p.x / UNIT_KM; out[o + 1] = p.z / UNIT_KM; out[o + 2] = -p.y / UNIT_KM; }

function pv(rec, date) {
  try { const r = propagate(rec, date, { communityDecayCheckEnabled: true }); return r && r.position ? r : null; } catch { return null; }
}

async function init({ url, thin }) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
  const data = await res.json();
  const seen = {}, kept = [];
  for (const s of data.sats) {
    const g = FLEETS.indexOf(s.GROUP);
    if (g < 0) continue;
    const k = seen[s.GROUP] = (seen[s.GROUP] || 0) + 1;
    if ((k - 1) % ((thin && thin[s.GROUP]) || 1) === 0) kept.push([s, g]);
  }
  recs = kept.map(([s]) => { try { const r = json2satrec(s); return r.error ? null : r; } catch { return null; } });
  const fetched = Object.values(data.groups || {}).map(g => g.fetched_utc).filter(Boolean).sort();
  postMessage({
    type: 'meta',
    names: kept.map(([s]) => s.OBJECT_NAME), norad: kept.map(([s]) => s.NORAD_CAT_ID),
    groups: Uint8Array.from(kept, ([, g]) => g), fleets: FLEETS,
    listed: Object.fromEntries(FLEETS.map(f => [f, data.groups && data.groups[f] ? data.groups[f].count_fetched : null])),
    snapshotUtc: fetched[0] || null, policy: data.policy || null,
  });
}

function at(t) {
  const n = recs.length, pos = new Float32Array(n * 3), vel = new Float32Array(n * 3), date = new Date(t);
  const minR = (R_EARTH_KM + MIN_HEIGHT_KM) / UNIT_KM;
  for (let i = 0; i < n; i++) {
    const r = recs[i] && pv(recs[i], date);
    if (!r) continue;
    toScene(r.position, pos, i * 3);
    if (Math.hypot(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]) < minR) { pos[i * 3] = pos[i * 3 + 1] = pos[i * 3 + 2] = 0; continue; }
    toScene(r.velocity, vel, i * 3);   // km/s becomes units per second
  }
  postMessage({ type: 'at', t, pos, vel }, [pos.buffer, vel.buffer]);
}

function detail({ i, t }) {
  const rec = recs[i], date = new Date(t), r = rec && pv(rec, date);
  if (!r) { postMessage({ type: 'detail', i, t, heightKm: null, ring: null }); return; }
  const heightKm = eciToGeodetic(r.position, gstime(date)).height;
  const periodMs = (2 * Math.PI / rec.no) * 60000;      // rec.no is mean motion in radians a minute
  const ring = new Float32Array(RING_POINTS * 3);
  for (let k = 0; k < RING_POINTS; k++) {
    const q = pv(rec, new Date(t + periodMs * k / RING_POINTS));
    if (q) toScene(q.position, ring, k * 3);
  }
  postMessage({ type: 'detail', i, t, heightKm, ring }, [ring.buffer]);
}

onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') await init(data);
    else if (data.type === 'at') at(data.t);
    else if (data.type === 'detail') detail(data);
  } catch (e) {
    postMessage({ type: 'error', message: String(e && e.message || e) });
  }
};
