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

  it("pops a sibling before adding its later child", () => {
    const headings = parseMarkdownHeadings("# A\n## B\n## C\n### D\n");
    expect(headings.find((heading) => heading.text === "D")?.path).toEqual(["A", "C", "D"]);
  });

  it("preserves actual ancestry when heading levels are skipped", () => {
    const headings = parseMarkdownHeadings("# A\n### C\n#### D\n## B\n#### E\n");
    expect(headings.find((heading) => heading.text === "C")?.path).toEqual(["A", "C"]);
    expect(headings.find((heading) => heading.text === "D")?.path).toEqual(["A", "C", "D"]);
    expect(headings.find((heading) => heading.text === "E")?.path).toEqual(["A", "B", "E"]);
  });

  it("discards deeper ancestry on an upward sibling transition", () => {
    const headings = parseMarkdownHeadings("# A\n## B\n### C\n## D\n### E\n");
    expect(headings.find((heading) => heading.text === "D")?.path).toEqual(["A", "D"]);
    expect(headings.find((heading) => heading.text === "E")?.path).toEqual(["A", "D", "E"]);
  });
});
