import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPasswordAuth } from "./auth.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const title = (value) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.trim().length <= 200
    ? value.trim()
    : fail(400, "Name must be between 1 and 200 characters.");
const blankScene = {
  type: "excalidraw",
  version: 2,
  elements: [],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
};
function scene(value) {
  if (
    !object(value) ||
    !Array.isArray(value.elements) ||
    value.elements.length > 100000 ||
    !object(value.appState) ||
    !object(value.files)
  )
    fail(400, "Invalid Excalidraw document.");
  return JSON.stringify(value);
}
async function readBody(request) {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    fail(415, "Expected application/json.");
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024)
      fail(413, "Drawing exceeds the 32 MB upload limit.");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks));
    if (!object(value)) fail(400, "Expected a JSON object.");
    return value;
  } catch {
    fail(400, "Invalid JSON object.");
  }
}
const metadata =
  "id, title, collection_id AS collectionId, pinned, deleted, created_at AS createdAt, updated_at AS updatedAt, revision";
export function createWorkspaceServer({
  databasePath,
  distPath = path.join(here, "dist"),
  authenticate,
  authentication,
  origin = "https://draw.ryanlatimer.dev",
}) {
  mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
      scene TEXT NOT NULL, thumbnail TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS revisions (document_id TEXT NOT NULL REFERENCES documents(id), revision INTEGER NOT NULL,
      scene TEXT NOT NULL, saved_at TEXT NOT NULL, PRIMARY KEY(document_id, revision));`);
  function get(id) {
    const doc = db
      .prepare(
        `SELECT ${metadata}, scene, thumbnail FROM documents WHERE id = ?`,
      )
      .get(id);
    if (!doc) fail(404, "Drawing not found.");
    return { ...doc, scene: JSON.parse(doc.scene) };
  }
  const server = http.createServer(async (request, response) => {
    const json = (status, value) => {
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(value));
    };
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
    try {
      const url = new URL(request.url, origin);
      if (url.origin !== origin) fail(400, "Invalid request origin.");
      if (url.pathname === "/healthz" && request.method === "GET")
        return json(200, { ok: true });
      if (
        authentication &&
        (await authentication.handle(request, response, url))
      )
        return;
      const identity = await (authentication?.authenticate || authenticate)(
        request,
      );
      if (!identity) {
        if (
          authentication &&
          request.method === "GET" &&
          !url.pathname.startsWith("/api/")
        ) {
          response.writeHead(302, {
            Location: `/auth/login?returnTo=${encodeURIComponent(
              url.pathname,
            )}`,
          });
          return response.end();
        }
        return json(401, {
          error: "Sign in to open your workspace.",
        });
      }
      if (
        !["GET", "HEAD"].includes(request.method) &&
        request.headers.origin !== origin
      )
        fail(403, "Request origin is not allowed.");
      if (url.pathname === "/api/me" && request.method === "GET")
        return json(200, identity);
      if (url.pathname === "/api/documents" && request.method === "GET") {
        return json(
          200,
          db
            .prepare(
              `SELECT ${metadata} FROM documents ORDER BY pinned DESC, updated_at DESC`,
            )
            .all(),
        );
      }
      if (url.pathname === "/api/documents" && request.method === "POST") {
        const body = await readBody(request);
        const id = randomUUID();
        const now = new Date().toISOString();
        if (
          body.collectionId &&
          !db
            .prepare("SELECT id FROM collections WHERE id=?")
            .get(body.collectionId)
        )
          fail(400, "Collection not found.");
        db.prepare(
          "INSERT INTO documents (id,title,collection_id,scene,created_at,updated_at) VALUES (?,?,?,?,?,?)",
        ).run(
          id,
          title(body.title || "Untitled"),
          body.collectionId || null,
          scene(body.scene || blankScene),
          now,
          now,
        );
        return json(201, get(id));
      }
      const match = url.pathname.match(
        /^\/api\/documents\/([a-f0-9-]{36})(\/thumbnail)?$/,
      );
      if (match) {
        const id = match[1];
        if (match[2] && request.method === "GET") {
          const thumbnail = get(id).thumbnail;
          if (!thumbnail) {
            response.writeHead(204);
            return response.end();
          }
          response.writeHead(200, { "Content-Type": "image/png" });
          return response.end(Buffer.from(thumbnail.split(",")[1], "base64"));
        }
        if (!match[2] && request.method === "GET") {
          if (url.searchParams.get("metadata") === "1") {
            const doc = db
              .prepare(`SELECT ${metadata} FROM documents WHERE id=?`)
              .get(id);
            if (!doc) fail(404, "Drawing not found.");
            return json(200, doc);
          }
          return json(200, get(id));
        }
        if (!match[2] && request.method === "PATCH") {
          const body = await readBody(request);
          const existing = get(id);
          if (!Number.isInteger(body.revision))
            fail(400, "A document revision is required.");
          if (body.revision !== existing.revision)
            fail(
              409,
              "This drawing changed on another device. Save your changes as a copy, or load the latest version.",
            );
          if (
            body.collectionId &&
            !db
              .prepare("SELECT id FROM collections WHERE id=?")
              .get(body.collectionId)
          )
            fail(400, "Collection not found.");
          if (
            body.thumbnail !== undefined &&
            (typeof body.thumbnail !== "string" ||
              body.thumbnail.length > 1000000 ||
              (body.thumbnail &&
                !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(
                  body.thumbnail,
                )))
          )
            fail(400, "Invalid thumbnail.");
          const newScene =
            body.scene === undefined
              ? JSON.stringify(existing.scene)
              : scene(body.scene);
          const name =
            body.title === undefined ? existing.title : title(body.title);
          const collection =
            body.collectionId === undefined
              ? existing.collectionId
              : body.collectionId;
          const now = new Date().toISOString();
          db.exec("BEGIN IMMEDIATE");
          try {
            if (body.scene !== undefined) {
              db.prepare(
                "INSERT OR IGNORE INTO revisions VALUES (?,?,?,?)",
              ).run(id, existing.revision, JSON.stringify(existing.scene), now);
              db.prepare(
                "DELETE FROM revisions WHERE document_id=? AND revision NOT IN (SELECT revision FROM revisions WHERE document_id=? ORDER BY revision DESC LIMIT 20)",
              ).run(id, id);
            }
            db.prepare(
              "UPDATE documents SET title=?, collection_id=?, scene=?, thumbnail=?, pinned=?, deleted=?, updated_at=?, revision=revision+1 WHERE id=? AND revision=?",
            ).run(
              name,
              collection,
              newScene,
              body.thumbnail ?? existing.thumbnail,
              body.pinned === undefined
                ? existing.pinned
                : Number(Boolean(body.pinned)),
              body.deleted === undefined
                ? existing.deleted
                : Number(Boolean(body.deleted)),
              now,
              id,
              body.revision,
            );
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          return json(200, get(id));
        }
      }
      if (url.pathname === "/api/collections" && request.method === "GET")
        return json(
          200,
          db
            .prepare("SELECT * FROM collections ORDER BY name COLLATE NOCASE")
            .all(),
        );
      if (url.pathname === "/api/collections" && request.method === "POST") {
        const body = await readBody(request);
        const collection = { id: randomUUID(), name: title(body.name) };
        db.prepare("INSERT INTO collections VALUES (?,?)").run(
          collection.id,
          collection.name,
        );
        return json(201, collection);
      }
      const collection = url.pathname.match(
        /^\/api\/collections\/([a-f0-9-]{36})$/,
      );
      if (collection && request.method === "PATCH") {
        const body = await readBody(request);
        const result = db
          .prepare("UPDATE collections SET name=? WHERE id=?")
          .run(title(body.name), collection[1]);
        if (!result.changes) fail(404, "Collection not found.");
        return json(200, { ok: true });
      }
      if (collection && request.method === "DELETE") {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare(
            "UPDATE documents SET collection_id=NULL, revision=revision+1, updated_at=? WHERE collection_id=?",
          ).run(new Date().toISOString(), collection[1]);
          db.prepare("DELETE FROM collections WHERE id=?").run(collection[1]);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return json(200, { ok: true });
      }
      if (url.pathname.startsWith("/api/")) fail(404, "Endpoint not found.");
      if (!["GET", "HEAD"].includes(request.method))
        fail(405, "Method not allowed.");
      const relative = decodeURIComponent(url.pathname);
      let file = path.resolve(distPath, `.${relative}`);
      if (!file.startsWith(path.resolve(distPath) + path.sep))
        file = path.join(distPath, "index.html");
      try {
        if (!statSync(file).isFile()) throw new Error();
      } catch {
        if (path.extname(relative)) fail(404, "Asset not found.");
        file = path.join(distPath, "index.html");
      }
      const mime = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css",
        ".woff2": "font/woff2",
        ".wasm": "application/wasm",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".json": "application/json",
      };
      response.writeHead(200, {
        "Content-Type": mime[path.extname(file)] || "application/octet-stream",
      });
      if (request.method === "HEAD") return response.end();
      createReadStream(file)
        .on("error", () => response.destroy())
        .pipe(response);
    } catch (error) {
      if (!error.status)
        console.error("Workspace request failed:", error.message);
      if (!response.headersSent)
        json(error.status || 500, {
          error: error.status
            ? error.message
            : "The server could not complete the request.",
        });
      else response.end();
    }
  });
  server.requestTimeout = 60000;
  server.on("close", () => {
    db.close();
    authentication?.close();
  });
  return server;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const dev = process.env.DRAW_DEV_AUTH === "1";
  if (dev && process.env.NODE_ENV === "production")
    throw new Error("Development auth cannot run in production.");
  const databasePath =
    process.env.DRAW_DATABASE || path.join(here, "data/workspace.sqlite");
  const origin =
    process.env.DRAW_ORIGIN ||
    (dev ? "http://127.0.0.1:3101" : "https://draw.ryanlatimer.dev");
  if (!dev && process.env.DRAW_AUTH !== "openauth")
    throw new Error(
      "Configure DRAW_AUTH=openauth and seed the owner's password before starting.",
    );
  const authentication = dev
    ? undefined
    : createPasswordAuth({
        databasePath,
        origin,
        ownerEmail: process.env.DRAW_OWNER_EMAIL,
      });
  createWorkspaceServer({
    databasePath,
    authentication,
    authenticate: dev ? async () => ({ email: "local@localhost" }) : undefined,
    origin,
  }).listen(Number(process.env.PORT || 3100), "127.0.0.1", () =>
    console.log(`Workspace listening on 127.0.0.1:${process.env.PORT || 3100}`),
  );
}
