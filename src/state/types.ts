export type Scope = "highlight" | "heading" | "whole_note";
export type MessageRole = "user" | "assistant";

export interface TrayItem {
  id: string;
  sourcePath: string;
  scope: Scope;
  headingPath: string[] | null;
  contentSnapshot: string;
  addedAt: string;
}

export interface Thread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  threadId: string;
  turnId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface Turn {
  id: string;
  threadId: string;
  userMessageId: string;
  assistantMessageId: string;
  createdAt: string;
}

export interface SourceSnapshot {
  id: string;
  turnId: string;
  sourceIndex: number;
  sourcePath: string;
  scope: Scope;
  headingPath: string[] | null;
  contentSnapshot: string;
}

export interface TokenBreakdown {
  system: number;
  conversation: number;
  tray: number;
  draft: number;
  total: number;
}

export interface PersistedState {
  threads: Thread[];
  messages: Message[];
  turns: Turn[];
  sourceSnapshots: SourceSnapshot[];
  activeTray: TrayItem[];
  previousTray: TrayItem[];
  activeThreadId: string | null;
}

export const DEFAULT_SYSTEM_PROMPT = `You are a synthesis partner working with authored material deliberately
selected by the user.

Treat the selected sources as contextual evidence for the current turn,
not as an exhaustive representation of the user's vault.

Synthesize across the selected material and the conversation as requested.
Preserve meaningful distinctions and tensions rather than forcing
agreement where the sources differ.

When grounding a claim in selected material, use the supplied source
identifiers such as [S1], [S2], and [S3].

Do not infer that something is absent from the user's vault merely because
it was not included in the selected sources for this turn.`;

export interface PluginSettings {
  /** Only the Obsidian SecretStorage name is persisted here. */
  secretName: string;
  model: string;
  systemPrompt: string;
  maxOutputTokens: number;
  promptCachingEnabled: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  secretName: "",
  model: "gpt-5.6",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  maxOutputTokens: 4096,
  promptCachingEnabled: true,
};
