import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { request as browserRequest } from "playwright";
import { ScryptHasher } from "@openauthjs/openauth/provider/password";
import { Storage } from "@openauthjs/openauth/storage/storage";
import { authDatabase } from "./auth-storage.mjs";
import { createPasswordAuth } from "./auth.mjs";
import { createWorkspaceServer } from "./server.mjs";

test("real OpenAuth flow: owner password, PKCE/state, persistent sessions, refresh, logout, allowlist and CSRF", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draw-auth-"));
  const databasePath = path.join(dir, "db.sqlite");
  const origin = "http://127.0.0.1:3103";
  const ownerEmail = "owner@example.com";
  const password = "test-password-for-auth-only";
  const store = authDatabase(databasePath);
  await Storage.set(
    store.storage,
    ["email", ownerEmail, "password"],
    await ScryptHasher().hash(password),
  );
  await Storage.set(
    store.storage,
    ["email", "other@example.com", "password"],
    await ScryptHasher().hash(password),
  );
  await Storage.set(store.storage, ["expired"], "old", -1);
  assert.equal(await Storage.get(store.storage, ["expired"]), undefined);
  store.db.close();
  writeFileSync(path.join(dir, "index.html"), "<html>workspace</html>");
  const make = () =>
    createWorkspaceServer({
      databasePath,
      distPath: dir,
      origin,
      authentication: createPasswordAuth({
        databasePath,
        origin,
        ownerEmail,
        accessSeconds: 1,
      }),
    });
  let server = make();
  await new Promise((resolve) => server.listen(3103, "127.0.0.1", resolve));
  const context = await browserRequest.newContext({ baseURL: origin });
  const anonymous = await browserRequest.newContext({ baseURL: origin });
  async function begin(ctx = context) {
    const result = await ctx.get("/auth/login", { maxRedirects: 5 });
    assert.equal(result.status(), 200);
    assert.match(await result.text(), /Secured by OpenAuth/);
    assert.ok(!/Sign up|Register|Forgot password/.test(await result.text()));
  }
  const login = (email = ownerEmail, pass = password) =>
    context.post("/password/authorize", {
      form: { email, password: pass },
      headers: { Origin: origin },
      maxRedirects: 0,
    });
  try {
    const before = await context.get("/", { maxRedirects: 0 });
    assert.equal(before.status(), 302);
    assert.match(before.headers().location, /^\/auth\/login/);
    assert.equal((await context.get("/api/documents")).status(), 401);
    assert.equal(
      (
        await context.get("/api/me", {
          headers: {
            "Cf-Access-Authenticated-User-Email": ownerEmail,
            "Cf-Access-Jwt-Assertion": "old-cloudflare-token",
          },
        })
      ).status(),
      401,
    );
    const discovery = await (
      await context.get("/.well-known/oauth-authorization-server")
    ).json();
    assert.equal(discovery.issuer, origin);
    assert.equal(discovery.token_endpoint, `${origin}/token`);
    assert.equal(
      (
        await context.get(
          "/authorize?client_id=evil&redirect_uri=https://evil.example/callback&response_type=code",
          { maxRedirects: 0 },
        )
      ).status(),
      400,
    );
    for (const route of ["/password/register", "/password/change"]) {
      assert.equal((await context.get(route)).status(), 404);
      assert.equal(
        (
          await context.post(route, {
            form: {
              action: "register",
              email: "attacker@example.com",
              password,
            },
            headers: { Origin: origin },
          })
        ).status(),
        404,
      );
    }
    await begin();
    assert.equal(
      (
        await context.post("/password/authorize", {
          form: { email: ownerEmail, password },
          headers: { Origin: "https://evil.example" },
        })
      ).status(),
      403,
    );
    const wrong = await login(ownerEmail, "wrong-password");
    assert.match(await wrong.text(), /email or password is incorrect/);
    assert.equal((await context.get("/api/me")).status(), 401);
    const other = await login("other@example.com");
    assert.equal(other.status(), 403);
    assert.equal((await context.get("/api/me")).status(), 401);
    await begin();
    const success = await login();
    assert.equal(success.status(), 302);
    const callback = success.headers().location;
    assert.equal(
      (await anonymous.get(callback, { maxRedirects: 0 })).status(),
      400,
      "callback without flow cookie rejected",
    );
    const wrongState = new URL(callback);
    wrongState.searchParams.set("state", "wrong-state");
    assert.equal(
      (await context.get(wrongState.href, { maxRedirects: 0 })).status(),
      400,
      "callback state mismatch rejected",
    );
    await begin();
    const pkce = await login();
    const code = new URL(pkce.headers().location).searchParams.get("code");
    const exchange = await context.post("/token", {
      form: {
        code,
        client_id: "draw-workspace",
        redirect_uri: `${origin}/auth/callback`,
        grant_type: "authorization_code",
      },
      headers: { Origin: origin },
    });
    assert.equal(exchange.status(), 400, "PKCE verifier required");
    await begin();
    const actual = await login();
    const done = await context.get(actual.headers().location, {
      maxRedirects: 0,
    });
    assert.equal(done.status(), 303);
    assert.equal(done.headers().location, "/");
    assert.match(done.headers()["set-cookie"], /HttpOnly/);
    assert.match(done.headers()["set-cookie"], /SameSite=Lax/);
    assert.deepEqual(await (await context.get("/api/me")).json(), {
      email: ownerEmail,
    });
    assert.equal(
      (
        await context.get(actual.headers().location, { maxRedirects: 0 })
      ).status(),
      400,
      "callback cannot be replayed",
    );
    const drawing = await context.post("/api/documents", {
      data: { title: "Preserved across login" },
      headers: { Origin: origin },
    });
    assert.equal(drawing.status(), 201);
    await new Promise((resolve) => server.close(resolve));
    server = make();
    await new Promise((resolve) => server.listen(3103, "127.0.0.1", resolve));
    assert.equal(
      (await context.get("/api/me")).status(),
      200,
      "session survives process restart",
    );
    assert.equal(
      (await (await context.get("/api/documents")).json())[0].title,
      "Preserved across login",
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(
      (await context.get("/api/me")).status(),
      200,
      "expired access token refreshed",
    );
    assert.equal(
      (
        await context.post("/auth/logout", {
          headers: { Origin: "https://evil.example" },
          maxRedirects: 0,
        })
      ).status(),
      403,
    );
    const savedCookies = await context.storageState();
    assert.equal(
      (
        await context.post("/auth/logout", {
          headers: { Origin: origin },
          maxRedirects: 0,
        })
      ).status(),
      303,
    );
    assert.equal((await context.get("/api/me")).status(), 401);
    const replay = await browserRequest.newContext({
      baseURL: origin,
      storageState: savedCookies,
    });
    assert.equal(
      (await replay.get("/api/me")).status(),
      401,
      "logged-out session cookie cannot be replayed",
    );
    await replay.dispose();
    const sql = new DatabaseSync(databasePath);
    const key = createHash("sha256").update("password:owner").digest("hex");
    sql
      .prepare("INSERT OR REPLACE INTO openauth_limits VALUES (?,100,?)")
      .run(key, Date.now() + 900000);
    assert.equal((await login()).status(), 429);
    assert.ok(
      sql
        .prepare("SELECT value FROM openauth_storage WHERE key=?")
        .get(["email", ownerEmail, "password"].join("\x1f"))
        .value.includes('"salt"'),
    );
    assert.ok(
      !sql
        .prepare("SELECT value FROM openauth_storage WHERE key=?")
        .get(["email", ownerEmail, "password"].join("\x1f"))
        .value.includes(password),
    );
    sql.close();
  } finally {
    await context.dispose();
    await anonymous.dispose();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
