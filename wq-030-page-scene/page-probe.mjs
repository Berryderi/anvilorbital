// Page-mode probe (WQ-030). No deps: Node 22+ and Google Chrome.
// Usage: TMPDIR=/tmp/claude-1000 node page-probe.mjs <site root> <out dir> [--width 1280] [--reduced] [--nojs] [--savedata]
//        [--nostars] [--pages /planner/,/findings/] [--hidetext]
// Per page: waits for the scene, counts rAF callbacks and WebGL draws over 3 s idle, JS errors, overflow, has-scene,
// whether #space is drawn, which requests went out (and that all are local), screenshot. With --nostars the served
// scene.js has its stars removed (measurement copy only), and --hidetext hides the page so the canvas alone is shot;
// then it reports luminance stats over the lower right corner box, where the limb sits.
import http from 'node:http';
import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const root = path.resolve(args[0]); const out = path.resolve(args[1]);
const opt = n => { const i = args.indexOf(n); return i > 0 ? args[i + 1] : null; };
const flag = n => args.includes(n);
const width = Number(opt('--width') || 1280), height = width < 600 ? 844 : 900;
const pages = (opt('--pages') || '/planner/,/findings/,/about/,/privacy/,/404.html,/').split(',');
const tag = `${width}${flag('--reduced') ? '-reduced' : ''}${flag('--nojs') ? '-nojs' : ''}${flag('--savedata') ? '-savedata' : ''}${flag('--nostars') ? '-nostars' : ''}${flag('--hidetext') ? '-canvas' : ''}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const HARNESS = `<script>
window.__p={cbs:0,draws:0,errs:[]};
addEventListener('error',e=>__p.errs.push('error: '+(e.message||(e.target&&(e.target.src||e.target.href))||'resource')),true);
addEventListener('unhandledrejection',e=>__p.errs.push('rejection: '+e.reason));
{const ce=console.error;console.error=(...a)=>{__p.errs.push('console.error: '+a.join(' '));ce(...a);};}
for(const C of [WebGLRenderingContext,WebGL2RenderingContext])for(const m of ['drawArrays','drawElements']){const f=C.prototype[m];C.prototype[m]=function(...a){__p.draws++;return f.apply(this,a);};}
{const raf=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=cb=>raf(ts=>{__p.cbs++;cb(ts);});}
</script>`;

const requests = [];
const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    requests.push(p);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) throw new Error('outside root');
    let body = await readFile(file);
    if (p.endsWith('.html')) body = Buffer.from(body.toString().replace('<meta charset="utf-8">', '<meta charset="utf-8">' + HARNESS));
    if (flag('--nostars') && p === '/assets/scene/scene.js') body = Buffer.from(body.toString().replace('for (const s of Object.values(STARS)) {\n    const n = s.n[phone ? 1 : 0]', 'for (const s of Object.values(STARS)) {\n    const n = 0'));
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const PORT = 9300 + Math.floor(Math.random() * 500);
const profile = await mkdtemp(path.join(os.tmpdir(), 'pp-'));
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--hide-scrollbars', '--no-first-run', '--user-data-dir=' + profile, `--remote-debugging-port=${PORT}`, `--window-size=${width},${height}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', process.env.PROBE_DEBUG ? 'inherit' : 'ignore'] });
// A hung Chrome must never hang the caller: kill it on TERM/INT and after a hard limit for the whole run.
const die = code => { try { chrome.kill('SIGKILL'); } catch { /* already gone */ } process.exit(code); };
process.on('SIGTERM', () => die(124)); process.on('SIGINT', () => die(124));
setTimeout(() => { console.error('page-probe: watchdog'); die(124); }, Number(process.env.PROBE_LIMIT_MS || 150000)).unref();
let ws, seq = 0; const pending = new Map();
const send = (method, params = {}, sessionId) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params, sessionId })); return new Promise((ok, fail) => pending.set(id, { ok, fail })); };
for (let i = 0; i < 50 && !ws; i++) { try { const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); ws = new WebSocket(v.webSocketDebuggerUrl); } catch { await sleep(200); } }
if (!ws) { console.error('Chrome did not start'); process.exit(2); }
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
ws.onmessage = m => { const d = JSON.parse(m.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.fail(new Error(d.error.message)) : p.ok(d.result); } };
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true });
const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sid); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '')); return r.result.value; };
await send('Page.enable', {}, sid);
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 }, sid);
if (flag('--reduced')) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sid);
if (flag('--nojs')) await send('Emulation.setScriptExecutionDisabled', { value: true }, sid);
if (flag('--savedata')) await send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator,'connection',{value:{saveData:true}})" }, sid);
await mkdir(out, { recursive: true });

let fails = 0;
for (const pg of pages) {
  requests.length = 0;
  await send('Page.navigate', { url: base + pg }, sid);
  await sleep(flag('--nojs') ? 1500 : 5000);   // idle start (<=1.5 s) + texture + first draw + fade
  const row = { page: pg, width };
  if (!flag('--nojs')) {
    const a = await ev('({...__p, errs: [...__p.errs]})'); await sleep(3000); const b = await ev('({...__p, errs: [...__p.errs]})');
    Object.assign(row, { idleCallbacks3s: b.cbs - a.cbs, idleDraws3s: b.draws - a.draws, totalDraws: b.draws, errors: b.errs,
      hasScene: await ev("document.documentElement.classList.contains('has-scene')"),
      canvasOpacity: await ev("getComputedStyle(document.getElementById('space')||document.body).opacity"),
      sceneMode: await ev("document.getElementById('space')?.dataset.sceneMode ?? null") });
    // resize: one redraw then idle again
    await send('Emulation.setDeviceMetricsOverride', { width: width - 40, height, deviceScaleFactor: 1, mobile: width < 600 }, sid); await sleep(800);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 }, sid); await sleep(800);
    const c = await ev('({...__p})'); await sleep(2000); const d = await ev('({...__p})');
    Object.assign(row, { drawsOnResize: c.draws - b.draws, idleCallbacksAfterResize2s: d.cbs - c.cbs });
  }
  row.overflow = await ev('document.documentElement.scrollWidth > innerWidth');
  row.bgImage = await ev("(()=>{const s=document.getElementById('space');return s?getComputedStyle(s).backgroundImage.slice(0,30):null})()");
  row.nonLocal = requests.filter(u => !u.startsWith('/')).length;
  row.requests = [...new Set(requests)].filter(u => /scene|three|webp/.test(u));
  if (flag('--hidetext')) await ev("(()=>{for(const el of document.body.children) if(el.id!=='space') el.style.visibility='hidden'; return 1})()");
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  const file = path.join(out, `${pg.replace(/[\/.]/g, '_') || 'root'}-${tag}.png`);
  await writeFile(file, Buffer.from(shot.data, 'base64'));
  if (flag('--hidetext')) {
    // Relative luminance (WCAG) of every pixel in the lower right box (right 45%, bottom 45%) of the canvas-only shot.
    row.lum = await ev(`(async()=>{const img=new Image(); img.src='data:image/png;base64,${shot.data}'; await img.decode();
      const c=document.createElement('canvas'); c.width=img.width; c.height=img.height; const x=c.getContext('2d'); x.drawImage(img,0,0);
      const x0=Math.floor(img.width*0.55), y0=Math.floor(img.height*0.55), w=img.width-x0, h=img.height-y0; const d=x.getImageData(x0,y0,w,h).data;
      const lin=v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4}; const L=[];
      for(let i=0;i<d.length;i+=4) L.push(0.2126*lin(d[i])+0.7152*lin(d[i+1])+0.0722*lin(d[i+2]));
      L.sort((a,b)=>a-b); const q=p=>+L[Math.min(L.length-1,Math.floor(L.length*p))].toFixed(4);
      return {p50:q(0.5),p99:q(0.99),p999:q(0.999),max:q(1),over0311:L.filter(v=>v>0.0311).length,n:L.length};})()`);
  }
  const bad = row.errors?.length || row.overflow || row.nonLocal || (!flag('--nojs') && (row.idleCallbacks3s || row.idleDraws3s || row.idleCallbacksAfterResize2s));
  if (bad) fails++;
  console.log((bad ? 'FAIL ' : 'OK   ') + JSON.stringify(row));
}
chrome.kill(); server.close();
console.log(fails ? `${fails} FAIL` : 'ALL OK');
process.exit(fails ? 1 : 0);
