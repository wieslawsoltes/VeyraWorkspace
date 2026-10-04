"""Restricted-environment UI component fixture, NOT native browser acceptance.
No HTTP navigation, native device capture, secure-origin permissions, or real-network claims.
The production modules are injected into about:blank. Capture and WebCrypto are explicit
synthetic/local-computation adapters. No network, ICE, signaling, or media transport is exercised.
"""
from pathlib import Path
import base64, re, json, hashlib, os
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tests/output/guest-component'
OUT.mkdir(parents=True, exist_ok=True)
CACHE = {}
def module_url(path):
    path = path.resolve()
    if path in CACHE: return CACHE[path]
    source = path.read_text()
    if path.name == 'meetings.js':
        source = source.replace('const media = new MediaController()', 'const media = new MediaController({secure: true, mediaDevices: globalThis.__fixtureDevices})')
    source = re.sub(r"(from\s+)(['\"])(\./[^'\"]+)\2", lambda m: m[1] + json.dumps(module_url(path.parent / m[3])), source)
    result = 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()
    CACHE[path] = result
    return result
BOOT = r'''() => {
  window.__fixtureTracks = []; window.__fixtureCaptures = 0; window.__pcs = [];
  const NativeRTC = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends NativeRTC { constructor(config) { super(config); window.__pcs.push(this); } };
  if (!crypto.subtle) Object.defineProperty(crypto, 'subtle', {value: {digest: async (algorithm, data) => new Uint8Array(await window.fixtureSHA(Array.from(new Uint8Array(data)))).buffer}});
  function video(label, color) {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d'); let tick = 0;
    const timer = setInterval(() => {ctx.fillStyle=color;ctx.fillRect(0,0,640,360);ctx.fillStyle='#fff';ctx.font='24px sans-serif';ctx.fillText(label,35,70);ctx.font='16px sans-serif';ctx.fillText('SYNTHETIC TEST MEDIA',35,105);ctx.fillRect(35+(tick++%55)*8,210,60,30);},80);
    const track = canvas.captureStream(12).getVideoTracks()[0]; const original = track.stop.bind(track);
    track.stop = () => {clearInterval(timer); original();}; return track;
  }
  function audio() {
    const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination();
    gain.gain.value=.01;oscillator.connect(gain);gain.connect(destination);oscillator.start();context.resume();
    const track=destination.stream.getAudioTracks()[0], original=track.stop.bind(track);
    track.stop=()=>{oscillator.stop();context.close();original();};return track;
  }
  function stream(tracks) {window.__fixtureTracks.push(...tracks);return new MediaStream(tracks);}
  window.__fixtureDevices = {
    getUserMedia: async options => {window.__fixtureCaptures++;return stream([options.audio?audio():video('Camera preview','#454c83')]);},
    getDisplayMedia: async options => stream([video('Screen presentation','#25716b'),...(options.audio?[audio()]:[])]),
    enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {}
  };
  // Capability reporting only: real screen capture is NOT tested by this harness.
  if (!navigator.mediaDevices) Object.defineProperty(navigator,'mediaDevices',{value:{getDisplayMedia(){}}});
}'''

def load(browser, viewport=None):
    page=browser.new_page(viewport=viewport or {'width':1440,'height':1000})
    page.expose_function('fixtureSHA', lambda data: list(hashlib.sha256(bytes(data)).digest()))
    page.evaluate(BOOT)
    html=(ROOT/'public/meet.html').read_text()
    html=re.sub(r'<link rel="stylesheet"[^>]*>', '<style>'+(ROOT/'public/meetings.css').read_text()+'</style>', html)
    html=re.sub(r'<script type="module"[^>]*></script>', '', html)
    page.set_content(html)
    page.add_script_tag(type='module',url=module_url(ROOT/'public/meetings.js'))
    page.wait_for_function("document.querySelector('#device-status').textContent.includes('Your choices')")
    return page

result={'scope':'about:blank component fixture only; synthetic capture and injected SHA-256; no HTTP, signaling, or RTC transport acceptance','checks':[]}
try:
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
        host=load(browser); errors=[]
        host.on('pageerror',lambda e: errors.append(str(e)))
        assert host.evaluate('window.__fixtureCaptures') == 0
        assert host.evaluate("document.querySelector('#preview').srcObject===null")
        host.screenshot(path=str(OUT/'setup-desktop.png'),full_page=True)
        mobile=load(browser,{'width':390,'height':844})
        mobile.screenshot(path=str(OUT/'setup-mobile.png'),full_page=True)
        assert mobile.evaluate('document.documentElement.scrollWidth <= innerWidth')
        result['checks'].append('Desktop/mobile setup layout and zero automatic capture requests')
        host.fill('#name','Alex Morgan')
        host.locator('#setup [data-device="audio"]').click()
        host.locator('#setup [data-device="video"]').click()
        host.wait_for_function('window.__fixtureTracks.length === 2')
        host.wait_for_function("document.querySelector('#preview').videoWidth > 0")
        host.screenshot(path=str(OUT/'setup-preview.png'),full_page=True)
        result['checks'].append('Explicit microphone and camera preview controls use the real MediaController with synthetic sources')
        for kind in ['audio','video']: host.locator(f'#setup [data-device="{kind}"]').click()
        host.wait_for_function("window.__fixtureTracks.every(t=>t.readyState==='ended')")
        assert host.evaluate("document.querySelector('#preview').srcObject===null")
        result['checks'].append('Turning devices off stops all synthetic capture tracks and detaches inactive preview')
        host.evaluate("() => {window.__fixtureDevices.getUserMedia = async () => {throw new DOMException('Test permission denial', 'NotAllowedError');};}")
        host.locator('#setup [data-device="video"]').click()
        host.wait_for_function("document.querySelector('#device-status').textContent.includes('blocked')")
        assert host.locator('#setup [data-device="video"]').inner_text() == 'Camera retry'
        result['checks'].append('Permission denial is visible, preserves setup, and offers Retry')
        host.click('#mode-direct')
        assert host.locator('#direct-setup').is_visible()
        assert host.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert not errors, errors
        result['checks'].append('Direct pairing setup is reachable; no uncaught component errors')
        browser.close()
    result['status']='pass'
except Exception as error:
    result['status']='fail'; result['error']=str(error); raise
finally:
    (OUT/'result.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))
