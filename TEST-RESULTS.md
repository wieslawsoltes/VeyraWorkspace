# Veyra release validation

Generated: 2026-09-08T13:45:42.395035+00:00

These are actual command results. A non-zero exit status is a failed check and must not be described as passed.

| Check | Exit status | Result |
|---|---:|---|
| Source syntax and import check | 0 | PASS |
| Node domain/server/adapter tests | 0 | PASS |
| Static client build | 0 | PASS |

## Source syntax and import check

Command: `npm run check`

```text

> veyra-workspace@1.0.0 check
> node scripts/check.mjs

Checked 22 JavaScript modules and their relative imports.
```

## Node domain/server/adapter tests

Command: `npm test`

```text

> veyra-workspace@1.0.0 test
> node --experimental-sqlite --test tests/*.test.mjs

TAP version 13
# Subtest: document edits are saved through revision-checked snapshots
ok 1 - document edits are saved through revision-checked snapshots
  ---
  duration_ms: 3.907787
  type: 'test'
  ...
# Subtest: a stale document save conflicts and retains the local recovery draft
ok 2 - a stale document save conflicts and retains the local recovery draft
  ---
  duration_ms: 0.51056
  type: 'test'
  ...
# Subtest: explicit reload discards a conflicting draft and adopts the server revision
ok 3 - explicit reload discards a conflicting draft and adopts the server revision
  ---
  duration_ms: 0.482819
  type: 'test'
  ...
# Subtest: text is escaped before limited markup is rendered
ok 4 - text is escaped before limited markup is rendered
  ---
  duration_ms: 1.509027
  type: 'test'
  ...
# Subtest: unsafe and credential-bearing URLs are rejected
ok 5 - unsafe and credential-bearing URLs are rejected
  ---
  duration_ms: 0.23164
  type: 'test'
  ...
# Subtest: messages validate ids and normalize content
ok 6 - messages validate ids and normalize content
  ---
  duration_ms: 2.596027
  type: 'test'
  ...
# Subtest: attachment list limits and shape are enforced
ok 7 - attachment list limits and shape are enforced
  ---
  duration_ms: 0.307855
  type: 'test'
  ...
# Subtest: idempotency excludes transient attachment metadata
ok 8 - idempotency excludes transient attachment metadata
  ---
  duration_ms: 0.320063
  type: 'test'
  ...
# Subtest: reaction toggles are reversible and users are unique
ok 9 - reaction toggles are reversible and users are unique
  ---
  duration_ms: 0.491802
  type: 'test'
  ...
# Subtest: document validation rejects non-finite geometry and excessive revisions
ok 10 - document validation rejects non-finite geometry and excessive revisions
  ---
  duration_ms: 1.539302
  type: 'test'
  ...
# Subtest: calendar boundaries and external URLs are validated
ok 11 - calendar boundaries and external URLs are validated
  ---
  duration_ms: 0.72263
  type: 'test'
  ...
# Subtest: every seeded shape tessellates to finite triangle vertices
ok 12 - every seeded shape tessellates to finite triangle vertices
  ---
  duration_ms: 1.744672
  type: 'test'
  ...
# Subtest: all drawing primitives including degenerate strokes tessellate
ok 13 - all drawing primitives including degenerate strokes tessellate
  ---
  duration_ms: 2.009272
  type: 'test'
  ...
# Subtest: sample files contain real readable bytes and sample ids are stable
ok 14 - sample files contain real readable bytes and sample ids are stable
  ---
  duration_ms: 1.494495
  type: 'test'
  ...
# Subtest: Graph requests reject untrusted hosts before token acquisition
ok 15 - Graph requests reject untrusted hosts before token acquisition
  ---
  duration_ms: 3.842247
  type: 'test'
  ...
# Subtest: Graph mutation requests are never retried automatically
ok 16 - Graph mutation requests are never retried automatically
  ---
  duration_ms: 24.176626
  type: 'test'
  ...
# Subtest: Graph retry handles throttled GET only
ok 17 - Graph retry handles throttled GET only
  ---
  duration_ms: 667.810062
  type: 'test'
  ...
# Subtest: Graph nextLink host validation prevents bearer-token exfiltration
ok 18 - Graph nextLink host validation prevents bearer-token exfiltration
  ---
  duration_ms: 1.041301
  type: 'test'
  ...
# Subtest: consumer sign-in never calls unsupported Teams chat endpoints
ok 19 - consumer sign-in never calls unsupported Teams chat endpoints
  ---
  duration_ms: 1.006279
  type: 'test'
  ...
# Subtest: Graph message identities stay distinct across conversations
ok 20 - Graph message identities stay distinct across conversations
  ---
  duration_ms: 0.55636
  type: 'test'
  ...
# Subtest: calendar edits PATCH the existing Graph id instead of duplicating events
ok 21 - calendar edits PATCH the existing Graph id instead of duplicating events
  ---
  duration_ms: 1.609007
  type: 'test'
  ...
# Subtest: Microsoft export includes no access tokens or MSAL account cache
ok 22 - Microsoft export includes no access tokens or MSAL account cache
  ---
  duration_ms: 0.465702
  type: 'test'
  ...
# (node:3526) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: authenticated collaboration server
    # Subtest: health is public; bootstrap requires a session
    ok 1 - health is public; bootstrap requires a session
      ---
      duration_ms: 26.283029
      type: 'test'
      ...
    # Subtest: registration creates independent users and hardened cookies
    ok 2 - registration creates independent users and hardened cookies
      ---
      duration_ms: 261.157692
      type: 'test'
      ...
    # Subtest: CSRF origin and weak-password checks
    ok 3 - CSRF origin and weak-password checks
      ---
      duration_ms: 5.552408
      type: 'test'
      ...
    # Subtest: General is installation-wide; private rooms are not
    ok 4 - General is installation-wide; private rooms are not
      ---
      duration_ms: 13.901566
      type: 'test'
      ...
    # Subtest: malformed members and oversized JSON are rejected
    ok 5 - malformed members and oversized JSON are rejected
      ---
      duration_ms: 7.25043
      type: 'test'
      ...
    # Subtest: send is durable and retry-idempotent; payload substitution is rejected
    ok 6 - send is durable and retry-idempotent; payload substitution is rejected
      ---
      duration_ms: 5.67265
      type: 'test'
      ...
    # Subtest: membership cannot be bypassed by send, upload, or document APIs
    ok 7 - membership cannot be bypassed by send, upload, or document APIs
      ---
      duration_ms: 6.731207
      type: 'test'
      ...
    # Subtest: only the message author can edit or delete
    ok 8 - only the message author can edit or delete
      ---
      duration_ms: 4.108279
      type: 'test'
      ...
    # Subtest: replies must target the same conversation
    ok 9 - replies must target the same conversation
      ---
      duration_ms: 4.057693
      type: 'test'
      ...
    # Subtest: simultaneous reactions are not lost
    ok 10 - simultaneous reactions are not lost
      ---
      duration_ms: 5.514221
      type: 'test'
      ...
    # Subtest: uploads preserve bytes and enforce download membership
    ok 11 - uploads preserve bytes and enforce download membership
      ---
      duration_ms: 5.551046
      type: 'test'
      ...
    # Subtest: attachment metadata is canonical and retry identity survives it
    ok 12 - attachment metadata is canonical and retry identity survives it
      ---
      duration_ms: 4.36781
      type: 'test'
      ...
    # Subtest: document compare-and-swap admits exactly one concurrent writer
    ok 13 - document compare-and-swap admits exactly one concurrent writer
      ---
      duration_ms: 8.294445
      type: 'test'
      ...
    # Subtest: whiteboard geometry validation and revisioning are enforced
    ok 14 - whiteboard geometry validation and revisioning are enforced
      ---
      duration_ms: 6.506948
      type: 'test'
      ...
    # Subtest: private calendar events are not leaked or editable by other users
    ok 15 - private calendar events are not leaked or editable by other users
      ---
      duration_ms: 4.491998
      type: 'test'
      ...
    # Subtest: SSE delivers real messages only to room members
    ok 16 - SSE delivers real messages only to room members
      ---
      duration_ms: 182.985248
      type: 'test'
      ...
    # Subtest: call signaling requires an authenticated live peer and real call membership
    ok 17 - call signaling requires an authenticated live peer and real call membership
      ---
      duration_ms: 9.83807
      type: 'test'
      ...
    # Subtest: RTC descriptions are targeted and cannot spoof sender identity
    ok 18 - RTC descriptions are targeted and cannot spoof sender identity
      ---
      duration_ms: 26.321856
      type: 'test'
      ...
    # Subtest: ACS fails explicitly when resource credentials are absent
    ok 19 - ACS fails explicitly when resource credentials are absent
      ---
      duration_ms: 1.894889
      type: 'test'
      ...
    # Subtest: soft deletion cannot be edited or reacted back into existence
    ok 20 - soft deletion cannot be edited or reacted back into existence
      ---
      duration_ms: 4.153407
      type: 'test'
      ...
    # Subtest: export is membership-filtered and excludes credentials
    ok 21 - export is membership-filtered and excludes credentials
      ---
      duration_ms: 1.780086
      type: 'test'
      ...
    # Subtest: static files have defensive headers and data files are not served
    ok 22 - static files have defensive headers and data files are not served
      ---
      duration_ms: 3.633743
      type: 'test'
      ...
    # Subtest: logout revokes the session immediately
    ok 23 - logout revokes the session immediately
      ---
      duration_ms: 2.768998
      type: 'test'
      ...
    # Subtest: SQLite history survives a server restart
    ok 24 - SQLite history survives a server restart
      ---
      duration_ms: 14.302451
      type: 'test'
      ...
    1..24
ok 23 - authenticated collaboration server
  ---
  duration_ms: 629.143163
  type: 'test'
  ...
1..23
# tests 47
# suites 0
# pass 47
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 773.600676
```

## Static client build

Command: `npm run build`

```text

> veyra-workspace@1.0.0 build
> node scripts/build.mjs

Built dist/: 18 files, 250687 bytes. Static hosting supports device-local work and configured Microsoft APIs, not the Node collaboration server.
```

## Browser and Microsoft boundaries

Native browser navigation/media can be blocked by environment policy. Component fixtures are not equivalent to a native end-to-end browser pass. No live Microsoft tenant, Entra consent, Graph write, ACS token resource or Teams meeting was independently verified. See VALIDATION.md.

## Component rendering acceptance

Production UI/domain/editor code was exercised with the documented in-memory database fixture. This does not test native IndexedDB, network navigation, camera/microphone capture, WebRTC media transport, or WebGPU.

- PASS: production UI boots with fixture storage
- PASS: composer sends and escapes HTML
- PASS: shared notes autosave
- PASS: Canvas whiteboard drawing and undo/redo
- PASS: calendar creates and displays events
- PASS: mobile layout and navigation

Browser JavaScript errors observed by the component harness: 0.

## Native browser acceptance

Status: NOT PASSED

```text
Page.goto: net::ERR_BLOCKED_BY_ADMINISTRATOR at http://localhost:4173/
Call log:
  - navigating to "http://localhost:4173/", waiting until "networkidle"

```

No successful native browser media, GPU-device, or live Microsoft tenant test is claimed.
