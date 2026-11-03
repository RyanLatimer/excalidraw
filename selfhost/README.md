# Private Excalidraw workspace

This fork adds a self-hosted multi-document workspace to the upstream Excalidraw editor. Production target: **https://draw.ryanlatimer.dev** on Ryan's Linux host, served through Cloudflare Tunnel.

## Features

- Dashboard with preview cards or list view, quick search, sorting, and pinned drawings.
- Collections, document rename/duplicate/move, import/export `.excalidraw`, and recoverable trash.
- The actual upstream drawing editor, including image import, undo/redo, and PNG/SVG export.
- Collapsible in-editor scene navigator with collection filters, search (`Ctrl/Cmd+P`), and direct drawing switching that flushes saves before navigation.
- SQLite storage for drawings and embedded image files. Automatically saves to the server across devices; a clean open editor checks for remote updates every ten seconds.
- IndexedDB drafts while offline. Saves run sequentially; stale revisions are rejected rather than overwriting another tab/device. Conflicting drafts can become a recovered copy.
- Cloudflare Access email sign-in with an owner allowlist. The origin independently verifies JWT signature, issuer, audience, expiration, and owner email. It binds to loopback and rejects cross-origin writes.
- Last 20 scene revisions retained in SQLite; daily consistent database backups retain 14 copies. Local backups are on this machine, not off-site.
- Light/dark themes and mobile navigation.

The dashboard recreates the publicly visible Excalidraw Plus layout, colors, typeface, collection sidebar and document menus; the editor comes directly from the MIT-licensed upstream source. This does not include Plus's proprietary source or subscriptions. Full pixel parity with the current signed-in Plus app has not been verified. Team collaboration, public sharing, voice, comments, presentations, and paid AI services are outside this multi-document implementation.

Public UI references: [Excalidraw Plus overview](https://plus.excalidraw.com/excalidraw-for-teams), [published dashboard screenshot](https://gdm-catalog-fmapi-prod.imgix.net/ProductScreenshot/9021b9fb-606a-48e6-ba0a-5d0878ebd435.png). Original license and font licenses remain in the repository.

## Build and verify

Use Node **24.10+** (Node 26.13.0 tested), Corepack, and Yarn 1.22.22. Node's built-in SQLite API is required.

```sh
corepack yarn install --frozen-lockfile
corepack yarn selfhost:typecheck
corepack yarn selfhost:test
corepack yarn selfhost:build
corepack yarn selfhost:test:browser
```

Browser checks use the repository's Playwright. Install its Chromium or set `DRAW_CHROMIUM` to an already installed compatible Chrome executable. Tests create disposable databases, independently of production data.

Local development, in separate terminals:

```sh
DRAW_DEV_AUTH=1 node selfhost/server.mjs
corepack yarn selfhost:dev
```

Open `http://127.0.0.1:3101`. Development authentication is loopback-only and forbidden with `NODE_ENV=production`. Never point a tunnel at a development instance.

## Cloudflare deployment

Provisioning needs a Cloudflare API token for the account/zone containing `ryanlatimer.dev`:

- Zone: **DNS Edit**, **Zone Read**, scoped to `ryanlatimer.dev`.
- Account: **Cloudflare Tunnel Edit**, **Access: Apps and Policies Edit**, **Access: Organizations, Identity Providers, and Groups Edit**.

Use a private credential file, outside the checkout. Its contents are never printed or put in Git. Set the owner email explicitly:

```sh
DRAW_CF_TOKEN_FILE=/private/path/to/token DRAW_OWNER_EMAIL=you@example.com node selfhost/provision-cloudflare.mjs
node selfhost/install-services.mjs
systemctl --user daemon-reload
systemctl --user enable --now excalidraw.service excalidraw-tunnel.service excalidraw-backup.timer
```

The provisioner discovers the correct zone and account, sets up email PIN sign-in, an owner-only Access policy, a remote tunnel, and a proxied CNAME. It saves resource IDs for retries. Existing unrelated DNS records, tunnel names, or Access apps cause it to stop for inspection. If Cloudflare Zero Trust is not yet enabled, the account may need its initial free-plan onboarding in the dashboard before its organization API is available.

Files created outside Git:

| Path | Purpose |
| --- | --- |
| `~/.config/excalidraw/workspace.env` | Production origin and Access verification settings |
| `~/.config/excalidraw/tunnel.token` | Private connector token, mode 0600 |
| `~/.config/excalidraw/deployment.json` | Cloudflare resource IDs for retries |
| `~/.local/share/excalidraw/workspace.sqlite` | Production drawings, revisions and images |
| `~/.local/share/excalidraw/backups/` | Daily SQLite snapshots |
| `~/.config/systemd/user/excalidraw*.service` | App, tunnel and backup services |

All origins are private; the Access app must be configured before the service starts. A raw email header cannot authenticate a request. `/healthz` is the only unauthenticated endpoint and contains no data. Do not add Cloudflare cache rules that bypass authentication for this hostname.

The host must be running and online for the tunnel and cross-device saves to work. User services start after reboot if lingering is enabled (`loginctl show-user "$USER" -p Linger`; already enabled on Ryan's machine).

## Operations and updates

```sh
systemctl --user status excalidraw excalidraw-tunnel excalidraw-backup.timer
journalctl --user -u excalidraw -u excalidraw-tunnel --since today
systemctl --user start excalidraw-backup.service
```

An unauthenticated visit to the production URL should redirect to Cloudflare Access. Direct unauthenticated requests to port 3100 should return 401 for the UI/API; `/healthz` returns 200. After signing in, create a drawing, reopen it from another device, and verify the same scene appears.

To update code, build and run tests before `systemctl --user restart excalidraw.service`. Keep the previous source commit available for rollback. Production data is independent of Git checkouts.

To restore a backup: stop `excalidraw.service`, keep a copy of the current database and its `-wal`/`-shm` files, replace the database with a chosen snapshot, remove the old `-wal`/`-shm` files, and start the service. Do not restore while the app is running. Copy backups to a separate machine/storage location for protection against disk failure.

For upstream changes, fetch `upstream` and merge `upstream/master` into the fork's `master`, then repeat verification. The upstream app is retained; self-hosting additions are isolated under `selfhost/`.
