import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const home = os.homedir();
const here = path.dirname(fileURLToPath(import.meta.url));
const unitDir = path.join(home, ".config/systemd/user");
mkdirSync(unitDir, { recursive: true });
mkdirSync(path.join(home, ".local/share/excalidraw"), {
  recursive: true,
  mode: 0o700,
});
const hardening =
  "NoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=%h/.local/share/excalidraw\nUMask=0077\n";
const units = {
  "excalidraw.service": `[Unit]
Description=Private Excalidraw workspace
After=network-online.target
ConditionPathExists=%h/.config/excalidraw/workspace.env

[Service]
Type=simple
WorkingDirectory=${here}
EnvironmentFile=%h/.config/excalidraw/workspace.env
ExecStart=${process.execPath} ${here}/server.mjs
Restart=on-failure
RestartSec=5
${hardening}
[Install]
WantedBy=default.target
`,
  "excalidraw-tunnel.service": `[Unit]
Description=Cloudflare Tunnel for draw.ryanlatimer.dev
After=network-online.target excalidraw.service
Wants=excalidraw.service
ConditionPathExists=%h/.config/excalidraw/tunnel.token

[Service]
Type=simple
ExecStart=%h/.local/bin/cloudflared tunnel --no-autoupdate run --token-file %h/.config/excalidraw/tunnel.token
Restart=on-failure
RestartSec=5
${hardening}
[Install]
WantedBy=default.target
`,
  "excalidraw-backup.service": `[Unit]
Description=Back up Excalidraw SQLite database
ConditionPathExists=%h/.local/share/excalidraw/workspace.sqlite

[Service]
Type=oneshot
EnvironmentFile=%h/.config/excalidraw/workspace.env
ExecStart=${process.execPath} ${here}/backup.mjs
${hardening}
`,
  "excalidraw-backup.timer": `[Unit]
Description=Daily Excalidraw backup (14 retained)

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
`,
};
for (const [name, contents] of Object.entries(units))
  writeFileSync(path.join(unitDir, name), contents);
console.log(
  `Installed ${Object.keys(units).join(
    ", ",
  )} in ${unitDir}. Run systemctl --user daemon-reload, then enable --now after provisioning.`,
);
