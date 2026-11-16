// Home text-over-scene contrast probe (WQ-037). No dependencies: Node 22+ and Google Chrome.
// Usage: node tools/home-contrast-probe.mjs <site root> [--width 1280] [--height 900] [--frames 2] [--reduced] [--shots <dir>]
// Built on tools/contrast-probe.mjs (WQ-035), for the home page: it scrolls through home half a screen at a time, and
// at each stop finds every visible text run, captures the viewport once with the text and once with the glyph fill
// hidden (color transparent; text-shadow is NOT removed, so a halo stays drawn as the background it is), and reads the
// pixels. Per run it keeps the worst stop and frame, and reports:
//   edgeMin  THE PASS METRIC. Glyph pixels are where the with-text shot is at least a quarter of the way from the
//            background toward the text colour. The sample is every glyph pixel plus a 1 px ring around it, read from
//            the fill-hidden shot after a 3x3 median (drops a lone star). edgeMin is the lowest contrast of the text
//            colour against that sample: the background right at the glyph edges.
//   min      lowest contrast over every pixel in the run's box (a single star anywhere in the box counts)
//   blurMin  lowest contrast over the box after a 5x5 median of the background's luminance
//   median   median contrast over the box after that filter, and under: the share of the box below 4.5:1
// A run fails when edgeMin is under 4.5. The nav is skipped: it sits on its own solid scrim, not over the scene.
import http from 'node:http';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const root = path.resolve(args[0] || '.');
const opt = name => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : null; };
const width = Number(opt('--width') || 1280), height = Number(opt('--height') || (width < 600 ? 844 : 900));
const FRAMES = Number(opt('--frames') || 2), FRAME_GAP_MS = 1200, STOP_SETTLE_MS = 2200;
const shots = opt('--shots'), reduced = args.includes('--reduced');
const CHROME = process.env.CHROME || 'google-chrome';
const DEBUG_PORT = 9650 + Math.floor(Math.random() * 140);
const TARGET = 4.5; // WCAG 2.2 AA, normal-size text
const BLUR = 2;     // 5x5 neighbourhood: its median drops a star of up to about 3x3 px but keeps the Earth and its halo
const HOOD = new Float32Array((2 * BLUR + 1) ** 2);
const EDGE = 1;     // the edge metric reads the glyph pixels and a ring this many px around them
const RUN_LIMIT_MS = Number(process.env.PROBE_LIMIT_MS || 280000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    if (p === '/index.html') body = body.toString().replace('<meta charset="utf-8">', '<meta charset="utf-8">' + HARNESS);
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
const LIN = Array.from({ length: 256 }, (_, c) => lin(c));
const ratio = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

const profile = await mkdtemp(path.join(os.tmpdir(), 'hprobe-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars',
  '--no-first-run', '--user-data-dir=' + profile, `--remote-debugging-port=${DEBUG_PORT}`, `--window-size=${width},${height}`, 'about:blank'],
  { stdio: 'ignore' });
// A hung Chrome must never hang the caller.
const die = code => { try { chrome.kill('SIGKILL'); } catch { /* already gone */ } process.exit(code); };
process.on('SIGTERM', () => die(124)); process.on('SIGINT', () => die(124));
setTimeout(() => { console.log(JSON.stringify({ summary: true, error: 'watchdog' })); die(124); }, RUN_LIMIT_MS).unref();
let ws, seq = 0, sid; const pending = new Map();
const send = (method, params = {}, sessionId) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params, sessionId })); return new Promise((ok, fail) => pending.set(id, { ok, fail })); };
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
}

// In the page: every visible text run in the viewport outside the nav, with its colour and token name.
const COLLECT = `(() => {
  const cs = getComputedStyle(document.documentElement), tok = {};
  for (const n of ['--ink', '--ink-2', '--ink-3', '--accent']) { const d = document.createElement('i'); d.style.color = cs.getPropertyValue(n); document.body.append(d); tok[getComputedStyle(d).color] = n; d.remove(); }
  const runs = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t; (t = walker.nextNode());) {
    const el = t.parentElement; if (!t.textContent.trim() || !el || el.closest('.nav, .skip, #pick') || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const s = getComputedStyle(el), col = el instanceof SVGElement ? s.fill : s.color;
    if (!/^rgb\\(/.test(col)) continue;   // text on a filled button carries its own background
    if (el.closest('.btn-primary')) continue;
    const rg = document.createRange(); rg.selectNodeContents(t);
    for (const r of rg.getClientRects()) {
      const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(innerWidth, r.right), y1 = Math.min(innerHeight, r.bottom);
      if (x1 - x0 < 1 || y1 - y0 < 1) continue;
      runs.push({ text: t.textContent.trim().slice(0, 48), where: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].join('.') : ''),
        chapter: el.closest('section')?.id || null, token: tok[col] || col, color: col, box: [Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1)] });
    }
  }
  return runs;
})()`;
// Hides the glyph fill only. A text-shadow stays drawn: it is the background the glyph edges are seen against.
const HIDE = `(() => { const s = document.createElement('style'); s.id = 'hprobe-hide';
  s.textContent = '*{color:transparent!important;-webkit-text-fill-color:transparent!important;caret-color:transparent!important} svg text{fill:transparent!important}';
  document.head.append(s); return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); })()`;
const SHOW = `document.getElementById('hprobe-hide')?.remove()`;

const worst = new Map(); let failures = 0, errs = [];
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
  await send('Page.navigate', { url: `${base}/` }, sid);
  for (let i = 0; i < 100 && !(await evaluate("document.documentElement.classList.contains('has-scene')").catch(() => false)); i++) await sleep(200);
  const hasScene = await evaluate("document.documentElement.classList.contains('has-scene')");
  await sleep(3000);   // textures and the first camera pose
  const H = await evaluate('document.documentElement.scrollHeight');
  const stops = []; for (let y = 0; y < H - height / 2; y += Math.round(height / 2)) stops.push(y);
  for (const y of stops) {
    await evaluate(`scrollTo({ top: ${y}, behavior: 'instant' })`);
    await sleep(STOP_SETTLE_MS);
    for (let f = 0; f < FRAMES; f++) {
      const sy = await evaluate('Math.round(scrollY)');
      const runs = await evaluate(COLLECT);
      const withText = Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, sid)).data, 'base64');
      await evaluate(HIDE);
      const shot = Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, sid)).data, 'base64');
      await evaluate(SHOW);
      if (shots) { await mkdir(shots, { recursive: true }); await writeFile(path.join(shots, `bg-${width}x${height}${reduced ? '-reduced' : ''}-y${sy}-f${f}.png`), shot); }
      const lumOf = png => { const im = readPng(png), out = new Float32Array(im.w * im.h);
        for (let i = 0; i < out.length; i++) { const p = i * im.bpp; out[i] = 0.2126 * LIN[im.px[p]] + 0.7152 * LIN[im.px[p + 1]] + 0.0722 * LIN[im.px[p + 2]]; }
        return { im, out }; };
      const { im: img, out: L } = lumOf(shot), { out: LA } = lumOf(withText);
      for (const r of runs) {
        const [cr, cg, cb] = r.color.match(/\d+/g).map(Number), lt = 0.2126 * LIN[cr] + 0.7152 * LIN[cg] + 0.0722 * LIN[cb];
        // Edge metric: glyph pixels are where the shot with text is at least a quarter of the way from the background
        // toward the text colour. The sample is every glyph pixel plus a 1 px ring around it, read from the shot with
        // the glyph fill hidden (so a text-shadow halo, if any, is the background), after a 3x3 median for lone stars.
        const [bx0, by0, bx1, by1] = [Math.max(0, r.box[0] - 1), Math.max(0, r.box[1] - 1), Math.min(img.w, r.box[2] + 1), Math.min(img.h, r.box[3] + 1)];
        const glyph = new Uint8Array((bx1 - bx0) * (by1 - by0)); let glyphN = 0;
        for (let yy = by0; yy < by1; yy++) for (let x = bx0; x < bx1; x++) {
          const i = yy * img.w + x; if (LA[i] - L[i] >= 0.25 * (lt - L[i]) && LA[i] - L[i] > 0.005) { glyph[(yy - by0) * (bx1 - bx0) + x - bx0] = 1; glyphN++; }
        }
        let edgeMin = Infinity, edgeN = 0;
        for (let yy = by0; yy < by1; yy++) for (let x = bx0; x < bx1; x++) {
          let near = false;
          for (let dy = -EDGE; dy <= EDGE && !near; dy++) for (let dx = -EDGE; dx <= EDGE; dx++) {
            const X = x + dx - bx0, Y = yy + dy - by0; if (X >= 0 && Y >= 0 && X < bx1 - bx0 && Y < by1 - by0 && glyph[Y * (bx1 - bx0) + X]) { near = true; break; }
          }
          if (!near) continue;
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = yy + dy; if (X >= 0 && Y >= 0 && X < img.w && Y < img.h) HOOD[n++] = L[Y * img.w + X]; }
          const c = ratio(lt, HOOD.subarray(0, n).sort()[n >> 1]); edgeN++; if (c < edgeMin) edgeMin = c;
        }
        let min = Infinity, at = null; const blurred = [];
        for (let yy = r.box[1]; yy < Math.min(r.box[3], img.h); yy++) for (let x = r.box[0]; x < Math.min(r.box[2], img.w); x++) {
          const c = ratio(lt, L[yy * img.w + x]); if (c < min) { min = c; at = [x, yy]; }
          let n = 0;
          for (let dy = -BLUR; dy <= BLUR; dy++) for (let dx = -BLUR; dx <= BLUR; dx++) {
            const X = x + dx, Y = yy + dy; if (X < 0 || Y < 0 || X >= img.w || Y >= img.h) continue; HOOD[n++] = L[Y * img.w + X];
          }
          const hood = HOOD.subarray(0, n).sort();
          blurred.push(ratio(lt, hood[n >> 1]));
        }
        if (!blurred.length) continue;
        blurred.sort((a, b) => a - b);
        const row = { width, height, reduced, scrollY: sy, frame: f, ...r, edgeMin: edgeN ? +edgeMin.toFixed(2) : null, glyphPx: glyphN, edgePx: edgeN,
          min: +min.toFixed(2), at, blurMin: +blurred[0].toFixed(2),
          median: +blurred[blurred.length >> 1].toFixed(2), under: +(blurred.filter(v => v < TARGET).length / blurred.length).toFixed(2) };
        const key = `${r.where}|${r.text}`, prev = worst.get(key), score = x => x.edgeMin ?? Infinity;
        if (!prev || score(row) < score(prev)) worst.set(key, row);
      }
      if (f < FRAMES - 1) await sleep(FRAME_GAP_MS);
    }
  }
  errs = await evaluate('__errs');
  const list = [...worst.values()].sort((a, b) => (a.edgeMin ?? Infinity) - (b.edgeMin ?? Infinity));
  for (const w of list) { if ((w.edgeMin ?? Infinity) < TARGET) failures++; console.log(JSON.stringify(w)); }
  const byToken = {};
  for (const w of list) { const t = byToken[w.token] ??= { runs: 0, below: 0, lowestEdge: Infinity, lowestBlur: Infinity, lowestRaw: Infinity }; t.runs++; if ((w.edgeMin ?? Infinity) < TARGET) t.below++; t.lowestEdge = Math.min(t.lowestEdge, w.edgeMin ?? Infinity); t.lowestBlur = Math.min(t.lowestBlur, w.blurMin); t.lowestRaw = Math.min(t.lowestRaw, w.min); }
  console.log(JSON.stringify({ summary: true, width, height, reduced, frames: FRAMES, stops: stops.length, hasScene, target: TARGET, byToken, runsBelowTarget: failures, errors: errs }));
} finally {
  ws?.close(); chrome.kill(); server.close();
  await sleep(300); await rm(profile, { recursive: true, force: true }).catch(() => {});
}
process.exit(failures || errs.length ? 1 : 0);
