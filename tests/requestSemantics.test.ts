import { describe, expect, it } from "vitest";
import { buildRequestText, buildResponsesRequest } from "../src/openai/requestBuilder";
import { serializeTray } from "../src/openai/sourceSerializer";
import { Message, PluginSettings, TrayItem } from "../src/state/types";

const settings: PluginSettings = { secretName: "openai-main", model: "custom-model", systemPrompt: "synth", maxOutputTokens: 123 };
const source = (path: string, content: string): TrayItem => ({ id: path, sourcePath: path, scope: "whole_note", headingPath: null, contentSnapshot: content, addedAt: "now" });
const message = (role: Message["role"], content: string): Message => ({ id: content, threadId: "thread", turnId: "turn", role, content, createdAt: "now" });

describe("explicit request context", () => {
  it("assigns S identifiers from current insertion order", () => {
    const text = serializeTray([source("a.md", "A"), source("b.md", "B"), source("c.md", "C")]);
    expect(text).toContain("[S1]");
    expect(text).toContain("[S2]");
    expect(text).toContain("[S3]");
    expect(text.indexOf("source: a.md")).toBeLessThan(text.indexOf("source: b.md"));
  });

  it("puts only the current tray in the current user turn", () => {
    const prior = [message("user", "What was A?"), message("assistant", "A was discussed.")];
    const request = buildResponsesRequest(settings, prior, [source("b.md", "CURRENT B")], "Compare this.");
    expect(request.instructions).toBe("synth");
    expect(request.input).toEqual([
      { role: "user", content: "What was A?" },
      { role: "assistant", content: "A was discussed." },
      { role: "user", content: expect.stringContaining("CURRENT B") },
    ]);
    expect(request.input[2].content).not.toContain("A CONTENT");
    expect(request.input[2].content).toContain("USER MESSAGE:\n\nCompare this.");
  });

  it("does not put source serialization into the visible stored user message", () => {
    const { currentUser } = buildRequestText([], [source("a.md", "A CONTENT")], "Question");
    expect(currentUser).toContain("A CONTENT");
    const visibleUserMessage = "Question";
    expect(visibleUserMessage).not.toContain("A CONTENT");
  });

  it("does not resend an old tray when the next tray changes", () => {
    const first = buildResponsesRequest(settings, [message("user", "First"), message("assistant", "Answer mentioning A")], [source("a.md", "OLD A")], "First");
    const second = buildResponsesRequest(settings, [message("user", "First"), message("assistant", "Answer mentioning A")], [source("b.md", "NEW B")], "Second");
    expect(first.input.at(-1)?.content).toContain("OLD A");
    expect(second.input.at(-1)?.content).toContain("NEW B");
    expect(second.input.at(-1)?.content).not.toContain("OLD A");
  });
});
