// Serves the site plus a stand-in /assets/scene/scene.js (dev-1's API shape) and checks page.js's side of it.
import fs from 'node:fs';
let probe = fs.readFileSync(new URL('./home-probe.mjs', import.meta.url), 'utf8');
const STUB = `export async function createScene(canvas){await new Promise(r=>setTimeout(r,50));const h={};window.__scene={calls:[],emit:(e,d)=>(h[e]||[]).forEach(f=>f(d))};
return {setChapter:(id,p)=>__scene.calls.push(['ch',id,+p.toFixed(2)]),setPlannerPreset:n=>__scene.calls.push(['preset',n]),on:(e,f)=>{(h[e]=h[e]||[]).push(f)},pause(){},resume(){},info:{}};}`;
probe = probe.replace("let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);",
  "let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);\n  if (p === '/assets/scene/scene.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(" + JSON.stringify(STUB) + "); }");
// Replace the case loop with stub checks.
const start = probe.indexOf('const MARK_FOR'), end = probe.indexOf("const homeUrls");
probe = probe.slice(0, start) + `
await load(base + '/', { width: 1280 });
await sleep(400);
const st = await ev(\`({has:document.documentElement.classList.contains('has-scene'), shown:[...document.querySelectorAll('[data-scene-only]')].filter(e=>!e.hidden).length, total:document.querySelectorAll('[data-scene-only]').length, calls:__scene.calls.slice(0,3)})\`);
check(st.has && st.shown === st.total && st.total === 3, 'scene loaded: has-scene set, all scene-only notes shown ' + JSON.stringify(st));
check(st.calls.some(c => c[0] === 'preset') && st.calls.some(c => c[0] === 'ch' && c[1] === 'hero'), 'setPlannerPreset and setChapter(hero) called');
const scroll = await ev(\`(async()=>{document.getElementById('retire').scrollIntoView({behavior:'instant'});scrollBy(0,300);await new Promise(r=>setTimeout(r,200));return __scene.calls.filter(c=>c[0]==='ch'&&c[1]==='retire').slice(-1)[0]})()\`);
check(scroll && scroll[2] > 0 && scroll[2] < 1, 'setChapter(retire, progress) gets a progress between 0 and 1: ' + JSON.stringify(scroll));
const pk = await ev(\`(()=>{__scene.emit('pick',{name:'STARLINK-1007',norad:44713,operator:'SpaceX',color:'#fff',heightKm:null,x:300,y:200});const a=document.getElementById('pick').textContent;__scene.emit('pick',{name:'STARLINK-1007',norad:44713,operator:'SpaceX',color:'#fff',heightKm:546.4,x:300,y:200});const b=document.getElementById('pick').textContent;__scene.emit('pick',null);return {a,b,hiddenAfterNull:document.getElementById('pick').hidden}})()\`);
check(!/\\b0 km|NaN/.test(pk.a) && /546 km/.test(pk.b) && pk.hiddenAfterNull, 'pick label: no height while null, then 546 km, hidden on null ' + JSON.stringify(pk));
const pr = await ev(\`(()=>{const s=document.getElementById('mini-preset');s.value='Eutelsat OneWeb Gen 1';s.dispatchEvent(new Event('change'));return __scene.calls.filter(c=>c[0]==='preset').slice(-1)[0]})()\`);
check(pr && pr[1] === 'Eutelsat OneWeb Gen 1', 'mini planner change calls setPlannerPreset ' + JSON.stringify(pr));
const errs = await ev('window.__errs'); check(errs.length === 0, 'JS errors: ' + JSON.stringify(errs));
console.log(fails ? fails + ' FAIL' : 'ALL OK'); chrome.kill(); server.close(); process.exit(fails ? 1 : 0);
` ;
fs.writeFileSync(new URL('./stub-run.mjs', import.meta.url), probe);
