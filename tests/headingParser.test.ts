import { describe, expect, it } from "vitest";
import { extractHeadingRegion, parseMarkdownHeadings } from "../src/capture/headingParser";

describe("Markdown heading regions", () => {
  it("stops at an equal-level heading", () => {
    const source = "# A\nalpha\n\n# B\nbeta\n";
    expect(extractHeadingRegion(source, 2)?.content).toBe("# A\nalpha\n\n");
  });

  it("stops at a higher-level heading", () => {
    const source = "## A\nalpha\n### B\nbeta\n# C\ngamma\n";
    expect(extractHeadingRegion(source, 3)?.content).toBe("## A\nalpha\n### B\nbeta\n");
  });

  it("retains nested headings and stops at the next higher/equal heading", () => {
    const source = "## A\nalpha\n\n### B\nbeta\n\n#### C\ngamma\n\n## D\ndelta";
    expect(extractHeadingRegion(source, 2)?.content).toBe("## A\nalpha\n\n### B\nbeta\n\n#### C\ngamma\n\n");
  });

  it("runs a nested heading through EOF", () => {
    const source = "## A\nalpha\n\n### B\nbeta\n";
    const offset = source.indexOf("### B") + 2;
    expect(extractHeadingRegion(source, offset)?.content).toBe("### B\nbeta\n");
  });

  it("handles a heading on the last line", () => {
    const source = "text\n## Last";
    expect(extractHeadingRegion(source, source.length - 1)?.content).toBe("## Last");
  });

  it("ignores headings inside fenced code", () => {
    const source = "```md\n# not a heading\n```\n\n# Actual\ncontent";
    expect(parseMarkdownHeadings(source).map((heading) => heading.text)).toEqual(["Actual"]);
  });
});
