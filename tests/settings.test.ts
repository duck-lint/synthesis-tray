import { describe, expect, it } from "vitest";
import { mergeSettings } from "../src/state/settings";

describe("secret settings boundary", () => {
  it("persists a secret name and never a resolved secret value", () => {
    const settings = mergeSettings({ secretName: "openai-main" });
    const serialized = JSON.stringify(settings);
    expect(settings.secretName).toBe("openai-main");
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("resolved-secret-value");
  });
});
