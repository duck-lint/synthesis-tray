import { describe, expect, it } from "vitest";
import { filterMessagesByQuery, filterTrayByQuery } from "../src/view/search";
import { presentationTrayEntriesForMatches } from "../src/state/tray";
import { compareLinkedContexts, compareTrays } from "../src/view/trayComparison";
import { diffSnapshotLines } from "../src/view/snapshotDiff";
import { tokenBarSegments } from "../src/tokens/tokenBar";
import { Message, TokenBreakdown, TrayItem } from "../src/state/types";

const item = (id: string, path: string, content: string, extra: Partial<TrayItem> = {}): TrayItem => ({ id, sourcePath: path, scope: "whole_note", headingPath: null, contentSnapshot: content, addedAt: "now", ...extra });
const message = (role: Message["role"], content: string): Message => ({ id: content, threadId: "thread", turnId: content, role, content, createdAt: "now" });

describe("presentation inspection helpers", () => {
  it("matches tray paths, headings, and immutable content case-insensitively", () => {
    const tray = [
      item("a", "Research/A.md", "ordinary", { captureGroup: { id: "folder", kind: "folder", label: "Research" } }),
      item("b", "Research/B.md", "PSR argument", { headingPath: ["Philosophy", "PSR"], captureGroup: { id: "folder", kind: "folder", label: "Research" } }),
    ];
    const matches = filterTrayByQuery(tray, "psr");
    expect(matches.map((match) => match.index)).toEqual([1]);
    const entries = presentationTrayEntriesForMatches(tray, matches);
    expect(entries).toEqual([{ kind: "folder", group: tray[0].captureGroup, items: [{ item: tray[1], index: 1 }] }]);
    expect(filterTrayByQuery(tray, "missing")).toEqual([]);
    expect(filterTrayByQuery(tray, "").map((match) => match.index)).toEqual([0, 1]);
  });

  it("filters only current-thread visible message content and preserves roles/order", () => {
    const messages = [message("user", "Ask about Kant"), message("assistant", "Kant answer"), message("user", "Unrelated")];
    expect(filterMessagesByQuery(messages, "KANT")).toEqual(messages.slice(0, 2));
    expect(messages).toHaveLength(3);
  });

  it("compares trays using canonical snapshot identity, not path or S labels", () => {
    const current = [item("current", "same.md", "new"), item("keep", "keep.md", "same")];
    const previous = [item("previous", "same.md", "old"), item("keep-previous-id", "keep.md", "same"), item("added", "added.md", "added")];
    const comparison = compareTrays(current, previous);
    expect(comparison.added.map((entry) => entry.sourcePath)).toEqual(["same.md", "added.md"]);
    expect(comparison.removed.map((entry) => entry.sourcePath)).toEqual(["same.md"]);
    expect(comparison.unchanged.map((entry) => entry.sourcePath)).toEqual(["keep.md"]);
  });

  it("keeps linked recall comparison relational", () => {
    const current = { sources: [], selections: [{ parentSourceId: "a", destinationSourceId: "x", authoredTarget: "X", displayText: "X alias" }] };
    const previous = { sources: [{ destinationSourceId: "x", sourcePath: "X.md", scope: "whole_note" as const, contentSnapshot: "X", addedAt: "now" }], selections: [{ parentSourceId: "a", destinationSourceId: "x", authoredTarget: "X", displayText: "X" }, { parentSourceId: "b", destinationSourceId: "y", authoredTarget: "Y", displayText: "Y" }] };
    const comparison = compareLinkedContexts(current, previous);
    expect(comparison.added).toEqual([{ parentSourceId: "b", destinationSourceId: "y", authoredTarget: "Y", displayText: "Y" }]);
    expect(comparison.unchanged).toHaveLength(1);
    expect(comparison.addedDestinations).toEqual(["y"]);
  });

  it("produces deterministic line additions, removals, replacements, and bounded large-input fallback", () => {
    expect(diffSnapshotLines("a\nb", "a\nc").lines.map((line) => [line.kind, line.text])).toEqual([["context", "a"], ["removed", "b"], ["added", "c"]]);
    expect(diffSnapshotLines("", "new").lines).toEqual([{ kind: "added", text: "new", oldLine: null, newLine: 1 }]);
    expect(diffSnapshotLines("a\nb\nc", "a\nx\ny\nc").lines.map((line) => [line.kind, line.text])).toEqual([["context", "a"], ["removed", "b"], ["added", "x"], ["added", "y"], ["context", "c"]]);
    expect(diffSnapshotLines("old", "").lines).toEqual([{ kind: "removed", text: "old", oldLine: 1, newLine: null }]);
    expect(diffSnapshotLines("a\nb\nc", "a\nb\nc").boundedFallback).toBe(false);
    expect(diffSnapshotLines("a\n".repeat(20), "b\n".repeat(20), 10).boundedFallback).toBe(true);
  });

  it("derives bar proportions from the existing numeric breakdown", () => {
    const breakdown: TokenBreakdown = { system: 2, conversation: 3, tray: 4, draft: 1, total: 10 };
    expect(tokenBarSegments(breakdown).map((segment) => segment.percentage)).toEqual([20, 30, 40, 10]);
    expect(tokenBarSegments({ system: 0, conversation: 0, tray: 0, draft: 0, total: 0 }).every((segment) => segment.percentage === 0)).toBe(true);
    expect(tokenBarSegments({ system: 0, conversation: 0, tray: 999, draft: 1, total: 1000 }).at(-1)?.percentage).toBe(0.1);
  });
});
