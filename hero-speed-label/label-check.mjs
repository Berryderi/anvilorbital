// Home probe for WQ-027 PR 2. Usage: node home-probe.mjs <site root> <shots dir>
// Serves the site, opens / in headless Chrome over CDP and, for each case (1280, 390, 390 reduced motion, 1280 no JS):
// JS errors from page start, horizontal overflow, nav marker on the right link per chapter, mini planner answers
// against the planner page itself for every preset, roadmap tabs and keyboard, reveal state after a full scroll,
// and full-page screenshots.
import http from 'node:http';
import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(process.argv[2]);
const shots = path.resolve(process.argv[3]);
await mkdir(shots, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HARNESS = `<script>window.__errs=[];addEventListener('error',e=>__errs.push('error: '+(e.message||(e.target&&(e.target.src||e.target.href))||'resource')),true);addEventListener('unhandledrejection',e=>__errs.push('rejection: '+e.reason));{const ce=console.error;console.error=(...a)=>{__errs.push('console.error: '+a.join(' '));ce(...a);};}</script>`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2' };
const requests = [];
const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  requests.push(p);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  try {
    if (!file.startsWith(root)) throw 0;
    let body = await readFile(file);
    if (p.endsWith('.html')) body = body.toString().replace('<meta charset="utf-8">', '<meta charset="utf-8">' + HARNESS);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const port = 9300 + Math.floor(Math.random() * 500);
const prof = await mkdtemp('/tmp/claude-1000/hp-');
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--hide-scrollbars', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
let ws;
for (let i = 0; i < 50 && !ws; i++) { try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const pg = t.find(x => x.type === 'page'); if (pg) ws = pg.webSocketDebuggerUrl; } catch {} await sleep(200); }
if (!ws) { console.log('FAIL chrome did not start'); process.exit(1); }
const sock = new WebSocket(ws); await new Promise(r => sock.onopen = r);
let id = 0; const pending = new Map();
const netUrls = [];
sock.onmessage = m => { const d = JSON.parse(m.data); if (d.method === "Network.requestWillBeSent") netUrls.push(d.params.request.url); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const cdp = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) return { probeError: r.result.exceptionDetails.exception?.description }; return r.result?.result?.value; };
await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable');

let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'OK   ' : 'FAIL ') + msg); if (!ok) fails++; };

async function load(url, { width, js = true, reduce = false, height = 900 }) {
  await cdp('Emulation.setScriptExecutionDisabled', { value: !js });
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }] });
  await cdp('Page.navigate', { url });
  await sleep(1800);
}
async function scrollThrough() {
  return ev(`(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));const seen={};for(let y=0;y<=document.documentElement.scrollHeight;y+=Math.round(innerHeight/3)){scrollTo(0,y);await s(140);const a=document.querySelector('.nav-links a[aria-current]');const mid=document.elementFromPoint(innerWidth/2,innerHeight/2);const ch=mid&&mid.closest('.chapter');if(ch)seen[ch.id]=(a&&a.dataset.ch)||'-';}await s(1500);scrollTo(0,0);await s(300);return seen;})()`);
}
async function shot(name, fullHeight) {
  const h = fullHeight || await ev('document.documentElement.scrollHeight');
  const w = await ev('innerWidth');
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: Math.min(h, 16000), scale: 1 } });
  await writeFile(path.join(shots, name + '.png'), Buffer.from(r.result.data, 'base64'));
}


for (const [w,js] of [[1280,true],[390,true],[1280,false]]) {
  await load(base+"/",{width:w,js}); await sleep(js?4000:500);
  const r=await ev(`({note:(()=>{const n=document.querySelector(".scene-note");return n?{hidden:n.hidden,text:n.innerText}:null})(),ts:document.getElementById("time-scale").hidden,errs:window.__errs||[]})`);
  console.log(w,js,JSON.stringify(r));
  if (js) check(!r.note.hidden && /snapshot of 10 Nov 2026, sped up \d+ times\./.test(r.note.text) && r.errs.length===0, w+" label shows from the real scene");
  else check(r.note.hidden && r.ts, w+" no JS: note and label hidden");
  if (js) { const shot=await cdp("Page.captureScreenshot",{format:"png"}); await writeFile(path.join(shots,"hero-label-"+w+".png"),Buffer.from(shot.result.data,"base64")); }
}
console.log(fails?fails+" FAIL":"ALL OK"); chrome.kill(); server.close(); process.exit(fails?1:0);
