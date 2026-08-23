import { LinkedContextSelection, LinkedContextState, TrayItem } from "../state/types";
import { trayIdentity } from "../state/tray";

export interface TrayComparison {
  added: TrayItem[];
  removed: TrayItem[];
  unchanged: TrayItem[];
}

export interface LinkedContextComparison {
  added: LinkedContextSelection[];
  removed: LinkedContextSelection[];
  unchanged: LinkedContextSelection[];
  addedDestinations: string[];
  removedDestinations: string[];
}

function keyed<T>(values: T[], key: (value: T) => string): Map<string, T> {
  return new Map(values.map((value) => [key(value), value]));
}

export function compareTrays(current: TrayItem[], previous: TrayItem[]): TrayComparison {
  const currentByIdentity = keyed(current, trayIdentity);
  const previousByIdentity = keyed(previous, trayIdentity);
  return {
    added: previous.filter((item) => !currentByIdentity.has(trayIdentity(item))),
    removed: current.filter((item) => !previousByIdentity.has(trayIdentity(item))),
    unchanged: current.filter((item) => previousByIdentity.has(trayIdentity(item))),
  };
}

function linkedSelectionIdentity(selection: LinkedContextSelection): string {
  // The relationship is parent -> destination. Authored/display text remains
  // metadata, but an alias edit must not turn the same edge into a new one.
  return JSON.stringify([selection.parentSourceId, selection.destinationSourceId]);
}

export function compareLinkedContexts(current: LinkedContextState, previous: LinkedContextState): LinkedContextComparison {
  const currentByIdentity = keyed(current.selections, linkedSelectionIdentity);
  const previousByIdentity = keyed(previous.selections, linkedSelectionIdentity);
  const added = previous.selections.filter((selection) => !currentByIdentity.has(linkedSelectionIdentity(selection)));
  const removed = current.selections.filter((selection) => !previousByIdentity.has(linkedSelectionIdentity(selection)));
  return {
    added,
    removed,
    unchanged: current.selections.filter((selection) => previousByIdentity.has(linkedSelectionIdentity(selection))),
    addedDestinations: [...new Set(added.map((selection) => selection.destinationSourceId))],
    removedDestinations: [...new Set(removed.map((selection) => selection.destinationSourceId))],
  };
}

export function trayItemLabel(item: TrayItem): string {
  const identity = item.scope === "conversation" && item.conversationTitle ? `Conversation snapshot: ${item.conversationTitle}` : item.sourcePath;
  const scope = item.scope === "whole_note" ? "Whole note" : item.scope === "highlight" ? "Highlight" : item.scope === "heading" ? "Heading" : "Conversation";
  return `${identity} · ${scope}${item.headingPath ? ` · ${item.headingPath.join(" › ")}` : ""}`;
}
