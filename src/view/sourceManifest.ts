import type { SourceSnapshot, Turn } from "../state/types";

export interface SourceManifestEntry {
  sourceIndex: number;
  identity: string;
  scope: string;
  headingPath: string[] | null;
  provenance?: "explicit" | "linked";
  parentSourceIds?: string[];
}

export interface HistoricalSnapshotCandidate {
  source: SourceSnapshot;
  turnCreatedAt: string | null;
  compatibleScope: boolean;
}

function sameScope(a: SourceSnapshot, b: SourceSnapshot): boolean {
  return a.scope === b.scope && JSON.stringify(a.headingPath) === JSON.stringify(b.headingPath);
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
      ...(source.provenanceKind ? { provenance: source.provenanceKind } : {}),
      ...(source.parentSourceIds ? { parentSourceIds: [...source.parentSourceIds] } : {}),
    }));
}

export function historicalComparisonsFor(source: SourceSnapshot, snapshots: SourceSnapshot[], turns: Pick<Turn, "id" | "createdAt">[]): HistoricalSnapshotCandidate[] {
  const turnDates = new Map(turns.map((turn) => [turn.id, turn.createdAt]));
  return snapshots
    .filter((candidate) => candidate.id !== source.id && candidate.sourcePath === source.sourcePath)
    .map((candidate) => ({ source: candidate, turnCreatedAt: turnDates.get(candidate.turnId) ?? null, compatibleScope: sameScope(candidate, source) }))
    .sort((a, b) => Number(b.compatibleScope) - Number(a.compatibleScope) || (b.turnCreatedAt ?? "").localeCompare(a.turnCreatedAt ?? "") || b.source.turnId.localeCompare(a.source.turnId) || b.source.sourceIndex - a.source.sourceIndex || b.source.id.localeCompare(a.source.id));
}
