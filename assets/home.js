// Home page (WQ-023 PR B): the hero orbit scene and the clickable roadmap track.
// Classic script, loaded after model.js and presets.js: it reads lifetimeYears, REENTRY and PRESETS from them.
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  // ---------- Hero: two satellites of one shape die at the same moment, at 550 km and 800 km ----------
  // Same defaults as the simulator's "When a satellite dies": first planner preset, average sun, 550 and 800 km.
  const SHAPE = Object.keys(PRESETS)[0];
  const LOW_KM = 550, HIGH_KM = 800, SUN = 1;
  const HEIGHT_SCALE = 4;          // heights drawn 4 times taller than real, as in the simulator, so the gap shows
  const EARTH_KM = 6378;
  const FRAME_MS = 1000 / 30;      // at most 30 frames a second, the simulator's cap
  const HOLD_START_MS = 600, FALL_MS = 5200, BURN_MS = 700, HOLD_END_MS = 900;
  const LOOP_MS = HOLD_START_MS + FALL_MS + BURN_MS + HOLD_END_MS;
  const LOW_PERIOD_MS = 2400;      // one visual lap of the low shell; speeds are not to scale
  const TRAIL_MAX = 400;

  const fig = $('hero-scene'), canvas = $('hero-canvas'), line = $('hero-line'), replay = $('hero-replay');
  if (fig && canvas && canvas.getContext) {
    const p = PRESETS[SHAPE], mA = p.mass / p.area;
    // Years to fall from each whole km, straight from the planner model.
    const L = new Float64Array(HIGH_KM + 1);
    for (let h = REENTRY + 1; h <= HIGH_KM; h++) L[h] = lifetimeYears(h, mA, SUN);
    const fallLow = L[LOW_KM], fallHigh = L[HIGH_KM];
    // Height after t years for a satellite that started at whole-km height a: L[a] - L[h] = t.
    const heightAt = (a, t) => {
      const target = L[a] - t;
      if (target <= 0) return REENTRY;
      let lo = REENTRY, hi = a;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (L[mid] <= target) lo = mid; else hi = mid; }
      return lo + (target - L[lo]) / (L[hi] - L[lo]);
    };
    const yrs = y => y >= 100 ? Number(y.toPrecision(2)).toLocaleString('en-US') : y >= 10 ? y.toFixed(0) : y.toFixed(1);
    const text = `A dead ${SHAPE} falls from ${LOW_KM} km in about ${yrs(fallLow)} years, and from ${HIGH_KM} km in about ${yrs(fallHigh)} years. `
      + 'Planner model, average sun, not checked by a spacecraft engineer.';
    line.textContent = text;
    canvas.setAttribute('aria-label', `Animation: Earth with two orbit shells. ${text}`);

    const ctx = canvas.getContext('2d');
    const col = {};
    const readColors = () => { for (const k of ['band', 'line', 'muted', 'ink', 'series-1', 'series-2', 'warn', 'panel', 'mono']) col[k] = token(`--${k}`); };
    let W = 0, H = 0, cx = 0, cy = 0, R = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const box = canvas.getBoundingClientRect();
      W = Math.max(1, Math.round(box.width)); H = Math.max(1, Math.round(box.height));
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = W / 2; cy = H / 2;
      R = Math.min(W, H) / 2 / (1 + HEIGHT_SCALE * HIGH_KM / EARTH_KM) * 0.86;
    };
    const radius = km => R * (1 + HEIGHT_SCALE * km / EARTH_KM);

    // State of one run. elapsed is in ms of animation time.
    let elapsed = 0, angLow = -Math.PI / 2, angHigh = -Math.PI / 2 + 2.2, trail = [], burnAt = null;
    const omega = km => (2 * Math.PI / LOW_PERIOD_MS) * Math.pow(radius(LOW_KM) / radius(km), 1.5);
    const yearsAt = ms => Math.min(fallLow, Math.max(0, (ms - HOLD_START_MS) / FALL_MS) * fallLow);

    function step(dt) {
      elapsed += dt;
      const t = yearsAt(elapsed);
      const hLow = heightAt(LOW_KM, t), hHigh = heightAt(HIGH_KM, t);
      if (burnAt === null) {
        angLow += omega(hLow) * dt;
        trail.push([angLow, hLow]);   // angle and height, so a resize redraws it in place
        if (trail.length > TRAIL_MAX) trail.shift();
        if (t >= fallLow) burnAt = elapsed;
      }
      angHigh += omega(hHigh) * dt;
    }

    function draw() {
      const t = yearsAt(elapsed);
      ctx.clearRect(0, 0, W, H);
      // Shells, dashed, in each satellite's colour.
      ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
      for (const [km, c] of [[LOW_KM, col['series-1']], [HIGH_KM, col['series-2']]]) {
        ctx.strokeStyle = c; ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.arc(cx, cy, radius(km), 0, 2 * Math.PI); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      // Earth.
      ctx.fillStyle = col.band; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.fill();
      ctx.strokeStyle = col.line; ctx.stroke();
      // The falling satellite's trail.
      const xy = ([a, km]) => [cx + radius(km) * Math.cos(a), cy + radius(km) * Math.sin(a)];
      if (trail.length > 1) {
        ctx.strokeStyle = col['series-1']; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.5; ctx.beginPath();
        ctx.moveTo(...xy(trail[0])); for (let i = 1; i < trail.length; i++) ctx.lineTo(...xy(trail[i]));
        ctx.stroke(); ctx.globalAlpha = 1;
      }
      // Satellites.
      const dot = (x, y, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fill(); };
      const rh = radius(heightAt(HIGH_KM, t));
      dot(cx + rh * Math.cos(angHigh), cy + rh * Math.sin(angHigh), col['series-2']);
      const last = trail.length ? xy(trail[trail.length - 1]) : null;
      if (burnAt === null && last) dot(last[0], last[1], col['series-1']);
      else if (burnAt !== null && last) {
        const k = Math.min(1, (elapsed - burnAt) / BURN_MS);
        if (k < 1) { ctx.fillStyle = col.warn; ctx.globalAlpha = 1 - k; ctx.beginPath(); ctx.arc(last[0], last[1], 4 + 10 * k, 0, 2 * Math.PI); ctx.fill(); ctx.globalAlpha = 1; }
      }
      // Labels: shell heights and the sped-up clock.
      ctx.font = `500 12px ${col.mono}`;   // col.mono is read once, so no frame forces a style recalculation
      ctx.textBaseline = 'top';
      // Shell heights as a key in the bottom left corner: the two shells are too close for a label beside each.
      for (const [i, km, c] of [[0, LOW_KM, col['series-1']], [1, HIGH_KM, col['series-2']]]) {
        const y = H - 40 + i * 20;
        ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.globalAlpha = 0.55; ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.moveTo(8, y + 6); ctx.lineTo(28, y + 6); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
        ctx.fillStyle = c; ctx.fillText(`${km} km`, 36, y);
      }
      ctx.fillStyle = col.muted; ctx.fillText(`${t.toFixed(2)} years after both died (sped up)`, 8, 8);
      ctx.textBaseline = 'alphabetic';
    }

    // Loop: runs only while the scene is on screen and the tab is visible, at most 30 times a second,
    // and stops for good when one run ends. Paced on a fixed schedule so headless and real browsers agree.
    let raf = 0, due = 0, last = 0, onScreen = false, done = false;
    const wanted = () => onScreen && !document.hidden && !done && !reduceMotion.matches;
    function frame(now) {
      raf = 0;
      if (!wanted()) return;
      if (now >= due) {
        const dt = Math.min(now - last, 100);
        last = now; due += FRAME_MS; if (due < now) due = now + FRAME_MS;
        step(dt);
        if (elapsed >= LOOP_MS) done = true;
        draw();
      }
      if (!done) raf = requestAnimationFrame(frame);
    }
    const kick = () => { if (!raf && wanted()) { last = due = performance.now(); raf = requestAnimationFrame(frame); } };
    const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };

    function reset() { elapsed = 0; angLow = -Math.PI / 2; angHigh = -Math.PI / 2 + 2.2; trail = []; burnAt = null; done = false; }
    // Reduced motion: one still frame of the finished run, with the whole spiral drawn.
    function still() {
      stop(); reset();
      const dt = FRAME_MS;
      while (elapsed < LOOP_MS) step(dt);
      done = true; draw();
    }
    function start() { if (reduceMotion.matches) { still(); return; } stop(); reset(); draw(); kick(); }

    fig.hidden = false;
    readColors(); resize();
    new IntersectionObserver(entries => { onScreen = entries[entries.length - 1].isIntersecting; if (onScreen) kick(); else stop(); }).observe(canvas);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else kick(); });
    new ResizeObserver(() => { resize(); draw(); }).observe(canvas);
    reduceMotion.addEventListener('change', start);
    replay.addEventListener('click', start);
    replay.hidden = reduceMotion.matches;
    reduceMotion.addEventListener('change', () => { replay.hidden = reduceMotion.matches; });
    start();
  }

  // ---------- Roadmap: the six steps as a track of tabs; each tab shows its step ----------
  const ol = document.querySelector('#roadmap ol.rows');
  if (ol) {
    const items = [...ol.children];
    const track = document.createElement('div');
    track.className = 'track'; track.setAttribute('role', 'tablist'); track.setAttribute('aria-label', 'Roadmap steps');
    const tabs = items.map((li, i) => {
      const num = li.querySelector('.num').textContent, title = li.querySelector('h3').textContent;
      const tab = document.createElement('button');
      tab.type = 'button'; tab.id = `step-tab-${num}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `step-${num}`);
      const n = document.createElement('span'); n.className = 'n'; n.textContent = num;
      const tt = document.createElement('span'); tt.className = 't'; tt.textContent = title;
      tab.append(document.createElement('span'), n, tt); tab.firstChild.className = 'dot';
      if (/running now/i.test(li.querySelector('.tag')?.textContent || '')) tab.classList.add('now');
      li.id = `step-${num}`; li.setAttribute('role', 'tabpanel'); li.setAttribute('aria-labelledby', tab.id); li.tabIndex = 0;
      tab.addEventListener('click', () => select(i, false));
      track.append(tab);
      return tab;
    });
    function select(i, focus) {
      tabs.forEach((t, j) => { const on = j === i; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; items[j].hidden = !on; });
      if (focus) tabs[i].focus();
    }
    track.addEventListener('keydown', e => {
      const i = tabs.indexOf(document.activeElement); if (i < 0) return;
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault(); select((to + tabs.length) % tabs.length, true);
    });
    ol.classList.add('track-panels');
    ol.before(track);
    const now = tabs.findIndex(t => t.classList.contains('now'));
    select(now < 0 ? 0 : now, false);
  }
})();
