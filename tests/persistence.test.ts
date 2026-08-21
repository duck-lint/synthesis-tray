import initSqlJs from "sql.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SynthesisDatabase } from "../src/persistence/database";
import { newId, nowIso } from "../src/state/ids";
import { Message, SourceSnapshot, Thread, TrayItem, Turn } from "../src/state/types";

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
function thread(id = "thread-1"): Thread { return { id, title: "Thread", createdAt: nowIso(), updatedAt: nowIso() }; }
function tray(path: string, content: string): TrayItem { return { id: newId("tray"), sourcePath: path, scope: "whole_note", headingPath: null, contentSnapshot: content, addedAt: nowIso() }; }

describe("SQLite persistence", () => {
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
    const turn: Turn = { id: turnId, threadId: currentThread.id, userMessageId: user.id, assistantMessageId: assistant.id, createdAt: nowIso() };
    const sources: SourceSnapshot[] = currentTray.map((item, index) => ({ id: `source-${index}`, turnId, sourceIndex: index + 1, sourcePath: item.sourcePath, scope: item.scope, headingPath: item.headingPath, contentSnapshot: item.contentSnapshot }));
    await db.commitTurn(currentThread, user, assistant, turn, sources, currentTray);
    const state = await db.load();
    expect(state.activeTray).toEqual([]);
    expect(state.previousTray).toEqual(currentTray);
    expect(state.messages.map((message) => message.content)).toEqual(["Question", "Answer [S1]"]);
    expect(state.sourceSnapshots.map((source) => [source.turnId, source.sourceIndex, source.contentSnapshot])).toEqual([[turnId, 1, "A"], [turnId, 2, "B"]]);
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
    expect(tableNames).toEqual(expect.arrayContaining(["threads", "messages", "turns", "source_snapshots", "tray_items", "meta"]));
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
    const turn: Turn = { id: "turn-a", threadId: first.id, userMessageId: "user-a", assistantMessageId: "assistant-a", createdAt: nowIso() };
    await db.commitTurn(first, { id: "user-a", threadId: first.id, turnId: turn.id, role: "user", content: "old", createdAt: nowIso() }, { id: "assistant-a", threadId: first.id, turnId: turn.id, role: "assistant", content: "old answer", createdAt: nowIso() }, turn, [], []);
    await db.setMeta([tray("active.md", "keep")], [], second.id);
    await db.deleteThread(first.id);
    const state = await db.load();
    expect(state.threads.map((entry) => entry.id)).toEqual([second.id]);
    expect(state.messages).toEqual([]);
    expect(state.activeTray[0].contentSnapshot).toBe("keep");
  });
});
