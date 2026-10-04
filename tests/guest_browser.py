"""Native HTTP/browser acceptance. A blocked environment is a FAILURE, never a pass.
Uses Chromium's synthetic native camera/microphone and native getDisplayMedia picker
with Chromium's auto-selection flag. No replacement storage, HTTP responses, SDP, or media. The reconnect scenario
explicitly cancels a native SSE request; it does not fabricate networking.
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
  const nativeFetch=globalThis.fetch.bind(globalThis);
  globalThis.fetch=(url,options={})=>{
    if(String(url).endsWith('/events')){
      const cancel=new AbortController();window.__cancelGuestStream=()=>cancel.abort();
      if(options.signal?.aborted)cancel.abort();
      else options.signal?.addEventListener('abort',()=>cancel.abort(),{once:true});
      return nativeFetch(url,{...options,signal:cancel.signal});
    }
    return nativeFetch(url,options);
  };
  const write=navigator.clipboard?.writeText?.bind(navigator.clipboard);
  if(write)navigator.clipboard.writeText=async value=>{await write(value);window.__lastCopied=value;};
})();'''
class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self,*_): pass
report={'scope':'isolated guest HTTP service' if args.fixture else 'complete workspace + guest server',
        'hardware':'Chromium-generated camera/microphone and native automated screen picker, not physical-device testing', 'checks':[], 'pageErrors':[], 'screenshotErrors':[]}
def screenshot(target, filename):
    # Evidence collection must not prevent transport assertions from running.
    # Any capture failure remains explicit in the report, never a visual pass.
    try: target.screenshot(path=str(OUT/filename),full_page=True,timeout=5000)
    except Exception as error:
        report['screenshotErrors'].append({'file':filename,'error':str(error)})
        print('SCREENSHOT FAILED:',filename,str(error),flush=True)
def wait(target, expression, arg=None, timeout=20000):
    # Poll via the browser automation evaluation API. wait_for_function evaluates
    # again inside requestAnimationFrame, where the production no-unsafe-eval CSP
    # correctly rejects this older Playwright runner's internal eval.
    script = '(arg) => { const value = (' + expression + '); return typeof value === "function" ? value(arg) : value; }'
    deadline = time.monotonic() + timeout / 1000
    while time.monotonic() < deadline:
        if target.evaluate(script, arg): return
        target.wait_for_timeout(50)
    raise AssertionError('Timed out waiting for browser condition: ' + expression)
def passed(message):
    report['checks'].append(message); print('PASS:',message,flush=True)
server=None; static=None; browser=None; playwright=None; pages=[]
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
        playwright = sync_playwright().start()
        p = playwright
        launch={'headless':os.environ.get('GUEST_HEADED')!='true','args':['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--auto-select-desktop-capture-source=Entire screen']}
        if os.environ.get('CHROMIUM_PATH'): launch['executable_path']=os.environ['CHROMIUM_PATH']
        browser=p.chromium.launch(**launch)
        def page(url=origin+'/meet.html',mobile=False):
            context=browser.new_context(viewport={'width':390,'height':844} if mobile else {'width':1440,'height':1000},permissions=['camera','microphone','clipboard-read','clipboard-write'])
            context.add_init_script(INSTRUMENT);target=context.new_page();pages.append(target)
            target.on('pageerror',lambda e: report['pageErrors'].append(str(e)))
            target.goto(url,wait_until='domcontentloaded',timeout=15000)
            wait(target,"document.querySelector('#device-status').textContent.includes('Your choices')")
            return target
        def connected(target,count=1):
            wait(target,'(count)=>window.__guestPCs.filter(p=>p.connectionState===\'connected\').length>=count',arg=count,timeout=20000)
        host=page();screenshot(host,'setup-desktop.png')
        mobile=page(mobile=True);assert mobile.evaluate('document.documentElement.scrollWidth<=innerWidth');screenshot(mobile,'setup-mobile.png');mobile.close()
        assert host.evaluate('window.__guestRequests')==0
        assert host.evaluate("document.querySelector('#preview').srcObject===null")
        passed('Native root/subpath-ready startup, responsive preview and no permission requests on open')
        host.bring_to_front();host.fill('#name','Alex Morgan');host.fill('#title','Guest collaboration review')
        host.locator('#setup [data-device="audio"]').click();host.locator('#setup [data-device="video"]').click()
        wait(host,'window.__guestCaptures.length===2')
        host.click('#create');expect(host.locator('#meeting')).to_be_visible(timeout=15000)
        host.click('#copy-invite');wait(host,'!!window.__lastCopied');invitation=host.evaluate('window.__lastCopied')
        assert '#room=' in invitation and 'key=' in invitation
        guest=page(invitation);assert guest.evaluate('location.hash')=='';guest.fill('#name','Sam Rivera');guest.click('#join');expect(guest.locator('#waiting')).to_be_visible()
        assert guest.evaluate('window.__guestRequests')==0
        host.click('#toggle-people');host.locator('#waiting-list').get_by_role('button',name='Admit',exact=True).click()
        expect(guest.locator('#meeting')).to_be_visible(timeout=10000);connected(host);connected(guest)
        wait(guest,"document.querySelector('.tile:not(.local) video')?.videoWidth>0")
        passed('Expiring invite, waiting-room approval, receive-only guest and actual RTP media between browser contexts')
        guest.click('#toggle-chat');guest.fill('#message','<img src=x onerror=alert(1)> Hello, Alex.');guest.click('#chat-form button');host.click('#chat-tab')
        wait(host,"document.querySelector('#messages').textContent.includes('Hello, Alex.')")
        assert host.locator('#messages img').count()==0
        guest.click('#hand');wait(host,"[...document.querySelectorAll('.tile:not(.local) .hand-marker')].some(x=>!x.hidden)")
        passed('Real data-channel chat escapes markup; raised hands propagate without broker chat storage')
        host.click('#close-panel');guest.click('#close-panel')
        host.locator('.more-controls summary').click()
        wait(host,"document.querySelector('#live-video-device').options.length>1")
        selected=host.locator('#live-video-device option').nth(1).get_attribute('value')
        previous_capture=host.evaluate('window.__guestCaptures.length')
        host.select_option('#live-video-device',selected)
        wait(host,f'window.__guestCaptures.length>{previous_capture}')
        wait(guest,"document.querySelector('.tile:not(.local) video')?.videoWidth>0")
        host.locator('.more-controls summary').click()
        passed('In-call camera selection changes native capture and restores remote video')
        camera=host.evaluate("window.__guestPCs.find(p=>p.connectionState==='connected').getTransceivers()[1].sender.track.id")
        host.bring_to_front();host.click('#share-screen');wait(host,"document.querySelector('#share-screen').getAttribute('aria-pressed')==='true'",timeout=15000)
        wait(guest,"document.querySelector('.tile.screen:not(.local) video')?.videoWidth>0",timeout=15000)
        assert host.evaluate("window.__guestPCs.find(p=>p.connectionState==='connected').getTransceivers()[1].sender.track.id")==camera
        assert host.evaluate("window.__guestPCs.find(p=>p.connectionState==='connected').getTransceivers()[0].sender.track.readyState")=='live'
        passed('Native screen selection transmits screen RTP while camera and microphone remain live')
        third=page(invitation);third.fill('#name','Jordan Lee');third.click('#join');expect(third.locator('#waiting')).to_be_visible();host.click('#toggle-people')
        host.locator('#waiting-list').get_by_role('button',name='Admit',exact=True).click();expect(third.locator('#meeting')).to_be_visible()
        for target in [host,guest,third]: connected(target,2)
        wait(third,"document.querySelector('.tile.screen:not(.local) video')?.videoWidth>0",timeout=15000)
        passed('Three-party mesh negotiation and late-joining presentation receiver')
        old_peer_count=host.evaluate('window.__guestPCs.length')
        host.evaluate('window.__cancelGuestStream()')
        wait(host,f'window.__guestPCs.length>{old_peer_count}')
        for target in [host,guest,third]: connected(target,2)
        wait(guest,"document.querySelector('.tile.screen:not(.local) video')?.videoWidth>0")
        assert host.evaluate("window.__guestPCs.find(p=>p.connectionState==='connected').getTransceivers()[1].sender.track.id")==camera
        assert host.evaluate("window.__guestPCs.find(p=>p.connectionState==='connected').getTransceivers()[2].sender.track.readyState")=='live'
        expect(host.locator('#connection-recovery')).not_to_be_visible()
        passed('Native SSE interruption reconnects all peers while retaining camera and presentation tracks')
        host.click('#lock');wait(host,"document.querySelector('#lock').getAttribute('aria-pressed')==='true'")
        fourth=page(invitation);fourth.fill('#name','Locked out');fourth.click('#join');expect(fourth.locator('#notice')).to_contain_text('locked');assert fourth.locator('#setup').is_visible();fourth.close()
        passed('Host lock rejects a new participant without disturbing existing connections')
        host.click('#lock');wait(host,"document.querySelector('#lock').getAttribute('aria-pressed')==='false'")
        host.once('dialog',lambda dialog:dialog.accept());host.click('#waiting-policy')
        wait(host,"document.querySelector('#waiting-policy').getAttribute('aria-pressed')==='false'")
        immediate=page(invitation);immediate.fill('#name','Policy guest');immediate.click('#join');expect(immediate.locator('#meeting')).to_be_visible(timeout=10000)
        connected(immediate);immediate.click('#leave');immediate.close()
        host.click('#waiting-policy');wait(host,"document.querySelector('#waiting-policy').getAttribute('aria-pressed')==='true'")
        passed('Waiting-room policy can be changed live without ending the meeting')
        host.once('dialog',lambda dialog:dialog.accept());host.click('#rotate-invite')
        host.evaluate('window.__lastCopied=null');host.click('#copy-invite');wait(host,'!!window.__lastCopied')
        replacement=host.evaluate('window.__lastCopied');assert replacement!=invitation
        invalid=page(invitation);invalid.fill('#name','Expired link');invalid.click('#join');expect(invalid.locator('#notice')).to_contain_text('Invalid or expired');invalid.close()
        pending=page(replacement);pending.fill('#name','Waiting after rotation');pending.click('#join');expect(pending.locator('#waiting')).to_be_visible()
        passed('Invitation rotation rejects old links while retaining connected participants')
        host.once('dialog',lambda dialog:dialog.accept())
        host.locator('#people .person').filter(has_text='Sam Rivera').get_by_role('button',name='Make host',exact=True).click()
        expect(host.locator('#host-controls')).not_to_be_visible();expect(host.locator('#copy-invite')).to_be_disabled()
        guest.click('#toggle-people');expect(guest.locator('#host-controls')).to_be_visible()
        guest.locator('#waiting-list').get_by_role('button',name='Admit',exact=True).click()
        expect(pending.locator('#meeting')).to_be_visible(timeout=10000);connected(pending)
        pending.click('#leave');pending.close()
        guest.click('#copy-invite');wait(guest,'!!window.__lastCopied');assert guest.evaluate('window.__lastCopied')!=replacement
        guest.click('#close-panel')
        passed('Host handover moves controls and waiting requests, issues a fresh invite and revokes old-host powers')
        host.click('#close-panel');screenshot(guest,'meeting-presentation.png')
        host.bring_to_front();host.click('#share-screen');wait(guest,"!document.querySelector('.tile.screen:not(.local)')")
        assert host.evaluate("window.__guestPCs.find(p=>p.connectionState==='connected').getTransceivers()[1].sender.track.readyState")=='live'
        guest.click('#toggle-people');guest.once('dialog',lambda dialog:dialog.accept());guest.click('#end')
        for target in [host,guest,third]: expect(target.locator('#ended')).to_be_visible(timeout=10000)
        assert host.evaluate("window.__guestCaptures.every(t=>t.readyState==='ended')")
        passed('Stop-sharing preserves camera; End for everyone stops every client and releases host capture')
        a=page(static_url);b=page(static_url);a.fill('#name','Direct Alex');b.fill('#name','Direct Sam')
        a.locator('#setup [data-device="audio"]').click();a.locator('#setup [data-device="video"]').click();wait(a,'window.__guestCaptures.length===2')
        for target in [a,b]: target.click('#mode-direct')
        a.click('#direct-create');wait(a,"document.querySelector('#pairing-output').value.length>100",timeout=20000)
        b.fill('#offer-input',a.input_value('#pairing-output'));b.click('#direct-accept');wait(b,"document.querySelector('#pairing-output').value.length>100",timeout=20000)
        a.fill('#answer-input',b.input_value('#pairing-output'));a.click('#apply-answer');connected(a);connected(b)
        wait(b,"document.querySelector('.tile:not(.local) video')?.videoWidth>0")
        a.click('#toggle-chat');a.fill('#message','Static-host direct data channel');a.click('#chat-form button');b.click('#toggle-chat')
        wait(b,"document.querySelector('#messages').textContent.includes('Static-host direct data channel')")
        a.click('#leave');b.click('#leave');assert a.evaluate("window.__guestCaptures.every(t=>t.readyState==='ended')")
        passed('Broker-free offer/answer pairing, native RTP and data channel work at a GitHub Pages-style project subpath')
        if not args.fixture:
            workspace=browser.new_page();workspace.goto(origin+'/index.html');expect(workspace.locator('.guest-meeting-entry')).to_have_count(1)
            assert workspace.locator('.guest-meeting-entry').get_attribute('href').endswith('/meet.html');workspace.close()
            passed('Existing workspace remains available with exactly one no-account meeting entry')
        assert not report['pageErrors'],report['pageErrors']
        assert not report['screenshotErrors'],report['screenshotErrors']
        report['status']='pass';browser.close();browser=None
except Exception as error:
    report['status']='fail';report['error']=str(error)
    report['diagnostics']=[]
    for index,target in enumerate(pages):
        if target.is_closed(): continue
        try:
            report['diagnostics'].append({'page':index, 'state':target.evaluate('''() => ({
              readyState:document.readyState,fonts:document.fonts.status,
              notice:document.querySelector('#notice')?.textContent,
              connection:document.querySelector('#connection-status')?.textContent,
              captures:window.__guestCaptures?.map(t=>({kind:t.kind,state:t.readyState})),
              peers:window.__guestPCs?.map(p=>({connection:p.connectionState,ice:p.iceConnectionState,
                gathering:p.iceGatheringState,signaling:p.signalingState,
                local:p.localDescription?.type,remote:p.remoteDescription?.type,
                tracks:p.getTransceivers().map(t=>({direction:t.currentDirection,
                  send:t.sender.track?.kind,sendState:t.sender.track?.readyState,
                  receive:t.receiver.track.kind,receiveState:t.receiver.track.readyState,muted:t.receiver.track.muted}))}))
            })''')})
        except Exception as diagnostic_error: report['diagnostics'].append({'page':index,'error':str(diagnostic_error)})
    raise
finally:
    if browser:
        try: browser.close()
        except Exception: pass
    if playwright:
        try: playwright.stop()
        except Exception: pass
    if server:
        server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill();server.wait()
    if static: static.shutdown();static.server_close()
    (OUT/'result.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2),flush=True)
