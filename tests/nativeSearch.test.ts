import { describe, expect, it } from "vitest";
import { chooseSearchLeaf, readNativeSearch, sameNativeSearchSnapshot } from "../src/search/nativeSearch";

interface TestFile { path: string; extension: string; }
function file(path: string, extension: string): TestFile { return { path, extension }; }

function app(files: TestFile[]) {
  const byPath = new Map(files.map((entry) => [entry.path, entry]));
  return { vault: { getAbstractFileByPath: (path: string) => byPath.get(path) ?? null } };
}

function workspaceApp(files: TestFile[], leaves: unknown[]) {
  return { ...app(files), workspace: { getLeavesOfType: () => leaves as never[] } };
}

function leaf(view: Record<string, unknown>) {
  return { id: `leaf-${Math.random()}`, view } as never;
}

function completedSearch(files: TestFile[], query = "tag:note") {
  return {
    getViewType: () => "search",
    getQuery: () => query,
    dom: { getFiles: () => files },
    queue: { queue: { runnable: { isRunning: () => false } } },
  };
}

describe("native Search adapter", () => {
  it("accepts only a stable complete accessor and returns distinct canonical Markdown files", () => {
    const a = file("a.md", "md");
    const b = file("b.md", "md");
    const pdf = file("asset.pdf", "pdf");
    const searchLeaf = leaf(completedSearch([b, pdf, a, a]));
    const result = readNativeSearch(app([a, b, pdf]), searchLeaf);
    expect(result).toMatchObject({ ok: true, snapshot: { query: "tag:note", files: [a, b], excludedNonMarkdown: ["asset.pdf"] } });
  });

  it("fails closed for loading, unsupported readiness, empty query, and changed reads", () => {
    const source = file("a.md", "md");
    const loading = leaf({ ...completedSearch([source]), queue: { queue: { runnable: { isRunning: () => true } } } });
    expect(readNativeSearch(app([source]), loading)).toMatchObject({ ok: false, reason: "loading" });
    const unsupported = leaf({ getViewType: () => "search", getQuery: () => "a", vChildren: {}, getFiles: () => [source], queue: null });
    expect(readNativeSearch(app([source]), unsupported)).toMatchObject({ ok: false, reason: "unsupported-shape" });
    const empty = leaf({ ...completedSearch([source], "  ") });
    expect(readNativeSearch(app([source]), empty)).toMatchObject({ ok: false, reason: "empty-query" });
    let reads = 0;
    const changed = leaf({ ...completedSearch([]), getQuery: () => "a", dom: { getFiles: () => { reads += 1; return reads === 1 ? [source] : []; } } });
    expect(readNativeSearch(app([source]), changed)).toMatchObject({ ok: false, reason: "stale" });
    const oldShape = leaf({ getViewType: () => "search", getQuery: () => "a", loading: false, queue: null, vChildren: {}, getFiles: () => [source] });
    expect(readNativeSearch(app([source]), oldShape)).toMatchObject({ ok: false, reason: "unsupported-shape" });
  });

  it("does not choose arbitrarily when multiple Search views exist", () => {
    const source = file("a.md", "md");
    const first = leaf(completedSearch([source], "a"));
    const second = leaf(completedSearch([source], "b"));
    const result = chooseSearchLeaf({ ...app([source]), workspace: { getLeavesOfType: () => [first, second] } });
    expect(result).toMatchObject({ ok: false, reason: "ambiguous-search-view" });
  });

  it("rejects a readable snapshot after its originating Search leaf closes", () => {
    const source = file("a.md", "md");
    const searchLeaf = leaf(completedSearch([source]));
    const application = workspaceApp([source], [searchLeaf]);
    const captured = readNativeSearch(application, searchLeaf);
    expect(captured).toMatchObject({ ok: true });

    application.workspace.getLeavesOfType = () => [];
    expect(sameNativeSearchSnapshot(application, (captured as { ok: true; snapshot: any }).snapshot)).toMatchObject({
      ok: false,
      reason: "stale",
    });
  });
});
