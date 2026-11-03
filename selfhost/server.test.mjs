import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createWorkspaceServer } from "./server.mjs";
import { accessVerifier } from "./auth.mjs";

test("private workspace API: auth, persistence, revision conflicts, images, collections, trash, and CSRF", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "draw-test-"));
  writeFileSync(path.join(dir, "index.html"), "<html>workspace</html>");
  const options = {
    databasePath: path.join(dir, "db.sqlite"),
    distPath: dir,
    origin: "https://draw.test",
    authenticate: async (req) =>
      req.headers.authorization === "test-owner"
        ? { email: "owner@test" }
        : null,
  };
  let server = createWorkspaceServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, method = "GET", body, headers = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        Authorization: "test-owner",
        Origin: "https://draw.test",
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal(
      (await request("/api/documents", "GET", undefined, { Authorization: "" }))
        .status,
      401,
    );
    assert.equal((await fetch(`${base}/drawing/something`)).status, 401);
    assert.equal(
      (
        await request(
          "/api/documents",
          "POST",
          {},
          { Origin: "https://evil.test" },
        )
      ).status,
      403,
    );
    assert.equal((await request("/api/documents", "POST", null)).status, 400);
    const folder = (
      await request("/api/collections", "POST", { name: "Systems" })
    ).body;
    const created = await request("/api/documents", "POST", {
      title: "Network",
      collectionId: folder.id,
    });
    assert.equal(created.status, 201);
    let doc = created.body;
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const scene = {
      ...doc.scene,
      elements: [{ id: "shape", type: "rectangle", x: 2 }],
      files: { image: { dataURL: "data:image/png;base64,abc" } },
    };
    doc = (
      await request(`/api/documents/${doc.id}`, "PATCH", {
        revision: 1,
        scene,
        thumbnail: png,
        pinned: true,
      })
    ).body;
    assert.equal(doc.revision, 2);
    assert.deepEqual(doc.scene.files, scene.files);
    assert.equal(
      (
        await request(`/api/documents/${doc.id}`, "PATCH", {
          revision: 1,
          scene: created.body.scene,
        })
      ).status,
      409,
    );
    assert.equal(
      (await request(`/api/documents/${doc.id}`)).body.scene.elements[0].id,
      "shape",
    );
    const thumbnail = await fetch(`${base}/api/documents/${doc.id}/thumbnail`, {
      headers: { Authorization: "test-owner" },
    });
    assert.equal(thumbnail.headers.get("content-type"), "image/png");
    assert.equal((await thumbnail.arrayBuffer()).byteLength, 8);
    await request(`/api/collections/${folder.id}`, "DELETE");
    doc = (await request(`/api/documents/${doc.id}`)).body;
    assert.equal(doc.collectionId, null);
    assert.equal(doc.revision, 3);
    assert.equal(
      (
        await request(`/api/documents/${doc.id}`, "PATCH", {
          revision: 3,
          deleted: true,
        })
      ).body.deleted,
      1,
    );
    assert.equal(
      (
        await request(`/api/documents/${doc.id}`, "PATCH", {
          revision: 4,
          deleted: false,
        })
      ).body.deleted,
      0,
    );
    await new Promise((resolve) => server.close(resolve));
    server = createWorkspaceServer(options);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const persisted = (await request(`/api/documents/${doc.id}`)).body;
    assert.equal(persisted.title, "Network");
    assert.deepEqual(persisted.scene, scene);
    const backupFile = path.join(dir, "backups");
    const result = spawnSync(process.execPath, ["selfhost/backup.mjs"], {
      env: {
        ...process.env,
        DRAW_DATABASE: options.databasePath,
        DRAW_BACKUPS: backupFile,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const target = result.stdout.trim().replace("Backup saved: ", "");
    const backup = new DatabaseSync(target, { readOnly: true });
    assert.equal(
      backup.prepare("SELECT title FROM documents WHERE id=?").get(doc.id)
        .title,
      "Network",
    );
    assert.ok(
      backup.prepare("SELECT count(*) AS count FROM revisions").get().count > 0,
    );
    backup.close();
    assert.equal((await request("/api/documents")).body.length, 1);
    assert.equal(
      (
        await request("/api/documents", "POST", {
          title: "Bad folder",
          collectionId: "missing",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`/api/documents/${doc.id}`, "PATCH", {
          revision: 5,
          scene: {},
        })
      ).status,
      400,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Access JWT verifies signature, issuer, audience, expiration and owner allowlist", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key" };
  const authenticate = accessVerifier({
    teamDomain: "draw-test.cloudflareaccess.com",
    audience: "draw-aud",
    allowedEmails: ["owner@test"],
    fetchKeys: async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }),
  });
  const base = {
    email: "owner@test",
    aud: ["draw-aud"],
    iss: "https://draw-test.cloudflareaccess.com",
    exp: Date.now() / 1000 + 600,
  };
  const jwt = (claims, key = privateKey) => {
    const content = `${Buffer.from(
      JSON.stringify({ alg: "RS256", kid: "test-key" }),
    ).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString(
      "base64url",
    )}`;
    return `${content}.${sign("RSA-SHA256", Buffer.from(content), key).toString(
      "base64url",
    )}`;
  };
  const check = (claims) =>
    authenticate({ headers: { "cf-access-jwt-assertion": jwt(claims) } });
  assert.deepEqual(await check(base), { email: "owner@test" });
  assert.equal(await check({ ...base, exp: 1 }), null);
  assert.equal(await check({ ...base, email: "attacker@test" }), null);
  assert.equal(
    await check({ ...base, iss: "https://wrong.cloudflareaccess.com" }),
    null,
  );
  assert.equal(await check({ ...base, aud: ["other-app"] }), null);
  assert.equal(
    await authenticate({
      headers: { "cf-access-authenticated-user-email": "owner@test" },
    }),
    null,
  );
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.equal(
    await authenticate({
      headers: { "cf-access-jwt-assertion": jwt(base, other.privateKey) },
    }),
    null,
  );
});
