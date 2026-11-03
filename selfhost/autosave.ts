import { get, set, del } from "idb-keyval";
import { api, ApiError } from "./api";
import type { Document, Scene } from "./api";

export type Draft = { scene: Scene; baseRevision: number };
export const draftKey = (id: string) => `draw-workspace:draft:${id}`;
export const readDraft = (id: string) => get<Draft>(draftKey(id));
export const clearDraft = (id: string) => del(draftKey(id));

// One request in flight per document; later edits wait for the new revision.
export class Autosave {
  pending: Scene | null = null;
  inFlight: Promise<void> | null = null;
  conflict = false;
  stopped = false;
  revision: number;
  lastSaved: string;
  lastObserved: string;
  needsPreview: boolean;
  timer?: ReturnType<typeof setTimeout>;
  draftWrites: Promise<unknown> = Promise.resolve();
  constructor(
    public doc: Document,
    private report: (status: string, error?: string) => void,
    private thumbnail: (scene: Scene) => Promise<string>,
  ) {
    this.revision = doc.revision;
    this.lastSaved = JSON.stringify(doc.scene);
    this.lastObserved = this.lastSaved;
    this.needsPreview =
      !doc.thumbnail &&
      doc.scene.elements.some((element) => !element.isDeleted);
  }
  get dirty() {
    return Boolean(this.pending || this.inFlight);
  }
  change(scene: Scene) {
    const serialized = JSON.stringify(scene);
    if (
      this.stopped ||
      (serialized === this.lastObserved && !this.needsPreview)
    )
      return;
    this.lastObserved = serialized;
    this.needsPreview = false;
    this.pending = scene;
    const draft = { scene, baseRevision: this.revision };
    this.draftWrites = this.draftWrites
      .catch(() => {})
      .then(() => set(draftKey(this.doc.id), draft))
      .catch(() =>
        this.report(
          "error",
          "Browser draft storage is unavailable. Keep this tab open until saving succeeds.",
        ),
      );
    this.report(this.conflict ? "conflict" : "pending");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, 800);
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.inFlight) {
      await this.inFlight;
      return this.flush();
    }
    if (this.conflict)
      throw new Error("Resolve the document conflict before leaving.");
    if (!this.pending || this.stopped) return;
    const next = this.pending;
    this.pending = null;
    this.report("saving");
    this.inFlight = (async () => {
      try {
        let thumbnail: string | undefined;
        try {
          thumbnail = await this.thumbnail(next);
        } catch {
          /* A preview must never block saving. */
        }
        const saved = await api<Document>(
          `/documents/${this.doc.id}`,
          "PATCH",
          { revision: this.revision, scene: next, thumbnail },
        );
        this.revision = saved.revision;
        this.lastSaved = JSON.stringify(next);
        await this.draftWrites;
        if (!this.pending) await clearDraft(this.doc.id);
        else
          await set(draftKey(this.doc.id), {
            scene: this.pending,
            baseRevision: this.revision,
          });
        this.report(this.pending ? "pending" : "saved");
      } catch (error) {
        this.pending ||= next;
        this.conflict = error instanceof ApiError && error.status === 409;
        this.report(
          this.conflict ? "conflict" : "error",
          error instanceof Error
            ? error.message
            : "Saving failed. Your draft is kept on this device.",
        );
        throw error;
      } finally {
        this.inFlight = null;
      }
    })();
    await this.inFlight;
    if (this.pending) await this.flush();
  }
  dispose() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
