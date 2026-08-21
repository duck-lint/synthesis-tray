import { SourceSnapshot } from "../state/types";

export interface SourceManifestEntry {
  sourceIndex: number;
  identity: string;
  scope: string;
  headingPath: string[] | null;
}

export function sourceManifestEntries(sources: SourceSnapshot[]): SourceManifestEntry[] {
  return sources
    .slice()
    .sort((a, b) => a.sourceIndex - b.sourceIndex)
    .map((source) => ({
      sourceIndex: source.sourceIndex,
      identity: source.scope === "conversation" && source.conversationTitle ? `Conversation: "${source.conversationTitle}"` : source.sourcePath,
      scope: source.scope,
      headingPath: source.headingPath ? [...source.headingPath] : null,
    }));
}
