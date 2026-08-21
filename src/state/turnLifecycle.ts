import { cloneTray } from "./tray";
import { TrayItem } from "./types";

export interface TrayLifecycleState {
  activeTray: TrayItem[];
  previousTray: TrayItem[];
}

export function afterSuccessfulTurn(usedTray: TrayItem[]): TrayLifecycleState {
  return { activeTray: [], previousTray: cloneTray(usedTray) };
}

export function afterUnsuccessfulTurn(state: TrayLifecycleState): TrayLifecycleState {
  return { activeTray: cloneTray(state.activeTray), previousTray: cloneTray(state.previousTray) };
}

export function recalledPreviousTray(state: TrayLifecycleState): TrayLifecycleState {
  return { activeTray: cloneTray(state.previousTray), previousTray: cloneTray(state.previousTray) };
}

export function clearedActiveTray(state: TrayLifecycleState): TrayLifecycleState {
  return { activeTray: [], previousTray: cloneTray(state.previousTray) };
}
