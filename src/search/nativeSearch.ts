import type { WorkspaceLeaf } from "obsidian";

export interface NativeVaultFile { path: string; extension: string; }

/** The adapter is the only place that knows about Obsidian's unsupported Search internals. */
export type NativeSearchFailure =
  | "no-search-view"
  | "ambiguous-search-view"
  | "empty-query"
  | "loading"
  | "unsupported-shape"
  | "incomplete"
  | "unresolved-result"
  | "stale"
  | "empty-results";

export interface NativeSearchSnapshot {
  leaf: WorkspaceLeaf;
  viewIdentity: string;
  query: string;
  collectionIdentity: object;
  rawSignature: string;
  files: NativeVaultFile[];
  excludedNonMarkdown: string[];
}

export type NativeSearchRead =
  | { ok: true; snapshot: NativeSearchSnapshot }
  | { ok: false; reason: NativeSearchFailure; detail: string };

interface SearchViewShape {
  getViewType?: () => string;
  getQuery?: () => unknown;
  /** Obsidian 1.13.7's Search view owns this resolved-result collection. */
  dom?: SearchResultCollectionShape;
  queue?: unknown;
}

interface SearchResultCollectionShape {
  getFiles?: () => unknown;
}

interface SearchQueueShape {
  queue?: unknown;
}

interface ActiveSearchQueueShape {
  runnable?: { isRunning?: () => unknown };
}

interface LeafShape {
  id?: unknown;
  view?: SearchViewShape;
}

interface SearchApp {
  vault: {
    getAbstractFileByPath(path: string): unknown;
  };
}

interface SearchWorkspaceApp extends SearchApp {
  workspace: {
    getLeavesOfType(type: string): WorkspaceLeaf[];
  };
}

const viewIds = new WeakMap<object, string>();
const collectionIds = new WeakMap<object, string>();
let nextIdentity = 1;

function stableObjectId(value: object, ids: WeakMap<object, string>, prefix: string): string {
  const existing = ids.get(value);
  if (existing) return existing;
  const id = `${prefix}-${nextIdentity++}`;
  ids.set(value, id);
  return id;
}

function viewIdentity(leaf: WorkspaceLeaf, view: SearchViewShape): string {
  const explicit = (leaf as unknown as LeafShape).id;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return stableObjectId(view as object, viewIds, "search-view");
}

function collectionIdentity(view: SearchViewShape): SearchResultCollectionShape | null {
  return view.dom && typeof view.dom === "object" ? view.dom : null;
}

function readiness(view: SearchViewShape): "ready" | "loading" | "unsupported" {
  if (!view.queue || typeof view.queue !== "object") return "unsupported";
  const controller = view.queue as SearchQueueShape;
  if (!("queue" in controller)) return "unsupported";
  if (controller.queue === null || controller.queue === undefined) return "unsupported";
  if (typeof controller.queue !== "object") return "unsupported";
  const activeQueue = controller.queue as ActiveSearchQueueShape;
  if (!activeQueue.runnable || typeof activeQueue.runnable !== "object" || typeof activeQueue.runnable.isRunning !== "function") return "unsupported";
  const running = activeQueue.runnable.isRunning();
  return typeof running === "boolean" ? (running ? "loading" : "ready") : "unsupported";
}

function rawSignature(files: unknown[]): string {
  return JSON.stringify(files.map((file) => {
    if (!file || typeof file !== "object") return null;
    const candidate = file as { path?: unknown };
    return typeof candidate.path === "string" ? candidate.path : null;
  }));
}

function readFiles(collection: SearchResultCollectionShape): unknown[] | null {
  if (typeof collection.getFiles !== "function") return null;
  const files = collection.getFiles();
  return Array.isArray(files) ? files : null;
}

function safelyInspectView(app: SearchApp, leaf: WorkspaceLeaf): NativeSearchRead {
  try {
    return inspectView(app, leaf);
  } catch (error) {
    return { ok: false, reason: "unsupported-shape", detail: `The native Search shape could not be inspected: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function inspectView(app: SearchApp, leaf: WorkspaceLeaf): NativeSearchRead {
  const view = (leaf as unknown as LeafShape).view;
  if (!view || typeof view.getViewType !== "function" || view.getViewType() !== "search" || typeof view.getQuery !== "function") {
    return { ok: false, reason: "unsupported-shape", detail: "The leaf is not the validated native Search view shape." };
  }
  const query = view.getQuery();
  if (typeof query !== "string") return { ok: false, reason: "unsupported-shape", detail: "The native Search query is not a string." };
  if (query.trim().length === 0) return { ok: false, reason: "empty-query", detail: "An empty Search query does not authorize vault-wide capture." };
  const collection = collectionIdentity(view);
  if (!collection) return { ok: false, reason: "unsupported-shape", detail: "The validated Search result collection is unavailable." };
  const initialReadiness = readiness(view);
  if (initialReadiness === "loading") return { ok: false, reason: "loading", detail: "Native Search results are still resolving." };
  if (initialReadiness === "unsupported") return { ok: false, reason: "unsupported-shape", detail: "Native Search readiness cannot be established from the Search queue." };
  const first = readFiles(collection);
  if (!first) return { ok: false, reason: "unsupported-shape", detail: "The native Search complete-result accessor is unavailable." };
  const firstSignature = rawSignature(first);
  const second = readFiles(collection);
  if (!second || rawSignature(second) !== firstSignature || view.getQuery() !== query || readiness(view) !== "ready") {
    return { ok: false, reason: "stale", detail: "Native Search changed while its complete result set was being read." };
  }
  if (first.length === 0) return { ok: false, reason: "empty-results", detail: "The completed native Search has no results." };

  const files: NativeVaultFile[] = [];
  const excludedNonMarkdown: string[] = [];
  for (const entry of first) {
    if (!entry || typeof entry !== "object" || typeof (entry as { path?: unknown }).path !== "string") {
      return { ok: false, reason: "unresolved-result", detail: "A native Search result did not expose a vault-relative path." };
    }
    const path = (entry as { path: string }).path;
    const resolved = app.vault.getAbstractFileByPath(path);
    if (!resolved || typeof resolved !== "object" || typeof (resolved as NativeVaultFile).path !== "string" || typeof (resolved as NativeVaultFile).extension !== "string") return { ok: false, reason: "unresolved-result", detail: `Native Search result is not a current vault file: ${path}` };
    const vaultFile = resolved as NativeVaultFile;
    if (vaultFile.extension.toLowerCase() !== "md") excludedNonMarkdown.push(vaultFile.path);
    else if (!files.some((file) => file.path === vaultFile.path)) files.push(vaultFile);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, snapshot: { leaf, viewIdentity: viewIdentity(leaf, view), query, collectionIdentity: collection, rawSignature: firstSignature, files, excludedNonMarkdown: [...new Set(excludedNonMarkdown)].sort() } };
}

export function readNativeSearch(app: SearchApp, leaf: WorkspaceLeaf | null): NativeSearchRead {
  if (!leaf) return { ok: false, reason: "no-search-view", detail: "No Search view is active." };
  return safelyInspectView(app, leaf);
}

export function searchLeaves(app: { workspace: { getLeavesOfType(type: string): WorkspaceLeaf[] } }): WorkspaceLeaf[] {
  return app.workspace.getLeavesOfType("search");
}

export function chooseSearchLeaf(app: SearchApp & { workspace: { getLeavesOfType(type: string): WorkspaceLeaf[]; activeLeaf?: WorkspaceLeaf | null } }, invokingLeaf?: WorkspaceLeaf | null): NativeSearchRead {
  if (invokingLeaf) return readNativeSearch(app, invokingLeaf);
  const leaves = searchLeaves(app);
  if (leaves.length === 0) return { ok: false, reason: "no-search-view", detail: "No native Search view is open." };
  if (leaves.length > 1) return { ok: false, reason: "ambiguous-search-view", detail: "Multiple native Search views are open; invoke the action from one Search view." };
  return readNativeSearch(app, leaves[0]);
}

export function sameNativeSearchSnapshot(app: SearchWorkspaceApp, snapshot: NativeSearchSnapshot): NativeSearchRead {
  if (!app.workspace.getLeavesOfType("search").includes(snapshot.leaf)) {
    return { ok: false, reason: "stale", detail: "The originating native Search pane is no longer open." };
  }
  const current = safelyInspectView(app, snapshot.leaf);
  if (!current.ok) return current;
  if (current.snapshot.viewIdentity !== snapshot.viewIdentity || current.snapshot.query !== snapshot.query || current.snapshot.collectionIdentity !== snapshot.collectionIdentity || current.snapshot.rawSignature !== snapshot.rawSignature || JSON.stringify(current.snapshot.files.map((file) => file.path)) !== JSON.stringify(snapshot.files.map((file) => file.path))) {
    return { ok: false, reason: "stale", detail: "The native Search selection changed after preview." };
  }
  return current;
}
