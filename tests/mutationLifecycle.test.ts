import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeNotice {
  constructor(public message: string) {}
  hide(): void {}
}

vi.mock("obsidian", () => ({
  Plugin: class {},
  PluginSettingTab: class {},
  ItemView: class {},
  Modal: class {},
  Notice: FakeNotice,
  TFile: class {},
  TFolder: class {},
}));

vi.mock("../src/openai/client", () => ({
  streamResponse: vi.fn(async () => ({ output: "assistant", usage: null })),
}));

const { default: SynthesisTrayPlugin } = await import("../src/main");
const { SynthesisView } = await import("../src/view/SynthesisView");
const { streamResponse } = await import("../src/openai/client");

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

function thread() {
  return { id: "thread-1", title: "Thread", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", model: "gpt-5.6-luna" as const, reasoningEffort: "high" as const };
}

function makePlugin(): any {
  const currentThread = thread();
  const plugin = Object.create(SynthesisTrayPlugin.prototype) as any;
  plugin.app = {
    secretStorage: { getSecret: vi.fn(async () => "secret") },
    vault: { getAbstractFileByPath: () => null },
    metadataCache: { getFirstLinkpathDest: () => null },
    workspace: { getLeavesOfType: () => [], detachLeavesOfType: vi.fn() },
  };
  plugin.settings = { secretName: "openai", systemPrompt: "", maxOutputTokens: 100, verbosity: "low", promptCachingEnabled: false };
  plugin.state = {
    threads: [currentThread], messages: [], turns: [], turnUsage: [], sourceSnapshots: [], activeTray: [], previousTray: [],
    activeLinkedContext: { sources: [], selections: [] }, previousLinkedContext: { sources: [], selections: [] }, activeThreadId: currentThread.id,
  };
  plugin.database = {
    putThread: vi.fn(async () => undefined),
    setMeta: vi.fn(async () => undefined),
    commitTurn: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  plugin.initialization = Promise.resolve();
  plugin.mutationQueue = [];
  plugin.mutationDispatcherRunning = false;
  plugin.mutationShutdown = Promise.resolve();
  plugin.mutationAdmissionClosed = false;
  plugin.currentMutation = null;
  plugin.unloadPromise = null;
  plugin.unloading = false;
  plugin.activeSearchOperation = null;
  plugin.trayRevision = 0;
  plugin.conversationRevision = 0;
  plugin.lastError = null;
  plugin.refreshViews = vi.fn();
  return plugin;
}

describe("shared mutation lifecycle", () => {
  beforeEach(() => {
    vi.mocked(streamResponse).mockReset();
    vi.mocked(streamResponse).mockImplementation(async () => ({ output: "assistant", usage: null }));
  });

  it("returns null for a queued Send commit and preserves the draft state", async () => {
    const plugin = makePlugin();
    const blocker = deferred<void>();
    const active = plugin.enqueueMutation((mutation: any) => mutation.persist(() => blocker.promise).then(() => undefined));
    const sendPromise = plugin.send("draft", () => undefined);
    await Promise.resolve();
    const unloadPromise = plugin.onunload();

    expect(await sendPromise).toBeNull();
    expect(plugin.database.commitTurn).not.toHaveBeenCalled();
    expect(plugin.state.messages).toEqual([]);
    expect(plugin.state.turns).toEqual([]);
    expect(plugin.state.sourceSnapshots).toEqual([]);

    blocker.resolve(undefined);
    await Promise.all([active, unloadPromise]);
    expect(plugin.database.commitTurn).not.toHaveBeenCalled();
  });

  it("does not publish a direct thread update after unload invalidates pre-publication state", async () => {
    const plugin = makePlugin();
    const write = deferred<void>();
    plugin.database.putThread = vi.fn(() => write.promise);
    const original = plugin.state.threads[0];
    const update = plugin.updateThreadInference(original.id, "gpt-6-luna", "max");
    for (let attempt = 0; attempt < 20 && plugin.database.putThread.mock.calls.length === 0; attempt += 1) await Promise.resolve();
    const unloadPromise = plugin.onunload();
    write.resolve(undefined);
    await Promise.all([update, unloadPromise]);
    expect(plugin.state.threads[0]).toEqual(original);
    expect(plugin.refreshViews).not.toHaveBeenCalled();
  });

  it("retains the prior thread state when direct persistence fails", async () => {
    const plugin = makePlugin();
    const original = plugin.state.threads[0];
    plugin.database.putThread = vi.fn(async () => { throw new Error("disk full"); });
    await expect(plugin.renameThread(original.id, "Renamed")).rejects.toThrow("disk full");
    expect(plugin.state.threads[0]).toEqual(original);
    expect(plugin.refreshViews).not.toHaveBeenCalled();
  });

  it("waits for database initialization before closing storage", async () => {
    const plugin = makePlugin();
    const loaded = deferred<any>();
    plugin.database.load = vi.fn(() => loaded.promise);
    const initialization = plugin.initialize();
    plugin.initialization = initialization;
    const unloadPromise = plugin.onunload();
    await Promise.resolve();
    expect(plugin.database.close).not.toHaveBeenCalled();
    loaded.resolve({ ...plugin.state });
    await Promise.all([initialization, unloadPromise]);
    expect(plugin.database.close).toHaveBeenCalledOnce();
  });

  it("makes repeated unload idempotent", async () => {
    const plugin = makePlugin();
    const first = plugin.onunload();
    const second = plugin.onunload();
    await Promise.all([first, second]);
    expect(plugin.database.close).toHaveBeenCalledOnce();
  });

  it("suppresses a late provider delta and completion after unload", async () => {
    const plugin = makePlugin();
    const response = deferred<{ output: string; usage: null }>();
    let providerDelta: ((delta: string) => void) | undefined;
    vi.mocked(streamResponse).mockImplementationOnce(async (...args) => {
      const callbacks = args[2];
      if (!callbacks) throw new Error("stream callback contract was not supplied");
      providerDelta = callbacks.onDelta;
      return response.promise;
    });
    const onDelta = vi.fn();
    const sendPromise = plugin.send("draft", onDelta);
    for (let attempt = 0; attempt < 20 && !providerDelta; attempt += 1) await Promise.resolve();
    expect(providerDelta).toBeDefined();

    const unloadPromise = plugin.onunload();
    providerDelta!("late");
    response.resolve({ output: "assistant", usage: null });

    await Promise.all([sendPromise, unloadPromise]);
    expect(onDelta).not.toHaveBeenCalled();
    expect(plugin.database.commitTurn).not.toHaveBeenCalled();
    expect(plugin.state.messages).toEqual([]);
    expect(plugin.state.turns).toEqual([]);
    expect(plugin.state.sourceSnapshots).toEqual([]);
    expect(plugin.refreshViews).not.toHaveBeenCalled();
  });

  it("suppresses a late provider failure after unload", async () => {
    const plugin = makePlugin();
    const response = deferred<{ output: string; usage: null }>();
    let providerDelta: ((delta: string) => void) | undefined;
    vi.mocked(streamResponse).mockImplementationOnce(async (_secret, _request, callbacks) => {
      providerDelta = callbacks.onDelta;
      return response.promise;
    });
    const sendPromise = plugin.send("draft", vi.fn());
    for (let attempt = 0; attempt < 20 && !providerDelta; attempt += 1) await Promise.resolve();
    const unloadPromise = plugin.onunload();
    response.reject(new Error("late provider failure"));

    expect(await sendPromise).toBeNull();
    await unloadPromise;
    expect(plugin.lastError).toBeNull();
    expect(plugin.database.commitTurn).not.toHaveBeenCalled();
    expect(plugin.refreshViews).not.toHaveBeenCalled();
  });

  it("preserves the normal loaded-state streaming and commit path", async () => {
    const plugin = makePlugin();
    const response = deferred<{ output: string; usage: null }>();
    let providerDelta: ((delta: string) => void) | undefined;
    vi.mocked(streamResponse).mockImplementationOnce(async (_secret, _request, callbacks) => {
      providerDelta = callbacks.onDelta;
      return response.promise;
    });
    const onDelta = vi.fn();
    const sendPromise = plugin.send("draft", onDelta);
    for (let attempt = 0; attempt < 20 && !providerDelta; attempt += 1) await Promise.resolve();
    providerDelta!("live");
    response.resolve({ output: "assistant", usage: null });

    const completed = await sendPromise;
    expect(completed).not.toBeNull();
    expect(onDelta).toHaveBeenCalledWith("live");
    expect(plugin.database.commitTurn).toHaveBeenCalledOnce();
    expect(plugin.state.messages).toHaveLength(2);
    expect(plugin.state.turns).toHaveLength(1);
  });

  it("invalidates provider callbacks when the user stops a request", async () => {
    const plugin = makePlugin();
    const response = deferred<{ output: string; usage: null }>();
    let providerDelta: ((delta: string) => void) | undefined;
    vi.mocked(streamResponse).mockImplementationOnce(async (_secret, _request, callbacks) => {
      providerDelta = callbacks.onDelta;
      return response.promise;
    });
    const onDelta = vi.fn();
    const sendPromise = plugin.send("draft", onDelta);
    for (let attempt = 0; attempt < 20 && !providerDelta; attempt += 1) await Promise.resolve();
    plugin.stopRequest();
    providerDelta!("stale");
    response.resolve({ output: "assistant", usage: null });

    expect(await sendPromise).toBeNull();
    expect(onDelta).not.toHaveBeenCalled();
    expect(plugin.database.commitTurn).not.toHaveBeenCalled();
  });

  it("does not let stale cleanup clear a newer Send operation", async () => {
    const plugin = makePlugin();
    const firstResponse = deferred<{ output: string; usage: null }>();
    const secondResponse = deferred<{ output: string; usage: null }>();
    let firstDelta: ((delta: string) => void) | undefined;
    let secondDelta: ((delta: string) => void) | undefined;
    vi.mocked(streamResponse)
      .mockImplementationOnce(async (_secret, _request, callbacks) => {
        firstDelta = callbacks.onDelta;
        return firstResponse.promise;
      })
      .mockImplementationOnce(async (_secret, _request, callbacks) => {
        secondDelta = callbacks.onDelta;
        return secondResponse.promise;
      });
    const firstSend = plugin.send("first", vi.fn());
    for (let attempt = 0; attempt < 20 && !firstDelta; attempt += 1) await Promise.resolve();
    plugin.stopRequest();
    const secondSend = plugin.send("second", vi.fn());
    for (let attempt = 0; attempt < 20 && !secondDelta; attempt += 1) await Promise.resolve();
    firstResponse.resolve({ output: "stale", usage: null });
    expect(await firstSend).toBeNull();
    secondDelta!("current");
    secondResponse.resolve({ output: "current", usage: null });

    expect(await secondSend).not.toBeNull();
    expect(plugin.database.commitTurn).toHaveBeenCalledOnce();
  });

  it("invalidates a SynthesisView callback and finalizer when the view closes", async () => {
    const response = deferred<{ id: string } | null>();
    let providerDelta: ((delta: string) => void) | undefined;
    const plugin = {
      isSendLifecycleLive: () => true,
      send: vi.fn(async (_draft: string, callback: (delta: string) => void) => {
        providerDelta = callback;
        return response.promise;
      }),
    };
    const view = Object.create(SynthesisView.prototype) as any;
    view.plugin = plugin;
    view.draft = "draft";
    view.draftElement = { value: "draft" };
    view.conversationElement = {};
    view.trayElement = {};
    view.streaming = false;
    view.streamedAssistant = "";
    view.mounted = true;
    view.requestGeneration = 0;
    view.render = vi.fn();

    const sendPromise = view.send();
    for (let attempt = 0; attempt < 20 && !providerDelta; attempt += 1) await Promise.resolve();
    expect(providerDelta).toBeDefined();
    await view.onClose();
    providerDelta!("late");
    response.resolve({ id: "turn-1" });
    await sendPromise;

    expect(view.render).toHaveBeenCalledOnce();
    expect(view.streamedAssistant).toBe("");
    expect(view.streaming).toBe(true);
  });
});
