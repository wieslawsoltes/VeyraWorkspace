# Veyra Workspace

An original, framework-free collaboration workspace with a familiar desktop communication layout, real self-hosted messaging, a WebGPU whiteboard, WebRTC calls, and optional integrations with Microsoft’s documented services.

**Veyra is not Microsoft Teams, is not endorsed by Microsoft, and is not a replacement implementation of Teams’ private protocols.** It contains original application code and UI, not extracted Microsoft application code or assets. Documented interoperability is separated from Veyra’s own communication system.

## Version 1.1 — recoverable camera and microphone setup

Pre-call device tests now include a real camera preview and local microphone level meter. Denied or missing devices leave setup open with independent Retry controls; a working microphone survives a camera failure. Preview tracks transfer into the call, and receive-only joining does not require capture permissions. Live device selection, camera flipping, interruption recovery, remote playback retry, participant pinning, safe diagnostics export, and format-correct self-recording are included.

Read [Calling and device recovery](docs/CALLS.md) for iPhone permission guidance, the capture lifecycle, browser test scope, and the distinction between GitHub Pages local-tab calls and server-backed cross-device calls. Browser/OS permission denials cannot be overridden by JavaScript.

## Run immediately

Install Node.js 22.16 or newer. The base app/server has no external runtime dependencies.

```sh
cd veyra-workspace
npm start
# Open http://localhost:4173
```

The app opens in **Local workspace** mode with clearly marked fictional example conversations. These are editable, persisted in your browser’s IndexedDB, and are not represented as real online colleagues. There are no simulated incoming messages or fake call participants.

Open **Settings → Live server** and create Veyra accounts in two different browser profiles to use actual server-backed chat, shared documents, files, presence, and calling. The default General channel is shared by all registered users of that installation; other conversations enforce explicit membership. These are Veyra passwords, not Microsoft passwords. Account registration does not verify email ownership.

WebGPU, screen capture and browser media require a suitable browser and a secure context. `localhost` is the development exception; deploy over HTTPS. The whiteboard falls back to Canvas 2D when WebGPU is unavailable or its device is lost.

## What is implemented

| Area | Implementation |
|---|---|
| Workspace | Left app rail, favorites, chats, teams/channels, conversation tabs, contextual details, search, light/dark/system appearance and mobile layout |
| Messaging | Persistent text, limited escaped markup, replies/quotes, editing, soft deletion, reactions, bookmarks/pins, draft recovery, failed-send retry, file attachments, real typing events |
| Live server | SQLite/WAL, session authentication, per-room authorization, HTTP writes, authenticated Server-Sent Events, live roster and signaling |
| Calling | Browser WebRTC mesh, microphone/camera toggles, screen sharing, raised hands, real participants, receive-only joining, actual transport statistics, self-only local recording |
| Files | Real binary uploads/downloads, private server storage, authenticated downloads, size limits, content-disposition and sandbox headers |
| Notes | Editable plain-text notes, serialized autosave, compare-and-swap revisions, conflict detection, retained recovery drafts and export |
| Whiteboard | Real WebGPU triangle pipeline, pens, sticky notes, rectangles, ellipses, arrows, selection/move/resize, colors, pan/zoom, undo/redo, SVG export and shared revisioned persistence |
| Calendar | Workweek and agenda views, overlap layout, create/edit/delete, local/server events, meeting links and UTF-8-safe iCalendar export |
| Microsoft | MSAL sign-in, delegated Microsoft Graph adapters and optional Azure Communication Services meeting participation; configuration and limitations below |

Chat text stays in accessible, selectable HTML. WebGPU accelerates the geometry-heavy whiteboard, rather than replacing the entire application with a bitmap. The conversation view is keyed and incrementally reconciled; it initially renders a bounded message window with explicit history expansion and uses CSS content visibility. It is not advertised as a general-purpose, variable-height virtualization engine. Search runs in a worker when available and otherwise uses a main-thread fallback.

## Microsoft sign-in and interoperability

Read **[docs/MICROSOFT.md](docs/MICROSOFT.md)** before deployment. The application never asks for or stores a Microsoft password or a browser-side Microsoft/Azure client secret.

1. Register an appropriate **Single-page application** in Microsoft Entra ID. Choose the supported account audience deliberately.
2. Register the exact redirect URI, such as `http://localhost:4173/auth.html` for development and your HTTPS production equivalent. Do not register an arbitrary wildcard.
3. In Veyra Settings, enter the public application/client ID and tenant (`organizations`, a particular tenant, or `common` as appropriate).
4. Grant the delegated Graph permissions required for the features you enable. Tenant administrators and policy may need to approve consent.
5. Use Veyra’s Microsoft sign-in button. Authentication happens in Microsoft’s own sign-in window through the official MSAL SDK.

Personal Microsoft accounts can authenticate, but **Teams chat/channel Graph APIs do not support consumer accounts**. Personal sign-in is not transformed into a work/school Teams entitlement. Microsoft calendar support and Teams meeting capabilities are also subject to account/resource eligibility.

To bundle the official client SDKs instead of loading the pinned CDN distributions:

```sh
npm install
npm run build:microsoft
# Set useBundledSDKs: true in public/config.js
```

The base app remains usable without these packages. `package.json` pins the optional SDK versions, not an assertion that these are the newest upstream releases. Preserve the upstream license notices emitted during bundling. Review dependencies and commit the lockfile generated by your approved package registry before production rollout.

## Microsoft Teams meetings via ACS

This is a separate integration from Veyra’s own calls. It uses the official Azure Communication Services SDK, not reverse-engineered Teams media/signaling.

Configure an Azure Communication Services resource and set `ACS_CONNECTION_STRING` **only on the Node server**. Install the optional `@azure/communication-identity` dependency. The authenticated `/api/acs/token` endpoint issues short-lived user tokens; resource keys never enter the browser bundle.

The included broker requires a Veyra server session. Microsoft Graph sign-in is not itself authentication to the Veyra server. Sign into the local server account first to establish that session. For an enterprise deployment, integrate your organization’s validated server-side identity/access policy before exposing token issuance publicly.

Then use **Teams meeting** to join an eligible work/school meeting URL. Joining is as an ACS participant; lobby, admission, guest access and tenant policy apply. It is **not** a promise to join as your native Teams organizational identity. Consumer meetings, sovereign-cloud endpoints, PSTN, Teams federation and full Teams feature parity are not implemented.

No live Microsoft tenant/application/resource credentials were supplied for this delivery. The source includes the integration adapters and configuration flow; successful real tenant consent, Graph traffic and ACS participation require acceptance testing against your own environment.

## Deploy the live server

Use a reverse proxy with HTTPS. Configure environment variables explicitly; `npm start` does not automatically load `.env`.

```sh
cp .env.example .env
# Edit values first, especially PUBLIC_ORIGIN and registration policy.
node --env-file=.env --experimental-sqlite server/index.mjs
```

| Variable | Meaning |
|---|---|
| `PORT`, `HOST` | HTTP listen endpoint; defaults to port 4173 |
| `PUBLIC_ORIGIN` | Exact external origin, e.g. `https://collab.example.com`; used for CSRF checks and secure cookies |
| `DATA_DIR` | SQLite database and private file storage directory; keep it outside any public web root |
| `ALLOW_REGISTRATION` | `true` for controlled onboarding; set `false` after provisioning or before a public deployment |
| `ICE_SERVERS_JSON` | Explicit WebRTC ICE server configuration |
| `TURN_URLS`, `TURN_SECRET` | TURN endpoints and shared secret for short-lived, per-user HMAC credentials |
| `ACS_CONNECTION_STRING` | Optional Azure resource secret; server only |

SSE requires proxy buffering to be disabled and idle timeouts long enough to allow 15-second heartbeats. Do not cache authenticated `/api` responses. The server checks the exact request Origin for state-changing operations. Forward HTTPS at the reverse proxy and set `PUBLIC_ORIGIN` to the public HTTPS origin, rather than the upstream HTTP address.

For calls across NATs/firewalls, configure your own TURN relay. An arbitrary public STUN server is not a substitute for TURN. Calls use a bounded peer-to-peer mesh with a maximum of eight participants; there is no large-meeting SFU.

A Dockerfile and Compose example are included. The base container does not download or bundle Microsoft client SDKs. Provision the optional broker dependency/client bundles explicitly when enabling those services.

## Static build

```sh
npm run build
# Deploy the contents of dist/ to an HTTPS static host.
```

Static hosting supports device-local work and the configured client-side Microsoft APIs. It cannot run the SQLite collaboration server or issue ACS tokens. GitHub Pages or a static bucket alone does not supply a live messaging backend.

## Verify

```sh
npm run check
npm test
npm run build
```

Tests cover domain validation, geometry tessellation, message identity, authorization, concurrent document writes, idempotency, file protection, signaling, durable storage, and Microsoft adapter behavior with explicit API test doubles. See **VALIDATION.md** and **TEST-RESULTS.md** for generated results and unverified boundaries.

For real browser acceptance testing against the running server:

```sh
python -m pip install playwright
python -m playwright install chromium
python tests/browser_smoke.py
```

The browser test uses browser-generated synthetic camera/microphone streams, not a real person’s media. A blocked browser policy or unsupported environment is a failure, not a silently passed test. `tests/render_fixture.py` is a separate component-rendering harness with explicit in-memory storage fixtures; it does not validate native IndexedDB, browser networking, real media transport, WebGPU device execution, or Microsoft services.

## Source layout

```text
public/app.js                  Accessible application controller and views
public/styles.css              Responsive workspace visual system
public/core/model.js           Shared validation and domain rules
public/core/storage.js         IndexedDB and authenticated server providers
public/core/renderer.js        WGSL, tessellation, WebGPU/Canvas backend
public/core/whiteboard.js      Interactive board controller
public/core/documents.js       Serialized revisioned editor sessions
public/core/calls.js           WebRTC peer lifecycle and negotiation
public/core/search-worker.js   Loaded-message search index
public/integrations/           MSAL/Graph and ACS adapters
server/index.mjs               HTTP/SQLite/authentication/signaling server
scripts/                       Checks, static build and SDK bundling
tests/                         Executable verification and rendering fixtures
 docs/                         Architecture, deployment and compatibility
```

## Explicit limits

This is functional original application source, not a claim of audited enterprise readiness or total Teams feature coverage. Notes/whiteboards use conflict-detecting snapshots, **not a CRDT**. Server conversation reads expose the latest 2,000 messages; authorized server export includes full retained message history. Microsoft presence is not synchronized; an authenticated account is not displayed as proof of Teams availability. Microsoft views have bounded pagination and exports include loaded records only. Search is over loaded records, not the complete Microsoft tenant. Client unread counts, bookmarks and favorites are local conveniences, not Teams read receipts or synchronized Microsoft preferences.

There is no native Teams wire-protocol compatibility, Teams-to-Veyra federation, SFU, PSTN, transcription, server-side recording, eDiscovery, legal hold, retention engine, malware scanning, enforced storage quotas, email verification, account recovery, organization administration or tenant-grade identity provisioning. Veyra’s notes/boards are not Teams Loop/Whiteboard documents. Microsoft channel file uploads are intentionally rejected rather than guessing the channel’s SharePoint access rules.

Review **SECURITY.md** before exposing the service. WebRTC transport encryption is not a claim of application-managed end-to-end encryption or encrypted-at-rest storage. SQLite and uploaded files are readable by the server operator. Backups, monitoring, quotas, deployment hardening and security review remain operational requirements.

## License

Original Veyra source: MIT; see LICENSE. Microsoft and other upstream SDKs retain their own licenses and service terms. Product names identify the interoperability targets and do not imply affiliation.
