import { ProviderUsage, TurnUsage } from "../state/types";

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordOrEmpty(value: unknown): ProviderUsage {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ProviderUsage : {};
}

/** Normalize provider metadata while retaining the complete payload for inspection. */
export function turnUsageFromProvider(turnId: string, usage: ProviderUsage | null): TurnUsage {
  const inputDetails = recordOrEmpty(usage?.input_tokens_details);
  const outputDetails = recordOrEmpty(usage?.output_tokens_details);
  return {
    turnId,
    inputTokens: numberOrNull(usage?.input_tokens),
    outputTokens: numberOrNull(usage?.output_tokens),
    reasoningTokens: numberOrNull(outputDetails.reasoning_tokens),
    totalTokens: numberOrNull(usage?.total_tokens),
    cachedInputTokens: numberOrNull(inputDetails.cached_tokens),
    cacheWriteTokens: numberOrNull(inputDetails.cache_write_tokens),
    usageJson: usage ? JSON.stringify(usage) : null,
  };
}
