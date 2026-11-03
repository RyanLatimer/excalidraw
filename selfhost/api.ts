export type Drawing = {
  id: string;
  title: string;
  collectionId: string | null;
  pinned: number;
  deleted: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type Collection = { id: string; name: string };
export type Scene = {
  elements: readonly import("@excalidraw/element/types").ExcalidrawElement[];
  appState: Partial<import("@excalidraw/excalidraw/types").AppState>;
  files: import("@excalidraw/excalidraw/types").BinaryFiles;
};
export type Document = Drawing & { scene: Scene; thumbnail: string };
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    redirect: "error",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 || response.status === 403)
    throw new ApiError(
      response.status,
      "Your session expired. Reload to sign in again; your draft is kept on this device.",
    );
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(response.status, value.error || "The request failed.");
  return value;
}
