// Text-over-scene contrast probe (WQ-035). No dependencies: Node 22+ and Google Chrome.
// Usage: node tools/contrast-probe.mjs <site root> [--width 1280] [--frames 4] [--reduced] [--shots <dir>]
// --reduced emulates prefers-reduced-motion: reduce, where the scene and step 04 rest in their still frames.
// Opens /simulator/ in headless Chrome (SwiftShader WebGL), and on each step 01-05 finds every visible text run whose
// box overlaps the 3D canvas. For each of several frames it hides all text, captures the viewport, and reads the pixels
// under each run: those pixels are the run's real background (card fill composited over whatever the scene drew).
// Prints one JSON line per run with the lowest WCAG contrast seen against its colour, then a summary per token.
// A text pixel's colour is the token the run uses (--ink, --ink-2, --ink-3), read from the page.
import http from 'node:http';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const root = path.resolve(args[0] || '.');
const opt = name => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : null; };
const width = Number(opt('--width') || 1280), height = 900;
const FRAMES = Number(opt('--frames') || 4), FRAME_GAP_MS = 1500, STEP_SETTLE_MS = 2000;
const shots = opt('--shots'), reduced = args.includes('--reduced');
const CHROME = process.env.CHROME || 'google-chrome';
const DEBUG_PORT = 9800 + Math.floor(Math.random() * 150);
const TARGET = 4.5; // WCAG 2.2 AA, normal-size text
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Runs before any page script, so errors from the first line on are caught.
const HARNESS = `<script>window.__errs=[];addEventListener('error',e=>__errs.push('error: '+(e.message||'resource')),true);
addEventListener('unhandledrejection',e=>__errs.push('rejection: '+e.reason));
{const ce=console.error;console.error=(...a)=>{__errs.push('console.error: '+a.join(' '));ce(...a);};}</script>`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) throw new Error('outside root');
    let body = await readFile(file);
    if (p === '/simulator/index.html') body = body.toString().replace('<meta charset="utf-8">', '<meta charset="utf-8">' + HARNESS);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// Minimal PNG reader for Chrome's screenshots: 8-bit RGB or RGBA, not interlaced.
function readPng(buf) {
  let pos = 8, w = 0, h = 0, type = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), kind = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9]; if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG'); }
    if (kind === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0; if (!bpp) throw new Error('unsupported PNG colour type ' + type);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp] : 0, b = y ? out[row - stride + x] : 0, c = x >= bpp && y ? out[row - stride + x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      out[row + x] = (src[x] + pred) & 255;
    }
  }
  return { w, h, bpp, px: out };
}
const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

const profile = await mkdtemp(path.join(os.tmpdir(), 'cprobe-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars',
  '--no-first-run', '--user-data-dir=' + profile, `--remote-debugging-port=${DEBUG_PORT}`, `--window-size=${width},${height}`, 'about:blank'],
  { stdio: 'ignore' });
let ws, seq = 0, sid; const pending = new Map();
const send = (method, params = {}, sessionId) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params, sessionId })); return new Promise((ok, fail) => pending.set(id, { ok, fail })); };
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
}

// In the page: every visible text run over the canvas, with its colour, its token name and whether it sits on a card.
const COLLECT = `(() => {
  const cs = getComputedStyle(document.documentElement), tok = {};
  for (const n of ['--ink', '--ink-2', '--ink-3']) { const d = document.createElement('i'); d.style.color = cs.getPropertyValue(n); document.body.append(d); tok[getComputedStyle(d).color] = n; d.remove(); }
  const cv = document.getElementById('scene').getBoundingClientRect(), runs = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t; (t = walker.nextNode());) {
    const el = t.parentElement; if (!t.textContent.trim() || !el || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const s = getComputedStyle(el), svg = el instanceof SVGElement, col = svg ? s.fill : s.color;
    const rg = document.createRange(); rg.selectNodeContents(t);
    for (const r of rg.getClientRects()) {
      const x0 = Math.max(r.left, cv.left), y0 = Math.max(r.top, cv.top), x1 = Math.min(r.right, cv.right), y1 = Math.min(r.bottom, cv.bottom);
      if (x1 - x0 < 1 || y1 - y0 < 1 || y1 < 0 || y0 > innerHeight) continue;
      runs.push({ text: t.textContent.trim().slice(0, 40), where: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].join('.') : ''),
        token: tok[col] || col, color: col, card: !!el.closest('.card'), box: [Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(Math.min(y1, innerHeight))] });
    }
  }
  return runs;
})()`;
const HIDE = `(() => { const s = document.createElement('style'); s.id = 'cprobe-hide';
  s.textContent = '*{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important} svg text{fill:transparent!important}';
  document.head.append(s); return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); })()`;
const SHOW = `document.getElementById('cprobe-hide')?.remove()`;

const worst = new Map(); let failures = 0;
try {
  for (let i = 0; i < 50 && !ws; i++) {
    try { const v = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); ws = new WebSocket(v.webSocketDebuggerUrl); } catch { await sleep(200); }
  }
  if (!ws) throw new Error('Chrome did not start');
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  ws.onmessage = m => { const d = JSON.parse(m.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.fail(new Error(d.error.message)) : p.ok(d.result); } };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 }, sid);
  if (reduced) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sid);
  await send('Page.navigate', { url: `${base}/simulator/` }, sid);
  for (let i = 0; i < 100 && !(await evaluate("!!document.getElementById('legend-1') && /\\d/.test(document.getElementById('legend-1').textContent)").catch(() => false)); i++) await sleep(200);
  await sleep(1000);
  for (const n of [1, 2, 3, 4, 5]) {
    await evaluate(`document.querySelector('#rail [data-step="${n}"]').click()`);
    await sleep(STEP_SETTLE_MS);
    for (let f = 0; f < FRAMES; f++) {
      const runs = await evaluate(COLLECT);
      await evaluate(HIDE);
      const shot = Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, sid)).data, 'base64');
      await evaluate(SHOW);
      if (shots) { await mkdir(shots, { recursive: true }); await writeFile(path.join(shots, `bg-step${n}-f${f}-${width}.png`), shot); }
      const img = readPng(shot);
      for (const r of runs) {
        const [cr, cg, cb] = r.color.match(/\d+/g).map(Number), lt = lum(cr, cg, cb);
        let min = Infinity, at = null;
        for (let y = r.box[1]; y < Math.min(r.box[3], img.h); y++) for (let x = r.box[0]; x < Math.min(r.box[2], img.w); x++) {
          const i = (y * img.w + x) * img.bpp, c = ratio(lt, lum(img.px[i], img.px[i + 1], img.px[i + 2]));
          if (c < min) { min = c; at = [x, y, img.px[i], img.px[i + 1], img.px[i + 2]]; }
        }
        const key = `${n}|${r.where}|${r.text}`, prev = worst.get(key);
        if (!prev || min < prev.min) worst.set(key, { step: n, width, ...r, min: +min.toFixed(2), at, frame: f });
      }
      await sleep(FRAME_GAP_MS);
    }
  }
  for (const w of worst.values()) { if (w.min < TARGET) failures++; console.log(JSON.stringify(w)); }
  const byToken = {};
  for (const w of worst.values()) { const t = byToken[w.token] ??= { runs: 0, below: 0, lowest: Infinity }; t.runs++; if (w.min < TARGET) t.below++; t.lowest = Math.min(t.lowest, w.min); }
  const errs = await evaluate('__errs');
  console.log(JSON.stringify({ summary: true, width, reduced, frames: FRAMES, target: TARGET, byToken, runsBelowTarget: failures, errors: errs }));
} finally {
  ws?.close(); chrome.kill(); server.close();
  await sleep(300); await rm(profile, { recursive: true, force: true }).catch(() => {});
}
process.exit(failures ? 1 : 0);
