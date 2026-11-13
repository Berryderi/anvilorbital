// WQ-027 recordings: a scroll recording of home and a star-arrival frame series on tool pages, in Chrome on the
// laptop's real GPU (headless=new without SwiftShader; the WebGL renderer string is logged so this can be checked).
// Usage: TMPDIR=/tmp/claude-1000/d4 node record.mjs <site root> <out dir>
// Writes per clip: frames/<clip>/NNNN.jpg (CDP screencast, with timestamps), <clip>.txt (ffmpeg concat list) and
// stats.json: rAF frame intervals in the page during the scroll (p50/p95/max, count over 50 ms), JS errors, renderer.
import http from 'node:http';
import { readFile, mkdir, writeFile, mkdtemp, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const [root, out] = process.argv.slice(2).map(p => path.resolve(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const HARNESS = `<script>window.__errs=[];window.__raf=[];addEventListener('error',e=>__errs.push('error: '+(e.message||(e.target&&(e.target.src||e.target.href))||'resource')),true);addEventListener('unhandledrejection',e=>__errs.push('rejection: '+e.reason));{const ce=console.error;console.error=(...a)=>{__errs.push('console.error: '+a.join(' '));ce(...a);};}{const t=ts=>{__raf.push(ts);requestAnimationFrame(t)};requestAnimationFrame(t);}</script>`;
const isDir = async f => { try { return (await stat(f)).isDirectory(); } catch { return false; } };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); let p = decodeURIComponent(u.pathname); let file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (!p.endsWith('/') && await isDir(file)) { res.writeHead(301, { location: p + '/' }); return res.end(); }
  if (p.endsWith('/')) file = path.join(file, 'index.html');
  try {
    let body = await readFile(file);
    if (file.endsWith('.html')) body = body.toString().replace('<meta charset="utf-8">', '<meta charset="utf-8">' + HARNESS);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const PORT = 9300 + Math.floor(Math.random() * 500);
const prof = await mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'rec-'));
// GPU flags from REC_FLAGS (space separated); the default is headless with the GPU allowed.
const GPU = (process.env.REC_FLAGS ?? '--headless=new --enable-gpu --ignore-gpu-blocklist').split(' ').filter(Boolean);
const chrome = spawn(process.env.CHROME || 'google-chrome', [...GPU, '--no-first-run', '--hide-scrollbars',
  `--user-data-dir=${prof}`, `--remote-debugging-port=${PORT}`, '--window-size=1280,800', 'about:blank'],
  { stdio: ['ignore', 'ignore', process.env.PROBE_DEBUG ? 'inherit' : 'ignore'] });
const die = code => { try { chrome.kill('SIGKILL'); } catch { /* gone */ } process.exit(code); };
process.on('SIGTERM', () => die(124)); process.on('SIGINT', () => die(124));
setTimeout(() => { console.log('FAIL watchdog'); die(124); }, 240000).unref();

let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) { try { const t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); wsUrl = t.find(x => x.type === 'page')?.webSocketDebuggerUrl; } catch { /* not up yet */ } await sleep(200); }
if (!wsUrl) { console.log('FAIL chrome did not start'); die(1); }
const ws = new WebSocket(wsUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); let onFrame = null;
ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (d.method === 'Page.screencastFrame') { ws.send(JSON.stringify({ id: ++id, method: 'Page.screencastFrameAck', params: { sessionId: d.params.sessionId } })); onFrame?.(d.params); }
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
};
const cdp = (method, params = {}) => new Promise(r => { const i = ++id; const t = setTimeout(() => { pending.delete(i); r({ error: 'timeout ' + method }); }, 30000); pending.set(i, d => { clearTimeout(t); r(d); }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
await cdp('Page.enable'); await cdp('Runtime.enable');

const stats = {};
async function clip(name, { url, width, height, mobile = false, act, ms }) {
  const dir = path.join(out, 'frames', name); await mkdir(dir, { recursive: true });
  await cdp('Page.navigate', { url: 'about:blank' }); await sleep(200);
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  const frames = [];
  onFrame = async f => { const n = String(frames.length).padStart(4, '0'); frames.push({ n, t: f.metadata.timestamp }); await writeFile(path.join(dir, n + '.jpg'), Buffer.from(f.data, 'base64')); };
  await cdp('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
  const t0 = Date.now();
  await cdp('Page.navigate', { url: base + url });
  if (act) await act(); else await sleep(ms);
  await cdp('Page.stopScreencast'); await sleep(300); onFrame = null;
  const s = await ev(`(()=>{const r=window.__raf||[];const d=r.slice(1).map((t,i)=>t-r[i]).sort((a,b)=>a-b);const q=p=>d.length?+d[Math.min(d.length-1,Math.floor(d.length*p))].toFixed(1):null;
    let gl='';try{const c=document.createElement('canvas').getContext('webgl2')||document.createElement('canvas').getContext('webgl');const x=c&&c.getExtension('WEBGL_debug_renderer_info');gl=!c?'no webgl':x?c.getParameter(x.UNMASKED_RENDERER_WEBGL):c.getParameter(c.RENDERER);}catch(e){gl='error '+e.message}
    return {rafFrames:r.length,p50:q(0.5),p95:q(0.95),max:q(1),over50:d.filter(v=>v>50).length,errs:window.__errs,renderer:gl,scrollH:document.documentElement.scrollHeight};})()`);
  // concat list for ffmpeg with the real gap to the next frame (screencast only sends frames when pixels change)
  const lines = frames.map((f, i) => `file '${path.join(dir, f.n + '.jpg')}'\nduration ${((frames[i + 1]?.t ?? f.t + 0.5) - f.t).toFixed(3)}`);
  if (frames.length) lines.push(`file '${path.join(dir, frames.at(-1).n + '.jpg')}'`);
  await writeFile(path.join(out, name + '.txt'), lines.join('\n') + '\n');
  stats[name] = { url, width, height, frames: frames.length, wallMs: Date.now() - t0, firstFrameT: frames[0]?.t, ...s };
  console.log((s?.errs?.length ? 'FAIL ' : 'OK   ') + name + ' ' + JSON.stringify(stats[name]));
}
// Real wheel input, like a mouse: 100 px notches every 60 ms down to the bottom, a pause, then back to the top.
const wheelThrough = (w, h) => async () => {
  await sleep(4000);
  await ev('window.__raf=[]');
  const H = await ev('document.documentElement.scrollHeight');
  for (let y = 0; y < H; y += 100) { await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: w / 2, y: h / 2, deltaX: 0, deltaY: 100 }); await sleep(60); }
  await sleep(1500);
};
if (process.env.REC_RENDERER_ONLY) {
  await cdp('Page.navigate', { url: base + '/privacy/' }); await sleep(1500);
  console.log('renderer: ' + await ev(`(()=>{const c=document.createElement('canvas').getContext('webgl2');if(!c)return 'no webgl';const x=c.getExtension('WEBGL_debug_renderer_info');return x?c.getParameter(x.UNMASKED_RENDERER_WEBGL):c.getParameter(c.RENDERER)})()`));
  die(0);
}
await clip('home-scroll-1280', { url: '/', width: 1280, height: 800, act: wheelThrough(1280, 800) });
await clip('home-scroll-390', { url: '/', width: 390, height: 844, mobile: true, act: wheelThrough(390, 844) });
for (const p of ['/planner/', '/findings/', '/simulator/', '/about/'])
  await clip('arrive' + p.replace(/\//g, '-').replace(/-$/, '') + '-1280', { url: p, width: 1280, height: 800, ms: 6000 });
await writeFile(path.join(out, 'stats.json'), JSON.stringify(stats, null, 1));
chrome.kill(); server.close(); console.log('RECORD-DONE');
process.exit(0);
