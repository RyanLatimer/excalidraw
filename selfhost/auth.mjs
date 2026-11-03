import { createPublicKey, verify } from "node:crypto";

// Validate the Access JWT at the origin too. The email header alone is forgeable.
export function accessVerifier({
  teamDomain,
  audience,
  allowedEmails,
  fetchKeys = fetch,
}) {
  if (
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain || "") ||
    !audience ||
    !allowedEmails?.length
  ) {
    throw new Error(
      "Configure DRAW_ACCESS_TEAM_DOMAIN, DRAW_ACCESS_AUD, and DRAW_ALLOWED_EMAILS before starting.",
    );
  }
  let keys = [];
  let expires = 0;
  return async (request) => {
    try {
      const token = request.headers["cf-access-jwt-assertion"];
      if (typeof token !== "string" || token.length > 16384) return null;
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      const header = JSON.parse(Buffer.from(parts[0], "base64url"));
      const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
      if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
      const now = Date.now() / 1000;
      if (
        claims.iss !== `https://${teamDomain}` ||
        typeof claims.exp !== "number" ||
        claims.exp <= now ||
        (claims.nbf && claims.nbf > now + 30) ||
        ![claims.aud].flat().includes(audience)
      )
        return null;
      if (expires < Date.now()) {
        const response = await fetchKeys(
          `https://${teamDomain}/cdn-cgi/access/certs`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (!response.ok) return null;
        keys = (await response.json()).keys;
        expires = Date.now() + 300000;
      }
      const jwk = keys.find((key) => key.kid === header.kid);
      if (
        !jwk ||
        !verify(
          "RSA-SHA256",
          Buffer.from(`${parts[0]}.${parts[1]}`),
          createPublicKey({ key: jwk, format: "jwk" }),
          Buffer.from(parts[2], "base64url"),
        )
      )
        return null;
      const email = claims.email?.toLowerCase();
      return allowedEmails.includes(email) ? { email } : null;
    } catch {
      return null;
    }
  };
}
