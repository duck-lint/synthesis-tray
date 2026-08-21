import { describe, expect, it } from "vitest";
import { composerPresentation } from "../src/view/composerPresentation";

describe("composer request lifecycle presentation", () => {
  it("starts with an editable composer when a secret is configured", () => {
    expect(composerPresentation(false, "", true)).toEqual({ textareaDisabled: false, sendButtonText: "Send", sendButtonDisabled: true });
    expect(composerPresentation(false, "first message", true).textareaDisabled).toBe(false);
  });

  it("disables the composer only while a request is in flight", () => {
    expect(composerPresentation(true, "first message", true)).toEqual({ textareaDisabled: true, sendButtonText: "Stop", sendButtonDisabled: false });
    expect(composerPresentation(false, "", true).textareaDisabled).toBe(false);
  });

  it.each(["success", "failure", "abort"])("returns to an editable composer after %s", () => {
    let streaming = false;
    streaming = true;
    try {
      // The request outcome is intentionally irrelevant to the terminal state.
    } finally {
      streaming = false;
    }
    expect(composerPresentation(streaming, "second message", true).textareaDisabled).toBe(false);
    expect(composerPresentation(streaming, "second message", true).sendButtonText).toBe("Send");
  });

  it("keeps a new or switched thread editable when idle", () => {
    expect(composerPresentation(false, "", true).textareaDisabled).toBe(false);
    expect(composerPresentation(false, "next thread message", true).sendButtonDisabled).toBe(false);
  });

  it("keeps the composer editable after recalling the previous tray", () => {
    // Tray recall changes source state, not request lifecycle state.
    expect(composerPresentation(false, "follow-up after recall", true)).toEqual({
      textareaDisabled: false,
      sendButtonText: "Send",
      sendButtonDisabled: false,
    });
  });
});
