// WQ-029: give the tool pages home's motion and structure without touching their words.
// Adds: the head class script home uses, page.js, a page-hero class on each page's opening block,
// data-reveal on headings and blocks. No text node is added, removed or changed.
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
const PAGES = ['planner/index.html', 'findings/index.html', 'about/index.html', 'privacy/index.html', '404.html', 'idea/index.html', 'roadmap/index.html', 'contact/index.html'];
const HEADJS = '<script>{const h=document.documentElement;h.classList.add("js");if(!matchMedia("(prefers-reduced-motion: reduce)").matches)h.classList.add("reveal-ready");}</script>';
let failed = false;
for (const rel of PAGES) {
  const f = path.join(root, rel);
  let s = fs.readFileSync(f, 'utf8');
  if (s.includes('/assets/page.js')) { console.log('already done ' + rel); continue; }
  s = s.replace('<link rel="stylesheet" href="/assets/tools.css">', '<link rel="stylesheet" href="/assets/tools.css">\n' + HEADJS);
  // Split main from the rest so only main's blocks get block reveals.
  const m0 = s.indexOf('<main'), m1 = s.indexOf('</main>');
  const isPlanner = rel.startsWith('planner');
  let head = s.slice(0, m0), main = m0 >= 0 ? s.slice(m0, m1) : '', tail = m0 >= 0 ? s.slice(m1) : s.slice(0);
  if (isPlanner) { head = s; main = ''; tail = ''; }
  const tag = (str, re, attr) => str.replace(re, (m, a) => m.includes('data-reveal') ? m : m.replace(/^<(\w+)/, `<$1 ${attr}`));
  const doc = isPlanner ? head : main;
  let d = doc;
  d = tag(d, /<h1\b[^>]*>/g, 'data-reveal="lines"');
  d = tag(d, /<h2\b[^>]*>/g, 'data-reveal="lines"');
  d = tag(d, /<p class="lede"[^>]*>/g, 'data-reveal="lines"');
  if (!isPlanner) {
    d = tag(d, /<h3\b[^>]*>/g, 'data-reveal');
    d = tag(d, /<p>/g, 'data-reveal');
    d = tag(d, /<p class="(source|note-p)"[^>]*>/g, 'data-reveal');
    d = tag(d, /<ul class="plain"[^>]*>/g, 'data-reveal');
    d = tag(d, /<div class="(table-wrap[^"]*|actions)"[^>]*>/g, 'data-reveal');
    d = tag(d, /<section class="note"[^>]*>/g, 'data-reveal');
    d = tag(d, /<li><span class="num">/g, 'data-reveal');
    d = tag(d, /<span class="label">/g, 'data-reveal');
  }
  // The opening block of each page is its hero.
  if (isPlanner) {
    if (!d.includes('<header id="main">')) { console.log('no planner header ' + rel); failed = true; }
    d = d.replace('<header id="main">', '<header id="main" class="page-hero">');
  } else {
    const before = d;
    d = d.replace(/<main id="main">(\s*)<section>/, '<main id="main">$1<section class="page-hero">');
    if (d === before) { console.log('no opening section ' + rel); failed = true; }
  }
  s = isPlanner ? d : head + d + tail;
  s = s.replace(/\s*$/, '\n<script src="/assets/page.js" defer></script>\n');
  fs.writeFileSync(f, s);
  console.log('ok ' + rel);
}
process.exit(failed ? 1 : 0);
