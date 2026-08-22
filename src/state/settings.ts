import { DEFAULT_SETTINGS, DEFAULT_SYSTEM_PROMPT, PluginSettings, isVerbosity } from "./types";

/** The exact prompt shipped immediately before line-aware citation tightening. */
export const PREVIOUS_DEFAULT_SYSTEM_PROMPT = `You are a synthesis partner working with authored material deliberately
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

export function migrateDefaultSystemPrompt(value: unknown): string {
  return value === PREVIOUS_DEFAULT_SYSTEM_PROMPT ? DEFAULT_SYSTEM_PROMPT : typeof value === "string" ? value : DEFAULT_SYSTEM_PROMPT;
}

export function mergeSettings(data: Partial<PluginSettings> | null | undefined): PluginSettings {
  return {
    systemPrompt: migrateDefaultSystemPrompt(data?.systemPrompt),
    maxOutputTokens: typeof data?.maxOutputTokens === "number" ? data.maxOutputTokens : DEFAULT_SETTINGS.maxOutputTokens,
    secretName: typeof data?.secretName === "string" ? data.secretName : "",
    verbosity: isVerbosity(data?.verbosity) ? data.verbosity : DEFAULT_SETTINGS.verbosity,
    promptCachingEnabled: typeof data?.promptCachingEnabled === "boolean" ? data.promptCachingEnabled : DEFAULT_SETTINGS.promptCachingEnabled,
  };
}
