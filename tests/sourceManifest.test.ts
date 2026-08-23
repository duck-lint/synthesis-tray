import { describe, expect, it } from "vitest";
import { historicalComparisonsFor, sourceManifestEntries } from "../src/view/sourceManifest";

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

  it("orders same-path historical candidates by compatible scope, then newest evidence", () => {
    const current = { id: "current", turnId: "turn-3", sourceIndex: 1, sourcePath: "note.md", scope: "heading" as const, headingPath: ["A"], contentSnapshot: "new" };
    const candidates = historicalComparisonsFor(current, [
      current,
      { id: "whole-new", turnId: "turn-4", sourceIndex: 1, sourcePath: "note.md", scope: "whole_note" as const, headingPath: null, contentSnapshot: "whole" },
      { id: "heading-old", turnId: "turn-2", sourceIndex: 1, sourcePath: "note.md", scope: "heading" as const, headingPath: ["A"], contentSnapshot: "old" },
      { id: "other", turnId: "turn-1", sourceIndex: 1, sourcePath: "other.md", scope: "heading" as const, headingPath: ["A"], contentSnapshot: "other" },
    ], [
      { id: "turn-2", createdAt: "2026-08-20" },
      { id: "turn-3", createdAt: "2026-08-21" },
      { id: "turn-4", createdAt: "2026-08-22" },
    ]);
    expect(candidates.map((candidate) => candidate.source.id)).toEqual(["heading-old", "whole-new"]);
    expect(candidates[0].compatibleScope).toBe(true);
    expect(candidates[1].compatibleScope).toBe(false);
    expect(historicalComparisonsFor(current, [current], [])).toEqual([]);
  });
});
