import { describe, expect, it } from "vitest";
import { sourceManifestEntries } from "../src/view/sourceManifest";

describe("completed-turn source manifest", () => {
  it("maps persisted turn-relative snapshots without rereading sources", () => {
    const entries = sourceManifestEntries([
      { id: "s2", turnId: "turn", sourceIndex: 2, sourcePath: "note.md", scope: "whole_note", headingPath: null, contentSnapshot: "immutable" },
      { id: "s1", turnId: "turn", sourceIndex: 1, sourcePath: "thread-id", scope: "conversation", headingPath: null, contentSnapshot: "User: old", conversationThreadId: "thread-id", conversationTitle: "Thread title" },
    ]);
    expect(entries).toEqual([
      { sourceIndex: 1, identity: 'Conversation: "Thread title"', scope: "conversation", headingPath: null },
      { sourceIndex: 2, identity: "note.md", scope: "whole_note", headingPath: null },
    ]);
  });
});
