import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  storage: new Map<string, unknown>(),
}));
vi.mock("idb-keyval", () => ({
  get: async (key: string) => mocks.storage.get(key),
  set: async (key: string, value: unknown) => {
    mocks.storage.set(key, value);
  },
  del: async (key: string) => {
    mocks.storage.delete(key);
  },
}));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: mocks.api,
}));
import { Autosave, draftKey } from "./autosave";
import { ApiError } from "./api";
import type { Document, Scene } from "./api";
const blank: Scene = {
  elements: [],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
};
const colored: Scene = {
  ...blank,
  appState: { viewBackgroundColor: "#eeeeee" },
};
const doc = {
  id: "test",
  revision: 1,
  scene: blank,
  thumbnail: "",
} as Document;
beforeEach(() => {
  mocks.api.mockReset();
  mocks.storage.clear();
});
describe("autosave data integrity", () => {
  it("deduplicates renders, serializes requests, and saves a revert made during an in-flight save", async () => {
    let release!: (value: unknown) => void;
    mocks.api
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce({ revision: 3 });
    const save = new Autosave(
      doc,
      () => {},
      async () => "",
    );
    save.change(colored);
    const pending = save.flush();
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(1));
    save.change(colored);
    expect(save.pending).toBeNull();
    save.change(blank);
    release({ revision: 2 });
    await pending;
    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(mocks.api.mock.calls[1][2]).toMatchObject({
      revision: 2,
      scene: blank,
    });
    expect(save.revision).toBe(3);
    expect(save.dirty).toBe(false);
    expect(mocks.storage.has(draftKey(doc.id))).toBe(false);
    save.dispose();
  });
  it("preserves a local draft after failure, and retries with the same revision", async () => {
    mocks.api
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce({ revision: 2 });
    const save = new Autosave(
      doc,
      () => {},
      async () => "",
    );
    save.change(colored);
    await expect(save.flush()).rejects.toThrow("Offline");
    expect(mocks.storage.get(draftKey(doc.id))).toEqual({
      scene: colored,
      baseRevision: 1,
    });
    await save.flush();
    expect(save.revision).toBe(2);
    expect(save.dirty).toBe(false);
    save.dispose();
  });
  it("stops overwrites after a conflict and keeps the draft for recovery", async () => {
    mocks.api.mockRejectedValue(new ApiError(409, "Conflict"));
    const save = new Autosave(
      doc,
      () => {},
      async () => "",
    );
    save.change(colored);
    await expect(save.flush()).rejects.toThrow("Conflict");
    await expect(save.flush()).rejects.toThrow("Resolve");
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(save.conflict).toBe(true);
    expect(mocks.storage.has(draftKey(doc.id))).toBe(true);
    save.dispose();
  });
});
