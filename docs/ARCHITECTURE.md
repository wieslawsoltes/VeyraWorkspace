# Architecture and invariants

## Three providers, not one fictional network

`LocalProvider` uses IndexedDB transactions for durable browser-local data and BroadcastChannel for actual same-origin peers. It seeds once, atomically, including real file bytes. Fictional sample people have explicit sample labels and do not generate online presence or replies.

`ServerProvider` uses cookie-authenticated REST writes and authenticated SSE. A unique peer ID represents one live browser connection, not a user identity. Signaling waits for the server's ready event, avoiding the join-before-registration race. Reconnect refreshes the active message window; SSE is not an exactly-once persistent event log.

`MicrosoftProvider` uses a documented delegated Graph boundary and optional official client SDKs. It does not reuse Veyra room IDs as Graph IDs. Authentication, scopes, tenant service eligibility and feature capabilities remain explicit. Notes/boards are not exposed as Microsoft resources.

The application guards asynchronous navigation with generation numbers and captures provider identities for pending operations. Switching providers tears down document sessions, event streams, calls and rendering resources. Binary uploads and message retry IDs are retained separately from mutable display metadata.

## Durable messages

SQLite runs in WAL mode with foreign keys and a busy timeout. A message's persistent ID, canonical author, room, content, reply target and attachment identities form its retry identity. Repeating the same authorized ID/payload is idempotent; substituting another payload or author fails. Attachment metadata is taken from authorized server records, not trusted from the browser. Message editing does not rewrite the original creation fingerprint.

Room membership is checked for reads, writes, file downloads, documents, calendar visibility and signaling. Message author identity is immutable. Deletion is soft and prohibits editing/reactions from reviving the message. SQL uses parameterized values rather than interpolated client input.

The live history query is bounded to 2,000 recent messages. The UI initially displays a smaller window and expands it explicitly. Full server export is separately authorized. This implementation does not claim unlimited history pagination or server-wide full-text indexing.

## Editor concurrency

A document is a typed value plus a monotonically increasing integer version. Compare-and-swap reads and updates occur inside a single SQLite transaction **after** the asynchronous body read, so concurrent requests cannot both commit the same base revision.

The editor serializes saves, retains a local recovery draft before network writes, and records edits made while a save is in flight. A remote change to a dirty document is a visible conflict, not a silent overwrite. The user can export the draft or explicitly reload the server state. There is no automatic merge, operation transform or CRDT claim.

## Graphics

The whiteboard tessellates domain shapes into a triangle-list Float32 vertex stream. Each vertex contains position and RGBA; the pipeline uses camera uniforms rather than rewriting geometry for pan/zoom. Capacity-rounded buffers are reused, uploads are driven by scene changes, and rendering is demand-driven. A four-sample antialiasing target resolves into the presentation texture. Device loss/unavailability selects a Canvas 2D backend.

Sticky-note text remains a DOM overlay. Chat text is not sent through an untested GPU text renderer. Geometry, interaction, document state and accessible text remain separate responsibilities. The renderer has explicit buffer/texture/observer/RAF teardown.

## Veyra calls

A call uses real RTCPeerConnection objects and authenticated signaling, with at most eight participants. The peer engine uses transceivers, per-peer signaling queues, deterministic polite-peer selection, negotiation collision handling, deferred ICE candidates, reconnection and bounded ICE restarts. Presence and connection status come from actual peers and events.

Camera/microphone capture happens only after the user joins or explicitly enables a device. Receive-only joining does not request capture. Screen sharing replaces the outgoing video track and restores the camera afterwards. Leaving stops locally acquired tracks and closes peer connections. Statistics are derived from `getStats`, not random counters. Self recording records only the local source; remote recording is not silently performed.

TURN is an operational dependency for networks that do not permit direct paths. There is no SFU, media server, PSTN bridge, or application-layer end-to-end key-management protocol.
