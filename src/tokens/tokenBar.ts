import { TokenBreakdown } from "../state/types";

export type TokenBarBucket = "system" | "conversation" | "tray" | "draft";

export interface TokenBarSegment {
  bucket: TokenBarBucket;
  label: string;
  tokens: number;
  percentage: number;
}

const BUCKETS: Array<[TokenBarBucket, string]> = [
  ["system", "System"],
  ["conversation", "Conversation"],
  ["tray", "Tray"],
  ["draft", "Message"],
];

export function tokenBarSegments(breakdown: TokenBreakdown): TokenBarSegment[] {
  return BUCKETS.map(([bucket, label]) => {
    const tokens = breakdown[bucket];
    return { bucket, label, tokens, percentage: breakdown.total > 0 ? tokens / breakdown.total * 100 : 0 };
  });
}
