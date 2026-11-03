import { readFileSync } from "node:fs";
import { ScryptHasher } from "@openauthjs/openauth/provider/password";
import { Storage } from "@openauthjs/openauth/storage/storage";
import { authDatabase } from "./auth-storage.mjs";

const email = process.env.DRAW_OWNER_EMAIL?.trim().toLowerCase();
if (
  !process.env.DRAW_DATABASE ||
  !process.env.DRAW_PASSWORD_FILE ||
  !email ||
  !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
)
  throw new Error(
    "Set DRAW_DATABASE, DRAW_OWNER_EMAIL, and DRAW_PASSWORD_FILE.",
  );
const password = readFileSync(process.env.DRAW_PASSWORD_FILE, "utf8");
if (password.length < 12 || password.length > 1024)
  throw new Error("Use a password between 12 and 1024 characters.");
const { db, storage } = authDatabase(process.env.DRAW_DATABASE);
try {
  const hash = await ScryptHasher().hash(password);
  await Storage.set(storage, ["email", email, "password"], hash);
  db.exec("DELETE FROM openauth_sessions; DELETE FROM openauth_flows;");
  for await (const [key] of Storage.scan(storage, ["oauth:refresh"]))
    await Storage.remove(storage, key);
  console.log(
    `OpenAuth password configured for ${email}; existing sessions invalidated.`,
  );
} finally {
  db.close();
}
