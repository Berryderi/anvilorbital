// WQ-027 PR 3: move every tool page onto the remake stylesheets. Only the head links, the header/nav,
// the footer wrapper, the page wrapper class, two inline <style> blocks and two class names change.
// Body text is untouched (checked separately by extracting text before and after).
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const PAGES = {
  'simulator/index.html': 'simulator', 'planner/index.html': 'planner', 'findings/index.html': 'findings',
  'about/index.html': 'about', 'privacy/index.html': 'privacy', '404.html': '404',
  'idea/index.html': 'redirect', 'roadmap/index.html': 'redirect', 'contact/index.html': 'redirect',
};
const CURRENT = { simulator: 'simulator', planner: 'planner', findings: 'findings', about: 'about' };
const HEAD = `<meta name="color-scheme" content="dark">
<link rel="preload" href="/assets/vendor/fonts/archivo/archivo-latin-wdth-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/base.css">
<link rel="stylesheet" href="/assets/page.css">
<link rel="stylesheet" href="/assets/tools.css">`;
const BRAND = '<a class="nav-brand" href="/" aria-label="Anvil Orbital, home"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 7h20c0 3.2-3.4 4.8-7 5v2.2l3.5 3.8H5.5L9 14.2V12C5.4 11.8 2 10.2 2 7z"/></svg><span>Anvil Orbital</span></a>';
const nav = cur => {
  const li = (id, label) => `<li><a href="/#${id}"${cur === id ? ' aria-current="page"' : ''}>${label}</a></li>`;
  return `<a class="skip" href="#main">Skip to content</a>
  <header class="nav">
  ${BRAND}
  <nav aria-label="Chapters"><ul class="nav-links">${li('simulator', 'Simulator')}${li('planner', 'Planner')}${li('findings', 'Findings')}${li('about', 'About')}</ul></nav>
  </header>`;
};

let failed = false;
const must = (s, re, what, file) => { if (!re.test(s)) { console.log(`MISSING ${what} in ${file}`); failed = true; } return s.replace(re, '__X__'); };
for (const [rel, kind] of Object.entries(PAGES)) {
  const file = path.join(root, rel);
  let s = fs.readFileSync(file, 'utf8');
  const cur = CURRENT[kind] || null;
  // 1. Head: Google Fonts and the old stylesheets out, the remake stylesheets in.
  s = s.replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>\n/, '');
  if (/fonts\.googleapis|fonts\.gstatic/.test(s)) { console.log('Google Fonts still in ' + rel); failed = true; }
  s = s.replace(/<link rel="stylesheet" href="(\.\.|)\/assets\/site\.css">\n/, '');
  const navRe = /<link rel="stylesheet" href="(\.\.|)\/assets\/nav\.css">/;
  if (!navRe.test(s)) { console.log('no nav.css link in ' + rel); failed = true; }
  s = s.replace(navRe, HEAD);
  // 2. Inline style blocks (planner, simulator) move to tools.css.
  s = s.replace(/<style>[\s\S]*?<\/style>\n/, m => (kind === 'planner' || kind === 'simulator') ? '' : m);
  // 3. Page wrapper class.
  const before = s;
  s = s.replace('<div class="page">', `<div class="page tool tool-${kind}">`);
  if (s === before) { console.log('no .page in ' + rel); failed = true; }
  // 4. Skip link + old header become the remake nav.
  const headRe = /<a class="skip" href="#main">Skip to content<\/a>\n\s*<header class="site-head">[\s\S]*?<\/header>/;
  if (!headRe.test(s)) { console.log('no site-head in ' + rel); failed = true; }
  s = s.replace(headRe, nav(cur));
  // 5. Footer: same text, remake wrapper.
  const footRe = /<footer class="site-foot"><span>([\s\S]*?)<\/span><span>([\s\S]*?)<\/span><\/footer>/;
  if (!footRe.test(s)) { console.log('no site-foot in ' + rel); failed = true; }
  s = s.replace(footRe, '<footer class="foot"><p>$1</p><p>$2</p></footer>');
  // 6. Two old class names that map onto remake components.
  if (kind === 'about') s = s.replace('<a class="button" href=', '<a class="btn btn-primary" href=');
  if (kind === 'simulator') s = s.replace('<span class="tag">Simulation.', '<span class="tag tag-caution">Simulation.');
  // The planner chart's line was the old cyan accent; the remake keeps the accent for actions only.
  if (kind === 'planner') s = s.replace(/stroke="var\(--accent\)"/g, 'stroke="var(--orbit-high)"');
  fs.writeFileSync(file, s);
  console.log('ok ' + rel);
}
process.exit(failed ? 1 : 0);
