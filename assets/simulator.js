// Orbit simulator. Mode 1: real fleets from the dated CelesTrak snapshot, propagated with SGP4.
// Mode 2: one dead satellite falling, using the planner's model (assets/model.js: lifetimeYears, REENTRY, LIMIT)
// and the planner presets (assets/presets.js: PRESETS, REAL, EXAMPLES, LINK_IDS, BY_LINK_ID), loaded as globals.
import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { json2satrec } from './vendor/satellite.js/io.js';
import { propagate, gstime } from './vendor/satellite.js/propagation.js';
import { eciToGeodetic } from './vendor/satellite.js/transforms.js';

const $ = id => document.getElementById(id);
const SNAPSHOT_URL = '../assets/data/gp-2026-11-10.json';
const UNIT_KM = 1000;                 // one scene unit is 1,000 km
const R_EARTH_KM = 6371;
const MIN_SHOWN_HEIGHT_KM = 100;      // below this a record has re-entered; don't draw it
const POSITION_HZ = 3;                // while playing, each satellite's position is recomputed at most this often (brief: at most 5)
const MAX_PROPAGATIONS_PER_S = 4500;  // SGP4 calls a second in all, well under the 8,000 budget so slower machines stay near 4 ms a frame; with "show all" each position updates less often
const TEXT_HZ = 10;                   // mode 2 readouts and slider while playing; the scene itself moves every frame
// Default view, about 1,500 points: every Nth record of these fleets in the snapshot. "Show all" draws every record.
const THIN = { 'starlink': 6, 'oneweb': 2 };
const HEIGHT_EXAGGERATION = 4;        // mode 2 only, stated on the page
const MAX_SHOWN_ALT_KM = 1200;
const MIN_ALT_KM = 300;
const MAX_CLOCK_YEARS = 1000;
const MAX_FRAME_S = 0.1;              // a frame after a pause or a slow frame never jumps further than this
const DOT_ORBITS_PER_S = 0.15;        // mode 2 dot speed, for the eye only
const CLICK_SLOP_PX = 6;
const FALL_TOLERANCE = 1e-9;
const DAY_MS = 86400000;
const FLEETS = {
  'starlink': { label: 'Starlink', token: '--series-1' },
  'oneweb': { label: 'OneWeb', token: '--series-2' },
  'amazon-leo': { label: 'Amazon Leo', token: '--series-3' },
  'planet': { label: 'Planet', token: '--series-4' },
};
// Filed fleets: nothing launched, so drawn as rings at the filed heights.
const FILED = [
  { label: 'Starcloud, filed at 600 to 850 km (drawn at 725 km), up to 88,000 satellites', km: 725, token: '--warn',
    src: 'https://api-prod.fcc.gov/icfs-attachment/exp/api/v1/5c6840321b3e365068b6a64ce54bcb49', srcName: 'FCC filing' },
  { label: 'SpaceX Starmind, filed at 323 to 327.5 km and 473 to 477.5 km, 100,000 satellites in the first phase', km: [325, 475], token: '--muted',
    src: 'https://www.advanced-television.com/?p=292409', srcName: 'Advanced Television' },
];

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const fmt = n => Math.round(n).toLocaleString('en-US');
const yrs = y => y >= 100 ? Number(y.toPrecision(2)).toLocaleString('en-US') : y >= 10 ? y.toFixed(0) : y.toFixed(1);
const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const color = name => new THREE.Color(token(name));
// Text written every frame only touches the page when it changes, so an unchanged clock costs no layout.
const setText = (el, s) => { if (el.textContent !== s) el.textContent = s; };
// ECI (z north) to scene (y up), a proper rotation.
const toScene = (p, out) => out.set(p.x / UNIT_KM, p.z / UNIT_KM, -p.y / UNIT_KM);

// ---------- WebGL, renderer, camera ----------
function hasWebGL() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}
const gl = hasWebGL();
const canvas = $('scene');
let renderer = null, scene = null, camera = null, controls = null;
const earthRadius = R_EARTH_KM / UNIT_KM;

if (gl) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(1);   // 1 CSS pixel per drawn pixel: up to 4x fewer pixels than before on high-DPI screens
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
  camera.position.set(14, 9, 22);
  controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.enableDamping = !reduceMotion.matches;
  controls.minDistance = earthRadius * 1.4;
  controls.maxDistance = 90;
} else {
  $('stage').hidden = true; $('keys').hidden = true; $('view-ctl').hidden = true; $('nogl').hidden = false;
}

const sunLight = gl ? new THREE.DirectionalLight(0xffffff, 2.6) : null;
const ambient = gl ? new THREE.AmbientLight(0xffffff, 0.45) : null;
const earthMat = gl ? new THREE.MeshLambertMaterial() : null;
if (gl) {
  scene.add(sunLight, ambient, new THREE.Mesh(new THREE.SphereGeometry(earthRadius, 32, 16), earthMat));
}

// Low-precision sun direction in ECI (Astronomical Almanac formula, about 0.01 degrees), for day and night.
function sunDirection(date) {
  const n = date.getTime() / DAY_MS + 2440587.5 - 2451545.0;
  const rad = Math.PI / 180;
  const L = 280.460 + 0.9856474 * n, g = (357.528 + 0.9856003 * n) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad, eps = (23.439 - 0.0000004 * n) * rad;
  return { x: Math.cos(lambda), y: Math.cos(eps) * Math.sin(lambda), z: Math.sin(eps) * Math.sin(lambda) };
}
function setSun(date) {
  if (!gl) return;
  const s = sunDirection(date);
  toScene({ x: s.x * 50 * UNIT_KM, y: s.y * 50 * UNIT_KM, z: s.z * 50 * UNIT_KM }, sunLight.position);
}

// ---------- Mode 1: real fleets ----------
const m1 = { group: gl ? new THREE.Group() : null, sats: [], recs: [], geom: null, points: null, sel: null, selIndex: -1,
  t: Date.now(), playing: false, speed: 100, cursor: 0, credit: 0, count: 0, defaultCount: 0, showAll: false,
  loaded: false, loading: false, meta: null, failed: 0 };
if (gl) scene.add(m1.group);

function circle(rKm, exaggerate = 1, segments = 128) {
  const r = (R_EARTH_KM + exaggerate * rKm) / UNIT_KM, pts = [];
  for (let i = 0; i < segments; i++) { const a = i / segments * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

function unitCircle(segments = 128) {
  const pts = [];
  for (let i = 0; i < segments; i++) { const a = i / segments * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a))); }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

function buildShells() {
  if (!gl) return;
  for (const f of FILED) {
    for (const km of [].concat(f.km)) {
      const ring = new THREE.LineLoop(circle(km), new THREE.LineBasicMaterial());
      ring.userData.token = f.token;
      m1.group.add(ring);
    }
  }
}

function legend1() {
  const ul = $('legend-1'); ul.replaceChildren();
  const counts = {};
  for (let i = 0; i < m1.count; i++) counts[m1.sats[i].GROUP] = (counts[m1.sats[i].GROUP] || 0) + 1;
  for (const [id, f] of Object.entries(FLEETS)) {
    const li = document.createElement('li'); li.style.setProperty('--c', `var(${f.token})`);
    li.textContent = `${f.label}${counts[id] ? ` (${fmt(counts[id])})` : ''}`; ul.append(li);
  }
  for (const f of FILED) {
    const li = document.createElement('li'); li.className = 'shell'; li.style.setProperty('--c', `var(${f.token})`);
    const a = document.createElement('a'); a.href = f.src; a.rel = 'noopener'; a.textContent = f.srcName;
    li.append(`${f.label}: filed, not launched (`, a, ')'); ul.append(li);
  }
}

function snapshotDate(meta) {
  const times = Object.values(meta.groups).map(g => g.fetched_utc).sort();
  return times[0] ? times[0].slice(0, 10) : '';
}

function dataNote() {
  const p = $('data-note'); p.replaceChildren();
  if (!m1.meta) return;
  // Per fleet, shown against the number CelesTrak listed on the snapshot date.
  const shown = {};
  for (let i = 0; i < m1.count; i++) shown[m1.sats[i].GROUP] = (shown[m1.sats[i].GROUP] || 0) + 1;
  const thinned = Object.entries(FLEETS).map(([id, f]) => {
    const real = m1.meta.groups[id] && m1.meta.groups[id].count_fetched, n = shown[id];
    return n && real > n ? `1 in ${fmt(real / n)} ${f.label} shown (${fmt(n)} of ${fmt(real)})` : null;
  }).filter(Boolean);
  const a = document.createElement('a'); a.href = m1.meta.policy; a.rel = 'noopener'; a.textContent = 'CelesTrak usage policy';
  p.append(`CelesTrak GP data, ${snapshotDate(m1.meta)}, propagated with SGP4; accuracy drifts by kilometres a day. `
    + (thinned.length ? `${thinned.join('; ')}. ` : '')
    + 'Loaded from this site; your browser makes no request to CelesTrak. ', a, '.');
}

async function loadSnapshot() {
  if (m1.loaded || m1.loading) return;
  m1.loading = true;
  $('status').textContent = 'Loading the satellite snapshot.';
  let meta;
  try {
    const res = await fetch(SNAPSHOT_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    meta = await res.json();
  } catch (e) {
    m1.loading = false;
    $('status').textContent = "Couldn't load the satellite snapshot. Reload the page to try again.";
    console.error('[simulator] snapshot load failed', e);
    summarize();
    return;
  }
  m1.meta = meta;
  // The default subset goes first, so "show all" only extends the draw range.
  const seen = {}, first = [], rest = [];
  for (const s of meta.sats.filter(r => FLEETS[r.GROUP])) {
    const k = seen[s.GROUP] = (seen[s.GROUP] || 0) + 1;
    ((k - 1) % (THIN[s.GROUP] || 1) === 0 ? first : rest).push(s);
  }
  m1.sats = first.concat(rest);
  m1.defaultCount = first.length;
  m1.count = m1.showAll ? m1.sats.length : m1.defaultCount;
  m1.recs = m1.sats.map(s => { try { const r = json2satrec(s); return r.error ? null : r; } catch { return null; } });
  m1.heights = new Float32Array(m1.sats.length).fill(NaN);
  if (gl) {
    const n = m1.sats.length, colors = new Float32Array(n * 3);
    m1.sats.forEach((s, i) => color(FLEETS[s.GROUP].token).toArray(colors, i * 3));
    m1.geom = new THREE.BufferGeometry();
    m1.geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    m1.geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    m1.points = new THREE.Points(m1.geom, new THREE.PointsMaterial({ size: 2.5 * renderer.getPixelRatio(), sizeAttenuation: false, vertexColors: true }));
    m1.points.frustumCulled = false;
    m1.geom.setDrawRange(0, m1.count);   // raycasting follows the draw range too
    m1.group.add(m1.points);
    const selGeom = new THREE.BufferGeometry(); selGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    m1.sel = new THREE.Points(selGeom, new THREE.PointsMaterial({ size: 11 * renderer.getPixelRatio(), sizeAttenuation: false, transparent: true, opacity: 0.85 }));
    m1.sel.visible = false; m1.sel.frustumCulled = false; m1.group.add(m1.sel);
  }
  propagateAll(new Date(m1.t));
  m1.loaded = true; m1.loading = false;
  $('status').textContent = '';
  showAllLabel(); legend1(); dataNote(); fillFleetPick(); summarize(); requestRender();
}

function showAllLabel() {
  const b = $('show-all');
  b.setAttribute('aria-pressed', String(m1.showAll));
  b.textContent = m1.loaded ? `Show all ${fmt(m1.sats.length)}` : 'Show all';
}

function setShowAll(on) {
  m1.showAll = on;
  showAllLabel();
  if (!m1.loaded) return;
  m1.count = on ? m1.sats.length : m1.defaultCount;
  m1.heights.fill(NaN, m1.count);
  if (m1.geom) m1.geom.setDrawRange(0, m1.count);
  if (m1.selIndex >= m1.count) { m1.selIndex = -1; if (m1.sel) m1.sel.visible = false; $('info').textContent = 'Click a satellite, or pick a fleet and press Next satellite.'; }
  propagateAll(new Date(m1.t));
  legend1(); dataNote(); summarize(); requestRender();
}

const tmp = new THREE.Vector3();
// Propagate the next `count` shown satellites, round robin from m1.cursor.
function propagateSome(date, count) {
  const n = m1.count; count = Math.min(count, n); if (!count) return;
  const gmst = gstime(date);
  const pos = m1.geom ? m1.geom.attributes.position.array : null;
  for (let done = 0; done < count; done++) {
    const i = m1.cursor; m1.cursor = (m1.cursor + 1) % n;
    let h = NaN, p = null;
    const rec = m1.recs[i];
    if (rec) {
      try { const pv = propagate(rec, date, { communityDecayCheckEnabled: true }); p = pv && pv.position; } catch { p = null; }
      if (p) h = eciToGeodetic(p, gmst).height;
    }
    const shown = p && h >= MIN_SHOWN_HEIGHT_KM;
    m1.heights[i] = shown ? h : NaN;
    if (pos) { if (shown) { toScene(p, tmp); pos[i * 3] = tmp.x; pos[i * 3 + 1] = tmp.y; pos[i * 3 + 2] = tmp.z; } else { pos[i * 3] = pos[i * 3 + 1] = pos[i * 3 + 2] = 0; } }
  }
  if (m1.geom) m1.geom.attributes.position.needsUpdate = true;
}
function propagateAll(date) {
  m1.cursor = 0; m1.credit = 0; propagateSome(date, m1.count);
  m1.failed = m1.heights.subarray(0, m1.count).filter(Number.isNaN).length;
}

function median(arr) { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

function fillFleetPick() {
  const sel = $('fleet-pick'); sel.replaceChildren();
  for (const [id, f] of Object.entries(FLEETS)) { const o = document.createElement('option'); o.value = id; o.textContent = f.label; sel.append(o); }
}

// Text goes to an aria-live region, so it is written on selection only; while playing, only the marker follows.
function showSatellite(i, text = true) {
  m1.selIndex = i;
  const s = m1.sats[i], rec = m1.recs[i], h = m1.heights[i];
  if (!s) return;
  const inc = rec ? rec.inclo * 180 / Math.PI : s.INCLINATION;
  if (text) $('info').textContent = `${s.OBJECT_NAME} (NORAD ${s.NORAD_CAT_ID}), ${FLEETS[s.GROUP].label}: `
    + (Number.isNaN(h) ? 'no position at this time (re-entered or propagation failed)' : `height ${fmt(h)} km`)
    + `, inclination ${inc.toFixed(1)}°, at ${new Date(m1.t).toISOString().slice(0, 16).replace('T', ' ')} UTC.`;
  if (m1.sel) {
    const p = m1.geom.attributes.position.array, sp = m1.sel.geometry.attributes.position.array;
    sp[0] = p[i * 3]; sp[1] = p[i * 3 + 1]; sp[2] = p[i * 3 + 2];
    m1.sel.geometry.attributes.position.needsUpdate = true; m1.sel.visible = !Number.isNaN(h);
  }
  requestRender();
}

function nextSatellite() {
  if (!m1.loaded) return;
  const fleet = $('fleet-pick').value, n = m1.count;
  for (let k = 1; k <= n; k++) {
    const i = (m1.selIndex + k + n) % n;
    if (m1.sats[i].GROUP === fleet && !Number.isNaN(m1.heights[i])) { showSatellite(i); return; }
  }
}

function clock1() {
  const d = new Date(m1.t);
  setText($('clock-1'), `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC, x${fmt(m1.speed)}${m1.playing ? '' : ', paused'}`);
}

// ---------- Mode 2: one dead satellite ----------
const m2 = { group: gl ? new THREE.Group() : null, years: 0, playing: false, speed: 1, shape: null, textAt: -Infinity,
  L: null, angleA: 0, angleB: Math.PI, rings: {} };
if (gl) {
  scene.add(m2.group); m2.group.visible = false;
  for (const k of ['a', 'b', 'five']) {
    const mat = k === 'five' ? new THREE.LineDashedMaterial({ dashSize: 0.25, gapSize: 0.18 }) : new THREE.LineBasicMaterial();
    const line = new THREE.LineLoop(k === 'five' ? circle(MIN_ALT_KM) : unitCircle(), mat); m2.rings[k] = line; m2.group.add(line);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(6), 3));
  m2.dots = new THREE.Points(g, new THREE.PointsMaterial({ size: 10 * renderer.getPixelRatio(), sizeAttenuation: false, vertexColors: true }));
  m2.dots.frustumCulled = false; m2.group.add(m2.dots);
}

function fillShapes() {
  const sel = $('shape'); sel.replaceChildren();
  for (const [label, group] of [['Real fleets (public figures)', REAL], ['Examples (illustrations)', EXAMPLES]]) {
    const g = document.createElement('optgroup'); g.label = label;
    for (const name of Object.keys(group)) { const o = document.createElement('option'); o.value = name; o.textContent = name; g.append(o); }
    sel.append(g);
  }
}

const clampAlt = v => Math.min(MAX_SHOWN_ALT_KM, Math.max(MIN_ALT_KM, Math.round(Number(v) || MIN_ALT_KM)));
// Years to fall from each whole km, straight from the planner model's lifetimeYears.
function fallTable(mA, sun) {
  const L = new Float64Array(MAX_SHOWN_ALT_KM + 1);
  for (let h = REENTRY + 1; h <= MAX_SHOWN_ALT_KM; h++) L[h] = lifetimeYears(h, mA, sun);
  return L;
}
// Height after t years for a satellite that started at whole-km height a: L[a] - L[h] = t.
function heightAt(L, a, t) {
  const target = L[a] - t;
  if (target <= L[a] * FALL_TOLERANCE) return null;   // the clock stops at the fall time; rounding must not leave it at 180 km
  let lo = REENTRY, hi = a;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (L[mid] <= target) lo = mid; else hi = mid; }
  return lo + (target - L[lo]) / (L[hi] - L[lo]);
}
function fiveYearHeight(L) {
  for (let h = REENTRY + 1; h <= MAX_SHOWN_ALT_KM; h++) if (L[h] >= LIMIT) return h - 1 + (LIMIT - L[h - 1]) / (L[h] - L[h - 1]);
  return null;
}

function recompute2() {
  const p = PRESETS[$('shape').value];
  m2.shape = $('shape').value;
  m2.mA = p.mass / p.area;
  m2.sun = Number($('sun').value);
  m2.a = clampAlt($('alt-a').value); m2.b = clampAlt($('alt-b').value);
  $('alt-a').value = String(m2.a); $('alt-b').value = String(m2.b);
  m2.L = fallTable(m2.mA, m2.sun);
  m2.five = fiveYearHeight(m2.L);
  const longest = Math.max(m2.L[m2.a], m2.L[m2.b]);
  m2.maxYears = Math.min(MAX_CLOCK_YEARS, longest);
  $('years').max = String(m2.maxYears);
  m2.years = Math.min(m2.years, m2.maxYears);
  if (gl) {
    m2.rings.five.visible = m2.five !== null;
    if (m2.five !== null) { m2.rings.five.geometry.dispose(); m2.rings.five.geometry = circle(m2.five, HEIGHT_EXAGGERATION); m2.rings.five.computeLineDistances(); }
  }
  update2(); summarize();
}

// Same rule as the planner card: above the model's atmosphere table, show only the order of magnitude and say so.
const TABLE_TOP_KM = T[T.length - 1][0];
// approx adds "about " before a number only, so the text never reads "about more than".
function fallText(start, years, approx = false) {
  const n = `${approx ? 'about ' : ''}${yrs(years)} years`;
  if (start <= TABLE_TOP_KM) return n;
  return (years >= MAX_CLOCK_YEARS ? `more than ${fmt(MAX_CLOCK_YEARS)} years` : n)
    + ` (the model isn't reliable above ${fmt(TABLE_TOP_KM)} km)`;
}
function satLine(name, start, h, fallYears) {
  if (h === null) return `${name}: started at ${fmt(start)} km, burned up after ${yrs(fallYears)} years.`;
  return `${name}: started at ${fmt(start)} km, now ${fmt(h)} km. Falls on its own after ${fallText(start, fallYears)}`
    + (fallYears > MAX_CLOCK_YEARS ? ', past the end of this clock.' : '.');
}

// While playing, the readouts and the slider are written at most TEXT_HZ times a second (the scene still moves every
// frame); every other caller writes them at once.
function update2(playingFrame = false) {
  const ha = heightAt(m2.L, m2.a, m2.years), hb = heightAt(m2.L, m2.b, m2.years);
  const now = performance.now();
  if (!playingFrame || now - m2.textAt >= 1000 / TEXT_HZ) {
    m2.textAt = now;
    setText($('sat-a'), satLine('Satellite A', m2.a, ha, m2.L[m2.a]));
    setText($('sat-b'), satLine('Satellite B', m2.b, hb, m2.L[m2.b]));
    setText($('clock-2'), `${yrs(m2.years)} years after it died${m2.playing ? '' : ', paused'}`);
    $('years').value = String(m2.years);
    const vt = `${yrs(m2.years)} years`;
    if ($('years').getAttribute('aria-valuetext') !== vt) $('years').setAttribute('aria-valuetext', vt);
  }
  if (!gl) return;
  const pos = m2.dots.geometry.attributes.position.array, col = m2.dots.geometry.attributes.color.array;
  [[ha, m2.angleA, 'a', '--series-1', 0], [hb, m2.angleB, 'b', '--series-2', 1]].forEach(([h, ang, k, tok, j]) => {
    const ring = m2.rings[k];
    if (h === null) { ring.visible = false; pos[j * 3] = pos[j * 3 + 1] = pos[j * 3 + 2] = 0; return; }
    const r = (R_EARTH_KM + HEIGHT_EXAGGERATION * h) / UNIT_KM;
    ring.visible = true; ring.scale.setScalar(r);   // a and b rings are unit circles
    pos[j * 3] = Math.cos(ang) * r; pos[j * 3 + 1] = 0; pos[j * 3 + 2] = Math.sin(ang) * r;
    color(tok).toArray(col, j * 3);
  });
  m2.dots.geometry.attributes.position.needsUpdate = true; m2.dots.geometry.attributes.color.needsUpdate = true;
  requestRender();
}

// ---------- Summary, theme, mode ----------
let mode = 1;
function summarize() {
  const out = $('summary');
  if (mode === 1) {
    if (!m1.loaded) { out.textContent = m1.loading ? 'Loading the satellite snapshot.' : 'The satellite snapshot did not load.'; return; }
    const parts = Object.entries(FLEETS).map(([id, f]) => {
      const hs = []; for (let i = 0; i < m1.count; i++) if (m1.sats[i].GROUP === id && !Number.isNaN(m1.heights[i])) hs.push(m1.heights[i]);
      return `${f.label} ${fmt(hs.length)}, median height ${fmt(median(hs))} km`;
    });
    out.textContent = `Satellites from the CelesTrak snapshot of ${snapshotDate(m1.meta)}, placed with SGP4 for ${new Date(m1.t).toISOString().slice(0, 16).replace('T', ' ')} UTC: `
      + parts.join('; ') + `. ${fmt(m1.failed)} ${m1.failed === 1 ? "record has no position at that time and isn't" : "records have no position at that time and aren't"} drawn. `
      + 'Rings mark filed fleets with no satellites up yet: Starcloud at 600 to 850 km and SpaceX Starmind at about 325 and 475 km. '
      + 'The lit half of Earth faces the sun at that time.';
  } else {
    const sunName = { 3: 'an active', 1: 'an average', 0.3: 'a quiet' }[m2.sun] || 'an average';
    const five = m2.five === null ? 'From every height up to 1,200 km it falls within 5 years.'
      : m2.five <= REENTRY + 1 ? 'It misses the 5-year limit from every height shown.'
      : `It falls within 5 years from below about ${fmt(m2.five)} km.`;
    out.textContent = `A dead "${m2.shape}" satellite (${m2.mA.toFixed(1)} kg per m² facing drag) with ${sunName} sun: from ${fmt(m2.a)} km it falls in ${fallText(m2.a, m2.L[m2.a], true)}, `
      + `from ${fmt(m2.b)} km in ${fallText(m2.b, m2.L[m2.b], true)}. ${five} Planner model, not checked by a spacecraft engineer.`;
  }
}

function applyTheme() {
  if (!gl) return;
  earthMat.color = color('--band');
  scene.background = color('--panel');
  for (const mesh of m1.group.children) if (mesh.userData.token) mesh.material.color = color(mesh.userData.token);
  if (m1.geom) { const c = m1.geom.attributes.color.array; m1.sats.forEach((s, i) => color(FLEETS[s.GROUP].token).toArray(c, i * 3)); m1.geom.attributes.color.needsUpdate = true; }
  if (m1.sel) m1.sel.material.color = color('--ink');
  m2.rings.a.material.color = color('--series-1'); m2.rings.b.material.color = color('--series-2'); m2.rings.five.material.color = color('--warn');
  requestRender();
}

function setPlayLabels() {
  $('play-1').textContent = m1.playing ? 'Pause' : 'Play';
  $('play-2').textContent = m2.playing ? 'Pause' : 'Play';
}

function setMode(n, writeHash = true) {
  mode = n;
  $('mode-1').setAttribute('aria-pressed', String(n === 1)); $('mode-2').setAttribute('aria-pressed', String(n === 2));
  $('panel-1').hidden = n !== 1; $('panel-2').hidden = n !== 2;
  if (gl) { m1.group.visible = n === 1; m2.group.visible = n === 2; }
  if (n === 1) { setSun(new Date(m1.t)); loadSnapshot(); } else { $('status').textContent = ''; setSun(new Date(Date.UTC(2026, 2, 20))); }
  if (writeHash) history.replaceState(null, '', location.pathname + (n === 2 ? '#' + LINK_IDS[m2.shape] : ''));
  summarize(); setPlayLabels(); clock1(); requestRender();
}

function applyHash() {
  const name = BY_LINK_ID[location.hash.slice(1).toLowerCase()];
  if (name) {
    $('shape').value = name;
    const alt = clampAlt(PRESETS[name].alt);
    $('alt-a').value = String(alt);
    $('alt-b').value = String(alt <= (550 + 800) / 2 ? 800 : 550);
    m2.years = 0; recompute2(); setMode(2, false);
  } else setMode(1, false);
}

// ---------- Loop: renders only while something moves, at most FPS_CAP times a second, and never while the
// tab is hidden or the view is off screen. One frame is pending at a time: requestRender is a no-op while
// one is scheduled or running, so calls made during a frame (update2, showSatellite, controls) never start
// a second chain. The cap waits with a timer, so a paced frame costs one callback, not several skipped ones.
// Frames follow a fixed schedule (due += FRAME_MS), so an early wake never adds frames over a second.
const FPS_CAP = 30;
const FRAME_MS = 1000 / FPS_CAP;
const VSYNC_SLACK_MS = 4;             // wake a little early so the frame lands on the display refresh it is due at
let raf = 0, timer = 0, pending = false, last = 0, due = -Infinity, onScreen = true;
function requestRender() {
  if (pending || document.hidden || !onScreen) return;
  pending = true;
  const wait = due - VSYNC_SLACK_MS - performance.now();
  if (wait > 0) timer = setTimeout(() => { timer = 0; raf = requestAnimationFrame(frame); }, wait);
  else raf = requestAnimationFrame(frame);
}
function stopLoop() { clearTimeout(timer); cancelAnimationFrame(raf); timer = raf = 0; pending = false; last = 0; }
function frame(ts) {
  raf = 0;
  due = ts - due > FRAME_MS ? ts + FRAME_MS : due + FRAME_MS;   // after an idle or slow spell, restart the schedule; never catch up
  const dt = last ? Math.min(MAX_FRAME_S, (ts - last) / 1000) : 0; last = ts;
  let moving = false;
  if (mode === 1 && m1.playing && m1.loaded) {
    m1.t += dt * 1000 * m1.speed;
    const d = new Date(m1.t);
    // Spread the work: each frame recomputes its share of positions, so no frame does them all at once.
    m1.credit = Math.min(m1.count, m1.credit + Math.min(m1.count * POSITION_HZ, MAX_PROPAGATIONS_PER_S) * dt);
    const k = Math.floor(m1.credit); m1.credit -= k;
    propagateSome(d, k); setSun(d); clock1();
    if (m1.selIndex >= 0) showSatellite(m1.selIndex, false);
    moving = true;
  }
  if (mode === 2 && m2.playing) {
    m2.years = Math.min(m2.maxYears, m2.years + dt * m2.speed);
    m2.angleA += dt * DOT_ORBITS_PER_S * Math.PI * 2; m2.angleB += dt * DOT_ORBITS_PER_S * Math.PI * 2 * 0.8;
    update2(true);
    if (m2.years >= m2.maxYears) { m2.playing = false; setPlayLabels(); update2(); }
    moving = m2.playing;
  }
  const damping = controls ? controls.update() : false;
  if (gl) renderer.render(scene, camera);
  pending = false;
  if (moving || damping) requestRender(); else last = 0;
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stopLoop(); else requestRender(); });
if (gl) new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; if (onScreen) requestRender(); else stopLoop(); }).observe($('stage'));

// ---------- Resize, input ----------
function resize() {
  if (!gl) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); requestRender();
}
if (gl) { new ResizeObserver(resize).observe($('stage')); controls.addEventListener('change', requestRender); }

function turn(dir, dPhi = 0) {
  const off = camera.position.clone().sub(controls.target), s = new THREE.Spherical().setFromVector3(off);
  s.theta += dir * Math.PI / 12; s.phi = Math.min(Math.PI - 0.1, Math.max(0.1, s.phi + dPhi));
  off.setFromSpherical(s); camera.position.copy(controls.target).add(off); controls.update(); requestRender();
}
function zoom(f) {
  const off = camera.position.clone().sub(controls.target);
  off.setLength(THREE.MathUtils.clamp(off.length() * f, controls.minDistance, controls.maxDistance));
  camera.position.copy(controls.target).add(off); controls.update(); requestRender();
}
document.querySelectorAll('[data-turn]').forEach(b => b.addEventListener('click', () => gl && turn(Number(b.dataset.turn))));
document.querySelectorAll('[data-zoom]').forEach(b => b.addEventListener('click', () => gl && zoom(Number(b.dataset.zoom))));
canvas.addEventListener('keydown', e => {
  if (!gl) return;
  const k = { ArrowLeft: () => turn(-1), ArrowRight: () => turn(1), ArrowUp: () => turn(0, -Math.PI / 12), ArrowDown: () => turn(0, Math.PI / 12),
    '+': () => zoom(0.8), '=': () => zoom(0.8), '-': () => zoom(1.25) }[e.key];
  if (k) { e.preventDefault(); k(); }
});

// Click (not drag) on a satellite in mode 1.
let downAt = null;
canvas.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', e => {
  if (!gl || mode !== 1 || !m1.points || !downAt) return;
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > CLICK_SLOP_PX) return;
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera);
  ray.params.Points.threshold = camera.position.length() * 0.006;
  const hits = ray.intersectObject(m1.points).filter(h => !Number.isNaN(m1.heights[h.index]));
  // Nearest to the ray, and in front of Earth.
  const earthHit = ray.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), earthRadius), new THREE.Vector3());
  const maxDist = earthHit ? earthHit.distanceTo(ray.ray.origin) : Infinity;
  const best = hits.filter(h => h.distance < maxDist).sort((a, b) => a.distanceToRay - b.distanceToRay)[0];
  if (best) showSatellite(best.index);
});

$('mode-1').addEventListener('click', () => setMode(1));
$('mode-2').addEventListener('click', () => setMode(2));
$('play-1').addEventListener('click', () => { m1.playing = !m1.playing; setPlayLabels(); clock1(); requestRender(); });
$('now-1').addEventListener('click', () => { m1.t = Date.now(); if (m1.loaded) { propagateAll(new Date(m1.t)); summarize(); } setSun(new Date(m1.t)); clock1(); if (m1.selIndex >= 0) showSatellite(m1.selIndex); requestRender(); });
$('speed-1').addEventListener('change', e => { m1.speed = Number(e.target.value); clock1(); });
$('next-sat').addEventListener('click', nextSatellite);
// Built here rather than in simulator/index.html, which the redesign (WQ-023) restyles in parallel.
$('next-sat').after(Object.assign(document.createElement('button'), { className: 'ctl', type: 'button', id: 'show-all', textContent: 'Show all' }));
$('show-all').setAttribute('aria-pressed', 'false');
$('show-all').addEventListener('click', () => setShowAll(!m1.showAll));
$('play-2').addEventListener('click', () => { if (!m2.playing && m2.years >= m2.maxYears) m2.years = 0; m2.playing = !m2.playing; setPlayLabels(); update2(); });
$('reset-2').addEventListener('click', () => { m2.years = 0; update2(); });
$('speed-2').addEventListener('change', e => { m2.speed = Number(e.target.value); });
$('years').addEventListener('input', e => { m2.years = Number(e.target.value); update2(); });
for (const id of ['shape', 'sun', 'alt-a', 'alt-b']) $(id).addEventListener('change', () => {
  recompute2();
  if (id === 'shape' && mode === 2) history.replaceState(null, '', location.pathname + '#' + LINK_IDS[m2.shape]);
});
window.addEventListener('hashchange', applyHash);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------- Start ----------
fillShapes();
$('speed-1').value = String(m1.speed);
buildShells();
legend1();
recompute2();
applyTheme();
setSun(new Date(m1.t));
clock1();
applyHash();
resize();
requestRender();
