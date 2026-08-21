import { Message, PluginSettings, TrayItem } from "../state/types";
import { serializeTray } from "./sourceSerializer";

export interface ResponsesInputMessage {
  role: "user" | "assistant";
  content: string | ResponsesInputTextBlock[];
}

export interface ResponsesInputTextBlock {
  type: "input_text";
  text: string;
  prompt_cache_breakpoint?: { mode: "explicit" };
}

export interface ResponsesRequest {
  model: string;
  instructions: string;
  input: ResponsesInputMessage[];
  max_output_tokens: number;
  stream: true;
  prompt_cache_key?: string;
  prompt_cache_options?: { mode: "explicit"; ttl: "30m" };
}

export interface RequestTextParts {
  conversation: string;
  tray: string;
  currentUser: string;
}

export function buildRequestText(priorMessages: Message[], tray: TrayItem[], draft: string): RequestTextParts {
  const conversation = priorMessages.map((message) => `${message.role === "user" ? "USER" : "ASSISTANT"}:\n${message.content}`).join("\n\n");
  const trayText = serializeTray(tray);
  const currentUser = trayText ? `${trayText}\n\nUSER MESSAGE:\n\n${draft}` : draft;
  return { conversation, tray: trayText, currentUser };
}

function stableHash(value: string): string {
  // A non-secret, deterministic key is sufficient; the cache key is not a security boundary.
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function promptCacheKey(settings: PluginSettings, threadId: string): string {
  // Responses API keys are limited to 64 characters. Keep the model legible
  // while hashing each namespace component so unrelated threads cannot share
  // a cache entry and long generated IDs cannot exceed the provider limit.
  const model = settings.model.trim().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 16);
  return `synthesis-tray:${model}-${stableHash(settings.model)}:${stableHash(settings.systemPrompt)}:${stableHash(threadId)}`;
}

function supportsPromptCacheOptions(model: string): boolean {
  return /^gpt-5\.6(?:$|[-.])/.test(model.trim());
}

export function buildResponsesRequest(settings: PluginSettings, threadId: string, priorMessages: Message[], tray: TrayItem[], draft: string): ResponsesRequest {
  const { currentUser } = buildRequestText(priorMessages, tray, draft);
  const cacheable = settings.promptCachingEnabled && supportsPromptCacheOptions(settings.model);
  // Responses only accepts breakpoint-capable input_text blocks on user-role
  // message content. Assistant messages accept output_text content, but the
  // provider does not treat a marker there as a cache-writing breakpoint.
  // Marking the latest two completed user boundaries preserves the rolling
  // prefix: the assistant response between the old and new boundaries is part
  // of the newly written extension on the following request.
  const userBoundaries = priorMessages
    .map((message, index) => message.role === "user" ? index : -1)
    .filter((index) => index >= 0)
    .slice(-2);
  const markedBoundaries = new Set(userBoundaries);
  const request: ResponsesRequest = {
    model: settings.model.trim(),
    instructions: settings.systemPrompt,
    input: [
      ...priorMessages.map((message, index): ResponsesInputMessage => markedBoundaries.has(index) && cacheable
        ? { role: message.role, content: [{ type: "input_text", text: message.content, prompt_cache_breakpoint: { mode: "explicit" } }] }
        : { role: message.role, content: message.content }),
      { role: "user", content: currentUser },
    ],
    max_output_tokens: settings.maxOutputTokens,
    stream: true,
  };
  if (cacheable) {
    request.prompt_cache_key = promptCacheKey(settings, threadId);
    request.prompt_cache_options = { mode: "explicit", ttl: "30m" };
  }
  return request;
}
