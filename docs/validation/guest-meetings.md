# Guest meeting validation record

## Verified implementation

Implementation commit: `5470136ce10c6f3421211c85857430e444819a62` on `feature/no-login-p2p-meetings` (PR #2). The following results were observed on October 4, 2026. These results apply to that initial implementation; later continuation results are recorded below.

- **Full repository core: 140 passed, 0 failed, 0 skipped.** Source checksums, JavaScript module/import validation, and static build also passed in [CI run 37209437025](https://github.com/wieslawsoltes/VeyraWorkspace/actions/runs/37209437025).
- **Existing native workspace/browser acceptance: passed** in the same run, including root and project-subpath media checks.
- **Guest regressions: 42 passed, 0 failed, 0 skipped** (18 HTTP/security, 18 media/protocol, 6 transport). They passed both locally on Node.js 22.16.0 and in GitHub Actions on Node.js 22.23.3.
- **Native guest meeting acceptance: all nine scenario groups passed**, with no uncaught page errors or screenshot failures, in [run 37209437060](https://github.com/wieslawsoltes/VeyraWorkspace/actions/runs/37209437060). This used the complete workspace server, Chromium 140, Playwright 1.55.0 and a virtual desktop. [Browser evidence artifact](https://github.com/wieslawsoltes/VeyraWorkspace/actions/runs/37209437060/artifacts/11304889444) contains the report and desktop/mobile/presentation screenshots.

## Native browser coverage

1. Desktop/mobile setup, no automatic capture request, and detached inactive preview.
2. Invitation joining, waiting-room admission, receive-only guests and actual RTP media between separate browser contexts.
3. Actual RTCDataChannel chat, escaped markup and propagated raised hands.
4. Native screen selection and received screen video while the original camera and microphone remain live.
5. Three-person mesh negotiation and a late-joining presentation receiver.
6. Meeting lock rejects new entry without disrupting existing connections.
7. Stopping screen sharing preserves camera capture; ending for everyone disconnects all clients and releases host devices.
8. Broker-free offer/answer pairing, RTP and chat on a GitHub Pages-style static project subpath.
9. The original workspace remains available with exactly one guest-meeting entry.

Native tests use Chromium-generated synthetic camera/microphone devices and an automated native screen chooser, **not physical-device testing**. HTTP, session descriptions, ICE negotiation, RTP, data channels, screen capture and the application security policy are not replaced with component fixtures. The production Content Security Policy was not relaxed for tests.

## Local component scope and earlier failures

Five separately scoped UI component scenarios passed locally: responsive setup, explicit device preview, capture cleanup/preview detachment, permission-denial feedback and direct-pairing setup navigation. That harness injects synthetic capture into `about:blank`; it is not evidence of native transport acceptance.

Local native loopback navigation was blocked by `net::ERR_BLOCKED_BY_ADMINISTRATOR`. A separate exploratory local RTC attempt gathered zero candidates and did not connect. No policy was bypassed, and those attempts remain failures. The production manual pairing path reports zero-candidate failure explicitly. Native transport acceptance was subsequently established on GitHub Actions as recorded above.

Initial GitHub attempts exposed test-runner screenshot/CSP polling problems and a real native-fetch receiver binding bug. These were fixed rather than skipped: inactive preview detachment, a virtual desktop, CSP-compatible test polling, and globally bound transport fetch with a receiver regression. The original `public/core/media.js` remains unchanged (Git blob `1b83008908ebccf12b30e8c516bd55b47b2612bc`).

## Remaining deployment acceptance

Physical iPhone/Android behavior, multiple real networks/NATs, production TURN, sustained eight-person bandwidth/CPU load, reverse-proxy operation, and independent security/load auditing remain deployment acceptance tasks. No public signaling/TURN backend was provisioned. GitHub Pages alone cannot host the automatic-invitation broker. This record does not claim full Microsoft Teams parity or production certification.


## PR #2 continuation: host controls and long-call recovery

The continuation adds host handover, invitation replacement, live admission policy, in-call device selectors, a signaling inactivity watchdog and explicit retry/leave UI, temporary TURN renewal, and independent shared-audio interruption cleanup. Authorization and invitation checks are repeated after asynchronous body reads; tests exercise slow-body revocation races.

Local continuation verification: **163 repository tests passed, zero failed/skipped**, including **65 guest regression tests**. JavaScript module/import checks and the static build passed. A new local native-browser attempt remained blocked by `ERR_BLOCKED_BY_ADMINISTRATOR` and is not counted as a pass. The extended GitHub browser suite checks the new controls and native reconnect behavior alongside the original scenarios; consult PR #2's exact-head checks for its result. No new physical-device, real TURN relay, eight-person sustained-load, or production certification claim is made.
