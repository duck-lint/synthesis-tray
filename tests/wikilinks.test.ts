import { describe, expect, it } from "vitest";
import { parseOutgoingWikilinks, resolveOutgoingWikilinks } from "../src/capture/wikilinks";
import { requestSources, serializeTray } from "../src/openai/sourceSerializer";
import { LinkedContextState, TrayItem } from "../src/state/types";

const source = (path: string, content: string): TrayItem => ({ id: path, sourcePath: path, scope: "whole_note", headingPath: null, contentSnapshot: content, addedAt: "now" });
const linked = (path: string, content: string) => ({ destinationSourceId: path, sourcePath: path, scope: "whole_note" as const, contentSnapshot: content, addedAt: "now" });

describe("authored wikilink awareness and linked context", () => {
  it("returns no destinations for a source without wikilinks and ignores embeds", () => {
    expect(parseOutgoingWikilinks("plain text\n![[embedded.png]]\n```md\n[[code-only]]\n```")).toEqual([]);
  });

  it("preserves alias text while resolving the destination through Obsidian", () => {
    const parsed = parseOutgoingWikilinks("[[Principle of Sufficient Reason|PSR]] and [[Missing]]");
    expect(parsed).toEqual([
      { authoredTarget: "Principle of Sufficient Reason", displayText: "PSR" },
      { authoredTarget: "Missing", displayText: "Missing" },
    ]);
    const app = { metadataCache: { getFirstLinkpathDest: (target: string) => target === "Principle of Sufficient Reason" ? { path: "PSR.md" } : null } } as never;
    expect(resolveOutgoingWikilinks(app, source("Kant.md", "[[Principle of Sufficient Reason|PSR]] and [[Missing]]"))).toEqual([
      { authoredTarget: "Principle of Sufficient Reason", displayText: "PSR", destinationPath: "PSR.md", destinationSourceId: "PSR.md" },
      { authoredTarget: "Missing", displayText: "Missing", destinationPath: null, destinationSourceId: null },
    ]);
  });

  it("serializes destination identity without destination content until inclusion", () => {
    const root = { ...source("A.md", "A"), outgoingWikilinks: [{ authoredTarget: "B", displayText: "Shown B", destinationSourceId: "B.md", destinationPath: "B.md" }] };
    const text = serializeTray([root]);
    expect(text).toContain("Shown B");
    expect(text).toContain("destination: B.md");
    expect(text).not.toContain("DESTINATION CONTENT");
  });

  it("keeps linked content one hop and serializes a shared destination once", () => {
    const a = { ...source("A.md", "A"), outgoingWikilinks: [{ authoredTarget: "X", displayText: "X", destinationSourceId: "X.md", destinationPath: "X.md" }] };
    const b = source("B.md", "B");
    const context: LinkedContextState = {
      sources: [linked("X.md", "X [[C.md]]")],
      selections: [
        { parentSourceId: a.id, destinationSourceId: "X.md", authoredTarget: "X", displayText: "X" },
        { parentSourceId: b.id, destinationSourceId: "X.md", authoredTarget: "X", displayText: "X" },
      ],
    };
    const request = requestSources([a, b], context);
    expect(request.map((entry) => entry.item.sourcePath)).toEqual(["A.md", "B.md", "X.md"]);
    expect(request.at(-1)?.parentSourceIds).toEqual(["A.md", "B.md"]);
    const text = serializeTray([a, b], context);
    expect(text.match(/source: X\.md/g)).toHaveLength(1);
    expect(text).toContain("parent source: A.md, B.md");
    expect(text).not.toContain("source: C.md");
  });

  it("does not duplicate a destination already represented by an explicit root", () => {
    const a = { ...source("A.md", "A"), outgoingWikilinks: [{ authoredTarget: "X", displayText: "X", destinationSourceId: "X.md", destinationPath: "X.md" }] };
    const x = source("X.md", "explicit X");
    const context: LinkedContextState = {
      sources: [linked("X.md", "linked X")],
      selections: [{ parentSourceId: a.id, destinationSourceId: "X.md", authoredTarget: "X", displayText: "X" }],
    };
    const request = requestSources([a, x], context);
    expect(request.map((entry) => entry.item.sourcePath)).toEqual(["A.md", "X.md"]);
    expect(serializeTray([a, x], context)).toContain("outgoing wikilinks");
    expect(serializeTray([a, x], context)).not.toContain("linked X");
  });
});
