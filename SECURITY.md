# Security and deployment boundaries

This source includes defensive controls; it has not undergone an independent security audit. Do not expose an unconfigured development installation to the public Internet.

## Implemented controls

- Passwords are salted and hashed with scrypt; session cookies are high-entropy, HttpOnly, SameSite=Strict, and Secure when PUBLIC_ORIGIN uses HTTPS. Only a hash of the session secret is stored.
- Unsafe API methods require the exact configured Origin. API authentication, membership, ownership, payload bounds and canonical attachment identities are checked server-side.
- Signaling peer IDs must be bound to the current authenticated live session. RTC targets must be members of the same actual call. Caller-supplied user names/identities cannot override the server identity.
- Files are stored outside the web root, downloaded only after room authorization, and served as attachments with sandbox/nosniff headers. User filenames are not filesystem paths.
- HTML rendering escapes user content. Graph HTML is converted into text before rendering. Graph URLs and next links are host-restricted before token acquisition; attachment URLs do not receive bearer tokens.
- The server applies CSP, request/connection limits, bounded request bodies, message/geometry limits, authentication throttling and additional token issuance limits.
- Secrets, password hashes, session hashes and Microsoft SDK caches are excluded from workspace export and public configuration.

## Required operational work

Use HTTPS, an exact PUBLIC_ORIGIN, a persistent non-public data directory, restricted filesystem permissions, secure backup/restore, monitoring and an explicit registration policy. Disable open registration once controlled onboarding is complete. Email ownership is not verified; all registered accounts join the installation-wide General channel and can see the installation directory. This is not multi-tenant SaaS isolation.

There is no password reset/email confirmation flow, 2FA, administrative account lifecycle, antivirus scanning, enforced disk quota, DLP, retention/legal hold, eDiscovery, tenant provisioning or enterprise SSO validation in the local server. These require deployment-specific implementation and security review. Microsoft client-side sign-in does not automatically validate a Veyra backend identity.

SQLite and uploads are not encrypted at rest by the application. The server operator can read stored messages, documents and files. WebRTC uses its transport protections, but Veyra does not implement an independently managed end-to-end encryption system.

Review the optional CDN dependency policy. For a controlled deployment, bundle reviewed SDK versions, retain licenses, generate/commit a dependency lockfile through an approved registry, narrow CSP/network destinations to the enabled services, and monitor upstream security updates. No SDK binary or font file is included in the source archive.

ACS tokens must be treated as capabilities. Protect and rotate resource keys, restrict broker access, monitor token issuance and Azure costs, and apply resource/organization policies. Never put an ACS connection string or a Microsoft application secret in public/config.js, localStorage, screenshots, source control or support logs.

When reporting a security issue, provide a minimal reproduction without credentials, personal messages or production file data. There is no dedicated externally hosted vulnerability intake service included with this source.
