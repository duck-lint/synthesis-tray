import { getEncoding } from "js-tiktoken";
import type { Tiktoken } from "js-tiktoken";
import { Message, TokenBreakdown, TrayItem } from "../state/types";
import { buildRequestText } from "../openai/requestBuilder";

let encoder: Tiktoken | null = null;

function count(value: string): number {
  if (!encoder) encoder = getEncoding("o200k_base");
  return encoder.encode(value).length;
}

export function countNextRequest(systemPrompt: string, priorMessages: Message[], tray: TrayItem[], draft: string): TokenBreakdown {
  const parts = buildRequestText(priorMessages, tray, draft);
  const system = count(systemPrompt);
  const conversation = count(parts.conversation);
  const trayTokens = count(parts.tray);
  // The draft bucket includes the current-turn USER MESSAGE label and separators.
  // That keeps the displayed breakdown additive while remaining explicitly approximate.
  const draftTokens = count(parts.currentUser) - trayTokens;
  return { system, conversation, tray: trayTokens, draft: draftTokens, total: system + conversation + trayTokens + draftTokens };
}
