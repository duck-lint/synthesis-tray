import { describe, expect, it } from "vitest";
import { mergeSettings } from "../src/state/settings";
import { migrateLegacyModel } from "../src/state/types";
import { newThreadInferenceDefaults } from "../src/state/thread";

describe("secret settings boundary", () => {
  it("persists a secret name and never a resolved secret value", () => {
    const settings = mergeSettings({ secretName: "openai-main" });
    const serialized = JSON.stringify(settings);
    expect(settings.secretName).toBe("openai-main");
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("resolved-secret-value");
  });

  it("migrates only the supported legacy model alias", () => {
    expect(migrateLegacyModel("gpt-5.6")).toBe("gpt-5.6-sol");
    expect(migrateLegacyModel("gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(migrateLegacyModel("custom-model")).toBe("gpt-5.6-sol");
  });

  it("keeps genuinely new threads on the canonical default after migration", () => {
    expect(migrateLegacyModel("gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(newThreadInferenceDefaults()).toEqual({ model: "gpt-5.6-sol", reasoningEffort: "none" });
    expect(migrateLegacyModel("gpt-5.6")).toBe(newThreadInferenceDefaults().model);
  });
});
