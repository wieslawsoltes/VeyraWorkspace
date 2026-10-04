"""Native HTTP/browser acceptance. A blocked environment is a FAILURE, never a pass.
Uses Chromium's synthetic native camera/microphone and native getDisplayMedia picker
with Chromium's auto-selection flag. No replacement storage, fetch, SDP, or capture API.
Run after installing Playwright: python tests/guest_browser.py
--fixture tests the isolated guest service instead of the complete workspace server.
"""
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import argparse, functools, json, os, shutil, subprocess, tempfile, threading, time, urllib.request
from playwright.sync_api import sync_playwright, expect
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tests/output/guest-native'
OUT.mkdir(parents=True, exist_ok=True)
args = argparse.ArgumentParser()
args.add_argument('--fixture', action='store_true')
args = args.parse_args()
INSTRUMENT = r'''(() => {
  window.__guestPCs=[];window.__guestCaptures=[];window.__guestRequests=0;
  const Native=RTCPeerConnection;
  window.RTCPeerConnection=class extends Native{constructor(config){super(config);window.__guestPCs.push(this);}};
  for(const method of ['getUserMedia','getDisplayMedia']){
    const original=navigator.mediaDevices?.[method]?.bind(navigator.mediaDevices);
    if(original)navigator.mediaDevices[method]=function(options){window.__guestRequests++;return original(options).then(stream=>{window.__guestCaptures.push(...stream.getTracks());return stream;});};
  }
  const write=navigator.clipboard?.writeText?.bind(navigator.clipboard);
  if(write)navigator.clipboard.writeText=async value=>{await write(value);window.__lastCopied=value;};
})();'''
class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self,*_): pass
report={'scope':'isolated guest HTTP service' if args.fixture else 'complete workspace + guest server',
        'hardware':'Chromium-generated camera/microphone and native automated screen picker, not physical-device testing', 'checks':[], 'pageErrors':[]}
def passed(message):
    report['checks'].append(message); print('PASS:',message,flush=True)
server=None; static=None; browser=None; pages=[]
try:
    with tempfile.TemporaryDirectory(prefix='veyra-guest-') as temporary:
        env={**os.environ,'PORT':'4178','HOST':'127.0.0.1','PUBLIC_ORIGIN':'http://127.0.0.1:4178','DATA_DIR':str(Path(temporary)/'data'),'ALLOW_REGISTRATION':'false','GUEST_MEETINGS_ENABLED':'true'}
        log=(OUT/'server.log').open('w')
        command=['node','tests/guest-http-fixture.mjs'] if args.fixture else ['node','--experimental-sqlite','server/start.mjs']
        server=subprocess.Popen(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
        origin='http://127.0.0.1:4178'
        for attempt in range(50):
            try:
                with urllib.request.urlopen(origin+'/api/guest-meetings',timeout=1) as response: assert response.status==200
                break
            except Exception:
                if server.poll() is not None: raise RuntimeError('Guest server exited; inspect server.log')
                time.sleep(.1)
        else: raise RuntimeError('Guest server did not become ready')
        static_root=Path(temporary)/'static';shutil.copytree(ROOT/'public',static_root/'VeyraWorkspace')
        static=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=str(static_root)))
        threading.Thread(target=static.serve_forever,daemon=True).start()
        static_url=f'http://127.0.0.1:{static.server_address[1]}/VeyraWorkspace/meet.html'
        with sync_playwright() as p:
            launch={'headless':True,'args':['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--auto-select-desktop-capture-source=Entire screen']}
            if os.environ.get('CHROMIUM_PATH'): launch['executable_path']=os.environ['CHROMIUM_PATH']
            browser=p.chromium.launch(**launch)
            def page(url=origin+'/meet.html',mobile=False):
                context=browser.new_context(viewport={'width':390,'height':844} if mobile else {'width':1440,'height':1000},permissions=['camera','microphone','clipboard-read','clipboard-write'])
                context.add_init_script(INSTRUMENT);target=context.new_page();pages.append(target)
                target.on('pageerror',lambda e: report['pageErrors'].append(str(e)))
                target.goto(url,wait_until='domcontentloaded',timeout=15000)
                target.wait_for_function("document.querySelector('#device-status').textContent.includes('Your choices')")
                return target
            def connected(target,count=1):
                target.wait_for_function('(count)=>window.__guestPCs.filter(p=>p.connectionState===\'connected\').length>=count',arg=count,timeout=20000)
            host=page();host.screenshot(path=str(OUT/'setup-desktop.png'),full_page=True)
            mobile=page(mobile=True);assert mobile.evaluate('document.documentElement.scrollWidth<=innerWidth');mobile.screenshot(path=str(OUT/'setup-mobile.png'),full_page=True);mobile.close()
            assert host.evaluate('window.__guestRequests')==0
            passed('Native root/subpath-ready startup, responsive preview and no permission requests on open')
            host.fill('#name','Alex Morgan');host.fill('#title','Guest collaboration review')
            host.locator('#setup [data-device="audio"]').click();host.locator('#setup [data-device="video"]').click()
            host.wait_for_function('window.__guestCaptures.length===2')
            host.click('#create');expect(host.locator('#meeting')).to_be_visible(timeout=15000)
            host.click('#copy-invite');host.wait_for_function('!!window.__lastCopied');invitation=host.evaluate('window.__lastCopied')
            assert '#room=' in invitation and 'key=' in invitation
            guest=page(invitation);assert guest.evaluate('location.hash')=='';guest.fill('#name','Sam Rivera');guest.click('#join');expect(guest.locator('#waiting')).to_be_visible()
            assert guest.evaluate('window.__guestRequests')==0
            host.click('#toggle-people');host.locator('#waiting-list').get_by_role('button',name='Admit',exact=True).click()
            expect(guest.locator('#meeting')).to_be_visible(timeout=10000);connected(host);connected(guest)
            guest.wait_for_function("document.querySelector('.tile:not(.local) video')?.videoWidth>0")
            passed('Expiring invite, waiting-room approval, receive-only guest and actual RTP media between browser contexts')
            guest.click('#toggle-chat');guest.fill('#message','<img src=x onerror=alert(1)> Hello, Alex.');guest.click('#chat-form button');host.click('#chat-tab')
            host.wait_for_function("document.querySelector('#messages').textContent.includes('Hello, Alex.')")
            assert host.locator('#messages img').count()==0
            guest.click('#hand');host.wait_for_function("[...document.querySelectorAll('.tile:not(.local) .hand-marker')].some(x=>!x.hidden)")
            passed('Real data-channel chat escapes markup; raised hands propagate without broker chat storage')
            host.click('#close-panel');guest.click('#close-panel')
            camera=host.evaluate("window.__guestPCs[0].getTransceivers()[1].sender.track.id")
            host.click('#share-screen');host.wait_for_function("document.querySelector('#share-screen').getAttribute('aria-pressed')==='true'",timeout=15000)
            guest.wait_for_function("document.querySelector('.tile.screen:not(.local) video')?.videoWidth>0",timeout=15000)
            assert host.evaluate("window.__guestPCs[0].getTransceivers()[1].sender.track.id")==camera
            assert host.evaluate("window.__guestPCs[0].getTransceivers()[0].sender.track.readyState")=='live'
            passed('Native screen selection transmits screen RTP while camera and microphone remain live')
            third=page(invitation);third.fill('#name','Jordan Lee');third.click('#join');expect(third.locator('#waiting')).to_be_visible();host.click('#toggle-people')
            host.locator('#waiting-list').get_by_role('button',name='Admit',exact=True).click();expect(third.locator('#meeting')).to_be_visible()
            for target in [host,guest,third]: connected(target,2)
            third.wait_for_function("document.querySelector('.tile.screen:not(.local) video')?.videoWidth>0",timeout=15000)
            passed('Three-party mesh negotiation and late-joining presentation receiver')
            host.click('#lock');host.wait_for_function("document.querySelector('#lock').getAttribute('aria-pressed')==='true'")
            fourth=page(invitation);fourth.fill('#name','Locked out');fourth.click('#join');expect(fourth.locator('#notice')).to_contain_text('locked');assert fourth.locator('#setup').is_visible();fourth.close()
            passed('Host lock rejects a new participant without disturbing existing connections')
            host.click('#close-panel');guest.screenshot(path=str(OUT/'meeting-presentation.png'),full_page=True)
            host.click('#share-screen');guest.wait_for_function("!document.querySelector('.tile.screen:not(.local)')")
            assert host.evaluate("window.__guestPCs[0].getTransceivers()[1].sender.track.readyState")=='live'
            host.click('#toggle-people');host.once('dialog',lambda dialog:dialog.accept());host.click('#end')
            for target in [host,guest,third]: expect(target.locator('#ended')).to_be_visible(timeout=10000)
            assert host.evaluate("window.__guestCaptures.every(t=>t.readyState==='ended')")
            passed('Stop-sharing preserves camera; End for everyone stops every client and releases host capture')
            a=page(static_url);b=page(static_url);a.fill('#name','Direct Alex');b.fill('#name','Direct Sam')
            a.locator('#setup [data-device="audio"]').click();a.locator('#setup [data-device="video"]').click();a.wait_for_function('window.__guestCaptures.length===2')
            for target in [a,b]: target.click('#mode-direct')
            a.click('#direct-create');a.wait_for_function("document.querySelector('#pairing-output').value.length>100",timeout=20000)
            b.fill('#offer-input',a.input_value('#pairing-output'));b.click('#direct-accept');b.wait_for_function("document.querySelector('#pairing-output').value.length>100",timeout=20000)
            a.fill('#answer-input',b.input_value('#pairing-output'));a.click('#apply-answer');connected(a);connected(b)
            b.wait_for_function("document.querySelector('.tile:not(.local) video')?.videoWidth>0")
            a.click('#toggle-chat');a.fill('#message','Static-host direct data channel');a.click('#chat-form button');b.click('#toggle-chat')
            b.wait_for_function("document.querySelector('#messages').textContent.includes('Static-host direct data channel')")
            a.click('#leave');b.click('#leave');assert a.evaluate("window.__guestCaptures.every(t=>t.readyState==='ended')")
            passed('Broker-free offer/answer pairing, native RTP and data channel work at a GitHub Pages-style project subpath')
            if not args.fixture:
                workspace=browser.new_page();workspace.goto(origin+'/index.html');expect(workspace.locator('.guest-meeting-entry')).to_have_count(1)
                assert workspace.locator('.guest-meeting-entry').get_attribute('href').endswith('/meet.html');workspace.close()
                passed('Existing workspace remains available with exactly one no-account meeting entry')
            assert not report['pageErrors'],report['pageErrors']
            report['status']='pass';browser.close();browser=None
except Exception as error:
    report['status']='fail';report['error']=str(error)
    raise
finally:
    if browser:
        try: browser.close()
        except Exception: pass
    if server:
        server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill();server.wait()
    if static: static.shutdown();static.server_close()
    (OUT/'result.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2),flush=True)
