import { ReasoningEffort, SynthesisModel } from "../state/types";

export const MODEL_OPTIONS: Array<{ value: SynthesisModel; label: string }> = [
  { value: "gpt-5.6-sol", label: "Sol" },
  { value: "gpt-5.6-terra", label: "Terra" },
  { value: "gpt-5.6-luna", label: "Luna" },
];

export const REASONING_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
];

export function modelLabel(model: SynthesisModel): string {
  return MODEL_OPTIONS.find((option) => option.value === model)?.label ?? "Sol";
}

export function reasoningLabel(reasoningEffort: ReasoningEffort): string {
  return REASONING_OPTIONS.find((option) => option.value === reasoningEffort)?.label ?? "Medium";
}
