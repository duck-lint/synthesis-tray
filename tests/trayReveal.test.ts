import { describe, expect, it } from "vitest";
import { captureGroupShouldOpen, trayGroupIsRevealTarget, trayItemIsRevealTarget } from "../src/view/trayReveal";

describe("tray reveal targets", () => {
  it("reveals an individually added source", () => {
    expect(trayItemIsRevealTarget("note-2", { kind: "item", id: "note-2" })).toBe(true);
    expect(trayItemIsRevealTarget("note-1", { kind: "item", id: "note-2" })).toBe(false);
  });

  it("reveals a large folder header without opening the child list", () => {
    const target = { kind: "capture-group" as const, id: "research" };
    expect(trayGroupIsRevealTarget("research", target)).toBe(true);
    expect(captureGroupShouldOpen("research", 300, new Set(), target)).toBe(false);
  });

  it("keeps small folder expansion deterministic", () => {
    const target = { kind: "capture-group" as const, id: "small" };
    expect(captureGroupShouldOpen("small", 20, new Set(), target)).toBe(true);
    expect(captureGroupShouldOpen("small", 21, new Set(), target)).toBe(false);
    expect(captureGroupShouldOpen("other", 300, new Set(["other"]), null)).toBe(true);
  });
});
