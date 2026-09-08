# Validation scope

The generated TEST-RESULTS.md records the exit status and output of the source check, Node tests and static build performed when packaging this project. Inspect that report rather than assuming every supplied test has passed. Tests are executable and are included so the same checks can be repeated in your environment.

## Version 1.1 validation additions

The v1 packaging reports below remain historical evidence. Current PR checks rerun the core suite and add native-browser acceptance, rather than treating HTTP availability as evidence of working media. `tests/media.test.mjs` and `tests/calls.test.mjs` exercise device failures, permission cancellation races, generation fences, track replacement, screen-share restoration and sanitized call state using explicit unit-test doubles. `tests/browser_calls.py` serves the real static build under a Pages-like `/VeyraWorkspace/` path with native browser persistence, signaling and RTP; it uses Chromium synthetic devices and explicitly injected failure scenarios. GitHub Actions retains reports and screenshots for both success and failure. No physical iPhone capture or live Microsoft session is claimed from those tests.

## What each test proves

- `tests/domain.test.mjs`: validation, safe text/URLs, attachment retry fingerprints, reaction behavior, calendar limits and geometry tessellation. Tessellation tests are not proof of a live GPU pipeline.
- `tests/server.test.mjs`: actual HTTP/SQLite/session operations against an ephemeral server, authorization and room isolation, file bytes, concurrent CAS, idempotency, SSE, authenticated signaling and restart persistence. It does not by itself prove WebRTC media traverses a real network.
- `tests/documents.test.mjs`: production editor-session behavior using an explicit in-memory provider test double.
- `tests/microsoft.test.mjs`: production Graph adapter safeguards using explicit HTTP/MSAL test doubles. It does not contact a live tenant.
- `tests/browser_smoke.py`: actual HTTP-served browser app, native IndexedDB, UI, graphics initialization and real peer connections with browser-generated synthetic media. Requires an environment that allows navigation, storage and media.
- `tests/render_fixture.py`: a separate rendering/component harness for restricted environments. It injects the production modules but replaces storage infrastructure with an in-memory fixture. It must not be presented as proof of native browser persistence, networking, real camera capture or Microsoft integration.

## Not independently validated in this delivery

Live Microsoft account consent, real Graph read/write operations, OneDrive permissions, organization calendar meeting creation, Azure token issuance, actual Teams meeting admission, real device capture, cross-device/NAT traversal and live WebGPU execution require acceptance testing in the target environment. Browser automation restrictions in the build environment may prevent full browser tests; any resulting failure must remain visible in the logs, not be converted into a pass.

No benchmark claim, production SLA, protocol parity claim, security audit certification or full Teams capability claim is made.
