import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("quality-of-life interaction boundaries", () => {
  it("contains no browser-native prompt or confirm calls", () => {
    const source = `${readFileSync("src/main.ts", "utf8")}\n${readFileSync("src/view/SynthesisView.ts", "utf8")}`;
    expect(source).not.toMatch(/window\.(prompt|confirm|alert)\s*\(/);
  });

  it("labels the unsent composer bucket as Message", () => {
    const source = readFileSync("src/view/SynthesisView.ts", "utf8");
    expect(source).toContain("message ${breakdown.draft.toLocaleString()}");
    expect(source).not.toContain("draft ${breakdown.draft.toLocaleString()}");
  });
});
