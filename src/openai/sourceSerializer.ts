import { LinkedContextSource, LinkedContextState, TrayItem, WikilinkDestination } from "../state/types";
import { linkedContextForRequest } from "../state/tray";

export function sourceIdentifier(index: number): string {
  return `S${index + 1}`;
}

export function serializeSourceLines(content: string): string {
  return content.split(/\r?\n/).map((line, index) => `L${index + 1}: ${line}`).join("\n");
}

export interface RequestSource {
  item: TrayItem | LinkedContextSource;
  provenanceKind: "explicit" | "linked";
  parentSourceIds: string[];
  parentSourcePaths: string[];
  destinationSourceId?: string;
}

function formatOutgoingLinks(links: WikilinkDestination[]): string {
  if (links.length === 0) return "";
  const rows = links.map((link) => `- ${link.displayText} · authored target: ${link.authoredTarget} · destination: ${link.destinationPath ?? "unresolved"}`);
  return ["outgoing wikilinks (authored identity metadata; not destination evidence):", ...rows].join("\n");
}

export function requestSources(tray: TrayItem[], linkedContext: LinkedContextState = { sources: [], selections: [] }): RequestSource[] {
  const linked = linkedContextForRequest(tray, linkedContext);
  const explicitPaths = new Set(tray.map((item) => item.sourcePath));
  const parentPaths = new Map(tray.map((item) => [item.id, item.sourcePath]));
  const sourceById = new Map(linked.sources.map((source) => [source.destinationSourceId, source]));
  const orderedLinkedIds: string[] = [];
  for (const selection of linked.selections) {
    if (!sourceById.has(selection.destinationSourceId) || explicitPaths.has(sourceById.get(selection.destinationSourceId)!.sourcePath)) continue;
    if (!orderedLinkedIds.includes(selection.destinationSourceId)) orderedLinkedIds.push(selection.destinationSourceId);
  }
  return [
    ...tray.map((item) => ({ item, provenanceKind: "explicit" as const, parentSourceIds: [], parentSourcePaths: [], destinationSourceId: undefined })),
    ...orderedLinkedIds.map((destinationSourceId) => ({
      item: sourceById.get(destinationSourceId)!,
      provenanceKind: "linked" as const,
      parentSourceIds: linked.selections.filter((selection) => selection.destinationSourceId === destinationSourceId).map((selection) => selection.parentSourceId),
      parentSourcePaths: linked.selections.filter((selection) => selection.destinationSourceId === destinationSourceId).map((selection) => parentPaths.get(selection.parentSourceId) ?? selection.parentSourceId),
      destinationSourceId,
    })),
  ];
}

export function serializeTray(tray: TrayItem[], linkedContext: LinkedContextState = { sources: [], selections: [] }): string {
  if (tray.length === 0) return "";
  const sources = requestSources(tray, linkedContext);
  const blocks = sources.map(({ item, provenanceKind, parentSourceIds, parentSourcePaths, destinationSourceId }, index) => {
    const identifier = sourceIdentifier(index);
    const heading = "headingPath" in item && item.headingPath ? item.headingPath.join(" > ") : "(none)";
    const metadata = provenanceKind === "explicit"
      ? formatOutgoingLinks((item as TrayItem).outgoingWikilinks ?? [])
      : [
        "linked context: explicitly included destination content",
        `parent source: ${parentSourcePaths.join(", ")}`,
        "relationship: outgoing wikilink",
        `destination: ${destinationSourceId ?? item.sourcePath}`,
      ].join("\n");
    return `[${identifier}]\nsource: ${item.sourcePath}\nscope: ${item.scope}\nprovenance: ${provenanceKind}\nheading: ${heading}${metadata ? `\n${metadata}` : ""}\n\n--- BEGIN ${provenanceKind === "linked" ? "LINKED SOURCE" : "SOURCE"} ${identifier} ---\n\n${serializeSourceLines(item.contentSnapshot)}\n\n--- END ${provenanceKind === "linked" ? "LINKED SOURCE" : "SOURCE"} ${identifier} ---`;
  });
  return [
    "The user deliberately selected the following authored material for this turn. These sources are contextual evidence and are not an exhaustive representation of the vault.",
    "",
    ...blocks,
  ].join("\n\n");
}
