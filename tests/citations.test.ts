import { describe, expect, it } from "vitest";
import { citationContextIsEligible, parseCitationReferences } from "../src/view/citations";
import { snapshotLines } from "../src/view/snapshotLines";

describe("historical citation presentation", () => {
  it("parses source and snapshot-relative line references", () => {
    expect(parseCitationReferences("See [S1], [S2:L42], and [S3:L7-L12].")).toEqual([
      { sourceIndex: 1, lineStart: null, lineEnd: null, raw: "[S1]" },
      { sourceIndex: 2, lineStart: 42, lineEnd: 42, raw: "[S2:L42]" },
      { sourceIndex: 3, lineStart: 7, lineEnd: 12, raw: "[S3:L7-L12]" },
    ]);
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
