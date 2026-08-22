import { DEFAULT_SETTINGS, PluginSettings } from "./types";

export function mergeSettings(data: Partial<PluginSettings> | null | undefined): PluginSettings {
  return {
    systemPrompt: typeof data?.systemPrompt === "string" ? data.systemPrompt : DEFAULT_SETTINGS.systemPrompt,
    maxOutputTokens: typeof data?.maxOutputTokens === "number" ? data.maxOutputTokens : DEFAULT_SETTINGS.maxOutputTokens,
    secretName: typeof data?.secretName === "string" ? data.secretName : "",
    promptCachingEnabled: typeof data?.promptCachingEnabled === "boolean" ? data.promptCachingEnabled : DEFAULT_SETTINGS.promptCachingEnabled,
  };
}
