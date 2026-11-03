import { issuer } from "@openauthjs/openauth";
import { createClient } from "@openauthjs/openauth/client";
import { createSubjects } from "@openauthjs/openauth/subject";
import { PasswordProvider } from "@openauthjs/openauth/provider/password";
import { object, string } from "valibot";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { authDatabase } from "./auth-storage.mjs";

const clientID = "draw-workspace";
const subjects = createSubjects({ user: object({ email: string() }) });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const opaque = () => randomBytes(32).toString("base64url");
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        char
      ]),
  );
const cookies = (request) =>
  Object.fromEntries(
    (request.headers.cookie || "").split(";").flatMap((part) => {
      const at = part.indexOf("=");
      return at < 0
        ? []
        : [[part.slice(0, at).trim(), part.slice(at + 1).trim()]];
    }),
  );
const destination = (value) =>
  /^\/(?:drawing\/[a-f0-9-]{36})?$/.test(value || "") ? value : "/";

function page(content, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Sign in · Ryan’s workspace</title><link rel="icon" href="/auth/favicon.svg"><style>
    *{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f5f5f9;color:#343a40;font:16px system-ui,sans-serif;padding:24px}main{width:400px;max-width:100%;background:white;padding:32px;border:1px solid #eaeaf2;border-radius:16px;box-shadow:0 8px 32px #20204008}header{display:flex;gap:12px;align-items:center;margin-bottom:28px}.avatar{display:grid;place-items:center;background:#6965db;color:white;width:40px;height:40px;border-radius:12px;font-size:22px}h1{font-size:21px;line-height:1.3;margin:0}p{color:#6c7077;font-size:14px;line-height:1.6}label{display:block;font-size:14px;margin:18px 0}input{display:block;width:100%;font:inherit;padding:12px;border:1px solid #dadae5;border-radius:7px;margin-top:7px}input:focus{outline:2px solid #a6a0ff;border-color:transparent}button,.button{display:block;background:#6965db;color:white;text-decoration:none;text-align:center;border:0;border-radius:7px;padding:12px;width:100%;font:600 15px system-ui;cursor:pointer;margin-top:24px}button:hover,.button:hover{background:#5753c6}.error{background:#fff0ed;color:#a33b32;padding:12px;border-radius:6px;font-size:14px}.foot{margin-top:24px;margin-bottom:0;font-size:12px;text-align:center}@media(prefers-color-scheme:dark){body{background:#1b1b1f;color:#e3e3e8}main{background:#232329;border-color:#34343e}input{background:#1b1b1f;color:#e3e3e8;border-color:#494954}p{color:#aaaab5}}
    </style></head><body><main><header><span class="avatar">R</span><h1>Ryan’s workspace</h1></header>${content}<p class="foot">Private drawing workspace · Secured by OpenAuth</p></main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export function createPasswordAuth({
  databasePath,
  origin,
  ownerEmail,
  sessionSeconds = 7 * 24 * 60 * 60,
  accessSeconds = 15 * 60,
}) {
  const configured = new URL(origin);
  if (!ownerEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail))
    throw new Error("DRAW_OWNER_EMAIL is required for OpenAuth.");
  if (
    configured.origin !== origin ||
    (configured.protocol !== "https:" &&
      !["127.0.0.1", "localhost"].includes(configured.hostname))
  )
    throw new Error(
      "OpenAuth needs an HTTPS origin, or loopback for local testing.",
    );
  if (process.env.OPENAUTH_STORAGE)
    throw new Error(
      "OPENAUTH_STORAGE overrides are not supported; use the workspace SQLite storage.",
    );
  const email = ownerEmail.trim().toLowerCase();
  const { db, storage } = authDatabase(databasePath);
  if (
    !db
      .prepare("SELECT key FROM openauth_storage WHERE key=?")
      .get(["email", email, "password"].join("\x1f"))
  ) {
    db.close();
    throw new Error("Seed the owner's OpenAuth password before starting.");
  }
  const secure = configured.protocol === "https:";
  const sessionCookie = secure ? "__Host-draw-session" : "draw-session";
  const flowCookie = secure ? "__Host-draw-login" : "draw-login";
  const cookie = (name, value, maxAge) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${
      secure ? "; Secure" : ""
    }`;
  const appendCookie = (response, value) =>
    response.setHeader("Set-Cookie", [
      ...[].concat(response.getHeader("Set-Cookie") || []),
      value,
    ]);
  const redirect = (response, location, status = 302) => {
    response.writeHead(status, { Location: location });
    response.end();
  };
  const send = async (response, result) => {
    for (const [key, value] of result.headers)
      if (key !== "set-cookie") response.setHeader(key, value);
    for (const value of result.headers.getSetCookie())
      appendCookie(response, value);
    response.writeHead(result.status);
    response.end(Buffer.from(await result.arrayBuffer()));
  };
  const provider = PasswordProvider({
    login: async (_request, form, error) =>
      page(
        `<h2>Sign in</h2><p>Use your email and password to open your drawings.</p>${
          error
            ? '<p class="error" role="alert">The email or password is incorrect.</p>'
            : ""
        }<form method="post" action="/password/authorize"><label>Email<input type="email" name="email" autocomplete="username" value="${escape(
          form?.get("email") || email,
        )}" required maxlength="254"></label><label>Password<input type="password" name="password" autocomplete="current-password" autofocus required maxlength="1024"></label><button type="submit">Sign in</button></form>`,
      ),
    register: async () =>
      new Response("Registration is disabled.", { status: 404 }),
    change: async () =>
      new Response("Password reset is managed on the server.", { status: 404 }),
    sendCode: async () => {
      throw new Error("Email code flows are disabled.");
    },
  });
  const app = issuer({
    subjects,
    storage,
    providers: { password: provider },
    ttl: { access: accessSeconds, refresh: sessionSeconds, reuse: 30 },
    allow: async ({ clientID: id, redirectURI }, request) => {
      const params = new URL(request.url).searchParams;
      return (
        id === clientID &&
        redirectURI === `${origin}/auth/callback` &&
        params.get("response_type") === "code" &&
        params.get("code_challenge_method") === "S256" &&
        /^[\w-]{43}$/.test(params.get("code_challenge") || "")
      );
    },
    success: async (ctx, value) =>
      value.provider === "password" && value.email === email
        ? ctx.subject("user", { email })
        : new Response("Access denied.", { status: 403 }),
    error: async () =>
      page(
        '<p class="error">Your sign-in request expired. Please start again.</p><a class="button" href="/auth/login">Back to sign in</a>',
        400,
      ),
  });
  const client = createClient({
    clientID,
    issuer: origin,
    fetch: (url, options) => app.fetch(new Request(url, options)),
  });
  const verifying = new Map();
  async function authenticate(request) {
    const raw = cookies(request)[sessionCookie];
    if (!raw || !/^[\w-]{43}$/.test(raw)) return null;
    const id = digest(raw);
    if (verifying.has(id)) return verifying.get(id);
    const task = (async () => {
      const session = db
        .prepare("SELECT * FROM openauth_sessions WHERE id=? AND expires>?")
        .get(id, Date.now());
      if (!session) return null;
      try {
        const verified = await client.verify(subjects, session.access, {
          refresh: session.refresh,
        });
        if (
          verified.err ||
          verified.aud !== clientID ||
          verified.subject.type !== "user" ||
          verified.subject.properties.email !== email
        ) {
          db.prepare("DELETE FROM openauth_sessions WHERE id=?").run(id);
          return null;
        }
        if (verified.tokens)
          db.prepare(
            "UPDATE openauth_sessions SET access=?, refresh=? WHERE id=?",
          ).run(verified.tokens.access, verified.tokens.refresh, id);
        if (
          !db
            .prepare(
              "SELECT id FROM openauth_sessions WHERE id=? AND expires>?",
            )
            .get(id, Date.now())
        )
          return null;
        return { email };
      } catch {
        return null;
      }
    })();
    verifying.set(id, task);
    try {
      return await task;
    } finally {
      verifying.delete(id);
    }
  }
  function rateLimit(key, max, seconds) {
    const id = digest(key);
    const now = Date.now();
    db.prepare(
      "INSERT INTO openauth_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END, expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END",
    ).run(id, now + seconds * 1000, now, now);
    return (
      db.prepare("SELECT count FROM openauth_limits WHERE key=?").get(id)
        .count <= max
    );
  }
  let lastPrune = 0;
  async function handle(request, response, url) {
    const route = url.pathname;
    const issuerRoutes = [
      "/authorize",
      "/token",
      "/password/authorize",
      "/.well-known/oauth-authorization-server",
      "/.well-known/jwks.json",
    ];
    if (
      !route.startsWith("/auth/") &&
      !route.startsWith("/password/") &&
      !issuerRoutes.includes(route)
    )
      return false;
    if (Date.now() - lastPrune > 300000) {
      for (const table of [
        "openauth_storage",
        "openauth_sessions",
        "openauth_flows",
        "openauth_limits",
      ])
        db.prepare(
          `DELETE FROM ${table} WHERE expires IS NOT NULL AND expires<=?`,
        ).run(Date.now());
      lastPrune = Date.now();
    }
    if (request.method === "POST" && request.headers.origin !== origin) {
      await send(
        response,
        new Response("Request origin is not allowed.", { status: 403 }),
      );
      return true;
    }
    if (route === "/auth/favicon.svg" && request.method === "GET") {
      await send(
        response,
        new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#6965db"/><text x="12" y="29" fill="white" font-family="sans-serif" font-size="28">R</text></svg>',
          { headers: { "Content-Type": "image/svg+xml" } },
        ),
      );
      return true;
    }
    if (route === "/auth/login" && request.method === "GET") {
      const to = destination(url.searchParams.get("returnTo"));
      if (await authenticate(request)) {
        redirect(response, to);
        return true;
      }
      const ip =
        request.headers["cf-connecting-ip"] ||
        request.socket.remoteAddress ||
        "local";
      if (!rateLimit(`start:${ip}`, 60, 900)) {
        await send(
          response,
          page(
            '<p class="error">Too many sign-in attempts. Please try again in 15 minutes.</p>',
            429,
          ),
        );
        return true;
      }
      const { challenge, url: authorizeURL } = await client.authorize(
        `${origin}/auth/callback`,
        "code",
        { pkce: true, provider: "password" },
      );
      const flow = opaque();
      db.prepare("INSERT INTO openauth_flows VALUES (?,?,?,?,?)").run(
        digest(flow),
        challenge.state,
        challenge.verifier,
        to,
        Date.now() + 600000,
      );
      appendCookie(response, cookie(flowCookie, flow, 600));
      redirect(response, authorizeURL);
      return true;
    }
    if (route === "/auth/callback" && request.method === "GET") {
      const raw = cookies(request)[flowCookie];
      const flow = raw
        ? db
            .prepare("SELECT * FROM openauth_flows WHERE id=? AND expires>?")
            .get(digest(raw), Date.now())
        : null;
      appendCookie(response, cookie(flowCookie, "", 0));
      if (flow)
        db.prepare("DELETE FROM openauth_flows WHERE id=?").run(digest(raw));
      if (
        !flow ||
        !equal(flow.state, url.searchParams.get("state")) ||
        !url.searchParams.get("code")
      ) {
        await send(
          response,
          page(
            '<p class="error">Your sign-in request is invalid or expired.</p><a class="button" href="/auth/login">Try again</a>',
            400,
          ),
        );
        return true;
      }
      const result = await client.exchange(
        url.searchParams.get("code"),
        `${origin}/auth/callback`,
        flow.verifier,
      );
      const verified =
        !result.err && (await client.verify(subjects, result.tokens.access));
      if (
        !verified ||
        verified.err ||
        verified.aud !== clientID ||
        verified.subject.properties.email !== email
      ) {
        await send(
          response,
          page(
            '<p class="error">Sign-in failed. Please try again.</p><a class="button" href="/auth/login">Try again</a>',
            403,
          ),
        );
        return true;
      }
      const session = opaque();
      db.prepare("INSERT INTO openauth_sessions VALUES (?,?,?,?)").run(
        digest(session),
        result.tokens.access,
        result.tokens.refresh,
        Date.now() + sessionSeconds * 1000,
      );
      appendCookie(response, cookie(sessionCookie, session, sessionSeconds));
      redirect(response, flow.destination, 303);
      return true;
    }
    if (route === "/auth/logout" && request.method === "POST") {
      const raw = cookies(request)[sessionCookie];
      if (raw) {
        const session = db
          .prepare("SELECT refresh FROM openauth_sessions WHERE id=?")
          .get(digest(raw));
        if (session) {
          const parts = session.refresh.split(":");
          const token = parts.pop();
          await storage.remove(["oauth:refresh", parts.join(":"), token]);
        }
        db.prepare("DELETE FROM openauth_sessions WHERE id=?").run(digest(raw));
      }
      appendCookie(response, cookie(sessionCookie, "", 0));
      redirect(response, "/auth/signed-out", 303);
      return true;
    }
    if (route === "/auth/signed-out" && request.method === "GET") {
      await send(
        response,
        page(
          '<h2>You’re signed out</h2><p>Your drawings are saved in your private workspace.</p><a class="button" href="/auth/login">Sign in again</a>',
        ),
      );
      return true;
    }
    if (
      !issuerRoutes.includes(route) ||
      !["GET", "POST"].includes(request.method)
    ) {
      await send(response, new Response("Not found.", { status: 404 }));
      return true;
    }
    if (
      route === "/authorize" &&
      (url.searchParams.get("client_id") !== clientID ||
        url.searchParams.get("redirect_uri") !== `${origin}/auth/callback` ||
        url.searchParams.get("response_type") !== "code" ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        !/^[\w-]{43}$/.test(url.searchParams.get("code_challenge") || ""))
    ) {
      await send(
        response,
        new Response("Invalid authorization request.", { status: 400 }),
      );
      return true;
    }
    if (route === "/password/authorize" && request.method === "POST") {
      const ip =
        request.headers["cf-connecting-ip"] ||
        request.socket.remoteAddress ||
        "local";
      if (
        !rateLimit(`password:${ip}`, 20, 900) ||
        !rateLimit("password:owner", 100, 900)
      ) {
        await send(
          response,
          page(
            '<p class="error">Too many sign-in attempts. Please try again in 15 minutes.</p>',
            429,
          ),
        );
        return true;
      }
    }
    let body;
    if (request.method === "POST") {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16384) {
          await send(
            response,
            new Response("Request too large.", { status: 413 }),
          );
          return true;
        }
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }
    const headers = new Headers();
    for (const name of ["cookie", "content-type", "accept"])
      if (request.headers[name]) headers.set(name, request.headers[name]);
    await send(
      response,
      await app.fetch(
        new Request(new URL(route + url.search, origin), {
          method: request.method,
          headers,
          body,
        }),
      ),
    );
    return true;
  }
  return { handle, authenticate, close: () => db.close() };
}
