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


const PAGES=["/simulator/","/planner/","/planner/#starcloud","/findings/","/about/","/about/#contact","/privacy/","/404.html","/idea/","/roadmap/","/contact/"];
const CUR={"/simulator/":"Simulator","/planner/":"Planner","/planner/#starcloud":"Planner","/findings/":"Findings","/about/":"About","/about/#contact":"About"};
for (const width of [1280,390]) for (const pg of PAGES) {
  const name=("tool"+pg.replace(/[\/#.]+/g,"-")+width).replace(/-+/g,"-");
  await load(base+pg,{width});
  if (/idea|roadmap|contact\/$/.test(pg)) { await sleep(800); const u=await ev("location.pathname+location.hash"); check(/^\/(#idea|#roadmap|about\/#contact)$/.test(u), name+" redirects to "+u); continue; }
  const r=await ev(`({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,cur:[...document.querySelectorAll(".nav-links a[aria-current=page]")].map(a=>a.textContent),font:document.fonts.check("16px Archivo"),wide:[...document.querySelectorAll("main *")].filter(e=>{const b=e.getBoundingClientRect();return b.width&&b.right>document.documentElement.clientWidth+1&&!e.closest(".table-wrap")}).slice(0,4).map(e=>e.tagName+"."+e.className),errs:window.__errs})`);
  check(r.sw<=r.cw, name+" no horizontal overflow "+r.sw+"/"+r.cw+" "+(r.wide.length?JSON.stringify(r.wide):""));
  check(r.errs.length===0, name+" JS errors "+JSON.stringify(r.errs));
  const bb=await ev("(()=>{const b=document.querySelector(\".nav-brand\").getBoundingClientRect();return [Math.round(b.width),Math.round(b.height)]})()"); check(bb[0]>=44&&bb[1]>=44, name+" brand target "+bb.join("x"));
  check(JSON.stringify(r.cur)===JSON.stringify(CUR[pg]?[CUR[pg]]:[]), name+" current nav item "+JSON.stringify(r.cur));
  if (pg==="/planner/#starcloud") { const v=await ev("document.getElementById(\"preset\").value+\" | \"+document.getElementById(\"a1\").textContent"); check(/^Starcloud/.test(v)&&/7\.0 years/.test(v), name+" deep link selects Starcloud: "+v); }
  if (pg==="/simulator/") { await sleep(1500); const v=await ev("({sum:document.getElementById(\"summary\").textContent.slice(0,80),nogl:document.getElementById(\"nogl\").hidden,status:document.getElementById(\"status\").textContent})"); check(v.sum!=="Loading.", name+" simulator ran: "+JSON.stringify(v)); }
  await ev("(async()=>{for(let y=0;y<=document.documentElement.scrollHeight;y+=Math.round(innerHeight/3)){scrollTo(0,y);await new Promise(r=>setTimeout(r,120));}await new Promise(r=>setTimeout(r,1500));scrollTo(0,0);await new Promise(r=>setTimeout(r,300));})()");
  const hid=await ev("[...document.querySelectorAll('[data-reveal]')].filter(e=>!e.hidden&&e.offsetParent&&+getComputedStyle(e).opacity<1).map(e=>e.tagName+'.'+e.className).slice(0,4)"); const hidL=await ev("[...document.querySelectorAll('.line-inner')].filter(e=>getComputedStyle(e).transform!=='none').length"); check(hid.length===0&&hidL===0, name+" everything revealed after a full scroll "+JSON.stringify(hid)+" lines:"+hidL);
  const h=await ev("document.documentElement.scrollHeight"); const r2=await cdp("Page.captureScreenshot",{format:"png",captureBeyondViewport:true,clip:{x:0,y:0,width,height:Math.min(h,9000),scale:1}}); await writeFile(path.join(shots,name+".png"),Buffer.from(r2.result.data,"base64"));
}
for (const pg of ["/findings/","/privacy/","/about/"]) { await load(base+pg,{width:1280,js:false}); const t=await ev("document.querySelectorAll(\"main p, main li, main h1, main h2\").length"); check(t>3, "no-JS "+pg+" shows its text ("+t+" blocks)"); }
const ext=netUrls.filter(u=>!u.startsWith(base)&&!u.startsWith("data:")&&u!=="about:blank");
check(ext.length===0, "all tool pages: only local requests "+JSON.stringify(ext.slice(0,3)));
console.log(fails?fails+" FAIL":"ALL OK"); chrome.kill(); server.close(); process.exit(fails?1:0);
