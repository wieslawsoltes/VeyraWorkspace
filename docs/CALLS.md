# Calling and device recovery (Veyra 1.1)

## Start or test a call

Select **Meet**, then **Enable microphone**, **Enable camera**, or **Test selected devices**. Opening setup never captures anything. The muted, inline video is a real preview; the microphone meter measures local input and is never connected to your speakers. **Join call** reuses those tracks instead of opening the camera a second time. An untested selected device is requested from the Join gesture.

Microphone and camera are acquired independently. A failed camera does not destroy a working microphone. If access fails, setup remains open with device-specific guidance. Select **Retry** after correcting permissions, uncheck the unavailable device to use the other one, or choose **Join without devices**. This is a real receive-only peer connection, not fake microphone/camera data. You can also use it while a permission prompt has not been answered. Any capture that finishes after cancellation is immediately stopped.

## iPhone/iPad permission errors

A `NotAllowedError` does not identify one unique cause: browser/site permissions, operating-system access, embedding policy, or secure-context restrictions can refuse capture. Veyra cannot grant itself access. Check the browser's access under **Settings → Privacy & Security → Camera / Microphone**, and review the site's own permissions. For Chrome on iOS, check Chrome's site permissions; for Safari, check the website's camera/microphone settings. Bring Veyra to the foreground before retrying. Do not globally enable unrelated sites.

When the device is busy, close competing capture tabs/apps and retry. Open the HTTPS app directly rather than inside an embedded preview. An ordinary HTTP LAN address is not the `localhost` exception. Settings names and available controls depend on browser and OS version.

Remote playback may separately be blocked by autoplay rules even after capture succeeds. Use **Tap to play audio/video** on the participant tile. Capture errors and playback errors are not conflated.

## During a call

**Devices** opens the same controller used for preflight. Change the microphone/camera selection or flip the camera without ending the call. A camera switch releases the previous camera first, accommodating platforms with one active camera. A failed microphone switch preserves the existing input. Selecting Automatic removes a stale device ID. Device enumeration is optional, does not request capture, and refreshes after permission grants or a device-change event. Device IDs are not persisted or included in diagnostics.

Turning the microphone or camera off stops and removes its track; turning it back on requests a new track and replaces the existing RTP sender source. Browser interruptions and ended tracks update visible state. A revoked or disconnected device is never silently reported as healthy or automatically recaptured. Explicit Retry is available. Screen sharing is capability-gated; changing cameras during a screen share does not accidentally replace the outgoing screen. Ending the share restores the selected camera. Mobile screen sharing still depends on actual browser support.

**People** lists actual call peers, connection state, microphone/camera state, raised hands and screen sharing. Pin a participant to enlarge that tile. Late joins receive current media state from presence, rather than assuming everyone is unmuted. The authenticated server canonicalizes this data and retains the existing room-membership checks.

Diagnostics report aggregate bytes, receive bitrate, packet loss, RTT and jitter. The exported JSON contains no names, device IDs, candidate IP addresses, SDP, tokens or credentials. These are observed measurements, not an invented quality score.

**Record me** records only your own media after explicit confirmation. MIME negotiation includes MP4/audio MP4 for supporting browsers, and the filename uses the actual container extension. Stopping or replacing a recorded device stops that recording; start another explicitly for the new devices. Remote media and screens are not recorded by this feature.

## Deployment and boundaries

The GitHub Pages build supports local browser work and calls between real tabs on the same origin/browser storage partition. It does not supply a multi-device signaling server. Cross-device calling needs the included authenticated Node server, HTTPS, and suitable TURN infrastructure. This is a bounded eight-person mesh, not an SFU. This release does not add PSTN, enterprise compliance, Teams protocol parity or an unauthenticated public signaling service.

The new Veyra device controller is for Veyra WebRTC rooms. The optional ACS adapter remains a distinct, credential-dependent Microsoft meeting integration. No live Microsoft tenant or physical iPhone permissions were available in the automated tests.

## Architecture and tests

`public/core/media.js` owns permission requests, track lifetimes, generation fences, device enumeration, the input meter and recording format negotiation. `public/core/calls.js` owns peer connections, perfect negotiation, serialized source replacement and call membership. `public/ui/device-panel.js` owns disposable DOM/meter subscriptions but never implicitly owns or stops call tracks. `public/core/call-state.js` defines the minimal public presence contract shared by client and server.

Run `npm run check`, `npm test`, and `npm run build`. Install `playwright==1.55.0` and Chromium to run `python tests/browser_calls.py`. It serves the actual built files at `/VeyraWorkspace/` and uses native IndexedDB, BroadcastChannel, capture APIs and RTP. Chromium's synthetic devices are used instead of physical hardware. Permission-denial, pending-prompt and autoplay-rejection scenarios explicitly inject failures in the test harness. They are not represented as physical iPhone tests. CI retains JSON reports, screenshots and a self-recording as artifacts. Environment policy blocks fail acceptance rather than being counted as passes.

After modifying release files, run `npm run manifest` to regenerate `MANIFEST.sha256` before committing.

## Primary references

- Media Capture and Streams: https://www.w3.org/TR/mediacapture-streams/
- WebRTC, sender replacement and negotiation: https://www.w3.org/TR/webrtc/
- WebKit media autoplay: https://webkit.org/blog/7763/a-closer-look-into-webrtc/
- WebKit playback rejection handling: https://webkit.org/blog/7734/auto-play-policy-changes-for-macos/
- Chrome camera/microphone permissions: https://support.google.com/chrome/answer/2693767?co=GENIE.Platform%3DiOS&hl=en
