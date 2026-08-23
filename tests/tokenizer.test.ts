import { describe, expect, it } from "vitest";
import { TokenCountCache } from "../src/tokens/tokenizer";
import { LinkedContextState, Message, TrayItem } from "../src/state/types";

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

  it("counts one shared linked destination once even when two roots include it", () => {
    const roots: TrayItem[] = [
      { id: "a", sourcePath: "A.md", scope: "whole_note", headingPath: null, contentSnapshot: "A", addedAt: "now" },
      { id: "b", sourcePath: "B.md", scope: "whole_note", headingPath: null, contentSnapshot: "B", addedAt: "now" },
    ];
    const linkedContext: LinkedContextState = {
      sources: [{ destinationSourceId: "x", sourcePath: "X.md", scope: "whole_note", contentSnapshot: "X", addedAt: "now" }],
      selections: [
        { parentSourceId: "a", destinationSourceId: "x", authoredTarget: "X", displayText: "X" },
        { parentSourceId: "b", destinationSourceId: "x", authoredTarget: "X", displayText: "X" },
      ],
    };
    const cache = new TokenCountCache((value) => value.length);
    cache.updateSystem("");
    cache.updateConversation("thread", 0, []);
    cache.updateTray(1, roots, linkedContext);
    const breakdown = cache.breakdown("", "thread");
    expect(breakdown.tray).toBeGreaterThan(0);
    expect(cache.tokenizationCounts().tray).toBe(1);
  });
});
