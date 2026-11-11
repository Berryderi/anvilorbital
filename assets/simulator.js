// Orbit simulator (WQ-028 remake: a mission-control console with five steps and a tour).
// 01 Fleets: real fleets from the dated CelesTrak snapshot, propagated with SGP4.
// 02 Decay: one dead satellite falling, using the planner's model (assets/model.js: lifetimeYears, REENTRY, LIMIT, T)
//    and the planner presets (assets/presets.js: PRESETS, REAL, EXAMPLES, LINK_IDS, BY_LINK_ID), loaded as globals.
// 03 Tug, 04 Workcell, 05 Wait / burn: concepts, not built (assets/sim-concepts.js draws 03 and 05; 04 is the page's SVG).
import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { json2satrec } from './vendor/satellite.js/io.js';
import { propagate, gstime } from './vendor/satellite.js/propagation.js';
import { eciToGeodetic } from './vendor/satellite.js/transforms.js';
import { EARTH_VS, EARTH_FS, HALO_VS, HALO_FS, STAR_VS, STAR_FS, FLEET_COLORS, mulberry32 } from './scene/scene.js';
import { createTug, createWaitBurn, makeShell, markers, setMark } from './sim-concepts.js';

const $ = id => document.getElementById(id);
const SNAPSHOT_URL = '/assets/data/gp-2026-11-10.json';
const TEXTURES = { day: '/assets/scene/earth-day-2k.webp', night: '/assets/scene/earth-night-2k.webp' };  // home's phone textures, cached across pages
const UNIT_KM = 1000;                 // one scene unit is 1,000 km
const R_EARTH_KM = 6371;
const MIN_SHOWN_HEIGHT_KM = 100;      // below this a record has re-entered; don't draw it
const POSITION_HZ = 3;                // while playing, each satellite's position is recomputed at most this often (brief: at most 5)
const MAX_PROPAGATIONS_PER_S = 4500;  // SGP4 calls a second in all, well under the 8,000 budget so slower machines stay near 4 ms a frame
const MAX_PROPAGATIONS_PER_FRAME = 150; // = 4,500 / 30 fps: when frames come slower, positions refresh less often instead of each frame doing more
const TEXT_HZ = 10;                   // readouts while playing; the scene itself moves every frame
// Default view, about 1,500 points: every Nth record of these fleets in the snapshot. "Show all" draws every record.
const THIN = { 'starlink': 6, 'oneweb': 2 };
const HEIGHT_EXAGGERATION = 4;        // steps 02, 03 and 05, stated on the page
const MAX_SHOWN_ALT_KM = 1200;
const MIN_ALT_KM = 300;
const MAX_CLOCK_YEARS = 1000;
const MAX_FRAME_S = 0.1;              // a frame after a pause or a slow frame never jumps further than this
const DOT_ORBITS_PER_S = 0.15;        // step 02 dot speed, for the eye only
const CLICK_SLOP_PX = 6;
const FALL_TOLERANCE = 1e-9;
const FIXED_DATE = Date.UTC(2026, 2, 20);   // steps 02 to 05 light Earth as at the March equinox
const TOUR_STEP_MS = 12000;           // the tour's time on each step
const STARS = [{ n: 1100, size: 1.1, r: 300, b: [0.3, 0.7] }, { n: 160, size: 2.0, r: 240, b: [0.6, 1.0] }];
// Fleet colours are home's (scene.js), so a satellite looks the same on both pages.
const FLEETS = Object.fromEntries(Object.entries(FLEET_COLORS).map(([id, f]) => [id, { label: f.label, hex: f.color }]));
// Filed fleets: nothing launched, so drawn as rings at the filed heights.
const FILED = [
  { short: 'Starcloud · filed', label: 'Starcloud, filed at 600 to 850 km (drawn at 725 km), up to 88,000 satellites', km: 725, token: '--sim-filed-1',
    src: 'https://api-prod.fcc.gov/icfs-attachment/exp/api/v1/5c6840321b3e365068b6a64ce54bcb49', srcName: 'FCC filing' },
  { short: 'Starmind · filed', label: 'SpaceX Starmind, filed at 323 to 327.5 km and 473 to 477.5 km, 100,000 satellites in the first phase', km: [325, 475], token: '--sim-filed-2',
    src: 'https://www.advanced-television.com/?p=292409', srcName: 'Advanced Television' },
];
const STEPS = {
  1: { name: 'Fleets', kind: 'real', hash: 'fleets', src: 'CelesTrak GP snapshot · SGP4' },
  2: { name: 'Decay', kind: 'model', hash: 'decay', src: "The planner's decay model" },
  3: { name: 'Tug', kind: 'concept', hash: 'tug', src: 'Our research estimates · illustration' },
  4: { name: 'Workcell', kind: 'concept', hash: 'workcell', src: 'Illustration · no numbers' },
  5: { name: 'Wait / burn', kind: 'concept', hash: 'wait-burn', src: 'Our research estimates · illustration' },
};
// Round, soft satellite points (home's look). A record with no position sits at the origin and draws at size 0.
const SAT_VS = `
attribute vec3 aColor; uniform float uSize; varying vec3 vC;
void main() { vC = aColor; gl_PointSize = dot(position, position) < 1.0 ? 0.0 : uSize; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SAT_FS = `
varying vec3 vC;
void main() { float r = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.55, r) * 0.55 + smoothstep(0.5, 0.0, r) * 0.45; if (a < 0.01) discard;
  gl_FragColor = vec4(vC, a);
  #include <colorspace_fragment>
}`;
const STEP_BY_HASH =Object.assign(Object.create(null), Object.fromEntries(Object.entries(STEPS).map(([n, s]) => [s.hash, Number(n)])));
const LAST_STEP = 5;

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const fmt = n => Math.round(n).toLocaleString('en-US');
const yrs = y => y >= 100 ? Number(y.toPrecision(2)).toLocaleString('en-US') : y >= 10 ? y.toFixed(0) : y.toFixed(1);
const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const color = name => new THREE.Color(token(name));
// Text written every frame only touches the page when it changes, so an unchanged clock costs no layout.
const setText = (el, s) => { if (el.textContent !== s) el.textContent = s; };
// ECI (z north) to scene (y up), a proper rotation.
const toScene = (p, out) => out.set(p.x / UNIT_KM, p.z / UNIT_KM, -p.y / UNIT_KM);
const mc = $('mc');

// ---------- WebGL, renderer, camera ----------
function hasWebGL() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}
const gl = hasWebGL();
const canvas = $('scene');
let renderer = null, scene = null, camera = null, controls = null;
const earthRadius = R_EARTH_KM / UNIT_KM;
const pr = 1;   // 1 CSS pixel per drawn pixel: the WQ-018 budget

if (gl) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(pr);
  renderer.setClearColor(color('--bg'), 1);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, 1, 0.1, 800);
  camera.position.set(14, 9, 22);
  controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.enableDamping = !reduceMotion.matches;
  controls.minDistance = earthRadius * 1.4;
  controls.maxDistance = 90;
} else {
  canvas.hidden = true; $('view-ctl').hidden = true; $('nogl').hidden = false;
}

// ---------- Earth, atmosphere, stars: home's shaders and textures ----------
const earthU = { uDay: { value: null }, uNight: { value: null }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uAtmo: { value: new THREE.Color('#6fa8e8') }, uFade: { value: 1 } };
const world = { earth: null, halo: null, stars: null };
if (gl) {
  world.earth = new THREE.Mesh(new THREE.SphereGeometry(earthRadius, 64, 32), new THREE.ShaderMaterial({ vertexShader: EARTH_VS, fragmentShader: EARTH_FS, uniforms: earthU }));
  world.earth.renderOrder = 1;
  const haloR = earthRadius * 1.045;
  world.halo = new THREE.Mesh(new THREE.SphereGeometry(haloR, 48, 24), new THREE.ShaderMaterial({ vertexShader: HALO_VS, fragmentShader: HALO_FS,
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uSun: earthU.uSun, uAtmo: earthU.uAtmo, uFade: { value: 1 }, uEdge: { value: Math.sqrt(1 - (earthRadius / haloR) ** 2) } } }));
  world.halo.renderOrder = 2;
  world.stars = new THREE.Group();
  const rand = mulberry32(20261111);
  for (const s of STARS) {
    const pos = new Float32Array(s.n * 3), b = new Float32Array(s.n);
    for (let i = 0; i < s.n; i++) {
      const u = rand() * 2 - 1, th = rand() * Math.PI * 2, k = Math.sqrt(1 - u * u);
      pos.set([k * Math.cos(th) * s.r, u * s.r, k * Math.sin(th) * s.r], i * 3);
      b[i] = s.b[0] + (s.b[1] - s.b[0]) * rand() ** 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aB', new THREE.BufferAttribute(b, 1));
    const pts = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: STAR_VS, fragmentShader: STAR_FS, transparent: true, depthWrite: false,
      uniforms: { uSize: { value: s.size * pr }, uColor: { value: color('--star') }, uFade: { value: 1 } } }));
    pts.frustumCulled = false; world.stars.add(pts);
  }
  scene.add(world.stars, world.earth, world.halo);
  const loader = new THREE.TextureLoader();
  const load = url => new Promise((res, rej) => loader.load(url, t => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 1; res(t); }, undefined, rej));
  Promise.all([load(TEXTURES.day), load(TEXTURES.night)])
    .then(([d, n]) => { earthU.uDay.value = d; earthU.uNight.value = n; requestRender(); })
    .catch(e => console.error('[simulator] Earth textures failed to load', e));
}

// Low-precision sun direction in ECI (Astronomical Almanac formula, about 0.01 degrees), for day and night.
function sunDirection(date) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const rad = Math.PI / 180;
  const L = 280.460 + 0.9856474 * n, g = (357.528 + 0.9856003 * n) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad, eps = (23.439 - 0.0000004 * n) * rad;
  return { x: Math.cos(lambda), y: Math.cos(eps) * Math.sin(lambda), z: Math.sin(eps) * Math.sin(lambda) };
}
// Sun and Earth's turn for a date: the texture's longitudes line up with SGP4 positions (rotation.y = sidereal angle).
function setSun(date) {
  if (!gl) return;
  toScene(sunDirection(date), earthU.uSun.value).normalize();
  world.earth.rotation.y = gstime(date);
}

// ---------- Step 01: real fleets ----------
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
      const ring = new THREE.LineLoop(circle(km), new THREE.LineBasicMaterial({ color: color(f.token), transparent: true, opacity: 0.7 }));
      m1.group.add(ring);
    }
  }
}

function legend1() {
  const ul = $('legend-1'); ul.replaceChildren();
  const counts = {};
  for (let i = 0; i < m1.count; i++) counts[m1.sats[i].GROUP] = (counts[m1.sats[i].GROUP] || 0) + 1;
  for (const [id, f] of Object.entries(FLEETS)) {
    const li = document.createElement('li'); li.style.setProperty('--c', f.hex);
    li.textContent = `${f.label}${counts[id] ? ` ${fmt(counts[id])}` : ''}`; ul.append(li);
  }
  for (const f of FILED) {
    const li = document.createElement('li'); li.className = 'ring'; li.style.setProperty('--c', `var(${f.token})`);
    li.textContent = f.short; ul.append(li);
  }
}
function filedNotes() {
  const ul = $('filed-notes'); ul.replaceChildren();
  for (const f of FILED) {
    const li = document.createElement('li');
    const a = document.createElement('a'); a.href = f.src; a.rel = 'noopener'; a.textContent = f.srcName;
    li.append(`${f.label}: filed, not launched (`, a, ').'); ul.append(li);
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
  p.append(`Step 01: CelesTrak GP data, ${snapshotDate(m1.meta)}, propagated with SGP4; accuracy drifts by kilometres a day. `
    + (thinned.length ? `${thinned.join('; ')}. ` : '')
    + 'Loaded from this site; your browser makes no request to CelesTrak. ', a, '.');
}

function counter1() {
  if (!m1.meta) return;
  const listed = Object.keys(FLEETS).reduce((s, id) => s + ((m1.meta.groups[id] && m1.meta.groups[id].count_fetched) || 0), 0);
  setText($('count-1'), fmt(listed));
  setText($('snap-date'), `satellites · CelesTrak ${snapshotDate(m1.meta)}`);
}

async function loadSnapshot() {
  if (m1.loaded || m1.loading) return;
  m1.loading = true;
  $('status').textContent = 'Loading';
  let meta;
  try {
    const res = await fetch(SNAPSHOT_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    meta = await res.json();
  } catch (e) {
    m1.loading = false;
    $('status').textContent = "Couldn't load the snapshot. Reload to try again.";
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
    m1.sats.forEach((s, i) => new THREE.Color(FLEETS[s.GROUP].hex).toArray(colors, i * 3));
    m1.geom = new THREE.BufferGeometry();
    m1.geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    m1.geom.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    m1.points = new THREE.Points(m1.geom, new THREE.ShaderMaterial({ vertexShader: SAT_VS, fragmentShader: SAT_FS, transparent: true, depthWrite: false,
      uniforms: { uSize: { value: 4.5 * pr } } }));
    m1.points.frustumCulled = false; m1.points.renderOrder = 5;
    m1.geom.setDrawRange(0, m1.count);   // raycasting follows the draw range too
    m1.group.add(m1.points);
    m1.sel = markers(1, pr);
    m1.sel.visible = false; m1.group.add(m1.sel);
  }
  propagateAll(new Date(m1.t));
  m1.loaded = true; m1.loading = false;
  $('status').textContent = '';
  showAllLabel(); legend1(); dataNote(); counter1(); fillFleetPick(); summarize(); requestRender();
}

function showAllLabel() {
  const b = $('show-all');
  b.setAttribute('aria-pressed', String(m1.showAll));
  b.textContent = m1.loaded ? `All ${fmt(m1.sats.length)}` : 'All';
}

function setShowAll(on) {
  m1.showAll = on;
  showAllLabel();
  if (!m1.loaded) return;
  m1.count = on ? m1.sats.length : m1.defaultCount;
  m1.heights.fill(NaN, m1.count);
  if (m1.geom) m1.geom.setDrawRange(0, m1.count);
  if (m1.selIndex >= m1.count) { m1.selIndex = -1; if (m1.sel) m1.sel.visible = false; $('info').textContent = 'Click a satellite'; }
  propagateAll(new Date(m1.t));
  legend1(); dataNote(); summarize(); requestRender();
}

const tmp = new THREE.Vector3();
const SEL_COLOR = new THREE.Color(token('--sim-ink') || '#e9edf2');
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
  if (text) $('info').textContent = `${s.OBJECT_NAME} · NORAD ${s.NORAD_CAT_ID} · ${FLEETS[s.GROUP].label} · `
    + (Number.isNaN(h) ? 'no position now' : `${fmt(h)} km`) + ` · ${inc.toFixed(1)}°`;
  if (m1.sel) {
    const p = m1.geom.attributes.position.array;
    setMark(m1.sel, 0, tmp.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]), SEL_COLOR, 22);
    m1.sel.visible = !Number.isNaN(h);
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
  setText($('clock-1'), `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC · ×${fmt(m1.speed)}${m1.playing ? '' : ' · paused'}`);
}

// ---------- Step 02: one dead satellite ----------
const m2 = { group: gl ? new THREE.Group() : null, years: 0, playing: false, speed: 1, shape: null, textAt: -Infinity,
  L: null, angleA: 0, angleB: Math.PI, rings: {}, shells: {} };
const C2 = { a: '--sim-low', b: '--sim-target', five: '--sim-five' };
if (gl) {
  scene.add(m2.group); m2.group.visible = false;
  for (const k of ['a', 'b', 'five']) {
    const mat = k === 'five' ? new THREE.LineDashedMaterial({ dashSize: 0.25, gapSize: 0.18, color: color(C2[k]) }) : new THREE.LineBasicMaterial({ color: color(C2[k]) });
    const line = new THREE.LineLoop(k === 'five' ? circle(MIN_ALT_KM) : unitCircle(), mat); line.renderOrder = 4; m2.rings[k] = line; m2.group.add(line);
  }
  for (const k of ['a', 'b']) { m2.shells[k] = makeShell(1, color(C2[k]), 0.16); m2.group.add(m2.shells[k]); }
  m2.dots = markers(2, pr); m2.group.add(m2.dots);
  m2.dotColor = { a: color(C2.a), b: color(C2.b) };
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
function fallText(start, years, approx = false, short = false) {
  const n = `${approx ? 'about ' : ''}${yrs(years)} ${short ? 'yr' : 'years'}`;
  if (start <= TABLE_TOP_KM) return n;
  return (years >= MAX_CLOCK_YEARS ? `more than ${fmt(MAX_CLOCK_YEARS)} ${short ? 'yr' : 'years'}` : n)
    + (short ? ` (model unreliable above ${fmt(TABLE_TOP_KM)} km)` : ` (the model isn't reliable above ${fmt(TABLE_TOP_KM)} km)`);
}
function satLine(name, start, h, fallYears) {
  if (h === null) return `${name} · ${fmt(start)} km · burned up after ${yrs(fallYears)} yr`;
  return `${name} · ${fmt(start)} → ${fmt(h)} km · falls in ${fallText(start, fallYears, false, true)}`;
}

// While playing, the readouts and the slider are written at most TEXT_HZ times a second (the scene still moves every
// frame); every other caller writes them at once.
function update2(playingFrame = false) {
  const ha = heightAt(m2.L, m2.a, m2.years), hb = heightAt(m2.L, m2.b, m2.years);
  const now = performance.now();
  if (!playingFrame || now - m2.textAt >= 1000 / TEXT_HZ) {
    m2.textAt = now;
    setText($('sat-a'), satLine('A', m2.a, ha, m2.L[m2.a]));
    setText($('sat-b'), satLine('B', m2.b, hb, m2.L[m2.b]));
    setText($('clock-2'), yrs(m2.years));
    $('years').value = String(m2.years);
    const vt = `${yrs(m2.years)} years`;
    if ($('years').getAttribute('aria-valuetext') !== vt) $('years').setAttribute('aria-valuetext', vt);
  }
  if (!gl) return;
  [[ha, m2.angleA, 'a', 0], [hb, m2.angleB, 'b', 1]].forEach(([h, ang, k, j]) => {
    const ring = m2.rings[k], shell = m2.shells[k];
    if (h === null) { ring.visible = shell.visible = false; setMark(m2.dots, j, tmp.set(0, 0, 0), m2.dotColor[k], 0); return; }
    const r = (R_EARTH_KM + HEIGHT_EXAGGERATION * h) / UNIT_KM;
    ring.visible = shell.visible = true; ring.scale.setScalar(r); shell.scale.setScalar(r);   // a and b rings are unit circles
    setMark(m2.dots, j, tmp.set(Math.cos(ang) * r, 0, Math.sin(ang) * r), m2.dotColor[k], 20);
  });
  requestRender();
}

// ---------- Steps 03 to 05: concepts ----------
const conc = { t: 0, playing: false, tug: null, wait: null, fuel: -1, day: -1, caption: '' };
if (gl) {
  const cc = { station: color('--sim-station'), target: color('--sim-target'), ghost: color('--sim-ghost'), ink: color('--sim-ink') };
  conc.tug = createTug(cc, pr); conc.wait = createWaitBurn(cc, pr);
  conc.tug.group.visible = conc.wait.group.visible = false;
  scene.add(conc.tug.group, conc.wait.group);
}
const KEYLINES = {
  3: [['dot', '--sim-station', 'Station'], ['', '--sim-station', 'Tug'], ['dot', '--sim-target', 'Retiree'], ['dash', '--sim-target', '+150 km / −100 km']],
  4: [],
  5: [['', '--sim-target', 'Target plane'], ['', '--sim-station', 'Tug plane'], ['dash', '--sim-ghost', 'Start']],
};
function keyline(n) {
  const ul = $('keyline'); ul.replaceChildren();
  for (const [cls, tok, text] of KEYLINES[n] || []) { const li = document.createElement('li'); if (cls) li.className = cls; li.style.setProperty('--c', `var(${tok})`); li.textContent = text; ul.append(li); }
}
function setCaption(s) { if (conc.caption !== s) { conc.caption = s; $('caption').textContent = s; } }
// Draw the concept step at conc.t and write its counters (only when they change).
function updateConcept() {
  if (mode === 3 && conc.tug) {
    const st = conc.tug.update(conc.t);
    const day = Math.round(st.p * 50);
    if (day !== conc.day) { conc.day = day; $('tug-day').textContent = String(day); }
    const f = Math.round(st.fuel * 100) / 100;
    if (f !== conc.fuel) { conc.fuel = f; $('tug-fuel').style.setProperty('--f', String(f)); }
    setCaption(st.caption);
  } else if (mode === 5 && conc.wait) {
    const st = conc.wait.update(conc.t);
    setCaption(st.caption);
  } else setCaption('');
}
function setConceptPlaying(on) {
  conc.playing = on;
  $('play-c').textContent = on ? 'Pause' : 'Play';
  mc.classList.toggle('playing', on && mode >= 3);
  requestRender();
}

// ---------- Summary ----------
let mode = 1;
function summarize() {
  const out = $('summary');
  if (mode === 1) {
    if (!m1.loaded) { out.textContent = m1.loading ? 'Loading the satellite snapshot.' : 'The satellite snapshot did not load.'; return; }
    const parts = Object.entries(FLEETS).map(([id, f]) => {
      const hs = []; for (let i = 0; i < m1.count; i++) if (m1.sats[i].GROUP === id && !Number.isNaN(m1.heights[i])) hs.push(m1.heights[i]);
      return `${f.label} ${fmt(hs.length)}, median height ${fmt(median(hs))} km`;
    });
    out.textContent = `Step 01, real fleets. Satellites from the CelesTrak snapshot of ${snapshotDate(m1.meta)}, placed with SGP4 for ${new Date(m1.t).toISOString().slice(0, 16).replace('T', ' ')} UTC: `
      + parts.join('; ') + `. ${fmt(m1.failed)} ${m1.failed === 1 ? "record has no position at that time and isn't" : "records have no position at that time and aren't"} drawn. `
      + 'Rings mark filed fleets with no satellites up yet: Starcloud at 600 to 850 km and SpaceX Starmind at about 325 and 475 km. '
      + 'The lit half of Earth faces the sun at that time.';
  } else if (mode === 2) {
    const sunName = { 3: 'an active', 1: 'an average', 0.3: 'a quiet' }[m2.sun] || 'an average';
    const five = m2.five === null ? 'From every height up to 1,200 km it falls within 5 years.'
      : m2.five <= REENTRY + 1 ? 'It misses the 5-year limit from every height shown.'
      : `It falls within 5 years from below about ${fmt(m2.five)} km.`;
    out.textContent = `Step 02, when a satellite dies. A dead "${m2.shape}" satellite (${m2.mA.toFixed(1)} kg per m² facing drag) with ${sunName} sun: from ${fmt(m2.a)} km it falls in ${fallText(m2.a, m2.L[m2.a], true)}, `
      + `from ${fmt(m2.b)} km in ${fallText(m2.b, m2.L[m2.b], true)}. ${five} Planner model, not checked by a spacecraft engineer.`;
  } else if (mode === 3) {
    out.textContent = 'Step 03, tug mission. Concept, not built. A tug leaves a station at 700 km, sun-synchronous, fetches a 700 kg retiree from the same plane, '
      + '150 km above or 100 km below, and tows it back, one at a time: about 75-170 m/s each way, about 12-18 kg of xenon per round trip, about 50 days per round trip (the day counter is sped up). '
      + 'Cost: about $18.6M per satellite (our model); about $3M per satellite at best (our model). Parts worth $46k-$116k at $200-500/kg launch prices. '
      + "At today's estimates it doesn't pay. This only works if fleets exist in the station's plane and keep their retirees up instead of de-orbiting them; those fleets don't exist yet.";
  } else if (mode === 4) {
    out.textContent = 'Step 04, station workcell. Concept, not built. A retired satellite docks, is inspected, and is sorted three ways: '
      + 'a data node, parts, or scrap. We have no sourced split between the three, so the drawing shows no counts. Robotic harvesting in orbit has never been done.';
  } else {
    out.textContent = "Step 05, wait or burn. Concept, not built. Two sun-synchronous planes with a 45° node gap. Turning the tug's plane with its engine now costs about 5.7 km/s. "
      + "Waiting in a lower drift orbit lets Earth's bulge (J2) turn the plane into line: 0.27-0.34 km/s each way after about a year. "
      + 'The gap is still there on the way back, so it is paid twice: once out, once back; 2-4 years per round trip. Waiting closes a node gap, not a tilt gap.';
  }
}

function setPlayLabels() {
  $('play-1').textContent = m1.playing ? 'Pause' : 'Play';
  $('play-2').textContent = m2.playing ? 'Pause' : 'Play';
}

// ---------- Steps ----------
const DEFAULT_CAMERA = { 1: [14, 9, 22], 2: [14, 9, 22], 3: conc.tug ? conc.tug.cameraPos.toArray() : [4, 15, 23], 4: [14, 9, 22], 5: conc.wait ? conc.wait.cameraPos.toArray() : [19, 9, 19] };
const savedCamera = {};
function setStep(n, writeHash = true) {
  n = Math.min(LAST_STEP, Math.max(1, n));
  if (gl && mode !== n) { savedCamera[mode] = camera.position.toArray(); camera.position.fromArray(savedCamera[n] || DEFAULT_CAMERA[n]); controls.update(); }
  mode = n;
  const s = STEPS[n];
  mc.dataset.step = String(n); mc.dataset.kind = s.kind;
  setText($('step-num'), String(n).padStart(2, '0')); setText($('step-name'), s.name); setText($('foot-src'), s.src);
  document.querySelectorAll('#rail button').forEach(b => { if (Number(b.dataset.step) === n) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
  if (gl) {
    m1.group.visible = n === 1; m2.group.visible = n === 2;
    conc.tug.group.visible = n === 3; conc.wait.group.visible = n === 5;
    world.earth.visible = world.halo.visible = n !== 4;
  }
  if (n === 1) { setSun(new Date(m1.t)); loadSnapshot(); } else { $('status').textContent = ''; setSun(new Date(FIXED_DATE)); }
  if (n >= 3) {
    const still = reduceMotion.matches;
    conc.t = still ? (n === 3 ? conc.tug?.stillT : n === 5 ? conc.wait?.stillT : 0) || 0 : 0;
    conc.day = -1; conc.fuel = -1;
    setConceptPlaying(!still);
  } else mc.classList.remove('playing');
  keyline(n); updateConcept();
  if (writeHash) history.replaceState(null, '', location.pathname + (n === 2 ? '#' + LINK_IDS[m2.shape] : n === 1 ? '' : '#' + s.hash));
  summarize(); setPlayLabels(); clock1(); requestRender();
}

function applyHash() {
  const h = location.hash.slice(1).toLowerCase();
  if (Object.hasOwn(STEP_BY_HASH, h)) { setStep(STEP_BY_HASH[h], false); return; }
  const name = BY_LINK_ID[h];
  if (name) {
    $('shape').value = name;
    const alt = clampAlt(PRESETS[name].alt);
    $('alt-a').value = String(alt);
    $('alt-b').value = String(alt <= (550 + 800) / 2 ? 800 : 550);
    m2.years = 0; recompute2(); setStep(2, false);
  } else setStep(1, false);
}

// ---------- Tour: each step for TOUR_STEP_MS with its own animation running, then the next; wraps after 05 ----------
const tour = { on: false, timer: 0 };
// Under reduced motion the tour only changes step: every step stays a still frame until the reader presses Play.
function startStepMotion() {
  if (reduceMotion.matches) return;
  if (mode === 1 && !m1.playing) { m1.playing = true; setPlayLabels(); clock1(); }
  if (mode === 2) { m2.years = 0; m2.playing = true; setPlayLabels(); update2(); }
  if (mode >= 3 && !conc.playing) setConceptPlaying(true);
  requestRender();
}
function armTour() {
  clearTimeout(tour.timer); tour.timer = 0;
  if (!tour.on || document.hidden) return;
  tour.timer = setTimeout(() => { setStep(mode >= LAST_STEP ? 1 : mode + 1); startStepMotion(); armTour(); }, TOUR_STEP_MS);
}
function setTour(on) {
  tour.on = on;
  $('tour').setAttribute('aria-pressed', String(on)); $('tour-label').textContent = on ? 'Pause' : 'Tour';
  if (on) startStepMotion();
  armTour();
}
// A step chosen by hand keeps the tour going from there, with a full dwell.
function goStep(n) { setStep(n); if (tour.on) { startStepMotion(); armTour(); } }

// ---------- UTC clock in the top bar: once a second, only while the page is visible ----------
let utcTimer = 0;
function tickUtc() { setText($('utc'), new Date().toISOString().slice(11, 19)); }
function startUtc() { clearInterval(utcTimer); tickUtc(); utcTimer = setInterval(tickUtc, 1000); }

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
  if (!gl || pending || document.hidden || !onScreen) return;
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
    m1.credit = Math.min(MAX_PROPAGATIONS_PER_FRAME, m1.credit + Math.min(m1.count * POSITION_HZ, MAX_PROPAGATIONS_PER_S) * dt);
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
  // 04 is CSS on the page's SVG: the canvas behind it draws once and then rests.
  if ((mode === 3 || mode === 5) && conc.playing) { conc.t += dt; updateConcept(); moving = true; }
  const damping = controls.update();
  renderer.render(scene, camera);
  pending = false;
  if (moving || damping) requestRender(); else last = 0;
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopLoop(); clearInterval(utcTimer); clearTimeout(tour.timer); }
  else { requestRender(); startUtc(); armTour(); }
});
if (gl) new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; if (onScreen) requestRender(); else stopLoop(); }).observe($('stage'));

// ---------- Resize, input ----------
function resize() {
  if (!gl) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); requestRender();
}
if (gl) { new ResizeObserver(resize).observe(canvas); controls.addEventListener('change', requestRender); }

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
// ← → step through the console anywhere else on the page, except inside a field, a menu or the 3D view.
document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const t = e.target;
  if (t === canvas || (t instanceof Element && t.closest('input, select, textarea, [contenteditable]'))) return;
  e.preventDefault();
  goStep(mode + (e.key === 'ArrowRight' ? 1 : -1));
});

// Click (not drag) on a satellite in step 01.
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

document.querySelectorAll('#rail button').forEach(b => b.addEventListener('click', () => goStep(Number(b.dataset.step))));
$('tour').addEventListener('click', () => setTour(!tour.on));
$('play-1').addEventListener('click', () => { m1.playing = !m1.playing; setPlayLabels(); clock1(); requestRender(); });
$('now-1').addEventListener('click', () => { m1.t = Date.now(); if (m1.loaded) { propagateAll(new Date(m1.t)); summarize(); } setSun(new Date(m1.t)); clock1(); if (m1.selIndex >= 0) showSatellite(m1.selIndex); requestRender(); });
$('speed-1').addEventListener('change', e => { m1.speed = Number(e.target.value); clock1(); });
$('next-sat').addEventListener('click', nextSatellite);
$('next-sat').after(Object.assign(document.createElement('button'), { className: 'ctl', type: 'button', id: 'show-all', textContent: 'All' }));
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
$('play-c').addEventListener('click', () => setConceptPlaying(!conc.playing));
$('reset-c').addEventListener('click', () => { conc.t = 0; conc.day = -1; conc.fuel = -1; updateConcept(); requestRender(); });
window.addEventListener('hashchange', applyHash);

// ---------- Start ----------
fillShapes();
$('speed-1').value = String(m1.speed);
buildShells();
legend1();
filedNotes();
recompute2();
setSun(new Date(m1.t));
clock1();
startUtc();
applyHash();
resize();
requestRender();
