"""Render/component smoke test for restricted browsers. NOT a network/media/IndexedDB test.
Uses the production UI, domain model, LocalProvider, editors and Canvas fallback.
Only storage and same-tab bus infrastructure are in-memory test fixtures.
"""
import asyncio, base64, json, os, re, traceback
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]
OUTPUT=Path(os.environ.get('VEYRA_ARTIFACT_DIR','/mnt/data'))
cache={}
def module_url(path):
 path=path.resolve()
 if path in cache:return cache[path]
 code=path.read_text()
 if path.name=='storage.js':
  start=code.index('class Database ');end=code.index('export class LocalProvider',start)
  code=code[:start]+(ROOT/'tests/fixtures/memory-database.js').read_text()+'\n'+code[end:]
 # A controlled application base URL, not a change to the browser's origin or policy.
 code=code.replace('location.href',json.dumps('http://localhost:4173/'))
 code=code.replace('import.meta.url',json.dumps('http://localhost:4173/'+str(path.relative_to(ROOT/'public'))))
 pattern=re.compile(r'''((?:from\s*|import\s*\()\s*['"])(\.[^'"]+)(['"])''')
 def replace(m):
  target=(path.parent/m[2]).resolve()
  if not target.is_file():return m[0] # Optional vendored SDKs are intentionally absent.
  return m[1]+module_url(target)+m[3]
 code=pattern.sub(replace,code)
 url='data:text/javascript;base64,'+base64.b64encode(code.encode()).decode()
 cache[path]=url
 return url
SHIM=r'''(()=>{
 const map=new Map();Object.defineProperty(window,'localStorage',{value:{getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k),clear:()=>map.clear()}});
 if(!crypto.randomUUID)crypto.randomUUID=()=>{const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');return`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`};
 class FixtureChannel extends EventTarget{postMessage(){}close(){}}Object.defineProperty(window,'BroadcastChannel',{value:FixtureChannel});
})()'''
async def run():
 OUTPUT.mkdir(parents=True,exist_ok=True)
 report={'mode':'component rendering with in-memory storage fixture','not_tested':['native IndexedDB persistence','browser network navigation','camera/microphone/screen capture','WebRTC media transport','WebGPU device execution','Microsoft live services'],'checks':[],'errors':[]}
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
  page=await browser.new_page(viewport={'width':1440,'height':1000},device_scale_factor=1)
  page.set_default_timeout(5000)
  page.on('pageerror',lambda e:report['errors'].append(str(e)))
  html=(ROOT/'public/index.html').read_text()
  html=re.sub(r'<link[^>]+>', '',html)
  html=re.sub(r'<script[^>]+src=[^>]+></script>','',html)
  html=html.replace('</head>','<style>'+(ROOT/'public/styles.css').read_text()+'</style></head>')
  await page.set_content(html);await page.evaluate(SHIM)
  await page.add_script_tag(type='module',content='import '+json.dumps(module_url(ROOT/'public/app.js'))+';')
  async def check(name,fn):
   try:
    await fn();report['checks'].append({'name':name,'passed':True});print('PASS',name,flush=True);(OUTPUT/'veyra-render-results.json').write_text(json.dumps(report,indent=2))
   except Exception as e:
    report['checks'].append({'name':name,'passed':False,'error':str(e)});print('FAIL',name,str(e)[:250],flush=True);(OUTPUT/'veyra-render-results.json').write_text(json.dumps(report,indent=2));raise
  async def boot():
   await page.locator('#composer-input').wait_for(timeout=20000)
   await page.wait_for_function('window.veyraDiagnostics?.messages>=7')
   assert await page.locator('h1').filter(has_text='Product & Design').count()
  async def send():
   await page.locator('#composer-input').fill('A real component test message <img src=x onerror="window.__xss=1">')
   await page.locator('#composer-input').press('Enter')
   await page.wait_for_function('document.querySelector("#message-feed").textContent.includes("A real component test message")')
   assert await page.evaluate('window.__xss||0')==0
  async def reaction():
   m=page.locator('[data-message-id]').filter(has_text='A real component test message').last
   await m.hover();await m.locator('[data-action=react]').click();await page.locator('#popover [data-action=reaction][data-value="👍"]').click()
   await page.wait_for_function('document.querySelector("#message-feed").textContent.includes("👍")')
  async def notes():
   await page.locator('.tabs [data-action=tab][data-value=notes]').click()
   await page.locator('#notes-editor').fill('Editable notes: tested through the production document session.')
   await page.wait_for_function('window.veyraDiagnostics.docVersion>=2&&!window.veyraDiagnostics.docDirty',timeout=6000)
  async def board():
   await page.locator('.tabs [data-action=tab][data-value=board]').click()
   await page.wait_for_function('!!window.veyraDiagnostics.renderer&&window.veyraDiagnostics.renderedFrames>0')
   before=(await page.evaluate('window.veyraDiagnostics'))['shapes']
   await page.locator('[data-action=board-tool][data-value=rect]').click()
   box=await page.locator('#board-stage').bounding_box()
   await page.mouse.move(box['x']+box['width']*.72,box['y']+box['height']*.7);await page.mouse.down();await page.mouse.move(box['x']+box['width']*.72+70,box['y']+box['height']*.7+50,steps=8);await page.mouse.up()
   assert (await page.evaluate('window.veyraDiagnostics'))['shapes']==before+1
   await page.locator('[data-action=board-undo]').click();assert(await page.evaluate('window.veyraDiagnostics'))['shapes']==before
   await page.locator('[data-action=board-redo]').click();assert(await page.evaluate('window.veyraDiagnostics'))['shapes']==before+1
   await page.wait_for_function('!window.veyraDiagnostics.docDirty',timeout=6000)
   await page.screenshot(path=str(OUTPUT/'veyra-whiteboard.png'))
  async def calendar():
   await page.locator('#rail [data-action=nav][data-value=calendar]').click()
   await page.locator('#main [data-action=new-event]').first.click()
   await page.locator('#event-form [name=title]').fill('Component test meeting')
   await page.locator('#event-form button[type=submit]').click()
   await page.wait_for_function('!document.querySelector("#modal").open')
   await page.locator('[data-action=calendar-view]').click()
   assert await page.get_by_text('Component test meeting',exact=True).count()
  async def mobile():
   await page.set_viewport_size({'width':390,'height':844})
   await page.locator('#rail [data-action=nav][data-value=chat]').click()
   assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   await page.screenshot(path=str(OUTPUT/'veyra-mobile.png'))
   await page.locator('[data-action=toggle-sidebar]').click()
   assert await page.locator('#sidebar').is_visible()
  try:
   await check('production UI boots with fixture storage',boot)
   await page.screenshot(path=str(OUTPUT/'veyra-desktop.png'))
   await check('composer sends and escapes HTML',send)
   # Subsequent selectors are deliberately asserted against the real app, not a mock DOM.
   await check('shared notes autosave',notes)
   await check('Canvas whiteboard drawing and undo/redo',board)
   await check('calendar creates and displays events',calendar)
   await check('mobile layout and navigation',mobile)
  except Exception:
   await page.screenshot(path=str(OUTPUT/'veyra-render-failure.png'))
   print('BODY',(await page.locator('body').inner_text())[:2000]);print('ERRORS',report['errors']);traceback.print_exc()
  finally:
   report['diagnostics']=await page.evaluate('window.veyraDiagnostics||null')
   (OUTPUT/'veyra-render-results.json').write_text(json.dumps(report,indent=2))
   await browser.close()
  print(json.dumps(report,indent=2))
  return all(c['passed'] for c in report['checks']) and not report['errors']
if __name__=='__main__':raise SystemExit(0 if asyncio.run(run()) else 1)
