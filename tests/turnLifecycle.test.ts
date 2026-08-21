import { describe, expect, it } from "vitest";
import { afterSuccessfulTurn, afterUnsuccessfulTurn, recalledPreviousTray } from "../src/state/turnLifecycle";
import { TrayItem } from "../src/state/types";

const source = (contentSnapshot: string): TrayItem => ({ id: "tray-1", sourcePath: "note.md", scope: "whole_note", headingPath: null, contentSnapshot, addedAt: "now" });

describe("tray lifecycle", () => {
  it("clears only after a successful completed turn and snapshots the exact tray", () => {
    const used = [source("immutable content")];
    const next = afterSuccessfulTurn(used);
    expect(next.activeTray).toEqual([]);
    expect(next.previousTray).toEqual(used);
    used[0].contentSnapshot = "changed after request";
    expect(next.previousTray[0].contentSnapshot).toBe("immutable content");
  });

  it("preserves active tray on failure or abort", () => {
    const state = { activeTray: [source("still here")], previousTray: [source("previous")] };
    expect(afterUnsuccessfulTurn(state)).toEqual(state);
  });

  it("recalls immutable previous snapshots", () => {
    const state = { activeTray: [], previousTray: [source("previous snapshot")] };
    const recalled = recalledPreviousTray(state);
    expect(recalled.activeTray).toEqual(state.previousTray);
    state.previousTray[0].contentSnapshot = "mutated source";
    expect(recalled.activeTray[0].contentSnapshot).toBe("previous snapshot");
  });
});
