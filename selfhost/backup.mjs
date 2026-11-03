import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

if (!process.env.DRAW_DATABASE) throw new Error("DRAW_DATABASE is required.");
const dir =
  process.env.DRAW_BACKUPS ||
  path.join(path.dirname(process.env.DRAW_DATABASE), "backups");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(process.env.DRAW_DATABASE, { readOnly: true });
const target = path.join(
  dir,
  `workspace-${new Date().toISOString().replaceAll(":", "-")}.sqlite`,
);
try {
  await backup(db, target);
} finally {
  db.close();
}
for (const old of readdirSync(dir)
  .filter((name) => /^workspace-.*\.sqlite$/.test(name))
  .sort()
  .reverse()
  .slice(14))
  unlinkSync(path.join(dir, old));
console.log(`Backup saved: ${target}`);
