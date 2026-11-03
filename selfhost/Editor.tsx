import { useEffect, useRef, useState } from "react";
import {
  Excalidraw,
  MainMenu,
  exportScene,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";
import { Autosave, readDraft, clearDraft } from "./autosave";
import { api } from "./api";
import type { Document, Scene } from "./api";
import { Icon } from "./icons";
import { SceneNavigator } from "./SceneNavigator";

async function preview(scene: Scene) {
  const elements = scene.elements.filter(
    (element) => !element.isDeleted,
  ) as NonDeletedExcalidrawElement[];
  if (!elements.length) return "";
  const blob = await exportScene({
    type: "png",
    data: { elements, appState: scene.appState, files: scene.files },
    config: { width: 480, height: 300 },
  });
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function Editor({
  doc,
  theme,
  onExit,
  onCopy,
  onRefresh,
}: {
  doc: Document;
  theme: "light" | "dark";
  onExit: () => void;
  onCopy: (doc: Document) => void;
  onRefresh: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState("saved");
  const [error, setError] = useState("");
  const [initial, setInitial] = useState<Scene | null>(null);
  const [name, setName] = useState(doc.title);
  const [showScenes, setShowScenes] = useState(false);
  const [focusSearch, setFocusSearch] = useState(0);
  const [navigating, setNavigating] = useState(false);
  const ready = useRef(false);
  const [autosave] = useState(
    () =>
      new Autosave(
        doc,
        (state, message) => {
          setStatus(state);
          if (message) setError(message);
          else if (state === "saved") setError("");
        },
        preview,
      ),
  );
  const rootDocument = () => host.current!.ownerDocument;
  useEffect(() => {
    let disposed = false;
    readDraft(doc.id)
      .then((draft) => {
        if (disposed) return;
        setInitial(draft?.scene || doc.scene);
        if (draft) {
          autosave.change(draft.scene);
          if (draft.baseRevision !== doc.revision) {
            autosave.conflict = true;
            setStatus("conflict");
            setError(
              "A draft on this device differs from the version on the server. Save it as a copy or load the latest.",
            );
          }
        }
      })
      .catch(() => {
        if (!disposed) setInitial(doc.scene);
      });
    const ownerWindow = rootDocument().defaultView!;
    setShowScenes(ownerWindow.innerWidth >= 850);
    const quickSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setShowScenes(true);
        setFocusSearch((count) => count + 1);
      }
    };
    rootDocument().addEventListener("keydown", quickSearch);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (autosave.dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    ownerWindow.addEventListener("beforeunload", beforeUnload);
    const retry = () => {
      void autosave.flush().catch(() => {});
    };
    ownerWindow.addEventListener("online", retry);
    const poll = ownerWindow.setInterval(async () => {
      if (autosave.dirty || rootDocument().visibilityState !== "visible") {
        retry();
        return;
      }
      try {
        const remote = await api<Document>(`/documents/${doc.id}?metadata=1`);
        if (!disposed && remote.revision > autosave.revision && !autosave.dirty)
          onRefresh();
      } catch {
        /* Retry on the next tick. */
      }
    }, 10000);
    return () => {
      disposed = true;
      autosave.dispose();
      ownerWindow.clearInterval(poll);
      ownerWindow.removeEventListener("beforeunload", beforeUnload);
      ownerWindow.removeEventListener("online", retry);
      ownerWindow.document.removeEventListener("keydown", quickSearch);
    };
  }, [autosave, doc.id]);
  async function leave() {
    try {
      await autosave.flush();
      onExit();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Saving failed.");
    }
  }
  async function rename() {
    if (name.trim() === doc.title) return;
    try {
      await autosave.flush();
      const result = await api<Document>(`/documents/${doc.id}`, "PATCH", {
        title: name.trim(),
        revision: autosave.revision,
      });
      autosave.revision = result.revision;
      doc.title = result.title;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rename failed.");
    }
  }
  async function switchScene(id?: string) {
    if (navigating || id === doc.id) return;
    setNavigating(true);
    try {
      await autosave.flush();
      const next = id
        ? await api<Document>(`/documents/${id}`)
        : await api<Document>("/documents", "POST", {
            title: "Untitled",
            collectionId: doc.collectionId,
          });
      onCopy(next);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not switch drawings.",
      );
    } finally {
      setNavigating(false);
    }
  }
  async function saveCopy() {
    try {
      const scene =
        autosave.pending ||
        (engine.current
          ? JSON.parse(
              serializeAsJSON(
                engine.current.getSceneElementsIncludingDeleted(),
                engine.current.getAppState(),
                engine.current.getFiles(),
                "local",
              ),
            )
          : initial);
      const copy = await api<Document>("/documents", "POST", {
        title: `${name} (recovered copy)`,
        scene,
        collectionId: doc.collectionId,
      });
      await clearDraft(doc.id);
      autosave.dispose();
      onCopy(copy);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save a copy.");
    }
  }
  return (
    <div className="editor-shell" ref={host}>
      <header className="editor-header">
        <button
          className="icon-button"
          aria-label="Toggle scene navigator"
          aria-expanded={showScenes}
          onClick={() => setShowScenes((open) => !open)}
        >
          <Icon name="dashboard" />
        </button>
        <button
          className="icon-button"
          aria-label="Back to dashboard"
          onClick={() => void leave()}
        >
          <Icon name="back" />
        </button>
        <span className="editor-divider" />
        <input
          className="document-title"
          aria-label="Drawing name"
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void rename()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        <span className={`save-status ${status}`} role="status">
          <Icon name={status === "saved" ? "check" : "cloud"} />
          <span>
            {
              (
                {
                  saved: "All changes saved",
                  pending: "Unsaved changes",
                  saving: "Saving…",
                  error: "Saved on this device",
                  conflict: "Changes need attention",
                } as Record<string, string>
              )[status]
            }
          </span>
        </span>
        <span className="private-label">
          <Icon name="lock" /> Private
        </span>
      </header>
      {(error || status === "conflict") && (
        <div className="save-error" role="alert">
          <span>{error || "This drawing changed on another device."}</span>
          <button onClick={() => void saveCopy()}>Save as a copy</button>
          {status === "conflict" ? (
            <button
              onClick={() => {
                if (
                  rootDocument().defaultView!.confirm(
                    "Discard this device's draft and load the server version?",
                  )
                )
                  void clearDraft(doc.id).then(onRefresh);
              }}
            >
              Load latest
            </button>
          ) : (
            <button onClick={() => void autosave.flush().catch(() => {})}>
              Retry save
            </button>
          )}
        </div>
      )}
      <div className="editor-body">
        {showScenes && (
          <SceneNavigator
            currentId={doc.id}
            revision={autosave.revision}
            onNavigate={(id) => void switchScene(id)}
            onCreate={() => void switchScene()}
            onDashboard={() => void leave()}
            onError={setError}
            focusSearch={focusSearch}
          />
        )}
        <div className="canvas-container">
          {initial ? (
            <Excalidraw
              initialData={initial}
              theme={theme}
              name={name}
              onExcalidrawAPI={(api) => {
                engine.current = api;
              }}
              onInitialize={() => {
                ready.current = true;
              }}
              onChange={(elements, appState, files) => {
                if (ready.current)
                  autosave.change(
                    JSON.parse(
                      serializeAsJSON(elements, appState, files, "local"),
                    ),
                  );
              }}
              UIOptions={{ canvasActions: { export: false } }}
              aiEnabled={false}
            >
              <MainMenu>
                <MainMenu.DefaultItems.LoadScene />
                <MainMenu.DefaultItems.SaveToActiveFile />
                <MainMenu.DefaultItems.SaveAsImage />
                <MainMenu.Separator />
                <MainMenu.DefaultItems.SearchMenu />
                <MainMenu.DefaultItems.Help />
                <MainMenu.DefaultItems.ClearCanvas />
                <MainMenu.Separator />
                <MainMenu.DefaultItems.ChangeCanvasBackground />
              </MainMenu>
            </Excalidraw>
          ) : (
            <div className="loading">Opening drawing…</div>
          )}
        </div>
      </div>
    </div>
  );
}
