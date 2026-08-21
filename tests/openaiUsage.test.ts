import { afterEach, describe, expect, it, vi } from "vitest";
import { streamResponse } from "../src/openai/client";
import { turnUsageFromProvider } from "../src/openai/usage";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI streaming usage", () => {
  it("returns provider usage from the completed response event", async () => {
    const body = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "answer" })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 5 } } } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })));

    const result = await streamResponse("secret", {}, { onDelta: vi.fn() }, new AbortController().signal);
    expect(result.output).toBe("answer");
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 5 } });
    expect(turnUsageFromProvider("turn-1", result.usage)).toMatchObject({ cachedInputTokens: 3, cacheWriteTokens: 5 });
  });
});
