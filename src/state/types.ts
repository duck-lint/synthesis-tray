export type Scope = "highlight" | "heading" | "whole_note" | "conversation";
export type MessageRole = "user" | "assistant";

export type SynthesisModel = "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna" | "gpt-6-astra" | "gpt-6-sol" | "gpt-6-luna";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type Verbosity = "low" | "medium" | "high";

/** Authored identity metadata; this never represents destination-note content. */
export interface WikilinkDestination {
  authoredTarget: string;
  displayText: string;
  destinationSourceId: string | null;
  destinationPath: string | null;
}

/** One immutable destination snapshot, deduplicated by destinationSourceId. */
export interface LinkedContextSource {
  destinationSourceId: string;
  sourcePath: string;
  scope: "whole_note";
  contentSnapshot: string;
  addedAt: string;
}

/** The relationship is the authority for linked inclusion, not the destination alone. */
export interface LinkedContextSelection {
  parentSourceId: string;
  destinationSourceId: string;
  authoredTarget: string;
  displayText: string;
}

export interface LinkedContextState {
  sources: LinkedContextSource[];
  selections: LinkedContextSelection[];
}

export const EMPTY_LINKED_CONTEXT: LinkedContextState = { sources: [], selections: [] };

export const DEFAULT_MODEL: SynthesisModel = "gpt-5.6-luna";
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high";
/** Former global default used only when interpreting an old thread row. */
export const LEGACY_DEFAULT_MODEL: SynthesisModel = "gpt-5.6-sol";
export const LEGACY_DEFAULT_REASONING_EFFORT: ReasoningEffort = "none";

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
  /** Derived from the immutable snapshot and the current Obsidian resolver. */
  outgoingWikilinks?: WikilinkDestination[];
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
  /** A subset of outputTokens, when the provider reports the breakdown. */
  reasoningTokens: number | null;
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
  provenanceKind?: "explicit" | "linked";
  parentSourceIds?: string[];
  relationship?: "outgoing_wikilink";
  destinationSourceId?: string;
  outgoingWikilinks?: WikilinkDestination[];
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
  activeLinkedContext: LinkedContextState;
  previousLinkedContext: LinkedContextState;
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

Outgoing wikilink metadata records authored relationships only. A destination
name or link is not evidence from that destination note. Use destination-note
content only when a separately marked linked source supplies that content.

When a claim is grounded in a specific passage or localized region of a
selected source, cite the narrowest useful snapshot-relative line or line
range, such as [S1:L42-L48] or [S3:L7]. Line numbers refer only to the
numbered source snapshot supplied for this turn; never invent line numbers.
When several passages support one claim, multiple citations may be grouped
inside one bracket with semicolons, such as [S1:L82-L83; S1:L103-L110].
Use plain [S1] only for a genuinely source-wide claim where no narrower
passage is the appropriate evidence. Put citations adjacent to the claim.
Do not require a citation in every sentence or add citation noise.

Do not infer that something is absent from the user's vault merely because
it was not included in the selected sources for this turn.`;

export interface PluginSettings {
  /** Only the Obsidian SecretStorage name is persisted here. */
  secretName: string;
  systemPrompt: string;
  maxOutputTokens: number;
  verbosity: Verbosity;
  promptCachingEnabled: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  secretName: "",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  maxOutputTokens: 4096,
  verbosity: "medium",
  promptCachingEnabled: true,
};

export function isSynthesisModel(value: unknown): value is SynthesisModel {
  return value === "gpt-5.6-sol" || value === "gpt-5.6-terra" || value === "gpt-5.6-luna"
    || value === "gpt-6-astra" || value === "gpt-6-sol" || value === "gpt-6-luna";
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

/** Astra does not accept the otherwise supported `none` reasoning setting. */
export function isReasoningEffortSupportedByModel(model: SynthesisModel, effort: ReasoningEffort): boolean {
  return model !== "gpt-6-astra" || effort !== "none";
}

export function isVerbosity(value: unknown): value is Verbosity {
  return value === "low" || value === "medium" || value === "high";
}

/** Migrate only the legacy supported alias; unrelated arbitrary IDs are not reinterpreted. */
export function migrateLegacyModel(value: unknown): SynthesisModel {
  if (value === "gpt-5.6" || value === "gpt-5.6-sol") return "gpt-5.6-sol";
  if (isSynthesisModel(value)) return value;
  return LEGACY_DEFAULT_MODEL;
}
