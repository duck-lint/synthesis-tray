import { ProviderUsage } from "../state/types";

export class OpenAIRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "OpenAIRequestError";
  }
}

export interface StreamCallbacks {
  onDelta: (delta: string) => void;
}

export interface StreamResponseResult {
  output: string;
  usage: ProviderUsage | null;
}

function readableError(status: number, body: string): string {
  if (status === 401) return "OpenAI rejected the configured secret.";
  if (status === 429) return "OpenAI rate limit reached. Try again later.";
  if (status >= 500) return "OpenAI is temporarily unavailable.";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message || `OpenAI request failed (${status}).`;
  } catch {
    return `OpenAI request failed (${status}).`;
  }
}

/** Direct stateless Responses API streaming. The secret is accepted only for this call. */
export async function streamResponse(apiKey: string, request: unknown, callbacks: StreamCallbacks, signal: AbortSignal): Promise<StreamResponseResult> {
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
    throw new OpenAIRequestError(`Network error: ${error instanceof Error ? error.message : "request failed"}`);
  }
  if (!response.ok) throw new OpenAIRequestError(readableError(response.status, await response.text()), response.status);
  if (!response.body) throw new OpenAIRequestError("OpenAI returned no streaming body.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let completed = false;
  let usage: ProviderUsage | null = null;
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return;
    let event: { type?: string; delta?: string; error?: { message?: string }; usage?: unknown; response?: { usage?: unknown } };
    try {
      event = JSON.parse(data);
    } catch {
      throw new OpenAIRequestError("OpenAI returned malformed streaming data.");
    }
    if (event.type === "error") throw new OpenAIRequestError(event.error?.message ?? "OpenAI returned a streaming error.");
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      output += event.delta;
      callbacks.onDelta(event.delta);
    }
    if (event.type === "response.completed") {
      const candidate = event.response?.usage ?? event.usage;
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) usage = candidate as ProviderUsage;
      completed = true;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line.replace(/\r$/, ""));
    if (done) break;
  }
  if (buffer.trim()) consume(buffer.trim());
  if (!completed) throw new OpenAIRequestError("OpenAI ended the stream without a completed response.");
  return { output, usage };
}
