import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export function authDatabase(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS openauth_storage (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER);
    CREATE TABLE IF NOT EXISTS openauth_sessions (id TEXT PRIMARY KEY, access TEXT NOT NULL, refresh TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS openauth_flows (id TEXT PRIMARY KEY, state TEXT NOT NULL, verifier TEXT NOT NULL, destination TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS openauth_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  const join = (key) => key.join("\x1f");
  const storage = {
    async get(key) {
      const row = db
        .prepare("SELECT value, expires FROM openauth_storage WHERE key=?")
        .get(join(key));
      if (!row) return undefined;
      if (row.expires && row.expires <= Date.now()) {
        await storage.remove(key);
        return undefined;
      }
      return JSON.parse(row.value);
    },
    async set(key, value, expiry) {
      db.prepare("INSERT OR REPLACE INTO openauth_storage VALUES (?,?,?)").run(
        join(key),
        JSON.stringify(value),
        expiry?.getTime() ?? null,
      );
    },
    async remove(key) {
      db.prepare("DELETE FROM openauth_storage WHERE key=?").run(join(key));
    },
    async *scan(prefix) {
      const key = join(prefix);
      const rows = db
        .prepare(
          "SELECT key, value FROM openauth_storage WHERE substr(key,1,?)=? AND (expires IS NULL OR expires>?) ORDER BY key",
        )
        .all(key.length, key, Date.now());
      for (const row of rows)
        yield [row.key.split("\x1f"), JSON.parse(row.value)];
    },
  };
  for (const table of [
    "openauth_storage",
    "openauth_sessions",
    "openauth_flows",
    "openauth_limits",
  ])
    db.prepare(
      `DELETE FROM ${table} WHERE expires IS NOT NULL AND expires<=?`,
    ).run(Date.now());
  return { db, storage };
}
