import { TrayItem } from "./types";

export function trayIdentity(item: Pick<TrayItem, "sourcePath" | "scope" | "headingPath" | "contentSnapshot" | "conversationThreadId" | "conversationTitle">): string {
  return JSON.stringify([item.sourcePath, item.scope, item.headingPath, item.contentSnapshot, item.conversationThreadId ?? null, item.conversationTitle ?? null]);
}

export function addTrayItem(tray: TrayItem[], item: TrayItem): { tray: TrayItem[]; duplicate: boolean } {
  if (tray.some((existing) => trayIdentity(existing) === trayIdentity(item))) {
    return { tray, duplicate: true };
  }
  return { tray: [...tray, item], duplicate: false };
}

export function removeTrayItem(tray: TrayItem[], id: string): TrayItem[] {
  return tray.filter((item) => item.id !== id);
}

export function cloneTray(tray: TrayItem[]): TrayItem[] {
  return tray.map((item) => ({
    ...item,
    headingPath: item.headingPath ? [...item.headingPath] : null,
    ...(item.captureGroup ? { captureGroup: { ...item.captureGroup } } : {}),
  }));
}

/** Presentation-only order: newest items first while retaining canonical indices. */
export function presentationTrayItems(tray: TrayItem[]): Array<{ item: TrayItem; index: number }> {
  return tray.map((item, index) => ({ item, index })).reverse();
}

export type TrayPresentationEntry =
  | { kind: "item"; item: TrayItem; index: number }
  | { kind: "folder"; group: NonNullable<TrayItem["captureGroup"]>; items: Array<{ item: TrayItem; index: number }> };

/** Groups only explicit folder captures while keeping the top-level tray newest-first. */
export function presentationTrayEntries(tray: TrayItem[]): TrayPresentationEntry[] {
  const entries: TrayPresentationEntry[] = [];
  for (let index = 0; index < tray.length;) {
    const item = tray[index];
    const group = item.captureGroup;
    if (!group) {
      entries.push({ kind: "item", item, index });
      index += 1;
      continue;
    }
    const items: Array<{ item: TrayItem; index: number }> = [];
    while (index < tray.length && tray[index].captureGroup?.id === group.id) {
      items.push({ item: tray[index], index });
      index += 1;
    }
    entries.push({ kind: "folder", group, items });
  }
  return entries.reverse();
}
