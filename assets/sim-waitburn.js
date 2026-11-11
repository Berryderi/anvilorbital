// "Wait vs burn" concept mode for /simulator/ (WQ-021). Own module: simulator.js is not changed.
// It adds a third mode next to the two in simulator.js, using only element ids that page already has:
// selecting it hides the 3D stage (whose own loop then stops, since it is off screen) and shows #panel-3;
// selecting mode 1 or 2 hands back. Every number on screen is a "Show" text from the research repo's
// out/sim-numbers.md (rows S1, S2, W1-W5, W9, W10), copied word for word. Drawing is a 2D canvas.
const $ = id => document.getElementById(id);
const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const HASH = '#wait-vs-burn';

// Shown text, word for word from out/sim-numbers.md (row id in each comment).
const T = {
  concept: 'Concept, not built',                                          // S2
  station: '700 km, sun-synchronous',                                     // S1
  gap: '45° node gap',                                                    // W1
  now: 'about 5.7 km/s now',                                              // W2
  wait: '0.27-0.34 km/s each way after about a year',                     // W3
  twice: 'paid twice: once out, once back',                               // W4
  years: '2-4 years per round trip',                                      // W5
  wall: 'Tilt over about 10° is a wall: 1.3-5.8 km/s each way',          // W9
  why: 'Waiting closes a node gap, not a tilt gap.',                      // W10
};
// Bar lengths only (not shown as numbers): W3's high end against W2, km/s.
const BAR_NOW_KMS = 5.7, BAR_WAIT_KMS = 0.34;

// Drawing constants. Planes: SSO, so near-polar; the inclination only shapes the drawing.
const INCL = 98.2 * Math.PI / 180;            // S1's inclination, for the ring shape
const GAP = 45 * Math.PI / 180;               // W1
const VIEW_AZ = 0.35, VIEW_EL = 0.42;         // camera azimuth and elevation, radians: both rings open and apart
const RING = 1.18;                            // ring radius in Earth radii: heights not to scale
const RING_POINTS = 120;
const FRAME_MS = 1000 / 30;                   // the WQ-018 cap: at most 30 frames a second
const LAP_MS = 4000;                          // one visual lap; orbit speed is not to scale
// The run, in ms: step 1 gap, step 2 burn now, step 3 the wait (sped up), step 4 cross, step 5 paid twice.
const STEPS_MS = [1600, 1600, 6000, 1600, 1600];
const RUN_MS = STEPS_MS.reduce((a, b) => a + b, 0);

const panel = $('panel-3'), button = $('mode-3');
if (panel && button) init();

function init() {
  panel.innerHTML = `
    <p class="actions"><span class="tag">${T.concept}</span></p>
    <div class="wb-stage"><canvas id="wb-canvas" role="img"></canvas></div>
    <div class="controls"><button class="ctl" type="button" id="wb-play">Play</button></div>
    <ol class="wb-steps" id="wb-steps">
      <li>The station's plane (${T.station}) and the target's plane: ${T.gap}.</li>
      <li><strong>Burn now:</strong> ${T.now}.</li>
      <li><strong>Or wait:</strong> Earth's bulge slowly turns the tug's plane into line with the target's. Sped up here.</li>
      <li><strong>Then cross:</strong> ${T.wait}.</li>
      <li>A station pays it twice: ${T.twice}. ${T.years}.</li>
    </ol>
    <div class="wb-bars" role="group" aria-label="Speed change needed, one way">
      <p class="label">Speed change needed, one way</p>
      <div class="wb-bar" id="wb-bar-now"><span class="wb-k">Burn now</span><span class="wb-track"><span class="wb-fill" style="--w:100%"></span></span><span class="wb-v">${T.now}</span></div>
      <div class="wb-bar" id="wb-bar-wait"><span class="wb-k">Wait, then cross</span><span class="wb-track"><span class="wb-fill" style="--w:${(100 * BAR_WAIT_KMS / BAR_NOW_KMS).toFixed(1)}%"></span></span><span class="wb-v">${T.wait}</span></div>
    </div>
    <div class="note wb-wall"><p><strong>${T.wall}</strong></p><p>${T.why}</p></div>
    <p class="small">Screening model from our research notes (mechanics lane): circular orbits, first-order J2 (Earth's bulge, which slowly turns orbit planes), no drag. Not checked by a spacecraft engineer. Heights and orbit speed are not to scale, and the wait is sped up.</p>`;
  const canvas = $('wb-canvas'), play = $('wb-play'), steps = [...$('wb-steps').children];
  canvas.setAttribute('aria-label', `Concept animation: Earth with the station's plane, ${T.station}, and a target's plane with a ${T.gap}. The tug's plane turns from the station's into line with the target's while it waits.`);
  const ctx = canvas.getContext('2d');

  // ---------- Geometry: a circular orbit plane drawn with an orthographic camera ----------
  const ca = Math.cos(VIEW_AZ), sa = Math.sin(VIEW_AZ), ce = Math.cos(VIEW_EL), se = Math.sin(VIEW_EL);
  // Point at argument of latitude u on a plane with node angle node; returns screen x, y (Earth radii) and depth (> 0 faces the viewer).
  function project(node, incl, u, r) {
    const cu = Math.cos(u), su = Math.sin(u), cn = Math.cos(node), sn = Math.sin(node), ci = Math.cos(incl), si = Math.sin(incl);
    const x = r * (cn * cu - sn * su * ci), y = r * (sn * cu + cn * su * ci), z = r * su * si;
    const x1 = x * ca + y * sa, y1 = -x * sa + y * ca;
    return { x: x1, y: y1 * se + z * ce, d: -y1 * ce + z * se };
  }
  let W = 0, H = 0, S = 1, cx = 0, cy = 0;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), box = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(box.width)); H = Math.max(1, Math.round(box.height));
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = W / 2; cy = H / 2; S = Math.min(W, H) / 2 / (RING * 1.12);
  }
  const col = {};
  const readColors = () => { for (const k of ['band', 'line', 'muted', 'ink', 'accent', 'series-2', 'warn', 'panel', 'mono', 'edge']) col[k] = token(`--${k}`); };

  // Draws one ring in two passes: back half (dimmer, before Earth) or front half (after Earth).
  function ring(node, color, front, dash, alpha) {
    ctx.strokeStyle = color; ctx.lineWidth = front ? 2 : 1.25; ctx.setLineDash(dash); ctx.globalAlpha = front ? alpha : alpha * 0.45;
    ctx.beginPath(); let pen = false;
    for (let k = 0; k <= RING_POINTS; k++) {
      const p = project(node, INCL, (k / RING_POINTS) * 2 * Math.PI, RING);
      if ((p.d >= 0) === front) { const X = cx + p.x * S, Y = cy - p.y * S; if (pen) ctx.lineTo(X, Y); else { ctx.moveTo(X, Y); pen = true; } } else pen = false;
    }
    ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  function dot(node, u, color, front) {
    const p = project(node, INCL, u, RING); if ((p.d >= 0) !== front) return;
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(cx + p.x * S, cy - p.y * S, front ? 4.5 : 3, 0, 2 * Math.PI); ctx.fill();
  }
  // The node gap: an arc along the equator between two nodes, with its label while the gap is open.
  function gapArc(from, to, label) {
    ctx.strokeStyle = col.warn; ctx.lineWidth = 2; ctx.beginPath(); let pen = false;
    const n = 24;
    for (let k = 0; k <= n; k++) {
      const p = project(from + (to - from) * k / n, 0, 0, RING);
      const X = cx + p.x * S, Y = cy - p.y * S; if (pen) ctx.lineTo(X, Y); else { ctx.moveTo(X, Y); pen = true; }
    }
    ctx.stroke();
    if (label) { const p = project((from + to) / 2, 0, 0, RING); ctx.fillStyle = col.warn; ctx.font = `500 12px ${col.mono}`; ctx.textAlign = 'center'; ctx.fillText(label, cx + p.x * S, cy - p.y * S + 18); ctx.textAlign = 'start'; }
  }

  // ---------- State and drawing ----------
  const NODE_STATION = -GAP / 2, NODE_TARGET = GAP / 2;
  let t = 0;                                   // ms into the run
  const stepAt = ms => { let a = 0; for (let i = 0; i < STEPS_MS.length; i++) { a += STEPS_MS[i]; if (ms < a) return i; } return STEPS_MS.length - 1; };
  const waitShare = ms => { const s = STEPS_MS[0] + STEPS_MS[1]; const k = Math.min(1, Math.max(0, (ms - s) / STEPS_MS[2])); return k * k * (3 - 2 * k); };
  function draw() {
    const k = waitShare(t), tugNode = NODE_STATION + (NODE_TARGET - NODE_STATION) * k, u = (t / LAP_MS) * 2 * Math.PI;
    ctx.clearRect(0, 0, W, H);
    for (const front of [false, true]) {
      if (front) {   // Earth between the back and front halves
        ctx.fillStyle = col.band; ctx.beginPath(); ctx.arc(cx, cy, S, 0, 2 * Math.PI); ctx.fill(); ctx.strokeStyle = col.line; ctx.lineWidth = 1; ctx.stroke();
      }
      ring(NODE_STATION, col.accent, front, [], 0.9);
      ring(NODE_TARGET, col['series-2'], front, [4, 4], 0.9);
      if (k > 0 && k < 1) ring(tugNode, col.ink, front, [], 0.8);
      dot(NODE_STATION, u, col.accent, front);
      dot(NODE_TARGET, u + 1.4, col['series-2'], front);
      if (k > 0) dot(tugNode, u + 0.7, col.ink, front);
    }
    gapArc(k > 0 ? tugNode : NODE_STATION, NODE_TARGET, k === 0 ? T.gap : null);
    ctx.font = `500 12px ${col.mono}`; ctx.textBaseline = 'top';
    ctx.fillStyle = col.accent; ctx.fillText(`Station: ${T.station}`, 8, 8);
    ctx.fillStyle = col['series-2']; ctx.fillText('Target plane', 8, 26);
    if (k > 0) { ctx.fillStyle = col.ink; ctx.fillText(k < 1 ? 'Tug waiting (sped up)' : 'Tug lined up with the target', 8, 44); }
    ctx.textBaseline = 'alphabetic';
    const s = stepAt(t);
    steps.forEach((li, i) => li.toggleAttribute('aria-current', i === s));
    $('wb-bar-now').classList.toggle('on', s === 1);
    $('wb-bar-wait').classList.toggle('on', s >= 3);
  }

  // ---------- Loop: one chain, at most 30 frames a second, paced with a timer so each frame costs one
  // callback; only while mode 3 is shown, the canvas is on screen and the tab is visible; stops at the end of the run.
  let active = false, playing = false, onScreen = false, raf = 0, timer = 0, due = 0, last = 0;
  const wanted = () => active && playing && onScreen && !document.hidden;
  function schedule() {
    if (raf || timer || !wanted()) return;
    const wait = due - performance.now();
    if (wait > 1) timer = setTimeout(() => { timer = 0; raf = requestAnimationFrame(frame); }, wait);
    else raf = requestAnimationFrame(frame);
  }
  function frame(ts) {
    raf = 0;
    if (!wanted()) return;
    due = ts - due > FRAME_MS ? ts + FRAME_MS : due + FRAME_MS;   // fixed schedule; never catch up after a pause
    t = Math.min(RUN_MS, t + (last ? Math.min(ts - last, 100) : 0)); last = ts;
    if (t >= RUN_MS) { playing = false; play.textContent = 'Replay'; }
    draw();
    if (playing) schedule(); else last = 0;
  }
  function stop() { clearTimeout(timer); cancelAnimationFrame(raf); timer = raf = 0; last = 0; }
  function still() { stop(); playing = false; t = RUN_MS; draw(); play.textContent = 'Replay'; }
  function start() {
    if (reduceMotion.matches) { still(); return; }
    stop(); t = 0; playing = true; play.textContent = 'Pause'; due = performance.now(); draw(); schedule();
  }
  play.addEventListener('click', () => {
    if (reduceMotion.matches) return;
    if (playing) { playing = false; stop(); play.textContent = 'Play'; }
    else if (t >= RUN_MS) start();
    else { playing = true; play.textContent = 'Pause'; due = performance.now(); schedule(); }
  });
  play.hidden = reduceMotion.matches;
  reduceMotion.addEventListener('change', () => { play.hidden = reduceMotion.matches; if (active) start(); });
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; if (onScreen) schedule(); else stop(); }).observe(canvas);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else schedule(); });
  new ResizeObserver(() => { if (!active) return; resize(); draw(); }).observe(canvas);

  // ---------- Mode switching, alongside simulator.js ----------
  // Elements the 3D modes own; hidden while mode 3 shows, then put back as they were.
  const summary = $('summary-h') && $('summary-h').closest('section');
  const owned = [$('stage'), $('keys'), $('nogl'), $('panel-1'), $('panel-2'), summary].filter(Boolean);
  let saved = null;
  function enter(writeHash) {
    if (!active) saved = owned.map(el => el.hidden);
    active = true;
    owned.forEach(el => { el.hidden = true; });
    panel.hidden = false;
    for (const n of [1, 2]) $(`mode-${n}`).setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-pressed', 'true');
    if (writeHash) history.replaceState(null, '', location.pathname + HASH);
    readColors(); resize(); start();
  }
  function leave() {
    if (!active) return;
    active = false; playing = false; stop();
    panel.hidden = true; button.setAttribute('aria-pressed', 'false');
    // Mode 1 and 2 panels are already set by simulator.js's own click handler; restore the rest.
    owned.forEach((el, i) => { if (el.id !== 'panel-1' && el.id !== 'panel-2') el.hidden = saved[i]; });
  }
  button.hidden = false;
  button.addEventListener('click', () => enter(true));
  for (const n of [1, 2]) $(`mode-${n}`).addEventListener('click', leave);
  // simulator.js handles the hash first (it registered first) and picks mode 1 for this hash; this runs after.
  window.addEventListener('hashchange', () => { if (location.hash === HASH) enter(false); else leave(); });
  if (location.hash === HASH) enter(false);
}
