import sys, re, os
root = sys.argv[1]
src = open(os.path.join(root, 'index.html')).read()
ids = lambda s: set(re.findall(r'\bid="([^"]+)"', s))
home_ids = ids(src)
bad = 0; n = 0
for href in sorted(set(re.findall(r'href="([^"]+)"', src))):
    if href.startswith('http'): continue
    n += 1
    path, _, frag = href.partition('#')
    if path == '':
        ok = frag in home_ids; where = 'home'
    else:
        f = os.path.join(root, path.lstrip('/'), 'index.html') if path.endswith('/') else os.path.join(root, path.lstrip('/'))
        ok = os.path.isfile(f); where = f
        if ok and frag and path != '/planner/':
            ok = frag in ids(open(f).read())
    print(('OK  ' if ok else 'BAD ') + href)
    bad += not ok
# old redirect targets
for old in ['idea', 'roadmap', 'contact']:
    t = re.search(r'url=([^"]+)"', open(os.path.join(root, old, 'index.html')).read()).group(1)
    path, _, frag = t.partition('#')
    target = os.path.normpath(os.path.join(root, old, path, 'index.html'))
    ok = frag in ids(open(target).read())
    print(('OK  ' if ok else 'BAD ') + f'/{old}/ -> {t}')
    bad += not ok
print(f'{n} internal links, {bad} bad')
