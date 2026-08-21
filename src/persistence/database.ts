import { cloneTray } from "../state/tray";
import { newId, nowIso } from "../state/ids";
import { Message, PersistedState, SourceSnapshot, Thread, TrayItem, Turn } from "../state/types";

const DB_VERSION = 1;
const STORE_NAMES = ["threads", "messages", "turns", "sourceSnapshots", "meta"] as const;
type StoreName = typeof STORE_NAMES[number];

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export class SynthesisDatabase {
  private db: IDBDatabase | null = null;

  constructor(private readonly vaultNamespace: string) {}

  async open(): Promise<void> {
    if (this.db) return;
    const request = indexedDB.open(`obsidian-synthesis-tray:${this.vaultNamespace}`, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORE_NAMES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: "id" });
      }
    };
    this.db = await requestResult(request);
  }

  private requireDb(): IDBDatabase {
    if (!this.db) throw new Error("Synthesis database has not been opened");
    return this.db;
  }

  async load(): Promise<PersistedState> {
    await this.open();
    const transaction = this.requireDb().transaction([...STORE_NAMES], "readonly");
    const [threads, messages, turns, sourceSnapshots, activeTray, previousTray, activeThreadId] = await Promise.all([
      requestResult(transaction.objectStore("threads").getAll()),
      requestResult(transaction.objectStore("messages").getAll()),
      requestResult(transaction.objectStore("turns").getAll()),
      requestResult(transaction.objectStore("sourceSnapshots").getAll()),
      requestResult(transaction.objectStore("meta").get("activeTray")),
      requestResult(transaction.objectStore("meta").get("previousTray")),
      requestResult(transaction.objectStore("meta").get("activeThreadId")),
    ]);
    const orderedTurns = (turns as Turn[]).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const orderedMessages = (messages as Message[]).slice().sort((a, b) => {
      const turnOrder = orderedTurns.findIndex((turn) => turn.id === a.turnId) - orderedTurns.findIndex((turn) => turn.id === b.turnId);
      if (turnOrder !== 0) return turnOrder;
      if (a.turnId !== b.turnId) return a.turnId.localeCompare(b.turnId);
      return a.role === "user" ? -1 : 1;
    });
    const orderedSources = (sourceSnapshots as SourceSnapshot[]).slice().sort((a, b) => {
      const turnOrder = orderedTurns.findIndex((turn) => turn.id === a.turnId) - orderedTurns.findIndex((turn) => turn.id === b.turnId);
      return turnOrder || a.sourceIndex - b.sourceIndex;
    });
    return {
      threads: threads as Thread[],
      messages: orderedMessages,
      turns: orderedTurns,
      sourceSnapshots: orderedSources,
      activeTray: cloneTray((activeTray as { value?: TrayItem[] } | undefined)?.value ?? []),
      previousTray: cloneTray((previousTray as { value?: TrayItem[] } | undefined)?.value ?? []),
      activeThreadId: (activeThreadId as { value?: string | null } | undefined)?.value ?? null,
    };
  }

  async setMeta(activeTray: TrayItem[], previousTray: TrayItem[], activeThreadId: string | null): Promise<void> {
    await this.open();
    const transaction = this.requireDb().transaction("meta", "readwrite");
    const meta = transaction.objectStore("meta");
    meta.put({ id: "activeTray", value: cloneTray(activeTray) });
    meta.put({ id: "previousTray", value: cloneTray(previousTray) });
    meta.put({ id: "activeThreadId", value: activeThreadId });
    await transactionComplete(transaction);
  }

  async commitTurn(thread: Thread, user: Message, assistant: Message, turn: Turn, sources: SourceSnapshot[], tray: TrayItem[]): Promise<void> {
    await this.open();
    const transaction = this.requireDb().transaction([...STORE_NAMES], "readwrite");
    transaction.objectStore("threads").put(thread);
    transaction.objectStore("messages").put(user);
    transaction.objectStore("messages").put(assistant);
    transaction.objectStore("turns").put(turn);
    for (const source of sources) transaction.objectStore("sourceSnapshots").put(source);
    transaction.objectStore("meta").put({ id: "previousTray", value: cloneTray(tray) });
    transaction.objectStore("meta").put({ id: "activeTray", value: [] });
    await transactionComplete(transaction);
  }

  async putThread(thread: Thread): Promise<void> {
    await this.open();
    const transaction = this.requireDb().transaction("threads", "readwrite");
    transaction.objectStore("threads").put(thread);
    await transactionComplete(transaction);
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.open();
    const transaction = this.requireDb().transaction([...STORE_NAMES], "readwrite");
    transaction.objectStore("threads").delete(threadId);
    const messages = await requestResult(transaction.objectStore("messages").getAll());
    const turns = await requestResult(transaction.objectStore("turns").getAll());
    const sourceSnapshots = await requestResult(transaction.objectStore("sourceSnapshots").getAll());
    for (const message of messages as Message[]) if (message.threadId === threadId) transaction.objectStore("messages").delete(message.id);
    const deletedTurnIds = new Set((turns as Turn[]).filter((turn) => turn.threadId === threadId).map((turn) => turn.id));
    for (const turn of turns as Turn[]) if (turn.threadId === threadId) transaction.objectStore("turns").delete(turn.id);
    for (const source of sourceSnapshots as SourceSnapshot[]) if (deletedTurnIds.has(source.turnId)) transaction.objectStore("sourceSnapshots").delete(source.id);
    await transactionComplete(transaction);
  }

  async setActiveThread(id: string | null, activeTray: TrayItem[], previousTray: TrayItem[]): Promise<void> {
    await this.setMeta(activeTray, previousTray, id);
  }
}

export function makeThread(title = "New synthesis thread"): Thread {
  const timestamp = nowIso();
  return { id: newId("thread"), title, createdAt: timestamp, updatedAt: timestamp };
}
