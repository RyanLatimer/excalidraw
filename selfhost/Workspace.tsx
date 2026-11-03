import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Collection, Document, Drawing } from "./api";
import { Icon } from "./icons";
import { Editor } from "./Editor";

const relativeTime = (date: string) => {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(date)) / 60000),
  );
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hours ago`;
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
};
function download(doc: Document, ownerDocument: globalThis.Document) {
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          { ...doc.scene, type: "excalidraw", version: 2 },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    ),
  );
  const a = ownerDocument.createElement("a");
  a.href = url;
  a.download = `${doc.title}.excalidraw`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Workspace() {
  const host = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [email, setEmail] = useState("");
  const [selection, setSelection] = useState("dashboard");
  const [search, setSearch] = useState("");
  const [document, setDocument] = useState<Document | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [view, setView] = useState("grid");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [sort, setSort] = useState("modified");
  const [dialog, setDialog] = useState<{
    kind: string;
    title: string;
    value: string;
    doc?: Drawing;
    collection?: Collection;
  } | null>(null);
  const [moveId, setMoveId] = useState<string | null>(null);
  const ownerDocument = () => host.current!.ownerDocument;
  const ownerWindow = () => ownerDocument().defaultView!;
  const refresh = useCallback(async () => {
    const [docs, folders] = await Promise.all([
      api<Drawing[]>("/documents"),
      api<Collection[]>("/collections"),
    ]);
    setDrawings(docs);
    setCollections(folders);
  }, []);
  const open = useCallback(async (id: string) => {
    const doc = await api<Document>(`/documents/${id}`);
    if (doc.deleted)
      throw new Error("Restore this drawing from Trash before opening it.");
    setDocument(doc);
    setEditorKey((key) => key + 1);
    host.current!.ownerDocument.defaultView!.history.replaceState(
      null,
      "",
      `/drawing/${id}`,
    );
  }, []);
  async function action(task: () => Promise<unknown>) {
    if (working) return;
    setWorking(true);
    setError("");
    setMenu(null);
    try {
      await task();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Something went wrong.",
      );
    } finally {
      setWorking(false);
    }
  }
  useEffect(() => {
    const win = ownerWindow();
    setTheme(
      win.localStorage.getItem("draw-theme") === "dark" ? "dark" : "light",
    );
    setView(win.localStorage.getItem("draw-view") || "grid");
    Promise.all([
      refresh(),
      api<{ email: string }>("/me").then((me) => setEmail(me.email)),
    ])
      .then(async () => {
        const id = win.location.pathname.match(
          /^\/drawing\/([a-f0-9-]{36})$/,
        )?.[1];
        if (id) await open(id);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        if (win.location.pathname.startsWith("/drawing/")) return;
        e.preventDefault();
        setSidebar(true);
        searchInput.current?.focus();
      }
      if (e.key === "Escape") {
        setMenu(null);
        setDialog(null);
        setMoveId(null);
      }
    };
    ownerDocument().addEventListener("keydown", handler);
    return () => ownerDocument().removeEventListener("keydown", handler);
  }, [refresh, open]);
  useEffect(() => {
    if (document) return;
    const win = ownerWindow();
    const interval = win.setInterval(() => {
      if (ownerDocument().visibilityState === "visible")
        void refresh().catch(() => {});
    }, 15000);
    return () => win.clearInterval(interval);
  }, [document, refresh]);
  function choose(id: string) {
    setSelection(id);
    setSearch("");
    setSidebar(false);
    setMenu(null);
  }
  async function create() {
    const doc = await api<Document>("/documents", "POST", {
      title: "Untitled",
      collectionId: collections.some((c) => c.id === selection)
        ? selection
        : null,
    });
    await open(doc.id);
  }
  async function patch(doc: Drawing, changes: object) {
    await api(`/documents/${doc.id}`, "PATCH", {
      revision: doc.revision,
      ...changes,
    });
    await refresh();
  }
  async function submitDialog() {
    if (!dialog || !dialog.value.trim()) return;
    await action(async () => {
      if (dialog.kind === "collection")
        await api("/collections", "POST", { name: dialog.value });
      if (dialog.kind === "rename-collection")
        await api(`/collections/${dialog.collection!.id}`, "PATCH", {
          name: dialog.value,
        });
      if (dialog.kind === "rename")
        await patch(dialog.doc!, { title: dialog.value });
      setDialog(null);
      await refresh();
    });
  }
  async function importFiles(files: FileList | null) {
    if (!files) return;
    await action(async () => {
      for (const file of Array.from(files)) {
        if (file.size > 32 * 1024 * 1024)
          throw new Error(`${file.name} exceeds the 32 MB upload limit.`);
        const scene = JSON.parse(await file.text());
        if (scene.type !== "excalidraw" || !Array.isArray(scene.elements))
          throw new Error(`${file.name} is not an Excalidraw drawing.`);
        await api("/documents", "POST", {
          title: file.name.replace(/\.excalidraw$|\.json$/i, ""),
          scene: {
            ...scene,
            appState: scene.appState || {},
            files: scene.files || {},
          },
          collectionId: collections.some((c) => c.id === selection)
            ? selection
            : null,
        });
      }
      await refresh();
    });
  }
  const visible = drawings
    .filter((doc) => {
      if (Boolean(doc.deleted) !== (selection === "trash")) return false;
      if (selection === "private" && doc.collectionId) return false;
      if (selection === "pinned" && !doc.pinned) return false;
      if (
        collections.some((c) => c.id === selection) &&
        doc.collectionId !== selection
      )
        return false;
      return doc.title.toLowerCase().includes(search.toLowerCase());
    })
    .sort((a, b) =>
      sort === "name"
        ? a.title.localeCompare(b.title)
        : b.pinned - a.pinned || b.updatedAt.localeCompare(a.updatedAt),
    );
  const heading = search
    ? "Search results"
    : (
        {
          dashboard: "Dashboard",
          private: "Private",
          pinned: "Pinned",
          trash: "Trash",
        } as Record<string, string>
      )[selection] ||
      collections.find((c) => c.id === selection)?.name ||
      "Dashboard";
  const activeCollection = collections.find((c) => c.id === selection);
  return (
    <div ref={host} className={`workspace ${theme}`}>
      {document ? (
        <Editor
          key={`${document.id}:${editorKey}`}
          doc={document}
          theme={theme}
          onExit={() => {
            setDocument(null);
            ownerWindow().history.replaceState(null, "", "/");
            void refresh().catch((e) => setError(e.message));
          }}
          onCopy={(doc) => {
            setDocument(doc);
            setEditorKey((k) => k + 1);
            ownerWindow().history.replaceState(null, "", `/drawing/${doc.id}`);
          }}
          onRefresh={() =>
            void open(document.id).catch((e) => setError(e.message))
          }
        />
      ) : (
        <>
          {sidebar && (
            <div className="sidebar-scrim" onClick={() => setSidebar(false)} />
          )}
          <aside className={`workspace-sidebar ${sidebar ? "open" : ""}`}>
            <div className="workspace-switcher">
              <span className="workspace-avatar">R</span>
              <strong>Ryan’s workspace</strong>
              <Icon name="lock" />
            </div>
            <div className="sidebar-content">
              <label className="quick-search">
                <Icon name="search" />
                <input
                  ref={searchInput}
                  aria-label="Quick search"
                  placeholder="Quick search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <kbd>⌘ P</kbd>
              </label>
              <nav aria-label="Workspace navigation">
                <button
                  className={selection === "dashboard" ? "active" : ""}
                  onClick={() => choose("dashboard")}
                >
                  <Icon name="dashboard" />
                  Dashboard
                </button>
                <button
                  className={selection === "pinned" ? "active" : ""}
                  onClick={() => choose("pinned")}
                >
                  <Icon name="pin" />
                  Pinned
                </button>
              </nav>
              <div className="collections-heading">
                <h2>Collections</h2>
                <button
                  className="small-primary"
                  aria-label="New collection"
                  title="New collection"
                  onClick={() =>
                    setDialog({
                      kind: "collection",
                      title: "New collection",
                      value: "",
                    })
                  }
                >
                  <Icon name="plus" />
                </button>
              </div>
              <nav aria-label="Collections">
                <button
                  className={selection === "private" ? "active" : ""}
                  onClick={() => choose("private")}
                >
                  <Icon name="lock" />
                  Private
                </button>
                <div className="collection-separator" />
                {collections.map((collection) => (
                  <button
                    key={collection.id}
                    className={selection === collection.id ? "active" : ""}
                    onClick={() => choose(collection.id)}
                  >
                    <Icon name="folder" />
                    <span>{collection.name}</span>
                  </button>
                ))}
                {!collections.length && (
                  <p className="sidebar-hint">
                    Keep your drawings organized
                    <br />
                    with collections.
                  </p>
                )}
              </nav>
              <nav className="trash-nav" aria-label="Trash">
                <button
                  className={selection === "trash" ? "active" : ""}
                  onClick={() => choose("trash")}
                >
                  <Icon name="trash" />
                  Trash
                </button>
              </nav>
            </div>
            <div className="user-footer">
              <span className="user-avatar">RL</span>
              <div>
                <strong>Ryan Latimer</strong>
                <span title={email}>{email || "Private workspace"}</span>
              </div>
              <button
                className="icon-button"
                aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}
                onClick={() => {
                  const next = theme === "light" ? "dark" : "light";
                  setTheme(next);
                  ownerWindow().localStorage.setItem("draw-theme", next);
                }}
              >
                <Icon name={theme === "light" ? "moon" : "sun"} />
              </button>
              <a
                className="icon-button"
                href="/cdn-cgi/access/logout"
                aria-label="Sign out"
                title="Sign out"
              >
                <Icon name="logout" />
              </a>
            </div>
          </aside>
          <main className="dashboard-main">
            <header className="dashboard-header">
              <div className="dashboard-title">
                <button
                  className="icon-button mobile-menu"
                  aria-label="Open navigation"
                  onClick={() => setSidebar(true)}
                >
                  <Icon name="menu" />
                </button>
                <h1>
                  <Icon
                    name={
                      selection === "dashboard"
                        ? "dashboard"
                        : selection === "private"
                        ? "lock"
                        : selection === "trash"
                        ? "trash"
                        : selection === "pinned"
                        ? "pin"
                        : "folder"
                    }
                  />
                  {heading}
                </h1>
                <p>
                  {selection === "trash"
                    ? "Deleted drawings stay here until you restore them."
                    : "Your ideas, saved and ready whenever you are."}
                </p>
              </div>
              <div className="header-actions">
                {selection !== "trash" && (
                  <>
                    <button
                      className="secondary-button import-button"
                      disabled={working}
                      onClick={() => importInput.current?.click()}
                    >
                      <Icon name="upload" />
                      Import
                    </button>
                    <button
                      className="primary-button"
                      disabled={working}
                      onClick={() => void action(create)}
                    >
                      <Icon name="draw" />
                      Start drawing
                    </button>
                  </>
                )}
                {activeCollection && (
                  <button
                    className="icon-button"
                    aria-label="Collection options"
                    onClick={() =>
                      setMenu(menu === "collection" ? null : "collection")
                    }
                  >
                    <Icon name="more" />
                  </button>
                )}
              </div>
              {menu === "collection" && activeCollection && (
                <div className="context-menu collection-menu">
                  <button
                    onClick={() => {
                      setDialog({
                        kind: "rename-collection",
                        title: "Rename collection",
                        value: activeCollection.name,
                        collection: activeCollection,
                      });
                      setMenu(null);
                    }}
                  >
                    <Icon name="pencil" />
                    Rename
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      if (
                        ownerWindow().confirm(
                          `Delete “${activeCollection.name}”? Its drawings will move to Private.`,
                        )
                      )
                        void action(async () => {
                          await api(
                            `/collections/${activeCollection.id}`,
                            "DELETE",
                          );
                          choose("private");
                          await refresh();
                        });
                    }}
                  >
                    <Icon name="trash" />
                    Delete collection
                  </button>
                </div>
              )}
            </header>
            {error && (
              <div className="workspace-error" role="alert">
                <span>{error}</span>
                <button
                  className="icon-button"
                  aria-label="Dismiss error"
                  onClick={() => setError("")}
                >
                  <Icon name="close" />
                </button>
              </div>
            )}
            <div className="section-heading">
              <h2>
                {selection === "dashboard" && !search
                  ? "Recently modified by you"
                  : `${visible.length} drawing${
                      visible.length === 1 ? "" : "s"
                    }`}
              </h2>
              <div>
                <select
                  aria-label="Sort drawings"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="modified">Last modified</option>
                  <option value="name">Name</option>
                </select>
                <button
                  className={`icon-button ${view === "grid" ? "selected" : ""}`}
                  aria-label="Grid view"
                  onClick={() => {
                    setView("grid");
                    ownerWindow().localStorage.setItem("draw-view", "grid");
                  }}
                >
                  <Icon name="grid" />
                </button>
                <button
                  className={`icon-button ${view === "list" ? "selected" : ""}`}
                  aria-label="List view"
                  onClick={() => {
                    setView("list");
                    ownerWindow().localStorage.setItem("draw-view", "list");
                  }}
                >
                  <Icon name="list" />
                </button>
              </div>
            </div>
            {loading ? (
              <div className="loading">Loading your workspace…</div>
            ) : visible.length ? (
              <div className={`drawings ${view}`}>
                {visible.map((doc) => (
                  <article
                    key={doc.id}
                    className={`drawing-card ${
                      menu === doc.id ? "menu-open" : ""
                    }`}
                  >
                    <button
                      className="drawing-preview"
                      aria-label={`Open ${doc.title}`}
                      disabled={Boolean(doc.deleted) || working}
                      onClick={() => void action(() => open(doc.id))}
                    >
                      <img
                        src={`/api/documents/${doc.id}/thumbnail?v=${doc.revision}`}
                        alt=""
                        loading="lazy"
                        onLoad={(e) => {
                          e.currentTarget.style.visibility = "visible";
                        }}
                        onError={(e) => {
                          e.currentTarget.style.visibility = "hidden";
                        }}
                      />
                      <span className="preview-placeholder">
                        <Icon name="draw" />
                      </span>
                      {Boolean(doc.pinned) && (
                        <span className="pinned-indicator">
                          <Icon name="pin" />
                        </span>
                      )}
                      <span className="modified-time">
                        {relativeTime(doc.updatedAt)}
                      </span>
                    </button>
                    <div className="drawing-info">
                      <button
                        className="drawing-name"
                        disabled={Boolean(doc.deleted) || working}
                        onClick={() => void action(() => open(doc.id))}
                      >
                        {doc.title}
                      </button>
                      <p>
                        {doc.collectionId
                          ? collections.find((c) => c.id === doc.collectionId)
                              ?.name
                          : "Private"}{" "}
                        · by you
                      </p>
                    </div>
                    <button
                      className="icon-button drawing-menu-button"
                      aria-label={`Options for ${doc.title}`}
                      aria-expanded={menu === doc.id}
                      onClick={() => setMenu(menu === doc.id ? null : doc.id)}
                    >
                      <Icon name="more" />
                    </button>
                    {menu === doc.id && (
                      <div className="context-menu drawing-context">
                        {doc.deleted ? (
                          <button
                            onClick={() =>
                              void action(() => patch(doc, { deleted: false }))
                            }
                          >
                            <Icon name="restore" />
                            Restore drawing
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={() => {
                                setDialog({
                                  kind: "rename",
                                  title: "Rename drawing",
                                  value: doc.title,
                                  doc,
                                });
                                setMenu(null);
                              }}
                            >
                              <Icon name="pencil" />
                              Rename
                            </button>
                            <button
                              onClick={() =>
                                void action(() =>
                                  patch(doc, { pinned: !doc.pinned }),
                                )
                              }
                            >
                              <Icon name="pin" />
                              {doc.pinned ? "Unpin" : "Pin"}
                            </button>
                            <button
                              onClick={() => {
                                setMoveId(doc.id);
                                setMenu(null);
                              }}
                            >
                              <Icon name="folder" />
                              Move to collection
                            </button>
                            <button
                              onClick={() =>
                                void action(async () => {
                                  const original = await api<Document>(
                                    `/documents/${doc.id}`,
                                  );
                                  await api("/documents", "POST", {
                                    title: `${original.title} (copy)`,
                                    scene: original.scene,
                                    collectionId: original.collectionId,
                                  });
                                  await refresh();
                                })
                              }
                            >
                              <Icon name="copy" />
                              Duplicate
                            </button>
                            <button
                              onClick={() =>
                                void action(async () =>
                                  download(
                                    await api<Document>(`/documents/${doc.id}`),
                                    ownerDocument(),
                                  ),
                                )
                              }
                            >
                              <Icon name="download" />
                              Download .excalidraw
                            </button>
                            <div className="menu-separator" />
                            <button
                              className="danger"
                              onClick={() =>
                                void action(() => patch(doc, { deleted: true }))
                              }
                            >
                              <Icon name="trash" />
                              Move to trash
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <span className="empty-illustration">
                  <Icon
                    name={
                      search
                        ? "search"
                        : selection === "trash"
                        ? "trash"
                        : "draw"
                    }
                  />
                </span>
                <h2>
                  {search
                    ? "No drawings found"
                    : selection === "trash"
                    ? "Your trash is empty"
                    : "A little space for your next big idea"}
                </h2>
                <p>
                  {search
                    ? "Try a different name or search another collection."
                    : selection === "trash"
                    ? "Drawings you delete will appear here."
                    : "Start a drawing or bring in an existing Excalidraw file."}
                </p>
                {!search && selection !== "trash" && (
                  <button
                    className="primary-button"
                    disabled={working}
                    onClick={() => void action(create)}
                  >
                    <Icon name="plus" />
                    Create your first drawing
                  </button>
                )}
              </div>
            )}
            <footer className="dashboard-footer">
              <span>
                <Icon name="lock" />
                Private · Synced across your devices
              </span>
              <span>Powered by Excalidraw</span>
            </footer>
          </main>
          <input
            ref={importInput}
            hidden
            type="file"
            accept=".excalidraw,.json"
            multiple
            onChange={(e) => {
              void importFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {menu && (
            <div className="menu-dismiss" onClick={() => setMenu(null)} />
          )}
          {(dialog || moveId) && (
            <div
              className="modal-backdrop"
              onClick={() => {
                setDialog(null);
                setMoveId(null);
              }}
            >
              <section
                className="workspace-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="dialog-title"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="icon-button modal-close"
                  aria-label="Close dialog"
                  onClick={() => {
                    setDialog(null);
                    setMoveId(null);
                  }}
                >
                  <Icon name="close" />
                </button>
                <h2 id="dialog-title">
                  {dialog?.title || "Move to collection"}
                </h2>
                {dialog ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void submitDialog();
                    }}
                  >
                    <label>
                      Name
                      <input
                        autoFocus
                        maxLength={200}
                        value={dialog.value}
                        onChange={(e) =>
                          setDialog({ ...dialog, value: e.target.value })
                        }
                      />
                    </label>
                    <div className="modal-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => setDialog(null)}
                      >
                        Cancel
                      </button>
                      <button
                        className="primary-button"
                        disabled={!dialog.value.trim() || working}
                      >
                        Save
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="collection-picker">
                    {[{ id: "", name: "Private" }, ...collections].map((c) => (
                      <button
                        key={c.id}
                        disabled={working}
                        onClick={() =>
                          void action(async () => {
                            const doc = drawings.find((d) => d.id === moveId)!;
                            await patch(doc, { collectionId: c.id || null });
                            setMoveId(null);
                          })
                        }
                      >
                        <Icon name={c.id ? "folder" : "lock"} />
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
