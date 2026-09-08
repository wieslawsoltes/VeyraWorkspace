"""HTTP-served browser acceptance at a GitHub Pages-like project subpath.

Native IndexedDB, BroadcastChannel, getUserMedia (Chromium synthetic devices),
and RTCPeerConnection are used. Denial, unanswered prompts and autoplay rejection
are injected ONLY in the explicitly named recovery scenarios, never in production.
No storage replacement or policy bypass. An environment block fails the suite.

Run: npm run build; pip install playwright==1.55.0;
     python -m playwright install chromium; python tests/browser_calls.py
"""
import asyncio
import functools
import json
import os
import shutil
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'tests' / 'output' / 'calls'
INSTRUMENT = r"""(() => {
  const devices = navigator.mediaDevices;
  window.__mediaRequests = []; window.__captureTracks = []; window.__failMedia = {};
  window.__deferMedia = null; window.__pendingMedia = [];
  if (devices?.getUserMedia) {
    const original = devices.getUserMedia.bind(devices);
    const capture = constraints => original(constraints).then(stream => {
      window.__captureTracks.push(...stream.getTracks()); return stream;
    });
    devices.getUserMedia = function(constraints) {
      const kind = constraints.video ? 'video' : 'audio';
      window.__mediaRequests.push({kind, constraints});
      if (window.__failMedia[kind]) return Promise.reject(new DOMException('Injected recovery scenario', window.__failMedia[kind]));
      if (window.__deferMedia === kind) return new Promise((resolve, reject) => window.__pendingMedia.push(() => capture(constraints).then(resolve, reject)));
      return capture(constraints);
    };
  }
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function() {
    if (window.__blockRemotePlayback && !this.muted && this.srcObject)
      return Promise.reject(new DOMException('Injected autoplay rejection', 'NotAllowedError'));
    return play.call(this);
  };
})();"""

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

async def run(base):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    report = {'basePath': '/VeyraWorkspace/', 'checks': [], 'errors': [], 'hardware': 'Chromium-generated synthetic microphone/camera; not a physical iPhone test'}
    def passed(name):
        report['checks'].append(name)
        print('PASS:', name, flush=True)
    async with async_playwright() as p:
        launch = {'headless': True, 'args': ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']}
        if os.environ.get('CHROMIUM_PATH'):
            launch['executable_path'] = os.environ['CHROMIUM_PATH']
        browser = await p.chromium.launch(**launch)
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000})
        await context.add_init_script(INSTRUMENT)
        async def page():
            target = await context.new_page()
            target.on('pageerror', lambda error: report['errors'].append(str(error)))
            await target.goto(base, wait_until='networkidle', timeout=15000)
            await target.locator('#composer-input').wait_for()
            return target
        async def setup(target):
            await target.locator('.conversation-header [data-action=start-call]').click()
            await target.locator('#call-join-form').wait_for()
        async def joined(target):
            await target.wait_for_function('window.veyraDiagnostics.callState === "joined"')
            await expect(target.locator('#modal')).not_to_be_visible()
        try:
            first = await page()
            await first.set_viewport_size({'width': 390, 'height': 844})
            await setup(first)
            assert await first.evaluate('window.__mediaRequests.length') == 0
            assert await first.evaluate('document.documentElement.scrollWidth <= innerWidth')
            await first.screenshot(path=str(OUTPUT / 'mobile-preflight.png'))
            passed('Project-subpath startup, native IndexedDB, mobile preflight, and no capture on open')

            await first.locator('[data-device-command=audio]').click()
            await first.wait_for_function('window.veyraDiagnostics.prejoinMedia.audio.status === "ready"')
            await first.locator('#call-join-form [name=video]').check()
            await first.wait_for_function('window.veyraDiagnostics.prejoinMedia.video.status === "ready"')
            await first.wait_for_function('document.querySelector("[data-device-preview]").videoWidth > 0')
            assert await first.locator('[data-device-preview]').evaluate('v => v.muted && v.playsInline')
            requests = await first.evaluate('window.__mediaRequests.length')
            assert requests == 2
            await first.wait_for_function('document.querySelector("[data-input-level]").value > 0', timeout=15000)
            await first.screenshot(path=str(OUTPUT / 'mobile-preview-active.png'))
            passed('Independent native microphone/camera capture, inline muted video, and measured input energy')

            await first.locator('#call-join-form [type=submit]').click()
            await joined(first)
            assert await first.evaluate('window.__mediaRequests.length') == requests
            await first.wait_for_function('window.veyraDiagnostics.camera && !window.veyraDiagnostics.muted')
            passed('Preflight tracks are reused by the live call without another getUserMedia request')

            second = await page()
            await second.evaluate('window.__blockRemotePlayback = true')
            await setup(second)
            await second.locator('[data-action=call-join-without]').click()
            await joined(second)
            assert await second.evaluate('window.__mediaRequests.length') == 0
            for target in [first, second]:
                await target.wait_for_function('window.veyraDiagnostics.callPeers === 1', timeout=30000)
            await second.wait_for_function('window.veyraDiagnostics.rtcBytesReceived > 0', timeout=30000)
            remote = second.locator('.video-tile:not([data-peer-id=local])')
            await expect(remote.locator('[data-action=call-play]')).to_be_visible()
            await second.evaluate('window.__blockRemotePlayback = false')
            await remote.locator('[data-action=call-play]').click()
            await expect(remote.locator('[data-action=call-play]')).not_to_be_visible()
            await remote.locator('video').evaluate('v => v.play()')
            passed('Real BroadcastChannel/WebRTC/RTP to a receive-only peer; explicit autoplay-rejection recovery')

            await first.locator('.call-control[data-action=call-camera]').click()
            await first.wait_for_function('!window.veyraDiagnostics.camera')
            await expect(remote.locator('.video-placeholder')).to_be_visible()
            assert await first.evaluate('window.__captureTracks.filter(t => t.kind === "video").every(t => t.readyState === "ended")')
            await first.locator('.call-control[data-action=call-camera]').click()
            await first.wait_for_function('window.veyraDiagnostics.camera')
            await expect(remote.locator('.video-placeholder')).not_to_be_visible()
            await first.locator('.call-control[data-action=call-mic]').click()
            await first.wait_for_function('window.veyraDiagnostics.muted')
            assert await first.evaluate('window.__captureTracks.filter(t => t.kind === "audio").every(t => t.readyState === "ended")')
            await first.locator('.call-control[data-action=call-mic]').click()
            await first.wait_for_function('!window.veyraDiagnostics.muted')
            passed('In-call device off releases native tracks; enabling them replaces RTP sender tracks')

            await first.locator('.call-control[data-action=call-devices]').click()
            await first.locator('[data-device-command=flip]').click()
            await first.wait_for_function('window.veyraDiagnostics.camera && document.querySelector("[data-device-preview]").videoWidth > 0')
            async with first.expect_download() as info:
                await first.locator('[data-action=call-diagnostics]').click()
            download = await info.value
            diagnostics_path = OUTPUT / download.suggested_filename
            await download.save_as(diagnostics_path)
            diagnostics = json.loads(diagnostics_path.read_text())
            assert diagnostics['version'] == '1.1.0'
            assert not any(key in diagnostics_path.read_text().lower() for key in ['candidate:', 'access_token', 'deviceid', 'sdp'])
            await first.locator('#modal .modal-head [data-action=close-modal]').click()
            await first.wait_for_function('window.veyraDiagnostics.camera')
            await first.locator('.call-control[data-action=call-people]').click()
            assert await first.locator('.call-person').count() == 2
            await first.locator('.call-person [data-action=call-pin]').first.click()
            await first.locator('#modal .modal-head [data-action=close-modal]').click()
            assert await first.locator('.video-tile.focused').count() == 1
            passed('Live device panel, camera flip, participant roster/pinning, and redacted diagnostics export')

            first.on('dialog', lambda dialog: dialog.accept())
            await first.locator('.call-control[data-action=call-record]').click()
            await first.wait_for_timeout(1300)
            async with first.expect_download() as info:
                await first.locator('.call-control[data-action=call-record]').click()
            recording = await info.value
            recording_path = OUTPUT / recording.suggested_filename
            await recording.save_as(recording_path)
            assert recording_path.suffix in ['.webm', '.mp4', '.m4a']
            assert recording_path.stat().st_size > 100
            passed('Explicit self-recording produces actual encoded media with the negotiated file extension')

            await first.locator('.call-control[data-action=call-leave]').click()
            await first.wait_for_function('window.veyraDiagnostics.callState === "idle"')
            assert await first.evaluate('window.__captureTracks.every(t => t.readyState === "ended")')
            await second.wait_for_function('window.veyraDiagnostics.callPeers === 0')
            await second.locator('.call-control[data-action=call-leave]').click()
            passed('Hang-up releases all captured devices and removes remote membership')

            denied = await page()
            await denied.set_viewport_size({'width':390,'height':844})
            await denied.evaluate('window.__failMedia.video = "NotAllowedError"')
            await setup(denied)
            await denied.locator('#call-join-form [name=video]').check()
            await expect(denied.locator('[data-device-errors]')).to_contain_text('Camera access is blocked')
            await denied.locator('#call-join-form [type=submit]').click()
            await expect(denied.locator('#prejoin-progress')).to_contain_text('Not joined')
            assert await denied.evaluate('window.veyraDiagnostics.prejoinMedia.audio.capturing')
            await expect(denied.locator('#call-overlay')).not_to_be_visible()
            await expect(denied.locator('#modal')).to_be_visible()
            await denied.screenshot(path=str(OUTPUT / 'mobile-permission-recovery.png'))
            count = await denied.evaluate('window.__mediaRequests.length')
            await denied.wait_for_timeout(300)
            assert await denied.evaluate('window.__mediaRequests.length') == count
            await denied.evaluate('delete window.__failMedia.video')
            await denied.locator('[data-device-command=video]').click()
            await denied.wait_for_function('window.veyraDiagnostics.prejoinMedia.video.status === "ready"')
            await denied.locator('#call-join-form [type=submit]').click()
            await joined(denied)
            await denied.locator('.call-control[data-action=call-leave]').click()
            passed('Injected camera denial retains microphone and dialog; explicit retry succeeds without reload')

            mic_only = await page()
            await mic_only.evaluate('window.__failMedia.video = "NotFoundError"')
            await setup(mic_only)
            await mic_only.locator('#call-join-form [name=video]').check()
            await expect(mic_only.locator('[data-device-errors]')).to_contain_text('No camera is available')
            await mic_only.locator('#call-join-form [name=video]').uncheck()
            await mic_only.locator('#call-join-form [type=submit]').click()
            await joined(mic_only)
            assert await mic_only.evaluate('!window.veyraDiagnostics.camera && !window.veyraDiagnostics.muted')
            await mic_only.locator('.call-control[data-action=call-leave]').click()
            passed('Injected missing camera can be unchecked to make a real microphone-only call')

            waiting = await page()
            await waiting.evaluate('window.__deferMedia = "audio"')
            await setup(waiting)
            await waiting.locator('#call-join-form [type=submit]').click()
            await waiting.wait_for_function('window.__pendingMedia.length === 1')
            await waiting.locator('[data-action=call-join-without]').click()
            await joined(waiting)
            await waiting.evaluate('Promise.all(window.__pendingMedia.splice(0).map(resolve => resolve()))')
            await waiting.wait_for_function('window.__captureTracks.length > 0 && window.__captureTracks.every(t => t.readyState === "ended")')
            assert await waiting.evaluate('window.veyraDiagnostics.muted && !window.veyraDiagnostics.camera')
            await waiting.locator('.call-control[data-action=call-leave]').click()
            passed('Injected unanswered prompt does not block receive-only join; late native capture is stopped')

            cancelled = await page()
            await cancelled.evaluate('window.__deferMedia = "audio"')
            await setup(cancelled)
            await cancelled.locator('#call-join-form [type=submit]').click()
            await cancelled.wait_for_function('window.__pendingMedia.length === 1')
            await cancelled.locator('.prejoin-actions [data-action=close-modal]').click()
            await cancelled.evaluate('Promise.all(window.__pendingMedia.splice(0).map(resolve => resolve()))')
            await cancelled.wait_for_function('window.__captureTracks.length > 0 && window.__captureTracks.every(t => t.readyState === "ended")')
            assert await cancelled.evaluate('window.veyraDiagnostics.callState === "idle"')
            passed('Cancelling preflight fences and stops a late-granted native stream')
            report['passed'] = not report['errors']
        except Exception as error:
            report['passed'] = False
            report['failure'] = str(error)
            for i, target in enumerate(context.pages[-2:]):
                try:
                    await target.screenshot(path=str(OUTPUT / f'failure-{i}.png'))
                except Exception:
                    pass
        finally:
            await context.close()
            await browser.close()
            (OUTPUT / 'browser-calls.json').write_text(json.dumps(report, indent=2))
            print(json.dumps(report, indent=2))
    return report['passed']

def main():
    if not (ROOT / 'dist' / 'index.html').exists():
        raise SystemExit('Run npm run build before browser acceptance.')
    with tempfile.TemporaryDirectory(prefix='veyra-static-') as directory:
        shutil.copytree(ROOT / 'dist', Path(directory) / 'VeyraWorkspace')
        handler = functools.partial(Handler, directory=directory)
        server = ThreadingHTTPServer(('127.0.0.1',0),handler)
        thread = threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        try:
            passed = asyncio.run(run(f'http://127.0.0.1:{server.server_port}/VeyraWorkspace/'))
        finally:
            server.shutdown()
            server.server_close()
        raise SystemExit(0 if passed else 1)

if __name__ == '__main__':
    main()
