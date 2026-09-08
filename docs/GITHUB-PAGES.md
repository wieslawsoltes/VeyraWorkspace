# Veyra Workspace on GitHub Pages

Application: https://wieslawsoltes.github.io/VeyraWorkspace/

Repository: https://github.com/wieslawsoltes/VeyraWorkspace

## Deployment

`.github/workflows/pages.yml` publishes the browser client on each push to `main`, or through the workflow's manual dispatch. The build uses Node.js 22, verifies the original release manifest, checks JavaScript imports, runs the domain/server/adapter tests, and builds `dist/`. No package installation is required for these tasks.

Only `dist/` is uploaded to Pages. The SQLite server, server-side secrets, tests, and project source outside `public/` are not deployed as web assets. A generated `build-info.json` identifies the exact deployed commit and workflow run. After deployment, the workflow checks this identity and requests the HTML, JavaScript, CSS, and authentication redirect page over HTTPS. These HTTP checks are not browser, GPU, media, or live Microsoft integration tests.

Application assets, ES modules, worker URLs, and the manifest use project-relative paths; deployment at `/VeyraWorkspace/` does not require a bundler or root-domain hosting.

## What works on static hosting

The device-local sample workspace and its browser-local features run without a server. Microsoft Graph operations require the application's Microsoft configuration, an eligible account, and the required consent. See [MICROSOFT.md](MICROSOFT.md) for implemented operations and boundaries.

GitHub Pages does not run the Node.js collaboration service. Live Veyra messaging, authenticated server sessions, server file storage, signaling, and the ACS token broker require hosting the supplied Node server separately. The current server client uses same-origin `./api/` routes: use the application served by that Node deployment, or configure an HTTPS reverse proxy that serves both the client and API on one origin. Entering an arbitrary remote API URL in the Pages client is not implemented. Do not switch to live Veyra mode on Pages and expect a backend to exist.

## Microsoft sign-in for this Pages URL

Register this exact redirect URI as a Single-page application URI in your Microsoft Entra application:

```text
https://wieslawsoltes.github.io/VeyraWorkspace/auth.html
```

Enter the public application client ID and tenant choice in Veyra Settings. No Microsoft registration, tenant consent, Azure resource, or secret is created by this GitHub deployment. Never place client secrets, ACS resource keys, or TURN shared secrets in `public/`, repository files, or browser settings. Meeting interoperability additionally requires the separately hosted authenticated token broker described in the project documentation.

## Source integrity

The initial import preserves the original delivered source files. `MANIFEST.sha256` records their SHA-256 hashes. When intentionally changing a tracked source file, update its corresponding manifest entry in the same commit; the Pages build rejects mismatched files. Pages-specific workflow and hosting documentation are additional repository files.

The temporary source-import workflow and payload are removed from the current branch after import. Normal future deployments use the checked-in source directly.
