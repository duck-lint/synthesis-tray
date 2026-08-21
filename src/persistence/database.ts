import initSqlJs from "sql.js";
import { cloneTray } from "../state/tray";
import { newId, nowIso } from "../state/ids";
import { Message, PersistedState, SourceSnapshot, Thread, TrayItem, Turn } from "../state/types";

/** The small surface of sql.js used here keeps the persistence boundary testable. */
interface SqliteDatabase {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
  close(): void;
}

interface VaultAdapter {
  exists(path: string): Promise<boolean>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
}

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), content TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, user_message_id TEXT NOT NULL, assistant_message_id TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS source_snapshots (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, source_index INTEGER NOT NULL, source_path TEXT NOT NULL, scope TEXT NOT NULL, heading_path_json TEXT, content_snapshot TEXT NOT NULL, FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS tray_items (tray_name TEXT NOT NULL CHECK (tray_name IN ('active', 'previous')), ordinal INTEGER NOT NULL, id TEXT NOT NULL, source_path TEXT NOT NULL, scope TEXT NOT NULL, heading_path_json TEXT, content_snapshot TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (tray_name, id));
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

function asString(value: unknown): string { return typeof value === "string" ? value : String(value ?? ""); }
function asNumber(value: unknown): number { return typeof value === "number" ? value : Number(value); }
function asNullableString(value: unknown): string | null { return value == null ? null : asString(value); }
function writeBinaryValue(bytes: Uint8Array): ArrayBuffer { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; }

function rowObjects(result: Array<{ columns: string[]; values: unknown[][] }>): Array<Record<string, unknown>> {
  const first = result[0];
  return first ? first.values.map((values) => Object.fromEntries(first.columns.map((column, index) => [column, values[index]]))) : [];
}

function asTrayScope(value: unknown): TrayItem["scope"] {
  if (value === "highlight" || value === "heading" || value === "whole_note") return value;
  throw new Error(`Invalid persisted tray scope: ${String(value)}`);
}

function parseTrayRows(rows: Array<Record<string, unknown>>): TrayItem[] {
  return rows.sort((a, b) => asNumber(a.ordinal) - asNumber(b.ordinal)).map((row) => ({
    id: asString(row.id), sourcePath: asString(row.source_path), scope: asTrayScope(row.scope),
    headingPath: row.heading_path_json ? JSON.parse(asString(row.heading_path_json)) as string[] : null,
    contentSnapshot: asString(row.content_snapshot), addedAt: asString(row.added_at),
  }));
}

/**
 * SQLite is kept in memory by sql.js and exported after each committed mutation.
 * This gives Obsidian one ordinary SQLite file without an Electron-ABI native module.
 */
export class SynthesisDatabase {
  private db: SqliteDatabase | null = null;
  private sqlReady: Promise<{ Database: new (data?: Uint8Array) => SqliteDatabase }> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly adapter: VaultAdapter, private readonly databasePath: string, private readonly wasmPath: string) {}

  async open(): Promise<void> {
    if (this.db) return;
    // Obsidian's adapter is the authority for plugin assets. Passing wasmBinary
    // avoids making Emscripten interpret a vault path as a fetchable filesystem URL.
    const wasmBinary = await this.adapter.readBinary(this.wasmPath);
    this.sqlReady ??= initSqlJs({ wasmBinary }) as unknown as Promise<{ Database: new (data?: Uint8Array) => SqliteDatabase }>;
    const SQL = await this.sqlReady;
    const existing = await this.adapter.exists(this.databasePath);
    this.db = new SQL.Database(existing ? new Uint8Array(await this.adapter.readBinary(this.databasePath)) : undefined);
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(SCHEMA);
    if (!existing) await this.persist();
  }

  private requireDb(): SqliteDatabase {
    if (!this.db) throw new Error("Synthesis database has not been opened");
    return this.db;
  }

  private async persist(): Promise<void> {
    await this.adapter.writeBinary(this.databasePath, writeBinaryValue(this.requireDb().export()));
  }

  private async mutate(operation: (db: SqliteDatabase) => void): Promise<void> {
    const next = this.writeQueue.then(async () => {
      await this.open();
      const db = this.requireDb();
      db.run("BEGIN");
      try { operation(db); db.run("COMMIT"); await this.persist(); }
      catch (error) { try { db.run("ROLLBACK"); } catch { /* Preserve the original database error. */ } throw error; }
    });
    this.writeQueue = next.catch(() => undefined);
    await next;
  }

  async load(): Promise<PersistedState> {
    await this.open();
    await this.writeQueue;
    const db = this.requireDb();
    const threads = rowObjects(db.exec("SELECT id, title, created_at, updated_at FROM threads ORDER BY created_at, id")).map((row) => ({ id: asString(row.id), title: asString(row.title), createdAt: asString(row.created_at), updatedAt: asString(row.updated_at) }));
    const turns = rowObjects(db.exec("SELECT id, thread_id, user_message_id, assistant_message_id, created_at FROM turns ORDER BY created_at, id")).map((row) => ({ id: asString(row.id), threadId: asString(row.thread_id), userMessageId: asString(row.user_message_id), assistantMessageId: asString(row.assistant_message_id), createdAt: asString(row.created_at) }));
    const turnOrder = new Map(turns.map((turn, index) => [turn.id, index]));
    const messages = rowObjects(db.exec("SELECT id, thread_id, turn_id, role, content, created_at FROM messages")).map((row) => ({ id: asString(row.id), threadId: asString(row.thread_id), turnId: asString(row.turn_id), role: row.role === "assistant" ? "assistant" as const : "user" as const, content: asString(row.content), createdAt: asString(row.created_at) })).sort((a, b) => (turnOrder.get(a.turnId) ?? Number.MAX_SAFE_INTEGER) - (turnOrder.get(b.turnId) ?? Number.MAX_SAFE_INTEGER) || (a.role === "user" ? -1 : 1));
    const sourceSnapshots = rowObjects(db.exec("SELECT id, turn_id, source_index, source_path, scope, heading_path_json, content_snapshot FROM source_snapshots")).map((row) => ({ id: asString(row.id), turnId: asString(row.turn_id), sourceIndex: asNumber(row.source_index), sourcePath: asString(row.source_path), scope: asTrayScope(row.scope), headingPath: row.heading_path_json ? JSON.parse(asString(row.heading_path_json)) as string[] : null, contentSnapshot: asString(row.content_snapshot) })).sort((a, b) => (turnOrder.get(a.turnId) ?? Number.MAX_SAFE_INTEGER) - (turnOrder.get(b.turnId) ?? Number.MAX_SAFE_INTEGER) || a.sourceIndex - b.sourceIndex);
    const trayRows = rowObjects(db.exec("SELECT tray_name, ordinal, id, source_path, scope, heading_path_json, content_snapshot, added_at FROM tray_items ORDER BY tray_name, ordinal"));
    const activeTray = parseTrayRows(trayRows.filter((row) => row.tray_name === "active"));
    const previousTray = parseTrayRows(trayRows.filter((row) => row.tray_name === "previous"));
    const meta = new Map(rowObjects(db.exec("SELECT key, value FROM meta")).map((row) => [asString(row.key), asNullableString(row.value)]));
    return { threads, messages, turns, sourceSnapshots, activeTray: cloneTray(activeTray), previousTray: cloneTray(previousTray), activeThreadId: meta.get("activeThreadId") ?? null };
  }

  async setMeta(activeTray: TrayItem[], previousTray: TrayItem[], activeThreadId: string | null): Promise<void> {
    await this.mutate((db) => { this.replaceTray(db, "active", activeTray); this.replaceTray(db, "previous", previousTray); this.putMeta(db, "activeThreadId", activeThreadId); });
  }

  async commitTurn(thread: Thread, user: Message, assistant: Message, turn: Turn, sources: SourceSnapshot[], tray: TrayItem[]): Promise<void> {
    await this.mutate((db) => {
      db.run("INSERT OR REPLACE INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [thread.id, thread.title, thread.createdAt, thread.updatedAt]);
      db.run("INSERT INTO messages (id, thread_id, turn_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)", [user.id, user.threadId, user.turnId, user.role, user.content, user.createdAt]);
      db.run("INSERT INTO messages (id, thread_id, turn_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)", [assistant.id, assistant.threadId, assistant.turnId, assistant.role, assistant.content, assistant.createdAt]);
      db.run("INSERT INTO turns (id, thread_id, user_message_id, assistant_message_id, created_at) VALUES (?, ?, ?, ?, ?)", [turn.id, turn.threadId, turn.userMessageId, turn.assistantMessageId, turn.createdAt]);
      for (const source of sources) db.run("INSERT INTO source_snapshots (id, turn_id, source_index, source_path, scope, heading_path_json, content_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)", [source.id, source.turnId, source.sourceIndex, source.sourcePath, source.scope, source.headingPath ? JSON.stringify(source.headingPath) : null, source.contentSnapshot]);
      this.replaceTray(db, "previous", tray); this.replaceTray(db, "active", []);
    });
  }

  async putThread(thread: Thread): Promise<void> { await this.mutate((db) => db.run("INSERT OR REPLACE INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [thread.id, thread.title, thread.createdAt, thread.updatedAt])); }
  async deleteThread(threadId: string): Promise<void> {
    await this.mutate((db) => {
      db.run("DELETE FROM source_snapshots WHERE turn_id IN (SELECT id FROM turns WHERE thread_id = ?)", [threadId]);
      db.run("DELETE FROM messages WHERE thread_id = ?", [threadId]);
      db.run("DELETE FROM turns WHERE thread_id = ?", [threadId]);
      db.run("DELETE FROM threads WHERE id = ?", [threadId]);
    });
  }
  async setActiveThread(id: string | null, activeTray: TrayItem[], previousTray: TrayItem[]): Promise<void> { await this.setMeta(activeTray, previousTray, id); }

  async close(): Promise<void> { await this.writeQueue; this.db?.close(); this.db = null; }

  private replaceTray(db: SqliteDatabase, trayName: "active" | "previous", tray: TrayItem[]): void {
    db.run("DELETE FROM tray_items WHERE tray_name = ?", [trayName]);
    tray.forEach((item, index) => db.run("INSERT INTO tray_items (tray_name, ordinal, id, source_path, scope, heading_path_json, content_snapshot, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [trayName, index + 1, item.id, item.sourcePath, item.scope, item.headingPath ? JSON.stringify(item.headingPath) : null, item.contentSnapshot, item.addedAt]));
  }

  private putMeta(db: SqliteDatabase, key: string, value: string | null): void { db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, value]); }
}

export function makeThread(title = "New synthesis thread"): Thread { const timestamp = nowIso(); return { id: newId("thread"), title, createdAt: timestamp, updatedAt: timestamp }; }
