import { beforeEach, describe, expect, it, vi } from "vitest";
import { countSerializedTrayTokens } from "../src/tokens/tokenizer";

class FakeElement {
  children: FakeElement[] = [];
  textContent = "";
  type = "";
  disabled = false;
  onclick: (() => void) | null = null;
  private listeners = new Map<string, Set<() => void>>();

  append(...children: unknown[]): void { this.children.push(...children.filter((child): child is FakeElement => child instanceof FakeElement)); }
  createDiv(): FakeElement { const child = new FakeElement(); this.children.push(child); return child; }
  createEl(_tag: string, options?: { text?: string; cls?: string }): FakeElement { const child = new FakeElement(); child.textContent = options?.text ?? ""; this.children.push(child); return child; }
  setAttribute(): void {}
  addEventListener(name: string, listener: () => void): void { const listeners = this.listeners.get(name) ?? new Set<() => void>(); listeners.add(listener); this.listeners.set(name, listeners); }
  removeEventListener(name: string, listener: () => void): void { this.listeners.get(name)?.delete(listener); }
  remove(): void {}
  click(): void { this.onclick?.(); for (const listener of this.listeners.get("click") ?? []) listener(); }
}

class FakeNotice {
  static instances: FakeNotice[] = [];
  readonly messageEl = new FakeElement();
  hidden = false;
  constructor(public message: string, public duration?: number) { FakeNotice.instances.push(this); this.messageEl.textContent = message; }
  setMessage(message: string): void { this.message = message; this.messageEl.textContent = message; }
  hide(): void { this.hidden = true; }
}

class FakeModal {
  static instances: FakeModal[] = [];
  readonly contentEl = new FakeElement();
  constructor(public app: unknown) { FakeModal.instances.push(this); }
  setTitle(): this { return this; }
  open(): void { (this as unknown as { onOpen?: () => void }).onOpen?.(); }
  close(): void { (this as unknown as { onClose?: () => void }).onClose?.(); }
}

vi.mock("obsidian", () => ({
  Plugin: class {},
  PluginSettingTab: class {},
  ItemView: class {},
  Modal: FakeModal,
  Notice: FakeNotice,
  TFile: class {},
  TFolder: class {},
}));

const { default: SynthesisTrayPlugin } = await import("../src/main");

interface TestPlugin {
  app: any;
  state: any;
  database: any;
  initialization: Promise<void>;
  trayRevision: number;
  mutationQueue: any[];
  mutationDispatcherRunning: boolean;
  mutationAdmissionClosed: boolean;
  mutationShutdown: Promise<void>;
  currentMutation: unknown;
  unloadPromise: Promise<void> | null;
  unloading: boolean;
  activeSearchOperation: unknown;
  ready: () => Promise<void>;
  tokenBreakdown: () => { total: number };
  refreshViews: ReturnType<typeof vi.fn>;
  enqueueMutation: (operation: (mutation: any) => Promise<void>) => Promise<string>;
  addAllSearchResults: (leaf?: unknown) => Promise<void>;
  onunload: () => Promise<void>;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

async function expectSettles<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), 100); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not settle");
}

function searchLeaf(path = "a.md"): any {
  const file = { path, extension: "md" };
  const searchState = { query: "tag:note", files: [file] };
  return {
    id: "search-leaf",
    view: {
      getViewType: () => "search",
      getQuery: () => searchState.query,
      dom: { getFiles: () => searchState.files },
      queue: { queue: { runnable: { isRunning: () => false } } },
    },
    file,
    searchState,
  };
}

function makePlugin(read: (file: { path: string }) => Promise<string> = async () => "# note"): TestPlugin {
  const file = { path: "a.md", extension: "md" };
  const plugin = Object.create(SynthesisTrayPlugin.prototype) as TestPlugin;
  const openSearchLeaves: unknown[] = [];
  plugin.app = {
    vault: { getAbstractFileByPath: (path: string) => path === file.path ? file : null, read },
    metadataCache: { getFirstLinkpathDest: () => null },
    workspace: { getLeavesOfType: () => openSearchLeaves, detachLeavesOfType: vi.fn(), activeLeaf: null },
  };
  plugin.state = { activeTray: [], previousTray: [], activeLinkedContext: { sources: [], selections: [] }, previousLinkedContext: { sources: [], selections: [] }, activeThreadId: null, threads: [] };
  plugin.database = { setMeta: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  plugin.initialization = Promise.resolve();
  plugin.trayRevision = 0;
  plugin.mutationQueue = [];
  plugin.mutationDispatcherRunning = false;
  plugin.mutationAdmissionClosed = false;
  plugin.mutationShutdown = Promise.resolve();
  plugin.currentMutation = null;
  plugin.unloadPromise = null;
  plugin.unloading = false;
  plugin.activeSearchOperation = null;
  plugin.ready = async () => undefined;
  plugin.tokenBreakdown = () => ({ total: 0 });
  plugin.refreshViews = vi.fn();
  const addAllSearchResults = plugin.addAllSearchResults;
  plugin.addAllSearchResults = (invokingLeaf?: unknown) => {
    plugin.app.workspace.activeLeaf = invokingLeaf ?? null;
    if (invokingLeaf && !openSearchLeaves.includes(invokingLeaf)) openSearchLeaves.push(invokingLeaf);
    return addAllSearchResults.call(plugin, invokingLeaf);
  };
  return plugin;
}

function latestModal(): FakeModal {
  return FakeModal.instances.at(-1)!;
}

async function waitForModal(): Promise<FakeModal> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const modal = FakeModal.instances.at(-1);
    if (modal) return modal;
    await Promise.resolve();
  }
  throw new Error("Search confirmation did not open");
}

function clickModalAction(modal: FakeModal, label: string): void {
  const button = modal.contentEl.children.flatMap((child) => child.children).find((child) => child.textContent === label);
  expect(button).toBeDefined();
  button!.click();
}

describe("Search import lifecycle", () => {
  beforeEach(() => {
    FakeNotice.instances = [];
    FakeModal.instances = [];
    (globalThis as any).document = { createElement: () => new FakeElement() };
  });

  it("reserves the operation before ready and closes the database only after unload invalidates it", async () => {
    const ready = deferred<void>();
    const plugin = makePlugin();
    plugin.ready = () => ready.promise;
    const importPromise = plugin.addAllSearchResults(searchLeaf());
    const unloadPromise = plugin.onunload();
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    ready.resolve(undefined);
    await Promise.all([importPromise, unloadPromise]);
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    expect(plugin.database.close).toHaveBeenCalledOnce();
    expect(FakeNotice.instances).toHaveLength(0);
  });

  it("keeps Cancel attached during preparation longer than the default Notice lifetime", async () => {
    const read = deferred<string>();
    const plugin = makePlugin(() => read.promise);
    const importPromise = plugin.addAllSearchResults(searchLeaf());
    await Promise.resolve();
    const progress = FakeNotice.instances[0];
    expect(progress.duration).toBe(0);
    const cancel = progress.messageEl.children[0];
    expect(cancel).toBeDefined();
    cancel.click();
    read.resolve("# note");
    await importPromise;
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    expect(progress.hidden).toBe(true);
  });

  it("aborts and cleans up preparation during unload without opening confirmation", async () => {
    const read = deferred<string>();
    const plugin = makePlugin(() => read.promise);
    const importPromise = plugin.addAllSearchResults(searchLeaf());
    await Promise.resolve();
    const progress = FakeNotice.instances[0];
    const unloadPromise = plugin.onunload();
    expect(FakeModal.instances).toHaveLength(0);
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    read.resolve("# note");
    await Promise.all([importPromise, unloadPromise]);
    expect(progress.hidden).toBe(true);
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    expect(plugin.database.close).toHaveBeenCalledOnce();
  });

  it("settles Cancel while preparation read remains unresolved and suppresses late effects", async () => {
    const read = deferred<string>();
    const plugin = makePlugin(() => read.promise);
    const importPromise = plugin.addAllSearchResults(searchLeaf());
    await Promise.resolve();
    const progress = FakeNotice.instances[0];
    progress.messageEl.children[0].click();

    await expectSettles(importPromise);
    expect(FakeModal.instances).toHaveLength(0);
    expect(progress.hidden).toBe(true);
    expect(plugin.state.activeTray).toEqual([]);
    expect(plugin.trayRevision).toBe(0);
    expect(plugin.database.setMeta).not.toHaveBeenCalled();

    read.resolve("late content");
    await Promise.resolve();
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    expect(plugin.refreshViews).not.toHaveBeenCalled();
  });

  it("settles unload and closes the database while preparation read remains unresolved", async () => {
    const read = deferred<string>();
    const plugin = makePlugin(() => read.promise);
    const importPromise = plugin.addAllSearchResults(searchLeaf());
    await Promise.resolve();
    const unloadPromise = plugin.onunload();

    await expectSettles(Promise.all([importPromise, unloadPromise]));
    expect(FakeModal.instances).toHaveLength(0);
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    expect(plugin.database.close).toHaveBeenCalledOnce();

    read.reject(new Error("late read failure"));
    await Promise.resolve();
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    expect(plugin.refreshViews).not.toHaveBeenCalled();
  });

  it("closes an open confirmation as Cancel during unload", async () => {
    const plugin = makePlugin();
    const importPromise = plugin.addAllSearchResults(searchLeaf());
    await waitForModal();
    expect(FakeModal.instances).toHaveLength(1);
    const unloadPromise = plugin.onunload();
    await Promise.all([importPromise, unloadPromise]);
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    expect(plugin.database.close).toHaveBeenCalledOnce();
  });

  it("skips a queued mutation admitted before unload but not yet started", async () => {
    const earlier = deferred<void>();
    const plugin = makePlugin();
    const active = plugin.enqueueMutation((mutation) => mutation.persist(() => earlier.promise).then(() => undefined));
    const importPromise = plugin.addAllSearchResults(searchLeaf());
    clickModalAction(await waitForModal(), "Add 1 notes");
    await Promise.resolve();
    const unloadPromise = plugin.onunload();
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    earlier.resolve(undefined);
    await Promise.all([active, importPromise, unloadPromise]);
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
  });

  it("settles queued Search work behind an unresolved pre-persistence mutation", async () => {
    const read = deferred<void>();
    const plugin = makePlugin();
    const active = plugin.enqueueMutation(async (mutation) => {
      await read.promise;
      if (!mutation.isLive()) return;
      const persisted = await mutation.persist(async () => undefined);
      expect(persisted).toBe(true);
    });
    const importPromise = plugin.addAllSearchResults(searchLeaf());
    clickModalAction(await waitForModal(), "Add 1 notes");
    const unloadPromise = plugin.onunload();
    await expectSettles(Promise.all([importPromise, unloadPromise]));
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    read.resolve(undefined);
    await active;
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
  });

  it("waits for database.setMeta after persistence has started and suppresses stale UI", async () => {
    const write = deferred<void>();
    const plugin = makePlugin();
    plugin.database.setMeta = vi.fn(() => write.promise);
    const importPromise = plugin.addAllSearchResults(searchLeaf());
    clickModalAction(await waitForModal(), "Add 1 notes");
    await waitForCondition(() => plugin.database.setMeta.mock.calls.length > 0);
    expect(plugin.database.setMeta).toHaveBeenCalledOnce();
    const unloadPromise = plugin.onunload();
    await Promise.resolve();
    expect(plugin.database.close).not.toHaveBeenCalled();
    write.resolve(undefined);
    await Promise.all([importPromise, unloadPromise]);
    expect(plugin.database.close).toHaveBeenCalledOnce();
    expect(plugin.trayRevision).toBe(0);
    expect(plugin.refreshViews).not.toHaveBeenCalled();
  });

  it("commits one mutation on normal success and ignores a repeated invocation", async () => {
    const plugin = makePlugin();
    const first = plugin.addAllSearchResults(searchLeaf());
    const second = plugin.addAllSearchResults(searchLeaf());
    clickModalAction(await waitForModal(), "Add 1 notes");
    await Promise.all([first, second]);
    expect(plugin.database.setMeta).toHaveBeenCalledOnce();
    expect(plugin.trayRevision).toBe(1);
    expect(plugin.refreshViews).toHaveBeenCalledOnce();
  });

  it("invalidates preparation when the native Search query changes", async () => {
    const read = deferred<string>();
    const leaf = searchLeaf();
    const plugin = makePlugin(() => read.promise);
    const importPromise = plugin.addAllSearchResults(leaf);
    await Promise.resolve();
    leaf.searchState.query = "path:changed";
    read.resolve("# note");
    await importPromise;
    expect(FakeModal.instances).toHaveLength(0);
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    expect(FakeNotice.instances.at(-1)?.message).toContain("Search preview is stale");
  });

  it("invalidates preparation when the active tray revision changes", async () => {
    const read = deferred<string>();
    const plugin = makePlugin(() => read.promise);
    const importPromise = plugin.addAllSearchResults(searchLeaf());
    await Promise.resolve();
    plugin.trayRevision = 1;
    read.resolve("# note");
    await importPromise;
    expect(FakeModal.instances).toHaveLength(0);
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    expect(FakeNotice.instances.at(-1)?.message).toContain("tray changed");
  });

  it("invalidates preparation when a selected source changes before confirmation", async () => {
    let reads = 0;
    const plugin = makePlugin(async () => reads++ === 0 ? "# original" : "# changed");
    const importPromise = plugin.addAllSearchResults(searchLeaf());
    await importPromise;
    expect(FakeModal.instances).toHaveLength(0);
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    expect(FakeNotice.instances.at(-1)?.message).toContain("content changed");
  });

  it("invalidates preparation when a selected source disappears before confirmation", async () => {
    const read = deferred<string>();
    const plugin = makePlugin(() => read.promise);
    const importPromise = plugin.addAllSearchResults(searchLeaf());
    await Promise.resolve();
    plugin.app.vault.getAbstractFileByPath = () => null;
    read.resolve("# note");
    await importPromise;
    expect(FakeModal.instances).toHaveLength(0);
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    expect(FakeNotice.instances.at(-1)?.message).toContain("source changed before commit");
  });

  it("invalidates preparation when a selected source loses Markdown eligibility", async () => {
    const read = deferred<string>();
    const plugin = makePlugin(() => read.promise);
    const importPromise = plugin.addAllSearchResults(searchLeaf());
    await Promise.resolve();
    plugin.app.vault.getAbstractFileByPath = () => ({ path: "a.md", extension: "pdf" });
    read.resolve("# note");
    await importPromise;
    expect(FakeModal.instances).toHaveLength(0);
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    expect(FakeNotice.instances.at(-1)?.message).toContain("source changed before commit");
  });

  it("invalidates preparation when a selected source becomes unreadable", async () => {
    let reads = 0;
    const plugin = makePlugin(async () => {
      if (reads++ > 0) throw new Error("read failed");
      return "# note";
    });
    const importPromise = plugin.addAllSearchResults(searchLeaf());
    await importPromise;
    expect(FakeModal.instances).toHaveLength(0);
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    expect(FakeNotice.instances.at(-1)?.message).toContain("read failed");
  });

  it("cancels an open confirmation when Search changes and does not commit", async () => {
    const leaf = searchLeaf();
    const plugin = makePlugin();
    const importPromise = plugin.addAllSearchResults(leaf);
    const modal = await waitForModal();
    leaf.searchState.files = [{ path: "other.md", extension: "md" }];
    clickModalAction(modal, "Add 1 notes");
    await importPromise;
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    expect(plugin.refreshViews).not.toHaveBeenCalled();
    expect(FakeNotice.instances.at(-1)?.message).toContain("Search preview is stale");
  });

  it("cancels an open confirmation when the originating Search pane closes", async () => {
    const plugin = makePlugin();
    const leaf = searchLeaf();
    const importPromise = plugin.addAllSearchResults(leaf);
    const modal = await waitForModal();
    plugin.app.workspace.getLeavesOfType = () => [];
    clickModalAction(modal, "Add 1 notes");
    await importPromise;
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    expect(plugin.state.activeTray).toEqual([]);
    expect(plugin.trayRevision).toBe(0);
    expect(FakeNotice.instances.at(-1)?.message).toContain("originating native Search pane is no longer open");
  });

  it("uses the committed outgoing-wikilink representation for preview token accounting", async () => {
    const plugin = makePlugin(async () => "# note\n[[Destination]]");
    const destination = { path: "Destination.md", extension: "md" };
    plugin.app.metadataCache.getFirstLinkpathDest = (target: string) => target === "Destination" ? destination : null;
    const importPromise = plugin.addAllSearchResults(searchLeaf());
    const modal = await waitForModal();
    const preview = modal.contentEl.children[0]?.textContent ?? "";
    const estimate = Number(preview.match(/Estimated additional tray tokens: \+(\d+)/)?.[1]);
    clickModalAction(modal, "Add 1 notes");
    await importPromise;
    const committedTray = plugin.database.setMeta.mock.calls[0][0];
    const committedDelta = countSerializedTrayTokens(committedTray, plugin.state.activeLinkedContext) - countSerializedTrayTokens([], plugin.state.activeLinkedContext);
    expect(estimate).toBe(committedDelta);
    expect(committedTray[0].outgoingWikilinks).toEqual([expect.objectContaining({ destinationPath: "Destination.md" })]);
  });

  it("cancels an open confirmation when a source becomes unreadable", async () => {
    let fail = false;
    const plugin = makePlugin(async () => {
      if (fail) throw new Error("read failed");
      return "# note";
    });
    const importPromise = plugin.addAllSearchResults(searchLeaf());
    const modal = await waitForModal();
    fail = true;
    clickModalAction(modal, "Add 1 notes");
    await importPromise;
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    expect(FakeNotice.instances.at(-1)?.message).toContain("read failed");
  });

  it("cancels an open confirmation when the active tray changes", async () => {
    const plugin = makePlugin();
    const importPromise = plugin.addAllSearchResults(searchLeaf());
    const modal = await waitForModal();
    plugin.trayRevision = 1;
    clickModalAction(modal, "Add 1 notes");
    await importPromise;
    expect(plugin.database.setMeta).not.toHaveBeenCalled();
    expect(FakeNotice.instances.at(-1)?.message).toContain("tray changed");
  });
});
