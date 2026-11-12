// Home scene for the remake (WQ-026 Track A): Earth with day and night, an atmosphere rim, three star layers,
// the real fleet from the CelesTrak snapshot, and the 550 km vs 800 km retirement moment.
// The page owns all text and labels; this module only draws and reports.
//
//   const scene = await createScene(canvas)   // null when WebGL is missing; the page then stays text on --bg
//   scene.setChapter(id, progress)            // id: hero | retire | simulator | planner | findings | roadmap | about; progress 0..1
//   scene.setPointer(x, y)                    // -1..1 from the viewport centre; once called, window pointermove no longer steers
//   scene.on('pick', fn)                      // {name, norad, operator, color, heightKm, x, y} while a satellite is hovered or tapped, null when cleared
//   scene.on('retire', fn)                    // {shape, lowStartKm, highStartKm, years, lowKm, highKm, lowFallYears, highFallYears, heightScale}
//   scene.on('ready', fn)                     // fleet loaded: same object as scene.info
//   scene.setPlannerPreset(name)              // rings at that planner preset's altitude, framed in the planner chapter
//   scene.pause(), scene.resume()
//   createScene(canvas, { mode: 'page' })     // tool pages: stars and Earth's limb, drawn once and on resize; other calls are no-ops
//   scene.info                                // {snapshotUtc, timeScale, phone, reducedMotion, count, fleets: [{id, label, color, shown, listed}]}
//
// Main-thread budget: SGP4 runs in orbits.worker.js about once a second; between updates each point moves on the GPU
// along its velocity, so a frame is uniforms plus one render.
import * as THREE from 'three';

const UNIT_KM = 1000;                          // 1 scene unit = 1,000 km
const R_EARTH_KM = 6371;
const EARTH_R = R_EARTH_KM / UNIT_KM;
const DAY_MS = 86400000;
const SNAPSHOT_URL = '/assets/data/gp-2026-11-10.json';
const TIME_SCALE = 60;                         // simulated seconds per real second; the page states it
const ORBIT_REFRESH_MS = 1000;                 // ask the worker for fresh positions this often
const PHONE_THIN = { starlink: 6, oneweb: 2 }; // phones draw every Nth record of these fleets (about 1,500 points)
const FPS = { desktop: 60, phone: 30 };
const VSYNC_SLACK_MS = 4;
const MAX_DT_S = 0.1;
const DPR_CAP = 1.5;
const POINTER_YAW_DEG = 3, POINTER_PITCH_DEG = 2;
const CAMERA_EASE = 3.2;                       // 1/s; about 300 ms to most of the way, the section duration
const POINTER_EASE = 2.4;
const FADE_EASE = 2.2;
const PICK_RADIUS_PX = { desktop: 12, phone: 24 };
const TAP_SLOP_PX = 8;
const DRAG_YAW_PER_PX = 0.006;
const HEIGHT_SCALE = 4;                        // retire chapter only: heights drawn 4 times taller than real, as in the simulator
const RETIRE = { low: 550, high: 800, sun: 1 }; // the simulator's "When a satellite dies" defaults: first planner preset, average sun
const RETIRE_PHASES = { holdStart: 0.12, fallEnd: 0.82 }; // progress share: hold, fall, then burn and hold
const RETIRE_LAP_S = 6;                        // one lap of the low shell, for the eye only; speeds are not to scale
const RETIRE_TILT_DEG = 28;                    // the two shells always face the camera at this tilt, so both stay in frame
const RETIRE_FALL_LAPS = 3;                    // laps the low satellite makes while the fall is scrubbed
const RETIRE_BURN_ANGLE = Math.PI / 2 - 0.9;   // where it burns: in front of Earth, lower right, never behind it
const HOVER_PICK_MS = 60;                      // at most one hover pick per this many ms
const TRAIL_POINTS = 90;
const STARS = {                                // three depths: count desktop/phone, size in CSS px, radius, parallax per unit of pointer
  far: { n: [2600, 900], size: 1.0, r: 300, bright: [0.25, 0.6], parallax: 0.004 },
  mid: { n: [700, 260], size: 1.6, r: 260, bright: [0.45, 0.85], parallax: 0.011 },
  near: { n: [140, 60], size: 2.4, r: 220, bright: [0.7, 1.0], parallax: 0.024 },
};
// Fleet colours belong to the scene (the page legend reads them from scene.info), muted so the gold accent stays the one accent.
const FLEETS = {
  'starlink': { label: 'Starlink', color: '#a9c7e2' },
  'oneweb': { label: 'OneWeb', color: '#d9a6a0' },
  'amazon-leo': { label: 'Amazon Leo', color: '#8fd1b0' },
  'planet': { label: 'Planet', color: '#c9c1e6' },
};
// Camera per chapter: start and end pose. dist in units, az and el in degrees (az relative to the sun, so Earth is mostly lit),
// shift moves Earth sideways as a share of the width (+ is right) so text has room. Each end is the next start.
const CHAPTERS = {
  hero: [{ dist: 30, az: 38, el: 16, shift: 0.2 }, { dist: 27, az: 28, el: 15, shift: 0.16 }],
  retire: [{ dist: 27, az: 28, el: 15, shift: 0.16 }, { dist: 36, az: 10, el: 18, shift: 0.1 }],   // eases out as the fall plays so both 4x shells fit
  simulator: [{ dist: 36, az: 10, el: 18, shift: -0.18 }, { dist: 20, az: -14, el: 24, shift: -0.2 }],
  planner: [{ dist: 20, az: -14, el: 24, shift: 0.2 }, { dist: 16, az: -30, el: 28, shift: 0.2 }],
  findings: [{ dist: 16, az: -30, el: 28, shift: 0 }, { dist: 36, az: -48, el: 12, shift: 0 }],
  roadmap: [{ dist: 36, az: -48, el: 12, shift: 0.22 }, { dist: 28, az: -66, el: 6, shift: 0.22 }],
  about: [{ dist: 28, az: -66, el: 6, shift: -0.2 }, { dist: 26, az: -84, el: 12, shift: -0.2 }],
};
const FLEET_OPACITY = { hero: 1, retire: 0.25, simulator: 1, planner: 0.35, findings: 1, roadmap: 0.6, about: 0.45 };
const PICKABLE = new Set(['hero', 'simulator', 'findings']);
const TEXT_TAGS = 'a,button,input,select,textarea,label,p,h1,h2,h3,h4,li,dd,dt,td,th,figcaption,blockquote,pre,code,summary';

const DEG = Math.PI / 180;
const clamp01 = x => Math.min(1, Math.max(0, x));
const ease = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const token = (name, fallback) => (getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);

// Low-precision sun direction in ECI (Astronomical Almanac, about 0.01 degrees), returned in scene axes.
function sunScene(date) {
  const n = date.getTime() / DAY_MS + 2440587.5 - 2451545.0;
  const L = 280.460 + 0.9856474 * n, g = (357.528 + 0.9856003 * n) * DEG;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG, eps = (23.439 - 0.0000004 * n) * DEG;
  const x = Math.cos(lam), y = Math.cos(eps) * Math.sin(lam), z = Math.sin(eps) * Math.sin(lam);
  return new THREE.Vector3(x, z, -y);
}
// Greenwich sidereal angle (IAU 1982, as satellite.js gstime), so the textured Earth turns with the real date.
function gmst(date) {
  const tut1 = (date.getTime() / DAY_MS + 2440587.5 - 2451545.0) / 36525;
  let t = -6.2e-6 * tut1 ** 3 + 0.093104 * tut1 ** 2 + (876600 * 3600 + 8640184.812866) * tut1 + 67310.54841;
  t = ((t * DEG) / 240) % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}
function mulberry32(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

const EARTH_VS = `
varying vec2 vUv; varying vec3 vN; varying vec3 vP;
void main() {
  vUv = uv; vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0); vP = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const EARTH_FS = `
uniform sampler2D uDay; uniform sampler2D uNight; uniform vec3 uSun; uniform vec3 uAtmo; uniform float uFade;
varying vec2 vUv; varying vec3 vN; varying vec3 vP;
void main() {
  vec3 n = normalize(vN), v = normalize(cameraPosition - vP);
  float d = dot(n, uSun);
  vec3 day = texture2D(uDay, vUv).rgb, night = texture2D(uNight, vUv).rgb;
  float lit = smoothstep(-0.06, 0.32, d);
  vec3 col = day * (0.025 + 1.1 * max(d, 0.0));
  float ocean = smoothstep(0.015, 0.08, day.b - day.r);
  col += ocean * pow(max(dot(n, normalize(uSun + v)), 0.0), 70.0) * 0.28 * lit;
  col += night * vec3(1.0, 0.86, 0.66) * (1.0 - lit) * 1.5;
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  col += uAtmo * rim * (0.12 + 0.88 * smoothstep(-0.25, 0.45, d)) * 0.85;
  gl_FragColor = vec4(col, uFade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
// Halo just outside the limb: drawn on the back faces of a slightly larger sphere, brightest at Earth's edge.
const HALO_VS = `
varying vec3 vN; varying vec3 vP;
void main() { vN = normalize(mat3(modelMatrix) * normal); vec4 wp = modelMatrix * vec4(position, 1.0); vP = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;
const HALO_FS = `
uniform vec3 uSun; uniform vec3 uAtmo; uniform float uFade; uniform float uEdge;
varying vec3 vN; varying vec3 vP;
void main() {
  vec3 n = normalize(vN), v = normalize(cameraPosition - vP);
  float g = pow(clamp(-dot(n, v) / uEdge, 0.0, 1.0), 2.2);
  float s = 0.15 + 0.85 * smoothstep(-0.3, 0.6, dot(n, uSun));
  gl_FragColor = vec4(uAtmo * g * s * 0.75 * uFade, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const STAR_VS = `
attribute float aB; uniform float uSize; varying float vB;
void main() { vB = aB; gl_PointSize = uSize; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const STAR_FS = `
uniform vec3 uColor; uniform float uFade; varying float vB;
void main() { float r = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.15, r) * vB * uFade; if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;
// Satellites: position at the last worker update plus velocity times the time since, so motion is smooth between updates.
const SAT_VS = `
attribute vec3 aVel; attribute vec3 aColor; uniform float uDt; uniform float uSize; varying vec3 vC;
void main() {
  vC = aColor;
  vec4 mv = modelViewMatrix * vec4(position + aVel * uDt, 1.0);
  gl_PointSize = dot(position, position) < 1.0 ? 0.0 : uSize * clamp(26.0 / -mv.z, 0.7, 1.7);
  gl_Position = projectionMatrix * mv;
}`;
const SAT_FS = `
uniform float uOpacity; varying vec3 vC;
void main() { float r = length(gl_PointCoord - 0.5) * 2.0; float a = (smoothstep(1.0, 0.55, r) * 0.55 + smoothstep(0.5, 0.0, r) * 0.45) * uOpacity; if (a < 0.01) discard;
  gl_FragColor = vec4(vC, a);
  #include <colorspace_fragment>
}`;
// Marker for one point: a ring (hover, selection) or a soft burst (re-entry).
const MARK_VS = `uniform float uSize; void main() { gl_PointSize = uSize; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RING_FS = `
uniform vec3 uColor; uniform float uOpacity;
void main() { float r = length(gl_PointCoord - 0.5) * 2.0; float a = (smoothstep(0.62, 0.72, r) - smoothstep(0.82, 0.92, r) + smoothstep(0.3, 0.0, r)) * uOpacity; if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;
const BURST_FS = `
uniform vec3 uColor; uniform float uOpacity;
void main() { float r = length(gl_PointCoord - 0.5) * 2.0; float a = pow(clamp(1.0 - r, 0.0, 1.0), 2.0) * uOpacity; if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

// Classic-script globals from the page (model.js, presets.js); undefined when the page did not load them.
const planModel = {
  presets: () => (typeof PRESETS !== 'undefined' ? PRESETS : undefined),
  life: () => (typeof lifetimeYears === 'function' ? lifetimeYears : undefined),
  reentry: () => (typeof REENTRY !== 'undefined' ? REENTRY : undefined),
};

function hasWebGL() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}

function loadTexture(loader, url) {
  return new Promise((resolve, reject) => loader.load(url, t => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; resolve(t); }, undefined, reject));
}

function ringGeometry(radius, segments = 160) {
  const pts = [];
  for (let i = 0; i < segments; i++) { const a = i / segments * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius)); }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

// ---------- Page mode (WQ-030): the quiet background for every page other than home ----------
// createScene(canvas, { mode: 'page' }): the same stars, plus the lit limb of Earth in the lower right corner. No fleet,
// no worker, no snapshot, no picking, no animation: it draws once when the day texture arrives and again after a resize,
// and draws nothing in between (0 frames idle). It starts when the browser is idle, after the page has painted, and
// loads only files home also uses (three.js and the 2k day texture), so a visit from home costs about 13 KB new.
// The page's own CSS (page.css, #space[data-scene-mode="page"]) shows static stars until then, and for good without
// JS, without WebGL, or when the reader asked to save data.
const PAGE = {
  texture: '/assets/scene/earth-day-2k.webp',  // home's phone texture: cached after a home visit
  idleTimeoutMs: 1500,                         // start at the latest this long after page.js asks, even if never idle
  // Where Earth sits: its centre in viewport units (1 = the right or bottom edge), and its radius as a share of the
  // viewport height. Only the upper left of the disc is on screen, so the limb arcs across the corner.
  desktop: { cx: 0.98, cy: -1.12, r: 0.52 },
  phone: { cx: 0.9, cy: -1.12, r: 0.4 },
  // Light from just behind Earth, tilted toward the upper left of the screen: a thin lit crescent on the limb, the rest
  // of the disc in night, so text that scrolls over the corner keeps its contrast. The angle is measured from the line
  // camera to Earth, not fixed in the world: Earth sits far off-axis, so the part on screen is its upper left limb and a
  // fixed world sun from the upper left lights all of it. Larger angle, thicker crescent.
  sunFromBehindDeg: 30,
  // Page text scrolls over the corner, so no Earth or halo pixel may be brighter than relative luminance 0.0311: the
  // most a background can be for caption text (--ink-3 #9199a4) to keep 4.5:1. The shaders cap every pixel below that
  // (0.026 leaves room for 8-bit rounding and the halo at the edge); earthGain then sets how much of the lit crescent's texture shows under it.
  maxLuminance: 0.026,
  earthGain: 0.06,      // share of home's Earth brightness, added on top of the page background colour
  haloMaxLuminance: 0.011, // the halo adds onto the background, so its own cap is lower; checked with the probe
  turnRad: 2.2,                                // which side of Earth faces the camera; for the look only
};

function wantsLessData() {
  try { if (navigator.connection && navigator.connection.saveData) return true; } catch { /* no Network Information API */ }
  return matchMedia('(prefers-reduced-data: reduce)').matches;
}

// Page-mode copies of home's Earth and halo shaders, with only their last line changed: the colour is scaled, put on the
// page background, and capped at a maximum luminance. Home's shaders are not touched. If home's last line ever changes,
// the copy would silently be home's look, so a missing line is an error and the page keeps its CSS stars.
const LUMA = 'vec3(0.2126, 0.7152, 0.0722)';   // WCAG relative luminance weights, applied to linear colour
function pageShader(src, line, replacement) {
  if (!src.includes(line)) { const e = new Error(`[scene] page mode: shader line not found: ${line}`); console.error(e.message); throw e; }
  return 'uniform float uGain; uniform float uMaxL; uniform vec3 uBase;\n' + src.replace(line, replacement);
}
const PAGE_EARTH_FS = () => pageShader(EARTH_FS, 'gl_FragColor = vec4(col, uFade);',
  `col = uBase + col * uGain; col *= min(1.0, uMaxL / max(dot(col, ${LUMA}), 1e-6)); gl_FragColor = vec4(col, 1.0);`);
const PAGE_HALO_FS = () => pageShader(HALO_FS, 'gl_FragColor = vec4(uAtmo * g * s * 0.75 * uFade, 1.0);',
  `vec3 h = uAtmo * g * s * 0.75; h *= min(1.0, uMaxL / max(dot(h, ${LUMA}), 1e-6)); gl_FragColor = vec4(h, 1.0);`);

async function createPageScene(canvas) {
  if (wantsLessData()) return null;
  await new Promise(r => ('requestIdleCallback' in window ? requestIdleCallback(r, { timeout: PAGE.idleTimeoutMs }) : setTimeout(r, 200)));
  const phone = matchMedia('(max-width: 720px), (pointer: coarse)').matches;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100vw', height: '100lvh', display: 'block', zIndex: '0', pointerEvents: 'none' });

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !phone && devicePixelRatio <= 1, alpha: false });
  const pr = Math.min(devicePixelRatio || 1, DPR_CAP);
  renderer.setPixelRatio(pr);
  renderer.setClearColor(new THREE.Color(token('--bg', '#070d14')), 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 800);

  const rand = mulberry32(20261110);   // home's seed: the same sky
  for (const s of Object.values(STARS)) {
    const n = s.n[phone ? 1 : 0], pos = new Float32Array(n * 3), b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = rand() * 2 - 1, th = rand() * Math.PI * 2, k = Math.sqrt(1 - u * u);
      pos.set([k * Math.cos(th) * s.r, u * s.r, k * Math.sin(th) * s.r], i * 3);
      b[i] = s.bright[0] + (s.bright[1] - s.bright[0]) * rand() ** 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aB', new THREE.BufferAttribute(b, 1));
    const pts = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: STAR_VS, fragmentShader: STAR_FS, transparent: true, depthWrite: false,
      uniforms: { uSize: { value: s.size * pr }, uColor: { value: new THREE.Color(token('--star', '#f1f6fc')) }, uFade: { value: 1 } } }));
    pts.frustumCulled = false; scene.add(pts);
  }

  // Earth with home's shader. No night texture is loaded (a black one stands in): the visible limb is the day side.
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); black.needsUpdate = true;
  const sun = new THREE.Vector3();     // set in layout(), relative to where Earth sits on screen
  // Opaque, so the shader's cap is the luminance on screen; it writes depth, so stars behind Earth stay hidden.
  const bgLinear = new THREE.Color(token('--bg', '#070d14'));   // THREE.Color holds linear values
  const earthU = { uDay: { value: black }, uNight: { value: black }, uSun: { value: sun }, uAtmo: { value: new THREE.Color('#6fa8e8') }, uFade: { value: 1 },
    uGain: { value: PAGE.earthGain }, uMaxL: { value: PAGE.maxLuminance }, uBase: { value: new THREE.Vector3(bgLinear.r, bgLinear.g, bgLinear.b) } };
  const earth = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, phone ? 64 : 96, phone ? 32 : 48),
    new THREE.ShaderMaterial({ vertexShader: EARTH_VS, fragmentShader: PAGE_EARTH_FS(), uniforms: earthU }));
  earth.rotation.y = PAGE.turnRad; earth.visible = false; earth.renderOrder = -1;
  const haloR = EARTH_R * 1.045;
  const halo = new THREE.Mesh(new THREE.SphereGeometry(haloR, 64, 32), new THREE.ShaderMaterial({ vertexShader: HALO_VS, fragmentShader: PAGE_HALO_FS(),
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uSun: earthU.uSun, uAtmo: earthU.uAtmo, uFade: { value: 1 }, uEdge: { value: Math.sqrt(1 - (EARTH_R / haloR) ** 2) },
      uGain: { value: 1 }, uMaxL: { value: PAGE.haloMaxLuminance }, uBase: { value: new THREE.Vector3() } } }));
  halo.visible = false;
  scene.add(earth, halo);

  // Camera at the origin looking down -z; Earth placed so its centre lands at (cx, cy) in viewport units.
  function layout() {
    const w = innerWidth, h = innerHeight;
    if (!w || !h) return false;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    const p = phone ? PAGE.phone : PAGE.desktop, t = Math.tan(camera.fov * Math.PI / 360);
    const d = EARTH_R / (p.r * t);           // distance at which the radius fills p.r of the half-height
    earth.position.set(p.cx * d * t * camera.aspect, p.cy * d * t, -d);
    halo.position.copy(earth.position);
    // Sun: the camera-to-Earth direction turned sunFromBehindDeg toward the screen's upper left.
    const back = earth.position.clone().normalize();
    const side = new THREE.Vector3(-1, 1, 0).addScaledVector(back, -back.dot(new THREE.Vector3(-1, 1, 0))).normalize();
    const a = PAGE.sunFromBehindDeg * Math.PI / 180;
    sun.copy(back).multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a)).normalize();
    return true;
  }
  let drawn = false;
  function draw() {
    if (!layout()) return;
    renderer.render(scene, camera);
    // First draw: fade the canvas in over the page's CSS stars (a cut under reduced motion). One extra callback, once.
    if (!drawn) { drawn = true; requestAnimationFrame(() => { if (!reduce) canvas.style.transition = 'opacity var(--dur-section, 200ms) var(--ease-enter, ease-out)'; canvas.style.opacity = '1'; }); }
  }
  // Resizes come in bursts; draw once per animation frame at most, and only after a resize.
  let resizeRaf = 0;
  const onResize = () => { if (!resizeRaf) resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; draw(); }); };
  addEventListener('resize', onResize);

  canvas.style.opacity = '0';
  draw();   // stars at once
  new THREE.TextureLoader().load(PAGE.texture, tex => {
    tex.colorSpace = THREE.SRGBColorSpace; earthU.uDay.value = tex; earth.visible = halo.visible = true; draw();
  }, undefined, e => console.error('[scene] page-mode Earth texture failed to load', e));

  const listeners = {};
  return {
    mode: 'page',
    setChapter() {}, setPointer() {}, setPlannerPreset() {}, pause() {}, resume() {},
    on(evt, fn) { (listeners[evt] ||= []).push(fn); return this; },
    info: { mode: 'page', timeScale: 0, phone, reducedMotion: reduce, count: 0, fleets: [], snapshotUtc: null },
  };
}

export async function createScene(canvas, opts = {}) {
  if (!canvas || !hasWebGL()) return null;
  if (opts.mode === 'page') return createPageScene(canvas);   // tool pages (WQ-030); home never passes a mode
  const phone = matchMedia('(max-width: 720px), (pointer: coarse)').matches;
  const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  let reduce = reduceMQ.matches;
  const kind = phone ? 'phone' : 'desktop';
  const FRAME_MS = 1000 / FPS[kind];

  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100vw', height: '100lvh', display: 'block', zIndex: '0', pointerEvents: 'none', transition: 'opacity var(--dur-section, 200ms) var(--ease-move, linear)' });   // the reduced-motion cross-fade, timed by the site's motion tokens
  if (phone) document.documentElement.style.touchAction = 'pan-y pinch-zoom';   // horizontal drags turn Earth; vertical scroll and zoom stay native

  const colors = {
    bg: new THREE.Color(token('--bg', '#070d14')), star: new THREE.Color(token('--star', '#f1f6fc')),
    accent: new THREE.Color(token('--accent', '#ecbc5e')), low: new THREE.Color(token('--orbit-low', '#fa934e')),
    high: new THREE.Color(token('--orbit-high', '#98cceb')), atmo: new THREE.Color('#6fa8e8'), burst: new THREE.Color('#ffd7a3'),
  };

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !phone && devicePixelRatio <= 1, alpha: false, powerPreference: 'high-performance' });
  const pr = Math.min(devicePixelRatio || 1, DPR_CAP);
  renderer.setPixelRatio(pr);
  renderer.setClearColor(colors.bg, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 800);

  // ---------- Stars: three depths ----------
  const rand = mulberry32(20261110);
  const starLayers = Object.entries(STARS).map(([name, s]) => {
    const n = s.n[phone ? 1 : 0], pos = new Float32Array(n * 3), b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = rand() * 2 - 1, th = rand() * Math.PI * 2, k = Math.sqrt(1 - u * u);
      pos.set([k * Math.cos(th) * s.r, u * s.r, k * Math.sin(th) * s.r], i * 3);
      b[i] = s.bright[0] + (s.bright[1] - s.bright[0]) * rand() ** 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aB', new THREE.BufferAttribute(b, 1));
    const m = new THREE.ShaderMaterial({ vertexShader: STAR_VS, fragmentShader: STAR_FS, transparent: true, depthWrite: false,
      uniforms: { uSize: { value: s.size * pr }, uColor: { value: colors.star }, uFade: { value: 0 } } });
    const pts = new THREE.Points(g, m); pts.frustumCulled = false; pts.renderOrder = 0;
    const group = new THREE.Group(); group.add(pts); scene.add(group);
    return { name, group, m, parallax: s.parallax };
  });

  // ---------- Earth, night lights, atmosphere ----------
  const tex = phone ? '2k' : '4k';
  const loader = new THREE.TextureLoader();
  const earthU = { uDay: { value: null }, uNight: { value: null }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uAtmo: { value: colors.atmo }, uFade: { value: 0 } };
  const earth = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, phone ? 64 : 96, phone ? 32 : 48),
    new THREE.ShaderMaterial({ vertexShader: EARTH_VS, fragmentShader: EARTH_FS, uniforms: earthU, transparent: true }));
  earth.renderOrder = 1; earth.visible = false;
  const haloR = EARTH_R * 1.045;
  const halo = new THREE.Mesh(new THREE.SphereGeometry(haloR, 64, 32), new THREE.ShaderMaterial({ vertexShader: HALO_VS, fragmentShader: HALO_FS,
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uSun: earthU.uSun, uAtmo: earthU.uAtmo, uFade: { value: 0 }, uEdge: { value: Math.sqrt(1 - (EARTH_R / haloR) ** 2) } } }));
  halo.renderOrder = 2; halo.visible = false;
  scene.add(earth, halo);
  Promise.all([loadTexture(loader, `/assets/scene/earth-day-${tex}.webp`), loadTexture(loader, `/assets/scene/earth-night-${tex}.webp`)])
    .then(([d, n]) => { earthU.uDay.value = d; earthU.uNight.value = n; warmUp(); earth.visible = halo.visible = true; state.earthAt = performance.now(); request(); })
    .catch(e => console.error('[scene] Earth textures failed to load', e));

  // ---------- Fleet ----------
  const fleetIds = Object.keys(FLEETS);
  const fleet = { n: 0, geom: null, points: null, names: [], norad: [], groups: null, t0: 0, ready: false, worker: null, lastAsk: -Infinity,
    pos: null, vel: null, opacity: 0, target: 1 };
  const satU = { uDt: { value: 0 }, uSize: { value: (phone ? 3.2 : 2.6) * pr }, uOpacity: { value: 0 } };
  const pick = { i: -1, x: 0, y: 0, height: null, ring: null, mark: null, detailAt: 0, hoverAt: -Infinity };
  const view = { w: innerWidth, h: innerHeight };   // canvas size in CSS px, kept by resize() so per-frame code never reads layout
  {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    pick.mark = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: MARK_VS, fragmentShader: RING_FS, transparent: true, depthTest: false, depthWrite: false,
      uniforms: { uSize: { value: 20 * pr }, uColor: { value: colors.accent }, uOpacity: { value: 1 } } }));
    pick.mark.visible = false; pick.mark.frustumCulled = false; pick.mark.renderOrder = 5;
    pick.ring = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: colors.accent, transparent: true, opacity: 0.55, depthWrite: false }));
    pick.ring.visible = false; pick.ring.frustumCulled = false; pick.ring.renderOrder = 4;
    scene.add(pick.mark, pick.ring);
  }
  function startWorker() {
    let w;
    try { w = new Worker(new URL('./orbits.worker.js', import.meta.url), { type: 'module' }); }
    catch (e) { console.error('[scene] orbit worker unavailable; no satellites drawn', e); return; }
    fleet.worker = w;
    w.onerror = e => console.error('[scene] orbit worker error', e.message || e);
    w.onmessage = ({ data }) => {
      if (data.type === 'meta') onMeta(data);
      else if (data.type === 'at') onPositions(data);
      else if (data.type === 'detail') onDetail(data);
      else if (data.type === 'error') console.error('[scene] orbit worker:', data.message);
    };
    w.postMessage({ type: 'init', url: opts.snapshotUrl || SNAPSHOT_URL, thin: phone ? PHONE_THIN : null });
  }
  function onMeta(m) {
    fleet.n = m.names.length; fleet.names = m.names; fleet.norad = m.norad; fleet.groups = m.groups;
    const col = new Float32Array(fleet.n * 3), c = new THREE.Color();
    for (let i = 0; i < fleet.n; i++) c.set(FLEETS[m.fleets[m.groups[i]]].color).toArray(col, i * 3);
    fleet.geom = new THREE.BufferGeometry();
    fleet.geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(fleet.n * 3), 3));
    fleet.geom.setAttribute('aVel', new THREE.BufferAttribute(new Float32Array(fleet.n * 3), 3));
    fleet.geom.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    fleet.points = new THREE.Points(fleet.geom, new THREE.ShaderMaterial({ vertexShader: SAT_VS, fragmentShader: SAT_FS, uniforms: satU, transparent: true, depthWrite: false }));
    fleet.points.frustumCulled = false; fleet.points.renderOrder = 3; fleet.points.visible = false;
    scene.add(fleet.points); warmUp();
    const shown = {}; for (let i = 0; i < fleet.n; i++) shown[m.fleets[m.groups[i]]] = (shown[m.fleets[m.groups[i]]] || 0) + 1;
    api.info.snapshotUtc = m.snapshotUtc; api.info.count = fleet.n;
    api.info.fleets = fleetIds.map(id => ({ id, label: FLEETS[id].label, color: FLEETS[id].color, shown: shown[id] || 0, listed: m.listed[id] }));
    askPositions();
  }
  function askPositions() { if (fleet.worker && fleet.n) { fleet.lastAsk = performance.now(); fleet.worker.postMessage({ type: 'at', t: state.simT }); } }
  function onPositions({ t, pos, vel }) {
    fleet.pos = pos; fleet.vel = vel; fleet.t0 = t;
    fleet.geom.attributes.position.array.set(pos); fleet.geom.attributes.position.needsUpdate = true;
    fleet.geom.attributes.aVel.array.set(vel); fleet.geom.attributes.aVel.needsUpdate = true;
    if (!fleet.ready) { fleet.ready = true; fleet.points.visible = true; emit('ready', api.info); }
    request();
  }
  function onDetail({ i, heightKm, ring }) {
    if (i !== pick.i) return;
    pick.height = heightKm;
    if (ring) { pick.ring.geometry.dispose(); pick.ring.geometry = new THREE.BufferGeometry(); pick.ring.geometry.setAttribute('position', new THREE.BufferAttribute(ring, 3)); pick.ring.visible = true; }
    emitPick();
    request();
  }

  // ---------- Retire chapter: two dead satellites of one shape, 550 km and 800 km ----------
  const retire = buildRetire();
  function buildRetire() {
    // model.js and presets.js are classic scripts: their top-level const values are global names, not globalThis properties.
    const P = planModel.presets(), life = planModel.life(), REENTRY = planModel.reentry();
    if (!P || typeof life !== 'function' || typeof REENTRY !== 'number') return null;   // the page didn't load model.js and presets.js
    const shape = Object.keys(P)[0], p = P[shape], mA = p.mass / p.area;
    const L = new Float64Array(RETIRE.high + 1);
    for (let h = REENTRY + 1; h <= RETIRE.high; h++) L[h] = life(h, mA, RETIRE.sun);
    const heightAt = (a, t) => {                        // L[a] - L[h] = t, null once it has burned up
      const target = L[a] - t;
      if (target <= 0) return null;
      let lo = REENTRY, hi = a;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (L[mid] <= target) lo = mid; else hi = mid; }
      return lo + (target - L[lo]) / (L[hi] - L[lo]);
    };
    const r = km => (R_EARTH_KM + HEIGHT_SCALE * km) / UNIT_KM;
    const group = new THREE.Group(); group.visible = false; scene.add(group);
    const lineMat = c => new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0, depthWrite: false });
    const shellLow = new THREE.LineLoop(ringGeometry(r(RETIRE.low)), lineMat(colors.low));
    const shellHigh = new THREE.LineLoop(ringGeometry(r(RETIRE.high)), lineMat(colors.high));
    const trail = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_POINTS * 3), 3)), lineMat(colors.low));
    const dot = c => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
      const m = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: MARK_VS, fragmentShader: BURST_FS, transparent: true, depthWrite: false,
        uniforms: { uSize: { value: 16 * pr }, uColor: { value: c }, uOpacity: { value: 0 } } })); m.frustumCulled = false; return m; };
    const lowDot = dot(colors.low), highDot = dot(colors.high), burst = dot(colors.burst);
    for (const o of [shellLow, shellHigh, trail, lowDot, highDot, burst]) o.renderOrder = 3;
    group.add(shellLow, shellHigh, trail, lowDot, highDot, burst);
    return { shape, reentry: REENTRY, L, heightAt, r, group, shellLow, shellHigh, trail, lowDot, highDot, burst, fallLow: L[RETIRE.low], fallHigh: L[RETIRE.high],
      opacity: 0, lastEmit: '' };
  }
  function updateRetire(dt) {
    if (!retire) return;
    const target = state.chapter === 'retire' ? 1 : 0;
    retire.opacity = reduce ? target : ease(retire.opacity, target, FADE_EASE * 1.5, dt);
    retire.group.visible = retire.opacity > 0.01;
    if (!retire.group.visible) return;
    const pr2 = state.chapter === 'retire' ? state.progress : (retire.opacity > 0 ? state.retireLast : 0);
    const pFall = reduce ? 1 : clamp01((pr2 - RETIRE_PHASES.holdStart) / (RETIRE_PHASES.fallEnd - RETIRE_PHASES.holdStart));
    const years = pFall * retire.fallLow;
    const hLow = retire.heightAt(RETIRE.low, years), hHigh = retire.heightAt(RETIRE.high, years);
    retire.group.quaternion.copy(camera.quaternion); retire.group.rotateX(RETIRE_TILT_DEG * DEG);
    // Angle: scroll drives the laps of the fall so the burn always lands at RETIRE_BURN_ANGLE; before the fall starts the pair
    // drifts with time (wrapped to one lap), and that drift is frozen and scrolled away as the fall plays.
    if (!reduce && pFall === 0) state.retireAngle = (state.retireAngle + dt * 2 * Math.PI / RETIRE_LAP_S) % (2 * Math.PI);
    const angLow = RETIRE_BURN_ANGLE - (1 - pFall) * RETIRE_FALL_LAPS * 2 * Math.PI + state.retireAngle * (1 - pFall);
    const angHigh = angLow * Math.pow(retire.r(RETIRE.low) / retire.r(RETIRE.high), 1.5) + 2.1;
    const set = (o, rad, ang) => { const a = o.geometry.attributes.position.array; a[0] = Math.cos(ang) * rad; a[1] = 0; a[2] = Math.sin(ang) * rad; o.geometry.attributes.position.needsUpdate = true; };
    const o = retire.opacity;
    retire.shellLow.material.opacity = 0.35 * o; retire.shellHigh.material.opacity = 0.45 * o;
    if (hHigh !== null) set(retire.highDot, retire.r(hHigh), angHigh);
    retire.highDot.material.uniforms.uOpacity.value = o;
    // Trail: where the low satellite was over the last stretch of its fall, worked out from the same model, so scrubbing back works.
    const tr = retire.trail.geometry.attributes.position.array, span = Math.max(retire.fallLow * 0.18, 1e-6);
    let lastR = null, lastA = angLow;
    for (let k = 0; k < TRAIL_POINTS; k++) {
      const yk = Math.max(0, years - span * k / TRAIL_POINTS), hk = retire.heightAt(RETIRE.low, yk) ?? retire.reentry;
      const ak = angLow - (k / TRAIL_POINTS) * 2.4, rk = retire.r(hk);
      tr[k * 3] = Math.cos(ak) * rk; tr[k * 3 + 1] = 0; tr[k * 3 + 2] = Math.sin(ak) * rk;
      if (k === 0) { lastR = rk; lastA = ak; }
    }
    retire.trail.geometry.attributes.position.needsUpdate = true;
    retire.trail.material.opacity = 0.6 * o * (pFall > 0 ? 1 : 0);
    if (hLow !== null) { set(retire.lowDot, retire.r(hLow), angLow); retire.lowDot.material.uniforms.uOpacity.value = o; retire.burst.material.uniforms.uOpacity.value = 0; }
    else {
      retire.lowDot.material.uniforms.uOpacity.value = 0;
      const pBurn = reduce ? 0.5 : clamp01((pr2 - RETIRE_PHASES.fallEnd) / (1 - RETIRE_PHASES.fallEnd));
      set(retire.burst, lastR, lastA);
      retire.burst.material.uniforms.uSize.value = (14 + 46 * pBurn) * pr;
      retire.burst.material.uniforms.uOpacity.value = o * (1 - pBurn) * 0.9 + (reduce ? 0.4 : 0);
    }
    const s = { shape: retire.shape, lowStartKm: RETIRE.low, highStartKm: RETIRE.high, years,
      lowKm: hLow, highKm: hHigh, lowFallYears: retire.fallLow, highFallYears: retire.fallHigh, heightScale: HEIGHT_SCALE };
    const key = `${years.toFixed(3)}|${hLow === null}`;
    if (key !== retire.lastEmit) { retire.lastEmit = key; emit('retire', s); }
  }

  // ---------- Planner chapter: the chosen preset's altitude as three rings, to scale ----------
  const planner = { group: new THREE.Group(), opacity: 0 };
  planner.group.visible = false; scene.add(planner.group);
  function setPlannerPreset(name) {
    const P = planModel.presets(), p = P && P[name];
    planner.group.clear();
    if (!p) return;
    const geo = ringGeometry((R_EARTH_KM + p.alt) / UNIT_KM);
    for (const tilt of [0, 60, -60]) {
      const ring = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: colors.high, transparent: true, opacity: 0, depthWrite: false }));
      ring.rotation.x = tilt * DEG; ring.renderOrder = 3; planner.group.add(ring);
    }
    request();
  }
  function updatePlanner(dt) {
    const target = state.chapter === 'planner' ? 1 : 0;
    planner.opacity = reduce ? target : ease(planner.opacity, target, FADE_EASE * 1.5, dt);
    planner.group.visible = planner.opacity > 0.01;
    for (const ring of planner.group.children) ring.material.opacity = 0.5 * planner.opacity;
  }

  // ---------- State, camera ----------
  const state = { chapter: 'hero', progress: 0, retireLast: 0, retireAngle: 0, simT: Date.now(), startAt: performance.now(), earthAt: 0,
    cam: { ...CHAPTERS.hero[0] }, pointer: { x: 0, y: 0, ex: 0, ey: 0, external: false }, dragYaw: 0, paused: false, sunAz: 0 };
  const sun0 = sunScene(new Date(state.simT));
  state.sunAz = Math.atan2(sun0.x, sun0.z) / DEG;     // camera azimuths are relative to this, so Earth stays mostly lit
  function poseFor(id, p) {
    const c = CHAPTERS[id] || CHAPTERS.hero, a = c[0], b = c[1], t = reduce ? 0.5 : clamp01(p);   // reduced motion: one still view per chapter
    return { dist: a.dist + (b.dist - a.dist) * t, az: a.az + (b.az - a.az) * t, el: a.el + (b.el - a.el) * t, shift: a.shift + (b.shift - a.shift) * t };
  }
  function applyCamera() {
    const w = view.w, h = view.h, aspect = w / h;
    const narrow = aspect < 0.9;
    const dist = state.cam.dist * (narrow ? Math.max(1, 1.05 / aspect) : 1);
    const az = (state.sunAz + state.cam.az + state.pointer.ex * POINTER_YAW_DEG) * DEG + state.dragYaw;
    const el = (state.cam.el + state.pointer.ey * POINTER_PITCH_DEG) * DEG;
    camera.position.set(dist * Math.cos(el) * Math.sin(az), dist * Math.sin(el), dist * Math.cos(el) * Math.cos(az));
    camera.lookAt(0, 0, 0);
    const shift = narrow ? 0 : state.cam.shift;
    camera.setViewOffset(w, h, -shift * w, 0, w, h);
  }

  // ---------- Shader warm-up ----------
  // three.js builds a program the first time a material is drawn, and the first draw also waits for the driver to finish it:
  // about 200 ms in SwiftShader when the hover marker or a chapter's objects first appear. So: compile every material
  // (compileAsync visits hidden objects too), and once that is done draw one frame with everything shown, then the real frame
  // straight after in the same task, so the warm-up frame is never presented.
  function warmUp() {
    renderer.compileAsync(scene, camera).then(() => {
      if (state.paused || document.hidden) return;
      const hidden = [];
      scene.traverse(o => { if (!o.visible) { hidden.push(o); o.visible = true; } });
      try { renderer.render(scene, camera); } finally { for (const o of hidden) o.visible = false; }
      renderer.render(scene, camera);
    }).catch(e => console.error('[scene] shader warm-up failed', e));
  }

  // ---------- Events ----------
  const listeners = {};
  function emit(name, v) { for (const fn of listeners[name] || []) { try { fn(v); } catch (e) { console.error(`[scene] ${name} listener failed`, e); } } }
  function emitPick() {
    if (pick.i < 0) { emit('pick', null); return; }
    const g = fleet.groups[pick.i], id = fleetIds[g];
    emit('pick', { name: fleet.names[pick.i], norad: fleet.norad[pick.i], operator: FLEETS[id].label, color: FLEETS[id].color,
      heightKm: pick.height, x: pick.x, y: pick.y });
  }

  // ---------- Picking: project the moving points on demand (pointer moves, taps), never every frame for all ----------
  const v3 = new THREE.Vector3();
  function satWorld(i, out) {
    const dt = (state.simT - fleet.t0) / 1000, p = fleet.pos, v = fleet.vel;
    return out.set(p[i * 3] + v[i * 3] * dt, p[i * 3 + 1] + v[i * 3 + 1] * dt, p[i * 3 + 2] + v[i * 3 + 2] * dt);
  }
  function occluded(p) {   // is Earth between the camera and p?
    const c = camera.position, dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
    const t = -(c.x * dx + c.y * dy + c.z * dz) / (dx * dx + dy * dy + dz * dz);
    if (t <= 0 || t >= 1) return false;
    return Math.hypot(c.x + dx * t, c.y + dy * t, c.z + dz * t) < EARTH_R;
  }
  function toScreen(p) {
    v3.copy(p).project(camera);
    return { x: (v3.x + 1) / 2 * view.w, y: (1 - v3.y) / 2 * view.h, front: v3.z < 1 };
  }
  // One view-projection matrix, then plain arithmetic per point: about 5,000 points cost well under a millisecond.
  const vp = new THREE.Matrix4(), pw = new THREE.Vector3();
  function pickAt(px, py) {
    if (!fleet.ready || !PICKABLE.has(state.chapter) || fleet.opacity < 0.5) return -1;
    camera.updateMatrixWorld(); vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const e = vp.elements, P = fleet.pos, V = fleet.vel, dt = (state.simT - fleet.t0) / 1000, W = view.w, H = view.h;
    let best = -1, bestD = PICK_RADIUS_PX[kind] ** 2;
    for (let i = 0, o = 0; i < fleet.n; i++, o += 3) {
      if (P[o] === 0 && P[o + 1] === 0 && P[o + 2] === 0) continue;
      const x = P[o] + V[o] * dt, y = P[o + 1] + V[o + 1] * dt, z = P[o + 2] + V[o + 2] * dt;
      const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (cw <= 0) continue;
      const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw + 1) / 2 * W, sy = (1 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw) / 2 * H;
      const d = (sx - px) ** 2 + (sy - py) ** 2;
      if (d < bestD && !occluded(pw.set(x, y, z))) { bestD = d; best = i; }
    }
    return best;
  }
  function select(i) {
    if (i === pick.i) return;
    pick.i = i; pick.height = null; pick.ring.visible = false;
    pick.mark.visible = i >= 0;
    if (i >= 0) { trackPick(); fleet.worker.postMessage({ type: 'detail', i, t: state.simT }); pick.detailAt = performance.now(); }
    emitPick(); request();
  }
  function trackPick() {   // keep the marker and the label position on the moving satellite
    if (pick.i < 0) return;
    satWorld(pick.i, v3); pick.mark.geometry.attributes.position.array.set([v3.x, v3.y, v3.z]); pick.mark.geometry.attributes.position.needsUpdate = true;
    const s = toScreen(v3), hidden = occluded(satWorld(pick.i, new THREE.Vector3())) || !s.front;
    if (hidden) { select(-1); return; }
    if (Math.abs(s.x - pick.x) > 0.5 || Math.abs(s.y - pick.y) > 0.5) { pick.x = s.x; pick.y = s.y; emitPick(); }
  }
  const isText = t => t instanceof Element && !!t.closest(TEXT_TAGS);
  let hoverQueued = null;
  addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse') {
      if (!state.pointer.external) { state.pointer.x = e.clientX / innerWidth * 2 - 1; state.pointer.y = -(e.clientY / innerHeight * 2 - 1); }
      hoverQueued = isText(e.target) ? null : [e.clientX, e.clientY];
      if (isText(e.target) && pick.i >= 0) select(-1);
      request();
    } else if (drag.id === e.pointerId) {
      const dx = e.clientX - drag.x; drag.x = e.clientX; drag.moved += Math.abs(dx);
      if (drag.moved > TAP_SLOP_PX) { state.dragYaw -= dx * DRAG_YAW_PER_PX; request(); }
    }
  }, { passive: true });
  const drag = { id: null, x: 0, moved: 0 };
  addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse' && !isText(e.target)) { drag.id = e.pointerId; drag.x = e.clientX; drag.moved = 0; } }, { passive: true });
  addEventListener('pointerup', e => {
    if (e.pointerType === 'mouse' || drag.id !== e.pointerId) return;
    drag.id = null;
    if (drag.moved <= TAP_SLOP_PX) select(pickAt(e.clientX, e.clientY));
  }, { passive: true });
  addEventListener('pointercancel', e => { if (drag.id === e.pointerId) drag.id = null; }, { passive: true });
  document.documentElement.addEventListener('mouseleave', () => { hoverQueued = null; if (pick.i >= 0) select(-1); });

  // ---------- Loop: one pending frame at most, capped, none while paused or hidden ----------
  let raf = 0, timer = 0, pending = false, due = -Infinity, last = 0;
  function request() {
    if (pending || state.paused || document.hidden) return;
    pending = true;
    const wait = due - VSYNC_SLACK_MS - performance.now();
    if (wait > 0) timer = setTimeout(() => { timer = 0; raf = requestAnimationFrame(frame); }, wait);
    else raf = requestAnimationFrame(frame);
  }
  function stop() { clearTimeout(timer); cancelAnimationFrame(raf); timer = raf = 0; pending = false; last = 0; }
  function frame(ts) {
    raf = 0;
    due = ts - due > FRAME_MS ? ts + FRAME_MS : due + FRAME_MS;
    const dt = last ? Math.min(MAX_DT_S, (ts - last) / 1000) : 0; last = ts;
    const busy = update(dt, ts);
    renderer.render(scene, camera);
    pending = false;
    if (busy) request(); else last = 0;
  }
  function update(dt, ts) {
    let busy = false;
    if (!reduce) { state.simT += dt * 1000 * TIME_SCALE; busy = true; }
    // Fade-in on load: stars first, then Earth, then the fleet.
    const since = (ts - state.startAt) / 1000;
    const starFade = reduce ? 1 : clamp01(since / 0.8);
    for (const L of starLayers) L.m.uniforms.uFade.value = starFade;
    const earthFade = reduce || !state.earthAt ? (state.earthAt ? 1 : 0) : clamp01((ts - state.earthAt) / 1000 - 0.15);
    earthU.uFade.value = earthFade; halo.material.uniforms.uFade.value = earthFade;
    if (starFade < 1 || (state.earthAt && earthFade < 1)) busy = true;
    // Sun, Earth's turn, stars' parallax.
    const date = new Date(state.simT);
    earthU.uSun.value.copy(sunScene(date));
    earth.rotation.y = gmst(date);
    const px = state.pointer, k = reduce ? 1 : 1 - Math.exp(-POINTER_EASE * dt);
    px.ex += (px.x - px.ex) * k; px.ey += (px.y - px.ey) * k;
    if (Math.abs(px.x - px.ex) > 1e-3 || Math.abs(px.y - px.ey) > 1e-3) busy = true;
    for (const L of starLayers) { L.group.rotation.y = -px.ex * L.parallax; L.group.rotation.x = px.ey * L.parallax * 0.6; }
    // Camera toward the chapter pose.
    const goal = poseFor(state.chapter, state.progress);
    for (const key of ['dist', 'az', 'el', 'shift']) {
      state.cam[key] = reduce ? goal[key] : ease(state.cam[key], goal[key], CAMERA_EASE, dt);
      if (Math.abs(state.cam[key] - goal[key]) > 1e-3) busy = true;
    }
    applyCamera();
    // Fleet.
    if (fleet.ready) {
      fleet.target = FLEET_OPACITY[state.chapter] ?? 1;
      fleet.opacity = reduce ? fleet.target : ease(fleet.opacity, fleet.target, FADE_EASE, dt);
      satU.uOpacity.value = fleet.opacity; satU.uDt.value = (state.simT - fleet.t0) / 1000;
      if (!reduce && performance.now() - fleet.lastAsk > ORBIT_REFRESH_MS) askPositions();
      if (hoverQueued && ts - pick.hoverAt >= HOVER_PICK_MS) { pick.hoverAt = ts; select(pickAt(hoverQueued[0], hoverQueued[1])); hoverQueued = null; }
      else if (hoverQueued) busy = true;
      else if (pick.i >= 0 && !PICKABLE.has(state.chapter)) select(-1);
      trackPick();
      if (pick.i >= 0 && !reduce && performance.now() - pick.detailAt > ORBIT_REFRESH_MS) { pick.detailAt = performance.now(); fleet.worker.postMessage({ type: 'detail', i: pick.i, t: state.simT }); }
    }
    updateRetire(dt);
    updatePlanner(dt);
    if (retire && retire.opacity > 0.01 && retire.opacity < 0.99) busy = true;
    if (planner.opacity > 0.01 && planner.opacity < 0.99) busy = true;
    return busy;
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    view.w = w; view.h = h;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); applyCamera(); request();
  }
  new ResizeObserver(resize).observe(canvas);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else request(); });
  new IntersectionObserver(([e]) => { if (e.isIntersecting) request(); else stop(); }).observe(canvas);
  reduceMQ.addEventListener('change', e => { reduce = e.matches; request(); });

  // ---------- API ----------
  const api = {
    info: { snapshotUtc: null, timeScale: TIME_SCALE, phone, reducedMotion: reduce, count: 0, fleets: [] },
    setChapter(id, progress = 0) {
      if (!CHAPTERS[id]) return;
      const changed = id !== state.chapter;
      if (state.chapter === 'retire') state.retireLast = state.progress;
      if (changed && reduce) {   // reduced motion: cross-fade to the new view instead of flying there
        canvas.style.opacity = '0';
        setTimeout(() => { state.chapter = id; state.progress = progress; request(); canvas.style.opacity = '1'; }, parseFloat(token('--dur-section', '200')) || 200);
        return;
      }
      state.chapter = id; state.progress = clamp01(progress); request();
    },
    setPointer(x, y) { state.pointer.external = true; state.pointer.x = Math.max(-1, Math.min(1, x)); state.pointer.y = Math.max(-1, Math.min(1, y)); request(); },
    on(name, fn) { (listeners[name] ||= []).push(fn); if (name === 'ready' && fleet.ready) fn(api.info); return api; },
    setPlannerPreset,
    pause() { state.paused = true; stop(); },
    resume() { state.paused = false; request(); },
  };
  startWorker();
  resize();
  warmUp();
  request();
  return api;
}

// Shared with the simulator page (WQ-028) so its Earth, stars and fleet colours match home. Read-only use; home is unchanged.
export { EARTH_VS, EARTH_FS, HALO_VS, HALO_FS, STAR_VS, STAR_FS, FLEETS as FLEET_COLORS, mulberry32 };
