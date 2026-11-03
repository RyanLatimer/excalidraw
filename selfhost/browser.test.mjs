import { chromium } from "playwright";
import { createWorkspaceServer } from "./server.mjs";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { ScryptHasher } from "@openauthjs/openauth/provider/password";
import { Storage } from "@openauthjs/openauth/storage/storage";
import { authDatabase } from "./auth-storage.mjs";
import { createPasswordAuth } from "./auth.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "draw-browser-"));
const origin = "http://127.0.0.1:3102";
const ownerEmail = "owner@example.com";
const password = "browser-test-password-only";
const databasePath = path.join(dir, "test.sqlite");
const authStore = authDatabase(databasePath);
await Storage.set(
  authStore.storage,
  ["email", ownerEmail, "password"],
  await ScryptHasher().hash(password),
);
authStore.db.close();
const server = createWorkspaceServer({
  databasePath,
  authentication: createPasswordAuth({ databasePath, origin, ownerEmail }),
  origin,
});
await new Promise((resolve) => server.listen(3102, "127.0.0.1", resolve));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.DRAW_CHROMIUM
    ? { executablePath: process.env.DRAW_CHROMIUM }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 950 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const api = async (route, method = "GET", body) => {
  const r = await context.request.fetch(`${origin}/api${route}`, {
    method,
    headers: { Origin: origin },
    ...(body ? { data: body } : {}),
  });
  assert.ok(r.ok(), `${method} ${route}: ${r.status()}`);
  return r.json();
};
const wait = async (condition, description) => {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}`);
};
try {
  await page.goto(origin);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "New collection", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Engineering");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Engineering", exact: true }).click();
  await page
    .getByRole("button", { name: "Start drawing", exact: true })
    .click();
  await page.locator(".excalidraw").waitFor();
  const title = page.getByRole("textbox", { name: "Drawing name" });
  await title.fill("System architecture");
  await title.press("Enter");
  await wait(
    async () => (await api("/documents"))[0]?.title === "System architecture",
    "rename",
  );
  await page.getByTitle(/Rectangle/).click();
  const canvas = page.locator("canvas.excalidraw__canvas.interactive");
  const bounds = await canvas.boundingBox();
  assert.ok(bounds);
  await page.mouse.move(bounds.x + 440, bounds.y + 260);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 650, bounds.y + 390, { steps: 10 });
  await page.mouse.up();
  const id = (await api("/documents"))[0].id;
  await wait(
    async () => (await api(`/documents/${id}`)).scene.elements.length === 1,
    "drawing autosave",
  );
  let saved = await api(`/documents/${id}`);
  assert.equal(saved.scene.elements[0].type, "rectangle");
  assert.ok(
    saved.thumbnail.startsWith("data:image/png;base64,"),
    "thumbnail generated",
  );
  // An independent browser context loads the durable scene, then sees new saves.
  const second = await browser.newContext();
  const other = await second.newPage();
  await other.goto(`${origin}/drawing/${id}`);
  await other.getByLabel("Password", { exact: true }).fill(password);
  await other.getByRole("button", { name: "Sign in", exact: true }).click();
  await other.locator(".excalidraw").waitFor();
  await other
    .getByRole("textbox", { name: "Drawing name" })
    .fill("Cross-device architecture");
  await other.getByRole("textbox", { name: "Drawing name" }).press("Enter");
  await wait(
    async () =>
      (await api(`/documents/${id}`)).title === "Cross-device architecture",
    "cross-device rename",
  );
  // A stale first tab must preserve its draft instead of overwriting that save.
  await page.getByTitle(/Rectangle/).click();
  await page.mouse.move(bounds.x + 720, bounds.y + 260);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 850, bounds.y + 370, { steps: 6 });
  await page.mouse.up();
  await page
    .getByRole("button", { name: "Save as a copy", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Save as a copy", exact: true })
    .click();
  await wait(
    async () => (await api("/documents")).length === 2,
    "conflict recovered as copy",
  );
  const copy = (await api("/documents")).find((doc) => doc.id !== id);
  assert.equal((await api(`/documents/${copy.id}`)).scene.elements.length, 2);
  // Simulate failed writes, then reload: the device draft must survive.
  await page.route("**/api/documents/*", async (route) => {
    if (route.request().method() === "PATCH")
      await route.abort("internetdisconnected");
    else await route.continue();
  });
  await page.getByTitle(/Rectangle/).click();
  await page.mouse.move(bounds.x + 450, bounds.y + 500);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 600, bounds.y + 610, { steps: 6 });
  await page.mouse.up();
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await page.unroute("**/api/documents/*");
  await page.reload();
  await wait(
    async () =>
      (await api(`/documents/${copy.id}`)).scene.elements.length === 3,
    "offline draft survives reload",
  );
  await page
    .getByRole("button", {
      name: "Switch to Cross-device architecture",
      exact: true,
    })
    .click();
  await wait(
    async () =>
      (await page
        .getByRole("textbox", { name: "Drawing name" })
        .inputValue()) === "Cross-device architecture",
    "direct scene switching",
  );
  await page
    .getByRole("button", {
      name: "Switch to System architecture (recovered copy)",
      exact: true,
    })
    .click();
  await wait(
    async () =>
      (await page
        .getByRole("textbox", { name: "Drawing name" })
        .inputValue()) === "System architecture (recovered copy)",
    "switch back",
  );
  await page
    .getByRole("button", { name: "Back to dashboard", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Options for System architecture (recovered copy)",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Pin", exact: true }).click();
  await wait(
    async () => (await api(`/documents/${copy.id}`)).pinned === 1,
    "pin",
  );
  await page
    .getByRole("button", {
      name: "Options for System architecture (recovered copy)",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Options for System architecture (recovered copy)",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Restore drawing", exact: true })
    .click();
  await wait(
    async () => (await api(`/documents/${copy.id}`)).deleted === 0,
    "restore",
  );
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Quick search" })
    .fill("Cross-device");
  await page
    .getByRole("button", {
      name: "Open Cross-device architecture",
      exact: true,
    })
    .waitFor();
  assert.equal(await page.locator(".drawing-card").count(), 1);
  await page.getByRole("textbox", { name: "Quick search" }).fill("");
  mkdirSync("selfhost/test-results", { recursive: true });
  await page.screenshot({
    path: "selfhost/test-results/dashboard.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Use dark theme", exact: true })
    .click();
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "no mobile overflow",
  );
  await page.screenshot({
    path: "selfhost/test-results/mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("heading", { name: "You’re signed out", exact: true })
    .waitFor();
  assert.equal((await context.request.get(`${origin}/api/me`)).status(), 401);
  await second.close();
  assert.deepEqual(errors, [], "no browser exceptions");
  console.log(
    "PASS: drawing, thumbnail, autosave, cross-device reload, conflict recovery, collections, pin, trash, restore, search, dark mode, and mobile layout",
  );
} catch (error) {
  mkdirSync("selfhost/test-results", { recursive: true });
  await page.screenshot({
    path: "selfhost/test-results/failure.png",
    fullPage: true,
  });
  console.error("Browser errors:", errors);
  console.error("Page:", (await page.locator("body").innerText()).slice(-7000));
  console.error("Saved documents:", await api("/documents"));
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
