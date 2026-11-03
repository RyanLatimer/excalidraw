# Private Excalidraw workspace

This fork adds a self-hosted multi-document workspace to the upstream Excalidraw editor. Production target: **https://draw.ryanlatimer.dev** on Ryan's Linux host, served through Cloudflare Tunnel.

## Features

- Dashboard with preview cards or list view, quick search, sorting, and pinned drawings.
- Collections, document rename/duplicate/move, import/export `.excalidraw`, and recoverable trash.
- The actual upstream drawing editor, including image import, undo/redo, and PNG/SVG export.
- Collapsible in-editor scene navigator with collection filters, search (`Ctrl/Cmd+P`), and direct drawing switching that flushes saves before navigation.
- SQLite storage for drawings and embedded image files. Automatically saves to the server across devices; a clean open editor checks for remote updates every ten seconds.
- IndexedDB drafts while offline. Saves run sequentially; stale revisions are rejected rather than overwriting another tab/device. Conflicting drafts can become a recovered copy.
- OpenAuth email/password sign-in for one preconfigured owner. Registration and email reset are disabled. Passwords use OpenAuth’s salted scrypt hashing; OAuth code exchange uses PKCE and state validation. Secure, HttpOnly session cookies contain an opaque identifier; tokens and signing keys stay in SQLite. Sessions last seven days, survive restarts, and refresh short-lived access tokens. The origin binds to loopback and rejects cross-origin writes.
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
- Account: **Cloudflare Tunnel Edit**. Cloudflare Access is not used. Migrating an existing Access deployment additionally needs **Access: Apps and Policies Edit** to delete only its old Access app.

Use a private credential file, outside the checkout. Its contents are never printed or put in Git. Set the owner email explicitly:

```sh
DRAW_CF_TOKEN_FILE=/private/path/to/token DRAW_OWNER_EMAIL=you@example.com node selfhost/provision-cloudflare.mjs
DRAW_DATABASE="$HOME/.local/share/excalidraw/workspace.sqlite" DRAW_OWNER_EMAIL=you@example.com DRAW_PASSWORD_FILE=/private/path/to/password node selfhost/set-owner-password.mjs
node selfhost/install-services.mjs
systemctl --user daemon-reload
systemctl --user enable --now excalidraw.service excalidraw-tunnel.service excalidraw-backup.timer
```

The provisioner configures only the tunnel and proxied CNAME, saving resource IDs for retries. OpenAuth runs inside the app on the same hostname; it needs no separate service or mail provider. Seed a password before starting: the app refuses to start without the configured owner's hash. Keep the private password file outside Git, and remove it after setup.

To migrate this fork's original Cloudflare Access deployment, build and test first, seed the owner's password, replace the old Access environment settings with `DRAW_AUTH=openauth` and `DRAW_OWNER_EMAIL=you@example.com`, and restart the app. Then run:

```sh
DRAW_CF_TOKEN_FILE=/private/path/to/token node selfhost/remove-cloudflare-access.mjs
```

That migration checks that OpenAuth is running and unauthenticated API requests are rejected before it deletes the specific Access app previously created for this workspace. It leaves the tunnel and shared Cloudflare organization/identity providers in place.

Files created outside Git:

| Path | Purpose |
| --- | --- |
| `~/.config/excalidraw/workspace.env` | Production origin and OpenAuth owner settings |
| `~/.config/excalidraw/tunnel.token` | Private connector token, mode 0600 |
| `~/.config/excalidraw/deployment.json` | Cloudflare resource IDs for retries |
| `~/.local/share/excalidraw/workspace.sqlite` | Drawings, images, OpenAuth password hash, keys and sessions |
| `~/.local/share/excalidraw/backups/` | Daily SQLite snapshots |
| `~/.config/systemd/user/excalidraw*.service` | App, tunnel and backup services |

The workspace requires an OpenAuth session at the origin. Cloudflare Access headers are ignored. Login/OAuth endpoints and `/healthz` are public; all drawings, images and app assets require a valid owner session. Authentication state is included in the existing database backups. Do not add Cloudflare cache rules that cache private responses for this hostname.

The host must be running and online for the tunnel and cross-device saves to work. User services start after reboot if lingering is enabled (`loginctl show-user "$USER" -p Linger`; already enabled on Ryan's machine).

## Operations and updates

```sh
systemctl --user status excalidraw excalidraw-tunnel excalidraw-backup.timer
journalctl --user -u excalidraw -u excalidraw-tunnel --since today
systemctl --user start excalidraw-backup.service
```

An unauthenticated visit redirects to the same-host OpenAuth email/password form. Direct unauthenticated API requests to port 3100 return 401; the UI redirects to sign-in, and `/healthz` returns 200. After signing in, create a drawing, reopen it from another device, and verify the same scene appears.

To change/reset the password, run `selfhost/set-owner-password.mjs` with `DRAW_DATABASE`, `DRAW_OWNER_EMAIL`, and `DRAW_PASSWORD_FILE`. The file must contain the exact password (12–1024 characters). The command stores a new salted hash and revokes current sessions; it never prints the password. Public registration and email-based password reset routes remain disabled.

To update code, build and run tests before `systemctl --user restart excalidraw.service`. Keep the previous source commit available for rollback. Production data is independent of Git checkouts.

To restore a backup: stop `excalidraw.service`, keep a copy of the current database and its `-wal`/`-shm` files, replace the database with a chosen snapshot, remove the old `-wal`/`-shm` files, and start the service. Do not restore while the app is running. Copy backups to a separate machine/storage location for protection against disk failure.

For upstream changes, fetch `upstream` and merge `upstream/master` into the fork's `master`, then repeat verification. The upstream app is retained; self-hosting additions are isolated under `selfhost/`.
