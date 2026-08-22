import { TrayRevealTarget } from "../state/tray";

export const CAPTURE_GROUP_AUTO_EXPAND_LIMIT = 20;

export function captureGroupShouldOpen(groupId: string, itemCount: number, groupPreferences: ReadonlyMap<string, boolean>, revealTarget: TrayRevealTarget | null): boolean {
  if (revealTarget?.kind === "capture-group" && revealTarget.id === groupId) return itemCount <= CAPTURE_GROUP_AUTO_EXPAND_LIMIT;
  return groupPreferences.get(groupId) ?? itemCount <= CAPTURE_GROUP_AUTO_EXPAND_LIMIT;
}

export function trayItemIsRevealTarget(itemId: string, revealTarget: TrayRevealTarget | null): boolean {
  return revealTarget?.kind === "item" && revealTarget.id === itemId;
}

export function trayGroupIsRevealTarget(groupId: string, revealTarget: TrayRevealTarget | null): boolean {
  return revealTarget?.kind === "capture-group" && revealTarget.id === groupId;
}
