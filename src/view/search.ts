import { Message, TrayItem } from "../state/types";

export interface IndexedTrayItem {
  item: TrayItem;
  index: number;
}

function normalizedQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function traySearchText(item: TrayItem): string {
  return [
    item.sourcePath,
    item.headingPath?.join(" "),
    item.conversationTitle,
    item.contentSnapshot,
  ].filter((value): value is string => Boolean(value)).join("\n");
}

export function trayItemMatchesQuery(item: TrayItem, query: string): boolean {
  const normalized = normalizedQuery(query);
  return normalized.length === 0 || traySearchText(item).toLowerCase().includes(normalized);
}

export function filterTrayByQuery(tray: TrayItem[], query: string): IndexedTrayItem[] {
  return tray.flatMap((item, index) => trayItemMatchesQuery(item, query) ? [{ item, index }] : []);
}

export function filterMessagesByQuery(messages: Message[], query: string): Message[] {
  const normalized = normalizedQuery(query);
  if (normalized.length === 0) return messages;
  return messages.filter((message) => message.content.toLowerCase().includes(normalized));
}
