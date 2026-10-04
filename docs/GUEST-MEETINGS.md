# Guest P2P meetings

Open **Guest meeting** in the workspace header, or open `meet.html` directly. No Veyra or Microsoft account, email address, password, or logo upload is required. A display name is not a verified identity. Existing workspace accounts, private conversations, Microsoft integrations and their access checks remain unchanged.

## Start and join

```sh
npm start
# Open http://localhost:4173/meet.html
```

`npm start` now runs `server/start.mjs`, which attaches the isolated guest broker to the original workspace HTTP server. `npm run start:workspace` retains the original account-based-only server. Docker uses the combined entry point. To load environment settings explicitly:

```sh
node --env-file=.env --experimental-sqlite server/start.mjs
```

Choose **Meeting link**, enter your name, select camera/microphone only when wanted, and create a meeting. Copy the invitation and send it through a trusted channel. Guests review the server address, enter their names, and join. The waiting room is enabled by default; the host admits guests in **People**. The host can lock/unlock new entry, remove participants, or end the meeting for everyone. Leaving is distinct from ending for everyone.

Rooms are ephemeral: they expire after four hours or a server restart. A dropped connection can reconnect within two minutes with its in-memory participant capability. Refreshing/closing the tab loses that capability, including host privileges; rejoining the invitation creates a new guest. The host can transfer control to a connected, admitted participant using **People → Make host** before leaving. There is no recovery account or automatic host election. Use **End for everyone** to revoke the room intentionally. Removing a guest revokes that session, but someone retaining the invitation can request entry again; keep the waiting room enabled or lock the meeting.

## Host controls and recovery

**Make host** transfers the role atomically to one admitted participant with active signaling/media membership. The previous host immediately loses access controls. A new invitation is issued to the new host and old invitation links stop admitting new arrivals. The transfer leaves existing calls and waiting requests intact; the new host receives the waiting list. There is no remote-unmute or forced camera activation.

**Replace invitation** invalidates the old invitation for future joins, without ejecting people already admitted or auto-admitting pending requests. Only the current host receives the replacement; other participants' Copy invitation buttons are disabled. **Waiting room: on/off** controls future arrivals only: existing waiting guests still require explicit admission. Old-host controls and old invitations submitted before a change cannot commit afterward, even when their HTTP request bodies arrive slowly.

A stalled signaling stream is aborted after 45 seconds without incoming bytes, then reconnected with bounded backoff. The recovery bar also provides **Retry connection** and **Leave meeting**. Reconnection replaces remote peer connections without reacquiring local devices or stopping a presentation. No connection failure is represented as a successful media connection. Microphone/camera selectors and device error guidance are accessible during a meeting under **More**, as well as before joining.

Server-issued guest TURN credentials include their expiry and renew at half-life (at most a five-minute interval). Fresh credentials update active peer-connection configurations and new-peer defaults without interrupting healthy media. Temporary renewal failures are shown and retried at a bounded rate; disconnecting or leaving discards stale renewal results. Operator-supplied static credentials do not acquire an inferred expiry and remain the operator's responsibility.

## Media and interaction

The mesh supports **up to eight admitted participants** and sixteen additional waiting guests. Every connected pair has its own RTCPeerConnection; this is not an SFU or a large-meeting architecture. Four stable RTP slots keep microphone, camera, screen and optional shared audio separate. Starting/stopping a presentation does not replace or stop the camera or microphone. Late-joining peers receive the current tracks.

Shared-audio interruption and ending update their advertised state independently; stopping only shared audio preserves the microphone, camera and presentation. Unexpected display tracks are stopped and are never transmitted.

The page includes receive-only joining, camera preview, microphone meter, independent permission recovery, input device selection, camera flipping, native screen picker, participant/presentation pinning, fullscreen, raised hands, five reactions, ephemeral chat, playback retry and measured connection statistics. Chat/reactions use RTCDataChannel, not the signaling server. Messages report the number of open channels sent to; this is **not a delivery/read receipt**. Chat is memory-only, bounded to 200 displayed entries, and is not replayed to late joiners.

Screen capture requires HTTPS (or local localhost) and a browser implementing `getDisplayMedia`. Sharing always requires an explicit user gesture and native source chooser. Screen/tab audio is requested only with **Include shared audio**; whether a track is returned depends on the browser, OS and selected source. Many mobile browsers cannot originate screen sharing; the page explains this and still supports receiving presentations. JavaScript cannot override denied OS/browser permissions. No recording or transcription is added by this feature.

## Direct pairing on static hosting

**Direct pairing** is a separate, one-to-one, serverless-signaling option. Both people open `meet.html`, including from a GitHub Pages project subpath. The initiator creates an offer and sends the complete JSON through a trusted channel. The recipient pastes the offer and sends the generated answer back. The initiator applies that answer. Pairing data expires after ten minutes and binds the answer to its offer/session; a reused or unrelated answer is rejected. A SHA-256 offer digest is an integrity binding, **not identity verification**. Exchange pairing data privately; SDP can expose network candidates. Media/chat still use WebRTC, not the copied text.

No third-party STUN/TURN service is silently selected. The default empty ICE configuration may work on a reachable local network but is not a promise of cross-network connectivity. Configure your own suitable ICE servers in **Connection settings**, or public non-secret defaults in `public/guest-config.js`. Never publish a long-lived TURN secret or embed a service administrator key. Direct pairing has no automatic signaling-based ICE restart; reconnect by exchanging a fresh offer/answer. Zero-candidate gathering fails visibly instead of presenting an unusable invitation.

## Deploy automatic invitation meetings

GitHub Pages serves HTML/JS only. It **cannot** run the broker. For automatic cross-device invitations, deploy the combined Node server over HTTPS, with appropriate STUN/TURN infrastructure. This change does not provision a public broker, TURN service or Azure resource.

| Setting | Purpose |
|---|---|
| `PUBLIC_ORIGIN` | Exact browser-facing origin for the combined server, e.g. `https://meet.example.com` |
| `GUEST_MEETINGS_ENABLED` | Guest broker enabled unless set to `false`; disable anonymous meetings independently of workspace registration |
| `GUEST_ALLOWED_ORIGINS` | Comma-separated exact HTTPS origins allowed to use a separately hosted client; no wildcard and no trailing path |
| `GUEST_ICE_SERVERS_JSON` | Explicit guest ICE array; intentionally separate from authenticated workspace ICE settings |
| `GUEST_TURN_ENABLED` | Set to `true` only when deliberately allowing guest TURN issuance |
| `TURN_URLS`, `TURN_SECRET` | Server-only TURN URLs and shared HMAC secret; guest credentials expire within ten minutes and no later than room expiry |

For a GitHub Pages frontend, set `guestConfig.signalingURL` to your HTTPS server root, then include `https://wieslawsoltes.github.io` in that server's `GUEST_ALLOWED_ORIGINS`. The page also allows per-meeting server entry. An invitation can identify a server, but no request or media capture occurs automatically: recipients review it before joining. Configured cross-origin access uses explicit CORS and `credentials: omit`, never workspace cookies.

Reverse proxies must disable buffering for the SSE endpoint, preserve `Authorization`, allow long-lived connections and pass the original request `Origin`. Set `PUBLIC_ORIGIN` to the external HTTPS origin. Do not log authorization headers, bodies containing capabilities, or signaling SDP. Do not cache `/api/guest-meetings` responses. The current adapter uses `/api/guest-meetings`; mounting beneath another path requires the proxy to strip that prefix consistently.

## Abuse controls and privacy limits

The broker holds meeting/participant records in memory, with independent random invitation and participant capabilities (256-bit secrets; server stores hashes). Tokens travel in authorization headers, not URL queries or cookies. Invitation secrets use a URL fragment and are removed from the visible page URL after parsing. No participant token is persisted to browser storage. Guest tokens cannot open workspace data, issue ACS tokens or impersonate a registered workspace account.

Waiting guests cannot obtain guest ICE credentials, send media signaling, enumerate admitted guests, or use host controls. Approved signaling requires an active stream, is scoped to the same room, and derives sender identity on the server. Validation, bounded bodies, bounded stream buffering, room/participant limits, expiry, exact-origin writes and rate limits are enforced. Same-origin GETs may omit `Origin`; those reads still require their header-only participant capability. Client-side media/data handling bounds candidates, chat, packet rate and retained history.

Default limits include 128 rooms, ten room creations and sixty join attempts per IP per hour, plus request/session budgets. The service deliberately does not trust `X-Forwarded-For`; behind a reverse proxy these limits may be shared by its upstream address. Deploy additional proxy-level quotas/CAPTCHA/access controls and monitoring before opening anonymous creation broadly. Guest TURN issuance can incur relay costs, and issuing a short-lived credential cannot forcibly terminate an existing malicious relay allocation. Keep it disabled unless provisioned and budgeted deliberately.

P2P connections may disclose participants' network addresses to each other. Transport encryption is provided by WebRTC; this is not a claim of verified identities, independent key verification, application-managed end-to-end encryption, or protection from an untrusted signaling/server operator. Admitted participants can capture media externally. Host removal stops the compliant clients' connections but cannot force malicious modified clients to forget previously received content. Privacy-sensitive deployments should use their own controlled infrastructure and review the threat model.

## Source and validation

`public/core/guest-protocol.js`, `guest-transport.js` and `meeting-session.js` are reusable browser modules. The latter reuses the unchanged `MediaController`. `server/guest-meetings.mjs` is a reusable HTTP adapter; `server/start.mjs` supplies workspace integration. `public/meetings.js` is the accessible UI controller. `guest-entry.js` adds a header link without rewriting the workspace application.

```sh
npm run test:guest
python -m pip install playwright==1.55.0
python -m playwright install chromium
python tests/guest_browser.py
```

The native browser suite launches the complete server, uses separate browser contexts, native RTCPeerConnections, browser-generated synthetic capture and the native screen chooser. It checks guest admission, RTP/data transport, three-person mesh, screen/camera coexistence, lock/end, device cleanup, static-subpath manual pairing and the workspace entry link. It fails on blocked navigation or unavailable media; no policy bypass or fixture pass is substituted. The separate `tests/guest_component.py` exercises only injected UI components with synthetic media. See [the validation record](validation/guest-meetings.md) for actual local results and remaining acceptance work.
