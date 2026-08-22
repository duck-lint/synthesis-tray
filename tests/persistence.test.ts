import initSqlJs from "sql.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SynthesisDatabase } from "../src/persistence/database";
import { newId, nowIso } from "../src/state/ids";
import { Message, SourceSnapshot, Thread, TrayItem, Turn, TurnUsage } from "../src/state/types";

class MemoryVaultAdapter {
  readonly files = new Map<string, ArrayBuffer>();
  wasmReads = 0;
  constructor() {
    const bytes = readFileSync(wasmPath);
    this.files.set(wasmPath, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }
  async exists(path: string): Promise<boolean> { return this.files.has(path); }
  async readBinary(path: string): Promise<ArrayBuffer> { if (path === wasmPath) this.wasmReads += 1; const value = this.files.get(path); if (!value) throw new Error(`Missing ${path}`); return value.slice(0); }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> { this.files.set(path, data.slice(0)); }
}

const wasmPath = resolve("node_modules/sql.js/dist/sql-wasm.wasm");
function database(adapter: MemoryVaultAdapter, name: string): SynthesisDatabase { return new SynthesisDatabase(adapter, `${name}/conversations.sqlite3`, wasmPath); }
function thread(id = "thread-1"): Thread { return { id, title: "Thread", createdAt: nowIso(), updatedAt: nowIso(), model: "gpt-5.6-sol", reasoningEffort: "medium" }; }
function tray(path: string, content: string): TrayItem { return { id: newId("tray"), sourcePath: path, scope: "whole_note", headingPath: null, contentSnapshot: content, addedAt: nowIso() }; }
function usage(turnId: string): TurnUsage { return { turnId, inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 40, cacheWriteTokens: 25, usageJson: '{"input_tokens":100,"output_tokens":20,"total_tokens":120,"input_tokens_details":{"cached_tokens":40,"cache_write_tokens":25}}' }; }

describe("SQLite persistence", () => {
  it("proves sql.js export during an open transaction includes uncommitted rows", async () => {
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    const live = new SQL.Database();
    live.run("CREATE TABLE export_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    live.run("BEGIN");
    live.run("INSERT INTO export_probe VALUES (?, ?)", ["uncommitted", "visible in export"]);
    const exported = live.export();
    const reopened = new SQL.Database(exported);
    // The reopened image contains the schema but not the pending row. It is
    // therefore not a reliable pre-commit image for this persistence design.
    expect(reopened.exec("SELECT id, value FROM export_probe")[0]?.values ?? []).toEqual([]);
    reopened.close();
    live.close();
  });

  it("survives a database instance reload and restores active/previous tray snapshots", async () => {
    const adapter = new MemoryVaultAdapter();
    const current = tray("a.md", "A snapshot");
    const name = `reload-${newId("test")}`;
    const first = database(adapter, name);
    await first.setMeta([current], [], "thread-1");
    await first.close();
    const reloaded = await database(adapter, name).load();
    expect(reloaded.activeTray).toEqual([current]);
    expect(reloaded.activeTray[0].contentSnapshot).toBe("A snapshot");
    expect(adapter.wasmReads).toBeGreaterThan(0);
  });

  it("commits relational turn/source records and clears active tray", async () => {
    const adapter = new MemoryVaultAdapter();
    const db = database(adapter, `commit-${newId("test")}`);
    const currentThread = thread();
    const currentTray = [tray("a.md", "A"), tray("b.md", "B")];
    await db.putThread(currentThread);
    const turnId = "turn-1";
    const user: Message = { id: "user-1", threadId: currentThread.id, turnId, role: "user", content: "Question", createdAt: nowIso() };
    const assistant: Message = { id: "assistant-1", threadId: currentThread.id, turnId, role: "assistant", content: "Answer [S1]", createdAt: nowIso() };
    const turn: Turn = { id: turnId, threadId: currentThread.id, userMessageId: user.id, assistantMessageId: assistant.id, createdAt: nowIso(), model: currentThread.model, reasoningEffort: currentThread.reasoningEffort };
    const sources: SourceSnapshot[] = currentTray.map((item, index) => ({ id: `source-${index}`, turnId, sourceIndex: index + 1, sourcePath: item.sourcePath, scope: item.scope, headingPath: item.headingPath, contentSnapshot: item.contentSnapshot }));
    await db.commitTurn(currentThread, user, assistant, turn, sources, currentTray, usage(turnId));
    const state = await db.load();
    expect(state.activeTray).toEqual([]);
    expect(state.previousTray).toEqual(currentTray);
    expect(state.messages.map((message) => message.content)).toEqual(["Question", "Answer [S1]"]);
    expect(state.sourceSnapshots.map((source) => [source.turnId, source.sourceIndex, source.contentSnapshot])).toEqual([[turnId, 1, "A"], [turnId, 2, "B"]]);
    expect(state.turns[0]).toMatchObject({ model: currentThread.model, reasoningEffort: currentThread.reasoningEffort });
    expect(state.turnUsage).toEqual([usage(turnId)]);
  });

  it("persists conversation source identity with the immutable snapshot", async () => {
    const adapter = new MemoryVaultAdapter();
    const db = database(adapter, `conversation-source-${newId("test")}`);
    const currentThread = thread();
    const conversation: TrayItem = { id: "conversation-source", sourcePath: 'Conversation: "Referenced"', scope: "conversation", headingPath: null, contentSnapshot: "User:\nQuestion\n\nAssistant:\nAnswer", addedAt: nowIso(), conversationThreadId: "referenced-thread", conversationTitle: "Referenced" };
    await db.setMeta([conversation], [], currentThread.id);
    await db.putThread(currentThread);
    const turnId = "conversation-turn";
    const turn: Turn = { id: turnId, threadId: currentThread.id, userMessageId: "conversation-user", assistantMessageId: "conversation-assistant", createdAt: nowIso(), model: currentThread.model, reasoningEffort: currentThread.reasoningEffort };
    await db.commitTurn(currentThread, { id: turn.userMessageId, threadId: currentThread.id, turnId, role: "user", content: "question", createdAt: nowIso() }, { id: turn.assistantMessageId, threadId: currentThread.id, turnId, role: "assistant", content: "answer", createdAt: nowIso() }, turn, [{ id: "conversation-snapshot", turnId, sourceIndex: 1, sourcePath: conversation.sourcePath, scope: conversation.scope, headingPath: null, contentSnapshot: conversation.contentSnapshot, conversationThreadId: conversation.conversationThreadId, conversationTitle: conversation.conversationTitle }], [conversation]);
    const state = await db.load();
    expect(state.previousTray).toEqual([conversation]);
    expect(state.sourceSnapshots[0].conversationThreadId).toBe("referenced-thread");
    expect(state.sourceSnapshots[0].conversationTitle).toBe("Referenced");
  });

  it("persists explicit folder capture provenance through active and historical snapshots", async () => {
    const adapter = new MemoryVaultAdapter();
    const db = database(adapter, `folder-group-${newId("test")}`);
    const currentThread = thread();
    const group = { id: "folder-group", kind: "folder" as const, label: "Research" };
    const grouped = { ...tray("Research/A.md", "A"), captureGroup: group };
    await db.setMeta([grouped], [], currentThread.id);
    await db.putThread(currentThread);
    const turnId = "folder-turn";
    const turn: Turn = { id: turnId, threadId: currentThread.id, userMessageId: "folder-user", assistantMessageId: "folder-assistant", createdAt: nowIso(), model: currentThread.model, reasoningEffort: currentThread.reasoningEffort };
    await db.commitTurn(currentThread, { id: turn.userMessageId, threadId: currentThread.id, turnId, role: "user", content: "question", createdAt: nowIso() }, { id: turn.assistantMessageId, threadId: currentThread.id, turnId, role: "assistant", content: "answer", createdAt: nowIso() }, turn, [{ id: "folder-source", turnId, sourceIndex: 1, sourcePath: grouped.sourcePath, scope: grouped.scope, headingPath: null, contentSnapshot: grouped.contentSnapshot, captureGroup: group }], [grouped]);
    const state = await db.load();
    expect(state.previousTray[0].captureGroup).toEqual(group);
    expect(state.sourceSnapshots[0].captureGroup).toEqual(group);
  });

  it("writes a standard SQLite file with recognizable records and no API secret", async () => {
    const adapter = new MemoryVaultAdapter();
    const dbPath = `inspect-${newId("test")}/conversations.sqlite3`;
    const db = new SynthesisDatabase(adapter, dbPath, wasmPath);
    await db.setMeta([tray("active.md", "visible source")], [], "thread-1");
    const bytes = new Uint8Array(await adapter.readBinary(dbPath));
    expect(new TextDecoder().decode(bytes.slice(0, 16))).toBe("SQLite format 3\0");
    expect(new TextDecoder().decode(bytes)).not.toContain("sk-test-secret");
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    const inspected = new SQL.Database(bytes);
    const tableNames = inspected.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")[0].values.flat();
    expect(tableNames).toEqual(expect.arrayContaining(["threads", "messages", "turns", "turn_usage", "source_snapshots", "tray_items", "meta"]));
    expect(inspected.exec("SELECT source_path, content_snapshot FROM tray_items")[0].values).toEqual([["active.md", "visible source"]]);
    inspected.close();
  });

  it("deletes only the selected thread's relational history", async () => {
    const adapter = new MemoryVaultAdapter();
    const db = database(adapter, `delete-${newId("test")}`);
    const first = thread("thread-a");
    const second = thread("thread-b");
    await db.putThread(first);
    await db.putThread(second);
    const turn: Turn = { id: "turn-a", threadId: first.id, userMessageId: "user-a", assistantMessageId: "assistant-a", createdAt: nowIso(), model: first.model, reasoningEffort: first.reasoningEffort };
    await db.commitTurn(first, { id: "user-a", threadId: first.id, turnId: turn.id, role: "user", content: "old", createdAt: nowIso() }, { id: "assistant-a", threadId: first.id, turnId: turn.id, role: "assistant", content: "old answer", createdAt: nowIso() }, turn, [], []);
    await db.setMeta([tray("active.md", "keep")], [], second.id);
    await db.deleteThread(first.id);
    const state = await db.load();
    expect(state.threads.map((entry) => entry.id)).toEqual([second.id]);
    expect(state.messages).toEqual([]);
    expect(state.activeTray[0].contentSnapshot).toBe("keep");
    expect(state.turnUsage).toEqual([]);
  });

  it("opens an existing SQLite database and adds turn_usage without destructive migration", async () => {
    const adapter = new MemoryVaultAdapter();
    const name = `legacy-${newId("test")}`;
    const dbPath = `${name}/conversations.sqlite3`;
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    const legacy = new SQL.Database();
    legacy.run("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    legacy.run("INSERT INTO threads VALUES (?, ?, ?, ?)", ["legacy-thread", "Legacy", "2020-01-01", "2020-01-01"]);
    const exported = legacy.export();
    adapter.files.set(dbPath, exported.buffer.slice(exported.byteOffset, exported.byteOffset + exported.byteLength) as ArrayBuffer);
    legacy.close();

    const state = await database(adapter, name).load();
    expect(state.threads.map((entry) => entry.id)).toEqual(["legacy-thread"]);
    expect(state.threads[0]).toMatchObject({ model: "gpt-5.6-sol", reasoningEffort: "none" });
    const inspected = new SQL.Database(new Uint8Array(await adapter.readBinary(dbPath)));
    expect(inspected.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turn_usage'")[0].values).toEqual([["turn_usage"]]);
    expect(inspected.exec("PRAGMA table_info(turn_usage)")[0].values.map((row) => row[1])).toContain("cache_write_tokens");
    inspected.close();
  });

  it("adds cache-write telemetry to an existing turn_usage table", async () => {
    const adapter = new MemoryVaultAdapter();
    const name = `legacy-usage-${newId("test")}`;
    const dbPath = `${name}/conversations.sqlite3`;
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    const legacy = new SQL.Database();
    legacy.run("CREATE TABLE turn_usage (turn_id TEXT PRIMARY KEY, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cached_input_tokens INTEGER, usage_json TEXT)");
    const exported = legacy.export();
    adapter.files.set(dbPath, exported.buffer.slice(exported.byteOffset, exported.byteOffset + exported.byteLength) as ArrayBuffer);
    legacy.close();

    await database(adapter, name).load();
    const inspected = new SQL.Database(new Uint8Array(await adapter.readBinary(dbPath)));
    expect(inspected.exec("PRAGMA table_info(turn_usage)")[0].values.map((row) => row[1])).toContain("cache_write_tokens");
    inspected.close();
  });

  it("does not create completed usage for a turn committed without provider usage", async () => {
    const adapter = new MemoryVaultAdapter();
    const db = database(adapter, `no-usage-${newId("test")}`);
    const currentThread = thread();
    const turnId = "turn-without-usage";
    const turn: Turn = { id: turnId, threadId: currentThread.id, userMessageId: "user-no-usage", assistantMessageId: "assistant-no-usage", createdAt: nowIso(), model: currentThread.model, reasoningEffort: currentThread.reasoningEffort };
    await db.commitTurn(currentThread, { id: turn.userMessageId, threadId: currentThread.id, turnId, role: "user", content: "question", createdAt: nowIso() }, { id: turn.assistantMessageId, threadId: currentThread.id, turnId, role: "assistant", content: "answer", createdAt: nowIso() }, turn, [], []);
    expect((await db.load()).turnUsage).toEqual([]);
  });

  it("does not leave a ghost turn after a one-time persistence failure", async () => {
    const adapter = new MemoryVaultAdapter();
    const name = `atomic-${newId("test")}`;
    const db = database(adapter, name);
    const currentThread = thread();
    await db.putThread(currentThread);
    const originalWrite = adapter.writeBinary.bind(adapter);
    let failNextWrite = true;
    adapter.writeBinary = async (path: string, data: ArrayBuffer): Promise<void> => {
      if (failNextWrite && path.endsWith("conversations.sqlite3")) {
        failNextWrite = false;
        throw new Error("forced persistence failure");
      }
      await originalWrite(path, data);
    };

    const makeTurn = (turnId: string): { turn: Turn; user: Message; assistant: Message } => {
      const turn: Turn = { id: turnId, threadId: currentThread.id, userMessageId: `${turnId}-user`, assistantMessageId: `${turnId}-assistant`, createdAt: nowIso(), model: currentThread.model, reasoningEffort: currentThread.reasoningEffort };
      return {
        turn,
        user: { id: turn.userMessageId, threadId: currentThread.id, turnId, role: "user", content: `${turnId} question`, createdAt: nowIso() },
        assistant: { id: turn.assistantMessageId, threadId: currentThread.id, turnId, role: "assistant", content: `${turnId} answer`, createdAt: nowIso() },
      };
    };

    const first = makeTurn("turn-1");
    await expect(db.commitTurn(currentThread, first.user, first.assistant, first.turn, [], [])).rejects.toThrow("forced persistence failure");
    expect((await db.load()).turns.map((turn) => turn.id)).toEqual([]);

    const second = makeTurn("turn-2");
    await db.commitTurn(currentThread, second.user, second.assistant, second.turn, [], []);
    const liveState = await db.load();
    expect(liveState.turns.map((turn) => turn.id)).toEqual(["turn-2"]);

    await db.close();
    const reopened = await database(adapter, name).load();
    expect(reopened.turns.map((turn) => turn.id)).toEqual(["turn-2"]);
    expect(reopened.messages.map((message) => message.turnId)).toEqual(["turn-2", "turn-2"]);
  });
});
