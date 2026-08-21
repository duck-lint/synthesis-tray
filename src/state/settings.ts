import { DEFAULT_SETTINGS, PluginSettings } from "./types";

export function mergeSettings(data: Partial<PluginSettings> | null | undefined): PluginSettings {
  return { ...DEFAULT_SETTINGS, ...data, secretName: typeof data?.secretName === "string" ? data.secretName : "" };
}
