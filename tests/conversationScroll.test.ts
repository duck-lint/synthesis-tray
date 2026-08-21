import { describe, expect, it } from "vitest";
import { scrollConversationToMessageStart } from "../src/view/conversationScroll";

describe("completed assistant scroll", () => {
  it("scrolls the conversation viewport to the message start, not its bottom", () => {
    const container = { scrollTop: 12, getBoundingClientRect: () => ({ top: 100 }) } as unknown as HTMLElement;
    const message = { getBoundingClientRect: () => ({ top: 240, bottom: 900 }) } as unknown as HTMLElement;

    scrollConversationToMessageStart(container, message);

    expect(container.scrollTop).toBe(152);
    expect(container.scrollTop).not.toBe(900);
  });

  it("never scrolls the whole workspace through the message helper", () => {
    const container = { scrollTop: 0, getBoundingClientRect: () => ({ top: 40 }) } as unknown as HTMLElement;
    const message = { getBoundingClientRect: () => ({ top: 40, bottom: 600 }) } as unknown as HTMLElement;
    const workspace = { scrollTop: 77 };

    scrollConversationToMessageStart(container, message);

    expect(container.scrollTop).toBe(0);
    expect(workspace.scrollTop).toBe(77);
  });
});
