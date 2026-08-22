import { getEncoding } from "js-tiktoken";
import type { Tiktoken } from "js-tiktoken";
import { Message, TokenBreakdown, TrayItem } from "../state/types";
import { serializeTray } from "../openai/sourceSerializer";

let encoder: Tiktoken | null = null;

function count(value: string): number {
  if (!encoder) encoder = getEncoding("o200k_base");
  return encoder.encode(value).length;
}

export function serializeConversation(messages: Message[]): string {
  return messages.map((message) => `${message.role === "user" ? "USER" : "ASSISTANT"}:\n${message.content}`).join("\n\n");
}

export interface TokenizationCounts {
  system: number;
  conversation: number;
  tray: number;
  draft: number;
}

type Tokenize = (value: string) => number;

/**
 * Counts stable request buckets once per authority revision. Draft input is
 * intentionally counted as a separate approximate suffix: re-tokenizing the
 * complete tray to model tokenizer-boundary effects would make typing scale
 * with static context size. The displayed total is therefore explicitly an
 * additive estimate, not a provider billing calculation.
 */
export class TokenCountCache {
  private systemPrompt: string | null = null;
  private systemTokens = 0;
  private readonly conversations = new Map<string, { revision: number; tokens: number }>();
  private trayRevision = -1;
  private trayTokens = 0;
  private trayPresent = false;
  private readonly tokenize: Tokenize;
  private readonly counts: TokenizationCounts = { system: 0, conversation: 0, tray: 0, draft: 0 };

  constructor(tokenize: Tokenize = count) {
    this.tokenize = tokenize;
  }

  updateSystem(prompt: string): void {
    if (this.systemPrompt === prompt) return;
    this.systemPrompt = prompt;
    this.systemTokens = this.tokenize(prompt);
    this.counts.system += 1;
  }

  updateConversation(threadId: string, revision: number, messages: Message[]): void {
    const cached = this.conversations.get(threadId);
    if (cached?.revision === revision) return;
    this.conversations.set(threadId, { revision, tokens: this.tokenize(serializeConversation(messages)) });
    this.counts.conversation += 1;
  }

  updateTray(revision: number, tray: TrayItem[]): void {
    if (this.trayRevision === revision) return;
    this.trayRevision = revision;
    this.trayPresent = tray.length > 0;
    this.trayTokens = this.tokenize(serializeTray(tray));
    this.counts.tray += 1;
  }

  breakdown(draft: string, threadId: string): TokenBreakdown {
    const conversation = this.conversations.get(threadId)?.tokens ?? 0;
    const draftText = this.trayPresent ? `\n\nUSER MESSAGE:\n\n${draft}` : draft;
    const draftTokens = this.tokenize(draftText);
    this.counts.draft += 1;
    const total = this.systemTokens + conversation + this.trayTokens + draftTokens;
    return { system: this.systemTokens, conversation, tray: this.trayTokens, draft: draftTokens, total };
  }

  tokenizationCounts(): TokenizationCounts {
    return { ...this.counts };
  }
}

export function countNextRequest(systemPrompt: string, priorMessages: Message[], tray: TrayItem[], draft: string): TokenBreakdown {
  const cache = new TokenCountCache();
  cache.updateSystem(systemPrompt);
  cache.updateConversation("request", 0, priorMessages);
  cache.updateTray(0, tray);
  return cache.breakdown(draft, "request");
}
