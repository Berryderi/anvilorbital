// Home scene probe (WQ-026 Track A). No dependencies: Node 22+ and Google Chrome.
// Usage: TMPDIR=/tmp/claude-1000 node tools/scene-probe.mjs <site root> [--width 1280] [--dpr 2] [--reduced] [--shots <dir>] [--page /]
// --page probes another page that mounts the scene (the home page): scene.js is served through a wrapper that exposes the scene.
// Serves the site on 127.0.0.1, opens /tools/scene-check.html in headless Chrome (SwiftShader WebGL) and measures, per run:
//   rAF callbacks per second, frames drawn per second, main-thread ms per drawn frame (inside rAF callbacks that drew),
//   Chrome TaskDuration ms per drawn frame, SGP4 propagate calls per second on the main thread (expected 0: the worker does it).
// Runs: hero at rest, hero with the pointer moving, each chapter at mid scroll, a scrub through the retire chapter,
// a hover sweep until a satellite is picked, the tab hidden. With --reduced: prefers-reduced-motion, where idle frames must be 0.
// Nothing is changed on disk: the probe hooks are injected into the served copy of the page only.
import http from 'node:http';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const root = path.resolve(args[0] || '.');
const opt = name => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : null; };
const width = Number(opt('--width') || 1280), height = width < 600 ? 844 : 900, dpr = Number(opt('--dpr') || 1);
const reduced = args.includes('--reduced');
const shots = opt('--shots');
const CHROME = process.env.CHROME || 'google-chrome';
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 500);
const PAGE = opt('--page') || '/tools/scene-check.html';
const SCENE_WRAPPER = `import { createScene as real } from '/assets/scene/scene.real.js';
export async function createScene(...a) { const s = await real(...a); window.__scene = s; return s; }`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Runs before any page script: error capture, rAF timing, WebGL draw counting, pick events.
const HARNESS = `<script>
window.__probe={prop:0,cbs:0,frames:0,drawMs:0,maxMs:0,draws:0,errs:[],picks:[]};
addEventListener('error',e=>__probe.errs.push('error: '+(e.message||(e.target&&(e.target.src||e.target.href))||'resource')),true);
addEventListener('unhandledrejection',e=>__probe.errs.push('rejection: '+e.reason));
{const ce=console.error;console.error=(...a)=>{__probe.errs.push('console.error: '+a.join(' '));ce(...a);};}
for(const C of [WebGLRenderingContext,WebGL2RenderingContext])for(const m of ['drawArrays','drawElements']){const f=C.prototype[m];C.prototype[m]=function(...a){__probe.draws++;return f.apply(this,a);};}
{const raf=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=cb=>raf(ts=>{const d0=__probe.draws,t0=performance.now();cb(ts);const dt=performance.now()-t0;__probe.cbs++;if(__probe.draws>d0){__probe.frames++;__probe.drawMs+=dt;__probe.maxMs=Math.max(__probe.maxMs,dt);}});}
</script>`;
const PROP_PATH = '/assets/vendor/satellite.js/propagation.js';
const WRAPPER = `import * as P from '${PROP_PATH}';
export * from '${PROP_PATH}';
export function propagate(...a) { window.__probe && window.__probe.prop++; return P.propagate(...a); }`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2' };

const bytes = { total: 0, files: {} };
const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/__probe/prop.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(WRAPPER); }
    if (opt('--page') && p === '/assets/scene/scene.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(SCENE_WRAPPER); }
    if (p === '/assets/scene/scene.real.js') p = '/assets/scene/scene.js';
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) throw new Error('outside root');
    let body = await readFile(file);
    if (p === (PAGE.endsWith('/') ? PAGE + 'index.html' : PAGE)) {
      let html = body.toString();
      html = html.replace(/<script type="importmap">(.*?)<\/script>/s, (m, json) => {
        const map = JSON.parse(json); map.scopes = { '/assets/': { [PROP_PATH]: '/__probe/prop.js' } };
        return `<script type="importmap">${JSON.stringify(map)}</script>`;
      });
      body = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">' + HARNESS);
    }
    bytes.total += body.length; bytes.files[p] = body.length;
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = await mkdtemp(path.join(os.tmpdir(), 'scene-probe-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars',
  '--no-first-run', '--user-data-dir=' + profile,
  `--remote-debugging-port=${DEBUG_PORT}`, `--window-size=${Math.max(width, 500)},${height}`, 'about:blank'], { stdio: ['ignore', 'ignore', process.env.PROBE_DEBUG ? 'inherit' : 'ignore'] });

let ws, seq = 0; const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = ++seq; ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((ok, fail) => pending.set(id, { ok, fail }));
}
async function connect() {
  for (let i = 0; i < 50; i++) {
    try { const v = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); ws = new WebSocket(v.webSocketDebuggerUrl); break; }
    catch (e) { if (i === 49) console.error('[scene-probe] connect:', e.message); await sleep(200); }
  }
  if (!ws) throw new Error('Chrome did not start');
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  ws.onmessage = m => { const d = JSON.parse(m.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.fail(new Error(d.error.message)) : p.ok(d.result); } };
}

let sid;
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
}
const reset = () => evaluate('Object.assign(__probe,{prop:0,cbs:0,frames:0,drawMs:0,maxMs:0})');
async function measure(name, seconds, during) {
  const taskS = async () => (await send('Performance.getMetrics', {}, sid)).metrics.find(m => m.name === 'TaskDuration').value;
  await reset(); const t0 = await taskS();
  const end = Date.now() + seconds * 1000;
  if (during) await during(end);
  await sleep(Math.max(0, end - Date.now())); const t1 = await taskS();
  const p = await evaluate('({...__probe})');
  const row = { run: name, seconds, callbacksPerS: +(p.cbs / seconds).toFixed(1), fps: +(p.frames / seconds).toFixed(1), frames: p.frames,
    msPerFrame: p.frames ? +(p.drawMs / p.frames).toFixed(2) : 0, maxMs: +p.maxMs.toFixed(1),
    taskMsPerFrame: p.frames ? +((t1 - t0) * 1000 / p.frames).toFixed(2) : 0,
    mainThreadPropagatePerS: Math.round(p.prop / seconds), errors: p.errs.length };
  console.log(JSON.stringify(row));
  return row;
}
async function shot(name) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await evaluate("document.getElementById('out')?.style.setProperty('visibility','hidden')");
  const r = await send('Page.captureScreenshot', { format: 'png' }, sid);
  await evaluate("document.getElementById('out')?.style.removeProperty('visibility')");
  await writeFile(path.join(shots, `${name}-${width}${reduced ? '-reduced' : ''}.png`), Buffer.from(r.data, 'base64'));
}
// Scroll so the middle of the viewport sits at share p of the chapter's section.
const toChapter = (id, p) => evaluate(`(s=>{const r=s.getBoundingClientRect();scrollTo({top:scrollY+r.top+r.height*${p}-innerHeight/2,behavior:'instant'})})(document.querySelector('[data-chapter="${id}"]')||document.getElementById('${id}'))`);
const mouse = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' }, sid);

try {
  await connect();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid); await send('Performance.enable', {}, sid);
  const phone = width < 600;
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: phone }, sid);
  if (phone) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);
  if (reduced) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sid);
  await send('Page.navigate', { url: base + PAGE }, sid);
  let info = null;
  for (let i = 0; i < 150 && !(info = await evaluate('window.__scene && window.__scene.info.count ? window.__scene.info : null').catch(() => null)); i++) await sleep(200);
  await sleep(2500);   // fade-ins finish
  console.log(JSON.stringify({ probe: 'scene-probe', root, width, dpr, reduced, chrome: (await send('Browser.getVersion')).product,
    info: info && { count: info.count, snapshotUtc: info.snapshotUtc, phone: info.phone, reducedMotion: info.reducedMotion, fleets: info.fleets },
    canvas: await evaluate("(c=>[c.width,c.height])(document.getElementById('space'))"),
    overflowX: await evaluate('document.documentElement.scrollWidth - innerWidth') }));
  await shot('hero');
  await measure('hero-rest', 5);
  if (!phone) await measure('hero-pointer-moving', 5, async end => { for (let i = 0; Date.now() < end - 100; i++) { await mouse(width * (0.3 + 0.4 * Math.abs(Math.sin(i / 20))), height * 0.5); await sleep(16); } });
  // Hover sweep (desktop) or tap sweep (phone) until a pick arrives.
  let picked = null;
  await evaluate("__scene.on('pick',p=>{if(p)__probe.picks.push(p)})");
  for (let y = 0.2; y < 0.85 && !picked; y += 0.03) for (let x = 0.3; x < 0.98 && !picked; x += 0.015) {
    const px = Math.round(width * x), py = Math.round(height * y);
    if (phone) {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: px, y: py }] }, sid);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sid);
    } else await mouse(px, py);
    await sleep(phone ? 40 : 20);
    picked = await evaluate('__probe.picks.length ? __probe.picks[__probe.picks.length-1] : null');
  }
  if (picked) await sleep(1500);
  const last = await evaluate('__probe.picks.length ? __probe.picks[__probe.picks.length-1] : null');
  console.log(JSON.stringify({ pick: last ? { name: last.name, norad: last.norad, operator: last.operator, heightKm: last.heightKm && Math.round(last.heightKm) } : null,
    label: await evaluate("document.getElementById('label')?.textContent ?? document.getElementById('pick')?.textContent ?? null") }));
  if (picked) { await shot('hero-picked'); await measure('hero-picked', 5); }
  if (!phone) await mouse(5, 5);
  for (const id of ['retire', 'simulator', 'planner', 'findings', 'roadmap', 'about']) {
    await toChapter(id, 0.5); await sleep(reduced ? 600 : 2500);
    await shot(id);
    await measure(`${id}-mid`, 3);
  }
  // Scrub the retire chapter from top to bottom: the low satellite falls and burns, the high one stays.
  const seen = [];
  await evaluate("__scene.on('retire',s=>{__probe.retire=s})");
  const scrub = await measure('retire-scrub', 6, async end => {
    for (let k = 0; k <= 40; k++) {
      await toChapter('retire', 0.02 + 0.96 * k / 40); await sleep(130);
      const s = await evaluate('__probe.retire||null');
      if (s && (k % 8 === 0 || k === 40)) seen.push({ p: +(0.02 + 0.96 * k / 40).toFixed(2), year: +s.years.toFixed(2), lowKm: s.lowKm && Math.round(s.lowKm), highKm: s.highKm && Math.round(s.highKm) });
    }
  });
  await shot('retire-end');
  console.log(JSON.stringify({ retireScrub: seen, scrubFps: scrub.fps }));
  // Hidden tab.
  await toChapter('hero', 0.3); await sleep(1500);
  const other = (await send('Target.createTarget', { url: 'about:blank' })).targetId; await send('Target.activateTarget', { targetId: other }); await sleep(500);
  console.log(JSON.stringify({ visibility: await evaluate('document.visibilityState') }));
  await measure('hero-hidden', 5);
  await send('Target.closeTarget', { targetId: other }); await send('Target.activateTarget', { targetId }); await sleep(800);
  await measure('hero-visible-again', 3);
  await evaluate('__scene.pause()'); await sleep(300);
  await measure('hero-paused', 3);
  await evaluate('__scene.resume()');
  const errs = await evaluate('__probe.errs');
  const files = Object.entries(bytes.files).sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(JSON.stringify({ servedBytes: bytes.total, largest: files, errors: errs }));
  process.exitCode = errs.length ? 1 : 0;
} catch (e) {
  console.error('[scene-probe] failed:', e.message); process.exitCode = 2;
} finally {
  chrome.kill(); server.close(); ws?.close();
  await sleep(500); await rm(profile, { recursive: true, force: true });
}
