import { describe, expect, it } from "vitest";
import { citationContextIsEligible, parseCitationReferences } from "../src/view/citations";
import { snapshotLines } from "../src/view/snapshotLines";
import { DEFAULT_SYSTEM_PROMPT } from "../src/state/types";

describe("historical citation presentation", () => {
  it("parses source and snapshot-relative line references", () => {
    expect(parseCitationReferences("See [S1], [S2:L42], and [S3:L7-L12].")).toEqual([
      { sourceIndex: 1, lineStart: null, lineEnd: null, raw: "[S1]" },
      { sourceIndex: 2, lineStart: 42, lineEnd: 42, raw: "[S2:L42]" },
      { sourceIndex: 3, lineStart: 7, lineEnd: 12, raw: "[S3:L7-L12]" },
    ]);
  });

  it("does not manufacture lines for a source-only citation", () => {
    expect(parseCitationReferences("Supported by [S1].")[0]).toEqual({ sourceIndex: 1, lineStart: null, lineEnd: null, raw: "[S1]" });
  });

  it("parses semicolon-grouped citations into individually inspectable references", () => {
    expect(parseCitationReferences("Supported by [S1:L82-L83; S1:L103-L110].")).toEqual([
      { sourceIndex: 1, lineStart: 82, lineEnd: 83, raw: "[S1:L82-L83]" },
      { sourceIndex: 1, lineStart: 103, lineEnd: 110, raw: "[S1:L103-L110]" },
    ]);
    expect(parseCitationReferences("[S1:L82-L83;S2:L4]")).toEqual([
      { sourceIndex: 1, lineStart: 82, lineEnd: 83, raw: "[S1:L82-L83]" },
      { sourceIndex: 2, lineStart: 4, lineEnd: 4, raw: "[S2:L4]" },
    ]);
  });

  it("requires narrow localized citations without requiring citation noise", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("cite the narrowest useful snapshot-relative line or line");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("[S1:L82-L83; S1:L103-L110]");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("Use plain [S1] only for a genuinely source-wide claim");
  });

  it("numbers the captured snapshot rather than claiming vault coordinates", () => {
    expect(snapshotLines("heading\nselected text")).toEqual([
      { number: 1, text: "heading" },
      { number: 2, text: "selected text" },
    ]);
  });

  it("does not decorate citations inside code, links, or existing controls", () => {
    expect(citationContextIsEligible(["P", "DIV"])).toBe(true);
    expect(citationContextIsEligible(["CODE", "PRE", "DIV"])).toBe(false);
    expect(citationContextIsEligible(["A", "P", "DIV"])).toBe(false);
    expect(citationContextIsEligible(["BUTTON", "P", "DIV"])).toBe(false);
  });
});
