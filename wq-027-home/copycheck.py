import sys, re, subprocess, html
from html.parser import HTMLParser
repo = sys.argv[1]
BLOCK = {'p','li','h1','h2','h3','h4','dt','dd','a','span','label','strong','b','button','title'}
class P(HTMLParser):
    def __init__(s): super().__init__(); s.stack=[]; s.blocks=[]; s.skip=0
    def handle_starttag(s,t,a):
        if t in ('script','style'): s.skip+=1
        if t in ('p','li','h1','h2','h3','h4','dt','dd'): s.stack.append([t,''])
    def handle_endtag(s,t):
        if t in ('script','style'): s.skip-=1
        if t in ('p','li','h1','h2','h3','h4','dt','dd') and s.stack:
            tag,txt=s.stack.pop(); txt=re.sub(r'\s+',' ',txt).strip()
            if txt: s.blocks.append((tag,txt))
            if s.stack: s.stack[-1][1]+=' '+txt+' '
    def handle_data(s,d):
        if s.skip: return
        if s.stack: s.stack[-1][1]+=d
def blocks(src):
    p=P(); p.feed(src); return p.blocks
def norm(t): return re.sub(r'\s+',' ',html.unescape(t)).replace('’',"'").strip()
old=''
for f in ['index.html','about/index.html','findings/index.html','planner/index.html','simulator/index.html','roadmap/index.html','idea/index.html','contact/index.html']:
    try: src=subprocess.run(['git','-C',repo,'show','origin/main:'+f],capture_output=True,text=True,check=True).stdout
    except Exception: continue
    old+=' || '.join(norm(t) for _,t in blocks(src))+' || '
    old+=norm(re.sub(r'<[^>]+>',' ',src))+' || '
oldn=re.sub(r'\s+',' ',old)
new=open(repo+'/index.html').read()
bad=0
for tag,t in blocks(new):
    t=norm(t)
    # leaf check: a nested li inside ol etc: test innermost sentences
    if t in oldn: continue
    # try per-sentence
    sents=[x for x in re.split(r'(?<=[.!?])\s+',t) if x]
    miss=[x for x in sents if x not in oldn]
    if miss:
        bad+=1; print(f'NEW <{tag}>: '+' | '.join(miss))
print('blocks with new text:',bad)
