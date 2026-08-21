import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { SynthesisDatabase } from "../src/persistence/database";
import { newId, nowIso } from "../src/state/ids";
import { cloneTray } from "../src/state/tray";
import { Message, SourceSnapshot, Thread, TrayItem, Turn } from "../src/state/types";

function thread(id = "thread-1"): Thread {
  return { id, title: "Thread", createdAt: nowIso(), updatedAt: nowIso() };
}
function tray(path: string, content: string): TrayItem {
  return { id: newId("tray"), sourcePath: path, scope: "whole_note", headingPath: null, contentSnapshot: content, addedAt: nowIso() };
}

describe("IndexedDB persistence", () => {
  it("reloads the active and previous tray without rereading source files", async () => {
    const db = new SynthesisDatabase(`reload-${newId("test")}`);
    const current = tray("a.md", "A snapshot");
    await db.setMeta([current], [], "thread-1");
    const reloaded = await db.load();
    expect(reloaded.activeTray).toEqual([current]);
    expect(reloaded.activeTray[0].contentSnapshot).toBe("A snapshot");
  });

  it("commits a successful turn, maps sources to that turn, and clears active tray", async () => {
    const db = new SynthesisDatabase(`commit-${newId("test")}`);
    const currentThread = thread();
    const currentTray = [tray("a.md", "A"), tray("b.md", "B")];
    await db.putThread(currentThread);
    const turnId = "turn-1";
    const user: Message = { id: "user-1", threadId: currentThread.id, turnId, role: "user", content: "Question", createdAt: nowIso() };
    const assistant: Message = { id: "assistant-1", threadId: currentThread.id, turnId, role: "assistant", content: "Answer [S1]", createdAt: nowIso() };
    const turn: Turn = { id: turnId, threadId: currentThread.id, userMessageId: user.id, assistantMessageId: assistant.id, createdAt: nowIso() };
    const sources: SourceSnapshot[] = currentTray.map((item, index) => ({ id: `source-${index}`, turnId, sourceIndex: index + 1, sourcePath: item.sourcePath, scope: item.scope, headingPath: item.headingPath, contentSnapshot: item.contentSnapshot }));
    await db.setMeta(currentTray, [], currentThread.id);
    await db.commitTurn(currentThread, user, assistant, turn, sources, currentTray);
    const state = await db.load();
    expect(state.activeTray).toEqual([]);
    expect(state.previousTray).toEqual(currentTray);
    expect(state.messages.map((message) => message.content)).toEqual(["Question", "Answer [S1]"]);
    expect(state.sourceSnapshots.map((source) => [source.turnId, source.sourceIndex, source.contentSnapshot])).toEqual([[turnId, 1, "A"], [turnId, 2, "B"]]);
  });

  it("deletes thread-owned records but leaves other threads and tray state", async () => {
    const db = new SynthesisDatabase(`delete-${newId("test")}`);
    const first = thread("thread-a");
    const second = thread("thread-b");
    await db.putThread(first);
    await db.putThread(second);
    await db.setMeta([tray("active.md", "keep")], [], second.id);
    const t1: Turn = { id: "turn-a", threadId: first.id, userMessageId: "u-a", assistantMessageId: "a-a", createdAt: nowIso() };
    const u1: Message = { id: "u-a", threadId: first.id, turnId: t1.id, role: "user", content: "old", createdAt: nowIso() };
    const a1: Message = { id: "a-a", threadId: first.id, turnId: t1.id, role: "assistant", content: "old answer", createdAt: nowIso() };
    await db.commitTurn(first, u1, a1, t1, [], []);
    await db.setMeta([tray("active.md", "keep")], [], second.id);
    await db.deleteThread(first.id);
    const state = await db.load();
    expect(state.threads.map((entry) => entry.id)).toEqual([second.id]);
    expect(state.messages).toEqual([]);
    expect(state.activeTray[0].contentSnapshot).toBe("keep");
  });
});
