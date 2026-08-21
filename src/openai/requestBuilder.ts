import { Message, PluginSettings, TrayItem } from "../state/types";
import { serializeTray } from "./sourceSerializer";

export interface ResponsesInputMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ResponsesRequest {
  model: string;
  instructions: string;
  input: ResponsesInputMessage[];
  max_output_tokens: number;
  stream: true;
  prompt_cache_key?: string;
  prompt_cache_options?: { mode: "implicit"; ttl: "30m" };
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

export function promptCacheKey(settings: PluginSettings): string {
  return `obsidian-synthesis-tray:${settings.model.trim()}:${stableHash(settings.systemPrompt)}`;
}

function supportsPromptCacheOptions(model: string): boolean {
  return /^gpt-5\.6(?:$|[-.])/.test(model.trim());
}

export function buildResponsesRequest(settings: PluginSettings, priorMessages: Message[], tray: TrayItem[], draft: string): ResponsesRequest {
  const { currentUser } = buildRequestText(priorMessages, tray, draft);
  const request: ResponsesRequest = {
    model: settings.model.trim(),
    instructions: settings.systemPrompt,
    input: [
      ...priorMessages.map((message) => ({ role: message.role, content: message.content })),
      { role: "user", content: currentUser },
    ],
    max_output_tokens: settings.maxOutputTokens,
    stream: true,
  };
  if (settings.promptCachingEnabled) {
    request.prompt_cache_key = promptCacheKey(settings);
    if (supportsPromptCacheOptions(request.model)) request.prompt_cache_options = { mode: "implicit", ttl: "30m" };
  }
  return request;
}
