export type Scope = "highlight" | "heading" | "whole_note" | "conversation";
export type MessageRole = "user" | "assistant";

export type SynthesisModel = "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export const DEFAULT_MODEL: SynthesisModel = "gpt-5.6-sol";
// The pre-amendment request had no explicit reasoning control; none is the least
// surprising deterministic default while users can opt into stronger effort.
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "none";

export interface CaptureGroup {
  id: string;
  kind: "folder";
  label: string;
}

export interface TrayItem {
  id: string;
  sourcePath: string;
  scope: Scope;
  headingPath: string[] | null;
  contentSnapshot: string;
  addedAt: string;
  captureGroup?: CaptureGroup;
  conversationThreadId?: string;
  conversationTitle?: string;
}

export interface Thread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: SynthesisModel;
  reasoningEffort: ReasoningEffort;
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
  /** Null means the historical request configuration is not evidenced. */
  model: SynthesisModel | null;
  reasoningEffort: ReasoningEffort | null;
}

export type ProviderUsage = Record<string, unknown>;

export interface TurnUsage {
  turnId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  usageJson: string | null;
}

export interface SourceSnapshot {
  id: string;
  turnId: string;
  sourceIndex: number;
  sourcePath: string;
  scope: Scope;
  headingPath: string[] | null;
  contentSnapshot: string;
  captureGroup?: CaptureGroup;
  conversationThreadId?: string;
  conversationTitle?: string;
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
  turnUsage: TurnUsage[];
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

When grounding a specific passage, prefer line-aware citations such as
[S1:L42-L48] or [S3:L7], where line numbers refer to the numbered source
snapshot supplied for this turn. Plain [S1] remains valid when the entire
source is relevant. Do not require a citation in every sentence.

Do not infer that something is absent from the user's vault merely because
it was not included in the selected sources for this turn.`;

export interface PluginSettings {
  /** Only the Obsidian SecretStorage name is persisted here. */
  secretName: string;
  systemPrompt: string;
  maxOutputTokens: number;
  promptCachingEnabled: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  secretName: "",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  maxOutputTokens: 4096,
  promptCachingEnabled: true,
};

export function isSynthesisModel(value: unknown): value is SynthesisModel {
  return value === "gpt-5.6-sol" || value === "gpt-5.6-terra" || value === "gpt-5.6-luna";
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

/** Migrate only the legacy supported alias; unrelated arbitrary IDs are not reinterpreted. */
export function migrateLegacyModel(value: unknown): SynthesisModel {
  if (value === "gpt-5.6" || value === "gpt-5.6-sol") return "gpt-5.6-sol";
  if (isSynthesisModel(value)) return value;
  return DEFAULT_MODEL;
}
