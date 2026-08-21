import { describe, expect, it } from "vitest";
import { captureConversation, captureFolderWholeNotes, captureHeading, captureSelection, captureWholeNote } from "../src/capture/capture";
import { addTrayItem, removeTrayItem, trayIdentity } from "../src/state/tray";
import { TrayItem } from "../src/state/types";

const item = (id: string, contentSnapshot: string): TrayItem => ({
  id, sourcePath: "Journal/today.md", scope: "highlight", headingPath: ["Journal"], contentSnapshot, addedAt: "2026-08-20T00:00:00.000Z",
});

describe("manual capture and tray", () => {
  it("recursively captures Markdown folder material as separate deterministic whole-note sources", () => {
    const captured = captureFolderWholeNotes([
      { path: "LAYER-3 LEXICON/Nested/C.md", extension: "md", source: "C" },
      { path: "LAYER-3 LEXICON/B.md", extension: "md", source: "B" },
      { path: "LAYER-3 LEXICON/image.png", extension: "png", source: "binary-looking attachment" },
      { path: "LAYER-3 LEXICON/A.md", extension: "md", source: "---\ntags: [one]\n---\nA ![[image.png]]" },
    ]);
    expect(captured.map((item) => [item.sourcePath, item.scope])).toEqual([
      ["LAYER-3 LEXICON/A.md", "whole_note"],
      ["LAYER-3 LEXICON/B.md", "whole_note"],
      ["LAYER-3 LEXICON/Nested/C.md", "whole_note"],
    ]);
    expect(captured.map((item) => item.contentSnapshot)).toEqual(["---\ntags: [one]\n---\nA ![[image.png]]", "B", "C"]);
  });
  it("preserves exact selection and does not expand its paragraph", () => {
    const source = "Before sentence. Selected one. Selected two. After sentence.";
    const editor = {
      getSelection: () => "Selected one. Selected two.",
      getCursor: (where?: "from" | "to") => where === "to" ? { line: 0, ch: 42 } : { line: 0, ch: 17 },
    };
    const captured = captureSelection("note.md", source, editor);
    expect(captured?.contentSnapshot).toBe("Selected one. Selected two.");
    expect(captured?.contentSnapshot).not.toContain("Before");
    expect(captured?.contentSnapshot).not.toContain("After");
  });

  it("captures frontmatter and literal embeds for whole notes", () => {
    const source = "---\ntags: [one]\n---\n![[image.png]]\n";
    const captured = captureWholeNote("note.md", source);
    expect(captured.contentSnapshot).toBe(source);
    expect(captured.contentSnapshot).toContain("tags: [one]");
    expect(captured.contentSnapshot).toContain("![[image.png]]");
  });

  it("captures heading metadata and subtree exactly", () => {
    const source = "# Root\n\n## Child\ntext\n## Next\n";
    const captured = captureHeading("note.md", source, source.indexOf("Child") + 1);
    expect(captured?.headingPath).toEqual(["Root", "Child"]);
    expect(captured?.contentSnapshot).toBe("## Child\ntext\n");
  });

  it("does not invent one heading path for a cross-heading selection", () => {
    const source = "# A\nfirst\n\n# B\nsecond\n";
    const from = source.indexOf("first");
    const to = source.indexOf("second") + "second".length;
    const editor = {
      getSelection: () => source.slice(from, to),
      getCursor: (where?: "from" | "to") => where === "to" ? { line: 4, ch: 6 } : { line: 1, ch: 0 },
    };
    expect(captureSelection("note.md", source, editor)?.headingPath).toBeNull();
  });

  it("captures a different thread as one immutable visible-transcript source", () => {
    const thread = { id: "thread-source", title: "Referenced thread", createdAt: "now", updatedAt: "now" };
    const messages = [
      { id: "u1", threadId: thread.id, turnId: "turn-1", role: "user" as const, content: "Question", createdAt: "1" },
      { id: "a1", threadId: thread.id, turnId: "turn-1", role: "assistant" as const, content: "Answer", createdAt: "2" },
    ];
    const captured = captureConversation(thread, messages);
    expect(captured.scope).toBe("conversation");
    expect(captured.conversationThreadId).toBe(thread.id);
    expect(captured.conversationTitle).toBe(thread.title);
    expect(captured.contentSnapshot).toBe("User:\nQuestion\n\nAssistant:\nAnswer");
    expect(captured.contentSnapshot).not.toContain("source_snapshots");
  });

  it("prevents exact duplicates and preserves insertion order", () => {
    const first = item("one", "same");
    const duplicate = item("two", "same");
    const second = item("three", "different");
    const afterFirst = addTrayItem([], first);
    const afterDuplicate = addTrayItem(afterFirst.tray, duplicate);
    const afterSecond = addTrayItem(afterDuplicate.tray, second);
    expect(afterDuplicate.duplicate).toBe(true);
    expect(afterSecond.tray.map((entry) => entry.id)).toEqual(["one", "three"]);
    expect(trayIdentity(first)).toBe(trayIdentity(duplicate));
    expect(removeTrayItem(afterSecond.tray, "one").map((entry) => entry.id)).toEqual(["three"]);
  });
});
