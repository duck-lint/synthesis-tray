import { describe, expect, it } from "vitest";
import { buildRequestText, buildResponsesRequest } from "../src/openai/requestBuilder";
import { serializeSourceLines, serializeTray } from "../src/openai/sourceSerializer";
import { Message, PluginSettings, TrayItem } from "../src/state/types";

const settings: PluginSettings = { secretName: "openai-main", systemPrompt: "synth", maxOutputTokens: 123, promptCachingEnabled: false };
const config = { model: "gpt-5.6-sol" as const, reasoningEffort: "medium" as const };
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
    const request = buildResponsesRequest(settings, config, "thread", prior, [source("b.md", "CURRENT B")], "Compare this.");
    expect(request.instructions).toBe("synth");
    expect(request.model).toBe("gpt-5.6-sol");
    expect(request.reasoning).toEqual({ effort: "medium" });
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
    const first = buildResponsesRequest(settings, config, "thread", [message("user", "First"), message("assistant", "Answer mentioning A")], [source("a.md", "OLD A")], "First");
    const second = buildResponsesRequest(settings, config, "thread", [message("user", "First"), message("assistant", "Answer mentioning A")], [source("b.md", "NEW B")], "Second");
    expect(first.input.at(-1)?.content).toContain("OLD A");
    expect(second.input.at(-1)?.content).toContain("NEW B");
    expect(second.input.at(-1)?.content).not.toContain("OLD A");
    expect(first.input.slice(0, -1)).toEqual(second.input.slice(0, -1));
  });

  it("adds deterministic line numbers only to model-facing source serialization", () => {
    const raw = "first\nsecond\nthird";
    const text = serializeTray([source("a.md", raw)]);
    expect(serializeSourceLines(raw)).toBe("L1: first\nL2: second\nL3: third");
    expect(text).toContain("L1: first\nL2: second\nL3: third");
    expect(text).toContain("[S1]");
    expect(source("a.md", raw).contentSnapshot).toBe(raw);
  });

  it("builds equivalent requests regardless of whether tray or message state was populated first", () => {
    const prior = [message("user", "Earlier"), message("assistant", "Earlier answer")];
    const buildAfter = (order: "message-first" | "tray-first") => {
      let currentTray: TrayItem[] = [];
      let currentDraft = "";
      if (order === "message-first") currentDraft = "Compare these.";
      currentTray = [source("a.md", "A"), source("b.md", "B")];
      if (order === "tray-first") currentDraft = "Compare these.";
      return buildResponsesRequest(settings, config, "thread", prior, currentTray, currentDraft);
    };
    const first = buildAfter("message-first");
    const second = buildAfter("tray-first");
    expect(second).toEqual(first);
    expect(first.instructions).toBe("synth");
    expect(first.input.at(-1)?.content).toContain("USER MESSAGE:\n\nCompare these.");
  });

  it("keeps instructions in every request while enabling or disabling cache metadata", () => {
    const cached = buildResponsesRequest({ ...settings, promptCachingEnabled: true }, config, "thread-a", [], [], "One");
    const ordinary = buildResponsesRequest({ ...settings, promptCachingEnabled: false }, config, "thread-a", [], [], "One");
    expect(cached.instructions).toBe(ordinary.instructions);
    expect(cached.input).toEqual(ordinary.input);
    expect(cached.prompt_cache_key).toBeTruthy();
    expect(cached.prompt_cache_key).not.toContain("A");
    expect(cached.prompt_cache_key).not.toContain("openai-main");
    expect(cached.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
    expect(ordinary).not.toHaveProperty("prompt_cache_key");
    expect(ordinary).not.toHaveProperty("prompt_cache_options");
  });

  it("marks only the latest two supported user boundaries and leaves assistant and tray suffixes unmarked", () => {
    const prior = [
      message("user", "User 1"), message("assistant", "Assistant 1"),
      message("user", "User 2"), message("assistant", "Assistant 2"),
      message("user", "User 3"), message("assistant", "Assistant 3"),
    ];
    const request = buildResponsesRequest({ ...settings, promptCachingEnabled: true }, config, "thread", prior, [source("current.md", "CURRENT TRAY")], "CURRENT MESSAGE");
    expect(request.input.slice(0, 3)).toEqual([
      { role: "user", content: "User 1" },
      { role: "assistant", content: "Assistant 1" },
      { role: "user", content: [{ type: "input_text", text: "User 2", prompt_cache_breakpoint: { mode: "explicit" } }] },
    ]);
    expect(request.input[2]).toEqual({ role: "user", content: [{ type: "input_text", text: "User 2", prompt_cache_breakpoint: { mode: "explicit" } }] });
    expect(request.input[4]).toEqual({ role: "user", content: [{ type: "input_text", text: "User 3", prompt_cache_breakpoint: { mode: "explicit" } }] });
    expect(request.input[3]).toEqual({ role: "assistant", content: "Assistant 2" });
    expect(request.input[5]).toEqual({ role: "assistant", content: "Assistant 3" });
    expect(request.input.at(-1)?.content).toEqual(expect.stringContaining("CURRENT TRAY"));
    expect(request.input.at(-1)?.content).toEqual(expect.stringContaining("CURRENT MESSAGE"));
    expect(JSON.stringify(request.input.at(-1))).not.toContain("prompt_cache_breakpoint");
  });

  it("scopes cache keys to the thread and system prompt namespace", () => {
    const base = { ...settings, promptCachingEnabled: true };
    const first = buildResponsesRequest(base, config, "thread-a", [], [], "One");
    const otherThread = buildResponsesRequest(base, config, "thread-b", [], [], "One");
    const otherPrompt = buildResponsesRequest({ ...base, systemPrompt: "different" }, config, "thread-a", [], [], "One");
    expect(first.prompt_cache_key).not.toBe(otherThread.prompt_cache_key);
    expect(first.prompt_cache_key).not.toBe(otherPrompt.prompt_cache_key);
    expect(first.prompt_cache_key).toMatch(/^synthesis-tray:/);
  });

  it("does not pad a short reusable prefix", () => {
    const request = buildResponsesRequest({ ...settings, promptCachingEnabled: true }, config, "thread", [message("user", "short"), message("assistant", "short answer")], [], "question");
    const marked = request.input[1].content;
    expect(marked).toBe("short answer");
    expect(JSON.stringify(request)).not.toContain("padding");
  });
});
