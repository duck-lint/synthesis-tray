import { ReasoningEffort, SynthesisModel } from "../state/types";
import { modelLabel, reasoningLabel } from "./inferenceControls";

export function inferenceSummary(model: SynthesisModel | null, effort: ReasoningEffort | null, inputTokens: number | null, outputTokens: number | null, cachedInputTokens: number | null): string {
  const usage = inputTokens === null && outputTokens === null ? "" : ` · ${inputTokens === null ? "?" : inputTokens.toLocaleString()} input · ${outputTokens === null ? "?" : outputTokens.toLocaleString()} output${cachedInputTokens === null ? "" : ` · ${cachedInputTokens.toLocaleString()} cached`}`;
  const inference = model && effort ? `${modelLabel(model)} · ${reasoningLabel(effort)}` : "Inference configuration unavailable";
  return `${inference}${usage}`;
}
