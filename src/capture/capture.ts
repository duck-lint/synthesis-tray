import { headingContainingOffset, extractHeadingRegion } from "./headingParser";
import { newId, nowIso } from "../state/ids";
import { TrayItem } from "../state/types";

export interface EditorSelectionLike {
  getSelection(): string;
  getCursor(position?: "from" | "to"): { line: number; ch: number };
}

export function offsetAtPosition(source: string, line: number, ch: number): number {
  const lines = source.split(/\r?\n/);
  return lines.slice(0, Math.max(0, line)).reduce((total, value) => total + value.length + 1, 0) + ch;
}

export function captureSelection(sourcePath: string, source: string, editor: EditorSelectionLike): TrayItem | null {
  const contentSnapshot = editor.getSelection();
  if (contentSnapshot.length === 0) return null;
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  const startOffset = offsetAtPosition(source, from.line, from.ch);
  const endOffset = offsetAtPosition(source, to.line, to.ch);
  const startHeading = headingContainingOffset(source, startOffset);
  const endHeading = headingContainingOffset(source, Math.max(startOffset, endOffset - 1));
  // A cross-region selection remains exact, but no single heading can honestly
  // be claimed as its container.
  const heading = startHeading && endHeading && startHeading.start === endHeading.start ? startHeading : null;
  return {
    id: newId("tray"),
    sourcePath,
    scope: "highlight",
    headingPath: heading?.path ?? null,
    contentSnapshot,
    addedAt: nowIso(),
  };
}

export function captureHeading(sourcePath: string, source: string, cursorOffset: number): TrayItem | null {
  const region = extractHeadingRegion(source, cursorOffset);
  if (!region) return null;
  return {
    id: newId("tray"),
    sourcePath,
    scope: "heading",
    headingPath: region.heading.path,
    contentSnapshot: region.content,
    addedAt: nowIso(),
  };
}

export function captureWholeNote(sourcePath: string, source: string): TrayItem {
  return {
    id: newId("tray"),
    sourcePath,
    scope: "whole_note",
    headingPath: null,
    contentSnapshot: source,
    addedAt: nowIso(),
  };
}

export interface FolderCaptureFile {
  path: string;
  extension: string;
  source: string;
}

/** Sorts before capture so folder actions have stable source ordering and IDs. */
export function captureFolderWholeNotes(files: FolderCaptureFile[]): TrayItem[] {
  return files
    .filter((file) => file.extension.toLowerCase() === "md")
    .slice()
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map((file) => captureWholeNote(file.path, file.source));
}
