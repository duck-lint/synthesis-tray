import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("assistant presentation", () => {
  it("explicitly permits native text selection for assistant Markdown", () => {
    const styles = readFileSync("styles.css", "utf8");
    expect(styles).toMatch(/\.synthesis-message-assistant[\s\S]*user-select:\s*text/);
    expect(styles).toMatch(/\.synthesis-message-assistant[\s\S]*-webkit-user-select:\s*text/);
  });
});
