import { describe, expect, it } from "vitest";
import { afterSuccessfulTurn, afterUnsuccessfulTurn, clearedActiveTray, recalledPreviousTray } from "../src/state/turnLifecycle";
import { presentationTrayEntries, presentationTrayItems } from "../src/state/tray";
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

  it("clears only the active tray and preserves previous snapshots", () => {
    const state = { activeTray: [source("active")], previousTray: [source("previous")] };
    const cleared = clearedActiveTray(state);
    expect(cleared.activeTray).toEqual([]);
    expect(cleared.previousTray).toEqual(state.previousTray);
  });

  it("puts newest items first only for presentation and preserves source indices", () => {
    const tray = [source("A"), { ...source("B"), id: "tray-2" }, { ...source("C"), id: "tray-3" }];
    const displayed = presentationTrayItems(tray);
    expect(displayed.map(({ item }) => item.contentSnapshot)).toEqual(["C", "B", "A"]);
    expect(displayed.map(({ index }) => index)).toEqual([2, 1, 0]);
    expect(tray.map((item) => item.contentSnapshot)).toEqual(["A", "B", "C"]);
  });

  it("renders an explicit folder capture as one newest-first group with canonical children", () => {
    const group = { id: "folder", kind: "folder" as const, label: "Research" };
    const tray = [
      { ...source("A"), id: "a", captureGroup: group },
      { ...source("B"), id: "b", captureGroup: group },
      { ...source("C"), id: "c" },
    ];
    const entries = presentationTrayEntries(tray);
    expect(entries[0]).toEqual({ kind: "item", item: tray[2], index: 2 });
    expect(entries[1]).toMatchObject({ kind: "folder", group, items: [{ item: tray[0], index: 0 }, { item: tray[1], index: 1 }] });
  });
});
