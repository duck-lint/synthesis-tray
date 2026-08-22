import { describe, expect, it } from "vitest";
import { TokenCountCache } from "../src/tokens/tokenizer";
import { Message, TrayItem } from "../src/state/types";

const tray: TrayItem[] = [{ id: "large", sourcePath: "large.md", scope: "whole_note", headingPath: null, contentSnapshot: "x".repeat(30000), addedAt: "now" }];
const messages: Message[] = [{ id: "message", threadId: "thread", turnId: "turn", role: "user", content: "question", createdAt: "now" }];

describe("stable token-count caching", () => {
  it("does not retokenize a stable tray while the draft changes", () => {
    const cache = new TokenCountCache((value) => value.length);
    cache.updateSystem("system");
    cache.updateConversation("thread", 0, messages);
    cache.updateTray(1, tray);
    for (let index = 0; index < 10; index += 1) cache.breakdown(`draft ${index}`, "thread");
    expect(cache.tokenizationCounts()).toEqual({ system: 1, conversation: 1, tray: 1, draft: 10 });
  });

  it("invalidates only the changed stable bucket", () => {
    const cache = new TokenCountCache((value) => value.length);
    cache.updateSystem("system");
    cache.updateConversation("thread", 0, messages);
    cache.updateTray(1, tray);
    cache.breakdown("draft", "thread");
    cache.updateTray(2, []);
    cache.breakdown("draft", "thread");
    expect(cache.tokenizationCounts()).toMatchObject({ system: 1, conversation: 1, tray: 2, draft: 2 });
    cache.updateConversation("thread", 1, [{ ...messages[0], content: "changed" }]);
    cache.breakdown("draft", "thread");
    expect(cache.tokenizationCounts().conversation).toBe(2);
  });
});
