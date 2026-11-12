// Final-PR check kit for WQ-027 (remake -> main). No dependencies: Node 22+ (global WebSocket) and Google Chrome.
//
// Usage: TMPDIR=/tmp/claude-1000 node final-check.mjs <candidate site root> <old site root> <out dir>
//   candidate = a checkout of remake (or remake with open PRs merged locally)
//   old       = a checkout of origin/main, the site live today; every old URL and planner deep link must still work
//   out       = screenshots go to <out>/shots, the OK/FAIL log to <out>/report.txt
//
// What it checks (each line prints OK or FAIL; exit code 1 on any FAIL):
//   1. Static link crawl: every href/src/srcset/meta-refresh in every candidate page and every url() in its CSS
//      resolves to a file; every #fragment exists as an id in the target page (planner fragments are preset links,
//      checked in the browser instead); no page loads a stylesheet, script or font from another host.
//   2. Old URLs: every page on the old site resolves on the candidate, with and without the trailing slash (the
//      server answers like GitHub Pages: 301 to the slash, custom 404.html on a miss); redirect pages land on their
//      target with the target id present, with JS on and with JS off; every planner deep link of the old site
//      (/planner/#<id>) selects the same preset on the candidate; /planner/#starcloud selects Starcloud.
//   3. Screenshots: every page at 1280 and 390, after scrolling through so every reveal has fired.
//   4. Reduced motion: every page at 1280 and 390 with prefers-reduced-motion: reduce; everything visible at load
//      without scrolling, no running infinite animations, no smooth scrolling.
//   5. No-JS read-through: every page at 1280 and 390 with JS disabled; no text block faded or transformed away,
//      text blocks hidden by display:none listed for a human to judge.
//   For every load: 0 JS errors from page start, no horizontal overflow, only local requests.
//   The real-browser scroll recording is not here; it is made by hand for the final PR.
import http from 'node:http';
import { readFile, readdir, stat, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const [candRoot, oldRoot, outDir] = process.argv.slice(2).map(p => p && path.resolve(p));
if (!outDir) { console.log('usage: node final-check.mjs <candidate root> <old root> <out dir>'); process.exit(2); }
const shotsDir = path.join(outDir, 'shots');
await mkdir(shotsDir, { recursive: true });

const WIDTHS = [1280, 390];
const SETTLE_MS = 1800;          // after navigation: fonts, page.js, scene loader
const REVEAL_WAIT_MS = 1500;     // after a scroll-through: longest reveal transition
const MAX_SHOT_PX = 16000;       // Chrome's capture limit is about 16384 px
const SKIP_DIRS = new Set(['.git', 'tools', 'node_modules', 'graphify-out']); // tools/ holds dev-only check pages
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lines = [];
let fails = 0;
const log = s => { console.log(s); lines.push(s); };
const check = (ok, msg) => { log((ok ? 'OK   ' : 'FAIL ') + msg); if (!ok) fails++; };
const info = msg => log('INFO ' + msg);

// ---------- Pages ----------
async function htmlFiles(root, dir = '') {
  const out = [];
  for (const e of await readdir(path.join(root, dir), { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...await htmlFiles(root, rel));
    else if (e.name.endsWith('.html')) out.push(rel);
  }
  return out.sort();
}
const urlOf = rel => '/' + rel.replace(/(^|\/)index\.html$/, '$1');
const candFiles = await htmlFiles(candRoot);
const oldFiles = await htmlFiles(oldRoot);
const candHtml = Object.fromEntries(await Promise.all(candFiles.map(async f => [f, await readFile(path.join(candRoot, f), 'utf8')])));
const refreshTarget = html => (html.match(/<meta http-equiv="refresh" content="\d+;\s*url=([^"]+)"/i) || [])[1];
const PAGES = candFiles.map(f => ({ file: f, url: urlOf(f), redirect: refreshTarget(candHtml[f]) }));
info(`candidate pages: ${PAGES.map(p => p.url + (p.redirect ? ' -> ' + p.redirect : '')).join(', ')}`);

// ---------- Servers that answer like GitHub Pages ----------
const HARNESS = `<script>window.__errs=[];addEventListener('error',e=>__errs.push('error: '+(e.message||(e.target&&(e.target.src||e.target.href))||'resource')),true);addEventListener('unhandledrejection',e=>__errs.push('rejection: '+e.reason));{const ce=console.error;console.error=(...a)=>{__errs.push('console.error: '+a.join(' '));ce(...a);};}</script>`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const isFile = async f => { try { return (await stat(f)).isFile(); } catch { return false; } };
const isDir = async f => { try { return (await stat(f)).isDirectory(); } catch { return false; } };
const noHarness = [];
function serve(root) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    let file = path.join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    if (!p.endsWith('/') && await isDir(file)) { res.writeHead(301, { location: p + '/' + u.search }); return res.end(); }
    if (p.endsWith('/')) file = path.join(file, 'index.html');
    let status = 200;
    if (!await isFile(file)) { status = 404; file = path.join(root, '404.html'); }
    try {
      let body = await readFile(file);
      if (file.endsWith('.html')) {
        const s = body.toString();
        if (!s.includes('<meta charset="utf-8">')) noHarness.push(p);
        body = s.replace('<meta charset="utf-8">', '<meta charset="utf-8">' + HARNESS);
      }
      res.writeHead(status, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

// ---------- 1. Static link crawl ----------
log('== 1. Static link crawl');
const idsOf = html => new Set([...html.matchAll(/\s(?:id|name)="([^"]+)"/g)].map(m => m[1]));
async function resolveLocal(abs) { // abs: site path without query or fragment
  const f = path.join(candRoot, abs);
  if (abs.endsWith('/')) return await isFile(path.join(f, 'index.html')) ? path.posix.join(abs, 'index.html').slice(1) : null;
  if (await isFile(f)) return abs.slice(1);
  if (await isDir(f) && await isFile(path.join(f, 'index.html'))) return path.posix.join(abs, 'index.html').slice(1);
  return null;
}
const linkFails = [], extLoads = [], extLinks = new Set();
let linkCount = 0;
const cssSeen = new Set();
async function checkRef(ref, fromUrl, kind, fromLabel) {
  ref = ref.trim().replace(/&amp;/g, '&');
  if (!ref || ref.startsWith('data:') || ref.startsWith('mailto:') || ref.startsWith('tel:') || ref.startsWith('javascript:')) return;
  const u = new URL(ref, 'https://anvilorbital.com' + fromUrl);
  if (u.host !== 'anvilorbital.com') {
    if (kind === 'load') extLoads.push(`${fromLabel}: ${ref}`); else extLinks.add(u.host);
    return;
  }
  linkCount++;
  const target = await resolveLocal(decodeURIComponent(u.pathname));
  if (!target) { linkFails.push(`${fromLabel}: ${ref} (no file)`); return; }
  if (target.endsWith('.css') && !cssSeen.has(target)) {
    cssSeen.add(target);
    const css = await readFile(path.join(candRoot, target), 'utf8');
    for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) await checkRef(m[1], '/' + target, 'load', target);
    for (const m of css.matchAll(/@import\s+['"]([^'"]+)['"]/g)) await checkRef(m[1], '/' + target, 'load', target);
  }
  const frag = decodeURIComponent(u.hash.slice(1));
  if (frag && target.endsWith('.html') && target !== 'planner/index.html') {
    const html = candHtml[target] ?? await readFile(path.join(candRoot, target), 'utf8');
    if (!idsOf(html).has(frag)) linkFails.push(`${fromLabel}: ${ref} (no id "${frag}" in ${target})`);
  }
}
for (const pg of PAGES) {
  const html = candHtml[pg.file];
  for (const m of html.matchAll(/<(a|link|script|img|source|iframe|use|image)\b[^>]*>/gi)) {
    const tag = m[0], name = m[1].toLowerCase();
    const rel = (tag.match(/\srel="([^"]+)"/i) || [])[1] || '';
    const isLoad = name !== 'a' && !(name === 'link' && /canonical|alternate/.test(rel));
    for (const a of tag.matchAll(/\s(?:href|src|xlink:href)="([^"]*)"/gi)) await checkRef(a[1], pg.url, isLoad ? 'load' : 'link', pg.url);
    for (const a of tag.matchAll(/\ssrcset="([^"]*)"/gi)) for (const part of a[1].split(',')) await checkRef(part.trim().split(/\s+/)[0], pg.url, 'load', pg.url);
  }
  if (pg.redirect) await checkRef(pg.redirect, pg.url, 'link', pg.url + ' (meta refresh)');
  for (const m of html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)) {
    for (const v of Object.values(JSON.parse(m[1]).imports || {})) await checkRef(v, pg.url, 'load', pg.url + ' (importmap)');
  }
  for (const m of html.matchAll(/style="[^"]*url\(\s*['"]?([^'")]+)/g)) await checkRef(m[1], pg.url, 'load', pg.url + ' (inline style)');
}
check(linkFails.length === 0, `${linkCount} internal references across ${PAGES.length} pages and their CSS resolve${linkFails.length ? ': ' + linkFails.join('; ') : ''}`);
check(extLoads.length === 0, `no page loads a stylesheet, script, image or font from another host${extLoads.length ? ': ' + extLoads.join('; ') : ''}`);
info(`outbound link hosts (links only, not loads): ${[...extLinks].sort().join(', ') || 'none'}`);

// ---------- Browser ----------
const cand = await serve(candRoot), old = await serve(oldRoot);
const port = 9300 + Math.floor(Math.random() * 500);
const prof = await mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'fc-'));
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--hide-scrollbars', '--window-size=1280,900', 'about:blank'], { stdio: process.env.PROBE_DEBUG ? 'inherit' : 'ignore' });
// A stuck Chrome must not hang the run: on TERM/INT or after RUN_LIMIT_MS, write what we have and exit.
const RUN_LIMIT_MS = Number(process.env.RUN_LIMIT_MS || 12 * 60 * 1000);
const abort = async why => {
  log(`FAIL run aborted: ${why}`); fails++;
  try { await writeFile(path.join(outDir, 'report.txt'), lines.join('\n') + '\n'); } catch { /* best effort */ }
  try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
  process.exit(124);
};
process.on('SIGTERM', () => abort('SIGTERM')); process.on('SIGINT', () => abort('SIGINT'));
setTimeout(() => abort(`watchdog after ${RUN_LIMIT_MS} ms`), RUN_LIMIT_MS).unref();
let ws;
for (let i = 0; i < 50 && !ws; i++) { try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const pg = t.find(x => x.type === 'page'); if (pg) ws = pg.webSocketDebuggerUrl; } catch {} await sleep(200); }
if (!ws) { console.log('FAIL chrome did not start (set PROBE_DEBUG=1; keep TMPDIR short)'); process.exit(1); }
const sock = new WebSocket(ws); await new Promise(r => sock.onopen = r);
let msgId = 0; const pending = new Map(); const netUrls = [];
let recordNet = true; // off while the old site loads: only candidate pages count for the local-requests checks
sock.onmessage = m => { const d = JSON.parse(m.data); if (d.method === 'Network.requestWillBeSent' && recordNet) netUrls.push(d.params.request.url); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
// Every call answers within CDP_TIMEOUT_MS, with an error result if Chrome never replies.
const CDP_TIMEOUT_MS = 60000;
const cdp = (method, params = {}) => new Promise(r => {
  const i = ++msgId;
  const t = setTimeout(() => { pending.delete(i); r({ error: { message: `no reply in ${CDP_TIMEOUT_MS} ms to ${method}` } }); }, CDP_TIMEOUT_MS);
  pending.set(i, d => { clearTimeout(t); r(d); });
  sock.send(JSON.stringify({ id: i, method, params }));
});
const ev = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) return { probeError: r.result.exceptionDetails.exception?.description }; return r.result?.result?.value; };
await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable');

async function load(url, { width, js = true, reduce = false, height = 900, wait = SETTLE_MS }) {
  await cdp('Page.navigate', { url: 'about:blank' }); await sleep(100); // a fresh document even for hash-only changes
  await cdp('Emulation.setScriptExecutionDisabled', { value: !js });
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }] });
  await cdp('Page.navigate', { url });
  await sleep(wait);
}
// Runtime.evaluate still works with page scripts disabled, so the same probes run in the no-JS cases.
const scrollThrough = () => ev(`(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));for(let y=0;y<=document.documentElement.scrollHeight;y+=Math.round(innerHeight/3)){scrollTo({top:y,behavior:'instant'});await s(120);}await s(${REVEAL_WAIT_MS});scrollTo({top:0,behavior:'instant'});await s(300);})()`);
const STATE = `(()=>{const de=document.documentElement;
  const eff=e=>{let o=1;for(let n=e;n&&n.nodeType===1;n=n.parentElement)o*=+getComputedStyle(n).opacity;return o;};
  const scope=document.querySelector('main')||document.body;
  const blocks=[...scope.querySelectorAll(':is(p,li,h1,h2,h3,h4,dt,dd,td,th,figcaption,blockquote,label)')].filter(e=>e.textContent.trim());
  const shown=blocks.filter(e=>e.getClientRects().length);
  return {hasMain:!!document.querySelector('main'),sw:de.scrollWidth,cw:de.clientWidth,errs:window.__errs||['harness missing'],
    wide:[...document.querySelectorAll('body *')].filter(e=>{const b=e.getBoundingClientRect();return b.width&&b.right>de.clientWidth+1&&!e.closest('.table-wrap,canvas,.skip')}).slice(0,4).map(e=>e.tagName+'.'+e.className),
    faded:shown.filter(e=>eff(e)<0.99).map(e=>e.tagName+': '+e.textContent.trim().slice(0,40)).slice(0,5),
    lines:[...document.querySelectorAll('.line-inner')].filter(e=>getComputedStyle(e).transform!=='none').length,
    revealHidden:[...document.querySelectorAll('[data-reveal]')].filter(e=>e.getClientRects().length&&+getComputedStyle(e).opacity<1).length,
    hiddenText:blocks.filter(e=>!e.getClientRects().length&&!e.closest('[hidden],.js-only,template,noscript,dialog')).map(e=>e.tagName+': '+e.textContent.trim().slice(0,40)).slice(0,5),
    blocks:shown.length,
    infinite:document.getAnimations().filter(a=>a.playState==='running'&&a.effect&&a.effect.getTiming().iterations===Infinity).map(a=>a.animationName||a.constructor.name).slice(0,4),
    smooth:getComputedStyle(de).scrollBehavior,
    path:location.pathname+location.hash,title:document.title};})()`;
// Full-page capture (captureBeyondViewport) hangs headless Chrome on a page whose height follows the viewport (an svh
// console, WQ-028). Such a page is found by growing the viewport 100 px: if the page grows with it, it gets one
// viewport shot per screen (name-p1.png, -p2 ...) instead of one full-page capture.
const VIEWPORT_PROBE_PX = 100, MAX_PARTS = 12;
async function followsViewport() {
  const w = await ev('innerWidth'), vh = await ev('innerHeight'), h0 = await ev('document.documentElement.scrollHeight');
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: vh + VIEWPORT_PROBE_PX, deviceScaleFactor: 1, mobile: w < 600 }); await sleep(300);
  const h1 = await ev('document.documentElement.scrollHeight');
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: vh, deviceScaleFactor: 1, mobile: w < 600 }); await sleep(300);
  return h1 - h0 >= VIEWPORT_PROBE_PX / 2;
}
async function shot(name) {
  const h = await ev('document.documentElement.scrollHeight'), w = await ev('innerWidth'), vh = await ev('innerHeight');
  const save = async (file, r) => {
    if (!r.result?.data) { check(false, `${file}: screenshot failed ${r.error?.message || ''}`); return; }
    await writeFile(path.join(shotsDir, file), Buffer.from(r.result.data, 'base64'));
  };
  if (await followsViewport()) {
    const parts = Math.min(MAX_PARTS, Math.ceil(h / vh));
    for (let p = 0; p < parts; p++) {
      await ev(`scrollTo({top:${p * vh},behavior:'instant'})`); await sleep(400);
      await save(`${name}-p${p + 1}.png`, await cdp('Page.captureScreenshot', { format: 'png' }));
    }
    await ev(`scrollTo({top:0,behavior:'instant'})`);
    info(`${name}: page height follows the viewport, so ${parts} viewport shots instead of one full-page capture`);
    return;
  }
  await save(name + '.png', await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: Math.min(h, MAX_SHOT_PX), scale: 1 } }));
  if (h > MAX_SHOT_PX) info(`${name}.png cut at ${MAX_SHOT_PX}px of ${h}px`);
}
const nameOf = (url, w, tag = '') => ((url === '/' ? 'home' : url.replace(/^\/|\/$/g, '').replace(/[\/#.]+/g, '-')) + '-' + w + (tag ? '-' + tag : ''));
const common = (label, s) => {
  check(s.errs.length === 0, `${label}: 0 JS errors ${s.errs.length ? JSON.stringify(s.errs.slice(0, 3)) : ''}`);
  check(s.sw <= s.cw, `${label}: no horizontal overflow ${s.sw}/${s.cw} ${s.wide.length ? JSON.stringify(s.wide) : ''}`);
};
// Where a redirect page should land: its meta refresh resolved against its own URL.
const landingOf = pg => { const u = new URL(pg.redirect, 'http://x' + pg.url); return u.pathname + u.hash; };
async function checkLanding(pg, label, js) {
  await sleep(800);
  const s = await ev(STATE);
  const want = landingOf(pg), frag = want.split('#')[1];
  const hasId = frag ? await ev(`!!document.getElementById(${JSON.stringify(frag)})`) : true;
  check(s.path === want && hasId, `${label}: lands on ${s.path} (want ${want}, id present: ${hasId})`);
  if (js) check(s.errs.length === 0, `${label}: 0 JS errors after landing ${s.errs.length ? JSON.stringify(s.errs.slice(0, 3)) : ''}`);
}

// ---------- 2. Old URLs and deep links ----------
log('== 2. Old URLs, redirects, planner deep links');
const oldUrls = oldFiles.map(urlOf);
for (const u of oldUrls) {
  const variants = u.endsWith('/') && u !== '/' ? [u, u.slice(0, -1)] : [u];
  for (const v of variants) {
    const r = await fetch(cand.base + v, { redirect: 'manual' });
    const loc = r.headers.get('location');
    const ok = r.status === 200 || (r.status === 301 && loc === v + '/');
    check(ok, `old URL ${v} answers ${r.status}${loc ? ' -> ' + loc : ''}`);
  }
}
for (const pg of PAGES.filter(p => p.redirect)) for (const js of [true, false]) {
  await load(cand.base + pg.url, { width: 1280, js });
  await checkLanding(pg, `redirect ${pg.url} JS ${js ? 'on' : 'off'}`, js);
}
{ // a miss gets 404.html with working absolute asset paths even two levels deep
  await load(cand.base + '/no-such/page/', { width: 1280 });
  const s = await ev(STATE);
  const styled = await ev(`getComputedStyle(document.body).fontFamily+' / '+getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
  check(s.errs.length === 0 && /Archivo/.test(styled) && !/\/ $/.test(styled), `/no-such/page/ shows 404.html styled (${styled}), errors ${JSON.stringify(s.errs.slice(0, 2))}`);
}
// Planner deep links: every link id the old planner knows must pick the same preset on the candidate.
// The old site loads a render-blocking Google Fonts stylesheet before its scripts; when Google is slow, BY_LINK_ID does
// not exist yet. Block Google Fonts for old-site loads only (candidate loads stay unblocked, so the font check below
// still sees any such request), and wait for the ids instead of reading them once.
const GOOGLE_FONTS = ['*://fonts.googleapis.com/*', '*://fonts.gstatic.com/*'];
const OLD_IDS_WAIT_MS = 10000;
const loadOld = async (url, opts) => { await cdp('Network.setBlockedURLs', { urls: GOOGLE_FONTS }); await load(url, opts); await cdp('Network.setBlockedURLs', { urls: [] }); };
recordNet = false;
await loadOld(old.base + '/planner/', { width: 1280 });
let oldIds = null;
for (const end = Date.now() + OLD_IDS_WAIT_MS; !oldIds && Date.now() < end; await sleep(250)) oldIds = await ev(`typeof BY_LINK_ID==='object'?Object.keys(BY_LINK_ID):null`);
recordNet = true;
check(Array.isArray(oldIds) && oldIds.length > 0, `old planner exposes its deep-link ids (${Array.isArray(oldIds) ? oldIds.length : 'none'})`);
for (const idv of oldIds || []) {
  recordNet = false;
  await loadOld(old.base + '/planner/#' + idv, { width: 1280, wait: 900 });
  const want = await ev(`document.getElementById('preset').value`);
  recordNet = true;
  await load(cand.base + '/planner/#' + idv, { width: 1280, wait: 900 });
  const got = await ev(`({v:document.getElementById('preset').value,a:(document.getElementById('a1')||{}).textContent,errs:window.__errs})`);
  check(got.v === want && got.errs.length === 0, `/planner/#${idv} selects "${got.v}" (old site: "${want}")`);
}
await load(cand.base + '/planner/#starcloud', { width: 1280 });
{ const v = await ev(`document.getElementById('preset').value+' / '+document.getElementById('a1').textContent`); check(/^Starcloud/.test(v), `/planner/#starcloud selects Starcloud: ${v}`); }

// ---------- 3. Screenshots, motion on ----------
log('== 3. Every page at 1280 and 390, motion on, after a full scroll');
const VIEWS = [...PAGES.filter(p => !p.redirect).map(p => p.url), '/planner/#starcloud', '/about/#contact'];
for (const w of WIDTHS) for (const url of VIEWS) {
  const label = `${url} ${w}`;
  await load(cand.base + url, { width: w });
  const s0 = await ev(STATE);
  common(label, s0);
  if (w === WIDTHS[0]) check(s0.hasMain, `${url}: has a <main> landmark`);
  await scrollThrough();
  const s = await ev(STATE);
  check(s.revealHidden === 0 && s.lines === 0 && s.faded.length === 0, `${label}: everything revealed after a full scroll (hidden ${s.revealHidden}, lines ${s.lines}, faded ${JSON.stringify(s.faded)})`);
  await shot(nameOf(url, w));
}

// ---------- 4. Reduced motion ----------
log('== 4. Reduced motion, at load, no scrolling');
for (const w of WIDTHS) for (const url of VIEWS) {
  const label = `${url} ${w} reduced motion`;
  await load(cand.base + url, { width: w, reduce: true });
  const s = await ev(STATE);
  common(label, s);
  check(s.revealHidden === 0 && s.lines === 0 && s.faded.length === 0, `${label}: everything visible without scrolling (hidden ${s.revealHidden}, lines ${s.lines}, faded ${JSON.stringify(s.faded)})`);
  check(s.infinite.length === 0, `${label}: no running infinite animations ${JSON.stringify(s.infinite)}`);
  check(s.smooth !== 'smooth', `${label}: scroll-behavior ${s.smooth}`);
  if (w === 390) await shot(nameOf(url, w, 'reduced'));
}

// ---------- 5. No-JS read-through ----------
log('== 5. No-JS read-through');
for (const w of WIDTHS) for (const url of VIEWS) {
  const label = `${url} ${w} no JS`;
  await load(cand.base + url, { width: w, js: false });
  const s = await ev(STATE);
  check(s.sw <= s.cw, `${label}: no horizontal overflow ${s.sw}/${s.cw} ${s.wide.length ? JSON.stringify(s.wide) : ''}`);
  check(s.blocks > 0 && s.revealHidden === 0 && s.lines === 0 && s.faded.length === 0, `${label}: ${s.blocks} text blocks readable (hidden ${s.revealHidden}, lines ${s.lines}, faded ${JSON.stringify(s.faded)})`);
  if (s.hiddenText.length) info(`${label}: text blocks with display:none, judge by eye: ${JSON.stringify(s.hiddenText)}`);
  if (w === 390) await shot(nameOf(url, w, 'nojs'));
}

// ---------- Requests ----------
const ext = netUrls.filter(u => !u.startsWith(cand.base) && !u.startsWith(old.base) && !u.startsWith('data:') && !u.startsWith('blob:') && u !== 'about:blank');
check(ext.length === 0, `every load made only local requests ${JSON.stringify([...new Set(ext)].slice(0, 5))}`);
check(!netUrls.some(u => /fonts\.(googleapis|gstatic)\.com/.test(u)), 'no request to fonts.googleapis.com or fonts.gstatic.com');
check(noHarness.length === 0, `error harness injected into every HTML response ${JSON.stringify([...new Set(noHarness)])}`);

log(fails ? `${fails} FAIL` : 'ALL OK');
await writeFile(path.join(outDir, 'report.txt'), lines.join('\n') + '\n');
chrome.kill(); cand.server.close(); old.server.close();
process.exit(fails ? 1 : 0);
