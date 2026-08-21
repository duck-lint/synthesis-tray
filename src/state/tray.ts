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
  return tray.map((item) => ({ ...item, headingPath: item.headingPath ? [...item.headingPath] : null }));
}
