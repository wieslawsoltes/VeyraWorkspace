"""Acceptance checks against the actual HTTP-served app. No storage/provider stubs.
Run: python -m pip install playwright; python -m playwright install chromium
     npm start   # another terminal
     python tests/browser_smoke.py
A browser policy blocking navigation/media is a failure, not a passed test.
"""
import asyncio,json,os,shutil
from pathlib import Path
from playwright.async_api import async_playwright

async def wait_until(page, expression, timeout=30000):
 """Poll through the automation protocol without injecting an eval-based poller.

 The server's production CSP remains enabled, including its unsafe-eval ban.
 Predicate errors fail immediately; a pending evaluate is bounded by the deadline.
 """
 loop=asyncio.get_running_loop()
 deadline=loop.time()+timeout/1000
 while True:
  remaining=deadline-loop.time()
  if remaining<=0:
   raise TimeoutError(f'Predicate did not become true within {timeout} ms: {expression}')
  if await asyncio.wait_for(page.evaluate(expression),timeout=remaining):
   return
  await asyncio.sleep(min(0.1,max(0,deadline-loop.time())))

async def main():
 base=os.environ.get('VEYRA_TEST_URL','http://localhost:4173')
 output=Path(__file__).parent/'output';output.mkdir(exist_ok=True)
 report={'url':base,'checks':[],'errors':[]}
 async with async_playwright() as p:
  binary=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium')
  browser=await p.chromium.launch(**({'executable_path':binary} if binary else {}),headless=True,args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required']+(['--no-sandbox'] if hasattr(os,'geteuid') and os.geteuid()==0 else []))
  context=await browser.new_context(viewport={'width':1440,'height':1000})
  page=await context.new_page();page.on('pageerror',lambda e:report['errors'].append(str(e)))
  try:
   await page.goto(base,wait_until='networkidle',timeout=10000);await page.locator('#composer-input').wait_for()
   report['checks'].append('Browser bootstrap and native IndexedDB seed')
   await page.screenshot(path=str(output/'desktop.png'))
   message='Acceptance: saved through real IndexedDB <img src=x onerror="window.__xss=1">'
   await page.locator('#composer-input').fill(message);await page.locator('#composer-input').press('Enter')
   await wait_until(page,'document.querySelector("#message-feed").textContent.includes("Acceptance: saved")')
   assert await page.evaluate('window.__xss||0')==0
   await page.reload(wait_until='networkidle');await wait_until(page,'document.querySelector("#message-feed")?.textContent.includes("Acceptance: saved")')
   report['checks'].append('Native persistence across reload and HTML injection escaping')
   await page.locator('.tabs [data-action=tab][data-value=notes]').click();await page.locator('#notes-editor').fill('Saved through native IndexedDB')
   await wait_until(page,'!window.veyraDiagnostics.docDirty&&window.veyraDiagnostics.docVersion>=2',timeout=6000)
   report['checks'].append('Revisioned shared-editor persistence')
   await page.locator('.tabs [data-action=tab][data-value=board]').click();await page.wait_for_timeout(1000)
   report['renderer']=await page.evaluate('window.veyraDiagnostics.renderer')
   await page.screenshot(path=str(output/'whiteboard.png'))
   assert await page.locator('#board-stage canvas').count()==1
   report['checks'].append('Whiteboard initializes an available graphics backend')
   peer=await context.new_page();await peer.goto(base,wait_until='networkidle')
   # Exercise the real CallEngine and real LocalProvider signaling, without any UI test hooks in production.
   script="""async()=>{const{LocalProvider}=await import('./core/storage.js');const{CallEngine}=await import('./core/calls.js');window.__testProvider=await new LocalProvider().init();window.__testCall=new CallEngine(window.__testProvider);await window.__testCall.join('product-design',{audio:true,video:true});}"""
   await page.evaluate(script);await peer.evaluate(script)
   for target in [page,peer]:
    await wait_until(target,'window.__testCall.peers.size===1&&[...window.__testCall.peers.values()].every(p=>p.pc.connectionState==="connected")',timeout=25000)
    await wait_until(target,'window.__testCall.local.getTracks().length>=1')
   report['checks'].append('Real RTCPeerConnection handshake with browser-generated synthetic media')
   await asyncio.sleep(2)
   for target in [page,peer]:
    received=await target.evaluate("""async()=>{let total=0;for(const p of window.__testCall.peers.values()){for(const r of(await p.pc.getStats()).values())if(r.type==='inbound-rtp')total+=r.bytesReceived||0;}return total;}""")
    assert received>0
   for target in [page,peer]:
    await target.evaluate('window.__testCall.leave()')
   report['checks'].append('Actual WebRTC inbound RTP bytes in both directions')
   await page.set_viewport_size({'width':390,'height':844});await page.locator('#rail [data-action=nav][data-value=chat]').click()
   assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   await page.screenshot(path=str(output/'mobile.png'));report['checks'].append('Responsive mobile width')
   report['passed']=not report['errors']
  except Exception as e:
   report['passed']=False;report['failure']=str(e)
  finally:
   await context.close();await browser.close();(output/'browser-results.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
 return report['passed']
if __name__=='__main__':raise SystemExit(0 if asyncio.run(main()) else 1)
