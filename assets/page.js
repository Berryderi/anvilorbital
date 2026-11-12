// Home page behaviour for the remake (WQ-027). Classic script, deferred, after model.js and presets.js
// (it reads evaluate, lifetimeYears, REENTRY, T, PRESETS, REAL, EXAMPLES, LINK_IDS from them).
// Everything here is progressive: without JS the page is complete text; without the scene it is text on space.
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const html = document.documentElement;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let scene = null;

  // ---------- Text reveals: headings and ledes by line, other blocks as a whole; each fires once ----------
  const lineTargets = [...document.querySelectorAll('[data-reveal="lines"]')].filter(el => el.children.length === 0);
  function splitLines(el) {
    const text = el.dataset.text || (el.dataset.text = el.textContent.replace(/\s+/g, ' ').trim());
    el.textContent = '';
    const words = text.split(' ').map(w => { const s = document.createElement('span'); s.textContent = w + ' '; el.append(s); return s; });
    const lines = []; let top = null;
    for (const w of words) { if (w.offsetTop !== top) { lines.push([]); top = w.offsetTop; } lines[lines.length - 1].push(w.textContent); }
    el.textContent = '';
    lines.forEach((ws, i) => {
      const line = document.createElement('span'); line.className = 'line';
      const inner = document.createElement('span'); inner.className = 'line-inner'; inner.style.setProperty('--i', i); inner.textContent = ws.join('').trimEnd();
      line.append(inner); el.append(line);
    });
  }
  // Elements with child markup (links, strong) are revealed as one block instead.
  document.querySelectorAll('[data-reveal="lines"]').forEach(el => { if (el.children.length) el.dataset.reveal = ''; });
  const splitAll = () => lineTargets.forEach(splitLines);
  if (html.classList.contains('reveal-ready')) {
    splitAll();
    let lastW = innerWidth, t = 0;
    addEventListener('resize', () => { if (innerWidth === lastW) return; lastW = innerWidth; clearTimeout(t); t = setTimeout(splitAll, 150); });
    // Blocks inside one chapter step in one after another.
    document.querySelectorAll('.chapter, .tool section').forEach(ch => ch.querySelectorAll('[data-reveal]:not([data-reveal="lines"])').forEach((el, i) => el.style.setProperty('--d', `${Math.min(i, 4) * 70}ms`)));
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -12% 0px' });
    document.querySelectorAll('[data-reveal]').forEach(el => io.observe(el));
  }
  html.classList.add('reveal-live');

  // ---------- Chapters: which one holds the middle of the screen, and how far through it we are ----------
  const chapters = [...document.querySelectorAll('.chapter')];
  const navLinks = new Map([...document.querySelectorAll('.nav-links a[data-ch]')].map(a => [a.dataset.ch, a]));
  const marker = document.querySelector('.nav-marker'), navList = document.querySelector('.nav nav');
  let current = null, ticking = false;
  function placeMarker(id) {
    navLinks.forEach((a, k) => { if (k === id) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current'); });
    const a = navLinks.get(id);
    if (!a || !marker) { marker && marker.style.setProperty('--mo', 0); return; }
    // The marker spans the link's text: its box minus the link's own side padding, read from CSS.
    const box = navList.getBoundingClientRect(), r = a.getBoundingClientRect(), pad = parseFloat(getComputedStyle(a).paddingLeft) || 0;
    marker.style.setProperty('--mx', `${r.left - box.left + pad}px`); marker.style.setProperty('--ms', Math.max(0, r.width - 2 * pad) / 100); marker.style.setProperty('--mo', 1);
  }
  function update() {
    ticking = false;
    const mid = innerHeight / 2;
    let active = chapters[0], progress = 0;
    for (const ch of chapters) { const r = ch.getBoundingClientRect(); if (r.top <= mid && r.bottom > mid) { active = ch; progress = Math.min(1, Math.max(0, (mid - r.top) / r.height)); break; } if (r.top > mid) break; active = ch; progress = 1; }
    if (active.id !== current) { current = active.id; placeMarker(current); }
    if (scene) scene.setChapter(current, progress);
  }
  const request = () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } };
  // Tool pages have no chapters: their nav keeps its own aria-current="page", so chapter tracking stays off there.
  if (chapters.length) {
    addEventListener('scroll', request, { passive: true });
    addEventListener('resize', () => { current = null; request(); });
    document.fonts && document.fonts.ready.then(() => { current = null; request(); });
    update();
  }

  // ---------- The scene (dev-1, assets/scene/scene.js), loaded only if present and WebGL works ----------
  const pick = $('pick');
  function showPick(d) {
    if (!d) { pick.hidden = true; return; }
    pick.replaceChildren();
    const name = document.createElement('b'); name.textContent = d.name;
    // heightKm is null for a moment until the scene's worker answers; the event then fires again with it.
    const height = Number.isFinite(d.heightKm) ? `${Math.round(d.heightKm).toLocaleString('en-US')} km` : null;
    const meta = document.createElement('span'); meta.textContent = [d.operator, height, `NORAD ${d.norad}`].filter(Boolean).join(' · ');
    pick.append(name, meta);
    pick.style.setProperty('--px', `${Math.min(d.x, innerWidth - 260)}px`); pick.style.setProperty('--py', `${Math.min(d.y, innerHeight - 80)}px`);
    pick.hidden = false;
  }
  const canvas = $('space');
  // Tool pages (WQ-030) ask for the quiet page mode with <canvas id="space" data-scene-mode="page">. They fetch three.js
  // only after the page has loaded and the browser is idle, and not at all when the reader asked to save data, so the
  // static CSS stars (page.css) stay. Home starts its scene at once, as before.
  const PAGE_SCENE_IDLE_TIMEOUT_MS = 1500;   // start at the latest this long after load, even if the browser is never idle
  const wantsLessData = () => {
    try { if (navigator.connection && navigator.connection.saveData) return true; } catch { /* no Network Information API */ }
    return matchMedia('(prefers-reduced-data: reduce)').matches;
  };
  const whenQuiet = () => new Promise(r => {
    const idle = () => ('requestIdleCallback' in window ? requestIdleCallback(r, { timeout: PAGE_SCENE_IDLE_TIMEOUT_MS }) : setTimeout(r, 200));
    if (document.readyState === 'complete') idle(); else addEventListener('load', idle, { once: true });
  });
  const startScene = () => {
    import('/assets/scene/scene.js')
      // Tool pages ask for dev-1's quiet mode with <canvas id="space" data-scene-mode="page">; home passes no options.
      .then(m => canvas.dataset.sceneMode ? m.createScene(canvas, { mode: canvas.dataset.sceneMode }) : m.createScene(canvas))
      .then(s => {
        if (!s) return;
        scene = s;
        html.classList.add('has-scene');
        document.querySelectorAll('[data-scene-only]').forEach(el => { el.hidden = false; });
        scene.on('pick', showPick);
        // The hero fleet runs faster than real time; the brief wants every exaggerated speed labelled.
        const labelSpeed = () => { const k = scene.info && scene.info.timeScale; if (k > 1) { $('time-scale-n').textContent = Math.round(k).toLocaleString('en-US'); $('time-scale').hidden = false; } };
        labelSpeed(); scene.on('ready', labelSpeed);
        if (mini.name) scene.setPlannerPreset(mini.name);
        if (chapters.length) { current = null; update(); }
      })
      .catch(() => { /* no scene file yet, or no WebGL: the page stays text on space */ });
  };
  if (canvas && canvas.dataset.sceneMode === 'page') { if (!wantsLessData()) whenQuiet().then(startScene); }
  else if (canvas) startScene();

  // ---------- 550 vs 800 km: the same two satellites the scene shows, numbers from the planner model ----------
  const fall = $('fall-line');
  if (fall && typeof lifetimeYears === 'function') {
    const SHAPE = Object.keys(PRESETS)[0], p = PRESETS[SHAPE], mA = p.mass / p.area;
    const yrs = y => y >= 100 ? Number(y.toPrecision(2)).toLocaleString('en-US') : y >= 10 ? y.toFixed(0) : y.toFixed(1);
    fall.textContent = `A dead ${SHAPE} falls from 550 km in about ${yrs(lifetimeYears(550, mA, 1))} years, and from 800 km in about ${yrs(lifetimeYears(800, mA, 1))} years. Planner model, average sun, not checked by a spacecraft engineer.`;
    fall.hidden = false;
  }

  // ---------- Mini planner: one preset, the planner's own four answers, word for word ----------
  // The formatting below is copied from planner/index.html (money, yrs, num and the answer strings).
  const mini = { name: null };
  const form = $('mini'), sel = $('mini-preset');
  if (form && typeof evaluate === 'function') {
    const TABLE_TOP = T[T.length - 1][0], SHOWN_MAX_YEARS = 1000;
    const money = v => v >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? '$' + Math.round(v / 1e3) + 'k' : '$' + Math.round(v);
    const yrs = y => y >= 100 ? Number(y.toPrecision(2)).toLocaleString() : y >= 10 ? y.toFixed(0) : y.toFixed(1);
    const num = v => v >= 100 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(0) : v.toFixed(1);
    for (const [label, group] of [['Real fleets (public figures)', REAL], ['Examples (illustrations)', EXAMPLES]]) {
      const g = document.createElement('optgroup'); g.label = label;
      for (const n of Object.keys(group)) { const o = document.createElement('option'); o.value = n; o.textContent = n; g.append(o); }
      sel.append(g);
    }
    const tag = (el, text, kind) => { el.textContent = text; el.className = 'tag ' + { good: 'tag-ok', warn: 'tag-caution', bad: 'tag-risk' }[kind]; };
    function show(name) {
      const v = PRESETS[name]; mini.name = name;
      const r = evaluate(v.count, v.mass, v.area, v.alt, v.life, v.fail / 100, v.launch, v.prop, v.isp, v.service, v.value);
      $('m1').textContent = yrs(r.mean) + ' years';
      if (v.alt > TABLE_TOP && r.mean >= SHOWN_MAX_YEARS) $('m1').textContent = `More than ${SHOWN_MAX_YEARS.toLocaleString()} years`;
      const s = { clears: ['Clears the 5-year limit unaided', 'good'], depends: ['Depends on the sun', 'warn'], misses: ['Misses the 5-year limit unaided', 'bad'] }[r.status];
      tag($('m1p'), s[0], s[1]);
      $('m2').textContent = r.alternative_usd === 0 ? '$0 in fuel' : money(r.fuel_usd) + ' each';
      $('m3').textContent = num(r.alumina_t_per_year) + ' t a year';
      $('m4').textContent = r.service_wins ? 'Yes, at this price' : 'No, burning up wins';
      tag($('m4p'), 'Depends on your inputs', r.service_wins ? 'good' : 'bad');
      $('mini-open').href = '/planner/#' + LINK_IDS[name];
      if (scene) scene.setPlannerPreset(name);
    }
    sel.addEventListener('change', () => show(sel.value));
    show(sel.value = Object.keys(PRESETS)[0]);
    form.hidden = false;
    form.addEventListener('submit', e => e.preventDefault());
  }

  // ---------- Roadmap: six steps as a track of tabs; the "running now" step is lit and selected ----------
  const ol = document.querySelector('#roadmap ol.steps');
  if (ol) {
    const items = [...ol.children];
    const track = document.createElement('div');
    track.className = 'track'; track.setAttribute('role', 'tablist'); track.setAttribute('aria-label', 'Roadmap steps');
    const tabs = items.map((li, i) => {
      const num = li.querySelector('.num').textContent, title = li.querySelector('h3').textContent;
      const tab = document.createElement('button');
      tab.type = 'button'; tab.id = `step-tab-${num}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `step-${num}`);
      const dot = document.createElement('span'); dot.className = 'dot';
      const n = document.createElement('span'); n.className = 'n'; n.textContent = num;
      const tt = document.createElement('span'); tt.textContent = title;
      tab.append(dot, n, tt);
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
    ol.classList.add('panels'); ol.before(track);
    if (html.classList.contains('reveal-ready')) { track.dataset.reveal = ''; new IntersectionObserver((es, o) => es.forEach(e => { if (e.isIntersecting) { track.classList.add('is-in'); o.disconnect(); } })).observe(track); }
    const now = tabs.findIndex(t => t.classList.contains('now'));
    select(now < 0 ? 0 : now, false);
  }
})();
