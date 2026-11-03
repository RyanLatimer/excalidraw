// Run only after build/tests. Credentials are read privately, never printed.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const token = (
  process.env.DRAW_CF_TOKEN_FILE
    ? readFileSync(process.env.DRAW_CF_TOKEN_FILE, "utf8")
    : process.env.CLOUDFLARE_API_TOKEN
)?.trim();
const email = process.env.DRAW_OWNER_EMAIL;
if (!token || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
  throw new Error(
    "Set DRAW_CF_TOKEN_FILE (or CLOUDFLARE_API_TOKEN) and DRAW_OWNER_EMAIL.",
  );
const hostname = "draw.ryanlatimer.dev";
const configDir = path.join(os.homedir(), ".config/excalidraw");
mkdirSync(configDir, { recursive: true, mode: 0o700 });
const stateFile = path.join(configDir, "deployment.json");
const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8"))
  : {};
const persist = () =>
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", {
    mode: 0o600,
  });
const privateFile = (name, contents) =>
  writeFileSync(path.join(configDir, name), contents, { mode: 0o600 });
async function cf(route, method = "GET", body, allowMissing = false) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (allowMissing && response.status === 404) return null;
  if (!response.ok || !result.success)
    throw new Error(
      `Cloudflare ${method} ${route}: ${response.status} ${JSON.stringify(
        result.errors,
      )}`,
    );
  return result.result;
}
const zones = await cf("/zones?name=ryanlatimer.dev");
if (zones.length !== 1)
  throw new Error("Token must include the ryanlatimer.dev zone.");
const zone = zones[0];
const accountId = zone.account.id;
const account = `/accounts/${accountId}`;
// Check access and DNS reads before creating resources.
const [records, apps, providers, tunnels] = await Promise.all([
  cf(`/zones/${zone.id}/dns_records?name=${hostname}`),
  cf(`${account}/access/apps`),
  cf(`${account}/access/identity_providers`),
  cf(`${account}/cfd_tunnel?is_deleted=false`),
]);
let organization = await cf(
  `${account}/access/organizations`,
  "GET",
  undefined,
  true,
);
if (records.length && !state.tunnelId)
  throw new Error(
    "draw.ryanlatimer.dev already has a DNS record; inspect it before continuing.",
  );
if (!organization)
  organization = await cf(`${account}/access/organizations`, "POST", {
    name: "Ryan's workspace",
    auth_domain: "ryanlatimer-draw.cloudflareaccess.com",
  });
let otp = providers.find((provider) => provider.type === "onetimepin");
if (!otp)
  otp = await cf(`${account}/access/identity_providers`, "POST", {
    name: "Email one-time PIN",
    type: "onetimepin",
    config: {},
  });
let app = apps.find((app) => app.id === state.accessAppId);
if (!app) {
  if (apps.some((app) => app.domain === hostname))
    throw new Error(
      "An existing Access app owns this hostname. Inspect it before continuing.",
    );
  app = await cf(`${account}/access/apps`, "POST", {
    name: "Ryan's Excalidraw",
    domain: hostname,
    type: "self_hosted",
    session_duration: "168h",
    allowed_idps: [otp.id],
    auto_redirect_to_identity: true,
    app_launcher_visible: true,
    http_only_cookie_attribute: true,
  });
  state.accessAppId = app.id;
  persist();
}
let policy = (await cf(`${account}/access/apps/${app.id}/policies`)).find(
  (policy) => policy.id === state.policyId,
);
const policyBody = {
  name: "Ryan only",
  decision: "allow",
  include: [{ email: { email } }],
  precedence: 1,
};
if (!policy)
  policy = await cf(
    `${account}/access/apps/${app.id}/policies`,
    "POST",
    policyBody,
  );
else
  policy = await cf(
    `${account}/access/apps/${app.id}/policies/${policy.id}`,
    "PUT",
    policyBody,
  );
state.policyId = policy.id;
persist();
let tunnel = tunnels.find((tunnel) => tunnel.id === state.tunnelId);
if (!tunnel) {
  if (tunnels.some((tunnel) => tunnel.name === "draw-ryanlatimer"))
    throw new Error(
      "A tunnel named draw-ryanlatimer already exists; inspect it before continuing.",
    );
  tunnel = await cf(`${account}/cfd_tunnel`, "POST", {
    name: "draw-ryanlatimer",
    config_src: "cloudflare",
  });
  state.tunnelId = tunnel.id;
  persist();
}
const tunnelToken = await cf(`${account}/cfd_tunnel/${tunnel.id}/token`);
privateFile("tunnel.token", tunnelToken + "\n");
await cf(`${account}/cfd_tunnel/${tunnel.id}/configurations`, "PUT", {
  config: {
    ingress: [
      { hostname, service: "http://127.0.0.1:3100", originRequest: {} },
      { service: "http_status:404" },
    ],
  },
});
const target = `${tunnel.id}.cfargotunnel.com`;
if (
  records.some((record) => record.type !== "CNAME" || record.content !== target)
)
  throw new Error(
    "Existing DNS does not target this tunnel. It was preserved.",
  );
privateFile(
  "workspace.env",
  [
    "NODE_ENV=production",
    "PORT=3100",
    `DRAW_ORIGIN=https://${hostname}`,
    `DRAW_ACCESS_TEAM_DOMAIN=${organization.auth_domain}`,
    `DRAW_ACCESS_AUD=${app.aud}`,
    `DRAW_ALLOWED_EMAILS=${email.toLowerCase()}`,
    `DRAW_DATABASE=${path.join(
      os.homedir(),
      ".local/share/excalidraw/workspace.sqlite",
    )}`,
    "",
  ].join("\n"),
);
state.accountId = accountId;
state.zoneId = zone.id;
state.hostname = hostname;
state.ownerEmail = email;
state.teamDomain = organization.auth_domain;
state.audience = app.aud;
persist();
// Only expose DNS after access policy and origin validation are configured.
if (!records.length) {
  const record = await cf(`/zones/${zone.id}/dns_records`, "POST", {
    type: "CNAME",
    name: hostname,
    content: target,
    proxied: true,
    ttl: 1,
  });
  state.dnsRecordId = record.id;
  persist();
}
console.log(
  `Configured ${hostname}; owner ${email}; tunnel ${tunnel.id}. Credentials saved privately under ${configDir}.`,
);
