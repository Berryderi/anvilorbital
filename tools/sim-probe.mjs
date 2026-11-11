// Simulator performance probe (WQ-018). No dependencies: Node 22+ and Google Chrome.
// Usage: node tools/sim-probe.mjs <site root> [--width 1280] [--shots <dir>]
// Serves the site on 127.0.0.1, opens /simulator/ in headless Chrome (SwiftShader WebGL) and measures:
//   mode 1 playing at x100 (10 s), with a satellite selected, after a drag, paused, paused after a drag,
//   playing off screen, playing in a hidden tab; mode 2 playing, after a drag, off screen, paused (5 s each).
//   Per run: rAF callbacks per second, frames drawn per second, main-thread ms per drawn frame (time inside
//   requestAnimationFrame callbacks that issued a WebGL draw), SGP4 propagate calls per second, JS errors.
// Nothing is changed on disk: the probe hooks are injected into the served copy of the page only.
import http from 'node:http';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const root = path.resolve(args[0] || '.');
const opt = name => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : null; };
const width = Number(opt('--width') || 1280), height = 900;
const shots = opt('--shots');
const CHROME = process.env.CHROME || 'google-chrome';
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 500);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Runs before any page script: error capture, rAF timing, WebGL draw counting.
const HARNESS = `<script>
window.__probe={prop:0,cbs:0,frames:0,drawMs:0,maxMs:0,draws:0,errs:[]};
addEventListener('error',e=>__probe.errs.push('error: '+(e.message||(e.target&&(e.target.src||e.target.href))||'resource')),true);
addEventListener('unhandledrejection',e=>__probe.errs.push('rejection: '+e.reason));
{const ce=console.error;console.error=(...a)=>{__probe.errs.push('console.error: '+a.join(' '));ce(...a);};}
for(const C of [WebGLRenderingContext,WebGL2RenderingContext])for(const m of ['drawArrays','drawElements']){const f=C.prototype[m];C.prototype[m]=function(...a){__probe.draws++;return f.apply(this,a);};}
{const raf=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=cb=>raf(ts=>{const d0=__probe.draws,t0=performance.now();cb(ts);const dt=performance.now()-t0;__probe.cbs++;if(__probe.draws>d0){__probe.frames++;__probe.drawMs+=dt;__probe.maxMs=Math.max(__probe.maxMs,dt);}});}
</script>`;
const PROP_PATH = '/assets/vendor/satellite.js/propagation.js';
const WRAPPER = `import * as P from '${PROP_PATH}';
export * from '${PROP_PATH}';
export function propagate(...a) { window.__probe.prop++; return P.propagate(...a); }`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/__probe/prop.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(WRAPPER); }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) throw new Error('outside root');
    let body = await readFile(file);
    if (p === '/simulator/index.html') {
      let html = body.toString();
      // Only modules under /assets/ get the counting wrapper, so the wrapper itself still loads the real file.
      html = html.replace(/<script type="importmap">(.*?)<\/script>/s, (m, json) => {
        const map = JSON.parse(json); map.scopes = { '/assets/': { [PROP_PATH]: '/__probe/prop.js' } };
        return `<script type="importmap">${JSON.stringify(map)}</script>`;
      });
      body = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">' + HARNESS);
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// A throwaway profile, removed at the end. Chrome's socket path must stay short, so this sits in the OS temp folder.
const profile = await mkdtemp(path.join(os.tmpdir(), 'sim-probe-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars',
  '--no-first-run', '--user-data-dir=' + profile,
  `--remote-debugging-port=${DEBUG_PORT}`, `--window-size=${width},${height}`, 'about:blank'], { stdio: ['ignore', 'ignore', process.env.PROBE_DEBUG ? 'inherit' : 'ignore'] });

let ws, seq = 0; const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = ++seq; ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((ok, fail) => pending.set(id, { ok, fail }));
}
async function connect() {
  for (let i = 0; i < 50; i++) {
    try { const v = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); ws = new WebSocket(v.webSocketDebuggerUrl); break; }
    catch (e) { if (i === 49) console.error("[sim-probe] connect:", e.message, e.cause?.message); await sleep(200); }
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
async function measure(name, seconds) {
  await reset(); await sleep(seconds * 1000);
  const p = await evaluate('({...__probe})');
  const row = { run: name, seconds, callbacksPerS: +(p.cbs / seconds).toFixed(1), fps: +(p.frames / seconds).toFixed(1), frames: p.frames,
    msPerFrame: p.frames ? +(p.drawMs / p.frames).toFixed(2) : 0, maxMs: +p.maxMs.toFixed(1),
    propagatePerS: Math.round(p.prop / seconds), errors: p.errs.length };
  console.log(JSON.stringify(row));
  return row;
}
async function shot(name) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sid);
  await writeFile(path.join(shots, `${name}-${width}.png`), Buffer.from(r.data, 'base64'));
}
const click = id => evaluate(`document.getElementById('${id}').click()`);
const text = id => evaluate(`document.getElementById('${id}').textContent`);
// Wait until no frame has run for 1.5 s (for example, OrbitControls damping after a drag), at most 20 s.
async function settle() {
  for (let total = 0, quiet = 0, prev = -1; total < 20000 && quiet < 1500; total += 500) { const n = await evaluate('__probe.cbs'); quiet = n === prev ? quiet + 500 : 0; prev = n; await sleep(500); }
}
async function setPlaying(id, on) { if (((await text(id)) === 'Pause') !== on) await click(id); }

try {
  await connect();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 }, sid);
  await send('Page.navigate', { url: `${base}/simulator/` }, sid);
  for (let i = 0; i < 100 && !(await evaluate("!!document.getElementById('legend-1') && /\\(\\d/.test(document.getElementById('legend-1').textContent)").catch(() => false)); i++) await sleep(200);
  await sleep(1000);
  console.log(JSON.stringify({ probe: 'sim-probe', root, width, chrome: (await send('Browser.getVersion')).product,
    startsPlaying: (await text('play-1')) === 'Pause', shownNote: await text('data-note') }));
  await shot('mode1');
  await shot('mode1');

  // Each run starts from a known state and is measured after the state change has settled.
  const offScreen = async on => {
    await evaluate(on ? "document.body.append(Object.assign(document.createElement('div'),{id:'probe-pad',style:'height:4000px'}));scrollTo(0,document.scrollingElement.scrollHeight)"
      : "document.getElementById('probe-pad')?.remove();scrollTo(0,0)");
    await sleep(500);
    const gone = await evaluate("document.getElementById('stage').getBoundingClientRect().bottom < 0");
    if (on && !gone) console.log(JSON.stringify({ warning: 'stage still on screen during the off-screen run' }));
  };
  const drag = async () => {
    const [x, y] = await evaluate("(r=>[r.left+r.width/2,r.top+r.height/2])(document.getElementById('scene').getBoundingClientRect())");
    const m = (type, dx, extra = {}) => send('Input.dispatchMouseEvent', { type, x: x + dx, y, button: 'left', ...extra }, sid);
    await m('mousePressed', 0, { clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 10; i++) { await m('mouseMoved', i * 15, { buttons: 1 }); await sleep(16); }
    await m('mouseReleased', 150, { clickCount: 1, buttons: 0 });
  };
  // Hidden tab: open a second tab in front of the simulator.
  const hide = async on => {
    if (on) { hide.other = (await send('Target.createTarget', { url: 'about:blank' })).targetId; await send('Target.activateTarget', { targetId: hide.other }); }
    else { await send('Target.closeTarget', { targetId: hide.other }); await send('Target.activateTarget', { targetId }); }
    await sleep(500);
    const state = await evaluate('document.visibilityState');
    if (on && state !== 'hidden') console.log(JSON.stringify({ warning: `tab still ${state} during the hidden run` }));
  };

  await evaluate("(s=>{s.value='100';s.dispatchEvent(new Event('change'))})(document.getElementById('speed-1'))");
  await setPlaying('play-1', true); await sleep(500);
  await measure('mode1-playing-x100', 10);
  await click('next-sat'); await sleep(300);
  await measure('mode1-playing-selected', 5);
  await drag(); await measure('mode1-playing-after-drag', 5);
  await setPlaying('play-1', false); await settle();
  await measure('mode1-paused', 5);
  await drag(); await measure('mode1-paused-after-drag', 5);
  await setPlaying('play-1', true);
  await offScreen(true); await measure('mode1-playing-offscreen', 5); await offScreen(false);
  await hide(true); await measure('mode1-playing-hidden', 5); await hide(false);
  await setPlaying('play-1', false); await sleep(300);

  await click('mode-2'); await setPlaying('play-2', true); await sleep(500);
  await measure('mode2-playing', 5);
  await drag(); await measure('mode2-playing-after-drag', 5);
  await offScreen(true); await measure('mode2-playing-offscreen', 5); await offScreen(false);
  await setPlaying('play-2', false); await settle();
  await measure('mode2-paused', 5);
  await shot('mode2');
  const errs = await evaluate('__probe.errs');
  console.log(JSON.stringify({ errors: errs }));
  process.exitCode = errs.length ? 1 : 0;
} catch (e) {
  console.error('[sim-probe] failed:', e.message); process.exitCode = 2;
} finally {
  chrome.kill(); server.close(); ws?.close();
  await sleep(500); await rm(profile, { recursive: true, force: true });
}
