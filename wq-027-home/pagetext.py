# Prints the visible text of an HTML file (scripts, styles and tags removed, whitespace collapsed), one block per line.
import sys, re, html
from html.parser import HTMLParser
BLOCK = {'p','li','h1','h2','h3','h4','dt','dd','tr','th','td','section','div','header','footer','nav','main','article','summary','figcaption','caption','title','option','label','button','span'}
class P(HTMLParser):
    def __init__(s): super().__init__(); s.out=['']; s.skip=0
    def handle_starttag(s,t,a):
        if t in ('script','style','noscript_skip'): s.skip+=1
        if t in BLOCK: s.out.append('')
    def handle_endtag(s,t):
        if t in ('script','style'): s.skip-=1
        if t in BLOCK: s.out.append('')
    def handle_data(s,d):
        if not s.skip: s.out[-1]+=d
p=P(); p.feed(open(sys.argv[1]).read())
for b in p.out:
    b=re.sub(r'\s+',' ',html.unescape(b)).strip()
    if b: print(b)
