// Explicit migration: remove only the Access app previously created for this workspace.
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const token = (
  process.env.DRAW_CF_TOKEN_FILE
    ? readFileSync(process.env.DRAW_CF_TOKEN_FILE, "utf8")
    : process.env.CLOUDFLARE_API_TOKEN
)?.trim();
if (!token)
  throw new Error(
    "A Cloudflare API token is required to remove the old Access app.",
  );
const stateFile = path.join(os.homedir(), ".config/excalidraw/deployment.json");
const state = JSON.parse(readFileSync(stateFile, "utf8"));
if (state.hostname !== "draw.ryanlatimer.dev")
  throw new Error("Unexpected deployment hostname.");
// Check that origin authentication works before removing the external gate.
const health = await fetch("http://127.0.0.1:3100/healthz");
const anonymous = await fetch("http://127.0.0.1:3100/api/me");
const login = await fetch("http://127.0.0.1:3100/auth/login", {
  redirect: "manual",
});
const metadata = await (
  await fetch("http://127.0.0.1:3100/.well-known/oauth-authorization-server")
).json();
if (
  !health.ok ||
  anonymous.status !== 401 ||
  login.status !== 302 ||
  !login.headers
    .get("location")
    ?.startsWith("https://draw.ryanlatimer.dev/authorize?") ||
  metadata.issuer !== "https://draw.ryanlatimer.dev"
)
  throw new Error(
    "OpenAuth is not ready at the origin; Cloudflare Access was kept.",
  );
if (state.accessAppId) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${state.accountId}/access/apps/${state.accessAppId}`;
  const headers = { Authorization: `Bearer ${token}` };
  const lookup = await fetch(endpoint, { headers });
  if (lookup.status !== 404) {
    const details = await lookup.json();
    if (
      !details.success ||
      details.result.domain !== state.hostname ||
      details.result.name !== "Ryan's Excalidraw"
    )
      throw new Error("Access app does not match this workspace.");
    const result = await (
      await fetch(endpoint, { method: "DELETE", headers })
    ).json();
    if (!result.success)
      throw new Error(
        `Access removal failed: ${JSON.stringify(result.errors)}`,
      );
  }
  state.retiredAccessAppId = state.accessAppId;
  for (const key of ["accessAppId", "policyId", "teamDomain", "audience"])
    delete state[key];
}
state.authentication = "openauth";
writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", {
  mode: 0o600,
});
console.log(
  "Removed the Excalidraw Cloudflare Access app; the tunnel and DNS remain. OpenAuth now protects the workspace.",
);
