import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { insertAssistantReference, selectionIsInsideOneMessage } from "../src/view/assistantReference";

describe("assistant presentation", () => {
  it("explicitly permits native text selection for assistant Markdown", () => {
    const styles = readFileSync("styles.css", "utf8");
    expect(styles).toMatch(/\.synthesis-message-assistant[\s\S]*user-select:\s*text/);
    expect(styles).toMatch(/\.synthesis-message-assistant[\s\S]*-webkit-user-select:\s*text/);
  });

  it("inserts a visible quoted assistant excerpt into the next user message", () => {
    expect(insertAssistantReference("Follow up", "first line\nsecond line")).toBe("Referenced from Assistant:\n\n> first line\n> second line\n\nFollow up");
    expect(insertAssistantReference("", "   ")).toBe("");
  });

  it("accepts one-message selection and rejects a cross-message selection", () => {
    const inside = {};
    const outside = {};
    const content = { contains: (node: unknown) => node === inside } as unknown as HTMLElement;
    const selection = (anchorNode: unknown, focusNode: unknown) => ({
      isCollapsed: false,
      anchorNode,
      focusNode,
      toString: () => "selected",
      getRangeAt: () => ({ commonAncestorContainer: anchorNode }),
    }) as unknown as Selection;
    expect(selectionIsInsideOneMessage(selection(inside, inside), content)).toBe(true);
    expect(selectionIsInsideOneMessage(selection(inside, outside), content)).toBe(false);
  });
});
