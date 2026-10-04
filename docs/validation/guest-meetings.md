# Guest meeting validation record

## Implemented local checks

- Node.js 22.16.0: `node --test tests/guest-*.test.mjs` — **41 passed, 0 failed, 0 skipped** (18 HTTP/security, 18 media/protocol, 5 transport tests).
- The original `public/core/media.js` was retrieved from GitHub and reconstructed byte-identically (blob `1b83008908ebccf12b30e8c516bd55b47b2612bc`); it is not modified. The original media test fixture is reused.
- JavaScript syntax checks are run separately on new and edited scripts. Python acceptance scripts are syntax-compiled.

## Native local environment limitation

Native Chromium navigation to the loopback HTTP fixture was attempted and failed with `net::ERR_BLOCKED_BY_ADMINISTRATOR`. A separate exploratory `about:blank` native RTCPeerConnection attempt gathered **zero ICE candidates** on both sides and did **not** connect. Neither attempt is counted as a pass. The production pairing path now fails explicitly when gathering yields zero candidates. No browser/network policy was bypassed.

The UI-only component harness is separate and explicitly substitutes synthetic capture and a local SHA-256 adapter in `about:blank`. It passed five component scenarios. Its scope is responsive rendering, explicit preview controls, capture cleanup, permission-denial feedback and direct-pairing setup navigation—not secure-origin permissions, signaling, native capture, or transport.

## GitHub acceptance workflow

`.github/workflows/guest-meetings.yml` runs the native server/browser suite independently of existing CI and preserves `tests/output/guest-native/` on success or failure. Existing CI also executes the new Node tests through its existing `tests/*.test.mjs` glob. The full original repository test suite and actual native meeting acceptance must be evaluated on GitHub Actions; they were not claimed to pass from the partial local source reconstruction.

Physical iPhone/Android device behavior, multiple real networks/NATs, production TURN, sustained eight-person bandwidth/CPU load, production reverse proxy behavior and security/load auditing remain deployment acceptance tasks. No production public signaling/TURN backend was provisioned in this change.
