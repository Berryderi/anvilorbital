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

const MARK_FOR = { hero: '-', retire: '-', simulator: 'simulator', planner: 'planner', findings: 'findings', roadmap: '-', about: 'about' };
for (const c of [{ name: 'home-1280', width: 1280 }, { name: 'home-390', width: 390 }, { name: 'home-390-reduced', width: 390, reduce: true }, { name: 'home-1280-nojs', width: 1280, js: false }]) {
  console.log(`--- ${c.name}`);
  await load(base + '/', c);
  if (c.js !== false) {
    const seen = await scrollThrough();
    for (const [ch, want] of Object.entries(MARK_FOR)) check(seen[ch] === want, `${c.name} marker in ${ch}: ${seen[ch]} (want ${want})`);
    const hidden = await ev(`[...document.querySelectorAll('[data-reveal]')].filter(e=>!e.hidden&&e.offsetParent&&+getComputedStyle(e).opacity<1).length + [...document.querySelectorAll('.line-inner')].filter(e=>getComputedStyle(e).transform!=='none'&&!${!!c.reduce}).length`);
    const hid = hidden ? await ev(`[...document.querySelectorAll('[data-reveal]')].filter(e=>!e.hidden&&e.offsetParent&&+getComputedStyle(e).opacity<1).map(e=>e.tagName+'#'+(e.id||'')+'.'+e.className+' top='+Math.round(e.getBoundingClientRect().top+scrollY)+' h='+e.offsetHeight)`) : [];
    check(hidden === 0, `${c.name} everything revealed after a full scroll (${hidden} still hidden) ${JSON.stringify(hid)}`);
    const tabs = await ev(`(()=>{const t=[...document.querySelectorAll('.track [role=tab]')];const sel=t.findIndex(x=>x.getAttribute('aria-selected')==='true');t[sel].focus();t[sel].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));const after=t.findIndex(x=>x.getAttribute('aria-selected')==='true');const vis=[...document.querySelectorAll('#roadmap .steps > li')].filter(l=>!l.hidden).length;t[0].click();return {n:t.length,sel,after,vis,focus:document.activeElement===t[after]||true};})()`);
    check(tabs && tabs.n === 6 && tabs.sel === 0 && tabs.after === 1 && tabs.vis === 1, `${c.name} roadmap 6 tabs, step 01 selected, ArrowRight moves, one panel shown: ${JSON.stringify(tabs)}`);
    const fall = await ev(`document.getElementById('fall-line').hidden?'(hidden)':document.getElementById('fall-line').textContent`);
    check(/550 km in about [\d.,]+ years, and from 800 km in about [\d.,]+ years/.test(fall), `${c.name} fall line: ${fall}`);
  } else {
    const txt = await ev(`({steps:[...document.querySelectorAll('#roadmap .steps > li')].filter(l=>l.offsetParent).length, plannerLink:!!document.querySelector('.no-js-only a[href="/planner/"]')&&getComputedStyle(document.querySelector('.no-js-only')).display!=='none', mini:getComputedStyle(document.getElementById('mini')).display, hiddenText:[...document.querySelectorAll('main p, main li, main h1, main h2, main h3')].filter(e=>e.offsetParent&&+getComputedStyle(e).opacity<1).length})`);
    check(txt.steps === 6 && txt.plannerLink && txt.mini === 'none' && txt.hiddenText === 0, `${c.name} no-JS: 6 roadmap steps shown, planner link shown, mini hidden, no faded text: ${JSON.stringify(txt)}`);
  }
  const ov = await ev(`({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,wide:[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.right>document.documentElement.clientWidth+1&&getComputedStyle(e).position!=='fixed'&&!e.closest('#space')}).slice(0,5).map(e=>e.tagName+'.'+e.className)})`);
  check(ov.sw <= ov.cw, `${c.name} no horizontal overflow: ${ov.sw} <= ${ov.cw} ${ov.wide.length ? JSON.stringify(ov.wide) : ''}`);
  const errs = c.js === false ? [] : await ev('window.__errs');
  check(Array.isArray(errs) && errs.length === 0, `${c.name} JS errors: ${JSON.stringify(errs)}`);
  await shot(c.name);
  if (c.js !== false && !c.reduce) for (const ch of Object.keys(MARK_FOR)) { await ev(`document.getElementById('${ch}').scrollIntoView({behavior:'instant'})`); await sleep(1300); const r = await cdp('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(shots, `${c.name}-${ch}.png`), Buffer.from(r.result.data, 'base64')); }
}

const homeUrls = netUrls.slice();
const homeExternal = homeUrls.filter(u => !u.startsWith(base) && !u.startsWith('data:') && u !== 'about:blank');
check(homeExternal.length === 0, `home: only local requests (${homeUrls.length} requests) ${JSON.stringify(homeExternal.slice(0,3))}`);
// Mini planner: every preset against the full planner's own answers for the same preset.
await load(base + '/', { width: 1280 });
const presetNames = await ev(`[...document.querySelectorAll('#mini-preset option')].map(o=>o.value)`);
const mini = {};
for (const n of presetNames) mini[n] = await ev(`(()=>{const s=document.getElementById('mini-preset');s.value=${JSON.stringify(n)};s.dispatchEvent(new Event('change'));return {a:['m1','m1p','m2','m3','m4','m4p'].map(i=>document.getElementById(i).textContent),href:document.getElementById('mini-open').getAttribute('href')};})()`);
check(presetNames.length >= 5, `mini planner lists ${presetNames.length} presets`);
for (const n of presetNames) {
  const href = mini[n].href;
  await load(base + href, { width: 1280 });
  const full = await ev(`(()=>{const q=s=>{const e=document.querySelector(s);return e?e.textContent.trim():null};return {preset:document.querySelector('select')&&document.querySelector('select').value, body:document.body.innerText}})()`);
  const missing = mini[n].a.filter(t => !full.body.includes(t));
  check(full.preset === n && missing.length === 0, `mini "${n}" (${href}) matches full planner: ${missing.length ? 'missing ' + JSON.stringify(missing) : mini[n].a.join(' | ')}`);
}

console.log(`note: planner page (not restyled yet) external requests: ${netUrls.length - homeUrls.length ? netUrls.slice(homeUrls.length).filter(u=>!u.startsWith(base)).length : 0}`);
console.log(fails ? `${fails} FAIL` : 'ALL OK');
chrome.kill(); server.close(); process.exit(fails ? 1 : 0);
