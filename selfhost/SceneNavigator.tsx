import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Collection, Drawing } from "./api";
import { Icon } from "./icons";

export function SceneNavigator({
  currentId,
  revision,
  onNavigate,
  onCreate,
  onDashboard,
  onError,
  focusSearch,
}: {
  currentId: string;
  revision: number;
  onNavigate: (id: string) => void;
  onCreate: () => void;
  onDashboard: () => void;
  onError: (error: string) => void;
  focusSearch: number;
}) {
  const [docs, setDocs] = useState<Drawing[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [query, setQuery] = useState("");
  const [collection, setCollection] = useState("all");
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let disposed = false;
    Promise.all([
      api<Drawing[]>("/documents"),
      api<Collection[]>("/collections"),
    ])
      .then(([docs, collections]) => {
        if (!disposed) {
          setDocs(docs);
          setCollections(collections);
        }
      })
      .catch((error) => onError(error.message));
    return () => {
      disposed = true;
    };
  }, [currentId, revision]);
  useEffect(() => {
    if (focusSearch) search.current?.focus();
  }, [focusSearch]);
  return (
    <aside className="scene-navigator" aria-label="Scene navigator">
      <button className="scene-workspace" onClick={onDashboard}>
        <span className="workspace-avatar">R</span>
        <strong>Ryan’s workspace</strong>
        <Icon name="down" />
      </button>
      <label className="quick-search">
        <Icon name="search" />
        <input
          ref={search}
          placeholder="Quick search"
          aria-label="Find a drawing"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <kbd>⌘ P</kbd>
      </label>
      <div className="scene-list-heading">
        <button onClick={onDashboard}>
          <Icon name="back" />
          Scenes
        </button>
        <button
          className="icon-button"
          aria-label="New drawing"
          onClick={onCreate}
        >
          <Icon name="plus" />
        </button>
      </div>
      <select
        className="scene-collection-filter"
        aria-label="Filter drawings by collection"
        value={collection}
        onChange={(e) => setCollection(e.target.value)}
      >
        <option value="all">All collections</option>
        <option value="private">Private</option>
        {collections.map((c) => (
          <option value={c.id} key={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <div className="scene-list">
        {docs
          .filter(
            (doc) =>
              !doc.deleted &&
              doc.title.toLowerCase().includes(query.toLowerCase()) &&
              (collection === "all" ||
                (collection === "private"
                  ? !doc.collectionId
                  : doc.collectionId === collection)),
          )
          .map((doc) => (
            <button
              key={doc.id}
              className={`scene-row ${currentId === doc.id ? "active" : ""}`}
              aria-label={`Switch to ${doc.title}`}
              aria-current={currentId === doc.id ? "page" : undefined}
              onClick={() => onNavigate(doc.id)}
            >
              <span className="scene-thumbnail">
                <img
                  src={`/api/documents/${doc.id}/thumbnail?v=${doc.revision}`}
                  alt=""
                  onError={(e) => {
                    e.currentTarget.style.visibility = "hidden";
                  }}
                  onLoad={(e) => {
                    e.currentTarget.style.visibility = "visible";
                  }}
                />
              </span>
              <span>
                <strong>{doc.title}</strong>
                <small>
                  {doc.collectionId
                    ? collections.find((c) => c.id === doc.collectionId)?.name
                    : "Private"}
                </small>
              </span>
              {Boolean(doc.pinned) && <Icon name="pin" />}
            </button>
          ))}
      </div>
      <button
        className="scene-dashboard"
        aria-label="Open workspace dashboard"
        onClick={onDashboard}
      >
        <Icon name="dashboard" />
        Back to dashboard
      </button>
    </aside>
  );
}
