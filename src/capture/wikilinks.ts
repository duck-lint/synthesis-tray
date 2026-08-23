import type { App } from "obsidian";
import { TrayItem, WikilinkDestination } from "../state/types";

export interface ParsedWikilink {
  authoredTarget: string;
  displayText: string;
}

/**
 * Extract only Obsidian wikilinks from the supplied snapshot. Embeds are not
 * outgoing note links for this feature; their existing literal snapshot
 * behavior remains unchanged.
 */
export function parseOutgoingWikilinks(source: string): ParsedWikilink[] {
  const links: ParsedWikilink[] = [];
  let fenced = false;
  const eligible = source.split(/\r?\n/).map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return "";
    }
    return fenced ? "" : line;
  }).join("\n");
  const pattern = /\[\[([^\]\n]+)\]\]/g;
  for (const match of eligible.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > 0 && eligible[start - 1] === "!") continue;
    const inner = match[1].trim();
    if (!inner) continue;
    const separator = inner.indexOf("|");
    const authoredTarget = (separator < 0 ? inner : inner.slice(0, separator)).trim();
    const displayText = (separator < 0 ? inner : inner.slice(separator + 1)).trim() || authoredTarget;
    if (authoredTarget) links.push({ authoredTarget, displayText });
  }
  return links;
}

/** Obsidian resolves heading/block subpaths against the containing note. */
export function noteTarget(authoredTarget: string): string {
  return authoredTarget.split(/[\#^]/, 1)[0].trim();
}

/**
 * Resolution is delegated to Obsidian's metadata cache. No vault search or
 * relevance decision is performed here; an unresolved authored edge remains
 * unresolved and therefore cannot produce linked content.
 */
export function resolveOutgoingWikilinks(app: App, item: Pick<TrayItem, "sourcePath" | "contentSnapshot" | "scope">): WikilinkDestination[] {
  if (item.scope === "conversation") return [];
  const seen = new Set<string>();
  const destinations: WikilinkDestination[] = [];
  for (const link of parseOutgoingWikilinks(item.contentSnapshot)) {
    const target = noteTarget(link.authoredTarget);
    if (!target) continue;
    const file = app.metadataCache.getFirstLinkpathDest(target, item.sourcePath);
    const destinationPath = file?.path ?? null;
    const destinationSourceId = destinationPath;
    const identity = destinationSourceId ?? `unresolved:${target.toLocaleLowerCase()}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    destinations.push({ ...link, destinationPath, destinationSourceId });
  }
  return destinations;
}
