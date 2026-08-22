import initSqlJs from "sql.js";
import { cloneTray } from "../state/tray";
import { newId, nowIso } from "../state/ids";
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, isReasoningEffort, isSynthesisModel, Message, PersistedState, SourceSnapshot, Thread, TrayItem, Turn, TurnUsage, ReasoningEffort, SynthesisModel } from "../state/types";

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
  CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, model TEXT, reasoning_effort TEXT);
  CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), content TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, user_message_id TEXT NOT NULL, assistant_message_id TEXT NOT NULL, created_at TEXT NOT NULL, model TEXT, reasoning_effort TEXT, FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS turn_usage (turn_id TEXT PRIMARY KEY, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cached_input_tokens INTEGER, cache_write_tokens INTEGER, usage_json TEXT, FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS source_snapshots (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, source_index INTEGER NOT NULL, source_path TEXT NOT NULL, scope TEXT NOT NULL, heading_path_json TEXT, content_snapshot TEXT NOT NULL, capture_group_id TEXT, capture_group_kind TEXT, capture_group_label TEXT, conversation_thread_id TEXT, conversation_title TEXT, FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS tray_items (tray_name TEXT NOT NULL CHECK (tray_name IN ('active', 'previous')), ordinal INTEGER NOT NULL, id TEXT NOT NULL, source_path TEXT NOT NULL, scope TEXT NOT NULL, heading_path_json TEXT, content_snapshot TEXT NOT NULL, added_at TEXT NOT NULL, capture_group_id TEXT, capture_group_kind TEXT, capture_group_label TEXT, conversation_thread_id TEXT, conversation_title TEXT, PRIMARY KEY (tray_name, id));
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

function asString(value: unknown): string { return typeof value === "string" ? value : String(value ?? ""); }
function asNumber(value: unknown): number { return typeof value === "number" ? value : Number(value); }
function asNullableString(value: unknown): string | null { return value == null ? null : asString(value); }
function writeBinaryValue(bytes: Uint8Array): ArrayBuffer { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; }

function asModel(value: unknown, fallback: SynthesisModel): SynthesisModel { return isSynthesisModel(value) ? value : fallback; }
function asReasoningEffort(value: unknown, fallback: ReasoningEffort): ReasoningEffort { return isReasoningEffort(value) ? value : fallback; }

function rowObjects(result: Array<{ columns: string[]; values: unknown[][] }>): Array<Record<string, unknown>> {
  const first = result[0];
  return first ? first.values.map((values) => Object.fromEntries(first.columns.map((column, index) => [column, values[index]]))) : [];
}

function ensureColumn(db: SqliteDatabase, table: string, column: string, definition: string): void {
  const columns = rowObjects(db.exec(`PRAGMA table_info(${table})`));
  if (!columns.some((entry) => entry.name === column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function asTrayScope(value: unknown): TrayItem["scope"] {
  if (value === "highlight" || value === "heading" || value === "whole_note" || value === "conversation") return value;
  throw new Error(`Invalid persisted tray scope: ${String(value)}`);
}

function parseTrayRows(rows: Array<Record<string, unknown>>): TrayItem[] {
  return rows.sort((a, b) => asNumber(a.ordinal) - asNumber(b.ordinal)).map((row) => ({
    id: asString(row.id), sourcePath: asString(row.source_path), scope: asTrayScope(row.scope),
    headingPath: row.heading_path_json ? JSON.parse(asString(row.heading_path_json)) as string[] : null,
    contentSnapshot: asString(row.content_snapshot), addedAt: asString(row.added_at),
    ...(row.capture_group_id == null ? {} : { captureGroup: { id: asString(row.capture_group_id), kind: "folder" as const, label: asString(row.capture_group_label) } }),
    ...(row.conversation_thread_id == null ? {} : { conversationThreadId: asString(row.conversation_thread_id) }),
    ...(row.conversation_title == null ? {} : { conversationTitle: asString(row.conversation_title) }),
  }));
}

/**
 * SQLite is kept in memory by sql.js and exported after each committed mutation.
 * This gives Obsidian one ordinary SQLite file without an Electron-ABI native module.
 */
export class SynthesisDatabase {
  private db: SqliteDatabase | null = null;
  private sql: { Database: new (data?: Uint8Array) => SqliteDatabase } | null = null;
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
    this.sql = SQL;
    const existing = await this.adapter.exists(this.databasePath);
    try {
      this.db = new SQL.Database(existing ? new Uint8Array(await this.adapter.readBinary(this.databasePath)) : undefined);
      this.db.run("PRAGMA foreign_keys = ON");
      this.db.run(SCHEMA);
      ensureColumn(this.db, "source_snapshots", "conversation_thread_id", "TEXT");
      ensureColumn(this.db, "source_snapshots", "conversation_title", "TEXT");
      ensureColumn(this.db, "source_snapshots", "capture_group_id", "TEXT");
      ensureColumn(this.db, "source_snapshots", "capture_group_kind", "TEXT");
      ensureColumn(this.db, "source_snapshots", "capture_group_label", "TEXT");
      ensureColumn(this.db, "tray_items", "conversation_thread_id", "TEXT");
      ensureColumn(this.db, "tray_items", "conversation_title", "TEXT");
      ensureColumn(this.db, "tray_items", "capture_group_id", "TEXT");
      ensureColumn(this.db, "tray_items", "capture_group_kind", "TEXT");
      ensureColumn(this.db, "tray_items", "capture_group_label", "TEXT");
      ensureColumn(this.db, "threads", "model", "TEXT");
      ensureColumn(this.db, "threads", "reasoning_effort", "TEXT");
      ensureColumn(this.db, "turns", "model", "TEXT");
      ensureColumn(this.db, "turns", "reasoning_effort", "TEXT");
      ensureColumn(this.db, "turn_usage", "cache_write_tokens", "INTEGER");
      // Persist schema additions on open as well, so an existing database is
      // upgraded durably without requiring a later conversation mutation.
      await this.persist();
    } catch (error) {
      this.db?.close();
      this.db = null;
      throw error;
    }
  }

  private requireDb(): SqliteDatabase {
    if (!this.db) throw new Error("Synthesis database has not been opened");
    return this.db;
  }

  private async persist(): Promise<void> {
    await this.adapter.writeBinary(this.databasePath, writeBinaryValue(this.requireDb().export()));
  }

  private restore(image: Uint8Array): void {
    if (!this.sql) throw new Error("SQLite engine has not been initialized");
    const replacement = new this.sql.Database(new Uint8Array(image));
    replacement.run("PRAGMA foreign_keys = ON");
    this.db?.close();
    this.db = replacement;
  }

  private async mutate(operation: (db: SqliteDatabase) => void): Promise<void> {
    const next = this.writeQueue.then(async () => {
      await this.open();
      const db = this.requireDb();
      // sql.js export() during an open transaction is not a reliable durable
      // image, so retain the last known-good committed database for recovery.
      const knownGoodImage = new Uint8Array(db.export());
      db.run("BEGIN");
      try { operation(db); db.run("COMMIT"); await this.persist(); }
      catch (error) {
        try { db.run("ROLLBACK"); } catch { /* A failed disk write occurs after COMMIT. */ }
        this.restore(knownGoodImage);
        throw error;
      }
    });
    this.writeQueue = next.catch(() => undefined);
    await next;
  }

  async load(defaultModel: SynthesisModel = DEFAULT_MODEL, defaultReasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT, legacyModel?: unknown): Promise<PersistedState> {
    await this.open();
    await this.writeQueue;
    const db = this.requireDb();
    const migratedModel = isSynthesisModel(legacyModel) || legacyModel === "gpt-5.6" ? (legacyModel === "gpt-5.6" ? DEFAULT_MODEL : legacyModel as SynthesisModel) : defaultModel;
    const threads = rowObjects(db.exec("SELECT id, title, created_at, updated_at, model, reasoning_effort FROM threads ORDER BY created_at, id")).map((row) => ({ id: asString(row.id), title: asString(row.title), createdAt: asString(row.created_at), updatedAt: asString(row.updated_at), model: asModel(row.model, migratedModel), reasoningEffort: asReasoningEffort(row.reasoning_effort, defaultReasoningEffort) }));
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    const turns = rowObjects(db.exec("SELECT id, thread_id, user_message_id, assistant_message_id, created_at, model, reasoning_effort FROM turns ORDER BY created_at, id")).map((row) => ({ id: asString(row.id), threadId: asString(row.thread_id), userMessageId: asString(row.user_message_id), assistantMessageId: asString(row.assistant_message_id), createdAt: asString(row.created_at), model: asModel(row.model, threadById.get(asString(row.thread_id))?.model ?? migratedModel), reasoningEffort: asReasoningEffort(row.reasoning_effort, threadById.get(asString(row.thread_id))?.reasoningEffort ?? defaultReasoningEffort) }));
    const turnOrder = new Map(turns.map((turn, index) => [turn.id, index]));
    const messages = rowObjects(db.exec("SELECT id, thread_id, turn_id, role, content, created_at FROM messages")).map((row) => ({ id: asString(row.id), threadId: asString(row.thread_id), turnId: asString(row.turn_id), role: row.role === "assistant" ? "assistant" as const : "user" as const, content: asString(row.content), createdAt: asString(row.created_at) })).sort((a, b) => (turnOrder.get(a.turnId) ?? Number.MAX_SAFE_INTEGER) - (turnOrder.get(b.turnId) ?? Number.MAX_SAFE_INTEGER) || (a.role === "user" ? -1 : 1));
    const turnUsage = rowObjects(db.exec("SELECT turn_id, input_tokens, output_tokens, total_tokens, cached_input_tokens, cache_write_tokens, usage_json FROM turn_usage ORDER BY turn_id")).map((row): TurnUsage => ({ turnId: asString(row.turn_id), inputTokens: row.input_tokens == null ? null : asNumber(row.input_tokens), outputTokens: row.output_tokens == null ? null : asNumber(row.output_tokens), totalTokens: row.total_tokens == null ? null : asNumber(row.total_tokens), cachedInputTokens: row.cached_input_tokens == null ? null : asNumber(row.cached_input_tokens), cacheWriteTokens: row.cache_write_tokens == null ? null : asNumber(row.cache_write_tokens), usageJson: asNullableString(row.usage_json) }));
    const sourceSnapshots = rowObjects(db.exec("SELECT id, turn_id, source_index, source_path, scope, heading_path_json, content_snapshot, capture_group_id, capture_group_kind, capture_group_label, conversation_thread_id, conversation_title FROM source_snapshots")).map((row) => ({ id: asString(row.id), turnId: asString(row.turn_id), sourceIndex: asNumber(row.source_index), sourcePath: asString(row.source_path), scope: asTrayScope(row.scope), headingPath: row.heading_path_json ? JSON.parse(asString(row.heading_path_json)) as string[] : null, contentSnapshot: asString(row.content_snapshot), ...(row.capture_group_id == null ? {} : { captureGroup: { id: asString(row.capture_group_id), kind: "folder" as const, label: asString(row.capture_group_label) } }), ...(row.conversation_thread_id == null ? {} : { conversationThreadId: asString(row.conversation_thread_id) }), ...(row.conversation_title == null ? {} : { conversationTitle: asString(row.conversation_title) }) })).sort((a, b) => (turnOrder.get(a.turnId) ?? Number.MAX_SAFE_INTEGER) - (turnOrder.get(b.turnId) ?? Number.MAX_SAFE_INTEGER) || a.sourceIndex - b.sourceIndex);
    const trayRows = rowObjects(db.exec("SELECT tray_name, ordinal, id, source_path, scope, heading_path_json, content_snapshot, added_at, capture_group_id, capture_group_kind, capture_group_label, conversation_thread_id, conversation_title FROM tray_items ORDER BY tray_name, ordinal"));
    const activeTray = parseTrayRows(trayRows.filter((row) => row.tray_name === "active"));
    const previousTray = parseTrayRows(trayRows.filter((row) => row.tray_name === "previous"));
    const meta = new Map(rowObjects(db.exec("SELECT key, value FROM meta")).map((row) => [asString(row.key), asNullableString(row.value)]));
    return { threads, messages, turns, turnUsage, sourceSnapshots, activeTray: cloneTray(activeTray), previousTray: cloneTray(previousTray), activeThreadId: meta.get("activeThreadId") ?? null };
  }

  async setMeta(activeTray: TrayItem[], previousTray: TrayItem[], activeThreadId: string | null): Promise<void> {
    await this.mutate((db) => { this.replaceTray(db, "active", activeTray); this.replaceTray(db, "previous", previousTray); this.putMeta(db, "activeThreadId", activeThreadId); });
  }

  async commitTurn(thread: Thread, user: Message, assistant: Message, turn: Turn, sources: SourceSnapshot[], tray: TrayItem[], usage?: TurnUsage): Promise<void> {
    await this.mutate((db) => {
      db.run("INSERT OR REPLACE INTO threads (id, title, created_at, updated_at, model, reasoning_effort) VALUES (?, ?, ?, ?, ?, ?)", [thread.id, thread.title, thread.createdAt, thread.updatedAt, thread.model, thread.reasoningEffort]);
      db.run("INSERT INTO messages (id, thread_id, turn_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)", [user.id, user.threadId, user.turnId, user.role, user.content, user.createdAt]);
      db.run("INSERT INTO messages (id, thread_id, turn_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)", [assistant.id, assistant.threadId, assistant.turnId, assistant.role, assistant.content, assistant.createdAt]);
      db.run("INSERT INTO turns (id, thread_id, user_message_id, assistant_message_id, created_at, model, reasoning_effort) VALUES (?, ?, ?, ?, ?, ?, ?)", [turn.id, turn.threadId, turn.userMessageId, turn.assistantMessageId, turn.createdAt, turn.model, turn.reasoningEffort]);
      if (usage) db.run("INSERT INTO turn_usage (turn_id, input_tokens, output_tokens, total_tokens, cached_input_tokens, cache_write_tokens, usage_json) VALUES (?, ?, ?, ?, ?, ?, ?)", [usage.turnId, usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cachedInputTokens, usage.cacheWriteTokens, usage.usageJson]);
      for (const source of sources) db.run("INSERT INTO source_snapshots (id, turn_id, source_index, source_path, scope, heading_path_json, content_snapshot, capture_group_id, capture_group_kind, capture_group_label, conversation_thread_id, conversation_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [source.id, source.turnId, source.sourceIndex, source.sourcePath, source.scope, source.headingPath ? JSON.stringify(source.headingPath) : null, source.contentSnapshot, source.captureGroup?.id ?? null, source.captureGroup?.kind ?? null, source.captureGroup?.label ?? null, source.conversationThreadId ?? null, source.conversationTitle ?? null]);
      this.replaceTray(db, "previous", tray); this.replaceTray(db, "active", []);
    });
  }

  async putThread(thread: Thread): Promise<void> { await this.mutate((db) => db.run("INSERT OR REPLACE INTO threads (id, title, created_at, updated_at, model, reasoning_effort) VALUES (?, ?, ?, ?, ?, ?)", [thread.id, thread.title, thread.createdAt, thread.updatedAt, thread.model, thread.reasoningEffort])); }
  async updateTurnInference(turnId: string, model: SynthesisModel, reasoningEffort: ReasoningEffort): Promise<void> {
    await this.mutate((db) => db.run("UPDATE turns SET model = ?, reasoning_effort = ? WHERE id = ?", [model, reasoningEffort, turnId]));
  }
  async deleteThread(threadId: string): Promise<void> {
    await this.mutate((db) => {
      db.run("DELETE FROM source_snapshots WHERE turn_id IN (SELECT id FROM turns WHERE thread_id = ?)", [threadId]);
      db.run("DELETE FROM turn_usage WHERE turn_id IN (SELECT id FROM turns WHERE thread_id = ?)", [threadId]);
      db.run("DELETE FROM messages WHERE thread_id = ?", [threadId]);
      db.run("DELETE FROM turns WHERE thread_id = ?", [threadId]);
      db.run("DELETE FROM threads WHERE id = ?", [threadId]);
    });
  }
  async setActiveThread(id: string | null, activeTray: TrayItem[], previousTray: TrayItem[]): Promise<void> { await this.setMeta(activeTray, previousTray, id); }

  async close(): Promise<void> { await this.writeQueue; this.db?.close(); this.db = null; }

  private replaceTray(db: SqliteDatabase, trayName: "active" | "previous", tray: TrayItem[]): void {
    db.run("DELETE FROM tray_items WHERE tray_name = ?", [trayName]);
    tray.forEach((item, index) => db.run("INSERT INTO tray_items (tray_name, ordinal, id, source_path, scope, heading_path_json, content_snapshot, added_at, capture_group_id, capture_group_kind, capture_group_label, conversation_thread_id, conversation_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [trayName, index + 1, item.id, item.sourcePath, item.scope, item.headingPath ? JSON.stringify(item.headingPath) : null, item.contentSnapshot, item.addedAt, item.captureGroup?.id ?? null, item.captureGroup?.kind ?? null, item.captureGroup?.label ?? null, item.conversationThreadId ?? null, item.conversationTitle ?? null]));
  }

  private putMeta(db: SqliteDatabase, key: string, value: string | null): void { db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, value]); }
}

export function makeThread(title = "New synthesis thread"): Thread { const timestamp = nowIso(); return { id: newId("thread"), title, createdAt: timestamp, updatedAt: timestamp, model: DEFAULT_MODEL, reasoningEffort: DEFAULT_REASONING_EFFORT }; }
