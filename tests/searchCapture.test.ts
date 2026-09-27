import { describe, expect, it } from "vitest";
import { prepareSearchCapture, stageSearchItems, validatePreparedSearchSources } from "../src/capture/searchCapture";
import { captureWholeNote } from "../src/capture/capture";

function vault(files: Record<string, { extension: string; content: string }>) {
  return {
    getAbstractFileByPath(path: string) {
      const file = files[path];
      return file ? { path, extension: file.extension } : null;
    },
    async read(file: { path: string }) {
      const entry = files[file.path];
      if (!entry) throw new Error(`missing ${file.path}`);
      return entry.content;
    },
  };
}

function pendingRead(): { read: (file: { path: string }) => Promise<string>; resolve: (content: string) => void; reject: (error: unknown) => void } {
  let resolve!: (content: string) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<string>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { read: () => promise, resolve, reject };
}

describe("staged native Search capture", () => {
  it("reads complete whole-note snapshots in canonical order and reports progress", async () => {
    const source = vault({
      "z.md": { extension: "md", content: "# Z\nbody" },
      "a.md": { extension: "md", content: "---\ntype: note\n---\nA" },
      "asset.pdf": { extension: "pdf", content: "binary" },
    });
    const progress: string[] = [];
    const result = await prepareSearchCapture(source, ["z.md", "a.md", "a.md"], [], { id: "search-1", kind: "search", label: "tag:note" }, (state) => progress.push(`${state.phase}:${state.completed}/${state.total}`));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.prepared.items.map((item) => [item.sourcePath, item.contentSnapshot, item.scope])).toEqual([
      ["a.md", "---\ntype: note\n---\nA", "whole_note"],
      ["z.md", "# Z\nbody", "whole_note"],
    ]);
    expect(result.prepared.items.every((item) => item.captureGroup?.kind === "search")).toBe(true);
    expect(result.prepared.selectedItems.map((item) => item.sourcePath)).toEqual(["a.md", "z.md"]);
    expect(progress.at(0)).toBe("preparing:0/2");
    expect(progress.at(-1)).toBe("validating:2/2");
  });

  it("uses the existing exact identity rule for preview duplicates and all-duplicate no-op", async () => {
    const existing = captureWholeNote("a.md", "A");
    const source = vault({ "a.md": { extension: "md", content: "A" }, "b.md": { extension: "md", content: "B" } });
    const result = await prepareSearchCapture(source, ["b.md", "a.md"], [existing], { id: "search-2", kind: "search", label: "A" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const staged = stageSearchItems([existing], result.prepared.items);
    expect(staged.added.map((item) => item.sourcePath)).toEqual(["b.md"]);
    expect(result.prepared.duplicateCount).toBe(1);
    expect(result.prepared.selectedItems.map((item) => item.sourcePath)).toEqual(["a.md", "b.md"]);
    const duplicateOnly = await prepareSearchCapture(source, ["a.md"], [existing], { id: "search-3", kind: "search", label: "A" });
    expect(duplicateOnly).toMatchObject({ ok: true, prepared: { items: [] } });
  });

  it("invalidates disappearance and changed saved content without refreshing the snapshot", async () => {
    const files: Record<string, { extension: string; content: string }> = { "a.md": { extension: "md", content: "A" } };
    const source = vault(files);
    const prepared = await prepareSearchCapture(source, ["a.md"], [], { id: "search-4", kind: "search", label: "A" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    files["a.md"].content = "changed";
    expect(await validatePreparedSearchSources(source, prepared.prepared.selectedItems)).toMatchObject({ ok: false, reason: "changed-content" });
    delete files["a.md"];
    expect(await validatePreparedSearchSources(source, prepared.prepared.selectedItems)).toMatchObject({ ok: false, reason: "missing-file" });
  });

  it("revalidates an exact duplicate even though it is not staged", async () => {
    const existing = captureWholeNote("a.md", "A");
    const files: Record<string, { extension: string; content: string }> = {
      "a.md": { extension: "md", content: "A" },
      "b.md": { extension: "md", content: "B" },
    };
    const source = vault(files);
    const prepared = await prepareSearchCapture(source, ["a.md", "b.md"], [existing], { id: "search-6", kind: "search", label: "A" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.prepared.items.map((item) => item.sourcePath)).toEqual(["b.md"]);
    files["a.md"].content = "changed";
    expect(await validatePreparedSearchSources(source, prepared.prepared.selectedItems)).toMatchObject({ ok: false, reason: "changed-content", paths: ["a.md"] });
  });

  it("cancels during preparation and leaves the staged operation detached", async () => {
    const controller = new AbortController();
    const result = await prepareSearchCapture(vault({
      "a.md": { extension: "md", content: "A" },
      "b.md": { extension: "md", content: "B" },
    }), ["a.md", "b.md"], [], { id: "search-5", kind: "search", label: "A" }, (progress) => {
      if (progress.completed === 1) controller.abort();
    }, controller.signal, 1);
    expect(result).toMatchObject({ ok: false, reason: "cancelled" });
  });

  it("settles preparation cancellation before a read resolves and consumes a late rejection", async () => {
    const pending = pendingRead();
    const controller = new AbortController();
    const resultPromise = prepareSearchCapture({
      getAbstractFileByPath: (path: string) => ({ path, extension: "md" }),
      read: pending.read,
    }, ["a.md"], [], { id: "search-pending", kind: "search", label: "A" }, undefined, controller.signal, 1);
    await Promise.resolve();
    controller.abort();
    await expect(Promise.race([resultPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 100))])).resolves.toMatchObject({ ok: false, reason: "cancelled" });
    pending.reject(new Error("late read failure"));
    await Promise.resolve();
  });

  it("settles validation cancellation before a read resolves", async () => {
    const item = captureWholeNote("a.md", "A");
    const pending = pendingRead();
    const controller = new AbortController();
    const resultPromise = validatePreparedSearchSources({
      getAbstractFileByPath: (path: string) => ({ path, extension: "md" }),
      read: pending.read,
    }, [item], controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(Promise.race([resultPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 100))])).resolves.toMatchObject({ ok: false, reason: "cancelled" });
    pending.resolve("late content");
    await Promise.resolve();
  });

  it("releases sibling workers when one read fails", async () => {
    const pending = pendingRead();
    const resultPromise = prepareSearchCapture({
      getAbstractFileByPath: (path: string) => ({ path, extension: "md" }),
      read: (file: { path: string }) => file.path === "a.md" ? Promise.reject(new Error("first read failed")) : pending.read(file),
    }, ["a.md", "b.md"], [], { id: "search-failure", kind: "search", label: "A" }, undefined, undefined, 2);
    const result = await Promise.race([resultPromise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 100))]);
    expect(result).toMatchObject({ ok: false, reason: "read-failed", paths: ["a.md"] });
    pending.reject(new Error("late sibling failure"));
    await Promise.resolve();
  });
});
