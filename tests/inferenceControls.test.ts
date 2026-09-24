import { describe, expect, it } from "vitest";
import { MODEL_OPTIONS, REASONING_OPTIONS, modelLabel, reasoningLabel } from "../src/view/inferenceControls";
import { inferenceSummary } from "../src/view/inferenceSummary";
import { isReasoningEffortSupportedByModel, isSynthesisModel } from "../src/state/types";

describe("thread inference controls", () => {
  it("accepts and exposes all supported model IDs", () => {
    const models = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] as const;
    expect(models.every(isSynthesisModel)).toBe(true);
    expect(MODEL_OPTIONS.map((option) => option.value)).toEqual(models);
    expect(modelLabel("gpt-5.6-terra")).toBe("Terra");
  });

  it("exposes every accepted reasoning effort value", () => {
    expect(REASONING_OPTIONS.map((option) => option.value)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(reasoningLabel("xhigh")).toBe("Extra High");
  });

  it("keeps all reasoning values for supported models and excludes only none for Astra", () => {
    const efforts = REASONING_OPTIONS.map((option) => option.value);
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-sol", "gpt-6-luna"] as const) {
      expect(efforts.every((effort) => isReasoningEffortSupportedByModel(model, effort))).toBe(true);
    }
    expect(efforts.filter((effort) => isReasoningEffortSupportedByModel("gpt-6-astra", effort))).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("does not fabricate inference metadata for legacy turns", () => {
    expect(inferenceSummary(null, null, null, null, null, null)).toBe("Inference configuration unavailable");
    expect(inferenceSummary(null, null, 12, 4, null, null)).toBe("Inference configuration unavailable · 12 input · 4 output");
    expect(inferenceSummary("gpt-5.6-luna", "high", 12, 6, 4, null)).toContain("6 output (4 reasoning)");
  });
});
