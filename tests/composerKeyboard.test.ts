import { describe, expect, it } from "vitest";
import { shouldSendOnEnter } from "../src/view/composerKeyboard";

describe("synthesis composer keyboard", () => {
  it("sends on plain Enter only when a send will actually occur", () => {
    expect(shouldSendOnEnter({ key: "Enter", shiftKey: false, isComposing: false }, true)).toBe(true);
    expect(shouldSendOnEnter({ key: "Enter", shiftKey: true, isComposing: false }, true)).toBe(false);
    expect(shouldSendOnEnter({ key: "Enter", shiftKey: false, isComposing: false }, false)).toBe(false);
  });

  it("does not send during IME composition, including keyCode 229", () => {
    expect(shouldSendOnEnter({ key: "Enter", shiftKey: false, isComposing: true }, true)).toBe(false);
    expect(shouldSendOnEnter({ key: "Enter", keyCode: 229, shiftKey: false }, true)).toBe(false);
  });
});
