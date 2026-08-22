import { describe, expect, it } from "vitest";
import { MODEL_OPTIONS, REASONING_OPTIONS, modelLabel, reasoningLabel } from "../src/view/inferenceControls";

describe("thread inference controls", () => {
  it("exposes the three canonical model tiers", () => {
    expect(MODEL_OPTIONS.map((option) => option.value)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(modelLabel("gpt-5.6-terra")).toBe("Terra");
  });

  it("exposes every accepted reasoning effort value", () => {
    expect(REASONING_OPTIONS.map((option) => option.value)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(reasoningLabel("xhigh")).toBe("Extra High");
  });
});
